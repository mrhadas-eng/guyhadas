// GuyHadas Visibility OS - Semrush V4 adapter: Keyword Metrics ONLY
// (narrow V4 pilot; docs/M3.2_IMPLEMENTATION_NOTES.md "Semrush V4 Keyword
// Metrics pilot").
//
// Deliberately independent of the V3 discovery adapter (functions/semrush.js):
// it does not import it, does not share its request helper, and never calls a
// V3 report (phrase_related, domain_organic, domain_organic_organic). V4 is
// used here for ENRICHMENT of one already-approved query, not for discovery.
//
// Verified 2026-10-13 against developer.semrush.com, "Get keyword metrics"
// (page last updated 2026-09-01, V4 marked Early Access):
//   GET https://api.semrush.com/apis/v4/keywords/v1/metrics
//   Authorization: Apikey <key>      (header - the key is never in the URL)
//   query: keyword (required, 1-255 chars), country (required, ISO alpha-2),
//          month (optional, YYYY-MM), format (json default)
//   price: 20 API units per request
//   JSON: { meta: {country, keyword, month, request_id, status_code, success},
//           data: { search_volume (numeric string), keyword_difficulty (number),
//                   intents (string[]), competitive_density (number),
//                   cpc (numeric string, USD cents), number_of_results (numeric
//                   string), serp_features (string[]), trends (number[12]) } }
//   errors: JSON { meta: {...}, error: { code, message, retryable, details } }
// Not documented (so not relied on): whether failed requests are charged,
// the no-data response shape, value ranges of difficulty/density.
//
// Safety: exactly ONE HTTPS request per call. No retry, no batch, no loop.
// The key is read from the environment, sent only in the Authorization
// header, and never logged, returned or embedded in an error message.

const KEYWORD_METRICS_URL = "https://api.semrush.com/apis/v4/keywords/v1/metrics";
const PROVIDER_VERSION = "semrush_v4_keywords_v1_metrics";
const UNITS_PER_REQUEST = 20;
const REQUEST_TIMEOUT_MS = 20000;

function isSemrushV4Configured(env = process.env) {
  const key = String(env.SEMRUSH_API_KEY || "").trim();
  if (key.length < 20) return false;
  return !/not[-_ ]?(yet|configured)|placeholder|changeme|dummy/i.test(key);
}

class SemrushV4Error extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "SemrushV4Error";
    this.httpStatus = fields.httpStatus ?? null;
    this.errorCode = fields.errorCode ?? null;
    this.requestId = fields.requestId ?? null;
    this.retryable = fields.retryable ?? null;
  }
}

// Bounded, control characters stripped, anything that looks like a URL with
// a query string removed (defence in depth - the key is never in a URL).
function safeText(v, max) {
  if (typeof v !== "string") return null;
  const t = v
    .replace(/https?:\/\/\S*\?\S*/gi, "[url redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
  return t || null;
}

// Numbers arrive as numbers or numeric strings ("1245", "1,245").
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.replace(/,/g, "").trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }
  return null;
}

// Provider-neutral intent vocabulary. V4 returns upper-case names; V3-style
// numeric codes are mapped too in case the Early Access format changes.
const INTENT_CODES = { 0: "commercial", 1: "informational", 2: "navigational", 3: "transactional" };
function mapIntents(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    let name = null;
    if (typeof v === "string" && v.trim()) name = /^\d$/.test(v.trim()) ? INTENT_CODES[v.trim()] || null : v.trim().toLowerCase();
    else if (typeof v === "number") name = INTENT_CODES[v] || null;
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function mapStringList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim().toLowerCase()))];
}

