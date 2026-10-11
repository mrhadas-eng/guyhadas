// M7 tracking rules tests (docs/M7_DESIGN.md §5, §6.4, §7, §8, §14).
// Pure module - no Firestore, no network, no clock.
// Run: node functions/test/trackingRules.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const T = require("../trackingRules");
const P = require("../predictionRules");
const cfg = require("../predictionConfig");

const BIZ = "hagar";
const TZ = "Asia/Jerusalem";
const DAY = T.DAY;
const D0 = T.startOfDayMs("2026-10-01", TZ);
const PAGE = "hagarlushi.com/architecture";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
  }
}

// committed prediction for a change of the given elements
function pred(id, elements, over = {}) {
  return P.predict({
    businessId: BIZ,
    kind: "committed",
    unitKey: id,
    decision: { decisionId: over.decisionId || "d1", decision: over.decision || "IMPROVE", actionDetails: over.actionDetails || ["strengthen_content"], scope: over.scope || "intent", intentId: "i1", confidence: "medium" },
    change: { changeEventId: id, changedElements: elements },
    target: over.target === undefined ? { pageKey: PAGE, page: { indexability: "indexable", robots: "crawlable", canonical: "valid", sitemap: "present", inboundInternalCount: 3, orphan: "linked" } } : over.target,
    visibility: { status: "observed", impressions: 380, clicks: 20, position: 8.2 },
    site: { searchConsole: { status: "available", band: "normal" }, volatility: { band: "unknown" }, traffic: { status: "unknown" } },
    intent: { intentType: "local" },
    marketDemand: { status: "not_available" },
    baseline: { status: "linked", baselineId: "b1" }
  });
}

function event(id, startDay, elements, over = {}) {
  const p = pred(id, elements, over);
  return {
    ev: {
      changeEventId: id,
      unitKey: over.unitKey || PAGE,
      scope: over.scope || "intent",
      decisionId: over.decisionId || "d1",
      intentId: over.intentId === undefined ? "i1" : over.intentId,
      opportunityIds: ["o1"],
      affectedPageKeys: [],
      startMs: D0 + startDay * DAY,
      startDate: "x",
      implementationStatus: over.status || "recorded",
      predictionId: p.predictionId,
      baselineSnapshot: { status: "linked", baselineId: "b1" }
    },
    p
  };
}

function build(list, nowMs, existing = new Map()) {
  const predictions = new Map(list.map((x) => [x.p.predictionId, x.p]));
  return T.buildExperiments({ businessId: BIZ, events: list.map((x) => x.ev), predictions, existing, nowMs });
}

// --- dates ---------------------------------------------------------------------

test("dates: start of a calendar day in the business time zone", () => {
  // Israel is UTC+3 in early October 2026 (summer time) -> 21:00 UTC the day before
  assert.strictEqual(new Date(T.startOfDayMs("2026-10-01", TZ)).toISOString(), "2026-09-30T21:00:00.000Z");
  // and UTC+2 in winter
  assert.strictEqual(new Date(T.startOfDayMs("2026-12-01", TZ)).toISOString(), "2026-11-30T22:00:00.000Z");
  assert.strictEqual(T.ymdInTz(Date.UTC(2026, 9, 10, 22, 30), TZ), "2026-10-11");
  assert.strictEqual(T.parseYmd("2026-02-30"), null);
});

// --- request validation -----------------------------------------------------------

const NOW = Date.UTC(2026, 9, 11, 9);
const okReq = () => ({ decisionId: "d1", implementedDate: "2026-10-05", publishedDate: null, changedElements: ["title"], implementationMatch: "full", responsibleActor: { type: "owner" }, ownerAttestation: true });

test("validation: a well-formed record is accepted and normalized", () => {
  const v = T.validateRecordRequest({ ...okReq(), changedElements: ["title", "h1", "title"] }, { nowMs: NOW, timeZone: TZ });
  assert.ok(v.ok, v.errors.join("; "));
  assert.deepStrictEqual(v.value.changedElements, ["h1", "title"]);
});

