// GuyHadas Visibility OS - M4 Search Intelligence & Baseline core
// (docs/MASTER.md §28–29, §32–34, §38.5, §41 M4; docs/M4_IMPLEMENTATION_BRIEF.md).
//
//   APPROVED SEARCH UNIVERSE (M3.2, read-only)
//     + page inventory (own-site crawl, observed)
//     + GSC query x page (governed Google call, cached, fail closed)
//     + existing GA4 / GSC snapshots (no new GA4 call)
//   -> topicIntelligence (per approved topic), seoPages (per crawled page),
//      GEO readiness, project summary  -> intelligenceRuns (one per run)
//   -> baselines (immutable, versioned, on explicit owner request)
//
// Invariants:
//   - only topics with an approved owner status are analyzed; owner status
//     and searchTopics are never written;
//   - nothing is fabricated: unavailable inputs are recorded as
//     not_available with a reason;
//   - no tasks / opportunities / pages are created;
//   - baselines are create-only: a refresh is a NEW version.
//
// Free of firebase-functions so it runs under the index-enforcing test
// Firestore; the GSC adapter and the crawler are injectable.

const admin = require("firebase-admin");
const { runGoverned, hashInput } = require("./apiUsage");
const { crawlSite, fetchPage, pageKey, bareHost } = require("./webUtils");
const { parseRobotsTxt, analyzePage, buildInventory, pageDocId } = require("./pageInventory");
const { computeTopicIntelligence, isApproved, APPROVED_STATUSES, ANALYSIS_VERSION } = require("./topicIntelligence");
const { computeGeoReadiness } = require("./geoReadiness");

const INVENTORY_MAX_PAGES = 50;
const GSC_ROW_LIMIT = 1000;
const GSC_LAG_DAYS = 3;
const GSC_PERIOD_DAYS = 28;
const BASELINE_MAX_TOPICS = 200;
const BASELINE_MAX_PAGES = 100;

function toMs(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts === "number") return ts;
  return null;
}

function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Final GSC data lags ~2-3 days; a fixed 28-day window ending 3 days ago is
// stable for a whole day, which keeps the cache identity stable too.
function analysisPeriod(nowMs) {
  const end = nowMs - GSC_LAG_DAYS * 86400000;
  const start = end - (GSC_PERIOD_DAYS - 1) * 86400000;
  return { startDate: ymd(start), endDate: ymd(end) };
}

function latestBy(rows, field) {
  return rows.slice().sort((a, b) => (toMs(b[field]) || 0) - (toMs(a[field]) || 0))[0] || null;
}

async function loadInputs(businessId) {
  const db = admin.firestore();
  const byBiz = (c) => db.collection(c).where("businessId", "==", businessId).get();
  const [bizDoc, topicsSnap, kwSnap, svcSnap, searchSnap, trafficSnap, gscInteg] = await Promise.all([
    db.collection("businesses").doc(businessId).get(),
    byBiz("searchTopics"),
    byBiz("keywords"),
    byBiz("businessServices"),
    byBiz("searchSnapshots"),
    byBiz("trafficSnapshots"),
    db.collection("integrations").doc(`${businessId}_search_console`).get()
  ]);
  const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return {
    business: bizDoc.exists ? { id: businessId, ...bizDoc.data() } : { id: businessId },
    topics: rows(topicsSnap),
    keywords: rows(kwSnap),
    services: rows(svcSnap),
    latestSearchSnapshot: latestBy(rows(searchSnap), "retrievedAt"),
    latestTrafficSnapshot: latestBy(rows(trafficSnap), "retrievedAt"),
    gscIntegration: gscInteg.exists ? gscInteg.data() : null
  };
}

async function readRobots(origin, fetcher) {
  if (!origin) return { available: false, reason: "site could not be fetched", groups: [] };
  const r = await fetcher(`${origin}/robots.txt`);
  if (r.ok) return { available: true, groups: parseRobotsTxt(r.html), url: `${origin}/robots.txt` };
  if (r.status === 404) return { available: true, groups: [], url: `${origin}/robots.txt`, note: "no robots.txt (404) - everything crawlable" };
  return { available: false, reason: `robots.txt: ${r.error}`, groups: [] };
}

