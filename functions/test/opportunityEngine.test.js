// M5 Opportunity Engine tests - index-enforcing in-memory Firestore,
// fixture M4 data, no network. Run: node functions/test/opportunityEngine.test.js

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { createFakeFirestore, loadWithFake } = require("./helpers/fakeFirestore");
const { detect, dedupeKey, confidenceOf, band } = require("../opportunityRules");
const { DEFAULT_WEIGHTS, resolveWeights } = require("../opportunityConfig");

const STORE = path.join(__dirname, "..", "opportunityEngineStore.js");
const BIZ = "hagar";
const O = "https://www.hagarlushi.com";
const NOW = Date.UTC(2026, 9, 9, 9, 0, 0);
const PERIOD = { startDate: "2026-09-08", endDate: "2026-10-05" };

const page = (slug, extra = {}) => ({
  id: `${BIZ}_${slug || "home"}`,
  businessId: BIZ,
  url: `${O}/${slug}`,
  pageKey: `hagarlushi.com/${slug}`,
  title: slug || "home",
  crawlStatus: "fetched",
  lastCrawledAtMs: NOW - 1000,
  indexability: { state: "indexable", reasons: [] },
  robots: { state: "crawlable" },
  canonical: { state: "valid" },
  links: { inboundInternalCount: 3, scope: "counted among 6 crawled pages" },
  role: { role: slug ? "other" : "homepage" },
  diagnostics: [],
  ...extra
});

const gsc = (impressions, clicks, pos, pages) => ({ status: "available", period: PERIOD, impressions, clicks, ctr: impressions ? clicks / impressions : 0, avgPosition: pos, pages });
const ti = (topicId, title, g, { observed = [], matched = [], intent = "commercial", linked = true, semrush = null } = {}) => ({
  id: `${BIZ}_${topicId}`,
  topicId,
  businessId: BIZ,
  title,
  runId: "run1",
  computedAtMs: NOW - 500,
  superseded: false,
  gscCurrent: g,
  semrush: semrush ? { status: "available", totalMonthlyVolume: semrush } : { status: "not_available" },
  pages: { observed: observed.map(([slug, impressions, position]) => ({ url: `${O}/${slug}`, pageKey: `hagarlushi.com/${slug}`, impressions, clicks: 1, position })), contentMatched: matched.map((slug) => ({ url: `${O}/${slug}`, pageKey: `hagarlushi.com/${slug}`, rule: "text" })) },
  business: { linkedServices: linked ? [{ serviceId: "svcArch", name: "אדריכלות למגורים", confirmed: true, basis: "observed" }] : [], geography: [], preliminaryIntent: intent, commercialSignal: { present: intent === "commercial" } }
});