test("validation: future implementation date rejected; future publication allowed", () => {
  assert.ok(!T.validateRecordRequest({ ...okReq(), implementedDate: "2026-10-12" }, { nowMs: NOW, timeZone: TZ }).ok);
  assert.ok(T.validateRecordRequest({ ...okReq(), publishedDate: "2026-10-20" }, { nowMs: NOW, timeZone: TZ }).ok);
  assert.ok(!T.validateRecordRequest({ ...okReq(), publishedDate: "2026-10-01" }, { nowMs: NOW, timeZone: TZ }).ok, "published before implemented");
});

test("validation: elements, match/deviation, actor, attestation, notes length", () => {
  const bad = (o) => !T.validateRecordRequest({ ...okReq(), ...o }, { nowMs: NOW, timeZone: TZ }).ok;
  assert.ok(bad({ changedElements: [] }));
  assert.ok(bad({ changedElements: ["magic"] }));
  assert.ok(bad({ implementationMatch: "partial" }), "partial needs a deviation note");
  assert.ok(!bad({ implementationMatch: "partial", deviationNote: "only the title" }));
  assert.ok(bad({ responsibleActor: { type: "robot" } }));
  assert.ok(bad({ ownerAttestation: false }), "owner attestation is mandatory");
  assert.ok(bad({ implementationNotes: "x".repeat(2001) }));
  assert.ok(bad({ implementedDate: undefined }), "implementation date mandatory");
});

test("change event id is deterministic over (decision, page, date)", () => {
  assert.strictEqual(T.changeEventIdOf(BIZ, "d1", PAGE, "2026-10-05"), T.changeEventIdOf(BIZ, "d1", PAGE, "2026-10-05"));
  assert.notStrictEqual(T.changeEventIdOf(BIZ, "d1", PAGE, "2026-10-05"), T.changeEventIdOf(BIZ, "d1", PAGE, "2026-10-06"));
});

test("P1 recordable: accepted actionable only; acceptance != implementation", () => {
  const d = { decision: "IMPROVE", ownerStatus: "accepted", actionDetail: "improve_snippet", engineState: "active" };
  assert.ok(T.recordableDecision(d).ok);
  for (const ownerStatus of ["pending", "deferred", "rejected"]) assert.ok(!T.recordableDecision({ ...d, ownerStatus }).ok, ownerStatus);
  for (const decision of ["WAIT", "MONITOR", "REJECT"]) assert.ok(!T.recordableDecision({ ...d, decision }).ok, decision);
  assert.ok(!T.recordableDecision({ ...d, engineState: "superseded" }).ok);
  const held = { ...d, decision: "MONITOR", reasonCodes: ["IMPLEMENTED_UNDER_OBSERVATION"], churnHold: { heldDecision: "IMPROVE", heldActionDetails: ["improve_snippet"] } };
  const r = T.recordableDecision(held);
  assert.ok(r.ok && r.effectiveDecision === "IMPROVE");
});

// --- windows ---------------------------------------------------------------------

test("dynamic window: start + ceil(B.max x 1.25), bounded 28..210", () => {
  const content = pred("c", ["body_content"]); // B 23-77 -> 97
  assert.strictEqual(T.observationDays(T.windowRanges(content)), Math.ceil(77 * 1.25));
  const snippet = pred("s", ["title"]); // B 14-42 x0.85 -> 12-36 -> 45
  assert.strictEqual(T.observationDays(T.windowRanges(snippet)), Math.ceil(snippet.stages.B.maxDays * 1.25));
  assert.notStrictEqual(T.observationDays(T.windowRanges(content)), T.observationDays(T.windowRanges(snippet)), "class-dependent");
  assert.strictEqual(T.observationDays({ A: [1, 5], B: [2, 10] }), 28, "minimum");
  assert.strictEqual(T.observationDays({ A: [1, 5], B: [2, 300] }), 210, "maximum");
});

test("hold length: major -> B.max, moderate -> A.max", () => {
  const content = pred("c", ["body_content"]);
  const snippet = pred("s", ["title"]);
  assert.strictEqual(T.holdDays(content), content.stages.B.maxDays);
  assert.strictEqual(T.holdDays(snippet), snippet.stages.A.maxDays);
});

// --- states ------------------------------------------------------------------------