// Own-site crawl -> page inventory (observed only).
async function buildPageInventory(business, services, deps) {
  if (!business.website) {
    return { status: "not_available", reason: "business has no website in its profile", pages: [], analyzed: [], report: null, robots: null };
  }
  const crawl = await (deps.crawlSite || crawlSite)(business.website, deps.cheerio, deps.maxPages || INVENTORY_MAX_PAGES);
  const robots = await readRobots(crawl.origin, deps.fetchPage || fetchPage);
  const siteHost = crawl.report && crawl.report.siteHost;
  const isSameSite = (u) => {
    try {
      return bareHost(new URL(u).hostname) === siteHost;
    } catch (err) {
      return false;
    }
  };
  const ctx = { isSameSite, robots, sitemapRead: crawl.sitemapRead === true, sitemapKeys: new Set(crawl.sitemapPageKeys || []) };
  const analyzed = [];
  const parseFailed = [];
  for (const fetched of crawl.pages) {
    try {
      analyzed.push(analyzePage(fetched, deps.cheerio, ctx));
    } catch (err) {
      parseFailed.push({ url: fetched.url, reason: `parse error: ${err.message}` });
    }
  }
  const pages = buildInventory(analyzed, { serviceNames: services.filter((s) => s.ownerStatus === "confirmed").map((s) => s.name) });
  return {
    status: crawl.pages.length ? "available" : "not_available",
    reason: crawl.pages.length ? null : "no page could be fetched",
    pages,
    analyzed,
    robots: { available: robots.available, reason: robots.reason || null, note: robots.note || null, url: robots.url || null },
    report: {
      ...crawl.report,
      failed: [...(crawl.report ? crawl.report.failed : []), ...parseFailed],
      pagesAnalyzed: pages.length,
      sitemapRead: crawl.sitemapRead === true
    }
  };
}

// Governed GSC query x page call.
async function fetchGscQueryPage({ businessId, integration, period, forceRefresh, adapter }) {
  if (!integration || integration.status !== "connected" || !integration.propertyId) {
    return { status: "not_available", reason: "Search Console is not connected for this business", rows: [], decision: null, providerCalled: false };
  }
  const input = { siteUrl: integration.propertyId, startDate: period.startDate, endDate: period.endDate, dimensions: ["query", "page"], rowLimit: GSC_ROW_LIMIT, dataState: "final" };
  let governed;
  try {
    governed = await runGoverned({
      provider: "google",
      operation: "searchConsoleQueryPage",
      businessId,
      input,
      model: null,
      analysisVersion: ANALYSIS_VERSION,
      forceRefresh: forceRefresh === true,
      reason: forceRefresh === true ? "owner_confirmed_fresh_gsc_query_page" : "owner_requested_search_intelligence",
      execute: async (inp) => {
        const rows = await adapter.fetchQueryPageRows(inp.siteUrl, inp);
        return { result: { rows }, usage: { recordsRequested: inp.rowLimit, recordsReturned: rows.length, actualCostUsd: 0 } };
      }
    });
  } catch (err) {
    return { status: "not_available", reason: `Search Console request failed: ${err.message}`, rows: [], decision: err.decision || null, providerCalled: err.providerCalled === true };
  }
  if (!governed.ok) {
    return { status: "not_available", reason: governed.blocked.message, blockedReason: governed.blocked.reason, rows: [], decision: governed.decision, providerCalled: false };
  }
  const rows = (governed.result && governed.result.rows) || [];
  return {
    status: "available",
    rows,
    period,
    decision: governed.decision,
    cacheHit: governed.cacheHit,
    providerCalled: governed.providerCalled,
    possiblyTruncated: rows.length >= GSC_ROW_LIMIT,
    retrievedAtMs: Date.now()
  };
}