// Fixture: one topic per rule + a healthy topic (NO_ACTION) + a topic
// whose GSC data is missing with no page (WAIT_FOR_DATA).
function fixture() {
  return {
    business: { name: "Hagar Lushi Studio", website: "hagarlushi.com" },
    run: {
      id: "run1",
      businessId: BIZ,
      status: "completed",
      completedAtMs: NOW - 400,
      analysisVersion: 1,
      gsc: { period: PERIOD, status: "available" },
      businessContext: { searchConsole: { status: "available", impressions: 5000, clicks: 200, ctr: 0.04 } },
      geoReadiness: {
        signals: [
          { key: "fact_consistency", status: "partial", observation: "2 different phone numbers", evidencePages: [`${O}/`], basis: "observed" },
          { key: "services_explicit", status: "present", observation: "ok", evidencePages: [], basis: "observed" },
          { key: "structured_data_coverage", status: "partial", observation: "3/6", evidencePages: [], basis: "observed" }
        ]
      }
    },
    searchTopics: [
      ["tRank", "priority"],
      ["tCtr", "relevant"],
      ["tGap", "priority"],
      ["tHidden", "relevant"],
      ["tOverlap", "relevant"],
      ["tHealthy", "brand_strategic"],
      ["tWait", "relevant"],
      ["tNew", "new"],
      ["tExcluded", "exclude"]
    ].map(([id, status]) => ({ id, businessId: BIZ, title: id, status })),
    topicIntel: [
      ti("tRank", "אדריכלות למגורים", gsc(400, 20, 8.4, []), { observed: [["architecture", 380, 8.2]], semrush: 1300 }),
      ti("tCtr", "עיצוב פנים", gsc(300, 2, 2.5, []), { observed: [["interior", 300, 2.5]], intent: "informational", linked: false }),
      ti("tGap", "שיפוץ דירות", { status: "no_observation", period: PERIOD }),
      ti("tHidden", "תכנון בתים", { status: "no_observation", period: PERIOD }, { matched: ["orphan"] }),
      ti("tOverlap", "אדריכלית בקיסריה", gsc(200, 4, 22, []), { observed: [["", 120, 21], ["contact", 80, 24]] }),
      ti("tHealthy", "הגר לושי", gsc(900, 150, 1.4, []), { observed: [["", 900, 1.4]], intent: "navigational" }),
      ti("tWait", "דירות גן", { status: "not_available", reason: "Search Console is not connected" }),
      ti("tNew", "לא מאושר", gsc(999, 0, 5, []), { observed: [["architecture", 999, 5]] })
    ],
    seoPages: [
      page(""),
      page("architecture"),
      page("interior"),
      page("contact", { canonical: { state: "conflicting" } }),
      page("orphan", { links: { inboundInternalCount: 0, scope: "counted among 6 crawled pages" } })
    ],
    baseline: { id: `${BIZ}_v1`, version: 1, sourceRunId: "run1", capturedAtMs: NOW - 300 }
  };
}

async function setup(mutate = (f) => f) {
  const f = mutate(fixture());
  const fake = createFakeFirestore();
  const store = loadWithFake(fake, STORE);
  const db = fake.admin.firestore();
  await db.collection("businesses").doc(BIZ).set(f.business);
  if (f.run) await db.collection("intelligenceRuns").doc(f.run.id).set(f.run);
  for (const t of f.searchTopics) await db.collection("searchTopics").doc(t.id).set(t);
  for (const t of f.topicIntel) await db.collection("topicIntelligence").doc(t.id).set(t);
  for (const p of f.seoPages) await db.collection("seoPages").doc(p.id).set(p);
  if (f.baseline) await db.collection("baselines").doc(f.baseline.id).set({ businessId: BIZ, ...f.baseline, baselineId: f.baseline.id });
  await db.collection("opportunities").doc("manual1").set({ businessId: BIZ, title: "manual", status: "approved", source: "manual" });
  const run = (n = NOW) => store.runOpportunityEngine({ businessId: BIZ, nowMs: n });
  const engineOpps = () => fake.rows("opportunities").filter((o) => o.source === "opportunity_engine");
  return { fake, db, store, run, engineOpps, f };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
  }
}

const byType = (opps, type) => opps.filter((o) => o.type === type);

