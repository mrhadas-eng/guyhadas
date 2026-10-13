// GuyHadas Visibility OS - Semrush API unit balance check (V4-era, read-only).
//
// INTENTIONALLY INDEPENDENT of functions/semrush.js. That file is the
// Version 3 discovery adapter (phrase_related / domain_organic /
// domain_organic_organic) and is not used, imported or changed here. This
// module makes exactly ONE kind of request: Semrush's documented FREE balance
// request (developer.semrush.com/api/v4/get-started/api-units-balance,
// "free API requests", returns the remaining units as a plain number):
//
//   GET https://www.semrush.com/users/countapiunits.html?key=<key>
//
// It costs 0 API units, so it is not routed through runGoverned / apiUsage
// (which govern and ledger PAID provider usage). Actual paid usage stays in
// apiUsage; the Semrush API Query Log is the external reconciliation source.
//
// Safety: the key is read from the environment (Secret Manager binding) at
// call time, sent only as the request's query parameter, and never
// returned, logged or stored. Every message that leaves this module is
// passed through redact(). Balance snapshots are append-only (create with a
// fresh id - never set/update), contain only {balance, checkedAt, source},
// and are written only when Semrush returned a valid number. No monthly
// allowance is inferred: a snapshot is the authoritative balance at that
// moment; opening balance / later balance / delta are derived by ordering
// snapshots by checkedAt.

const crypto = require("crypto");
const admin = require("firebase-admin");

const BALANCE_URL = "https://www.semrush.com/users/countapiunits.html";
const SOURCE = "semrush_free_balance_check";
const TIMEOUT_MS = 10000;

// Same placeholder rule as the existing adapter, re-implemented here so this
// module never imports the V3 adapter.
function configuredKey(env = process.env) {
  const key = (env.SEMRUSH_API_KEY || "").trim();
  if (key.length < 20) return null;
  if (/not[-_ ]?(yet|configured)|placeholder|changeme|dummy/i.test(key)) return null;
  return key;
}

function redact(text, key) {
  let s = String(text == null ? "" : text);
  if (key) s = s.split(key).join("[redacted]");
  // never echo a URL with a query string (it could carry a key)
  s = s.replace(/https?:\/\/\S*\?\S*/gi, "[url redacted]");
  return s.slice(0, 300);
}

// Semrush answers with a plain number ("1000" or "1,000"); errors come back
// as "ERROR <code> :: <message>" (often with HTTP 200). A UTF-8 BOM is
// tolerated.
function parseBalance(body) {
  const text = String(body == null ? "" : body).replace(/^\uFEFF/, "").trim();
  if (/^ERROR\b/i.test(text)) return { ok: false, kind: "semrush_error", detail: text };
  if (!/^\d{1,3}(,\d{3})*$|^\d+$/.test(text)) return { ok: false, kind: "malformed" };
  const n = Number(text.replace(/,/g, ""));
  if (!Number.isSafeInteger(n) || n < 0) return { ok: false, kind: "malformed" };
  return { ok: true, balance: n };
}

// Safe, one-line description of a response for the logs (diagnostics for a
// non-numeric answer). Records only: HTTP status, content-type, whether a
// redirect happened, the FINAL URL's origin + path (never the query string,
// which carries the key), body length, a coarse format guess, and the first
// 120 characters of the body with the key and any URL query strings
// redacted and whitespace collapsed.
function describeResponse(res, body, key) {
  let finalPath = null;
  try {
    if (res && res.url) {
      const u = new URL(res.url);
      finalPath = `${u.origin}${u.pathname}`;
    }
  } catch (err) {
    finalPath = "unparseable";
  }
  const headers = res && res.headers;
  const contentType = headers && typeof headers.get === "function" ? headers.get("content-type") : null;
  const t = String(body || "").replace(/^\uFEFF/, "").trim();
  const format = !t ? "empty" : t.startsWith("<") ? "html_or_xml" : t.startsWith("{") || t.startsWith("[") ? "json" : /[;,]/.test(t) && /\n/.test(t) ? "csv_like" : "text";
  const snippet = redact(t.replace(/\s+/g, " ").slice(0, 120), key).slice(0, 120);
  return `status=${res ? res.status : "?"} contentType=${contentType || "none"} redirected=${!!(res && res.redirected)} finalUrl=${finalPath || "unknown"} length=${String(body || "").length} format=${format} bodyStart="${snippet}"`;
}