function businessContext(inputs) {
  const s = inputs.latestSearchSnapshot;
  const t = inputs.latestTrafficSnapshot;
  const organic = t && t.data && (t.data.byChannel || []).find((c) => /organic search/i.test(c.channel));
  return {
    searchConsole: s
      ? { status: "available", basis: "observed", source: "searchSnapshots (existing daily sync)", period: s.dateRange || null, retrievedAtMs: toMs(s.retrievedAt), clicks: s.data.clicks, impressions: s.data.impressions, ctr: s.data.ctr, avgPosition: s.data.avgPosition }
      : { status: "not_available", reason: "no Search Console snapshot yet" },
    traffic: t
      ? { status: "available", basis: "observed", source: "trafficSnapshots (existing daily sync)", period: t.dateRange || null, retrievedAtMs: toMs(t.retrievedAt), sessions: t.data.sessions, organicSessions: organic ? organic.sessions : null, conversions: t.data.conversions, engagementRate: t.data.engagementRate }
      : { status: "not_available", reason: "no GA4 snapshot yet" },
    pageLevelTraffic: { status: "not_available", reason: "needs a governed GA4 landing-page report - deferred (no new GA4 call in M4)" }
  };
}

// The whole M4 analysis. Writes seoPages, topicIntelligence, intelligenceRuns.
async function runSearchIntelligence({ businessId, forceRefresh = false, deps }) {
  const db = admin.firestore();
  const nowMs = deps.nowMs || Date.now();
  const inputs = await loadInputs(businessId);
  const approved = inputs.topics.filter(isApproved);
  const statusCounts = {};
  for (const t of inputs.topics) statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;

  const inventory = await buildPageInventory(inputs.business, inputs.services, deps);
  const period = analysisPeriod(nowMs);
  const gsc = await fetchGscQueryPage({ businessId, integration: inputs.gscIntegration, period, forceRefresh, adapter: deps.gscAdapter });

  const pagesByKey = new Map(inventory.pages.map((p) => [p.pageKey, p]));
  const pageTexts = new Map(inventory.analyzed.map((p) => [p.pageKey, p._text]));
  const keywordsByTopic = new Map();
  for (const k of inputs.keywords) {
    if (!k.topicId) continue;
    if (!keywordsByTopic.has(k.topicId)) keywordsByTopic.set(k.topicId, []);
    keywordsByTopic.get(k.topicId).push(k);
  }
  const gscStatus = gsc.status === "available" ? { status: "available", period, retrievedAtMs: gsc.retrievedAtMs } : { status: "not_available", reason: gsc.reason };
  const intelligence = approved
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((topic) => computeTopicIntelligence({ topic, keywords: keywordsByTopic.get(topic.id) || [], gscRows: gsc.rows, gscStatus, pagesByKey, pageTexts, services: inputs.services, nowMs }));
  const geo = computeGeoReadiness(inventory.analyzed, { business: inputs.business, services: inputs.services });

  const runRef = await db.collection("intelligenceRuns").add({ businessId, status: "running", startedAtMs: nowMs, analysisVersion: ANALYSIS_VERSION });
  const runId = runRef.id;
  const now = admin.firestore.FieldValue.serverTimestamp();

  // seoPages: one doc per crawled page (latest observed state). Pages known
  // from earlier runs but not fetched now keep their last observation and
  // are marked as such - never silently presented as current.
  const existingPages = await db.collection("seoPages").where("businessId", "==", businessId).get();
  const seen = new Set();
  for (const p of inventory.pages) {
    const id = pageDocId(businessId, p.pageKey);
    seen.add(id);
    await db.collection("seoPages").doc(id).set({ businessId, ...p, crawlStatus: "fetched", observedInRunId: runId, lastCrawledAtMs: nowMs, lastCrawledAt: now });
  }
  const failedKeys = new Map(((inventory.report && inventory.report.failed) || []).map((f) => [pageKey(f.url), f.reason]));
  for (const d of existingPages.docs) {
    if (seen.has(d.id)) continue;
    const reason = failedKeys.get(d.data().pageKey);
    await db.collection("seoPages").doc(d.id).update({ crawlStatus: reason ? "failed_last_run" : "not_crawled_last_run", lastRunReason: reason || "not selected or not reachable in the last crawl", lastRunId: runId });
  }

  // topicIntelligence: latest per approved topic; topics no longer approved
  // are marked superseded (not deleted).
  const existingTi = await db.collection("topicIntelligence").where("businessId", "==", businessId).get();
  const approvedIds = new Set(approved.map((t) => t.id));
  for (const ti of intelligence) {
    await db.collection("topicIntelligence").doc(`${businessId}_${ti.topicId}`).set({ ...ti, runId, computedAtMs: nowMs, computedAt: now, superseded: false });
  }
  for (const d of existingTi.docs) {
    if (!approvedIds.has(d.data().topicId) && d.data().superseded !== true) {
      await db.collection("topicIntelligence").doc(d.id).update({ superseded: true, supersededByRunId: runId });
    }
  }

  const diagCounts = {};
  for (const p of inventory.pages) for (const d of p.diagnostics) diagCounts[d.code] = (diagCounts[d.code] || 0) + 1;
  const count = (fn) => inventory.pages.filter(fn).length;
  const summary = {
    approvedTopics: approved.length,
    topicsWithGscVisibility: intelligence.filter((t) => t.gscCurrent.status === "available").length,
    topicsWithSemrushDemand: intelligence.filter((t) => t.semrush.status === "available").length,
    topicsWithAssociatedPage: intelligence.filter((t) => t.pages.observed.length || t.pages.contentMatched.length).length,
    pagesAnalyzed: inventory.pages.length,
    pagesIndexable: count((p) => p.indexability.state === "indexable"),
    pagesNonIndexable: count((p) => p.indexability.state === "non_indexable"),
    pagesWithStructuredData: count((p) => p.structuredData.state === "present"),
    pagesInSitemap: count((p) => p.sitemap.state === "present"),
    diagnostics: diagCounts,
    geoReadiness: geo.summary
  };
  const run = {
    businessId,
    status: "completed",
    analysisVersion: ANALYSIS_VERSION,
    startedAtMs: nowMs,
    completedAtMs: Date.now(),
    completedAt: now,
    inputs: { approvedStatuses: APPROVED_STATUSES, approvedTopicIds: approved.map((t) => t.id), topicStatusCounts: statusCounts },
    crawl: { status: inventory.status, reason: inventory.reason || null, report: inventory.report, robots: inventory.robots },
    gsc: { status: gsc.status, reason: gsc.reason || null, blockedReason: gsc.blockedReason || null, decision: gsc.decision, cacheHit: !!gsc.cacheHit, providerCalled: !!gsc.providerCalled, period, rowsReturned: gsc.rows.length, possiblyTruncated: !!gsc.possiblyTruncated },
    businessContext: businessContext(inputs),
    geoReadiness: geo,
    semrush: { status: "not_available", reason: "Semrush live discovery deferred; no Semrush call made by M4" },
    serpContext: { status: "not_available", reason: "no SERP data provider configured" },
    summary
  };
  await db.collection("intelligenceRuns").doc(runId).set(run);
  return { runId, ...run };
}

