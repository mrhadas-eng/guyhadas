// M6 Decision Engine tests - index-enforcing in-memory Firestore, fixture
// M3/M4/M5 data, no network. Run: node functions/test/decisionEngine.test.js
//
// Covers docs/M6_DECISION_ENGINE_DESIGN.md §Q (intent, ownership,
// cannibalization, decision table, guardrails G1-G11, explainability,
// demand vs visibility, CONSOLIDATE wording, missing data, lifecycle,
// boundary, determinism) plus the M5 decisionId compatibility fix.

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { createFakeFirestore, loadWithFake } = require("./helpers/fakeFirestore");
const { decide } = require("../decisionRules");
const cfg = require("../decisionConfig");

const STORE = path.join(__dirname, "..", "decisionEngineStore.js");
const M5_STORE = path.join(__dirname, "..", "opportunityEngineStore.js");
const BIZ = "hagar";
const O = "https://www.hagarlushi.com";
const HOST = "hagarlushi.com";
const NOW = Date.UTC(2026, 9, 11, 9, 0, 0);
const PERIOD = { startDate: "2026-09-10", endDate: "2026-10-07" };
const APPROVED = ["relevant", "priority", "brand_strategic"];

// --- fixture builders --------------------------------------------------------

const keyOf = (slug) => `${HOST}/${slug}`;
const urlOf = (slug) => `${O}/${slug}`;

function page(slug, role, title, extra = {}) {
  return {
    id: `${BIZ}_${slug || "home"}`,
    businessId: BIZ,
    url: urlOf(slug),
    pageKey: keyOf(slug),
    title,
    h1: extra.h1 || [],
    h2: extra.h2 || [],
    crawlStatus: "fetched",
    lastCrawledAtMs: NOW - 1000,
    indexability: { state: "indexable", reasons: [] },
    robots: { state: "crawlable" },
    canonical: { state: "valid", target: urlOf(slug) },
    links: { inboundInternalCount: 3, scope: "counted among 6 crawled pages" },
    role: { role, basis: "inferred" },
    diagnostics: [],
    ...extra
  };
}

function service(id, name, extra = {}) {
  return { id, businessId: BIZ, name, aliases: extra.aliases || [], ownerStatus: "confirmed", facets: { services: [], geographies: extra.geographies || [], audiences: extra.audiences || [] } };
}

function topic(id, title, { status = "relevant", queries, prelim = null, reasons = [], svc = null } = {}) {
  return {
    id,
    businessId: BIZ,
    title,
    status,
    queries: queries || [title],
    preliminaryIntent: prelim,
    qualificationReasons: reasons,
    seedRefs: svc ? [{ serviceId: svc, serviceName: svc, components: [] }] : []
  };
}

// gsc: null -> not_available; "none" -> no_observation; [[slug, impr, clicks, pos, queries[]]]
function intel(topicId, title, { gsc = "none", matched = [], semrush = null, prelim = null, svc = null } = {}) {
  let gscCurrent;
  let observed = [];
  if (gsc === null) gscCurrent = { status: "not_available", reason: "Search Console is not connected" };
  else if (gsc === "none") gscCurrent = { status: "no_observation", period: PERIOD };
  else {
    const pages = gsc.map(([slug, impressions, clicks, position, queries]) => ({ url: urlOf(slug), pageKey: keyOf(slug), impressions, clicks, position, queries: queries || [title], crawled: true, basis: "observed" }));
    const impressions = pages.reduce((a, p) => a + p.impressions, 0);
    const clicks = pages.reduce((a, p) => a + p.clicks, 0);
    const qset = [...new Set(pages.flatMap((p) => p.queries))];
    gscCurrent = { status: "available", period: PERIOD, impressions, clicks, ctr: impressions ? clicks / impressions : 0, avgPosition: pages[0].position, queries: qset.map((q) => ({ query: q })), pages };
    observed = pages.map(({ url, pageKey, impressions: i, clicks: c, position }) => ({ url, pageKey, impressions: i, clicks: c, position, basis: "observed" }));
  }
  return {
    id: `${BIZ}_${topicId}`,
    topicId,
    businessId: BIZ,
    title,
    runId: "run1",
    computedAtMs: NOW - 500,
    superseded: false,
    queries: [title],
    gscCurrent,
    semrush: semrush ? { status: "available", totalMonthlyVolume: semrush } : { status: "not_available" },
    pages: { observed, contentMatched: matched.map((slug) => ({ url: urlOf(slug), pageKey: keyOf(slug), basis: "inferred" })) },
    business: { linkedServices: svc ? [{ serviceId: svc, name: svc, confirmed: true, basis: "observed" }] : [], geography: [], preliminaryIntent: prelim, commercialSignal: { present: false } }
  };
}

let oppSeq = 0;
function opp(type, { topicId = null, pageSlug = null, status = "new", confidence = "high", signal = null, signalStatus = null } = {}) {
  oppSeq++;
  return {
    id: `${BIZ}_opp${String(oppSeq).padStart(3, "0")}_${type}`,
    businessId: BIZ,
    source: "opportunity_engine",
    engineState: "active",
    type,
    status,
    confidence,
    priority: "medium",
    score: 60,
    targetTopicIds: topicId ? [topicId] : [],
    targetPageKeys: pageSlug != null ? [keyOf(pageSlug)] : [],
    title: `${type} ${topicId || pageSlug || signal}`,
    evidence: [{ id: `searchTopics/${topicId || "x"}#status`, sourceType: "owner_decision", sourceRef: { collection: "searchTopics", docId: topicId || "tRank", field: "status" }, observation: "status", basis: "observed", capturedAtMs: null }],
    signals: signal ? { geo: { level: 3, signal, status: signalStatus } } : {},
    estimatedEffort: { level: 2, basis: "assumption" },
    estimatedValue: { level: 2, basis: "inference" },
    impactInputs: { targetType: topicId ? "topic" : "page", targetId: topicId || pageSlug, baselineId: `${BIZ}_v1`, current: null, period: PERIOD },
    decisionId: null,
    lastEvaluatedAtMs: NOW - 200
  };
}

// The base scenario (one rule per topic). Every scenario test mutates a copy.
function fixture() {
  oppSeq = 0;
  const f = {
    business: { id: BIZ, name: "Hagar Lushi Studio", geographicMarkets: ["קיסריה", "חיפה"] },
    services: [service("svcArch", "אדריכלות", { aliases: ["אדריכלית"], audiences: [{ value: "משפחות", provenance: "owner" }] }), service("svcInt", "עיצוב פנים")],
    knowledge: [{ id: "k1", businessId: BIZ, type: "brand_terminology", content: "הגר לושי" }],
    seoPages: [
      page("", "homepage", "Hagar Lushi Studio", { h1: ["סטודיו לאדריכלות ועיצוב"] }),
      page("architecture", "service", "אדריכלות למגורים", { h1: ["אדריכלות"] }),
      page("interior", "service", "עיצוב פנים", { h1: ["עיצוב פנים לבית"] }),
      page("blog-kitchens", "article", "מטבחים קטנים", { links: { inboundInternalCount: 0, scope: "counted among 6 crawled pages" } }),
      page("contact", "contact", "צור קשר", { canonical: { state: "conflicting", targets: ["a", "b"] } })
    ],
    searchTopics: [
      // Hebrew prefix letters ("בקיסריה") defeat whole-token place matching (known
      // M3.2 limitation), so the family also carries the bare form.
      topic("tRank", "אדריכלית בקיסריה", { status: "priority", svc: "svcArch", prelim: "local", queries: ["אדריכלית בקיסריה", "אדריכלית קיסריה"] }),
      topic("tBrand", "הגר לושי", { status: "brand_strategic", prelim: "navigational" }),
      topic("tLearn", "איך לבחור אדריכלית", { svc: "svcArch", prelim: "informational" }),
      topic("tGap", "שיפוץ דירות"),
      topic("tWait", "דירות גן"),
      topic("tNew", "לא מאושר", { status: "new" })
    ],
    topicIntel: [
      intel("tRank", "אדריכלית בקיסריה", { gsc: [["architecture", 380, 20, 8.2, ["אדריכלית בקיסריה", "אדריכלית קיסריה"]]], svc: "svcArch", semrush: 1300 }),
      intel("tBrand", "הגר לושי", { gsc: [["", 900, 150, 1.4, ["הגר לושי"]], ["contact", 30, 2, 3, ["הגר לושי טלפון"]]] }),
      intel("tLearn", "איך לבחור אדריכלית", { gsc: "none", semrush: 500, svc: "svcArch" }),
      intel("tGap", "שיפוץ דירות", { gsc: "none" }),
      intel("tWait", "דירות גן", { gsc: null })
    ],
    opportunities: [],
    baseline: { id: `${BIZ}_v1`, version: 1, sourceRunId: "run1", capturedAtMs: NOW - 300 },
    run: { id: "run1", businessId: BIZ, status: "completed", completedAtMs: NOW - 400 },
    policy: undefined
  };
  f.opportunities = [
    opp("ranking_upside", { topicId: "tRank" }),
    opp("coverage_gap", { topicId: "tLearn", confidence: "medium" }),
    opp("coverage_gap", { topicId: "tGap", confidence: "medium" }),
    opp("technical_blocker", { pageSlug: "contact" }),
    opp("internal_linking", { pageSlug: "blog-kitchens" }),
    opp("entity_clarity", { signal: "fact_consistency", signalStatus: "partial" })
  ];
  return f;
}