(async () => {
  await test("a topic can carry two complementary findings (position band + low CTR)", async () => {
    const t = await setup((f) => {
      f.topicIntel = f.topicIntel.map((x) => (x.topicId === "tRank" ? { ...x, gscCurrent: gsc(400, 2, 6, []) } : x));
      return f;
    });
    await t.run();
    const onRank = t.engineOpps().filter((o) => o.targetTopicIds.includes("tRank")).map((o) => o.type).sort();
    assert.deepStrictEqual(onRank, ["ctr_upside", "ranking_upside"]);
  });

  await test("creation: every rule fires on its fixture, only for approved topics", async () => {
    const t = await setup();
    const r = await t.run();
    assert.strictEqual(r.decision, "computed");
    const opps = t.engineOpps();
    const types = opps.map((o) => o.type).sort();
    assert.deepStrictEqual(types, ["coverage_gap", "ctr_upside", "entity_clarity", "internal_linking", "page_not_visible", "page_overlap_observed", "ranking_upside", "technical_blocker"]);
    assert.ok(!opps.some((o) => o.targetTopicIds.includes("tNew")), "unapproved topic never targeted");
    assert.ok(!opps.some((o) => o.targetTopicIds.includes("tExcluded")));
    assert.strictEqual(byType(opps, "ranking_upside")[0].targetTopicIds[0], "tRank");
    assert.strictEqual(byType(opps, "coverage_gap")[0].targetTopicIds[0], "tGap");
    assert.strictEqual(byType(opps, "page_not_visible")[0].targetTopicIds[0], "tHidden");
    assert.ok(byType(opps, "technical_blocker")[0].targetPageKeys.includes("hagarlushi.com/contact"));
    assert.ok(byType(opps, "internal_linking")[0].targetPageKeys.includes("hagarlushi.com/orphan"));
    assert.strictEqual(byType(opps, "entity_clarity").length, 1, "only the fact-consistency signal (structured data coverage is not an opportunity)");
    assert.ok(opps.every((o) => o.status === "new" && o.engineState === "active" && Array.isArray(o.candidateActions) && o.candidateActions.length));
    assert.strictEqual(t.fake.rows("opportunities").find((o) => o.id === "manual1").status, "approved", "manual opportunity untouched");
  });

  await test("NO_ACTION and WAIT_FOR_DATA are recorded on the run, not as opportunities", async () => {
    const t = await setup();
    const r = await t.run();
    const run = t.fake.rows("opportunityRuns").find((x) => x.id === r.runId);
    const ev = Object.fromEntries(run.topicEvaluations.map((e) => [e.topicId, e]));
    assert.strictEqual(ev.tHealthy.outcome, "NO_ACTION");
    assert.ok(ev.tHealthy.reasons.length > 0, "NO_ACTION is explained");
    assert.strictEqual(ev.tWait.outcome, "WAIT_FOR_DATA");
    assert.ok(!t.engineOpps().some((o) => o.targetTopicIds.includes("tHealthy") || o.targetTopicIds.includes("tWait")));
    assert.strictEqual(run.summary.noAction, 1);
    assert.strictEqual(run.summary.waitForData, 1);
  });

  await test("evidence linkage: every opportunity has evidence pointing at real source documents", async () => {
    const t = await setup();
    await t.run();
    const docsOf = (c) => new Set(t.fake.rows(c).map((d) => d.id));
    const known = { searchTopics: docsOf("searchTopics"), topicIntelligence: docsOf("topicIntelligence"), seoPages: docsOf("seoPages"), intelligenceRuns: docsOf("intelligenceRuns"), baselines: docsOf("baselines") };
    for (const o of t.engineOpps()) {
      assert.ok(o.evidence.length >= 1, `${o.type} has evidence`);
      for (const e of o.evidence) {
        assert.ok(e.id && e.sourceType && e.basis, "evidence fields");
        assert.ok(known[e.sourceRef.collection] && known[e.sourceRef.collection].has(e.sourceRef.docId), `${o.type}: ${e.sourceRef.collection}/${e.sourceRef.docId} exists`);
      }
      assert.strictEqual(o.baselineId, `${BIZ}_v1`);
      assert.strictEqual(o.baselineMatchesRun, true);
      assert.strictEqual(o.sourceRunId, "run1");
      assert.ok(o.impactInputs && o.impactInputs.baselineId === `${BIZ}_v1`, "impact inputs reference the baseline");
    }
  });

  await test("scoring is explainable: factors carry level, weight, basis and explanation; unknowns are null not 0", async () => {
    const t = await setup();
    await t.run();
    for (const o of t.engineOpps()) {
      for (const f of o.factors) {
        assert.ok("level" in f && "weight" in f && f.basis && f.explanation, `${o.type}.${f.key}`);
        if (f.level == null) assert.strictEqual(f.contribution, null);
      }
      assert.ok(o.score >= 0 && o.score <= 100);
    }
    const ent = byType(t.engineOpps(), "entity_clarity")[0];
    assert.strictEqual(ent.factors.find((f) => f.key === "marketDemand").level, null);
    assert.ok(!ent.missing.includes("factor_unknown:marketDemand"), "not-applicable is not reported as missing");
    assert.ok(t.engineOpps().every((o) => !o.factors.some((f) => f.key === "demand")), "no merged 'demand' factor any more");
  });

  await test("prioritization: bands are ordered and the guards hold", async () => {
    const t = await setup();
    await t.run();
    const opps = t.engineOpps();
    assert.strictEqual(byType(opps, "page_overlap_observed")[0].priority, "low", "overlap is monitor-only");
    assert.notStrictEqual(byType(opps, "technical_blocker")[0].priority, "low", "blocker at least medium");
    const rank = byType(opps, "ranking_upside")[0];
    const hidden = byType(opps, "page_not_visible")[0];
    assert.ok(rank.score > hidden.score, "observed high-demand upside outranks an inferred, unseen page");
    assert.strictEqual(band("ranking_upside", 75), "high");
    assert.strictEqual(band("ranking_upside", 74), "medium");
    assert.strictEqual(band("ranking_upside", 49), "low");
    assert.strictEqual(band("technical_blocker", 10), "medium");
    assert.strictEqual(band("ranking_upside", 95, "low"), "medium", "low confidence is never high priority");
    assert.strictEqual(band("entity_clarity", 95), "medium", "site-level clarity is at most medium");
    const highs = opps.filter((o) => o.priority === "high").map((o) => o.type).sort();
    assert.deepStrictEqual(highs, ["ranking_upside", "technical_blocker"], "high is reserved for strong, observed findings");
  });

  await test("confidence: reasons reduce it; observed + crawled + baseline = high", async () => {
    const t = await setup();
    await t.run();
    const opps = t.engineOpps();
    assert.strictEqual(byType(opps, "ranking_upside")[0].confidence, "high", "tRank has stored Semrush demand -> nothing unknown");
    const ctr = byType(opps, "ctr_upside")[0];
    assert.strictEqual(ctr.confidence, "medium", "no Semrush for tCtr -> market demand unknown lowers confidence");
    assert.ok(ctr.confidenceReasons.some((r) => r.includes("ביקוש בשוק")));
    const hidden = byType(opps, "page_not_visible")[0];
    assert.notStrictEqual(hidden.confidence, "high");
    assert.ok(hidden.confidenceReasons.some((r) => r.includes("הסקה")));
    assert.strictEqual(confidenceOf({ gscAvailable: false, unknownFactors: ["demand"], inferredTarget: true, uncrawledTarget: true, hasBaseline: false }).confidence, "low");
    assert.strictEqual(byType(opps, "entity_clarity")[0].confidence === "high", true, "fact conflict is observed, not assumed");
  });

  await test("dedupe: re-running on new data updates the same documents, never duplicates", async () => {
    const t = await setup();
    await t.run();
    const first = t.engineOpps().map((o) => o.id).sort();
    // new data: a new crawl timestamp changes the semantic input
    await t.db.collection("seoPages").doc(`${BIZ}_architecture`).update({ lastCrawledAtMs: NOW + 5000 });
    const r2 = await t.run(NOW + 6000);
    assert.strictEqual(r2.decision, "computed");
    const second = t.engineOpps();
    assert.deepStrictEqual(second.map((o) => o.id).sort(), first);
    assert.ok(second.every((o) => o.detectionCount === 2));
    assert.ok(second.every((o) => o.firstDetectedAtMs === NOW && o.lastDetectedAtMs === NOW + 6000));
    assert.strictEqual(dedupeKey(BIZ, "ranking_upside", { topicIds: ["a"], pageKeys: ["x"] }), dedupeKey(BIZ, "ranking_upside", { topicIds: ["a"], pageKeys: ["y"] }), "topic-level key ignores the page");
    assert.notStrictEqual(dedupeKey(BIZ, "internal_linking", { topicIds: ["a"], pageKeys: ["x"] }), dedupeKey(BIZ, "internal_linking", { topicIds: ["b"], pageKeys: ["y"] }));
  });

  await test("page-level opportunities are deduped across topics", async () => {
    const t = await setup((f) => {
      f.searchTopics.push({ id: "tHidden2", businessId: BIZ, title: "x", status: "relevant" });
      f.topicIntel.push(ti("tHidden2", "בית פרטי", { status: "no_observation", period: PERIOD }, { matched: ["orphan"] }));
      return f;
    });
    await t.run();
    const links = byType(t.engineOpps(), "internal_linking");
    assert.strictEqual(links.length, 1);
    assert.deepStrictEqual([...links[0].targetTopicIds].sort(), ["tHidden", "tHidden2"]);
  });

  await test("identical analysis is a cache hit: no writes, no provider", async () => {
    const t = await setup();
    await t.run();
    const before = JSON.stringify(t.fake.rows("opportunities"));
    const runsBefore = t.fake.rows("opportunityRuns").length;
    const r2 = await t.run(NOW + 60000);
    assert.strictEqual(r2.cacheHit, true);
    assert.strictEqual(r2.decision, "cache_hit");
    assert.strictEqual(r2.providerCalled, false);
    assert.strictEqual(r2.written, 0);
    assert.strictEqual(JSON.stringify(t.fake.rows("opportunities")), before);
    assert.strictEqual(t.fake.rows("opportunityRuns").length, runsBefore);
    assert.strictEqual(t.fake.rows("apiUsage").length, 0, "no governed provider call at all");
  });

  await test("changed input (owner approves another topic) recomputes", async () => {
    const t = await setup();
    await t.run();
    await t.db.collection("searchTopics").doc("tNew").update({ status: "relevant" });
    const r = await t.run(NOW + 1000);
    assert.strictEqual(r.decision, "computed");
    assert.ok(t.engineOpps().some((o) => o.targetTopicIds.includes("tNew")));
  });

  await test("weights: business override changes the cache identity; unknown/invalid keys ignored", async () => {
    const { weights, applied } = resolveWeights({ marketDemand: 5, demand: 4, bogus: 9, upside: -1, effortInverse: "3" });
    assert.strictEqual(weights.marketDemand, 5);
    assert.ok(!("demand" in weights), "the old merged key is not a weight any more");
    assert.strictEqual(weights.upside, DEFAULT_WEIGHTS.upside);
    assert.deepStrictEqual(applied, { marketDemand: 5 });
    const t = await setup();
    await t.run();
    await t.db.collection("businesses").doc(BIZ).update({ opportunityWeights: { marketDemand: 5 } });
    const r = await t.run(NOW + 1000);
    assert.strictEqual(r.decision, "computed");
    const run = t.fake.rows("opportunityRuns").find((x) => x.id === r.runId);
    assert.deepStrictEqual(run.weightsOverride, { marketDemand: 5 });
  });

  await test("owner status is never overwritten; rejection is durable", async () => {
    const t = await setup();
    await t.run();
    const rank = byType(t.engineOpps(), "ranking_upside")[0];
    const gap = byType(t.engineOpps(), "coverage_gap")[0];
    await t.db.collection("opportunities").doc(rank.id).update({ status: "approved" });
    await t.db.collection("opportunities").doc(gap.id).update({ status: "rejected" });
    await t.db.collection("seoPages").doc(`${BIZ}_architecture`).update({ lastCrawledAtMs: NOW + 5000 });
    await t.run(NOW + 6000);
    const opps = t.engineOpps();
    assert.strictEqual(opps.find((o) => o.id === rank.id).status, "approved");
    assert.strictEqual(opps.find((o) => o.id === gap.id).status, "rejected");
    assert.strictEqual(opps.find((o) => o.id === gap.id).engineState, "active", "still detected, still rejected");
    assert.strictEqual(opps.filter((o) => o.type === "coverage_gap").length, 1, "no duplicate re-proposal");
  });

  await test("issue #36: phone evidence that is insufficient (unknown) or consistent (present) creates no business-facts opportunity", async () => {
    for (const status of ["unknown", "present"]) {
      const t = await setup((f) => {
        f.run.geoReadiness.signals = f.run.geoReadiness.signals.map((s) => (s.key === "fact_consistency" ? { ...s, status, insufficientEvidence: status === "unknown" } : s));
        return f;
      });
      await t.run();
      assert.strictEqual(byType(t.engineOpps(), "entity_clarity").length, 0, status);
    }
  });

  await test("M6 compatibility: an M5 re-run never resets opportunities.decisionId", async () => {
    const t = await setup();
    await t.run();
    const rank = byType(t.engineOpps(), "ranking_upside")[0];
    assert.strictEqual(rank.decisionId, null, "initialised to null on creation");
    await t.db.collection("opportunities").doc(rank.id).update({ decisionId: `${BIZ}_intent_${BIZ}_tRank` });
    await t.db.collection("seoPages").doc(`${BIZ}_architecture`).update({ lastCrawledAtMs: NOW + 5000 });
    const r = await t.run(NOW + 6000);
    assert.strictEqual(r.decision, "computed");
    assert.strictEqual(t.engineOpps().find((o) => o.id === rank.id).decisionId, `${BIZ}_intent_${BIZ}_tRank`);
  });

  await test("no longer detected -> resolved (kept), re-detected -> active again", async () => {
    const t = await setup();
    await t.run();
    const blocker = byType(t.engineOpps(), "technical_blocker")[0];
    await t.db.collection("seoPages").doc(`${BIZ}_contact`).update({ canonical: { state: "valid" }, lastCrawledAtMs: NOW + 1 });
    const r = await t.run(NOW + 1000);
    assert.strictEqual(r.summary.resolved, 1);
    const after = t.engineOpps().find((o) => o.id === blocker.id);
    assert.strictEqual(after.engineState, "resolved");
    assert.strictEqual(after.status, "new", "owner status untouched");
    await t.db.collection("seoPages").doc(`${BIZ}_contact`).update({ canonical: { state: "conflicting" }, lastCrawledAtMs: NOW + 2 });
    await t.run(NOW + 2000);
    const again = t.engineOpps().find((o) => o.id === blocker.id);
    assert.strictEqual(again.engineState, "active");
    assert.strictEqual(again.resolvedAtMs, null);
  });

  await test("edge: no intelligence run -> WAIT_FOR_DATA for every approved topic, zero opportunities", async () => {
    const t = await setup((f) => ({ ...f, run: null }));
    const r = await t.run();
    assert.strictEqual(r.summary.opportunities, 0);
    const run = t.fake.rows("opportunityRuns").find((x) => x.id === r.runId);
    assert.strictEqual(run.outcome, "WAIT_FOR_DATA");
    assert.ok(run.topicEvaluations.every((e) => e.outcome === "WAIT_FOR_DATA"));
    assert.strictEqual(t.engineOpps().length, 0);
  });

  await test("edge: no approved topics -> only site-level findings, no padding", async () => {
    const t = await setup((f) => ({ ...f, searchTopics: f.searchTopics.map((s) => ({ ...s, status: "new" })) }));
    await t.run();
    assert.deepStrictEqual(t.engineOpps().map((o) => o.type), ["entity_clarity"]);
  });

  await test("edge: GSC unavailable for all -> no visibility opportunities are invented", async () => {
    const t = await setup((f) => {
      f.topicIntel = f.topicIntel.map((x) => ({ ...x, gscCurrent: { status: "not_available", reason: "blocked_by_quota" }, pages: { observed: [], contentMatched: x.pages.contentMatched } }));
      return f;
    });
    await t.run();
    const types = new Set(t.engineOpps().map((o) => o.type));
    for (const ty of ["ranking_upside", "ctr_upside", "coverage_gap", "page_not_visible", "page_overlap_observed"]) assert.ok(!types.has(ty), `${ty} not invented`);
    const link = byType(t.engineOpps(), "internal_linking")[0];
    assert.ok(link.confidenceReasons.some((r) => r.includes("Search Console")));
  });

  await test("edge: target page not crawled in the latest run -> no page-level finding from stale data", async () => {
    const t = await setup((f) => {
      f.seoPages = f.seoPages.map((p) => (p.pageKey.endsWith("/contact") ? { ...p, crawlStatus: "failed_last_run" } : p));
      return f;
    });
    await t.run();
    assert.strictEqual(byType(t.engineOpps(), "technical_blocker").length, 0);
  });

  await test("edge: impressions below the business's floor do not trigger visibility rules", async () => {
    const t = await setup((f) => {
      f.topicIntel = f.topicIntel.map((x) => (x.topicId === "tRank" ? { ...x, gscCurrent: gsc(3, 0, 8, []) } : x));
      return f;
    });
    const r = await t.run();
    assert.strictEqual(byType(t.engineOpps(), "ranking_upside").length, 0);
    const run = t.fake.rows("opportunityRuns").find((x) => x.id === r.runId);
    assert.strictEqual(run.topicEvaluations.find((e) => e.topicId === "tRank").outcome, "NO_ACTION");
  });

  await test("edge: no baseline -> opportunities still detected, confidence reduced, missing says so", async () => {
    const t = await setup((f) => ({ ...f, baseline: null }));
    await t.run();
    const rank = byType(t.engineOpps(), "ranking_upside")[0];
    assert.strictEqual(rank.baselineId, null);
    assert.ok(rank.missing.includes("no_baseline"));
    assert.notStrictEqual(rank.confidence, "high");
  });

  await test("boundary: no tasks, decisions, predictions, intents; M3/M4 data untouched", async () => {
    const t = await setup();
    const snap = (c) => JSON.stringify(t.fake.rows(c));
    const before = { searchTopics: snap("searchTopics"), topicIntelligence: snap("topicIntelligence"), seoPages: snap("seoPages"), baselines: snap("baselines"), intelligenceRuns: snap("intelligenceRuns") };
    await t.run();
    for (const c of Object.keys(before)) assert.strictEqual(snap(c), before[c], `${c} unchanged`);
    for (const c of ["tasks", "decisions", "impactPredictions", "searchIntents", "seoChangeEvents", "evidence"]) assert.strictEqual(t.fake.rows(c).length, 0, c);
    assert.ok(t.engineOpps().every((o) => o.decisionId === null));
  });

  await test("boundary: engine modules import no provider adapter and no network", async () => {
    for (const f of ["opportunityRules.js", "opportunityEngineStore.js", "opportunityConfig.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      assert.ok(!/require\("\.\/(semrush|googleSearchConsole|webUtils|businessUnderstanding)"\)|googleapis|fetch\(|runGoverned/.test(src), f);
    }
  });

  // --- market demand vs observed visibility -------------------------------
  const factorOf = (o, k) => o.factors.find((f) => f.key === k);

  await test("MD1 Semrush unavailable + GSC impressions -> market demand stays unknown", async () => {
    const t = await setup();
    await t.run();
    const ctr = byType(t.engineOpps(), "ctr_upside")[0]; // tCtr: 300 impressions, no Semrush
    assert.strictEqual(factorOf(ctr, "marketDemand").level, null);
    assert.strictEqual(factorOf(ctr, "marketDemand").basis, "unknown");
    assert.strictEqual(factorOf(ctr, "marketDemand").contribution, null);
    assert.strictEqual(ctr.signals.marketDemand.source, null);
    assert.ok(ctr.missing.includes("factor_unknown:marketDemand"));
  });

  await test("MD2 GSC impressions still count, as observed visibility from Search Console", async () => {
    const t = await setup();
    await t.run();
    const ctr = byType(t.engineOpps(), "ctr_upside")[0];
    const v = factorOf(ctr, "observedVisibility");
    assert.ok(v.level >= 1 && v.basis === "observed");
    assert.ok(v.explanation.includes("Search Console"));
    assert.strictEqual(ctr.signals.visibility.source, "search_console");
    assert.strictEqual(ctr.signals.visibility.impressions, 300);
    const rank = byType(t.engineOpps(), "ranking_upside")[0];
    assert.strictEqual(factorOf(rank, "marketDemand").basis, "observed", "Semrush stored -> market demand known");
    assert.strictEqual(rank.signals.marketDemand.source, "semrush");
  });

  await test("MD3 zero GSC impressions never becomes zero market demand", async () => {
    const t = await setup();
    await t.run();
    for (const type of ["coverage_gap", "page_not_visible"]) {
      const o = byType(t.engineOpps(), type)[0];
      assert.strictEqual(factorOf(o, "marketDemand").level, null, `${type}: market demand unknown, not 0`);
      const v = factorOf(o, "observedVisibility");
      assert.strictEqual(v.notApplicable, true, `${type}: missing visibility is the reason, not a low score`);
      assert.strictEqual(v.contribution, null);
      assert.strictEqual(o.signals.visibility.impressions, 0, `${type}: zero impressions kept as an observed visibility fact`);
      assert.strictEqual(o.signals.visibility.source, "search_console");
    }
  });

  await test("MD4 coverage-gap confidence and priority reflect missing market demand", async () => {
    const t = await setup((f) => {
      f.baseline = { ...f.baseline }; // keep baseline so only market demand is missing
      return f;
    });
    await t.run();
    const gap = byType(t.engineOpps(), "coverage_gap")[0];
    assert.strictEqual(gap.confidence, "medium");
    assert.ok(gap.confidenceReasons.some((r) => r.includes("ביקוש בשוק")));
    assert.notStrictEqual(gap.priority, "high", "unknown demand never inflates a demand-dependent gap to high");
    // with market demand evidence the same gap regains full confidence
    const t2 = await setup((f) => {
      f.topicIntel = f.topicIntel.map((x) => (x.topicId === "tGap" ? { ...x, semrush: { status: "available", totalMonthlyVolume: 900 } } : x));
      return f;
    });
    await t2.run();
    const gap2 = byType(t2.engineOpps(), "coverage_gap")[0];
    assert.strictEqual(gap2.confidence, "high");
    assert.strictEqual(factorOf(gap2, "marketDemand").basis, "observed");
  });

  await test("MD5 page_not_visible / coverage_gap wording refers to Search Console and the period, never to absence from Google", async () => {
    const t = await setup();
    await t.run();
    const forbidden = /לא מופיע בגוגל:|הוא לא מופיע בגוגל|אינו מופיע בגוגל|לא מופיע עבורו בגוגל|Google לא מציג|לא באינדקס/;
    for (const type of ["page_not_visible", "coverage_gap"]) {
      const o = byType(t.engineOpps(), type)[0];
      assert.ok(!forbidden.test(o.title) && !forbidden.test(o.description), `${type} wording`);
      assert.ok(o.title.includes("Search Console") || o.description.includes("Search Console"), `${type} names the source`);
      assert.ok(o.description.includes("בתקופה"), `${type} names the observation window`);
      for (const e of o.evidence) assert.ok(!forbidden.test(e.observation || ""), `${type} evidence`);
    }
    const hidden = byType(t.engineOpps(), "page_not_visible")[0];
    assert.ok(hidden.description.includes("זה לא אומר שהדף לא מופיע בגוגל"), "explicit disclaimer");
  });

  await test("MD6 priorities unchanged by the split (only demand-dependent gaps are capped)", async () => {
    const t = await setup();
    await t.run();
    const p = Object.fromEntries(t.engineOpps().map((o) => [o.type, o.priority]));
    assert.deepStrictEqual(p, {
      ranking_upside: "high",
      technical_blocker: "high",
      ctr_upside: "medium",
      coverage_gap: "medium",
      page_not_visible: "medium",
      internal_linking: "medium",
      entity_clarity: "medium",
      page_overlap_observed: "low"
    });
  });

  await test("fail closed: a Firestore read failure stops the run before any write", async () => {
    const t = await setup();
    t.fake.failNextQueries(1);
    await assert.rejects(() => t.run(), /UNAVAILABLE/);
    assert.strictEqual(t.engineOpps().length, 0);
    assert.strictEqual(t.fake.rows("opportunityRuns").length, 0);
  });

  await test("determinism: same input -> identical detection output", async () => {
    const f = fixture();
    const input = { business: { id: BIZ, ...f.business }, run: f.run, topicIntel: f.topicIntel, searchTopics: f.searchTopics, seoPages: f.seoPages, baseline: f.baseline };
    const a = detect(input, DEFAULT_WEIGHTS);
    const b = detect(JSON.parse(JSON.stringify(input)), DEFAULT_WEIGHTS);
    assert.deepStrictEqual(a, b);
  });

  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL"));
  if (failed.length) {
    console.error(`\n${failed.length} opportunity-engine test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll opportunity-engine tests passed.");
})();
