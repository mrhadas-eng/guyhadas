// GuyHadas Visibility OS - governed market-demand enrichment of ONE approved
// Search Topic query (Semrush V4 Keyword Metrics pilot).
//
//   owner picks an approved topic + one of its stored queries
//   -> server re-validates (topic belongs to the business, is approved, the
//      query is one of its stored keyword rows)
//   -> runGoverned("semrush", "enrichKeywordMetrics"): cache first ($0 hit),
//      circuit breaker, quotas, HARD 20-unit cap, fail closed, ledger
//   -> exactly one Semrush V4 request on a miss (no retry, no batch)
//   -> provider-neutral marketDemand stored on that keyword row
//
// What this does NOT do: discovery, seed expansion, domain reports, new
// topics or keywords, owner-status changes, or any change to Search Console
// evidence. The stored evidence is labelled as a market-demand ESTIMATE
// (source semrush_v4), never as observed Google traffic.
//
// Pure of firebase-functions so it runs under the in-memory Firestore in
// functions/test. The HTTP endpoint is keywordMetrics.js.

const admin = require("firebase-admin");
const { runGoverned } = require("./apiUsage");
const apiLimits = require("./apiLimits");
const semrushV4 = require("./semrushV4");
const { normalizePhrase } = require("./seedBuilder");

const APPROVED_STATUSES = ["relevant", "priority", "brand_strategic"];
const OPERATION = "enrichKeywordMetrics";

// Calendar month in UTC; explicit so the cache identity is deterministic.
function monthOf(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function fail(status, error, extra = {}) {
  return { ok: false, status, error, providerCalled: false, ...extra };
}

async function enrichKeywordMetrics({ businessId, topicId, query, country = "IL", nowMs = Date.now(), env = process.env, fetchImpl } = {}) {
  if (!businessId || !topicId || typeof query !== "string" || !query.trim()) return fail(400, "businessId, topicId and query are required");
  if (!/^[A-Z]{2}$/.test(String(country))) return fail(400, "country must be a two-letter ISO code (e.g. IL)");
  const db = admin.firestore();

  const topicSnap = await db.collection("searchTopics").doc(topicId).get();
  if (!topicSnap.exists) return fail(404, "Search Topic not found");
  const topic = topicSnap.data();
  if (topic.businessId !== businessId) return fail(403, "This Search Topic belongs to another business");
  if (!APPROVED_STATUSES.includes(topic.status)) return fail(400, "Only an approved Search Topic (relevant / priority / brand strategic) can be enriched");

  const q = query.replace(/\s+/g, " ").trim();
  const kwSnap = await db.collection("keywords").where("businessId", "==", businessId).where("query", "==", q).limit(1).get();
  if (kwSnap.empty || kwSnap.docs[0].data().topicId !== topicId) return fail(400, "The query must be one of this topic's stored queries");
  const kwDoc = kwSnap.docs[0];

  if (!semrushV4.isSemrushV4Configured(env)) return fail(400, "Semrush V4 is not configured (SEMRUSH_API_KEY missing or a placeholder) - no request was made.");

  const month = monthOf(nowMs);
  const limits = apiLimits.semrush[OPERATION];
  let governed;
  try {
    governed = await runGoverned({
      provider: "semrush",
      operation: OPERATION,
      businessId,
      // Cache identity: business (runGoverned scopes by it) + normalized
      // keyword + country + month + provider version.
      input: { keyword: normalizePhrase(q), country, month, providerVersion: semrushV4.PROVIDER_VERSION },
      model: semrushV4.PROVIDER_VERSION,
      forceRefresh: false, // no repeat path in the pilot
      reason: "owner_confirmed_semrush_v4_keyword_metrics_pilot",
      estimateUnits: () => limits.unitsPerRequest,
      execute: async () => {
        const r = await semrushV4.fetchKeywordMetrics(q, country, month, { env, nowMs, ...(fetchImpl ? { fetchImpl } : {}) });
        return {
          result: r.metrics,
          usage: { requestId: r.requestId, recordsRequested: 1, recordsReturned: r.metrics.metricsAvailable ? 1 : 0, providerUnitsUsed: limits.unitsPerRequest, actualCostUsd: null }
        };
      }
    });
  } catch (err) {
    // The one provider request failed (recorded in apiUsage by the governor).
    // Never retried here; the owner decides whether to try again later.
    return {
      ok: false,
      status: 502,
      error: `Semrush V4 request failed: ${String(err.message || "error").slice(0, 300)}`,
      errorCode: err.errorCode || null,
      httpStatus: err.httpStatus || null,
      providerCalled: err.providerCalled === true,
      cacheDecision: err.decision || null,
      providerUnitsUsed: null, // unknown - Semrush does not document whether failed requests are billed
      estimatedUnits: limits.unitsPerRequest
    };
  }
  if (!governed.ok) {
    return fail(/_unavailable$/.test(governed.blocked.reason) ? 503 : 429, governed.blocked.message, { blockedReason: governed.blocked.reason, cacheDecision: governed.decision, estimatedUnits: limits.unitsPerRequest });
  }

  const metrics = governed.result;
  const stored = {
    ...metrics,
    topicId,
    apiUsage: { inputHash: governed.inputHash, cachedFromUsageId: governed.cachedFromUsageId || null }
  };
  // Idempotent: an identical stored result is not rewritten (a cache hit on
  // an already-stored answer makes zero writes).
  const prev = kwDoc.data().marketDemand;
  const same = prev && prev.source === stored.source && prev.retrievedAt === stored.retrievedAt && prev.month === stored.month && prev.country === stored.country;
  if (!same) await db.collection("keywords").doc(kwDoc.id).update({ marketDemand: stored });

  return {
    ok: true,
    keywordId: kwDoc.id,
    topicId,
    query: q,
    country,
    month,
    marketDemand: metrics,
    cacheHit: governed.cacheHit,
    cacheDecision: governed.decision,
    providerCalled: governed.providerCalled,
    providerUnitsUsed: governed.providerCalled ? limits.unitsPerRequest : 0,
    estimatedUnits: limits.unitsPerRequest,
    stored: !same
  };
}

module.exports = { enrichKeywordMetrics, monthOf, APPROVED_STATUSES };
