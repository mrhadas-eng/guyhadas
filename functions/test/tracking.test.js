// M7 store tests: tracking runs + implementation recording, on the
// index-enforcing in-memory Firestore with the shared Hagar fixture and the
// real M6 store producing the decisions. No network.
// Run: node functions/test/tracking.test.js
//
// Covers docs/M7_DESIGN.md §14 "Change events", "Observation windows",
// "Experiments", "Governance and run safety", plus P1/P3 and backlog #39.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const F = require("./helpers/m7Fixture");
const T = require("../trackingRules");

const { BIZ, NOW, DAY, TZ, RUN1_AT, D_RANK, D_LEARN, D_SITE, D_GAP, ARCH, setup } = require("./helpers/m7Setup");

const preds = (s, filter = () => true) => s.rows("impactPredictions").filter(filter);
const expectReject = async (p, status, re) => {
  try {
    await p;
  } catch (err) {
    assert.strictEqual(err.status, status, `${err.status} ${err.message}`);
    if (re) assert.ok(re.test(err.message), err.message);
    return err;
  }
  throw new Error(`expected rejection ${status}`);
};
const SIGNAL = /NO_SIGNAL_YET|EARLY_SIGNAL|SEO_SIGNAL|MEANINGFUL_IMPACT|UNDERPERFORMING|FAILED/;
function noUndefined(v, at = "doc") {
  if (v === undefined) throw new Error(`undefined at ${at}`);
  if (Array.isArray(v)) v.forEach((x, i) => noUndefined(x, `${at}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) noUndefined(x, `${at}.${k}`);
}
function invariants(s) {
  for (const c of ["impactPredictions", "seoChangeEvents", "seoExperiments", "trackingRuns"]) {
    for (const d of s.rows(c)) {
      noUndefined(d, `${c}/${d.id}`);
      const json = JSON.stringify(d);
      assert.ok(!SIGNAL.test(json.replace(/"[^"]*note[^"]*":"[^"]*"/gi, "")), `${c}/${d.id} carries an M8 signal state`);
    }
  }
  for (const x of s.rows("seoExperiments")) {
    assert.strictEqual(x.outcome, null);
    assert.strictEqual(x.signalState, null);
    assert.strictEqual(x.attributionConfidence, null);
  }
  for (const e of s.rows("seoChangeEvents")) assert.strictEqual(e.afterSnapshot.status, "pending");
  assert.strictEqual(s.rows("apiUsage").length, 0, "no provider ledger entry");
  assert.ok(!s.fake.queryLog.some((q) => ["integrations", "apiUsage", "apiCircuitBreakers"].includes(q.collection)), "no provider-path reads");
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.stack.split("\n").slice(0, 3).join(" | ")}`);
  }
}