// --- immutable baselines ----------------------------------------------------

async function createOnce(ref, data) {
  if (typeof ref.create === "function") return ref.create(data); // Admin SDK: fails if it exists
  const existing = await ref.get();
  if (existing.exists) throw new Error("ALREADY_EXISTS: baseline version already exists - baselines are immutable");
  return ref.set(data);
}

function pageBaseline(p) {
  return {
    url: p.url,
    pageKey: p.pageKey,
    crawlStatus: p.crawlStatus || "fetched",
    observedAtMs: p.lastCrawledAtMs || null,
    title: p.title || null,
    h1: (p.h1 || []).slice(0, 3),
    wordCount: p.wordCount ?? null,
    indexability: p.indexability ? p.indexability.state : "unknown",
    canonical: p.canonical ? p.canonical.state : "unknown",
    robots: p.robots ? p.robots.state : "unknown",
    sitemap: p.sitemap ? p.sitemap.state : "unknown",
    structuredData: p.structuredData ? p.structuredData.state : "unknown",
    inboundInternalCount: p.links ? p.links.inboundInternalCount : null,
    outboundInternalCount: p.links ? p.links.outboundInternalCount : null,
    orphan: p.orphan ? p.orphan.state : "unknown",
    diagnostics: (p.diagnostics || []).map((d) => d.code),
    // additive (M7 crawl verification of recorded changes); older baselines
    // simply lack these fields
    h2: (p.h2 || []).slice(0, 10),
    finalUrl: p.finalUrl || null,
    canonicalTarget: p.canonical ? p.canonical.target || null : null,
    structuredDataTypes: p.structuredData && Array.isArray(p.structuredData.types) ? [...p.structuredData.types].sort() : []
  };
}