// Maps a V4 Keyword Metrics JSON body into the provider-neutral market-demand
// structure. Downstream code depends on THIS shape, never on Semrush names.
// Throws SemrushV4Error for a body that is not a usable response.
function mapKeywordMetrics(json, { keyword, country, month, retrievedAt }) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new SemrushV4Error("Semrush V4 response was not a JSON object", { errorCode: "malformed_response" });
  }
  const meta = json.meta && typeof json.meta === "object" ? json.meta : {};
  if (meta.success === false || json.error) {
    const e = json.error && typeof json.error === "object" ? json.error : {};
    throw new SemrushV4Error(`Semrush V4 error: ${safeText(e.message, 200) || "unspecified"}`, {
      httpStatus: toNumber(meta.status_code),
      errorCode: safeText(String(e.code ?? ""), 40),
      requestId: safeText(meta.request_id, 80),
      retryable: typeof e.retryable === "boolean" ? e.retryable : null
    });
  }
  const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : null;
  const dataQuality = [];
  const num = (field) => {
    if (!data || data[field] === undefined || data[field] === null || data[field] === "") return null;
    const n = toNumber(data[field]);
    if (n === null) dataQuality.push(`${field}_not_numeric`);
    return n;
  };
  const searchVolume = num("search_volume");
  const keywordDifficulty = num("keyword_difficulty");
  const competitiveDensity = num("competitive_density");
  const cpcCents = num("cpc");
  const numberOfResults = num("number_of_results");
  const trends = data && Array.isArray(data.trends) ? data.trends.slice(0, 12).map(toNumber) : [];
  const metricsAvailable = !!data && [searchVolume, keywordDifficulty, competitiveDensity, cpcCents, numberOfResults].some((v) => v !== null);
  if (!data) dataQuality.push("no_data");
  else if (!metricsAvailable) dataQuality.push("no_metrics");

  return {
    keyword: safeText(meta.keyword, 255) || keyword,
    country: safeText(meta.country, 2) ? String(meta.country).toUpperCase() : country,
    month: /^\d{4}-\d{2}$/.test(String(meta.month || "")) ? String(meta.month) : month,
    searchVolume,
    keywordDifficulty,
    intents: data ? mapIntents(data.intents) : [],
    competitiveDensity,
    // V4 documents CPC in USD cents; stored here in USD.
    cpc: cpcCents === null ? null : Math.round(cpcCents) / 100,
    cpcCurrency: "USD",
    numberOfResults,
    serpFeatures: data ? mapStringList(data.serp_features) : [],
    trends,
    metricsAvailable,
    dataQuality,
    // What this is - and what it is not.
    kind: "market_demand_estimate",
    basis: "provider_estimate",
    note: "Semrush market-demand estimate for the specified monthly snapshot - not observed Google traffic and not Search Console visibility",
    source: "semrush_v4",
    providerVersion: PROVIDER_VERSION,
    requestId: safeText(meta.request_id, 80),
    retrievedAt
  };
}

// ONE request, no retry. Returns { metrics, requestId, httpStatus }.
async function fetchKeywordMetrics(keyword, country, month, { fetchImpl = fetch, env = process.env, nowMs = Date.now(), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const kw = String(keyword || "").replace(/\s+/g, " ").trim();
  if (kw.length < 1 || kw.length > 255) throw new SemrushV4Error("keyword must be 1-255 characters", { errorCode: "invalid_keyword" });
  if (!/^[A-Z]{2}$/.test(String(country || ""))) throw new SemrushV4Error("country must be an ISO 3166-1 alpha-2 code", { errorCode: "invalid_country" });
  if (month != null && !/^\d{4}-\d{2}$/.test(String(month))) throw new SemrushV4Error("month must be YYYY-MM", { errorCode: "invalid_month" });
  if (!isSemrushV4Configured(env)) throw new SemrushV4Error("Semrush V4 is not configured", { errorCode: "not_configured" });

  const url = new URL(KEYWORD_METRICS_URL);
  url.searchParams.set("keyword", kw);
  url.searchParams.set("country", country);
  if (month) url.searchParams.set("month", month);
  url.searchParams.set("format", "json");

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: `Apikey ${String(env.SEMRUSH_API_KEY).trim()}`, Accept: "application/json" },
      redirect: "error",
      signal: controller ? controller.signal : undefined
    });
  } catch (err) {
    throw new SemrushV4Error(err && err.name === "AbortError" ? "Semrush V4 request timed out" : "Semrush V4 request could not be completed", { errorCode: "network_error" });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text.replace(/^﻿/, "")) : null;
  } catch (err) {
    json = undefined;
  }
  if (!res.ok) {
    const e = json && json.error && typeof json.error === "object" ? json.error : {};
    const meta = json && json.meta && typeof json.meta === "object" ? json.meta : {};
    throw new SemrushV4Error(`Semrush V4 HTTP ${res.status}: ${safeText(e.message, 200) || "no error message"}`, {
      httpStatus: res.status,
      errorCode: safeText(String(e.code ?? ""), 40),
      requestId: safeText(meta.request_id, 80),
      retryable: typeof e.retryable === "boolean" ? e.retryable : null
    });
  }
  if (json === undefined) throw new SemrushV4Error("Semrush V4 response was not valid JSON", { httpStatus: res.status, errorCode: "malformed_response" });
  const metrics = mapKeywordMetrics(json, { keyword: kw, country, month, retrievedAt: new Date(nowMs).toISOString() });
  return { metrics, requestId: metrics.requestId, httpStatus: res.status };
}

module.exports = {
  KEYWORD_METRICS_URL,
  PROVIDER_VERSION,
  UNITS_PER_REQUEST,
  SemrushV4Error,
  isSemrushV4Configured,
  mapKeywordMetrics,
  fetchKeywordMetrics
};
