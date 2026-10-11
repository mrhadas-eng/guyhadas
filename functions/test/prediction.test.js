// M7 prediction engine tests (docs/M7_DESIGN.md §4, §14 "Prediction").
// Pure module - no Firestore, no network, no clock.
// Run: node functions/test/prediction.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const P = require("../predictionRules");
const cfg = require("../predictionConfig");

const BIZ = "hagar";
const KEY = "hagarlushi.com/architecture";

// The worked example of design §4.8: accepted IMPROVE strengthen_content on a
// visible, linked, eligible service page; normal site activity; a valid
// before-snapshot; no Semrush data.
function base(over = {}) {
  return {
    businessId: BIZ,
    kind: "provisional",
    unitKey: `${BIZ}_intent_${BIZ}_tRank`,
    decision: { decisionId: `${BIZ}_intent_${BIZ}_tRank`, decision: "IMPROVE", actionDetail: "strengthen_content", actionDetails: ["strengthen_content"], scope: "intent", intentId: `${BIZ}_tRank`, opportunityIds: ["o2", "o1"], confidence: "medium" },
    change: null,
    target: { pageKey: KEY, pageBasis: "live_seo_pages", page: { indexability: "indexable", robots: "crawlable", canonical: "valid", sitemap: "present", structuredData: "present", inboundInternalCount: 3, orphan: "linked", role: "service", wordCount: 900 } },
    visibility: { status: "observed", impressions: 380, clicks: 20, position: 8.2, queryCount: 2, source: "topicIntelligence.gscCurrent.pages" },
    site: { searchConsole: { status: "available", impressions28d: 5000, band: "normal" }, volatility: { status: "insufficient_history", band: "unknown" }, traffic: { status: "unknown" } },
    intent: { intentType: "local", intentConfidence: "high", queryCount: 2 },
    marketDemand: { status: "not_available" },
    baseline: { status: "candidate", baselineId: `${BIZ}_v1`, targetType: "page", targetId: KEY },
    retroactive: false,
    evidenceAsOfMs: 1000,
    sources: { intelligenceRunId: "run1" },
    ...over
  };
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const with_ = (fn) => {
  const b = base();
  fn(b);
  return b;
};
const days = (p, s) => [p.stages[s].minDays, p.stages[s].maxDays];

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
  }
}

test("worked example §4.8: content prior, M1 visible B x0.85, outward rounding", () => {
  const p = P.predict(base());
  assert.deepStrictEqual(days(p, "A"), [7, 35]);
  assert.deepStrictEqual(days(p, "B"), [23, 77]);
  assert.deepStrictEqual(days(p, "C"), [56, 150]);
  assert.deepStrictEqual([p.stages.A.minWeeks, p.stages.A.maxWeeks], [1, 5]);
  assert.deepStrictEqual([p.stages.B.minWeeks, p.stages.B.maxWeeks], [3, 11]);
  assert.deepStrictEqual([p.stages.C.minWeeks, p.stages.C.maxWeeks], [8, 22]);
  assert.strictEqual(p.predictedVisibilityImpact.direction, "increase");
  assert.strictEqual(p.predictedVisibilityImpact.band, "moderate");
  assert.strictEqual(p.predictedTrafficImpact.band, "small");
  assert.strictEqual(p.confidence, "medium");
  assert.strictEqual(p.changeType, "content");
  assert.strictEqual(p.predictionState, "ranges");
});

test("deterministic: same input -> same id and content", () => {
  const a = P.predict(base());
  const b = P.predict(base());
  assert.deepStrictEqual(a, b);
  assert.ok(a.predictionId.startsWith(`${BIZ}_pred_`));
});

test("input order independence (opportunityIds, actionDetails, changedElements)", () => {
  const a = P.predict(base({ change: { changeEventId: "c1", changedElements: ["title", "body_content", "h1"] }, kind: "committed", unitKey: "c1" }));
  const b = P.predict(base({ decision: { ...base().decision, opportunityIds: ["o1", "o2"] }, change: { changeEventId: "c1", changedElements: ["h1", "body_content", "title"] }, kind: "committed", unitKey: "c1" }));
  assert.strictEqual(a.predictionId, b.predictionId);
  assert.deepStrictEqual(a.stages, b.stages);
});