(async () => {
  await test("acceptance is not implementation: accepting creates no event and no prediction", async () => {
    const s = await setup();
    assert.strictEqual(s.rows("seoChangeEvents").length, 0);
    assert.strictEqual(s.rows("impactPredictions").length, 0);
    assert.strictEqual(s.rows("seoExperiments").length, 0);
  });

  await test("tracking run: provisional prediction only for accepted actionable decisions", async () => {
    const s = await setup({ accept: [D_RANK, D_GAP] }); // tGap is WAIT
    const r = await s.track();
    assert.strictEqual(r.decision, "computed");
    const p = preds(s);
    assert.strictEqual(p.length, 1, JSON.stringify(p.map((x) => x.decisionId)));
    assert.strictEqual(p[0].decisionId, D_RANK);
    assert.strictEqual(p[0].status, "provisional");
    assert.strictEqual(p[0].kind, "provisional");
    assert.strictEqual(p[0].predictionVersion, 1);
    assert.strictEqual(p[0].changeType, "content");
    assert.strictEqual(p[0].baselineSnapshot.status, "candidate");
    assert.ok(p[0].confidence === "medium" || p[0].confidence === "low");
    assert.strictEqual(s.rows("seoChangeEvents").length, 0, "a tracking run never implements");
    invariants(s);
  });

  await test("pending CREATE / unaccepted decisions get no speculative prediction", async () => {
    const s = await setup({ accept: [] });
    await s.track();
    assert.strictEqual(preds(s).length, 0);
  });

  await test("cache hit: unchanged rerun performs zero writes", async () => {
    const s = await setup();
    await s.track();
    s.fake.failWritesAfter(0);
    const r = await s.track(NOW + 1000);
    assert.strictEqual(r.decision, "cache_hit");
    assert.strictEqual(r.written, 0);
    assert.strictEqual(s.fake.writeCount(), 0);
  });

  await test("changed relevant input recomputes: new provisional version, old superseded", async () => {
    const s = await setup();
    await s.track();
    const ti = s.rows("topicIntelligence").find((t) => t.topicId === "tRank");
    ti.gscCurrent.pages[0].impressions = 500;
    await s.db.collection("topicIntelligence").doc(ti.id).set(ti);
    const r = await s.track(NOW + 1000);
    assert.strictEqual(r.decision, "computed");
    const p = preds(s).sort((a, b) => a.predictionVersion - b.predictionVersion);
    assert.strictEqual(p.length, 2);
    assert.strictEqual(p[0].status, "superseded");
    assert.strictEqual(p[0].supersededBy, p[1].id);
    assert.strictEqual(p[1].predictionVersion, 2);
    assert.strictEqual(p[1].status, "provisional");
  });

  await test("un-accepted decision: its provisional prediction is withdrawn, not deleted", async () => {
    const s = await setup();
    await s.track();
    await s.db.collection("decisions").doc(D_RANK).update({ ownerStatus: "deferred" });
    await s.track(NOW + 1000);
    const p = preds(s);
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].status, "withdrawn");
  });

  await test("P1: pending, WAIT and future-dated implementations are rejected and write nothing", async () => {
    const s = await setup({ accept: [D_GAP] });
    s.fake.failWritesAfter(0);
    await expectReject(s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"] }), 409, /accepted/);
    await expectReject(s.record({ decisionId: D_GAP, implementedDate: "2026-10-08", changedElements: ["body_content"] }), 409, /cannot be implemented/);
    await expectReject(s.record({ decisionId: D_RANK, implementedDate: "2026-10-12", changedElements: ["body_content"] }), 400, /future/);
    await expectReject(s.record({ decisionId: "nope", implementedDate: "2026-10-08", changedElements: ["title"] }), 404);
    await expectReject(s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["title"], ownerAttestation: false }), 400, /attestation/i);
    assert.strictEqual(s.fake.writeCount(), 0);
  });

  await test("record: one deterministic change event, ex-ante commit, experiment, linked before-snapshot", async () => {
    const s = await setup();
    await s.track();
    const prov = preds(s)[0];
    const r = await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content", "h1"], implementationNotes: "rewrote the intro", responsibleActor: { type: "contractor", name: "Studio dev" } });
    assert.strictEqual(r.duplicate, false);
    assert.strictEqual(r.changeEventId, T.changeEventIdOf(BIZ, D_RANK, ARCH, "2026-10-08"));
    assert.strictEqual(r.predictionId, prov.id, "the ex-ante provisional is committed");
    assert.strictEqual(r.predictionDerivation, "ex_ante");
    const p = s.rows("impactPredictions").find((x) => x.id === prov.id);
    assert.strictEqual(p.status, "committed");
    assert.strictEqual(p.committedTo, r.changeEventId);
    const e = s.rows("seoChangeEvents")[0];
    assert.strictEqual(e.implementationStatus, "recorded");
    assert.strictEqual(e.basis, "owner_reported");
    assert.strictEqual(e.beforeSnapshot.status, "linked");
    assert.strictEqual(e.beforeSnapshot.baselineId, `${BIZ}_v1`);
    assert.strictEqual(e.beforeSnapshot.capturedAtRecording, false);
    assert.strictEqual(e.afterSnapshot.status, "pending");
    assert.strictEqual(e.afterSnapshot.reservedFor, "M8");
    assert.strictEqual(e.implementationNotes, "rewrote the intro");
    assert.deepStrictEqual(e.responsibleActor, { type: "contractor", name: "Studio dev" });
    assert.strictEqual(e.implementationMatch, "full");
    assert.strictEqual(e.ownerAttestation.attested, true);
    assert.strictEqual(e.experimentId, r.experimentId);
    const x = s.rows("seoExperiments");
    assert.strictEqual(x.length, 1);
    assert.strictEqual(x[0].unit.pageKey, ARCH);
    assert.strictEqual(x[0].status, "open");
    assert.ok(T.holdStatusAt(x[0], NOW).active);
    assert.strictEqual(x[0].ownerHoldRelease, null);
    assert.ok(x[0].predictionId, "experiment-level prediction");
    assert.ok(s.rows("impactPredictions").some((q) => q.id === x[0].predictionId && q.kind === "experiment"));
    assert.strictEqual(r.experimentState, "TOO_EARLY", "published 8 Oct; stage A starts 7 days later");
    invariants(s);
  });

  await test("duplicate record: same implementation again -> duplicate, zero writes", async () => {
    const s = await setup();
    const body = { decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"] };
    const a = await s.record(body);
    s.fake.failWritesAfter(0);
    const b = await s.record(body);
    assert.strictEqual(b.duplicate, true);
    assert.strictEqual(b.changeEventId, a.changeEventId);
    assert.strictEqual(b.written, 0);
    assert.strictEqual(s.fake.writeCount(), 0);
    // still a duplicate after M6 turned the decision into MONITOR
    s.fake.failWritesAfter(null);
    await s.db.collection("decisions").doc(D_RANK).update({ decision: "MONITOR", reasonCodes: ["IMPLEMENTED_UNDER_OBSERVATION"], churnHold: { heldDecision: "IMPROVE", heldActionDetails: ["strengthen_content"], heldRecommendedPage: { kind: "existing", pageKey: ARCH, url: F.urlOf("architecture") } } });
    const c = await s.record(body);
    assert.strictEqual(c.duplicate, true);
    assert.strictEqual(s.rows("seoChangeEvents").length, 1);
  });

  await test("retroactive: no provisional prediction -> re-derived from pre-change evidence, flagged, confidence lowered", async () => {
    const s = await setup({ accept: [D_SITE] });
    const r = await s.record({ decisionId: D_SITE, implementedDate: "2026-10-08", changedElements: ["business_facts"] });
    const p = s.rows("impactPredictions").find((x) => x.id === r.predictionId);
    assert.strictEqual(p.retroactive, true);
    assert.strictEqual(p.derivation, "retroactive");
    assert.strictEqual(p.status, "committed");
    assert.strictEqual(p.confidence, "low");
    assert.ok(p.confidenceReasons.some((t) => /retroactive/.test(t)));
    assert.strictEqual(p.changeType, "entity_facts");
    assert.strictEqual(s.rows("seoExperiments")[0].unit.pageKey, "site");
  });

  await test("re-derived: the implemented class differs from the provisional -> new committed, provisional superseded", async () => {
    const s = await setup();
    await s.track();
    const prov = preds(s)[0];
    const r = await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["title"], implementationMatch: "partial", deviationNote: "only the title changed" });
    assert.notStrictEqual(r.predictionId, prov.id);
    assert.strictEqual(r.predictionDerivation, "re_derived");
    const p = s.rows("impactPredictions").find((x) => x.id === r.predictionId);
    assert.strictEqual(p.changeType, "snippet");
    assert.strictEqual(p.retroactive, false);
    assert.strictEqual(s.rows("impactPredictions").find((x) => x.id === prov.id).status, "superseded");
    assert.strictEqual(s.rows("seoChangeEvents")[0].implementationMatch, "partial");
  });

  await test("P3: post-change crawl data is never used as the before state (contaminated)", async () => {
    const s = await setup();
    // implemented on 2 Oct; the only analysis and baseline are from 6 Oct
    const r = await s.record({ decisionId: D_RANK, implementedDate: "2026-10-02", changedElements: ["body_content"] });
    assert.strictEqual(r.beforeSnapshot.status, "contaminated");
    const p = s.rows("impactPredictions").find((x) => x.id === r.predictionId);
    assert.strictEqual(p.baselineSnapshot.status, "contaminated");
    assert.strictEqual(p.retroactive, true);
    // the live (post-change) page and visibility were ignored
    assert.strictEqual(p.predictionFactors.find((f) => f.key === "target_visibility").basis, "unknown");
    assert.strictEqual(p.sources.pageBasis, "none");
    assert.strictEqual(p.predictionFactors.find((f) => f.key === "site_search_console_activity").basis, "unknown", "snapshots after the cutoff are ignored too");
    assert.strictEqual(s.rows("baselines").length, 1, "no baseline fabricated");
    assert.ok(s.rows("seoExperiments")[0].warnings.includes("missing_baseline"));
  });

  await test("P3 step 2: no baseline yet, stored state pre-change -> new immutable baseline captured from stored data", async () => {
    const s = await setup({ baseline: false });
    const before = s.rows("baselines").length;
    const r = await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"] });
    assert.strictEqual(r.beforeSnapshot.status, "linked");
    assert.strictEqual(r.beforeSnapshot.capturedAtRecording, true);
    const b = s.rows("baselines");
    assert.strictEqual(b.length, before + 1);
    assert.strictEqual(b[0].sourceRunId, "run1");
    assert.ok(b[0].referenceKeys.pageKeys.includes(ARCH));
    assert.strictEqual(b[0].immutable, true);
  });

  await test("#39: the baseline cap never drops a page an accepted decision targets", async () => {
    const s = await setup({
      baseline: false,
      mutate: (f) => {
        for (let i = 0; i < 120; i++) f.seoPages.push(F.page(`a-filler-${String(i).padStart(3, "0")}`, "other", `filler ${i}`));
        return f;
      }
    });
    const store = F.loadWithFake(s.fake, path.join(__dirname, "..", "searchIntelligenceStore.js"));
    const b = await store.captureBaseline({ businessId: BIZ, capturedBy: "t", nowMs: NOW });
    assert.ok(b.referenceKeys.pageKeys.includes(ARCH), "accepted decision's page kept");
    assert.strictEqual(b.pages.length, 100, "cap unchanged");
    assert.strictEqual(b.selection.requiredPages, 1);
    assert.ok(b.selection.pagesNotIncluded > 0);
  });

  await test("CREATE: targetUrl required and must be on the business's site", async () => {
    const s = await setup({ accept: [D_LEARN] });
    await expectReject(s.record({ decisionId: D_LEARN, implementedDate: "2026-10-08", changedElements: ["new_page_published"] }), 400, /targetUrl/);
    await expectReject(s.record({ decisionId: D_LEARN, implementedDate: "2026-10-08", changedElements: ["new_page_published"], targetUrl: "https://evil.example/x" }), 400, /own website/);
    const r = await s.record({ decisionId: D_LEARN, implementedDate: "2026-10-08", changedElements: ["new_page_published", "internal_links_added"], targetUrl: "https://www.hagarlushi.com/how-to-choose" });
    const e = s.rows("seoChangeEvents")[0];
    assert.strictEqual(e.targetPageKey, "hagarlushi.com/how-to-choose");
    assert.strictEqual(s.rows("impactPredictions").find((x) => x.id === r.predictionId).changeType, "new_page");
  });

  await test("implemented on a different page than recommended -> at most partial, deviation required", async () => {
    const s = await setup();
    await expectReject(s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"], targetUrl: F.urlOf("interior") }), 400, /deviation/);
    const r = await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"], targetUrl: F.urlOf("interior"), deviationNote: "changed the interior page instead" });
    assert.strictEqual(r.implementationMatch, "partial");
    const e = s.rows("seoChangeEvents")[0];
    assert.strictEqual(e.targetPageKey, F.keyOf("interior"));
    assert.strictEqual(e.recommendedPageKey, ARCH);
  });

  await test("verification after the next crawl: title change verified; window state by time", async () => {
    const s = await setup();
    await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["title"], implementationMatch: "full" });
    // next M4 crawl on 10 Oct sees the new title
    const pg = s.rows("seoPages").find((p) => p.pageKey === ARCH);
    await s.db.collection("seoPages").doc(pg.id).set({ ...pg, title: "אדריכלות למגורים בקיסריה", lastCrawledAtMs: NOW - DAY });
    await s.db.collection("intelligenceRuns").doc("run2").set({ businessId: BIZ, status: "completed", completedAtMs: NOW - DAY });
    const r = await s.track();
    assert.strictEqual(r.summary.verified, 1);
    const e = s.rows("seoChangeEvents")[0];
    assert.strictEqual(e.implementationStatus, "verified");
    assert.strictEqual(e.verification.checks[0].result, "confirmed");
    assert.ok(/says nothing about SEO results/.test(e.verification.note));
    assert.ok(e.history.some((h) => h.event === "verification"));
    // idempotent: same crawl -> no second verification entry, then cache hit
    await s.track(NOW + 1000);
    assert.strictEqual(s.rows("seoChangeEvents")[0].history.filter((h) => h.event === "verification").length, 1);
    s.fake.failWritesAfter(0);
    assert.strictEqual((await s.track(NOW + 2000)).decision, "cache_hit");
  });

  await test("a contradicted verification closes the experiment (structural INCONCLUSIVE)", async () => {
    const s = await setup({ accept: [`${BIZ}_page_e38464d3e0076b06`] }); // contact page fix_eligibility
    await s.record({ decisionId: `${BIZ}_page_e38464d3e0076b06`, implementedDate: "2026-10-08", changedElements: ["canonical_tag"] });
    await s.db.collection("intelligenceRuns").doc("run2").set({ businessId: BIZ, status: "completed", completedAtMs: NOW - DAY });
    const pg = s.rows("seoPages").find((p) => p.pageKey === F.keyOf("contact"));
    await s.db.collection("seoPages").doc(pg.id).set({ ...pg, lastCrawledAtMs: NOW - DAY });
    await s.track();
    assert.strictEqual(s.rows("seoChangeEvents")[0].implementationStatus, "contradicted");
    const x = s.rows("seoExperiments")[0];
    assert.strictEqual(x.status, "closed");
    assert.strictEqual(x.timeState, "INCONCLUSIVE");
    assert.strictEqual(T.holdStatusAt(x, NOW).active, false);
  });

  await test("same page: second change within 14 days joins the experiment; later one joins late", async () => {
    const s = await setup();
    await s.record({ decisionId: D_RANK, implementedDate: "2026-09-20", changedElements: ["title"] }, NOW);
    await s.record({ decisionId: D_RANK, implementedDate: "2026-09-25", changedElements: ["h1"] }, NOW);
    let x = s.rows("seoExperiments");
    assert.strictEqual(x.length, 1);
    assert.deepStrictEqual(x[0].groupedChangeEventIds.length, 2);
    await s.record({ decisionId: D_RANK, implementedDate: "2026-10-10", changedElements: ["body_content"] }, NOW);
    x = s.rows("seoExperiments");
    assert.strictEqual(x.length, 1);
    assert.strictEqual(x[0].lateChangeEventIds.length, 1);
    assert.strictEqual(x[0].timeState, "CHANGE_IN_OBSERVATION_WINDOW");
    assert.strictEqual(x[0].extensions, 1);
    assert.ok(s.rows("seoChangeEvents").every((e) => e.experimentId === x[0].id));
    assert.strictEqual(s.rows("seoChangeEvents").filter((e) => e.lateJoin).length, 1);
  });

  await test("revert: event reverted (history kept), experiment INCONCLUSIVE, hold released", async () => {
    const s = await setup();
    const r = await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"] });
    const out = await s.store.recordImplementation({ businessId: BIZ, body: { action: "revert", changeEventId: r.changeEventId, revertNote: "wrong date" }, uid: "owner", nowMs: NOW });
    assert.strictEqual(out.reverted, true);
    const e = s.rows("seoChangeEvents")[0];
    assert.strictEqual(e.implementationStatus, "reverted");
    assert.strictEqual(e.implementationDate, "2026-10-08", "dates are never edited");
    assert.ok(e.history.some((h) => h.event === "reverted"));
    const x = s.rows("seoExperiments")[0];
    assert.strictEqual(x.timeState, "INCONCLUSIVE");
    assert.strictEqual(T.holdStatusAt(x, NOW).active, false);
    // the corrected date is a new event (and joins / opens an experiment)
    await s.record({ decisionId: D_RANK, implementedDate: "2026-10-09", changedElements: ["body_content"] });
    assert.strictEqual(s.rows("seoChangeEvents").length, 2);
  });

  await test("concurrency: a tracking run and a record at the same time -> one proceeds, the other in_progress", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([s.track(), s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"] })]);
    const decisions = [a.decision, b.decision || (b.duplicate === false ? "recorded" : "?")];
    assert.ok(decisions.includes("in_progress"), JSON.stringify(decisions));
    assert.ok(s.rows("trackingRunLocks").length === 0, "lock released");
  });

  await test("partial-write failure: run marked failed, retry repairs, then cache hit", async () => {
    const s = await setup();
    await s.record({ decisionId: D_RANK, implementedDate: "2026-09-20", changedElements: ["title"] });
    await s.record({ decisionId: D_RANK, implementedDate: "2026-10-10", changedElements: ["body_content"] });
    await s.db.collection("decisions").doc(D_SITE).update({ ownerStatus: "accepted" });
    s.fake.failNthWrite(4); // lock, run doc, chunk 1 ok; chunk 2 fails
    let failed = false;
    try {
      await s.track(NOW, { batchSize: 1 });
    } catch (err) {
      failed = true;
    }
    assert.ok(failed);
    const run = s.rows("trackingRuns").find((r) => r.status === "failed");
    assert.ok(run && run.failedPhase === "write" && run.chunksCommitted >= 1);
    const ok = await s.track(NOW, { batchSize: 1 });
    assert.strictEqual(ok.decision, "computed");
    assert.strictEqual(s.rows("trackingRuns").find((r) => r.id === run.id).status, "completed");
    s.fake.failWritesAfter(0);
    assert.strictEqual((await s.track(NOW + 1)).decision, "cache_hit");
  });

  await test("abandoned run: an expired lock is taken over and its run marked abandoned", async () => {
    const s = await setup();
    await s.db.collection("trackingRunLocks").doc(BIZ).set({ businessId: BIZ, owner: "dead", acquiredAtMs: NOW - 10 * 60000, leaseExpiresAtMs: NOW - 5 * 60000 });
    await s.db.collection("trackingRuns").doc(`${BIZ}_trk_old`).set({ businessId: BIZ, status: "running", startedAtMs: NOW - 10 * 60000 });
    const r = await s.track();
    assert.strictEqual(r.decision, "computed");
    assert.strictEqual(s.rows("trackingRuns").find((x) => x.id === `${BIZ}_trk_old`).status, "abandoned");
  });

  await test("held lock -> in_progress with zero writes", async () => {
    const s = await setup();
    await s.db.collection("trackingRunLocks").doc(BIZ).set({ businessId: BIZ, owner: "other", acquiredAtMs: NOW, leaseExpiresAtMs: NOW + 60000 });
    const r = await s.track();
    assert.strictEqual(r.decision, "in_progress");
    const rr = await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"] });
    assert.strictEqual(rr.decision, "in_progress");
    for (const c of ["trackingRuns", "seoChangeEvents", "impactPredictions", "seoExperiments"]) assert.strictEqual(s.rows(c).length, 0, c);
  });

  await test("fail closed: a read failure aborts before any write", async () => {
    const s = await setup();
    s.fake.failNextQueries(1);
    s.fake.failWritesAfter(0);
    await assert.rejects(s.track());
    s.fake.failNextQueries(1);
    await assert.rejects(s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"] }));
    assert.strictEqual(s.fake.writeCount(), 0);
  });

  await test("M3-M6 documents untouched by M7 (decisions, intents, opportunities, topics, pages)", async () => {
    const s = await setup();
    const snap = () => JSON.stringify(["decisions", "searchIntents", "opportunities", "searchTopics", "seoPages", "topicIntelligence", "opportunityRuns", "decisionRuns"].map((c) => s.rows(c)));
    const before = snap();
    await s.track();
    await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"] });
    await s.track(NOW + 1000);
    assert.strictEqual(snap(), before);
    invariants(s);
  });

  await test("no M7 write on render: the endpoints are the only writers (static)", async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "trackingStore.js"), "utf8");
    assert.ok(!/crawlSite\(|fetchPage\(|runGoverned\(|fetchQueryPageRows/.test(src), "no crawl or provider call");
    const eng = fs.readFileSync(path.join(__dirname, "..", "trackingEngine.js"), "utf8");
    assert.ok(/method !== "POST"/.test(eng) && /requireAdmin/.test(eng));
    assert.ok(!/pubsub|schedule\(/.test(eng), "no scheduled tracking in v1");
  });

  const failed = results.filter((r) => r.startsWith("FAIL"));
  console.log(results.join("\n"));
  console.log(`\n${results.length - failed.length}/${results.length} tracking store tests passed`);
  if (failed.length) process.exit(1);
})();
