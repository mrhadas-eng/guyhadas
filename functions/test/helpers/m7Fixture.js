// Shared M3-M6 fixture for the M7 tests: the same Hagar-like scenario the
// M6 suite uses (functions/test/decisionEngine.test.js), seeded into the
// index-enforcing fake Firestore, plus helpers to run M6 and M7 stores.
const path = require("path");
const { createFakeFirestore, loadWithFake } = require("./fakeFirestore");
const cfg = require("../../decisionConfig");
const DECISION_STORE = path.join(__dirname, "..", "..", "decisionEngineStore.js");
const TRACKING_STORE = path.join(__dirname, "..", "..", "trackingStore.js");
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



module.exports = { BIZ, O, HOST, NOW, PERIOD, keyOf, urlOf, page, service, topic, intel, opp, fixture, seedStore, DECISION_STORE, TRACKING_STORE, loadWithFake, createFakeFirestore, cfg };