// Mutation tests: every relevant factor changes the identity; the ones that
// carry an effect also change the ranges or the confidence.
const MUTATIONS = [
  ["decision value", (b) => (b.decision.decision = "CONSOLIDATE"), "id"],
  ["actionDetail", (b) => (b.decision.actionDetails = ["improve_snippet"]), "ranges"],
  ["decision confidence low", (b) => (b.decision.confidence = "low"), "confidence"],
  ["target indexability", (b) => (b.target.page.indexability = "non_indexable"), "ranges"],
  ["target robots", (b) => (b.target.page.robots = "blocked"), "ranges"],
  ["target canonical elsewhere", (b) => (b.target.page.canonical = "points_elsewhere"), "ranges"],
  ["sitemap absent", (b) => (b.target.page.sitemap = "absent"), "ranges"],
  ["orphan", (b) => Object.assign(b.target.page, { inboundInternalCount: 0, orphan: "no_inbound_from_crawled_pages" }), "ranges"],
  ["impressions", (b) => (b.visibility.impressions = 381), "id"],
  ["zero impressions", (b) => Object.assign(b.visibility, { status: "zero", impressions: 0, clicks: 0 }), "ranges"],
  ["visibility unknown", (b) => (b.visibility = { status: "unknown" }), "confidence"],
  ["position 11-20", (b) => (b.visibility.position = 14), "ranges"],
  ["position > 20", (b) => (b.visibility.position = 31), "ranges"],
  ["site activity low", (b) => (b.site.searchConsole = { status: "available", impressions28d: 50, band: "low" }), "ranges"],
  ["site activity unknown", (b) => (b.site.searchConsole = { status: "unknown" }), "confidence"],
  ["volatility high", (b) => (b.site.volatility = { status: "computed", cv: 0.6, band: "high" }), "ranges"],
  ["intent unclassified", (b) => (b.intent.intentType = "unclassified"), "confidence"],
  ["market demand", (b) => (b.marketDemand = { status: "available", monthlyVolume: 1300 }), "id"],
  ["baseline missing", (b) => (b.baseline = { status: "missing" }), "confidence"],
  ["baseline contaminated", (b) => (b.baseline = { status: "contaminated" }), "confidence"],
  ["retroactive", (b) => (b.retroactive = true), "confidence"],
  ["intelligence run", (b) => (b.sources.intelligenceRunId = "run2"), "id"],
  ["unit key", (b) => (b.unitKey = "other"), "id"]
];
for (const [name, mutate, expect] of MUTATIONS) {
  test(`mutation recomputes: ${name}`, () => {
    const a = P.predict(base());
    const b = P.predict(with_(mutate));
    assert.notStrictEqual(a.predictionId, b.predictionId, "identity must change");
    if (expect === "ranges") assert.notDeepStrictEqual(a.stages, b.stages, "ranges must change");
    if (expect === "confidence") assert.notStrictEqual(a.confidence, b.confidence, "confidence must change");
  });
}

test("volatility / activity are bands: a different number in the same band keeps the id", () => {
  const a = P.predict(base());
  const b = P.predict(with_((x) => (x.site.searchConsole.impressions28d = 7000)));
  assert.strictEqual(a.predictionId, b.predictionId);
});

test("unknown factors are listed, never 0", () => {
  const p = P.predict(base());
  const keys = p.unknownFactors.map((u) => u.key);
  for (const k of ["authority_backlinks", "page_age", "page_history", "serp_volatility", "seasonality", "algorithm_updates", "competitor_movement", "historical_responsiveness", "topical_authority", "market_demand"]) assert.ok(keys.includes(k), k);
  for (const u of p.unknownFactors) assert.strictEqual(u.value, null);
  const vu = P.predict(with_((b) => (b.visibility = { status: "unknown" })));
  const f = vu.predictionFactors.find((x) => x.key === "target_visibility");
  assert.strictEqual(f.value, null);
  assert.strictEqual(f.basis, "unknown");
  // an unknown is not treated as zero: zero visibility changes ranges, unknown does not
  assert.deepStrictEqual(days(vu, "B"), [28, 90], "unknown visibility applies no modifier (the plain prior)");
  assert.notDeepStrictEqual(days(vu, "B"), days(P.predict(with_((b) => Object.assign(b.visibility, { status: "zero", impressions: 0 }))), "B"));
});