function topicBaseline(t) {
  const g = t.gscCurrent || {};
  return {
    topicId: t.topicId,
    title: t.title,
    ownerStatus: t.ownerStatus,
    queryCount: t.queryCount,
    queries: (t.queries || []).slice(0, 50),
    sources: Object.keys(t.sourceMix || {}).sort(),
    gscCurrent:
      g.status === "available"
        ? { status: "available", period: g.period, impressions: g.impressions, clicks: g.clicks, ctr: g.ctr, avgPosition: g.avgPosition, queriesWithImpressions: g.queriesWithImpressions, rankingDistribution: g.rankingDistribution, pages: (g.pages || []).map((p) => ({ url: p.url, pageKey: p.pageKey, impressions: p.impressions, clicks: p.clicks, position: p.position })) }
        : { status: g.status || "not_available", reason: g.reason || g.note || null },
    semrush: t.semrush && t.semrush.status === "available" ? { status: "available", totalMonthlyVolume: t.semrush.totalMonthlyVolume, maxDifficulty: t.semrush.maxDifficulty } : { status: "not_available" },
    contentMatchedPages: ((t.pages && t.pages.contentMatched) || []).map((p) => p.pageKey),
    sourceConfidence: t.sourceConfidence
  };
}

// Pages / topics that MUST be in a baseline regardless of the cap (backlog
// #39): every page and topic referenced by an owner-accepted active decision
// or an open M7 experiment - they are the before-snapshots M7 links to.
function referencedKeys(decisions, intents, experiments) {
  const pageKeys = new Set();
  const topicIds = new Set();
  const intentTopics = new Map(intents.map((i) => [i.id, i.topicIds || []]));
  for (const d of decisions) {
    if (d.ownerStatus !== "accepted" || d.engineState === "superseded") continue;
    const rp = d.recommendedPage || {};
    if (rp.pageKey) pageKeys.add(rp.pageKey);
    if (d.pageKey) pageKeys.add(d.pageKey);
    for (const k of (d.consolidation && d.consolidation.otherPageKeys) || []) pageKeys.add(k);
    for (const t of intentTopics.get(d.intentId) || []) topicIds.add(t);
  }
  for (const x of experiments) {
    if (x.status !== "open") continue;
    if (x.unit && x.unit.pageKey && x.unit.pageKey !== "site") pageKeys.add(x.unit.pageKey);
    for (const k of x.affectedPageKeys || []) pageKeys.add(k);
    for (const i of x.intentIds || []) for (const t of intentTopics.get(i) || []) topicIds.add(t);
  }
  return { pageKeys, topicIds };
}

// Required items first (all of them), then the rest in key order up to the
// cap. The cap itself is unchanged - it only stops limiting what M7 needs.
function selectWithPriority(items, keyOf, required, cap) {
  const sorted = items.slice().sort((a, b) => String(keyOf(a)).localeCompare(String(keyOf(b))));
  const req = sorted.filter((x) => required.has(keyOf(x)));
  const rest = sorted.filter((x) => !required.has(keyOf(x))).slice(0, Math.max(0, cap - req.length));
  const chosen = new Set([...req, ...rest]);
  return { list: sorted.filter((x) => chosen.has(x)), required: req.length, truncated: sorted.length - chosen.size };
}