test("states: PENDING_PUBLICATION -> TOO_EARLY -> PENDING_MEASUREMENT by time only", () => {
  const e = event("c1", 10, ["body_content"]);
  const at = (n) => build([e], D0 + n * DAY).experiments[0];
  assert.strictEqual(at(5).timeState, "PENDING_PUBLICATION");
  assert.strictEqual(at(12).timeState, "TOO_EARLY"); // A.min = 7 days after day 10
  assert.strictEqual(at(17).timeState, "PENDING_MEASUREMENT");
  assert.strictEqual(at(400).timeState, "PENDING_MEASUREMENT", "no premature FAILED / UNDERPERFORMING from time alone");
  assert.ok(at(400).warnings.includes("window_ended_awaiting_measurement"));
});

test("M7 never sets a signal state (guard over every state and output)", () => {
  for (const s of T.SIGNAL_STATES) assert.throws(() => T.assertNoSignalState(s));
  for (const s of T.M7_STATES) assert.ok(T.assertNoSignalState(s));
  const list = [event("c1", 0, ["body_content"]), event("c2", 30, ["title"]), event("c3", 0, ["business_facts"], { unitKey: "site", scope: "site", intentId: null, target: null, actionDetails: ["clarify_business_facts"] })];
  for (const n of [-5, 1, 10, 100, 400]) {
    const out = build(list, D0 + n * DAY);
    const strip = out.experiments.map(({ _expPred, ...rest }) => rest);
    T.assertNoSignalState(strip);
    for (const x of out.experiments) {
      assert.ok(T.M7_STATES.includes(x.timeState), x.timeState);
      assert.strictEqual(x.outcome, null);
      assert.strictEqual(x.signalState, null);
      assert.strictEqual(x.attributionConfidence, null);
    }
  }
});

// --- grouping -----------------------------------------------------------------------

test("same page within 14 days -> one experiment (title + H1 + content + links)", () => {
  const list = [event("c1", 0, ["title"]), event("c2", 3, ["h1"]), event("c3", 9, ["body_content"]), event("c4", 14, ["internal_links_added"])];
  const out = build(list, D0 + 20 * DAY);
  assert.strictEqual(out.experiments.length, 1);
  const x = out.experiments[0];
  assert.deepStrictEqual(x.groupedChangeEventIds, ["c1", "c2", "c3", "c4"]);
  assert.deepStrictEqual(x.lateChangeEventIds, []);
  assert.strictEqual(x.timeState, "PENDING_MEASUREMENT");
  assert.strictEqual(x.hold.materiality, "major");
  assert.ok(x.predictionId && x.memberPredictionIds.length === 4);
});

test("after the grouping window but inside the observation window -> late join + flag + extension", () => {
  const list = [event("c1", 0, ["body_content"]), event("c2", 40, ["body_content"])];
  const out = build(list, D0 + 50 * DAY);
  assert.strictEqual(out.experiments.length, 1);
  const x = out.experiments[0];
  assert.deepStrictEqual(x.lateChangeEventIds, ["c2"]);
  assert.strictEqual(x.timeState, "CHANGE_IN_OBSERVATION_WINDOW");
  assert.strictEqual(x.extensions, 1);
  assert.strictEqual(x.observationWindowEndMs, D0 + 40 * DAY + Math.ceil(77 * 1.25) * DAY);
  assert.ok(x.interferences.some((i) => i.type === "late_change" && i.changeEventId === "c2"));
  assert.strictEqual(out.eventLate.c2, true);
});

test("extension beyond 240 days -> INCONCLUSIVE window_saturated + new linked experiment", () => {
  // content B 23-77 -> window 97 days; a change at day 90 would end at 187;
  // a chain of late changes eventually exceeds 240 days from the start
  const list = [event("c1", 0, ["body_content"]), event("c2", 90, ["body_content"]), event("c3", 180, ["body_content"])];
  const out = build(list, D0 + 200 * DAY);
  assert.strictEqual(out.experiments.length, 2);
  const [a, b] = out.experiments;
  assert.strictEqual(a.status, "closed");
  assert.strictEqual(a.closedReason, "window_saturated");
  assert.strictEqual(a.timeState, "INCONCLUSIVE");
  assert.strictEqual(a.nextExperimentId, b.experimentId);
  assert.strictEqual(b.previousExperimentId, a.experimentId);
  assert.ok(b.relatedExperimentIds.some((r) => r.experimentId === a.experimentId));
  assert.ok(b.observationWindowEndMs - b.startMs <= cfg.WINDOW.maxExperimentSpanDays * DAY);
});