test("unknown market demand does not lower confidence (visibility is not demand)", () => {
  const a = P.predict(base());
  const b = P.predict(with_((x) => (x.marketDemand = { status: "available", monthlyVolume: 1000 })));
  assert.strictEqual(a.confidence, b.confidence);
});

test("confidence capped at medium; never high; floor low", () => {
  const p = P.predict(with_((b) => (b.decision.confidence = "high")));
  assert.strictEqual(p.confidence, "medium");
  const worst = P.predict(with_((b) => Object.assign(b, { retroactive: true, baseline: { status: "missing" }, visibility: { status: "unknown" }, site: { searchConsole: { status: "unknown" }, volatility: { band: "high" } } })));
  assert.strictEqual(worst.confidence, "low");
  assert.ok(worst.confidenceReasons.length >= 5);
});

test("stages A/B/C stay separate; min<max, A<=B<=C, whole days, cap 365", () => {
  for (const cls of Object.keys(cfg.ACTION_DETAIL_CLASS)) {
    const p = P.predict(with_((b) => (b.decision.actionDetails = [cls])));
    const st = ["A", "B", "C"].map((s) => p.stages[s]).filter((x) => x.status === "range");
    for (const s of st) {
      assert.ok(Number.isInteger(s.minDays) && Number.isInteger(s.maxDays));
      assert.ok(s.minDays >= 1 && s.maxDays > s.minDays && s.maxDays <= 365);
    }
    for (let i = 1; i < st.length; i++) assert.ok(st[i].maxDays >= st[i - 1].maxDays, `${cls} stage order`);
    assert.ok(p.stages.A && p.stages.B && p.stages.C, "three stage records always present");
  }
  const huge = P.predict(with_((b) => Object.assign(b, { visibility: { status: "zero", impressions: 0, clicks: 0 }, site: { searchConsole: { status: "available", band: "low" }, volatility: { band: "high" } }, decision: { ...b.decision, actionDetails: ["rework_intent"] } })));
  assert.ok(huge.stages.C.maxDays <= 365);
});

test("entity_facts: stage B not applicable, C unknown", () => {
  const p = P.predict(with_((b) => Object.assign(b, { decision: { ...b.decision, scope: "site", actionDetails: ["clarify_business_facts"], intentId: null }, target: null })));
  assert.strictEqual(p.stages.B.status, "not_applicable");
  assert.strictEqual(p.stages.C.status, "unknown");
  assert.strictEqual(p.targetType, "site");
  assert.deepStrictEqual(days(p, "A"), [14, 56]);
});

test("no exact date anywhere in a prediction", () => {
  const p = P.predict(base());
  const json = JSON.stringify(p);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(json), "no YYYY-MM-DD");
  assert.ok(!/(Date|At)Ms"?:\s*1[6-9]\d{11}/.test(json.replace(/"evidenceAsOfMs":\d+/, "")), "no epoch target dates");
  for (const k of Object.keys(p)) assert.ok(!/date$/i.test(k), `no *Date field: ${k}`);
});

test("blocked_by_eligibility: non-technical change on an ineligible page has no ranges", () => {
  const p = P.predict(with_((b) => (b.target.page.indexability = "non_indexable")));
  assert.strictEqual(p.predictionState, "blocked_by_eligibility");
  assert.strictEqual(p.stages.B.status, "blocked_by_eligibility");
  assert.strictEqual(p.predictedMeaningfulImpactMaxDays, null);
  const fix = P.predict(with_((b) => Object.assign(b, { decision: { ...b.decision, actionDetails: ["fix_eligibility"] } }, { target: { ...b.target, page: { ...b.target.page, indexability: "non_indexable" } } })));
  assert.strictEqual(fix.predictionState, "ranges");
  assert.strictEqual(fix.predictedVisibilityImpact.band, "large");
});

