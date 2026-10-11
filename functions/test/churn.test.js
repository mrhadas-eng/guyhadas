// M7 <-> M6 churn integration tests (docs/M7_DESIGN.md §9, §14 "Churn").
// The overlap matrix and overrides run through the real M6 decide(); the
// lifecycle tests run M6 + M7 stores on the index-enforcing fake Firestore.
// Run: node functions/test/churn.test.js

const assert = require("assert");
const F = require("./helpers/m7Fixture");
const S = require("./helpers/m7Setup");
const { decide } = require("../decisionRules");
const T = require("../trackingRules");

const { BIZ, NOW } = F;
const DAY = 86400000;
const ARCH = F.keyOf("architecture");
const CONTACT = F.keyOf("contact");
const D_RANK = `${BIZ}_intent_${BIZ}_tRank`;
const D_LEARN = `${BIZ}_intent_${BIZ}_tLearn`;
const D_SITE = `${BIZ}_site_fact_consistency`;
const D_CONTACT = `${BIZ}_page_e38464d3e0076b06`;
const I_RANK = `${BIZ}_tRank`;

function pure(f, experiments = []) {
  return decide({ business: f.business, services: f.services, knowledge: f.knowledge, searchTopics: f.searchTopics, topicIntel: f.topicIntel, seoPages: f.seoPages, opportunities: f.opportunities, baseline: f.baseline, policy: F.cfg.resolvePolicy(f.business.decisionPolicy), nowMs: NOW, experiments });
}
const get = (r, id) => r.decisions.find((d) => d.decisionId === id);

function exp(over = {}) {
  return {
    experimentId: over.id || "exp1",
    id: over.id || "exp1",
    status: "open",
    unit: { scope: over.scope || "page", pageKey: over.pageKey === undefined ? ARCH : over.pageKey },
    affectedPageKeys: over.affectedPageKeys || [],
    intentIds: over.intentIds || [I_RANK],
    decisionIds: over.decisionIds || ["someOtherDecision"],
    signalKeys: over.signalKeys || [],
    liveChangeEventIds: over.live || ["chg1"],
    startMs: over.startMs || NOW - 10 * DAY,
    stageWindows: { A: { fromMs: NOW - 3 * DAY, toMs: over.aEnd === undefined ? NOW + 20 * DAY : over.aEnd } },
    hold: { holdUntilMs: over.holdUntil === undefined ? NOW + 60 * DAY : over.holdUntil, materiality: over.mat || "major", classes: over.classes || ["content"], beforeEligibility: over.beforeEligibility || {} },
    ownerHoldRelease: over.release ? { released: true, note: "go", atMs: NOW - DAY } : null
  };
}

