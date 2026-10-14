// Semrush V4 Keyword Metrics pilot tests - adapter mapping, one-request
// safety, governed enrichment (cache, 20-unit hard cap, fail closed),
// persistence, endpoint guards, M4/M5 compatibility. No network: every
// Semrush response is a fake fetch.
// Run with: node functions/test/keywordMetrics.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createFakeFirestore, loadWithFake } = require("./helpers/fakeFirestore");
const v4 = require("../semrushV4");
const { computeTopicIntelligence } = require("../topicIntelligence");

const STORE = path.join(__dirname, "..", "keywordMetricsStore.js");
const BIZ = "hagar";
const KEY = "test-v4-key-0123456789abcdef";
const ENV = { SEMRUSH_API_KEY: KEY };
const NOW = Date.parse("2026-10-13T09:00:00Z");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
  }
}

// Shaped like the documented example response (developer.semrush.com).
function v4Body(overrides = {}) {
  return {
    meta: { country: "IL", keyword: "אדריכלית בקיסריה", month: "2026-10", request_id: "req-123", status_code: 200, success: true },
    data: {
      competitive_density: 0.42,
      cpc: "1245",
      intents: ["COMMERCIAL", "INFORMATIONAL"],
      keyword_difficulty: 31,
      number_of_results: "184000",
      search_volume: "320",
      serp_features: ["SITELINKS", "PEOPLE_ALSO_ASK", "AI_OVERVIEW"],
      trends: [0.5, 0.6, 0.7, 0.8, 0.9, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.6],
      ...overrides
    }
  };
}

function fakeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? responses.slice() : [responses];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    if (r instanceof Error) throw r;
    const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => h[String(k).toLowerCase()] ?? null }, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  fn.calls = calls;
  return fn;
}

