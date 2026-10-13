// GuyHadas Visibility OS - M4 Search Topic intelligence
// (docs/MASTER.md §16 Search Topic, §22 Evidence & Confidence, §28.1/28.3,
// §33 Provider Independence, §41 M4).
//
// Pure, deterministic aggregation for ONE approved Search Topic over its
// raw queries and the normalized observations M4 has:
//   - gscCurrent   : GSC query×page rows for the analysis period (governed
//                    call) - "what the site already appears for, and where"
//   - gscDiscovery : per-query GSC metrics stored on keywords by M3.2
//                    discovery (90-day window) - kept SEPARATE
//   - semrush      : external market demand stored on keywords - SEPARATE;
//                    "not_available" when there is none
//   - pages        : observed (GSC) pages, plus content-matched crawled pages
//                    labelled as INFERENCE
//
// No score, no opportunity, no ownership. Every block says what it is based
// on (basis: observed | inferred) and what is missing.

const { normalizePhrase } = require("./seedBuilder");
const { pageKey } = require("./webUtils");

const ANALYSIS_VERSION = 1;
const APPROVED_STATUSES = ["relevant", "priority", "brand_strategic"];
const EMERGENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function isApproved(topic) {
  return APPROVED_STATUSES.includes(topic && topic.status);
}

function toMs(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts === "number") return ts;
  if (ts instanceof Date) return ts.getTime();
  return null;
}

function round(n, d = 2) {
  return n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d;
}

function bucket(position) {
  if (position == null) return null;
  if (position <= 3) return "1-3";
  if (position <= 10) return "4-10";
  if (position <= 20) return "11-20";
  if (position <= 50) return "21-50";
  return "51+";
}

function emptyDistribution() {
  return { "1-3": 0, "4-10": 0, "11-20": 0, "21-50": 0, "51+": 0 };
}