function pureInput(f, extra = {}) {
  return {
    business: f.business,
    services: f.services,
    knowledge: f.knowledge,
    searchTopics: f.searchTopics,
    topicIntel: f.topicIntel,
    seoPages: f.seoPages,
    opportunities: f.opportunities,
    baseline: f.baseline,
    policy: f.policy || cfg.resolvePolicy(f.business.decisionPolicy),
    nowMs: NOW,
    ...extra
  };
}

const run = (f) => decide(pureInput(f));
const intentDecision = (r, topicId) => r.decisions.find((d) => d.scope === "intent" && d.intentId === `${BIZ}_${topicId}`);
const intentDoc = (r, topicId) => r.intents.find((i) => i.intentId === `${BIZ}_${topicId}`);

async function seedStore(f) {
  const fake = createFakeFirestore();
  const db = fake.admin.firestore();
  const { id, ...biz } = f.business;
  await db.collection("businesses").doc(BIZ).set(biz);
  for (const s of f.services) await db.collection("businessServices").doc(s.id).set(s);
  for (const k of f.knowledge) await db.collection("businessKnowledge").doc(k.id).set(k);
  for (const t of f.searchTopics) await db.collection("searchTopics").doc(t.id).set(t);
  if (f.run) await db.collection("intelligenceRuns").doc(f.run.id).set(f.run);
  for (const t of f.topicIntel) await db.collection("topicIntelligence").doc(t.id).set(t);
  for (const p of f.seoPages) await db.collection("seoPages").doc(p.id).set(p);
  if (f.baseline) await db.collection("baselines").doc(f.baseline.id).set({ businessId: BIZ, ...f.baseline });
  for (const o of f.opportunities) await db.collection("opportunities").doc(o.id).set(o);
  await db.collection("opportunities").doc("manual1").set({ businessId: BIZ, title: "manual", status: "approved", source: "manual" });
  const approvedIds = f.searchTopics.filter((t) => APPROVED.includes(t.status)).map((t) => t.id);
  await db.collection("opportunityRuns").doc("oppRun1").set({ businessId: BIZ, status: "completed", completedAtMs: NOW - 100, inputHash: "m5hash1", intelligenceRunId: f.run ? f.run.id : null, topicEvaluations: approvedIds.map((t) => ({ topicId: t, outcome: "opportunities" })) });
  return { fake, db };
}

async function setupStore(mutate = (f) => f) {
  const f = mutate(fixture());
  const { fake, db } = await seedStore(f);
  const store = loadWithFake(fake, STORE);
  const runM6 = (n = NOW) => store.runDecisionEngine({ businessId: BIZ, nowMs: n });
  const decisions = () => fake.rows("decisions");
  return { f, fake, db, store, runM6, decisions };
}

// Forbidden claims (EN + HE): Google's canonical choice / duplicates "in Google".
// Affirmative claims only - the engine's own disclaimers ("not a statement
// about which URL Google has selected as canonical") are allowed.
const FORBIDDEN = /Google (considers|sees|treats) (these|the|both) pages as|duplicates? in Google|Google['’]s (selected|chosen) canonical is|Google (has )?(selected|chose|picked) (this|the|that) (URL|page|canonical)|Google בחר |גוגל בחר |Google רואה|גוגל רואה|כפולים בגוגל|כפולים ב-Google|Google החליט|גוגל החליט/i;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
  }
}

