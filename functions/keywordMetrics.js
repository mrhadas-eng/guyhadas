// GuyHadas Visibility OS - admin-only endpoint for the Semrush V4 Keyword
// Metrics pilot (logic in keywordMetricsStore.js).
//
// Explicit owner action only: the request must carry confirmPaidCall: true
// (set by the confirmation step in the UI). Never on render, listener, page
// load, deploy or schedule. One keyword per invocation, at most one Semrush
// request per invocation, no batch, no retry. The SEMRUSH_API_KEY secret is
// bound to this function; the key never leaves the server.

const functions = require("firebase-functions");
const { setCors, requireAdmin } = require("./visibility");
const { enrichKeywordMetrics } = require("./keywordMetricsStore");

const RESULT_FIELDS = ["keywordId", "topicId", "query", "country", "month", "marketDemand", "cacheHit", "cacheDecision", "providerCalled", "providerUnitsUsed", "estimatedUnits", "stored"];
const ERROR_FIELDS = ["blockedReason", "cacheDecision", "providerCalled", "providerUnitsUsed", "estimatedUnits", "errorCode", "httpStatus"];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

async function handleEnrichRequest(req, res, { auth = requireAdmin, enrich = enrichKeywordMetrics, cors = setCors } = {}) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "POST only", providerCalled: false });
    return;
  }
  const user = await auth(req, res);
  if (!user) return;
  const body = req.body || {};
  // One keyword per invocation - arrays / batches are refused outright.
  if (Array.isArray(body.query) || Array.isArray(body.queries) || Array.isArray(body.keywords) || body.queries !== undefined || body.keywords !== undefined) {
    res.status(400).json({ success: false, error: "Exactly one query per request (no batch)", providerCalled: false });
    return;
  }
  if (body.confirmPaidCall !== true) {
    res.status(400).json({ success: false, error: "The paid call must be explicitly confirmed (confirmPaidCall: true)", providerCalled: false, estimatedUnits: 20 });
    return;
  }
  try {
    const r = await enrich({ businessId: body.businessId, topicId: body.topicId, query: body.query, country: body.country || "IL" });
    if (!r.ok) {
      res.status(r.status || 500).json({ success: false, error: r.error, ...pick(r, ERROR_FIELDS) });
      return;
    }
    res.status(200).json({ success: true, ...pick(r, RESULT_FIELDS) });
  } catch (err) {
    console.error("visibilityEnrichKeywordMetrics: unexpected failure");
    res.status(500).json({ success: false, error: "The enrichment failed unexpectedly.", providerCalled: err && err.providerCalled === true });
  }
}

exports.visibilityEnrichKeywordMetrics = functions
  .runWith({ secrets: ["SEMRUSH_API_KEY"], timeoutSeconds: 60, memory: "256MB" })
  .https.onRequest((req, res) => handleEnrichRequest(req, res));

exports.handleEnrichRequest = handleEnrichRequest;