// gscRows: [{ query, page, clicks, impressions, position }]
// gscStatus: { status: "available" | "not_available", reason?, period?, retrievedAtMs? }
// pagesByKey: Map(pageKey -> inventory page) from this run's crawl
// pageTexts: Map(pageKey -> lowercase text) for content matching
function computeTopicIntelligence({ topic, keywords, gscRows, gscStatus, pagesByKey, pageTexts, services, nowMs }) {
  const missing = [];
  const queries = [...new Set([...(topic.queries || []), ...keywords.map((k) => k.query)])];
  const norm = new Set(queries.map(normalizePhrase));
  const activeKeywords = keywords.filter((k) => !k.excludedByRule);

  // ---- sources ---------------------------------------------------------
  const sourceMix = {};
  for (const k of activeKeywords) {
    const list = k.sourceList && k.sourceList.length ? k.sourceList : k.source ? [k.source] : [];
    for (const s of list) sourceMix[s] = (sourceMix[s] || 0) + 1;
  }

  // ---- GSC current (query x page, governed) -----------------------------
  let gscCurrent;
  if (gscStatus.status !== "available") {
    gscCurrent = { status: "not_available", reason: gscStatus.reason, basis: "observed" };
    missing.push("gsc_current_not_available");
  } else {
    const rows = (gscRows || []).filter((r) => norm.has(normalizePhrase(r.query)));
    if (rows.length === 0) {
      gscCurrent = { status: "no_observation", period: gscStatus.period, basis: "observed", note: "no GSC impressions for this topic's queries in the period" };
      missing.push("no_gsc_observation_for_topic");
    } else {
      let impressions = 0;
      let clicks = 0;
      let posWeighted = 0;
      const perQuery = new Map();
      const perPage = new Map();
      for (const r of rows) {
        impressions += r.impressions || 0;
        clicks += r.clicks || 0;
        posWeighted += (r.position || 0) * (r.impressions || 0);
        const q = perQuery.get(r.query) || { query: r.query, impressions: 0, clicks: 0, posW: 0, pages: new Set() };
        q.impressions += r.impressions || 0;
        q.clicks += r.clicks || 0;
        q.posW += (r.position || 0) * (r.impressions || 0);
        q.pages.add(r.page);
        perQuery.set(r.query, q);
        const key = pageKey(r.page);
        const p = perPage.get(key) || { url: r.page, pageKey: key, impressions: 0, clicks: 0, posW: 0, queries: new Set() };
        p.impressions += r.impressions || 0;
        p.clicks += r.clicks || 0;
        p.posW += (r.position || 0) * (r.impressions || 0);
        p.queries.add(r.query);
        perPage.set(key, p);
      }
      const distribution = emptyDistribution();
      const queryRows = [...perQuery.values()]
        .map((q) => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, ctr: round(q.impressions ? q.clicks / q.impressions : 0, 4), position: round(q.impressions ? q.posW / q.impressions : null, 1), pageCount: q.pages.size }))
        .sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));
      for (const q of queryRows) if (q.position != null) distribution[bucket(q.position)]++;
      const pages = [...perPage.values()]
        .map((p) => ({
          url: p.url,
          pageKey: p.pageKey,
          impressions: p.impressions,
          clicks: p.clicks,
          position: round(p.impressions ? p.posW / p.impressions : null, 1),
          queries: [...p.queries].sort(),
          crawled: pagesByKey.has(p.pageKey),
          basis: "observed"
        }))
        .sort((a, b) => b.impressions - a.impressions || a.url.localeCompare(b.url));
      gscCurrent = {
        status: "available",
        basis: "observed",
        period: gscStatus.period,
        retrievedAtMs: gscStatus.retrievedAtMs || null,
        impressions,
        clicks,
        ctr: round(impressions ? clicks / impressions : 0, 4),
        avgPosition: round(impressions ? posWeighted / impressions : null, 1),
        queriesWithImpressions: queryRows.length,
        rankingDistribution: distribution,
        queries: queryRows.slice(0, 50),
        pages,
        // Observed fact, not a cannibalization verdict (that is M6).
        multiplePagesObserved: pages.length > 1
      };
    }
  }

  // ---- GSC discovery (90-day, per query, from M3.2) ---------------------
  const disc = activeKeywords.map((k) => (k.sources && k.sources.gsc && k.sources.gsc.metrics) || (k.source === "gsc" ? k.metrics : null)).filter(Boolean);
  const gscDiscovery = disc.length
    ? {
        status: "available",
        basis: "observed",
        window: "90 days (M3.2 discovery)",
        queriesObserved: disc.length,
        impressions: disc.reduce((s, m) => s + (m.impressions || 0), 0),
        clicks: disc.reduce((s, m) => s + (m.clicks || 0), 0)
      }
    : { status: "not_available", reason: "no GSC discovery evidence on this topic's queries" };

  // ---- Semrush market demand (separate evidence) -----------------------
  // Compatibility mapping (Semrush V4 pilot): a provider-neutral
  // keywords.marketDemand estimate (functions/keywordMetricsStore.js) is read
  // as the same per-query { volume, difficulty } evidence as V3 discovery and
  // takes precedence over it for that query (it is explicit and more recent).
  // The block keeps its name and meaning (external market demand); M5 scoring
  // is unchanged. Search Console evidence is never mixed in here.
  const demandOf = (k) => {
    const md = k.marketDemand;
    if (md && md.source && md.searchVolume != null) return { volume: md.searchVolume, difficulty: md.keywordDifficulty ?? null, v4: { query: k.query, source: md.source, country: md.country, month: md.month, retrievedAt: md.retrievedAt } };
    return (k.sources && k.sources.semrush) || (k.source === "semrush" ? { volume: k.volume, difficulty: k.difficulty } : null);
  };
  const sem = activeKeywords.map((k) => ({ q: k.query, e: demandOf(k) })).filter((x) => x.e && x.e.volume != null);
  const v4Provenance = sem.filter((x) => x.e.v4).map((x) => x.e.v4);
  const semrush = sem.length
    ? {
        status: "available",
        basis: "observed",
        provider: "semrush",
        queriesWithVolume: sem.length,
        totalMonthlyVolume: sem.reduce((s, x) => s + (Number(x.e.volume) || 0), 0),
        maxDifficulty: sem.some((x) => x.e.difficulty != null) ? Math.max(...sem.filter((x) => x.e.difficulty != null).map((x) => Number(x.e.difficulty))) : null,
        note: "sum of per-query monthly volumes; queries may overlap in intent",
        // only present when V4 enrichment contributed (keeps every other topic's output byte-identical)
        ...(v4Provenance.length ? { demandProvenance: v4Provenance } : {})
      }
    : { status: "not_available", reason: "no Semrush evidence (Semrush live discovery deferred)" };
  if (semrush.status !== "available") missing.push("semrush_demand_not_available");

  // ---- associated pages ------------------------------------------------
  const titleNorm = normalizePhrase(topic.title);
  const contentMatched = [];
  if (titleNorm.length > 1) {
    for (const [key, text] of pageTexts) {
      if (` ${normalizePhrase(text)} `.includes(` ${titleNorm} `)) {
        const p = pagesByKey.get(key);
        contentMatched.push({ url: p ? p.url : key, pageKey: key, basis: "inferred", rule: "topic title appears in page title/headings/text" });
      }
    }
  }
  contentMatched.sort((a, b) => a.url.localeCompare(b.url));
  const observedPages = gscCurrent.status === "available" ? gscCurrent.pages : [];
  if (observedPages.length === 0 && contentMatched.length === 0) missing.push("no_associated_page");

  // Technical context for associated, crawled pages (observed state).
  const associatedKeys = [...new Set([...observedPages.map((p) => p.pageKey), ...contentMatched.map((p) => p.pageKey)])];
  const technical = associatedKeys
    .filter((k) => pagesByKey.has(k))
    .map((k) => {
      const p = pagesByKey.get(k);
      return { pageKey: k, url: p.url, indexability: p.indexability.state, canonical: p.canonical.state, sitemap: p.sitemap.state, structuredData: p.structuredData.state, diagnostics: p.diagnostics.map((d) => d.code) };
    });
  if (associatedKeys.some((k) => !pagesByKey.has(k))) missing.push("associated_page_not_in_crawl");

  // ---- business linkage / geography / commercial -----------------------
  const refs = topic.seedRefs || [];
  const serviceIds = [...new Set(refs.map((r) => r.serviceId))];
  const confirmed = new Map((services || []).filter((s) => s.ownerStatus === "confirmed").map((s) => [s.id, s]));
  const linkedServices = serviceIds.map((id) => ({ serviceId: id, name: confirmed.get(id) ? confirmed.get(id).name : (refs.find((r) => r.serviceId === id) || {}).serviceName, confirmed: confirmed.has(id), basis: "observed" }));
  const reasons = topic.qualificationReasons || [];
  if (linkedServices.length === 0) {
    const r = reasons.find((x) => x.code === "matches_confirmed_service");
    if (r) linkedServices.push({ serviceId: null, name: r.detail, confirmed: true, basis: "inferred", rule: "query text matches a confirmed service (M3.2 qualification)" });
  }
  const geography = [
    ...refs.flatMap((r) => r.components.filter((c) => c.dimension === "geographies").map((c) => ({ value: c.value, provenance: c.provenance, basis: "observed", via: "seed" }))),
    ...reasons.filter((x) => x.code === "matches_owner_geography").map((x) => ({ value: x.detail, provenance: "owner", basis: "inferred", via: "query text" }))
  ].filter((g, i, a) => a.findIndex((h) => h.value === g.value) === i);

  // ---- freshness / emergence -------------------------------------------
  const firstSeen = activeKeywords.map((k) => toMs(k.firstDiscoveredAt)).filter((v) => v != null);
  const lastSeen = activeKeywords.map((k) => toMs(k.lastDiscoveredAt) ?? toMs(k.discoveredAt)).filter((v) => v != null);
  const emergence = {
    newQueriesLast30Days: firstSeen.length ? firstSeen.filter((ms) => nowMs - ms <= EMERGENCE_WINDOW_MS).length : null,
    basis: firstSeen.length ? "observed" : "unknown",
    note: firstSeen.length ? "queries first discovered in the last 30 days" : "discovery timestamps unavailable"
  };

  const sourceConfidence = gscCurrent.status === "available" ? "high" : gscDiscovery.status === "available" || semrush.status === "available" ? "medium" : "low";
  missing.push("serp_context_not_available");

  return {
    topicId: topic.id,
    businessId: topic.businessId,
    title: topic.title,
    ownerStatus: topic.status,
    ownerPriority: topic.status === "priority",
    addedBy: topic.addedBy || null,
    analysisVersion: ANALYSIS_VERSION,
    queryCount: queries.length,
    queries: queries.slice(0, 100),
    excludedQueryCount: keywords.length - activeKeywords.length,
    // M3.2 groups at topic level; the topic itself is the query family.
    queryFamilies: [{ representative: topic.title, queryCount: queries.length, basis: "observed", rule: "M3.2 topic grouping" }],
    sourceMix,
    sourceCount: Object.keys(sourceMix).length,
    gscCurrent,
    gscDiscovery,
    semrush,
    pages: { observed: observedPages.map(({ url, pageKey: k, impressions, clicks, position }) => ({ url, pageKey: k, impressions, clicks, position, basis: "observed" })), contentMatched },
    technical,
    business: {
      linkedServices,
      geography,
      preliminaryIntent: topic.preliminaryIntent || null,
      qualification: topic.qualification || null,
      commercialSignal: reasons.some((x) => x.code === "commercial_modifier") ? { present: true, basis: "inferred", rule: "commercial modifier word in query" } : { present: false, basis: "inferred" }
    },
    serpContext: { status: "not_available", reason: "no SERP data provider configured; Semrush live discovery deferred" },
    freshness: { gscCurrentRetrievedAtMs: gscCurrent.retrievedAtMs || null, lastDiscoveredAtMs: lastSeen.length ? Math.max(...lastSeen) : null },
    emergence,
    sourceConfidence,
    missing: [...new Set(missing)]
  };
}

module.exports = { computeTopicIntelligence, isApproved, APPROVED_STATUSES, ANALYSIS_VERSION, bucket };