async function setup({ topicStatus = "relevant", seedUsage = [] } = {}) {
  const fake = createFakeFirestore();
  const store = loadWithFake(fake, STORE);
  const db = fake.admin.firestore();
  await db.collection("searchTopics").doc("t1").set({ businessId: BIZ, title: "אדריכלית בקיסריה", queries: ["אדריכלית בקיסריה", "אדריכל קיסריה"], status: topicStatus });
  await db.collection("searchTopics").doc("tOther").set({ businessId: "other", title: "x", queries: ["x"], status: "relevant" });
  await db.collection("keywords").doc("k1").set({
    businessId: BIZ,
    topicId: "t1",
    query: "אדריכלית בקיסריה",
    source: "gsc",
    sources: { gsc: { metrics: { impressions: 50, clicks: 3, position: 8 } } },
    sourceList: ["gsc"],
    volume: null,
    difficulty: null,
    excludedByRule: null
  });
  await db.collection("keywords").doc("k2").set({ businessId: BIZ, topicId: "t2", query: "שיפוץ", source: "gsc", sources: {}, sourceList: ["gsc"], excludedByRule: null });
  for (const row of seedUsage) fake.seed("apiUsage", row);
  return { fake, store, db };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// n prior provider attempts for a business, ageMs before the real clock
// (store-level tests run on the real clock; calendar-day boundaries are
// tested separately with a pinned clock - see the CAL tests).
const usageRows = (businessId, n, ageMs) =>
  Array.from({ length: n }, (_, i) => ({ provider: "semrush", operation: "enrichKeywordMetrics", businessId, status: "success", providerCalled: true, inputHash: `prior${i}`, retrievedAtMs: Date.now() - ageMs - i }));
// rows "earlier today" without risking yesterday when the suite runs just after midnight
const TODAY_AGE = 5;

const ledger = (fake) => fake.rows("apiUsage").filter((r) => r.operation === "enrichKeywordMetrics");

(async () => {
  // ---------------- adapter mapping ----------------
  await test("A1 valid V4 JSON maps to the provider-neutral structure", () => {
    const m = v4.mapKeywordMetrics(v4Body(), { keyword: "k", country: "IL", month: "2026-10", retrievedAt: "2026-10-13T09:00:00.000Z" });
    assert.strictEqual(m.searchVolume, 320);
    assert.strictEqual(m.keywordDifficulty, 31);
    assert.strictEqual(m.competitiveDensity, 0.42);
    assert.strictEqual(m.cpc, 12.45, "USD cents -> USD");
    assert.strictEqual(m.numberOfResults, 184000);
    assert.deepStrictEqual(m.serpFeatures, ["sitelinks", "people_also_ask", "ai_overview"]);
    assert.strictEqual(m.trends.length, 12);
    assert.strictEqual(m.source, "semrush_v4");
    assert.strictEqual(m.country, "IL");
    assert.strictEqual(m.month, "2026-10");
    assert.strictEqual(m.keyword, "אדריכלית בקיסריה");
    assert.strictEqual(m.retrievedAt, "2026-10-13T09:00:00.000Z");
    assert.strictEqual(m.metricsAvailable, true);
    assert.strictEqual(m.kind, "market_demand_estimate");
    assert.ok(/not observed Google traffic/.test(m.note));
    for (const k of Object.keys(m)) assert.ok(!/^(search_volume|keyword_difficulty|competitive_density|number_of_results|serp_features)$/.test(k), `no Semrush field name ${k}`);
  });

  await test("A2 multiple intents are normalized, de-duplicated; numeric codes mapped", () => {
    const m = v4.mapKeywordMetrics(v4Body({ intents: ["COMMERCIAL", "TRANSACTIONAL", "commercial", 1, "2"] }), { keyword: "k", country: "IL", month: "2026-10", retrievedAt: "x" });
    assert.deepStrictEqual(m.intents, ["commercial", "transactional", "informational", "navigational"]);
  });

  await test("A3 non-numeric search volume -> null with a data-quality flag (never 0)", () => {
    const m = v4.mapKeywordMetrics(v4Body({ search_volume: "n/a" }), { keyword: "k", country: "IL", month: "2026-10", retrievedAt: "x" });
    assert.strictEqual(m.searchVolume, null);
    assert.ok(m.dataQuality.includes("search_volume_not_numeric"));
    assert.strictEqual(m.metricsAvailable, true, "other metrics still present");
  });

  await test("A4 missing metrics: empty data / no data -> metricsAvailable false, all null", () => {
    const a = v4.mapKeywordMetrics({ meta: { success: true }, data: {} }, { keyword: "k", country: "IL", month: "2026-10", retrievedAt: "x" });
    assert.strictEqual(a.metricsAvailable, false);
    assert.ok(a.dataQuality.includes("no_metrics"));
    assert.strictEqual(a.searchVolume, null);
    const b = v4.mapKeywordMetrics({ meta: { success: true } }, { keyword: "k", country: "IL", month: "2026-10", retrievedAt: "x" });
    assert.strictEqual(b.metricsAvailable, false);
    assert.ok(b.dataQuality.includes("no_data"));
    assert.deepStrictEqual(b.intents, []);
  });

  await test("A5 malformed JSON -> malformed_response error after exactly one request", async () => {
    const f = fakeFetch({ status: 200, body: "<html>oops</html>" });
    await assert.rejects(() => v4.fetchKeywordMetrics("k", "IL", "2026-10", { fetchImpl: f, env: ENV, nowMs: NOW }), (e) => e.errorCode === "malformed_response");
    assert.strictEqual(f.calls.length, 1);
  });

  await test("A6 API error (HTTP 401 JSON error, and 200 with success:false) -> safe error, one request, no key", async () => {
    const f = fakeFetch({ status: 401, body: { meta: { success: false, status_code: 401, request_id: "r9" }, error: { code: "UNAUTHORIZED", message: `bad key ${KEY}? see https://x.y/z?key=${KEY}`, retryable: false } } });
    await assert.rejects(
      () => v4.fetchKeywordMetrics("k", "IL", "2026-10", { fetchImpl: f, env: ENV, nowMs: NOW }),
      (e) => e.httpStatus === 401 && e.errorCode === "UNAUTHORIZED" && e.requestId === "r9" && !e.message.includes("?key=")
    );
    assert.strictEqual(f.calls.length, 1, "no retry");
    const g = fakeFetch({ status: 200, body: { meta: { success: false, status_code: 402 }, error: { code: "NO_UNITS", message: "not enough units" } } });
    await assert.rejects(() => v4.fetchKeywordMetrics("k", "IL", "2026-10", { fetchImpl: g, env: ENV, nowMs: NOW }), (e) => e.errorCode === "NO_UNITS");
    assert.strictEqual(g.calls.length, 1);
  });

  await test("A7 request shape: V4 endpoint, key only in Authorization header, one GET, no redirects", async () => {
    const f = fakeFetch({ status: 200, body: v4Body() });
    await v4.fetchKeywordMetrics("אדריכלית בקיסריה", "IL", "2026-10", { fetchImpl: f, env: ENV, nowMs: NOW });
    assert.strictEqual(f.calls.length, 1);
    const u = new URL(f.calls[0].url);
    assert.strictEqual(`${u.origin}${u.pathname}`, "https://api.semrush.com/apis/v4/keywords/v1/metrics");
    assert.strictEqual(u.searchParams.get("keyword"), "אדריכלית בקיסריה");
    assert.strictEqual(u.searchParams.get("country"), "IL");
    assert.strictEqual(u.searchParams.get("month"), "2026-10");
    assert.ok(!f.calls[0].url.includes(KEY), "key never in the URL");
    assert.strictEqual(f.calls[0].init.headers.Authorization, `Apikey ${KEY}`);
    assert.strictEqual(f.calls[0].init.method, "GET");
    assert.strictEqual(f.calls[0].init.redirect, "error");
  });

  await test("A8 network failure -> one attempt, no retry", async () => {
    const f = fakeFetch(new Error("ECONNRESET"));
    await assert.rejects(() => v4.fetchKeywordMetrics("k", "IL", "2026-10", { fetchImpl: f, env: ENV, nowMs: NOW }), (e) => e.errorCode === "network_error");
    assert.strictEqual(f.calls.length, 1);
  });

  // ---------------- governed enrichment ----------------
  await test("G1 cache miss: exactly one Semrush request, ledger = 20 units, marketDemand stored, owner/GSC data untouched", async () => {
    const { fake, store, db } = await setup();
    const f = fakeFetch({ status: 200, body: v4Body() });
    const r = await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(r.providerCalled, true);
    assert.strictEqual(r.providerUnitsUsed, 20);
    assert.strictEqual(r.cacheHit, false);
    const rows = ledger(fake);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, "success");
    assert.strictEqual(rows[0].providerCalled, true);
    assert.strictEqual(rows[0].providerUnitsUsed, 20);
    assert.strictEqual(rows[0].estimatedUnits, 20);
    assert.strictEqual(rows[0].provider, "semrush");
    const kw = (await db.collection("keywords").doc("k1").get()).data();
    assert.strictEqual(kw.marketDemand.source, "semrush_v4");
    assert.strictEqual(kw.marketDemand.searchVolume, 320);
    assert.strictEqual(kw.marketDemand.country, "IL");
    assert.strictEqual(kw.marketDemand.month, "2026-10");
    assert.ok(kw.marketDemand.retrievedAt);
    assert.deepStrictEqual(kw.sources, { gsc: { metrics: { impressions: 50, clicks: 3, position: 8 } } }, "GSC evidence unchanged");
    assert.deepStrictEqual(kw.sourceList, ["gsc"], "enrichment is not a discovery source");
    assert.strictEqual(kw.volume, null, "legacy top-level fields untouched");
    const topic = (await db.collection("searchTopics").doc("t1").get()).data();
    assert.strictEqual(topic.status, "relevant", "owner status untouched");
  });

  await test("G2 repeat: cache hit, zero provider calls, zero units, keyword not rewritten", async () => {
    const { fake, store, db } = await setup();
    const f = fakeFetch({ status: 200, body: v4Body() });
    await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });
    const before = JSON.stringify((await db.collection("keywords").doc("k1").get()).data());
    const r = await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "  אדריכלית   בקיסריה ", env: ENV, nowMs: NOW + 60000, fetchImpl: f });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.cacheHit, true);
    assert.strictEqual(r.providerCalled, false);
    assert.strictEqual(r.providerUnitsUsed, 0);
    assert.strictEqual(r.stored, false);
    assert.strictEqual(f.calls.length, 1, "still only the first request");
    const hit = ledger(fake).find((x) => x.status === "cache_hit");
    assert.ok(hit && hit.providerCalled === false && hit.providerUnitsUsed === 0 && hit.actualCostUsd === 0);
    assert.strictEqual(JSON.stringify((await db.collection("keywords").doc("k1").get()).data()), before);
  });

  await test("G3 cache identity includes month: a new month is a new identity", async () => {
    const { store } = await setup();
    const f = fakeFetch({ status: 200, body: v4Body() });
    await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });
    // a new month is a new cache identity: not a cache hit, so a (second) provider call is made
    const r = await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: Date.parse("2026-11-02T09:00:00Z"), fetchImpl: f });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.cacheHit, false);
    assert.strictEqual(r.providerCalled, true);
    assert.strictEqual(r.month, "2026-11");
    assert.strictEqual(f.calls.length, 2);
  });

  await test("G4 budget/quota failure -> no provider call", async () => {
    const { fake, store } = await setup({ seedUsage: usageRows(BIZ, 5, TODAY_AGE) });
    const f = fakeFetch({ status: 200, body: v4Body() });
    const r = await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blockedReason, "blocked_by_quota");
    assert.strictEqual(r.providerCalled, false);
    assert.strictEqual(f.calls.length, 0);
    assert.ok(ledger(fake).some((x) => x.status === "blocked_by_quota" && x.providerCalled === false));
  });

  await test("G5 unit cap cannot be confirmed (estimate above 20) -> blocked_by_budget, no call", async () => {
    const fake = createFakeFirestore();
    const limits = require("../apiLimits");
    const patched = JSON.parse(JSON.stringify(limits));
    patched.semrush.enrichKeywordMetrics.unitsPerRequest = 40; // estimate exceeds the 20-unit cap
    const store = loadWithFake(fake, STORE, { [path.join(__dirname, "..", "apiLimits.js")]: patched });
    const db = fake.admin.firestore();
    await db.collection("searchTopics").doc("t1").set({ businessId: BIZ, title: "q", queries: ["q"], status: "priority" });
    await db.collection("keywords").doc("k1").set({ businessId: BIZ, topicId: "t1", query: "q", excludedByRule: null });
    const f = fakeFetch({ status: 200, body: v4Body() });
    const r = await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "q", env: ENV, nowMs: NOW, fetchImpl: f });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blockedReason, "blocked_by_budget");
    assert.strictEqual(f.calls.length, 0);
  });

  await test("G6 safety check unavailable (Firestore outage) -> fail closed, no call", async () => {
    const { fake, store } = await setup();
    const f = fakeFetch({ status: 200, body: v4Body() });
    fake.failQueriesAfter(2); // keyword lookup + cache lookup succeed, the quota sums fail
    const r = await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });
    assert.strictEqual(r.ok, false);
    assert.ok(/_unavailable$/.test(r.blockedReason), r.blockedReason);
    assert.strictEqual(f.calls.length, 0);
  });

  await test("G7 provider error -> one request, no retry, recorded, nothing stored", async () => {
    const { fake, store, db } = await setup();
    const f = fakeFetch({ status: 500, body: { meta: { success: false }, error: { code: "INTERNAL", message: "boom", retryable: true } } });
    const r = await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.providerCalled, true);
    assert.strictEqual(f.calls.length, 1, "retryable:true is still NOT retried");
    const err = ledger(fake).find((x) => x.status === "error");
    assert.ok(err && err.providerCalled === true && err.estimatedUnits === 20 && err.providerUnitsUsed === null);
    assert.strictEqual((await db.collection("keywords").doc("k1").get()).data().marketDemand, undefined);
    // a failed call is never re-sent by itself, and it counts toward the quota
    assert.strictEqual(ledger(fake).filter((x) => x.providerCalled === true).length, 1);
  });

  await test("G8 only an approved topic of this business, and only its stored queries", async () => {
    const f = fakeFetch({ status: 200, body: v4Body() });
    const a = await setup({ topicStatus: "new" });
    assert.strictEqual((await a.store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f })).status, 400);
    const b = await setup();
    assert.strictEqual((await b.store.enrichKeywordMetrics({ businessId: BIZ, topicId: "tOther", query: "x", env: ENV, nowMs: NOW, fetchImpl: f })).status, 403);
    assert.strictEqual((await b.store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "something typed", env: ENV, nowMs: NOW, fetchImpl: f })).status, 400);
    assert.strictEqual((await b.store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "שיפוץ", env: ENV, nowMs: NOW, fetchImpl: f })).status, 400, "query of another topic");
    assert.strictEqual((await b.store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: {}, nowMs: NOW, fetchImpl: f })).status, 400, "not configured");
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual(ledger(b.fake).length, 0, "validation failures never reach the governor");
  });

  // ---------------- provider error diagnostics (403) ----------------
  const leak = (obj) => {
    const j = JSON.stringify(obj);
    return j.includes(KEY) || /Apikey/i.test(j) || /authorization/i.test(j) || /[?&]key=/.test(j);
  };

  await test("D1 a 403 JSON provider error: providerCalled=true, safe metadata persisted, no secret, no retry", async () => {
    const { fake, store, db } = await setup();
    const f = fakeFetch({
      status: 403,
      headers: { "Content-Type": "application/json", "X-Request-Id": "hdr-1" },
      body: { meta: { success: false, status_code: 403, request_id: "req-403" }, error: { code: "FORBIDDEN", message: `Access denied for key ${KEY}`, retryable: false } }
    });
    const r = await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });
    assert.strictEqual(f.calls.length, 1, "no retry");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.providerCalled, true);
    assert.strictEqual(r.httpStatus, 403);
    assert.strictEqual(r.errorCode, "FORBIDDEN");
    assert.strictEqual(r.requestId, "req-403", "body request_id preferred over header");
    assert.strictEqual(r.retryable, false);
    assert.strictEqual(r.responseFormat, "json");
    const row = ledger(fake).find((x) => x.status === "error");
    assert.ok(row, "error row recorded");
    assert.strictEqual(row.providerCalled, true);
    assert.strictEqual(row.providerHttpStatus, 403);
    assert.strictEqual(row.providerErrorCode, "FORBIDDEN");
    assert.strictEqual(row.providerRequestId, "req-403");
    assert.strictEqual(row.providerRetryable, false);
    assert.strictEqual(row.providerContentType, "application/json");
    assert.strictEqual(row.providerResponseFormat, "json");
    assert.strictEqual(row.estimatedUnits, 20);
    assert.strictEqual(row.providerUnitsUsed, null);
    // NOTE: the provider's message is echoed into errorMessage only via safeText (bounded) -
    // the key must never be persisted even if Semrush echoes it back.
    assert.ok(!leak(fake.rows("apiUsage")), "no secret in apiUsage");
    assert.ok(!leak(r), "no secret in the store result");
    assert.strictEqual((await db.collection("keywords").doc("k1").get()).data().marketDemand, undefined);
  });

  await test("D2 a 403 HTML/edge page: format, content type, length and a header request id; no body persisted", async () => {
    const { fake, store } = await setup();
    const html = "<!DOCTYPE html><html><body>Access denied secret-body-marker</body></html>";
    const f = fakeFetch({ status: 403, headers: { "content-type": "text/html; charset=UTF-8", "cf-ray": "8abc123-TLV" }, body: html });
    const r = await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(r.httpStatus, 403);
    assert.strictEqual(r.errorCode, null);
    assert.strictEqual(r.retryable, null);
    assert.strictEqual(r.requestId, "cf-ray:8abc123-TLV");
    assert.strictEqual(r.responseFormat, "html");
    assert.strictEqual(r.bodyLength, html.length);
    const row = ledger(fake).find((x) => x.status === "error");
    assert.strictEqual(row.providerHttpStatus, 403);
    assert.strictEqual(row.providerRequestId, "cf-ray:8abc123-TLV");
    assert.strictEqual(row.providerResponseFormat, "html");
    assert.strictEqual(row.providerContentType, "text/html; charset=UTF-8");
    assert.strictEqual(row.providerBodyLength, html.length);
    assert.ok(!JSON.stringify(fake.rows("apiUsage")).includes("secret-body-marker"), "raw body never persisted");
    assert.ok(!leak(fake.rows("apiUsage")));
  });

  await test("D3 a 403 is never retried automatically: one request per explicit click, counted toward the quota", async () => {
    const { fake, store } = await setup();
    const f = fakeFetch({ status: 403, body: { meta: { success: false }, error: { code: "FORBIDDEN", message: "denied", retryable: true } } });
    await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });
    assert.strictEqual(f.calls.length, 1, "retryable:true still not retried");
    await store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });
    assert.strictEqual(f.calls.length, 2, "a second explicit click is a second (single) request");
    assert.strictEqual(ledger(fake).filter((x) => x.status === "error" && x.providerCalled === true).length, 2, "both attempts are on the ledger");
  });

  // ---------------- pilot quota (owner-authorized: 5 per calendar day Asia/Jerusalem, 25 per rolling 30 days) ----------------
  const ERR500 = { status: 500, body: { meta: { success: false }, error: { code: "INTERNAL", message: "boom" } } };
  const click = (store, f) => store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: "אדריכלית בקיסריה", env: ENV, nowMs: NOW, fetchImpl: f });

  await test("Q1 provider attempts 1-5 pass the quota check; the 6th is blocked_by_quota with no call", async () => {
    const { store, db } = await setup();
    // six distinct stored queries of the approved topic (distinct cache identities, successful calls -
    // consecutive failures would instead trip the circuit breaker after 3, see G9)
    const qs = ["q1", "q2", "q3", "q4", "q5", "q6"];
    await db.collection("searchTopics").doc("t1").update({ queries: qs });
    for (const q of qs) await db.collection("keywords").add({ businessId: BIZ, topicId: "t1", query: q, excludedByRule: null });
    const f = fakeFetch({ status: 200, body: v4Body() });
    const ask = (q) => store.enrichKeywordMetrics({ businessId: BIZ, topicId: "t1", query: q, env: ENV, nowMs: NOW, fetchImpl: f });
    for (let i = 1; i <= 5; i++) {
      const r = await ask(qs[i - 1]);
      assert.strictEqual(r.ok, true, `attempt ${i}: ${r.error}`);
      assert.strictEqual(r.providerCalled, true, `attempt ${i} passed the quota check`);
      assert.strictEqual(f.calls.length, i);
    }
    const r6 = await ask(qs[5]);
    assert.strictEqual(r6.ok, false);
    assert.strictEqual(r6.blockedReason, "blocked_by_quota");
    assert.strictEqual(r6.providerCalled, false);
    assert.strictEqual(f.calls.length, 5, "6th never reached Semrush");
    assert.ok(/limit 5/.test(r6.error), r6.error);
  });

  await test("G9 circuit breaker unchanged: 3 consecutive provider failures open it for 1 h (no call on the 4th)", async () => {
    const { store } = await setup();
    const f = fakeFetch(ERR500);
    for (let i = 1; i <= 3; i++) assert.strictEqual((await click(store, f)).providerCalled, true);
    const r4 = await click(store, f);
    assert.strictEqual(r4.blockedReason, "blocked_by_safety_limit");
    assert.strictEqual(f.calls.length, 3);
  });

  await test("Q3 cache hits and blocked attempts never count toward the quota", async () => {
    const seeds = [
      ...Array.from({ length: 10 }, (_, i) => ({ provider: "semrush", operation: "enrichKeywordMetrics", businessId: BIZ, status: "cache_hit", providerCalled: false, inputHash: `h${i}`, retrievedAtMs: Date.now() - 1000 })),
      ...Array.from({ length: 10 }, (_, i) => ({ provider: "semrush", operation: "enrichKeywordMetrics", businessId: BIZ, status: "blocked_by_quota", providerCalled: false, inputHash: `b${i}`, retrievedAtMs: Date.now() - 1000 }))
    ];
    const { store } = await setup({ seedUsage: seeds });
    const f = fakeFetch({ status: 200, body: v4Body() });
    const r = await click(store, f);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(f.calls.length, 1);
  });

  await test("Q4 monthly business limit: 24 attempts in 30 days allow the 25th; 25 block the 26th", async () => {
    const f = fakeFetch({ status: 200, body: v4Body() });
    const a = await setup({ seedUsage: usageRows(BIZ, 24, 3 * DAY) }); // all on earlier calendar days
    assert.strictEqual((await click(a.store, f)).ok, true);
    const b = await setup({ seedUsage: usageRows(BIZ, 25, 3 * DAY) });
    const r = await click(b.store, f);
    assert.strictEqual(r.blockedReason, "blocked_by_quota");
    assert.ok(/this month/.test(r.error) && /limit 25/.test(r.error), r.error);
    const c = await setup({ seedUsage: usageRows(BIZ, 25, 31 * DAY) }); // outside the rolling 30 days
    assert.strictEqual((await click(c.store, f)).ok, true);
    assert.strictEqual(f.calls.length, 2);
  });

  await test("Q5 global limits: 5 attempts by any business today block; 25 in 30 days block", async () => {
    const f = fakeFetch({ status: 200, body: v4Body() });
    const a = await setup({ seedUsage: usageRows("otherBiz", 5, TODAY_AGE) });
    const r = await click(a.store, f);
    assert.strictEqual(r.blockedReason, "blocked_by_quota");
    assert.ok(/all businesses/.test(r.error) && /limit 5/.test(r.error), r.error);
    const b = await setup({ seedUsage: usageRows("otherBiz", 25, 3 * DAY) });
    const r2 = await click(b.store, f);
    assert.strictEqual(r2.blockedReason, "blocked_by_quota");
    assert.ok(/this month \(all businesses\)/.test(r2.error) && /limit 25/.test(r2.error), r2.error);
    const c = await setup({ seedUsage: usageRows("otherBiz", 4, TODAY_AGE) });
    assert.strictEqual((await click(c.store, f)).ok, true);
    assert.strictEqual(f.calls.length, 1);
  });

  await test("Q6 pilot limits are exactly as authorized; every other operation's limits are unchanged", () => {
    const L = require("../apiLimits");
    const e = L.semrush.enrichKeywordMetrics;
    assert.deepStrictEqual(
      { units: e.unitsPerRequest, cap: e.maxEstimatedUnitsPerCall, bDay: e.maxRequestsPerBusinessPerDay, bMonth: e.maxRequestsPerBusinessPerMonth, gDay: e.maxRequestsGlobalPerDay, gMonth: e.maxRequestsGlobalPerMonth, ttl: e.cacheTtlMs, cbT: e.circuitBreakerThreshold, cbC: e.circuitBreakerCooldownMs },
      { units: 20, cap: 20, bDay: 5, bMonth: 25, gDay: 5, gMonth: 25, ttl: 31 * DAY, cbT: 3, cbC: HOUR }
    );
    assert.deepStrictEqual(e.dailyWindow, { type: "calendar_day", timeZone: "Asia/Jerusalem" });
    for (const op of [L.anthropic.analyzeBusinessServices, L.semrush.discoverRelatedForSeed, L.semrush.discoverDomainOrganic, L.google.searchConsoleQueryPage]) assert.strictEqual(op.dailyWindow, undefined, "other operations keep the default rolling day");
    const q = (o) => [o.maxRequestsPerBusinessPerDay, o.maxRequestsPerBusinessPerMonth, o.maxRequestsGlobalPerDay, o.maxRequestsGlobalPerMonth];
    assert.deepStrictEqual(q(L.anthropic.analyzeBusinessServices), [5, 30, 50, 500]);
    assert.deepStrictEqual(q(L.semrush.discoverRelatedForSeed), [20, 120, 100, 1000]);
    assert.deepStrictEqual(q(L.semrush.discoverDomainOrganic), [3, 30, 30, 300]);
    assert.deepStrictEqual(q(L.google.searchConsoleQueryPage), [10, 120, 100, 2000]);
    assert.deepStrictEqual(Object.keys(L).sort(), ["anthropic", "google", "semrush"]);
    assert.deepStrictEqual(Object.keys(L.semrush).sort(), ["discoverDomainOrganic", "discoverRelatedForSeed", "enrichKeywordMetrics"]);
  });

  // ---------------- calendar day, Asia/Jerusalem (pinned clock, explicit offsets) ----------------
  const GOV = path.join(__dirname, "..", "apiUsage.js");
  const J = (local) => Date.parse(local); // ISO with an explicit Asia/Jerusalem offset, e.g. "2026-10-14T23:59:00+03:00"
  const { calendarDayWindow } = require("../apiUsage");

  await test("CAL1 window = [00:00, next 00:00) Asia/Jerusalem for any instant of the day", () => {
    for (const t of ["2026-10-14T00:00:00+03:00", "2026-10-14T12:00:00+03:00", "2026-10-14T23:59:59+03:00"]) {
      const w = calendarDayWindow(J(t), "Asia/Jerusalem");
      assert.strictEqual(w.startMs, J("2026-10-14T00:00:00+03:00"), t);
      assert.strictEqual(w.endMs, J("2026-10-15T00:00:00+03:00"), t);
    }
    const before = calendarDayWindow(J("2026-10-13T23:59:00+03:00"), "Asia/Jerusalem");
    assert.strictEqual(before.endMs, J("2026-10-14T00:00:00+03:00"), "23:59 belongs to the previous day");
    const after = calendarDayWindow(J("2026-10-14T00:01:00+03:00"), "Asia/Jerusalem");
    assert.strictEqual(after.startMs, J("2026-10-14T00:00:00+03:00"), "00:01 belongs to the new day");
  });

  await test("CAL2 DST: spring-forward day is 23 h, fall-back day is 25 h, both start at local midnight", () => {
    const spring = calendarDayWindow(J("2026-03-27T12:00:00+03:00"), "Asia/Jerusalem");
    assert.strictEqual(spring.startMs, J("2026-03-27T00:00:00+02:00"));
    assert.strictEqual(spring.endMs, J("2026-03-28T00:00:00+03:00"));
    assert.strictEqual(spring.endMs - spring.startMs, 23 * HOUR);
    const fall = calendarDayWindow(J("2026-10-25T12:00:00+02:00"), "Asia/Jerusalem");
    assert.strictEqual(fall.startMs, J("2026-10-25T00:00:00+03:00"));
    assert.strictEqual(fall.endMs, J("2026-10-26T00:00:00+02:00"));
    assert.strictEqual(fall.endMs - fall.startMs, 25 * HOUR);
    // the repeated 01:xx hour on the fall-back night is still the same day
    for (const t of ["2026-10-25T01:30:00+03:00", "2026-10-25T01:30:00+02:00"]) assert.strictEqual(calendarDayWindow(J(t), "Asia/Jerusalem").startMs, fall.startMs, t);
  });

  await test("CAL3 independent of the runtime time zone (same windows under TZ=UTC, Los Angeles, Tokyo, Jerusalem)", () => {
    const { execFileSync } = require("child_process");
    const script = `const {calendarDayWindow}=require(${JSON.stringify(GOV)});console.log(JSON.stringify(["2026-10-14T23:59:00+03:00","2026-10-15T00:01:00+03:00","2026-03-27T12:00:00+03:00","2026-10-25T12:00:00+02:00"].map(t=>calendarDayWindow(Date.parse(t),"Asia/Jerusalem"))))`;
    const outs = ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Asia/Jerusalem"].map((tz) => execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz } }).toString().trim());
    assert.ok(outs.every((o) => o === outs[0]), outs.join("\n"));
  });

  async function governedAt(nowMs, seeds) {
    const fake = createFakeFirestore();
    const gov = loadWithFake(fake, GOV);
    for (const r of seeds) fake.seed("apiUsage", { provider: "semrush", operation: "enrichKeywordMetrics", status: "success", providerCalled: true, inputHash: "prior", ...r });
    let calls = 0;
    const out = await gov.runGoverned({
      provider: "semrush",
      operation: "enrichKeywordMetrics",
      businessId: BIZ,
      input: { keyword: `k${Math.random()}`, country: "IL", month: "2026-10", providerVersion: "test" },
      model: "test",
      nowMs,
      estimateUnits: () => 20,
      execute: async () => (calls++, { result: { ok: 1 }, usage: { providerUnitsUsed: 20 } })
    });
    return { out, calls };
  }
  const at = (local, biz = BIZ) => ({ businessId: biz, retrievedAtMs: J(local) });

  await test("CAL4 5 attempts on the same Asia/Jerusalem day are allowed; the 6th that day is blocked_by_quota", async () => {
    const four = ["2026-10-14T00:00:30+03:00", "2026-10-14T08:00:00+03:00", "2026-10-14T15:00:00+03:00", "2026-10-14T23:58:00+03:00"].map((t) => at(t));
    const a = await governedAt(J("2026-10-14T23:59:00+03:00"), four);
    assert.strictEqual(a.calls, 1, "5th attempt allowed");
    const b = await governedAt(J("2026-10-14T23:59:30+03:00"), [...four, at("2026-10-14T23:59:00+03:00")]);
    assert.strictEqual(b.calls, 0, "6th attempt blocked");
    assert.strictEqual(b.out.decision, "blocked_by_quota");
    assert.ok(/calendar day, Asia\/Jerusalem/.test(b.out.blocked.message) && /limit 5/.test(b.out.blocked.message), b.out.blocked.message);
  });

  await test("CAL5 5 attempts on the previous day (incl. 23:59) do not block today's first attempt at 00:01", async () => {
    const yesterday = ["2026-10-13T09:00:00+03:00", "2026-10-13T12:00:00+03:00", "2026-10-13T18:00:00+03:00", "2026-10-13T23:00:00+03:00", "2026-10-13T23:59:00+03:00"].map((t) => at(t));
    const r = await governedAt(J("2026-10-14T00:01:00+03:00"), yesterday);
    assert.strictEqual(r.calls, 1);
    assert.strictEqual(r.out.decision, "cache_miss");
    const sameDay = await governedAt(J("2026-10-13T23:59:30+03:00"), yesterday);
    assert.strictEqual(sameDay.calls, 0, "those five do block the rest of their own day");
  });

  await test("CAL6 an attempt at 00:01 belongs to the new day (not counted for the previous day)", async () => {
    const rows = [...["2026-10-14T10:00:00+03:00", "2026-10-14T11:00:00+03:00", "2026-10-14T12:00:00+03:00", "2026-10-14T13:00:00+03:00"].map((t) => at(t)), at("2026-10-15T00:01:00+03:00")];
    const prev = await governedAt(J("2026-10-14T23:59:00+03:00"), rows);
    assert.strictEqual(prev.calls, 1, "the 00:01 row is outside 14 Oct (4 counted)");
    const next = await governedAt(J("2026-10-15T00:02:00+03:00"), rows);
    assert.strictEqual(next.calls, 1, "on 15 Oct only the 00:01 row counts (1 of 5)");
  });

  await test("CAL7 global daily limit uses the same calendar day across businesses", async () => {
    const others = ["01:00", "05:00", "09:00", "13:00", "17:00"].map((h) => at(`2026-10-14T${h}:00+03:00`, "otherBiz"));
    const r = await governedAt(J("2026-10-14T20:00:00+03:00"), others);
    assert.strictEqual(r.calls, 0);
    assert.ok(/all businesses/.test(r.out.blocked.message), r.out.blocked.message);
    const tomorrow = await governedAt(J("2026-10-15T00:01:00+03:00"), others);
    assert.strictEqual(tomorrow.calls, 1);
  });

  await test("CAL8 DST fall-back day (25 h): attempts at 00:30 (+03) and 23:30 (+02) are the same day", async () => {
    const rows = ["2026-10-25T00:30:00+03:00", "2026-10-25T01:30:00+03:00", "2026-10-25T01:30:00+02:00", "2026-10-25T12:00:00+02:00", "2026-10-25T23:30:00+02:00"].map((t) => at(t));
    const r = await governedAt(J("2026-10-25T23:45:00+02:00"), rows);
    assert.strictEqual(r.calls, 0, "all five counted on 25 Oct");
    const next = await governedAt(J("2026-10-26T00:00:00+02:00"), rows);
    assert.strictEqual(next.calls, 1, "midnight starts a new day");
  });

  await test("CAL9 month stays a rolling 30 days (pinned clock): 25 attempts on earlier days in the last 30 days block", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => at(`2026-10-${String(1 + i).padStart(2, "0")}T12:00:00+03:00`));
    const r = await governedAt(J("2026-10-27T10:00:00+02:00"), rows);
    assert.strictEqual(r.calls, 0);
    assert.ok(/this month/.test(r.out.blocked.message) && /limit 25/.test(r.out.blocked.message), r.out.blocked.message);
    const later = await governedAt(J("2026-11-25T10:00:00+02:00"), rows); // all older than 30 days
    assert.strictEqual(later.calls, 1);
  });

  await test("CAL10 an invalid time zone fails closed (no provider call)", async () => {
    const fake = createFakeFirestore();
    const L = JSON.parse(JSON.stringify(require("../apiLimits")));
    L.semrush.enrichKeywordMetrics.dailyWindow = { type: "calendar_day", timeZone: "Not/AZone" };
    const gov = loadWithFake(fake, GOV, { [path.join(__dirname, "..", "apiLimits.js")]: L });
    let calls = 0;
    const out = await gov.runGoverned({ provider: "semrush", operation: "enrichKeywordMetrics", businessId: BIZ, input: { k: 1 }, estimateUnits: () => 20, execute: async () => (calls++, { result: {}, usage: {} }) });
    assert.strictEqual(calls, 0);
    assert.strictEqual(out.decision, "blocked_safety_check_unavailable");
  });

  // ---------------- endpoint guards ----------------
  const { handleEnrichRequest } = loadWithFake(createFakeFirestore(), path.join(__dirname, "..", "keywordMetrics.js"), {
    [path.join(__dirname, "..", "visibility.js")]: { setCors: () => {}, requireAdmin: async () => ({ uid: "admin" }) }
  });
  function fakeRes() {
    const r = { code: null, body: null };
    r.status = (c) => ((r.code = c), r);
    r.json = (b) => ((r.body = b), r);
    r.send = (b) => ((r.body = b), r);
    return r;
  }
  const okAuth = async () => ({ uid: "admin" });

  await test("E1 no explicit confirmation -> refused, enrichment never invoked", async () => {
    let called = 0;
    const res = fakeRes();
    await handleEnrichRequest({ method: "POST", body: { businessId: BIZ, topicId: "t1", query: "q" } }, res, { auth: okAuth, enrich: async () => (called++, { ok: true }), cors: () => {} });
    assert.strictEqual(res.code, 400);
    assert.strictEqual(called, 0);
    assert.strictEqual(res.body.providerCalled, false);
  });

  await test("E2 no batch: array/multiple queries refused; GET refused", async () => {
    let called = 0;
    const enrich = async () => (called++, { ok: true });
    for (const body of [{ query: ["a", "b"], confirmPaidCall: true }, { queries: ["a"], confirmPaidCall: true }, { keywords: ["a"], confirmPaidCall: true }]) {
      const res = fakeRes();
      await handleEnrichRequest({ method: "POST", body: { businessId: BIZ, topicId: "t1", ...body } }, res, { auth: okAuth, enrich, cors: () => {} });
      assert.strictEqual(res.code, 400);
    }
    const res = fakeRes();
    await handleEnrichRequest({ method: "GET", body: {} }, res, { auth: okAuth, enrich, cors: () => {} });
    assert.strictEqual(res.code, 405);
    assert.strictEqual(called, 0);
  });

  await test("E4 failed call: endpoint returns the safe diagnostic fields, bounded message, nothing else", async () => {
    const res = fakeRes();
    await handleEnrichRequest({ method: "POST", body: { businessId: BIZ, topicId: "t1", query: "q", confirmPaidCall: true } }, res, {
      auth: okAuth,
      cors: () => {},
      enrich: async () => ({ ok: false, status: 502, error: "x".repeat(2000), providerCalled: true, httpStatus: 403, errorCode: "FORBIDDEN", requestId: "req-403", retryable: false, responseFormat: "json", contentType: "application/json", bodyLength: 120, estimatedUnits: 20, providerUnitsUsed: null, rawBody: "nope", apiKey: KEY })
    });
    assert.strictEqual(res.code, 502);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.error.length <= 400);
    for (const [k, v] of Object.entries({ httpStatus: 403, errorCode: "FORBIDDEN", requestId: "req-403", retryable: false, providerCalled: true, responseFormat: "json" })) assert.strictEqual(res.body[k], v, k);
    assert.strictEqual(res.body.rawBody, undefined);
    assert.strictEqual(res.body.apiKey, undefined);
  });

  await test("E3 confirmed single query -> one enrichment invocation, whitelisted fields only", async () => {
    const calls = [];
    const res = fakeRes();
    await handleEnrichRequest({ method: "POST", body: { businessId: BIZ, topicId: "t1", query: "q", confirmPaidCall: true } }, res, {
      auth: okAuth,
      cors: () => {},
      enrich: async (a) => (calls.push(a), { ok: true, query: "q", marketDemand: { searchVolume: 1 }, providerUnitsUsed: 20, providerCalled: true, cacheHit: false, secretThing: "x" })
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.providerUnitsUsed, 20);
    assert.strictEqual(res.body.secretThing, undefined);
  });

  // ---------------- static safety ----------------
  await test("S1 V4 code never imports the V3 adapter or calls V3 discovery reports", () => {
    for (const f of ["semrushV4.js", "keywordMetricsStore.js", "keywordMetrics.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\/\/.*$/gm, "");
      assert.ok(!/require\(["']\.\/semrush["']\)/.test(src), `${f} imports the V3 adapter`);
      for (const banned of ["phrase_related", "domain_organic", "fetchRelatedKeywords", "fetchDomainOrganicKeywords", "fetchOrganicCompetitors"]) assert.ok(!src.includes(banned), `${f} references ${banned}`);
    }
  });

  await test("S2 one request maximum: a single fetch site, no loop/retry around it, no forceRefresh path", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "semrushV4.js"), "utf8").replace(/\/\/.*$/gm, "");
    assert.strictEqual((src.match(/fetchImpl\(/g) || []).length, 1);
    assert.ok(!/\bretry\s*\(|for\s*\(\s*let\s+attempt|while\s*\(/.test(src));
    const store = fs.readFileSync(STORE, "utf8").replace(/\/\/.*$/gm, "");
    assert.strictEqual((store.match(/fetchKeywordMetrics\(/g) || []).length, 1);
    assert.ok(/forceRefresh:\s*false/.test(store));
  });

  await test("S3 rules: the client can never create or change keywords.marketDemand (static check; no emulator - #45)", () => {
    const rules = fs.readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8");
    const i = rules.indexOf("match /keywords/{keywordId}");
    const block = rules.slice(i, rules.indexOf("\n    }", i));
    assert.ok(!/allow read, write/.test(block), "no blanket write");
    assert.ok(/allow create: if isAdmin\(\) && !\("marketDemand" in request\.resource\.data\)/.test(block));
    assert.ok(/allow update: if isAdmin\(\) && !request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasAny\(\["marketDemand"\]\)/.test(block));
  });

  // ---------------- M4 / M5 compatibility ----------------
  await test("C1 M4 reads marketDemand as the same market-demand evidence M5 consumes (no scoring change)", () => {
    const topic = { id: "t1", title: "אדריכלית בקיסריה", queries: ["אדריכלית בקיסריה"], status: "relevant" };
    const base = { topic, gscRows: [], gscStatus: "available", pagesByKey: new Map(), pageTexts: new Map(), services: [], nowMs: NOW };
    const kwPlain = { id: "k1", query: "אדריכלית בקיסריה", sources: { gsc: { metrics: { impressions: 5 } } } };
    const without = computeTopicIntelligence({ ...base, keywords: [kwPlain] });
    assert.strictEqual(without.semrush.status, "not_available");
    const md = v4.mapKeywordMetrics(v4Body(), { keyword: "k", country: "IL", month: "2026-10", retrievedAt: "2026-10-13T09:00:00.000Z" });
    const withV4 = computeTopicIntelligence({ ...base, keywords: [{ ...kwPlain, marketDemand: md }] });
    assert.strictEqual(withV4.semrush.status, "available");
    assert.strictEqual(withV4.semrush.totalMonthlyVolume, 320);
    assert.strictEqual(withV4.semrush.maxDifficulty, 31);
    assert.deepStrictEqual(withV4.semrush.demandProvenance, [{ query: "אדריכלית בקיסריה", source: "semrush_v4", country: "IL", month: "2026-10", retrievedAt: "2026-10-13T09:00:00.000Z" }]);
    assert.deepStrictEqual(withV4.gscCurrent, without.gscCurrent, "Search Console visibility meaning unchanged");
    // a V4 row with no volume contributes nothing (never 0)
    const noVol = computeTopicIntelligence({ ...base, keywords: [{ ...kwPlain, marketDemand: { ...md, searchVolume: null } }] });
    assert.strictEqual(noVol.semrush.status, "not_available");
  });

  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL"));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