test("committed: change class comes from the recorded elements", () => {
  const p = P.predict(base({ kind: "committed", unitKey: "c1", change: { changeEventId: "c1", changedElements: ["title", "meta_description"] } }));
  assert.strictEqual(p.changeType, "snippet");
  assert.strictEqual(p.predictedVisibilityImpact.band, "none");
  const multi = P.predict(base({ kind: "committed", unitKey: "c1", change: { changeEventId: "c1", changedElements: ["title", "body_content", "internal_links_added"] } }));
  assert.strictEqual(multi.changeType, "content");
  assert.deepStrictEqual(multi.changeClasses, ["content", "internal_linking"]);
  assert.ok(multi.predictionFactors.some((f) => f.key === "change_magnitude" && f.effect !== "none"));
  const intent = P.predict(base({ kind: "committed", unitKey: "c1", change: { changeEventId: "c1", changedElements: ["body_content"], intentChange: true } }));
  assert.strictEqual(intent.changeType, "intent_correction");
});

test("class mapping §4.1 from elements", () => {
  const c = (els, o = {}) => P.classesFromElements(els, o);
  assert.deepStrictEqual(c(["noindex_removed"]), ["technical_eligibility"]);
  assert.deepStrictEqual(c(["canonical_tag"]), ["technical_eligibility"]);
  assert.deepStrictEqual(c(["canonical_tag"], { decision: "CONSOLIDATE" }), ["consolidation"]);
  assert.deepStrictEqual(c(["redirect", "content_merged"]), ["consolidation"]);
  assert.deepStrictEqual(c(["internal_links_added"]), ["internal_linking"]);
  assert.deepStrictEqual(c(["new_page_published"]), ["new_page"]);
  assert.deepStrictEqual(c(["business_facts"]), ["entity_facts"]);
  assert.deepStrictEqual(c(["structured_data"], { scope: "site" }), ["entity_facts"]);
  assert.deepStrictEqual(c(["other"], { fallbackDetails: ["add_internal_links"] }), ["internal_linking"]);
  assert.strictEqual(P.primaryClassOf(["snippet", "content", "new_page"]), "new_page");
});

test("new page: no-internal-link modifier and unknown magnitude", () => {
  const b = base({ kind: "committed", unitKey: "c1", decision: { ...base().decision, decision: "CREATE", actionDetails: ["new_page"] }, target: { pageKey: "hagarlushi.com/new", page: null, pageBasis: "none" }, change: { changeEventId: "c1", changedElements: ["new_page_published"] } });
  const p = P.predict(b);
  assert.strictEqual(p.changeType, "new_page");
  assert.strictEqual(p.targetType, "new_page");
  assert.deepStrictEqual(days(p, "A"), [3, 55]); // 42 x 1.3 = 54.6 -> 55
  const linked = P.predict({ ...b, change: { changeEventId: "c1", changedElements: ["new_page_published", "internal_links_added"] } });
  assert.ok(linked.stages.A.maxDays < p.stages.A.maxDays);
  assert.strictEqual(p.predictedRankingImpact.band, "unknown");
});

test("business impact measurable only with stored site traffic data", () => {
  assert.strictEqual(P.predict(base()).businessImpact.measurable, false);
  const p = P.predict(with_((b) => (b.site.traffic = { status: "available", organicSessions: 120, conversions: 4 })));
  assert.strictEqual(p.businessImpact.measurable, true);
  assert.strictEqual(p.businessImpact.scope, "site");
});

test("no numeric traffic / lead / revenue forecast; magnitudes ordinal", () => {
  const p = P.predict(base());
  for (const k of ["predictedVisibilityImpact", "predictedRankingImpact", "predictedTrafficImpact"]) {
    assert.ok(["none", "small", "moderate", "large", "unknown"].includes(p[k].band), k);
    assert.strictEqual(p[k].basis, "assumption");
    for (const v of Object.values(p[k])) assert.notStrictEqual(typeof v, "number");
  }
  assert.ok(!/revenue|leads?\b/i.test(JSON.stringify(p).replace(/conversion/gi, "")));
});