// tRank as a CTR (snippet = moderate) recommendation instead of content
const snippetFixture = () => {
  const f = F.fixture();
  f.opportunities = f.opportunities.map((o) => (o.type === "ranking_upside" ? { ...o, type: "ctr_upside" } : o));
  return f;
};

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
  const baseRun = pure(F.fixture());
  assert.strictEqual(get(baseRun, D_RANK).decision, "IMPROVE");

  await test("implemented decision itself -> MONITOR IMPLEMENTED_UNDER_OBSERVATION; held value kept", async () => {
    const d = get(pure(F.fixture(), [exp({ decisionIds: [D_RANK] })]), D_RANK);
    assert.strictEqual(d.decision, "MONITOR");
    assert.ok(d.reasonCodes.includes("IMPLEMENTED_UNDER_OBSERVATION"));
    assert.ok(d.blockingConditions.includes("WAIT_FOR_OBSERVATION_WINDOW"));
    assert.ok(d.dependencies.some((x) => x.experimentId === "exp1" && x.relation === "under_observation"));
    assert.strictEqual(d.churnHold.heldDecision, "IMPROVE");
    assert.deepStrictEqual(d.churnHold.heldActionDetails, ["strengthen_content"]);
    assert.strictEqual(d.churnHold.heldRecommendedPage.pageKey, ARCH);
    assert.ok(d.evidence.some((e) => e.id === "seoExperiments/exp1#hold"));
    assert.ok(d.newPageJustification, "M6 rationale preserved");
  });

  await test("matrix: same page, same intent, major -> WAIT RECENT_CHANGE_UNDER_OBSERVATION", async () => {
    const d = get(pure(F.fixture(), [exp()]), D_RANK);
    assert.strictEqual(d.decision, "WAIT");
    assert.ok(d.reasonCodes.includes("RECENT_CHANGE_UNDER_OBSERVATION"));
    assert.ok(d.blockingConditions.includes("WAIT_FOR_OBSERVATION_WINDOW"));
    assert.ok(d.dependencies.some((x) => x.relation === "held_by_observation"));
    assert.strictEqual(d.churnHold.overlap, "same_page_same_intent");
    assert.strictEqual(d.churnHold.heldDecision, "IMPROVE");
    assert.strictEqual(d.recommendedPage.pageKey, ARCH, "held recommendation not discarded");
  });

  await test("matrix: same page, same intent, moderate D: WAIT if E major or before E's stage A ends; allowed after", async () => {
    const f = snippetFixture;
    assert.deepStrictEqual(get(pure(f()), D_RANK).actionDetails, ["improve_snippet"]);
    assert.strictEqual(get(pure(f(), [exp({ mat: "major" })]), D_RANK).decision, "WAIT");
    assert.strictEqual(get(pure(f(), [exp({ mat: "moderate", classes: ["snippet"] })]), D_RANK).decision, "WAIT");
    const after = get(pure(f(), [exp({ mat: "moderate", classes: ["snippet"], aEnd: NOW - DAY })]), D_RANK);
    assert.strictEqual(after.decision, "IMPROVE");
    assert.ok(after.reasonCodes.includes("RECENT_CHANGE_ON_PAGE"));
    assert.strictEqual(after.churnHold, null);
  });

  await test("matrix: same page, different intent: major -> WAIT; moderate -> allowed + note", async () => {
    assert.strictEqual(get(pure(F.fixture(), [exp({ intentIds: ["other"] })]), D_RANK).decision, "WAIT");
    const m = get(pure(snippetFixture(), [exp({ intentIds: ["other"] })]), D_RANK);
    assert.strictEqual(m.decision, "IMPROVE");
    assert.ok(m.reasonCodes.includes("RECENT_CHANGE_ON_PAGE"));
  });

  await test("matrix: different page, same intent: IMPROVE allowed (noted); CREATE held without budget use", async () => {
    const d = get(pure(F.fixture(), [exp({ pageKey: F.keyOf("interior") })]), D_RANK);
    assert.strictEqual(d.decision, "IMPROVE");
    assert.ok(d.reasonCodes.includes("RELATED_EXPERIMENT_ACTIVE"));
    const r = pure(F.fixture(), [exp({ pageKey: F.keyOf("interior"), intentIds: [`${BIZ}_tLearn`] })]);
    const c = get(r, D_LEARN);
    assert.strictEqual(c.decision, "WAIT");
    assert.strictEqual(c.churnHold.heldDecision, "CREATE");
    assert.strictEqual(c.churnHold.heldRecommendedPage.kind, "new_page_placeholder");
    assert.strictEqual(r.summary.creates, 0);
    assert.strictEqual(r.summary.createCandidates, 0, "a held CREATE is not a G5/G11 candidate");
  });

  await test("matrix: site-wide experiment: page decisions allowed (noted), same site signal held", async () => {
    const r = pure(F.fixture(), [exp({ scope: "site", pageKey: "site", intentIds: [], signalKeys: ["fact_consistency"], mat: "site", classes: ["entity_facts"] })]);
    assert.strictEqual(get(r, D_RANK).decision, "IMPROVE");
    assert.ok(get(r, D_RANK).reasonCodes.includes("RELATED_EXPERIMENT_ACTIVE"));
    assert.strictEqual(get(r, D_SITE).decision, "WAIT");
    assert.strictEqual(get(r, D_SITE).churnHold.overlap, "site_same_signal");
    const other = pure(F.fixture(), [exp({ scope: "site", pageKey: "site", intentIds: [], signalKeys: ["contact_details"], mat: "site" })]);
    assert.strictEqual(get(other, D_SITE).decision, "IMPROVE");
  });

  await test("unrelated experiment: no decision changes at all (no over-blocking)", async () => {
    const r = pure(F.fixture(), [exp({ pageKey: F.keyOf("unrelated"), intentIds: ["x"], decisionIds: ["y"] })]);
    assert.deepStrictEqual(r.decisions.map((d) => [d.decisionId, d.decision, d.reasonCodes]), baseRun.decisions.map((d) => [d.decisionId, d.decision, d.reasonCodes]));
  });

  await test("override: owner release -> decision proceeds with CHURN_OVERRIDE_OWNER_RELEASE", async () => {
    const d = get(pure(F.fixture(), [exp({ release: true })]), D_RANK);
    assert.strictEqual(d.decision, "IMPROVE");
    assert.ok(d.reasonCodes.includes("CHURN_OVERRIDE_OWNER_RELEASE"));
    assert.ok(d.churnNotes.some((n) => n.interference && n.experimentId === "exp1"));
  });

  await test("override: change not in effect (reverted / contradicted) -> proceeds", async () => {
    const d = get(pure(F.fixture(), [exp({ live: [] })]), D_RANK);
    assert.strictEqual(d.decision, "IMPROVE");
    assert.ok(d.reasonCodes.includes("CHURN_OVERRIDE_CHANGE_NOT_IN_EFFECT"));
  });

  await test("override: eligibility regression after publication -> fix proceeds", async () => {
    const held = get(pure(F.fixture(), [exp({ pageKey: CONTACT, intentIds: [] })]), D_CONTACT);
    assert.strictEqual(held.decision, "WAIT", "without a regression the page-level fix is held");
    const d = get(pure(F.fixture(), [exp({ pageKey: CONTACT, intentIds: [], beforeEligibility: { [CONTACT]: "eligible" } })]), D_CONTACT);
    assert.strictEqual(d.decision, "IMPROVE");
    assert.ok(d.reasonCodes.includes("CHURN_OVERRIDE_ELIGIBILITY_REGRESSION"));
  });

  await test("override: new opportunity after publication (same page, different intent, different class)", async () => {
    const f = F.fixture();
    for (const o of f.opportunities) o.firstDetectedAtMs = NOW - DAY;
    const d = get(pure(f, [exp({ intentIds: ["other"], classes: ["snippet"], startMs: NOW - 10 * DAY })]), D_RANK);
    assert.strictEqual(d.decision, "IMPROVE");
    assert.ok(d.reasonCodes.includes("CHURN_OVERRIDE_NEW_OPPORTUNITY"));
    const g = F.fixture();
    for (const o of g.opportunities) o.firstDetectedAtMs = NOW - 20 * DAY;
    assert.strictEqual(get(pure(g, [exp({ intentIds: ["other"], classes: ["snippet"], startMs: NOW - 10 * DAY })]), D_RANK).decision, "WAIT");
  });

  await test("expired hold and closed experiments: no effect", async () => {
    const a = pure(F.fixture(), [exp({ holdUntil: NOW - 1 })]);
    const b = pure(F.fixture(), [{ ...exp(), status: "closed" }]);
    for (const r of [a, b]) assert.deepStrictEqual(r.decisions.map((d) => [d.decisionId, d.decision]), baseRun.decisions.map((d) => [d.decisionId, d.decision]));
  });

  await test("owner REJECT and WAIT are never changed by a hold", async () => {
    const f = F.fixture();
    for (const o of f.opportunities.filter((x) => x.targetTopicIds.includes("tRank"))) o.status = "rejected";
    const d = get(pure(f, [exp({ decisionIds: [D_RANK] })]), D_RANK);
    assert.strictEqual(d.decision, "REJECT");
    assert.strictEqual(d.churnHold, null);
  });

  await test("deterministic: experiment order does not change the result", async () => {
    const xs = [exp({ id: "a" }), exp({ id: "b", pageKey: F.keyOf("interior") }), exp({ id: "c", scope: "site", pageKey: "site", signalKeys: ["fact_consistency"], mat: "site" })];
    const r1 = pure(F.fixture(), xs);
    const r2 = pure(F.fixture(), [...xs].reverse());
    assert.deepStrictEqual(r1.decisions, r2.decisions);
  });

  // --- lifecycle through the real stores ------------------------------------

  await test("end to end: record -> M6 run: implemented decision MONITOR, accepted kept, unrelated untouched", async () => {
    const s = await S.setup({ accept: [D_RANK] });
    await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"] });
    const r = await s.m6.runDecisionEngine({ businessId: BIZ, nowMs: NOW + 1000 });
    assert.strictEqual(r.decision, "computed");
    const d = s.rows("decisions").find((x) => x.id === D_RANK);
    assert.strictEqual(d.decision, "MONITOR");
    assert.strictEqual(d.ownerStatus, "accepted", "I-2: own implementation does not reset the review");
    assert.ok(d.decisionHistory.some((h) => h.event === "implemented"));
    assert.strictEqual(d.churnHold.heldDecision, "IMPROVE");
    for (const id of [D_SITE, D_CONTACT, D_LEARN]) assert.strictEqual(s.rows("decisions").find((x) => x.id === id).churnHold, null, id);
    assert.strictEqual(s.rows("decisions").find((x) => x.id === D_SITE).decision, "IMPROVE");
    // a further implementation of the same (held) decision is still recordable
    const again = await s.record({ decisionId: D_RANK, implementedDate: "2026-10-10", changedElements: ["title"] }, NOW + 2000);
    assert.strictEqual(again.duplicate, false);
  });

  await test("M6 fingerprint: unchanged hold -> cache hit; hold expiry -> recompute, held decision returns with history", async () => {
    const s = await S.setup({ accept: [D_RANK] });
    await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["title"] }); // snippet: hold = start + A.max
    await s.m6.runDecisionEngine({ businessId: BIZ, nowMs: NOW + 1000 });
    assert.strictEqual((await s.m6.runDecisionEngine({ businessId: BIZ, nowMs: NOW + 2000 })).decision, "cache_hit");
    const x = s.rows("seoExperiments")[0];
    const after = x.hold.holdUntilMs + 1000;
    const r = await s.m6.runDecisionEngine({ businessId: BIZ, nowMs: after });
    assert.strictEqual(r.decision, "computed", "crossing the hold boundary changes the input fingerprint");
    const d = s.rows("decisions").find((y) => y.id === D_RANK);
    assert.strictEqual(d.decision, "IMPROVE");
    assert.strictEqual(d.churnHold, null);
    assert.deepStrictEqual(d.decisionHistory.map((h) => h.decision).slice(-2), ["MONITOR", "IMPROVE"]);
  });

  await test("P2: owner hold release (client field) -> held decision returns; release survives tracking runs", async () => {
    const s = await S.setup({ accept: [D_RANK] });
    // an implemented change on the same page under ANOTHER decision holds D_RANK
    await s.db.collection("decisions").doc(D_CONTACT).update({ ownerStatus: "accepted" });
    await s.record({ decisionId: D_RANK, implementedDate: "2026-10-08", changedElements: ["body_content"] });
    const x0 = s.rows("seoExperiments")[0];
    // simulate a second decision on the same page by re-pointing the experiment's decision ids
    await s.db.collection("seoExperiments").doc(x0.id).update({ decisionIds: ["anotherDecision"] });
    await s.m6.runDecisionEngine({ businessId: BIZ, nowMs: NOW + 1000 });
    assert.strictEqual(s.rows("decisions").find((d) => d.id === D_RANK).decision, "WAIT");
    // owner releases the hold (the only owner field on experiments)
    await s.db.collection("seoExperiments").doc(x0.id).update({ ownerHoldRelease: { released: true, note: "need to fix now", atMs: NOW + 1500 }, updatedAt: "now" });
    await s.m6.runDecisionEngine({ businessId: BIZ, nowMs: NOW + 2000 });
    const d = s.rows("decisions").find((y) => y.id === D_RANK);
    assert.strictEqual(d.decision, "IMPROVE");
    assert.ok(d.reasonCodes.includes("CHURN_OVERRIDE_OWNER_RELEASE"));
    // a tracking run recomputes the experiment but keeps the release
    await s.track(NOW + 3000);
    const x1 = s.rows("seoExperiments").find((y) => y.id === x0.id);
    assert.strictEqual(x1.ownerHoldRelease.released, true);
    assert.strictEqual(x1.hold.releasedBy.reason, "owner_release");
    assert.strictEqual(T.holdStatusAt(x1, NOW + 3000).reason, "owner_release");
  });

  const failed = results.filter((r) => r.startsWith("FAIL"));
  console.log(results.join("\n"));
  console.log(`\n${results.length - failed.length}/${results.length} churn tests passed`);
  if (failed.length) process.exit(1);
})();