// Captures an immutable baseline: version n+1, never an update. Whatever is
// unavailable is recorded as such. Returns the baseline doc.
async function captureBaseline({ businessId, capturedBy, note, nowMs = Date.now(), includePageKeys = [], includeTopicIds = [] }) {
  const db = admin.firestore();
  const byBiz = (c) => db.collection(c).where("businessId", "==", businessId).get();
  const [runsSnap, tiSnap, pagesSnap, prevSnap, searchSnap, trafficSnap, decSnap, intentSnap, expSnap] = await Promise.all([
    byBiz("intelligenceRuns"),
    byBiz("topicIntelligence"),
    byBiz("seoPages"),
    byBiz("baselines"),
    byBiz("searchSnapshots"),
    byBiz("trafficSnapshots"),
    byBiz("decisions"),
    byBiz("searchIntents"),
    byBiz("seoExperiments")
  ]);
  const rows = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
  const run = rows(runsSnap)
    .filter((r) => r.status === "completed")
    .sort((a, b) => (b.completedAtMs || 0) - (a.completedAtMs || 0))[0] || null;
  const topics = rows(tiSnap).filter((t) => !t.superseded && (!run || t.runId === run.id));
  const pages = rows(pagesSnap).filter((p) => p.crawlStatus === "fetched");
  const previous = rows(prevSnap).sort((a, b) => b.version - a.version)[0] || null;
  const version = previous ? previous.version + 1 : 1;
  const ctx = businessContext({ latestSearchSnapshot: latestBy(rows(searchSnap), "retrievedAt"), latestTrafficSnapshot: latestBy(rows(trafficSnap), "retrievedAt") });
  const refs = referencedKeys(rows(decSnap), rows(intentSnap), rows(expSnap));
  for (const k of includePageKeys) refs.pageKeys.add(k);
  for (const t of includeTopicIds) refs.topicIds.add(t);
  const topicSel = selectWithPriority(topics, (t) => t.topicId, refs.topicIds, BASELINE_MAX_TOPICS);
  const pageSel = selectWithPriority(pages, (p) => p.pageKey, refs.pageKeys, BASELINE_MAX_PAGES);

  const content = {
    businessId,
    scope: "business",
    sourceRunId: run ? run.id : null,
    analysisVersion: run ? run.analysisVersion : null,
    period: { gscQueryPage: run && run.gsc ? run.gsc.period : null, searchConsoleSnapshot: ctx.searchConsole.period || null, traffic: ctx.traffic.period || null },
    business: ctx,
    topics: topicSel.list.map(topicBaseline),
    pages: pageSel.list.map(pageBaseline),
    selection: {
      rule: "pages/topics referenced by accepted decisions and open experiments first (never cut), then key order up to the cap",
      pageCap: BASELINE_MAX_PAGES,
      topicCap: BASELINE_MAX_TOPICS,
      requiredPages: pageSel.required,
      requiredTopics: topicSel.required,
      pagesNotIncluded: pageSel.truncated,
      topicsNotIncluded: topicSel.truncated
    },
    technicalSummary: run ? run.summary : null,
    geoReadiness: run ? { summary: run.geoReadiness.summary, signals: run.geoReadiness.signals.map((s) => ({ key: s.key, status: s.status, observation: s.observation })) } : null,
    serpContext: { status: "not_available", reason: "no SERP data provider configured" },
    availability: {
      intelligenceRun: run ? "available" : "not_available",
      gscQueryPage: run && run.gsc ? run.gsc.status : "not_available",
      searchConsoleSnapshot: ctx.searchConsole.status,
      traffic: ctx.traffic.status,
      pageLevelTraffic: "not_available",
      semrush: "not_available",
      serp: "not_available"
    }
  };
  const contentHash = hashInput(content);
  const baselineId = `${businessId}_v${version}`;
  const doc = {
    ...content,
    baselineId,
    version,
    immutable: true,
    contentHash,
    previousBaselineId: previous ? previous.baselineId || previous.id : null,
    identicalToPrevious: previous ? previous.contentHash === contentHash : false,
    capturedAtMs: nowMs,
    capturedAt: admin.firestore.FieldValue.serverTimestamp(),
    capturedBy: capturedBy || null,
    note: note || null,
    // For future references (ImpactPrediction.baseline_snapshot_id,
    // SEOChangeEvent.before_snapshot_id): baselineId + targetType
    // ("business" | "topic" | "page") + targetId (topicId | pageKey).
    referenceKeys: { topicIds: content.topics.map((t) => t.topicId), pageKeys: content.pages.map((p) => p.pageKey) }
  };
  await createOnce(db.collection("baselines").doc(baselineId), doc);
  // One baseline concept: the M2 charts' baselineDate now points at the
  // latest immutable baseline (it is a pointer, the snapshot is the truth).
  await db.collection("businesses").doc(businessId).update({ baselineDate: ymd(nowMs), latestBaselineId: baselineId });
  return doc;
}

module.exports = {
  runSearchIntelligence,
  captureBaseline,
  buildPageInventory,
  fetchGscQueryPage,
  analysisPeriod,
  loadInputs,
  createOnce,
  INVENTORY_MAX_PAGES
};