test("versions stored on every prediction", () => {
  const p = P.predict(base());
  assert.strictEqual(p.predictionModelVersion, cfg.PREDICTION_MODEL_VERSION);
  assert.strictEqual(p.predictionConfigVersion, cfg.PREDICTION_CONFIG_VERSION);
  assert.strictEqual(p.basis, "assumption");
});

test("experiment prediction: min of mins, max of maxes, weakest confidence, deterministic", () => {
  const a = P.predict(base({ kind: "committed", unitKey: "c1", change: { changeEventId: "c1", changedElements: ["title"] } }));
  const b = P.predict(base({ kind: "committed", unitKey: "c2", change: { changeEventId: "c2", changedElements: ["body_content"] }, retroactive: true }));
  const e1 = P.deriveExperimentPrediction([a, b], { businessId: BIZ, experimentId: "e1" });
  const e2 = P.deriveExperimentPrediction([b, a], { businessId: BIZ, experimentId: "e1" });
  assert.deepStrictEqual(e1, e2);
  assert.strictEqual(e1.stages.A.minDays, Math.min(a.stages.A.minDays, b.stages.A.minDays));
  assert.strictEqual(e1.stages.B.maxDays, Math.max(a.stages.B.maxDays, b.stages.B.maxDays));
  assert.strictEqual(e1.confidence, "low");
  assert.deepStrictEqual(e1.changeClasses, ["content", "snippet"]);
  assert.deepStrictEqual(e1.derivedFrom, [a.predictionId, b.predictionId].sort());
});

test("retroactive filter: only evidence strictly before the cutoff qualifies", () => {
  const cutoff = 10_000;
  const ev = P.preChangeEvidence(
    {
      intelligenceRuns: [{ id: "r1", status: "completed", completedAtMs: 5000 }, { id: "r2", status: "completed", completedAtMs: 12000 }, { id: "r3", status: "running", completedAtMs: 9000 }],
      searchSnapshots: [{ id: "s1", retrievedAt: { toMillis: () => 9000 }, data: { impressions: 1 } }, { id: "s2", retrievedAt: { toMillis: () => 11000 }, data: { impressions: 2 } }],
      trafficSnapshots: [{ id: "t1", retrievedAtMs: 10000 }],
      baselines: [{ id: "b1", capturedAtMs: 9999 }, { id: "b2", capturedAtMs: 10001 }]
    },
    cutoff
  );
  assert.strictEqual(ev.run.id, "r1");
  assert.strictEqual(ev.latestSearch.id, "s1");
  assert.deepStrictEqual(ev.searchSnapshots.map((s) => s.id), ["s1"]);
  assert.strictEqual(ev.latestTraffic, null, "a snapshot AT the cutoff is not pre-change");
  assert.strictEqual(ev.baseline.id, "b1");
});

test("volatility proxy needs >= 14 snapshots and is order independent", () => {
  const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, retrievedAt: { toMillis: () => i * 86400000 }, data: { impressions: f(i) } }));
  assert.strictEqual(P.volatilityOf(mk(10, () => 100)).status, "insufficient_history");
  const flat = P.volatilityOf(mk(20, () => 100));
  assert.strictEqual(flat.band, "normal");
  const spiky = mk(20, (i) => (i % 2 ? 20 : 200));
  assert.strictEqual(P.volatilityOf(spiky).band, "high");
  assert.deepStrictEqual(P.volatilityOf([...spiky].reverse()), P.volatilityOf(spiky));
});

test("provider-free: prediction modules import no adapter, Firestore or network", () => {
  for (const f of ["predictionRules.js", "predictionConfig.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.ok(!/require\(["'](firebase-admin|firebase-functions|googleapis|\.\/semrush|\.\/googleSearchConsole|\.\/visibility|\.\/apiUsage|https?|node-fetch|axios)["']\)/.test(src), f);
    assert.ok(!/Date\.now\(|new Date\(\)/.test(src), `${f} reads no clock`);
  }
});

const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(`\n${results.length - failed.length}/${results.length} prediction tests passed`);
if (failed.length) process.exit(1);