test("after the window ended -> new experiment linked as previous", () => {
  const list = [event("c1", 0, ["title"]), event("c2", 120, ["title"])];
  const out = build(list, D0 + 130 * DAY);
  assert.strictEqual(out.experiments.length, 2);
  assert.strictEqual(out.experiments[1].previousExperimentId, out.experiments[0].experimentId);
  assert.strictEqual(out.experiments[1].lateChangeEventIds.length, 0);
});

test("different pages stay separate; same intent -> related", () => {
  const list = [event("c1", 0, ["body_content"]), event("c2", 2, ["body_content"], { unitKey: "hagarlushi.com/interior", decisionId: "d2" })];
  const out = build(list, D0 + 10 * DAY);
  assert.strictEqual(out.experiments.length, 2);
  for (const x of out.experiments) assert.strictEqual(x.relatedExperimentIds.filter((r) => r.relation === "same_intent").length, 1);
  const unrelated = build([event("c1", 0, ["body_content"]), event("c2", 2, ["body_content"], { unitKey: "hagarlushi.com/interior", intentId: "i2" })], D0 + 10 * DAY);
  for (const x of unrelated.experiments) assert.strictEqual(x.relatedExperimentIds.length, 0);
});

test("site-wide change: own experiment + interference note on open page experiments (state unchanged)", () => {
  const page = event("c1", 0, ["body_content"]);
  const site = event("c2", 5, ["business_facts"], { unitKey: "site", scope: "site", intentId: null, target: null, actionDetails: ["clarify_business_facts"], decisionId: "dSite" });
  const out = build([page, site], D0 + 10 * DAY);
  assert.strictEqual(out.experiments.length, 2);
  const p = out.experiments.find((x) => x.unit.scope === "page");
  const s = out.experiments.find((x) => x.unit.scope === "site");
  assert.ok(p.interferences.some((i) => i.type === "site_wide_change" && i.experimentId === s.experimentId));
  assert.strictEqual(p.timeState, "PENDING_MEASUREMENT", "attribution note only");
  assert.strictEqual(s.hold.materiality, "site");
});

test("reverted: removed from live; all reverted -> INCONCLUSIVE, hold released", () => {
  const one = build([event("c1", 0, ["title"]), event("c2", 3, ["h1"], { status: "reverted" })], D0 + 10 * DAY).experiments[0];
  assert.deepStrictEqual(one.liveChangeEventIds, ["c1"]);
  assert.strictEqual(one.status, "open");
  const none = build([event("c1", 0, ["title"], { status: "reverted" })], D0 + 10 * DAY).experiments[0];
  assert.strictEqual(none.status, "closed");
  assert.strictEqual(none.timeState, "INCONCLUSIVE");
  assert.strictEqual(none.closedReason, "reverted");
  assert.strictEqual(T.holdStatusAt(none, D0 + 10 * DAY).active, false);
  const contra = build([event("c1", 0, ["noindex_removed"], { status: "contradicted" })], D0 + 10 * DAY).experiments[0];
  assert.strictEqual(contra.closedReason, "verification_contradicted");
});

test("deterministic ids and assignment; no duplicates on re-run; order independent", () => {
  const list = [event("c1", 0, ["title"]), event("c2", 3, ["h1"]), event("c3", 40, ["body_content"])];
  const a = build(list, D0 + 50 * DAY);
  const b = build([...list].reverse(), D0 + 50 * DAY);
  const strip = (o) => o.experiments.map(({ _expPred, ...rest }) => rest);
  assert.deepStrictEqual(strip(a), strip(b));
  assert.strictEqual(new Set(a.experiments.map((x) => x.experimentId)).size, a.experiments.length);
  assert.strictEqual(a.experiments[0].experimentId, `${BIZ}_exp_${P.sha16(`${PAGE}|c1`)}`);
});

// --- hold ----------------------------------------------------------------------------