function noUndefined(v, where) {
  if (v === undefined) throw new Error(`undefined value at ${where} (Firestore rejects undefined)`);
  if (Array.isArray(v)) v.forEach((x, i) => noUndefined(x, `${where}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) noUndefined(x, `${where}.${k}`);
}

// Universal invariants checked on every decision set the tests produce.
function invariants(r, label) {
  noUndefined(r.decisions, `${label}.decisions`);
  noUndefined(r.intents, `${label}.intents`);
  const ids = new Set();
  for (const d of r.decisions) {
    assert.ok(!ids.has(d.decisionId), `${label}: unique decision ids`);
    ids.add(d.decisionId);
    assert.ok(["CREATE", "IMPROVE", "CONSOLIDATE", "WAIT", "MONITOR", "REJECT"].includes(d.decision), `${label}: canonical decision ${d.decision}`);
    assert.ok(d.reasonCodes.length >= 1, `${label}: ${d.decisionId} has reason codes`);
    assert.ok(["high", "medium", "low"].includes(d.confidence), `${label}: confidence`);
    assert.ok(Array.isArray(d.confidenceReasons) && Array.isArray(d.blockingConditions) && Array.isArray(d.alternativesConsidered) && Array.isArray(d.evidence) && Array.isArray(d.opportunityIds), `${label}: explainability fields`);
    assert.strictEqual(d.basis, "recommendation");
    // G10: IMPROVE / CONSOLIDATE always target a real existing page (or business facts at site scope)
    if (d.decision === "IMPROVE" || d.decision === "CONSOLIDATE") {
      if (d.scope === "site") assert.strictEqual(d.recommendedPage.kind, "business_facts", `${label}: site IMPROVE targets business facts`);
      else {
        assert.strictEqual(d.recommendedPage.kind, "existing", `${label}: ${d.decisionId} ${d.decision} targets an existing page`);
        assert.ok(d.recommendedPage.pageKey && d.recommendedPage.url, `${label}: ${d.decisionId} non-null target`);
      }
    }
    // G8: CREATE is a placeholder only
    if (d.decision === "CREATE") {
      assert.deepStrictEqual(Object.keys(d.recommendedPage).sort(), ["intentId", "kind", "note", "pageKey", "url"]);
      assert.strictEqual(d.recommendedPage.kind, "new_page_placeholder");
      assert.strictEqual(d.recommendedPage.pageKey, null);
      assert.strictEqual(d.recommendedPage.url, null);
      assert.ok(d.newPageJustification.evaluated && d.newPageJustification.justified, `${label}: CREATE justified`);
      assert.ok(d.newPageJustification.distinctValue, `${label}: CREATE states its distinct value`);
      assert.ok("existingOwnerPageKey" in d && d.collision && d.collision.status && d.collision.reason, `${label}: CREATE explains owner + collision`);
      assert.ok(d.ownership && !d.ownership.acceptable, `${label}: G2 never CREATE with an acceptable owner`);
    }
    // IMPROVE records why CREATE was not chosen
    if (d.decision === "IMPROVE" && d.scope === "intent") assert.ok(d.alternativesConsidered.some((a) => a.decision === "CREATE" && a.rejectedBecause.length), `${label}: IMPROVE says why not CREATE`);
    if (d.consolidation) assert.strictEqual(d.consolidation.googleSelectedCanonical, null, `${label}: googleSelectedCanonical null`);
    assert.ok(!FORBIDDEN.test(JSON.stringify(d)), `${label}: no Google-canonical claim in ${d.decisionId}`);
    // never a URL / slug / brief / task for a new page
    assert.ok(!/"slug"|"brief"|"contentBrief"|"taskId"|"draft"/.test(JSON.stringify(d)), `${label}: no slug/brief/task fields`);
  }
  for (const i of r.intents) assert.strictEqual(i.cannibalization.googleSelectedCanonical, null);
}

(async () => {
  // ---------------------------------------------------------------- intent
  await test("intent: types per approved rule, unclassified stays valid, stable anchor ids", async () => {
    const r = run(fixture());
    invariants(r, "base");
    assert.strictEqual(intentDoc(r, "tRank").intentType, "local");
    assert.strictEqual(intentDoc(r, "tBrand").intentType, "navigational");
    assert.strictEqual(intentDoc(r, "tLearn").intentType, "how_to");
    assert.strictEqual(intentDoc(r, "tGap").intentType, "unclassified");
    assert.ok(!r.intents.some((i) => i.topicIds.includes("tNew")), "unapproved topic never becomes an intent");
    for (const i of r.intents) assert.strictEqual(i.intentBasis, "inference");
    const types = (title, extra = {}) => {
      const f = fixture();
      f.searchTopics = [topic("tX", title, { svc: "svcArch", ...extra })];
      f.topicIntel = [intel("tX", title, { svc: "svcArch" })];
      f.opportunities = [];
      return run(f).intents[0].intentType;
    };
    assert.strictEqual(types("אדריכלות מחיר"), "pricing");
    assert.strictEqual(types("אדריכלות לעומת עיצוב"), "comparison");
    assert.strictEqual(types("אדריכלית המלצות"), "review");
    assert.strictEqual(types("מה זה אדריכלות נוף"), "definition");
    assert.strictEqual(types("אדריכלות", { prelim: "commercial" }), "commercial_investigation");
    assert.strictEqual(types("אדריכלות וידאו"), "media", "extended type only where the approved rows leave it unclassified");
    assert.strictEqual(types("אדריכלות ירוקה"), "unclassified");
  });

  await test("intent: user task, lightweight entity refs, cluster id", async () => {
    const r = run(fixture());
    const rank = intentDoc(r, "tRank");
    assert.deepStrictEqual(rank.userTask.verb, "hire");
    assert.strictEqual(rank.userTask.object, "service:svcArch");
    assert.strictEqual(rank.userTask.qualifiers.geography, "place:קיסריה");
    const ids = rank.entityRefs.map((e) => e.id);
    assert.ok(ids.includes("service:svcArch") && ids.includes("place:קיסריה"));
    assert.ok(rank.entityRefs.every((e) => /^(service|place|audience|brand):/.test(e.id)), "only lightweight refs");
    assert.strictEqual(intentDoc(r, "tBrand").userTask.verb, "find_business");
    assert.ok(intentDoc(r, "tBrand").entityRefs.some((e) => e.id === `brand:${BIZ}`));
    assert.strictEqual(intentDoc(r, "tLearn").userTask.verb, "learn");
    assert.strictEqual(rank.clusterId, `${BIZ}_cluster_service:svcArch`);
    assert.strictEqual(intentDoc(r, "tGap").clusterId, `${BIZ}_cluster_brand`);
  });

  await test("G4 grouping: equivalent topics merge into one intent; different places never merge", async () => {
    const f = fixture();
    f.searchTopics.push(topic("tRank2", "אדריכלית קיסריה", { svc: "svcArch" }), topic("tHaifa", "אדריכלית בחיפה", { svc: "svcArch", queries: ["אדריכלית בחיפה", "אדריכלית חיפה"] }));
    f.topicIntel.push(intel("tRank2", "אדריכלית קיסריה", { gsc: [["architecture", 50, 2, 9, ["אדריכלית קיסריה"]]], svc: "svcArch" }), intel("tHaifa", "אדריכלית בחיפה", { svc: "svcArch" }));
    const r = run(f);
    invariants(r, "grouping");
    const merged = r.intents.find((i) => i.topicIds.includes("tRank2"));
    assert.deepStrictEqual(merged.topicIds, ["tRank", "tRank2"]);
    assert.strictEqual(merged.intentId, `${BIZ}_tRank`, "anchored on the smallest topic id");
    assert.ok(!merged.topicIds.includes("tHaifa"), "different place -> different intent");
    assert.strictEqual(r.decisions.filter((d) => d.intentId === merged.intentId).length, 1);
  });

  // ------------------------------------------------------------- G1 units
  await test("G1: 100 queries in one intent -> 1 decision", async () => {
    const f = fixture();
    const queries = ["אדריכלית בקיסריה", ...Array.from({ length: 99 }, (_, i) => `אדריכלית בקיסריה ${i}`)];
    f.searchTopics = f.searchTopics.map((t) => (t.id === "tRank" ? { ...t, queries } : t));
    f.topicIntel = f.topicIntel.map((t) => (t.topicId === "tRank" ? intel("tRank", "אדריכלית בקיסריה", { gsc: [["architecture", 900, 40, 8, queries]], svc: "svcArch", semrush: 1300 }) : t));
    const r = run(f);
    invariants(r, "100q");
    assert.strictEqual(intentDoc(r, "tRank").queryCount, 100);
    assert.strictEqual(r.decisions.filter((d) => d.intentId === `${BIZ}_tRank`).length, 1);
  });

  await test("G1: 10 M5 opportunities on one intent -> 1 decision folding all 10", async () => {
    const f = fixture();
    const types = ["ranking_upside", "ctr_upside", "page_overlap_observed", "page_not_visible", "coverage_gap"];
    const extra = Array.from({ length: 9 }, (_, i) => opp(types[i % types.length], { topicId: "tRank" }));
    f.opportunities.push(...extra);
    const r = run(f);
    invariants(r, "10opps");
    const d = intentDecision(r, "tRank");
    assert.strictEqual(d.opportunityIds.length, 10);
    assert.strictEqual(r.decisions.filter((x) => x.opportunityIds.some((id) => extra.some((e) => e.id === id))).length, 1);
    const total = r.intents.length + new Set(f.opportunities.filter((o) => o.targetPageKeys.length).map((o) => o.targetPageKeys[0])).size + 1;
    assert.ok(r.decisions.length <= total, "decision count bounded by units, not queries/opportunities");
  });

  // ------------------------------------------------------------ ownership
  await test("ownership: established / probable / none / unknown; thresholds labelled as internal heuristics", async () => {
    const r = run(fixture());
    const rank = intentDoc(r, "tRank").ownership;
    assert.strictEqual(rank.status, "established");
    assert.strictEqual(rank.primaryOwnerPageKey, keyOf("architecture"));
    assert.strictEqual(rank.acceptable, true);
    assert.strictEqual(rank.candidates[0].observedShare, 1);
    assert.strictEqual(rank.candidates[0].eligibility, "eligible");
    assert.strictEqual(rank.candidates[0].intentFit, "fit");
    assert.strictEqual(rank.thresholds.basis, "assumption");
    assert.ok(/not a Google-defined/.test(rank.thresholds.note));
    assert.strictEqual(intentDoc(r, "tLearn").ownership.status, "probable", "service page for the service is a content candidate");
    assert.strictEqual(intentDoc(r, "tLearn").ownership.acceptable, false, "a service page does not fit a how-to intent");
    assert.strictEqual(intentDoc(r, "tGap").ownership.status, "none");
    assert.strictEqual(intentDoc(r, "tWait").ownership.status, "unknown");
  });

  await test("ownership: contested split and homepage not automatically the owner of a service+place intent", async () => {
    const f = fixture();
    f.topicIntel = f.topicIntel.map((t) => (t.topicId === "tRank" ? intel("tRank", "אדריכלית בקיסריה", { gsc: [["architecture", 50, 2, 8, ["a"]], ["interior", 50, 2, 9, ["b"]]], svc: "svcArch" }) : t));
    assert.strictEqual(intentDoc(run(f), "tRank").ownership.status, "contested");
    const g = fixture();
    g.topicIntel = g.topicIntel.map((t) => (t.topicId === "tRank" ? intel("tRank", "אדריכלית בקיסריה", { gsc: [["", 400, 10, 6, ["אדריכלית בקיסריה"]]], svc: "svcArch" }) : t));
    const r = run(g);
    invariants(r, "home-owner");
    const own = intentDoc(r, "tRank").ownership;
    assert.strictEqual(own.status, "established");
    assert.strictEqual(own.primaryOwnerPageKey, keyOf(""));
    assert.strictEqual(own.acceptable, false, "homepage is not an acceptable owner of a specific service + place intent");
  });

  // -------------------------------------------------------- decision table
  await test("decision table: base scenario outcomes", async () => {
    const r = run(fixture());
    invariants(r, "base");
    const rank = intentDecision(r, "tRank");
    assert.strictEqual(rank.decision, "IMPROVE");
    assert.strictEqual(rank.actionDetail, "strengthen_content");
    assert.ok(rank.reasonCodes.includes("OWNER_ESTABLISHED"));
    assert.ok(rank.alternativesConsidered.some((a) => a.decision === "CREATE" && a.rejectedBecause.includes("EXISTING_OWNER")), "acceptable owner -> CREATE explicitly avoided");
    const brand = intentDecision(r, "tBrand");
    assert.strictEqual(brand.decision, "REJECT");
    assert.ok(brand.reasonCodes.includes("NO_ACTION_NEEDED"));
    const learn = intentDecision(r, "tLearn");
    assert.strictEqual(learn.decision, "CREATE");
    assert.deepStrictEqual(learn.newPageJustification.distinctOn.sort(), ["information_requirement", "user_task"]);
    assert.strictEqual(learn.existingOwnerPageKey, keyOf("architecture"));
    assert.strictEqual(learn.cluster.parentPageKey, keyOf("architecture"));
    assert.ok(learn.alternativesConsidered.some((a) => a.decision === "IMPROVE" && a.target === keyOf("architecture")), "parent page named, and why IMPROVE was not chosen");
    const gap = intentDecision(r, "tGap");
    assert.strictEqual(gap.decision, "WAIT");
    assert.ok(gap.reasonCodes.includes("INTENT_UNCLASSIFIED") && gap.reasonCodes.includes("ENTITY_UNKNOWN"));
    const wait = intentDecision(r, "tWait");
    assert.strictEqual(wait.decision, "WAIT");
    assert.ok(wait.reasonCodes.includes("MISSING_VISIBILITY_DATA"));
    const contact = r.decisions.find((d) => d.scope === "page" && d.pageKey === keyOf("contact"));
    assert.strictEqual(contact.decision, "IMPROVE");
    assert.strictEqual(contact.actionDetail, "fix_eligibility");
    assert.ok(contact.blockingConditions.includes("CONFIRM_BLOCKER_UNINTENDED"));
    const blog = r.decisions.find((d) => d.scope === "page" && d.pageKey === keyOf("blog-kitchens"));
    assert.strictEqual(blog.decision, "MONITOR");
    assert.ok(blog.reasonCodes.includes("NOT_AN_OWNER_PAGE"));
    const site = r.decisions.find((d) => d.scope === "site");
    assert.strictEqual(site.decision, "IMPROVE");
    assert.strictEqual(site.actionDetail, "clarify_business_facts");
  });

  await test("decision table: owner rejected all folded opportunities -> REJECT", async () => {
    const f = fixture();
    f.opportunities = f.opportunities.map((o) => (o.targetTopicIds.includes("tRank") ? { ...o, status: "rejected" } : o));
    const d = intentDecision(run(f), "tRank");
    assert.strictEqual(d.decision, "REJECT");
    assert.deepStrictEqual(d.reasonCodes, ["OWNER_REJECTED"]);
  });

  await test("decision table: acceptable owner with a blocker -> IMPROVE fix_eligibility", async () => {
    const f = fixture();
    f.seoPages = f.seoPages.map((p) => (p.pageKey === keyOf("architecture") ? { ...p, indexability: { state: "non_indexable", reasons: ["noindex"] } } : p));
    const r = run(f);
    invariants(r, "blocker");
    const d = intentDecision(r, "tRank");
    assert.strictEqual(d.decision, "IMPROVE");
    assert.strictEqual(d.actionDetail, "fix_eligibility");
    assert.ok(d.reasonCodes.includes("OWNER_HAS_BLOCKER"));
  });

  await test("decision table: probable owner without visibility -> IMPROVE rework_intent", async () => {
    const f = fixture();
    f.searchTopics.push(topic("tSvc", "אדריכלות מחיר", { svc: "svcArch" }));
    f.topicIntel.push(intel("tSvc", "אדריכלות מחיר", { gsc: "none", svc: "svcArch" }));
    f.opportunities.push(opp("page_not_visible", { topicId: "tSvc" }));
    const r = run(f);
    invariants(r, "probable");
    const d = intentDecision(r, "tSvc");
    assert.strictEqual(d.decision, "IMPROVE");
    assert.strictEqual(d.actionDetail, "rework_intent");
    assert.strictEqual(d.recommendedPage.pageKey, keyOf("architecture"));
  });

  // -------------------------------------------------------------- property
  await test("G2 property: whenever the owner is acceptable, the decision is never CREATE", async () => {
    let checked = 0;
    const roles = ["service", "article", "homepage", "other", "contact"];
    const titles = ["אדריכלית בקיסריה", "איך לבחור אדריכלית", "אדריכלות מחיר", "הגר לושי", "מה זה אדריכלות", "אדריכלות ירוקה"];
    for (const role of roles) {
      for (const title of titles) {
        for (const gscMode of ["obs", "none"]) {
          for (const semrush of [null, 800]) {
            const f = fixture();
            f.seoPages = f.seoPages.map((p) => (p.pageKey === keyOf("architecture") ? { ...p, role: { role } } : p));
            f.searchTopics = [topic("tP", title, { svc: "svcArch", status: "priority" })];
            f.topicIntel = [intel("tP", title, { gsc: gscMode === "obs" ? [["architecture", 300, 10, 7, [title]]] : "none", svc: "svcArch", semrush })];
            f.opportunities = [opp(gscMode === "obs" ? "ranking_upside" : "page_not_visible", { topicId: "tP" })];
            const r = run(f);
            invariants(r, `prop ${role}/${title}/${gscMode}/${semrush}`);
            const i = r.intents[0];
            const d = intentDecision(r, "tP");
            if (i.ownership.acceptable) assert.notStrictEqual(d.decision, "CREATE", `${role}/${title}`);
            checked++;
          }
        }
      }
    }
    assert.strictEqual(checked, roles.length * titles.length * 4);
  });

  // ------------------------------------------------------- cannibalization
  await test("cannibalization: POTENTIAL -> MONITOR", async () => {
    const f = fixture();
    f.topicIntel = f.topicIntel.map((t) => (t.topicId === "tRank" ? intel("tRank", "אדריכלית בקיסריה", { gsc: [["architecture", 70, 5, 8, ["q1", "q2", "q3"]], ["blog-kitchens", 30, 1, 12, ["q1", "q2"]]], svc: "svcArch" }) : t));
    const r = run(f);
    invariants(r, "potential");
    assert.strictEqual(intentDoc(r, "tRank").cannibalization.status, "POTENTIAL_COLLISION");
    const d = intentDecision(r, "tRank");
    assert.strictEqual(d.decision, "MONITOR");
    assert.ok(d.reasonCodes.includes("COLLISION_POTENTIAL"));
    assert.ok(d.blockingConditions.includes("NEEDS_SERP_OVERLAP_OR_MORE_DATA"));
  });

  await test("cannibalization: HIGH -> CONSOLIDATE (our recommendation, never Google's canonical)", async () => {
    const f = fixture();
    f.seoPages.push(page("architecture-homes", "service", "אדריכלות בתים", { h1: ["אדריכלות לבתים פרטיים"] }));
    f.topicIntel = f.topicIntel.map((t) => (t.topicId === "tRank" ? intel("tRank", "אדריכלית בקיסריה", { gsc: [["architecture", 55, 4, 8, ["q1", "q2", "q3"]], ["architecture-homes", 45, 3, 9, ["q1", "q2", "q4"]]], svc: "svcArch" }) : t));
    const r = run(f);
    invariants(r, "high");
    assert.strictEqual(intentDoc(r, "tRank").cannibalization.status, "HIGH_COLLISION");
    const d = intentDecision(r, "tRank");
    assert.strictEqual(d.decision, "CONSOLIDATE");
    assert.strictEqual(d.consolidation.recommendedOwnerPageKey, keyOf("architecture"));
    assert.deepStrictEqual(d.consolidation.otherPageKeys, [keyOf("architecture-homes")]);
    assert.strictEqual(d.consolidation.googleSelectedCanonical, null);
    assert.strictEqual(d.consolidation.basis, "recommendation");
    assert.ok(/not a statement about which URL Google has selected/.test(d.consolidation.statement));
    assert.ok(d.summary.includes("המלצה שלנו") && d.summary.includes("לא החלטה של Google"));
    assert.notStrictEqual(d.confidence, "high", "no declared canonical, no SERP -> not high");
    assert.ok(d.blockingConditions.includes("HUMAN_REVIEW_REQUIRED"));
  });

  await test("cannibalization: declared canonical relation -> DUPLICATE -> CONSOLIDATE; the tag is a declared preference only", async () => {
    const f = fixture();
    f.seoPages.push(page("architecture-old", "other", "ארכיון", { canonical: { state: "points_elsewhere", target: urlOf("architecture") } }));
    f.topicIntel = f.topicIntel.map((t) => (t.topicId === "tRank" ? intel("tRank", "אדריכלית בקיסריה", { gsc: [["architecture", 70, 4, 8, ["q1"]], ["architecture-old", 30, 1, 9, ["q9"]]], svc: "svcArch" }) : t));
    const r = run(f);
    invariants(r, "duplicate");
    assert.strictEqual(intentDoc(r, "tRank").cannibalization.status, "DUPLICATE");
    const d = intentDecision(r, "tRank");
    assert.strictEqual(d.decision, "CONSOLIDATE");
    assert.ok(d.reasonCodes.includes("COLLISION_DUPLICATE"));
    assert.strictEqual(d.consolidation.recommendedOwnerPageKey, keyOf("architecture"), "the eligible page, not the one pointing away");
    assert.strictEqual(d.consolidation.declaredCanonicals.length, 1);
    assert.ok(/declared preference/.test(d.consolidation.declaredCanonicals[0].note));
    assert.ok(/not Google's selected canonical/.test(d.consolidation.declaredCanonicals[0].note));
    assert.strictEqual(d.consolidation.googleSelectedCanonical, null);
    assert.ok(d.missing.includes("google_selected_canonical"));
  });

  await test("cannibalization: thresholds are labelled internal heuristics, not Google thresholds", async () => {
    const r = run(fixture());
    for (const i of r.intents) {
      assert.strictEqual(i.cannibalization.thresholds.basis, "assumption");
      assert.ok(/not Google-defined/.test(i.cannibalization.thresholds.note));
      assert.strictEqual(i.cannibalization.serpOverlap, "missing");
    }
    const src = fs.readFileSync(path.join(__dirname, "..", "decisionConfig.js"), "utf8");
    assert.ok(/INTERNAL HEURISTIC/.test(src) && /None of them is a value defined or published by Google/.test(src));
  });

  // ----------------------------------------------------------- CREATE gates
  await test("CREATE gates: unclassified intent and unknown entity never CREATE", async () => {
    const f = fixture();
    f.searchTopics.push(topic("tBare", "אדריכלות ירוקה", { svc: "svcArch", status: "priority" }));
    f.topicIntel.push(intel("tBare", "אדריכלות ירוקה", { gsc: "none", svc: "svcArch", semrush: 900 }));
    f.searchTopics.push(topic("tNoEnt", "איך לשפץ מקלחת", { status: "priority" }));
    f.topicIntel.push(intel("tNoEnt", "איך לשפץ מקלחת", { gsc: "none", semrush: 900 }));
    const r = run(f);
    invariants(r, "gates4");
    const bare = intentDecision(r, "tBare");
    assert.notStrictEqual(bare.decision, "CREATE");
    assert.ok(bare.reasonCodes.includes("INTENT_UNCLASSIFIED"));
    const noEnt = intentDecision(r, "tNoEnt");
    assert.strictEqual(noEnt.decision, "WAIT");
    assert.ok(noEnt.reasonCodes.includes("ENTITY_UNKNOWN"));
    assert.ok(noEnt.blockingConditions.includes("NEEDS_ENTITY_CONFIRMATION"));
  });

  await test("CREATE gates: missing demand -> confidence capped; learn-type without demand or visibility -> WAIT", async () => {
    const f = fixture();
    f.searchTopics = f.searchTopics.map((t) => (t.id === "tLearn" ? { ...t, status: "priority" } : t));
    f.topicIntel = f.topicIntel.map((t) => (t.topicId === "tLearn" ? intel("tLearn", "איך לבחור אדריכלית", { gsc: "none", svc: "svcArch" }) : t));
    const d = intentDecision(run(f), "tLearn");
    assert.strictEqual(d.decision, "WAIT", "owner priority alone is not enough for a learn-type page (G7)");
    assert.ok(d.reasonCodes.includes("INFORMATIONAL_NEEDS_DEMAND") && d.reasonCodes.includes("MISSING_MARKET_DEMAND"));
    assert.ok(d.blockingConditions.includes("NEEDS_MARKET_DEMAND"));
    // a non-learn priority intent passes the value gate on owner priority, with capped confidence
    const g = fixture();
    g.searchTopics.push(topic("tPrice", "עיצוב פנים מחיר", { svc: "svcInt", status: "priority" }));
    g.topicIntel.push(intel("tPrice", "עיצוב פנים מחיר", { gsc: "none", svc: "svcInt" }));
    g.seoPages = g.seoPages.filter((p) => p.pageKey !== keyOf("interior"));
    const r = run(g);
    invariants(r, "priority-only");
    const p = intentDecision(r, "tPrice");
    assert.strictEqual(p.decision, "CREATE");
    assert.notStrictEqual(p.confidence, "high", "unknown market demand never yields a high-confidence CREATE");
    assert.ok(p.reasonCodes.includes("MISSING_MARKET_DEMAND"));
    assert.ok(p.missing.includes("market_demand"));
  });

  await test("visibility != demand: visibility-only CREATE is labelled visibility, demand stays unknown, confidence <= medium", async () => {
    const f = fixture();
    f.topicIntel = f.topicIntel.map((t) => (t.topicId === "tLearn" ? intel("tLearn", "איך לבחור אדריכלית", { gsc: [["blog-kitchens", 40, 1, 30, ["איך לבחור אדריכלית"]]], svc: "svcArch" }) : t));
    f.seoPages = f.seoPages.map((p) => (p.pageKey === keyOf("blog-kitchens") ? { ...p, role: { role: "contact" } } : p));
    const r = run(f);
    invariants(r, "vis-only");
    const d = intentDecision(r, "tLearn");
    assert.strictEqual(d.decision, "CREATE");
    assert.ok(d.reasonCodes.includes("VISIBILITY_OBSERVED_NOT_DEMAND"));
    assert.ok(d.blockingConditions.includes("NEEDS_MARKET_DEMAND"));
    assert.ok(d.missing.includes("market_demand"));
    assert.notStrictEqual(d.confidence, "high");
    assert.strictEqual(d.businessValue.marketDemand.status, "unknown");
    assert.strictEqual(d.businessValue.marketDemand.source, null);
    assert.strictEqual(d.businessValue.observedVisibility.source, "search_console");
    assert.ok(!("demand" in d.businessValue.observedVisibility) && !("marketDemand" in d.businessValue.observedVisibility));
    for (const i of r.intents) assert.ok(i.businessValue.marketDemand.source === null || i.businessValue.marketDemand.source === "semrush", "market demand only ever from Semrush");
  });

  await test("zero visibility is never zero demand", async () => {
    const r = run(fixture());
    const gap = intentDoc(r, "tGap");
    assert.strictEqual(gap.businessValue.observedVisibility.impressions, 0);
    assert.strictEqual(gap.businessValue.marketDemand.status, "unknown");
    assert.strictEqual(gap.businessValue.marketDemand.monthlyVolume, null);
  });

  // ------------------------------------------------------------- G6 location
  function locationFixture({ semrush = null, gsc = "none", relatedPage = true, ownerDeclared = true } = {}) {
    const f = fixture();
    f.business = { ...f.business, geographicMarkets: ownerDeclared ? ["קיסריה", "חיפה"] : ["קיסריה"] };
    f.seoPages = f.seoPages.filter((p) => p.pageKey !== keyOf("architecture"));
    if (relatedPage) f.seoPages.push(page("about-architecture", "other", "על האדריכלות שלנו", { h1: ["אדריכלות"] }));
    f.searchTopics = [topic("tCity", "אדריכלית בחיפה", { svc: "svcArch", status: "priority", queries: ["אדריכלית בחיפה", "אדריכלית חיפה"] })];
    if (!ownerDeclared) f.searchTopics[0].seedRefs = [{ serviceId: "svcArch", components: [{ dimension: "geographies", value: "חיפה", provenance: "website" }] }];
    f.topicIntel = [intel("tCity", "אדריכלית בחיפה", { gsc, matched: [""], svc: "svcArch", semrush })];
    f.opportunities = [opp("page_not_visible", { topicId: "tCity" })];
    return f;
  }

  await test("G6 location gate: pass with market demand -> CREATE", async () => {
    const r = run(locationFixture({ semrush: 300 }));
    invariants(r, "g6-pass");
    const d = intentDecision(r, "tCity");
    assert.strictEqual(r.intents[0].intentType, "local");
    assert.strictEqual(d.decision, "CREATE");
    assert.ok(d.newPageJustification.distinctOn.includes("entity_place"));
    assert.strictEqual(d.createGates.g6.pass, true);
  });

  await test("G6 location gate: fail with an existing service page -> IMPROVE that page", async () => {
    const r = run(locationFixture({ semrush: null, relatedPage: true }));
    invariants(r, "g6-fail-page");
    const d = intentDecision(r, "tCity");
    assert.strictEqual(d.decision, "IMPROVE");
    assert.ok(d.reasonCodes.includes("LOCATION_VARIANT_NOT_JUSTIFIED"));
    assert.strictEqual(d.recommendedPage.pageKey, keyOf("about-architecture"));
  });

  await test("G6 location gate: fail without a service page -> WAIT (never IMPROVE to nowhere)", async () => {
    const r = run(locationFixture({ semrush: null, relatedPage: false }));
    invariants(r, "g6-fail-nopage");
    const d = intentDecision(r, "tCity");
    assert.strictEqual(d.decision, "WAIT");
    assert.ok(d.reasonCodes.includes("LOCATION_VARIANT_NOT_JUSTIFIED") && d.reasonCodes.includes("NO_PAGE_TO_EXTEND"));
    assert.strictEqual(d.recommendedPage.kind, "none");
  });

  await test("G6 location gate: place not owner-declared -> no new location page", async () => {
    const r = run(locationFixture({ semrush: 300, ownerDeclared: false }));
    invariants(r, "g6-undeclared");
    assert.notStrictEqual(intentDecision(r, "tCity").decision, "CREATE");
  });

  // --------------------------------------------------------- G5 / G11 limits
  function manyLearnIntents({ clusters }) {
    const f = fixture();
    f.searchTopics = [];
    f.topicIntel = [];
    f.opportunities = [];
    const titles = ["איך לבחור", "מה זה", "מדריך שלבים", "איך לתכנן", "מה זה בעצם"];
    for (let i = 0; i < 5; i++) {
      const svc = clusters === "many" ? `svc${i}` : "svcArch";
      if (clusters === "many") f.services.push(service(svc, `שירות${i}`));
      const title = `${titles[i]} ${clusters === "many" ? `שירות${i}` : ["גג", "חלון", "מדרגות", "חזית", "מרפסת"][i]}`;
      f.searchTopics.push(topic(`tL${i}`, title, { svc }));
      f.topicIntel.push(intel(`tL${i}`, title, { gsc: "none", svc, semrush: 100 * (i + 1) }));
      f.opportunities.push(opp("coverage_gap", { topicId: `tL${i}` }));
    }
    return f;
  }

  await test("G5 budget 3 (default): never more than 3 CREATE per run, overflow -> WAIT", async () => {
    const r = run(manyLearnIntents({ clusters: "many" }));
    invariants(r, "budget3");
    const creates = r.decisions.filter((d) => d.decision === "CREATE");
    assert.strictEqual(r.policy.createBudgetPerRun, 3);
    assert.strictEqual(creates.length, 3);
    const over = r.decisions.filter((d) => d.reasonCodes.includes("CREATE_BUDGET_EXCEEDED"));
    assert.strictEqual(over.length, 2);
    assert.ok(over.every((d) => d.decision === "WAIT" && d.deferredCreate && d.newPageJustification.justified), "rationale kept");
    assert.deepStrictEqual(creates.map((d) => d.intentId).sort(), [`${BIZ}_tL2`, `${BIZ}_tL3`, `${BIZ}_tL4`], "highest market demand first, deterministic");
  });

  await test("G5 budget 0 -> zero CREATE, CREATE_DISABLED_BY_POLICY; policy can only lower the ceiling", async () => {
    const f = manyLearnIntents({ clusters: "many" });
    f.business = { ...f.business, decisionPolicy: { createBudgetPerRun: 0 } };
    const r = run(f);
    invariants(r, "budget0");
    assert.strictEqual(r.decisions.filter((d) => d.decision === "CREATE").length, 0);
    assert.strictEqual(r.decisions.filter((d) => d.reasonCodes.includes("CREATE_DISABLED_BY_POLICY")).length, 5);
    assert.strictEqual(r.policy.sources.createBudgetPerRun, "business_policy");
    const raised = cfg.resolvePolicy({ createBudgetPerRun: 50, createsPerClusterPerRun: 9 });
    assert.strictEqual(raised.createBudgetPerRun, 3, "cannot raise above the safety ceiling");
    assert.strictEqual(raised.createsPerClusterPerRun, 1);
    assert.strictEqual(cfg.resolvePolicy({ createBudgetPerRun: -4 }).createBudgetPerRun, 0);
    assert.strictEqual(cfg.resolvePolicy({ createBudgetPerRun: 2 }).createBudgetPerRun, 2);
  });

  await test("G11 cluster: one CREATE per cluster by default, the others WAIT with a dependency; parent page named", async () => {
    const r = run(manyLearnIntents({ clusters: "one" }));
    invariants(r, "cluster");
    const ds = r.decisions.filter((d) => d.scope === "intent");
    const creates = ds.filter((d) => d.decision === "CREATE");
    assert.strictEqual(creates.length, 1);
    const pending = ds.filter((d) => d.reasonCodes.includes("CLUSTER_CREATE_PENDING"));
    assert.strictEqual(pending.length, 4);
    for (const d of pending) {
      assert.strictEqual(d.decision, "WAIT");
      assert.deepStrictEqual(d.dependencies, [{ decisionId: creates[0].decisionId, relation: "same_cluster" }]);
    }
    assert.ok(ds.every((d) => d.reasonCodes.includes("CLUSTER_FRAGMENTATION_RISK")));
    assert.strictEqual(creates[0].cluster.parentPageKey, keyOf("architecture"));
    assert.strictEqual(r.summary.byCluster[`${BIZ}_cluster_service:svcArch`].CREATE, 1);
  });

  await test("G11 cluster limit 0 -> zero CREATE", async () => {
    const f = manyLearnIntents({ clusters: "one" });
    f.business = { ...f.business, decisionPolicy: { createsPerClusterPerRun: 0 } };
    const r = run(f);
    invariants(r, "cluster0");
    assert.strictEqual(r.decisions.filter((d) => d.decision === "CREATE").length, 0);
    assert.strictEqual(r.policy.createsPerClusterPerRun, 0);
  });

  // ------------------------------------------------------------ explainability
  await test("explainability: every decision carries reasons, evidence, ownership/collision; evidence ids resolve after a run", async () => {
    const t = await setupStore();
    await t.runM6();
    const known = (c) => new Set(t.fake.rows(c).map((d) => d.id));
    const cols = { searchTopics: known("searchTopics"), topicIntelligence: known("topicIntelligence"), seoPages: known("seoPages"), searchIntents: known("searchIntents"), intelligenceRuns: known("intelligenceRuns"), baselines: known("baselines") };
    for (const d of t.decisions()) {
      assert.ok(d.evidence.length >= 1, `${d.decisionId} has evidence`);
      for (const e of d.evidence) assert.ok(cols[e.sourceRef.collection] && cols[e.sourceRef.collection].has(e.sourceRef.docId), `${d.decisionId}: ${e.sourceRef.collection}/${e.sourceRef.docId}`);
      if (d.scope === "intent") assert.ok(d.ownership && d.collision && d.newPageJustification && d.cluster, `${d.decisionId} intent explainability`);
      assert.ok(d.summary && d.summary.length > 5);
    }
  });

  // -------------------------------------------------------- integration M5->M6
  await test("integration: real M5 run, then M6 -> every active opportunity maps to exactly one active decision", async () => {
    const f = fixture();
    f.opportunities = [];
    const { fake, db } = await seedStore(f);
    await db.collection("opportunityRuns").doc("oppRun1").set({ businessId: BIZ, status: "failed" });
    const m5 = loadWithFake(fake, M5_STORE);
    await m5.runOpportunityEngine({ businessId: BIZ, nowMs: NOW });
    const m6 = loadWithFake(fake, STORE);
    const r = await m6.runDecisionEngine({ businessId: BIZ, nowMs: NOW + 1000 });
    assert.strictEqual(r.outcome, "DECISIONS");
    const opps = fake.rows("opportunities").filter((o) => o.source === "opportunity_engine" && o.engineState === "active");
    assert.ok(opps.length > 0);
    const decisions = fake.rows("decisions").filter((d) => d.engineState === "active");
    for (const o of opps) {
      const holders = decisions.filter((d) => d.opportunityIds.includes(o.id));
      assert.strictEqual(holders.length, 1, `${o.type} folded exactly once`);
      assert.strictEqual(o.decisionId, holders[0].id, "opportunities.decisionId links to its decision");
    }
    assert.ok(decisions.length <= fake.rows("searchIntents").length + new Set(opps.filter((o) => o.type === "technical_blocker" || o.type === "internal_linking").map((o) => o.targetPageKeys[0])).size + opps.filter((o) => o.type === "entity_clarity").length);
  });

  await test("M5 compatibility: an M5 re-run after M6 linked a decision preserves opportunities.decisionId", async () => {
    const f = fixture();
    f.opportunities = [];
    const { fake, db } = await seedStore(f);
    await db.collection("opportunityRuns").doc("oppRun1").set({ businessId: BIZ, status: "failed" });
    await loadWithFake(fake, M5_STORE).runOpportunityEngine({ businessId: BIZ, nowMs: NOW });
    await loadWithFake(fake, STORE).runDecisionEngine({ businessId: BIZ, nowMs: NOW + 1000 });
    const linked = fake.rows("opportunities").filter((o) => o.source === "opportunity_engine" && o.decisionId);
    assert.ok(linked.length > 0);
    await db.collection("seoPages").doc(`${BIZ}_architecture`).update({ lastCrawledAtMs: NOW + 5000 });
    const r5 = await loadWithFake(fake, M5_STORE).runOpportunityEngine({ businessId: BIZ, nowMs: NOW + 6000 });
    assert.strictEqual(r5.decision, "computed", "M5 recomputed (not a cache hit)");
    for (const o of linked) assert.strictEqual(fake.rows("opportunities").find((x) => x.id === o.id).decisionId, o.decisionId);
  });

  // ---------------------------------------------------------------- lifecycle
  await test("lifecycle: identical re-run is a cache hit with zero writes", async () => {
    const t = await setupStore();
    const r1 = await t.runM6();
    assert.strictEqual(r1.decision, "computed");
    const snap = () => JSON.stringify(["decisions", "searchIntents", "decisionRuns", "opportunities"].map((c) => t.fake.rows(c)));
    const before = snap();
    const r2 = await t.runM6(NOW + 60000);
    assert.strictEqual(r2.cacheHit, true);
    assert.strictEqual(r2.written, 0);
    assert.strictEqual(r2.providerCalled, false);
    assert.strictEqual(snap(), before);
  });

  // --------------------------------------------------- cache correctness
  // Each mutation keeps ids / titles / counts / timestamps constant and
  // changes only a decision-driving field. Every one must recompute.
  const CACHE_MUTATIONS = [
    ["topic query text (same id, title and count)", async (t) => t.db.collection("searchTopics").doc("tGap").update({ queries: ["שיפוץ דירות מחיר"] })],
    ["topic qualification reason", async (t) => t.db.collection("searchTopics").doc("tGap").update({ qualificationReasons: [{ code: "commercial_modifier", detail: "מחיר" }] })],
    ["topic seed ref", async (t) => t.db.collection("searchTopics").doc("tGap").update({ seedRefs: [{ serviceId: "svcInt", serviceName: "עיצוב פנים", components: [] }] })],
    ["topic preliminary intent", async (t) => t.db.collection("searchTopics").doc("tGap").update({ preliminaryIntent: "informational" })],
    ["topic-intelligence page queries", async (t) => {
      const ti = t.fake.rows("topicIntelligence").find((x) => x.topicId === "tBrand");
      const pages = ti.gscCurrent.pages.map((pg) => (pg.pageKey === keyOf("contact") ? { ...pg, queries: ["הגר לושי"] } : pg));
      await t.db.collection("topicIntelligence").doc(ti.id).update({ gscCurrent: { ...ti.gscCurrent, pages } });
    }],
    ["topic-intelligence market demand", async (t) => t.db.collection("topicIntelligence").doc(`${BIZ}_tGap`).update({ semrush: { status: "available", totalMonthlyVolume: 700 } })],
    ["topic-intelligence content match", async (t) => {
      const ti = t.fake.rows("topicIntelligence").find((x) => x.topicId === "tGap");
      await t.db.collection("topicIntelligence").doc(ti.id).update({ pages: { ...ti.pages, contentMatched: [{ url: urlOf("interior"), pageKey: keyOf("interior") }] } });
    }],
    ["page title", async (t) => t.db.collection("seoPages").doc(`${BIZ}_architecture`).update({ title: "אדריכלות ותכנון" })],
    ["page H1", async (t) => t.db.collection("seoPages").doc(`${BIZ}_architecture`).update({ h1: ["אדריכלות בקיסריה"] })],
    ["page H2", async (t) => t.db.collection("seoPages").doc(`${BIZ}_architecture`).update({ h2: ["קיסריה"] })],
    ["page role", async (t) => t.db.collection("seoPages").doc(`${BIZ}_architecture`).update({ role: { role: "article" } })],
    ["page canonical state", async (t) => t.db.collection("seoPages").doc(`${BIZ}_architecture`).update({ canonical: { state: "points_elsewhere", target: urlOf("") } })],
    ["page indexability", async (t) => t.db.collection("seoPages").doc(`${BIZ}_architecture`).update({ indexability: { state: "non_indexable", reasons: ["noindex"] } })],
    ["page robots", async (t) => t.db.collection("seoPages").doc(`${BIZ}_architecture`).update({ robots: { state: "blocked" } })],
    ["service alias", async (t) => t.db.collection("businessServices").doc("svcArch").update({ aliases: ["אדריכלית", "אדריכל"] })],
    ["service facet geography", async (t) => t.db.collection("businessServices").doc("svcArch").update({ facets: { services: [], geographies: [{ value: "חדרה", provenance: "owner" }], audiences: [] } })],
    ["business geographies", async (t) => t.db.collection("businesses").doc(BIZ).update({ geographicMarkets: ["קיסריה"] })],
    ["brand terminology", async (t) => t.db.collection("businessKnowledge").doc("k1").update({ content: "סטודיו הגר" })],
    ["opportunity owner status", async (t) => t.db.collection("opportunities").doc(t.f.opportunities[0].id).update({ status: "approved" })],
    ["opportunity confidence", async (t) => t.db.collection("opportunities").doc(t.f.opportunities[0].id).update({ confidence: "low" })],
    ["business decision policy", async (t) => t.db.collection("businesses").doc(BIZ).update({ decisionPolicy: { createBudgetPerRun: 0 } })]
  ];
  for (const [label, mutate] of CACHE_MUTATIONS) {
    await test(`cache correctness: changing ${label} recomputes (never a false cache hit)`, async () => {
      const t = await setupStore();
      const r1 = await t.runM6();
      assert.strictEqual(r1.decision, "computed");
      assert.strictEqual((await t.runM6(NOW + 1)).decision, "cache_hit", "unchanged input is a cache hit");
      await mutate(t);
      const r2 = await t.runM6(NOW + 2);
      assert.strictEqual(r2.decision, "computed", `${label} must change the fingerprint`);
      assert.notStrictEqual(r2.runId, r1.runId, "a different input gets a different run record");
    });
  }

  await test("cache correctness: an unrelated business field does not invalidate the cache", async () => {
    const t = await setupStore();
    await t.runM6();
    await t.db.collection("businesses").doc(BIZ).update({ lastSyncAtMs: NOW + 5, baselineDate: "2026-10-11" });
    assert.strictEqual((await t.runM6(NOW + 6)).decision, "cache_hit");
  });

  await test("cache correctness: edited or deleted engine output is repaired, never reported as unchanged", async () => {
    const t = await setupStore();
    await t.runM6();
    const id = `${BIZ}_intent_${BIZ}_tRank`;
    const before = t.decisions().find((d) => d.id === id);
    // simulate tampering / a lost write: the decision document disappears
    await t.db.collection("decisions").doc(id).delete();
    const r = await t.runM6(NOW + 1);
    assert.strictEqual(r.decision, "computed");
    assert.strictEqual(t.decisions().find((d) => d.id === id).decision, before.decision);
    // and an opportunity link that went missing is restored
    const oppId = t.f.opportunities[0].id;
    await t.db.collection("opportunities").doc(oppId).update({ decisionId: null });
    assert.strictEqual((await t.runM6(NOW + 2)).decision, "computed");
    assert.strictEqual(t.fake.rows("opportunities").find((o) => o.id === oppId).decisionId, id);
    assert.strictEqual((await t.runM6(NOW + 3)).decision, "cache_hit");
  });

  // ------------------------------------------------------------- concurrency
  await test("concurrency: two simultaneous runs -> one computes, the other is in_progress and writes nothing", async () => {
    const t = await setupStore();
    const [a, b] = await Promise.all([t.runM6(NOW), t.runM6(NOW)]);
    const outcomes = [a.decision, b.decision].sort();
    assert.deepStrictEqual(outcomes, ["computed", "in_progress"]);
    const loser = a.decision === "in_progress" ? a : b;
    assert.strictEqual(loser.written, 0);
    assert.strictEqual(t.fake.rows("decisionRuns").length, 1, "exactly one run record");
    assert.ok(t.decisions().every((d) => d.decisionHistory.length === 1), "no duplicated history");
    assert.strictEqual(t.fake.rows("decisionRunLocks").length, 0, "lock released");
    assert.strictEqual((await t.runM6(NOW + 1)).decision, "cache_hit");
  });

  await test("concurrency: a live lock held by another run -> in_progress, no writes", async () => {
    const t = await setupStore();
    await t.db.collection("decisionRunLocks").doc(BIZ).set({ businessId: BIZ, owner: "other", acquiredAtMs: NOW - 1000, leaseExpiresAtMs: NOW + 60000 });
    const r = await t.runM6();
    assert.strictEqual(r.decision, "in_progress");
    assert.strictEqual(t.decisions().length, 0);
    assert.strictEqual(t.fake.rows("decisionRuns").length, 0);
    assert.strictEqual(t.fake.rows("decisionRunLocks")[0].owner, "other", "someone else's lock is never released");
  });

  // ---------------------------------------------------- partial-write recovery
  await test("recovery: a write failure mid-way marks the run failed (never stuck running) and the next run repairs the state", async () => {
    const clean = await setupStore();
    await clean.runM6();
    const expected = clean.decisions().map((d) => [d.id, d.decision, d.engineState, d.decisionHistory.length]).sort();

    const t = await setupStore();
    // writes: 1 lock, 2 run "running", 3 chunk 1, 4 chunk 2 (fails), ...
    t.fake.failNthWrite(4);
    await assert.rejects(() => t.store.runDecisionEngine({ businessId: BIZ, nowMs: NOW, batchSize: 3 }), /UNAVAILABLE/);
    const failed = t.fake.rows("decisionRuns");
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].status, "failed");
    assert.strictEqual(failed[0].failedPhase, "write");
    assert.strictEqual(failed[0].chunksCommitted, 1);
    assert.ok(failed[0].totalOps > 3 && failed[0].recovery);
    assert.strictEqual(t.fake.rows("decisionRunLocks").length, 0, "lock released after the failure");
    assert.ok(t.decisions().length < expected.length, "state is partial after the failure");

    const r = await t.store.runDecisionEngine({ businessId: BIZ, nowMs: NOW + 1000, batchSize: 3 });
    assert.strictEqual(r.decision, "computed", "a failed run never yields a cache hit");
    assert.strictEqual(r.runId, failed[0].id, "same input -> same run record, retried");
    const run = t.fake.rows("decisionRuns").find((x) => x.id === r.runId);
    assert.strictEqual(run.status, "completed");
    assert.strictEqual(run.attempt, 2);
    assert.deepStrictEqual(t.decisions().map((d) => [d.id, d.decision, d.engineState, d.decisionHistory.length]).sort(), expected, "repaired to exactly the clean-run state, no duplicated history");
    assert.strictEqual((await t.runM6(NOW + 2000)).decision, "cache_hit");
  });

  await test("recovery: a crashed run (expired lease, run left running) is taken over and recorded as abandoned", async () => {
    const t = await setupStore();
    await t.db.collection("decisionRunLocks").doc(BIZ).set({ businessId: BIZ, owner: "crashed", acquiredAtMs: NOW - 600000, leaseExpiresAtMs: NOW - 300000 });
    await t.db.collection("decisionRuns").doc(`${BIZ}_run_stale`).set({ businessId: BIZ, status: "running", startedAtMs: NOW - 600000, inputHash: "old" });
    const r = await t.runM6();
    assert.strictEqual(r.decision, "computed");
    const stale = t.fake.rows("decisionRuns").find((x) => x.id === `${BIZ}_run_stale`);
    assert.strictEqual(stale.status, "abandoned");
    assert.strictEqual(stale.abandonedByRunId, r.runId);
    const run = t.fake.rows("decisionRuns").find((x) => x.id === r.runId);
    assert.strictEqual(run.tookOverLockFrom, "crashed");
    assert.strictEqual(t.fake.rows("decisionRunLocks").length, 0);
    assert.ok(!t.fake.rows("decisionRuns").some((x) => x.status === "running"), "no run is left running");
  });

  await test("lifecycle: owner rejection is durable; owner review never overwritten by an unchanged decision", async () => {
    const t = await setupStore();
    await t.runM6();
    const rankId = `${BIZ}_intent_${BIZ}_tRank`;
    const learnId = `${BIZ}_intent_${BIZ}_tLearn`;
    await t.db.collection("decisions").doc(rankId).update({ ownerStatus: "rejected", ownerNote: "not now" });
    await t.db.collection("decisions").doc(learnId).update({ ownerStatus: "accepted" });
    const r = await t.runM6(NOW + 1000);
    assert.strictEqual(r.decision, "computed", "owner review changes the cache identity");
    const byId = (id) => t.decisions().find((d) => d.id === id);
    assert.strictEqual(byId(rankId).ownerStatus, "rejected");
    assert.strictEqual(byId(rankId).ownerNote, "not now");
    assert.strictEqual(byId(learnId).ownerStatus, "accepted");
    assert.strictEqual(byId(rankId).decisionHistory.length, 1, "unchanged decision adds no history");
  });

  await test("lifecycle: a changed decision keeps history and resets an owner review to pending", async () => {
    const t = await setupStore();
    await t.runM6();
    const rankId = `${BIZ}_intent_${BIZ}_tRank`;
    await t.db.collection("decisions").doc(rankId).update({ ownerStatus: "accepted", ownerNote: "go" });
    // the owner rejects every opportunity on the intent -> decision becomes REJECT
    for (const o of t.fake.rows("opportunities").filter((x) => (x.targetTopicIds || []).includes("tRank"))) await t.db.collection("opportunities").doc(o.id).update({ status: "rejected" });
    await t.runM6(NOW + 2000);
    const d = t.decisions().find((x) => x.id === rankId);
    assert.strictEqual(d.decision, "REJECT");
    assert.strictEqual(d.previousDecision, "IMPROVE");
    assert.strictEqual(d.ownerStatus, "pending");
    assert.strictEqual(d.ownerStatusResetReason, "decision_changed_since_owner_review");
    assert.strictEqual(d.ownerNote, "go", "the owner's own note is never erased");
    assert.strictEqual(d.decisionHistory.length, 2);
    assert.strictEqual(d.decisionHistory[1].previousDecision, "IMPROVE");
    assert.strictEqual(d.decisionHistory[1].ownerStatusAtChange, "accepted");
  });

  await test("lifecycle: unapproved topic -> intent and decision superseded (kept, never deleted)", async () => {
    const t = await setupStore();
    await t.runM6();
    await t.db.collection("searchTopics").doc("tGap").update({ status: "exclude" });
    // M6 waits until M5 reflects the new approved set
    const stale = await t.runM6(NOW + 1000);
    assert.strictEqual(stale.outcome, "WAIT_FOR_DATA");
    const oppRun = t.fake.rows("opportunityRuns").find((x) => x.id === "oppRun1");
    await t.db.collection("opportunityRuns").doc("oppRun1").update({ inputHash: "m5hash2", topicEvaluations: oppRun.topicEvaluations.filter((e) => e.topicId !== "tGap") });
    for (const o of t.fake.rows("opportunities").filter((x) => (x.targetTopicIds || []).includes("tGap"))) await t.db.collection("opportunities").doc(o.id).update({ engineState: "resolved" });
    await t.runM6(NOW + 2000);
    const intent = t.fake.rows("searchIntents").find((i) => i.id === `${BIZ}_tGap`);
    assert.strictEqual(intent.status, "superseded");
    const d = t.decisions().find((x) => x.id === `${BIZ}_intent_${BIZ}_tGap`);
    assert.strictEqual(d.engineState, "superseded");
    assert.strictEqual(d.decision, "REJECT");
    assert.ok(d.reasonCodes.includes("TOPIC_NO_LONGER_APPROVED"));
    assert.strictEqual(d.decisionHistory[d.decisionHistory.length - 1].event, "superseded");
  });

  await test("lifecycle: regrouping supersedes the old intent with a subsumed_by dependency", async () => {
    const t = await setupStore((f) => {
      // tA shares observed queries with tRank -> one intent anchored on "tA"
      f.searchTopics.push(topic("tA", "אדריכלית קיסריה", { svc: "svcArch" }));
      f.topicIntel.push(intel("tA", "אדריכלית קיסריה", { gsc: [["architecture", 50, 2, 9, ["אדריכלית קיסריה"]]], svc: "svcArch" }));
      return f;
    });
    await t.runM6();
    const merged = t.fake.rows("searchIntents").find((i) => i.id === `${BIZ}_tA`);
    assert.deepStrictEqual(merged.topicIds, ["tA", "tRank"]);
    // the owner un-approves tA; M5 is refreshed; tRank now forms its own intent
    await t.db.collection("searchTopics").doc("tA").update({ status: "exclude" });
    const oppRun = t.fake.rows("opportunityRuns").find((x) => x.id === "oppRun1");
    await t.db.collection("opportunityRuns").doc("oppRun1").update({ inputHash: "m5hash3", topicEvaluations: oppRun.topicEvaluations.filter((e) => e.topicId !== "tA") });
    await t.runM6(NOW + 1000);
    const old = t.fake.rows("searchIntents").find((i) => i.id === `${BIZ}_tA`);
    assert.strictEqual(old.status, "superseded");
    assert.deepStrictEqual(old.supersededByIntentIds, [`${BIZ}_tRank`]);
    const d = t.decisions().find((x) => x.id === `${BIZ}_intent_${BIZ}_tA`);
    assert.strictEqual(d.engineState, "superseded");
    assert.deepStrictEqual(d.dependencies, [{ decisionId: `${BIZ}_intent_${BIZ}_tRank`, relation: "subsumed_by" }]);
    assert.ok(d.reasonCodes.includes("SUBSUMED_BY_DECISION"));
    assert.ok(t.decisions().some((x) => x.id === `${BIZ}_intent_${BIZ}_tRank` && x.engineState === "active"));
  });

  await test("lifecycle: Firestore read failure fails closed - nothing written", async () => {
    const t = await setupStore();
    t.fake.failNextQueries(1);
    await assert.rejects(() => t.runM6(), /UNAVAILABLE/);
    assert.strictEqual(t.decisions().length, 0);
    assert.strictEqual(t.fake.rows("searchIntents").length, 0);
    assert.strictEqual(t.fake.rows("decisionRuns").length, 0);
    assert.ok(t.fake.rows("opportunities").every((o) => !o.decisionId));
  });

  await test("lifecycle: no M5 run / stale M5 run -> WAIT_FOR_DATA, no decisions", async () => {
    const t = await setupStore();
    await t.db.collection("opportunityRuns").doc("oppRun1").update({ intelligenceRunId: "olderRun" });
    const r = await t.runM6();
    assert.strictEqual(r.outcome, "WAIT_FOR_DATA");
    assert.ok(/older than the latest/.test(r.reason));
    assert.strictEqual(t.decisions().length, 0);
  });

  // ----------------------------------------------------------------- boundary
  await test("boundary: provider-free modules; no tasks / pages / content / predictions; M3/M4 data untouched", async () => {
    for (const file of ["decisionRules.js", "decisionEngineStore.js", "decisionConfig.js", "decisionEngine.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      assert.ok(!/require\("\.\/(semrush|googleSearchConsole|webUtils|businessUnderstanding|apiLimits)"\)|googleapis|fetch\(|runGoverned|anthropic/i.test(src), file);
    }
    const t = await setupStore();
    const snap = (c) => JSON.stringify(t.fake.rows(c));
    const before = Object.fromEntries(["searchTopics", "topicIntelligence", "seoPages", "baselines", "intelligenceRuns", "businessServices", "businesses", "opportunityRuns"].map((c) => [c, snap(c)]));
    const oppsBefore = t.fake.rows("opportunities").map(({ decisionId, ...rest }) => rest);
    await t.runM6();
    for (const c of Object.keys(before)) assert.strictEqual(snap(c), before[c], `${c} unchanged`);
    assert.deepStrictEqual(t.fake.rows("opportunities").map(({ decisionId, ...rest }) => rest), oppsBefore, "only opportunities.decisionId changes");
    for (const c of ["tasks", "impactPredictions", "seoChangeEvents", "seoExperiments", "pages", "contentAssets", "apiUsage"]) assert.strictEqual(t.fake.rows(c).length, 0, c);
    assert.strictEqual(t.fake.rows("opportunities").find((o) => o.id === "manual1").decisionId, undefined, "manual opportunities untouched");
  });

  await test("determinism: identical input -> identical output, independent of input order", async () => {
    const f = fixture();
    const a = decide(pureInput(f));
    const shuffled = pureInput(JSON.parse(JSON.stringify(f)));
    for (const k of ["services", "searchTopics", "topicIntel", "seoPages", "opportunities"]) shuffled[k] = [...shuffled[k]].reverse();
    const b = decide(shuffled);
    assert.deepStrictEqual(a, b);
  });

  await test("wording: decision summaries and the החלטות UI never claim Google's canonical choice", async () => {
    for (const claim of ["Google selected this canonical", "Google considers these pages as duplicates", "duplicates in Google", "Google בחר בכתובת הזו", "הדפים כפולים בגוגל"]) assert.ok(FORBIDDEN.test(claim), `detector catches: ${claim}`);
    const r = run(fixture());
    for (const d of r.decisions) assert.ok(!FORBIDDEN.test(d.summary), d.summary);
    const ui = path.join(__dirname, "..", "..", "app", "src", "pages", "business", "BusinessDecisions.tsx");
    const src = fs.readFileSync(ui, "utf8");
    assert.ok(!FORBIDDEN.test(src), "UI wording");
    assert.ok(src.includes("לא החלטה של Google"), "CONSOLIDATE rows say it is our recommendation, not Google's decision");
    assert.ok(src.includes("לא יוצרת דף"), "CREATE rows say no page, URL or content is created");
  });

  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL"));
  if (failed.length) {
    console.error(`\n${failed.length} decision-engine test(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} decision-engine tests passed.`);
})();