// SAFE diagnostic metadata returned to the admin UI when the answer is not
// recognized (Cloud Logging is not always accessible). Never the body, never
// the key, never a query string or the request URL, never headers other than
// the content type.
const RESPONSE_FORMATS = ["html", "json", "csv", "text", "unknown"];
function responseFormatOf(contentType, body) {
  const ct = String(contentType || "").toLowerCase();
  const t = String(body || "").replace(/^\uFEFF/, "").trim();
  if (/html|xml/.test(ct) || t.startsWith("<")) return "html";
  if (/json/.test(ct) || t.startsWith("{") || t.startsWith("[")) return "json";
  if (/csv/.test(ct) || (/[;,]/.test(t) && /\n/.test(t))) return "csv";
  if (t || /text\//.test(ct)) return "text";
  return "unknown";
}

function diagnosticOf(res, body, key) {
  const headers = res && res.headers;
  const rawType = headers && typeof headers.get === "function" ? headers.get("content-type") : null;
  // content type: media type + charset only, bounded, key-redacted
  const contentType = rawType ? redact(String(rawType).replace(/[^\w\/+.;=\- ]/g, "").slice(0, 80), key) : null;
  let finalPath = null;
  try {
    if (res && res.url) {
      const u = new URL(res.url);
      finalPath = redact(`${u.origin}${u.pathname}`, key);
    }
  } catch (err) {
    finalPath = null;
  }
  return {
    httpStatus: res && typeof res.status === "number" ? res.status : null,
    contentType,
    redirected: !!(res && res.redirected),
    finalPath,
    responseFormat: responseFormatOf(rawType, body),
    bodyLength: String(body || "").length
  };
}

// deps: { env, fetchImpl, nowMs, db, log } - injectable for tests.
async function checkSemrushBalance({ env = process.env, fetchImpl = globalThis.fetch, nowMs = Date.now(), db = null, log = console } = {}) {
  const checkedAt = new Date(nowMs).toISOString();
  const fail = (error) => ({ ok: false, error, checkedAt });
  const key = configuredKey(env);
  if (!key) return fail("Semrush is not configured (SEMRUSH_API_KEY is missing or a placeholder) - no request was made.");

  let status = null;
  let body = "";
  let response = null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const url = new URL(BALANCE_URL);
    url.searchParams.set("key", key);
    const res = await fetchImpl(url.toString(), { method: "GET", signal: controller ? controller.signal : undefined });
    response = res;
    status = res.status;
    body = await res.text();
  } catch (err) {
    log.error("Semrush balance check: request failed:", redact(err && err.message, key));
    return fail("Could not reach Semrush to check the balance. Try again later.");
  } finally {
    if (timer) clearTimeout(timer);
  }

  const parsed = parseBalance(body);
  if (!parsed.ok) {
    if (parsed.kind === "semrush_error") {
      log.error(`Semrush balance check: Semrush returned an error (HTTP ${status}):`, redact(parsed.detail, key));
      return fail(`Semrush rejected the balance request: ${redact(parsed.detail.replace(/^ERROR\s*\d*\s*::\s*/i, ""), key)}`);
    }
    log.error(`Semrush balance check: unexpected response: ${describeResponse(response, body, key)}`);
    return { ...fail("Semrush returned an unexpected response to the balance request."), diagnostic: diagnosticOf(response, body, key) };
  }
  if (status != null && (status < 200 || status >= 300)) {
    log.error(`Semrush balance check: HTTP error: ${describeResponse(response, body, key)}`);
    return { ...fail(`Semrush returned HTTP ${status} for the balance request.`), diagnostic: diagnosticOf(response, body, key) };
  }

  // Append-only snapshot (fresh id, create - never overwrites).
  const store = db || admin.firestore();
  const id = `${nowMs}_${crypto.randomUUID().slice(0, 8)}`;
  try {
    await store.collection("semrushBalanceSnapshots").doc(id).create({ balance: parsed.balance, checkedAt, source: SOURCE });
  } catch (err) {
    log.error("Semrush balance check: snapshot write failed:", redact(err && err.message, key));
    return { ok: true, currentBalance: parsed.balance, checkedAt, snapshotStored: false };
  }
  return { ok: true, currentBalance: parsed.balance, checkedAt };
}

module.exports = { checkSemrushBalance, parseBalance, redact, describeResponse, diagnosticOf, responseFormatOf, RESPONSE_FORMATS, configuredKey, BALANCE_URL, SOURCE };