test("hold: active until holdUntil; owner release durable for the experiment; expiry", () => {
  const e = event("c1", 0, ["body_content"]);
  const x = build([e], D0 + 5 * DAY).experiments[0];
  assert.strictEqual(x.hold.holdUntilMs, D0 + e.p.stages.B.maxDays * DAY);
  assert.ok(T.holdStatusAt(x, D0 + 5 * DAY).active);
  assert.strictEqual(T.holdStatusAt(x, x.hold.holdUntilMs).reason, "expired");
  const released = { ...x, ownerHoldRelease: { released: true, note: "urgent", atMs: D0 + DAY } };
  assert.strictEqual(T.holdStatusAt(released, D0 + 5 * DAY).reason, "owner_release");
  // the release survives a recompute (owner field preserved, recorded as releasedBy)
  const again = build([e], D0 + 6 * DAY, new Map([[x.experimentId, released]])).experiments[0];
  assert.strictEqual(again.hold.releasedBy.reason, "owner_release");
  // a new experiment (after the window) is evaluated independently
  const later = build([e, event("c9", 200, ["body_content"])], D0 + 201 * DAY, new Map([[x.experimentId, released]])).experiments[1];
  assert.strictEqual(later.hold.releasedBy, null);
  assert.ok(T.holdStatusAt(later, D0 + 201 * DAY).active);
});

// --- verification ------------------------------------------------------------------------

const fetched = (o = {}) => ({ crawlStatus: "fetched", url: "https://x/a", finalUrl: "https://x/a", title: "new", h1: ["H"], h2: ["a"], indexability: { state: "indexable" }, robots: { state: "crawlable" }, canonical: { state: "valid" }, structuredData: { state: "present", types: ["Organization"] }, links: { inboundInternalCount: 4 }, ...o });
const beforeP = { title: "old", h1: ["H"], h2: ["a"], indexability: "non_indexable", robots: "blocked", canonical: "missing", structuredData: "missing", inboundInternalCount: 1 };

test("verification: verified / not_observed / not_verifiable / contradicted", () => {
  assert.strictEqual(T.verifyChange({ changedElements: ["title"], before: beforeP, current: fetched() }).status, "verified");
  assert.strictEqual(T.verifyChange({ changedElements: ["title"], before: { ...beforeP, title: "new" }, current: fetched() }).status, "not_observed");
  assert.strictEqual(T.verifyChange({ changedElements: ["body_content", "meta_description"], before: beforeP, current: fetched() }).status, "not_verifiable");
  assert.strictEqual(T.verifyChange({ changedElements: ["noindex_removed"], before: beforeP, current: fetched({ indexability: { state: "non_indexable" } }) }).status, "contradicted");
});

test("verification per observable element", () => {
  const v = (el, cur, b = beforeP, extra = {}) => T.verifyChange({ changedElements: [el], before: b, current: cur, ...extra }).checks[0].result;
  assert.strictEqual(v("h1", fetched({ h1: ["New H1"] })), "confirmed");
  assert.strictEqual(v("headings", fetched({ h2: ["b"] })), "confirmed");
  assert.strictEqual(v("headings", fetched(), { ...beforeP, h2: undefined }), "not_verifiable");
  assert.strictEqual(v("canonical_tag", fetched()), "confirmed");
  assert.strictEqual(v("canonical_tag", fetched({ canonical: { state: "missing" } })), "contradicted");
  assert.strictEqual(v("robots_rule", fetched()), "confirmed");
  assert.strictEqual(v("robots_rule", fetched({ robots: { state: "blocked" } })), "contradicted");
  assert.strictEqual(v("internal_links_added", fetched()), "confirmed");
  assert.strictEqual(v("internal_links_added", fetched({ links: { inboundInternalCount: 1 } })), "not_observed");
  assert.strictEqual(v("structured_data", fetched()), "confirmed");
  assert.strictEqual(v("new_page_published", fetched(), null), "confirmed");
  assert.strictEqual(v("new_page_published", null, null), "not_observed");
  assert.strictEqual(v("redirect", fetched({ finalUrl: "https://x/b" })), "confirmed");
  assert.strictEqual(v("redirect", fetched()), "not_observed");
  assert.strictEqual(v("title", fetched({ crawlStatus: "failed_last_run" })), "not_observed");
  const cons = T.verifyChange({ changedElements: ["canonical_tag"], changeClasses: ["consolidation"], before: beforeP, current: fetched(), affected: [fetched({ pageKey: "x/b", canonical: { state: "points_elsewhere" } })] });
  assert.strictEqual(cons.status, "verified");
});

test("verification never reads a performance metric", () => {
  const out = T.verifyChange({ changedElements: ["title"], before: beforeP, current: fetched({ impressions: 999, clicks: 5 }) });
  assert.ok(!/impressions|clicks|position/.test(JSON.stringify(out)));
  assert.ok(/says nothing about SEO results/.test(out.note));
});

// --- before-snapshot (P3) -------------------------------------------------------------------

const cutoff = T.startOfDayMs("2026-10-05", TZ);
const runs = [{ id: "r1", status: "completed", completedAtMs: cutoff - 5 * DAY }, { id: "r2", status: "completed", completedAtMs: cutoff + DAY }];
const target = { scope: "intent", kind: "existing", pageKey: PAGE, topicIds: ["t1"] };
const bl = (id, capturedAtMs, sourceRunId, pageKeys = [PAGE]) => ({ id, baselineId: id, version: 1, capturedAtMs, sourceRunId, referenceKeys: { pageKeys, topicIds: ["t1"] } });

test("P3 step 1: pre-change baseline whose source analysis completed before the cutoff", () => {
  const r = T.selectBeforeSnapshot({ baselines: [bl("b1", cutoff - 4 * DAY, "r1"), bl("b2", cutoff + 2 * DAY, "r2")], intelligenceRuns: runs, target, cutoffMs: cutoff });
  assert.strictEqual(r.status, "linked");
  assert.strictEqual(r.baseline.id, "b1");
});

test("P3: a baseline captured before the cutoff from a post-change run is not pre-change", () => {
  const r = T.selectBeforeSnapshot({ baselines: [bl("b1", cutoff - DAY, "r2")], intelligenceRuns: runs, target, cutoffMs: cutoff });
  assert.notStrictEqual(r.status, "linked");
});

test("P3: a baseline captured the same day (after the day started) is not pre-change", () => {
  const r = T.selectBeforeSnapshot({ baselines: [bl("b1", cutoff + 3600000, "r1")], intelligenceRuns: [runs[0]], target, cutoffMs: cutoff });
  assert.strictEqual(r.status, "capture", "falls through to the stored pre-change state");
});

test("P3 step 2: no baseline, stored state pre-change -> capture from stored data", () => {
  const r = T.selectBeforeSnapshot({ baselines: [bl("b0", cutoff - 9 * DAY, "r1", ["other"])], intelligenceRuns: [runs[0]], target, cutoffMs: cutoff });
  assert.strictEqual(r.status, "capture");
  assert.strictEqual(r.run.id, "r1");
});

test("P3 step 3: only post-change evidence -> contaminated; nothing -> missing (never fabricated)", () => {
  const c = T.selectBeforeSnapshot({ baselines: [], intelligenceRuns: runs, target, cutoffMs: cutoff });
  assert.strictEqual(c.status, "contaminated", "the latest stored state is post-change - a capture now would be post-change");
  assert.strictEqual(T.selectBeforeSnapshot({ baselines: [], intelligenceRuns: [], target, cutoffMs: cutoff }).status, "missing");
});

test("P3: target inclusion - page key, CREATE topic ids, site scope", () => {
  const b = bl("b1", cutoff - DAY, "r1", ["other"]);
  assert.ok(!T.baselineContains(b, target));
  assert.ok(T.baselineContains(b, { kind: "new_page", topicIds: ["t1"] }));
  assert.ok(T.baselineContains(b, { scope: "site" }));
});

test("provider-free + clock-free: tracking rules import no adapter and read no clock", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "trackingRules.js"), "utf8");
  assert.ok(!/require\(["'](firebase-admin|firebase-functions|googleapis|\.\/semrush|\.\/googleSearchConsole|\.\/visibility|\.\/apiUsage)["']\)/.test(src));
  assert.ok(!/Date\.now\(|new Date\(\)/.test(src));
});

const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(`\n${results.length - failed.length}/${results.length} tracking-rule tests passed`);
if (failed.length) process.exit(1);
