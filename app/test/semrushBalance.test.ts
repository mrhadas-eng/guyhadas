// Client wrapper for the free Semrush balance function: auth, request shape,
// safe-field parsing, and "never invoked automatically".
// Run: node --experimental-strip-types app/test/semrushBalance.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { requestSemrushBalance } from "../src/lib/semrushBalance.ts";

const URL_ = "https://us-central1-guyhadas-e38c4.cloudfunctions.net/visibilityGetSemrushBalance";
type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };
const mkFetch = (status: number, json: unknown, calls: Call[], fail = false) => async (url: string, init: Call["init"]) => {
  calls.push({ url, init });
  if (fail) throw new Error("network down");
  return { ok: status >= 200 && status < 300, status, json: async () => json };
};
const user = (token = "ID_TOKEN_123", calls?: { n: number }) => ({ getIdToken: async () => { if (calls) calls.n++; return token; } });

// no current user -> no request
{
  const calls: Call[] = [];
  const r = await requestSemrushBalance(() => null, mkFetch(200, {}, calls), URL_);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls.length, 0, "no request without a signed-in user");
}

// ID token retrieval + POST with Authorization header
{
  const calls: Call[] = [];
  const t = { n: 0 };
  await requestSemrushBalance(() => user("TOKEN_ABC", t), mkFetch(200, { ok: true, currentBalance: 1, checkedAt: "x" }, calls), URL_);
  assert.strictEqual(t.n, 1, "getIdToken called once");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, URL_);
  assert.strictEqual(calls[0].init.method, "POST");
  assert.strictEqual(calls[0].init.headers.Authorization, "Bearer TOKEN_ABC");
  assert.strictEqual(calls[0].init.headers["Content-Type"], "application/json");
}

// ID token failure -> no request
{
  const calls: Call[] = [];
  const r = await requestSemrushBalance(() => ({ getIdToken: async () => { throw new Error("expired"); } }), mkFetch(200, {}, calls), URL_);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls.length, 0);
}

// success -> only the safe fields
{
  const calls: Call[] = [];
  const r = await requestSemrushBalance(() => user(), mkFetch(200, { ok: true, currentBalance: 2000000, checkedAt: "2026-10-13T05:40:00.000Z", extra: "secret-ish", key: "nope" }, calls), URL_);
  assert.deepStrictEqual(r, { ok: true, currentBalance: 2000000, checkedAt: "2026-10-13T05:40:00.000Z" });
}

// server error (502 with safe error body) -> ok:false with the server message
{
  const calls: Call[] = [];
  const r = await requestSemrushBalance(() => user(), mkFetch(502, { ok: false, error: "Semrush rejected the balance request: WRONG KEY", checkedAt: "2026-10-13T05:40:00.000Z" }, calls), URL_);
  assert.deepStrictEqual(r, { ok: false, error: "Semrush rejected the balance request: WRONG KEY", checkedAt: "2026-10-13T05:40:00.000Z" });
}

// 403 / non-JSON / network failure -> ok:false, never throws
{
  const calls: Call[] = [];
  const r1 = await requestSemrushBalance(() => user(), mkFetch(403, { success: false, error: "Not authorized" }, calls), URL_);
  assert.strictEqual(r1.ok, false);
  assert.strictEqual((r1 as { error: string }).error, "Not authorized");
  const r2 = await requestSemrushBalance(() => user(), mkFetch(500, null, calls), URL_);
  assert.strictEqual(r2.ok, false);
  const r3 = await requestSemrushBalance(() => user(), mkFetch(200, {}, calls, true), URL_);
  assert.strictEqual(r3.ok, false);
  // a "success" without a numeric balance is not accepted
  const r4 = await requestSemrushBalance(() => user(), mkFetch(200, { ok: true, currentBalance: "1000", checkedAt: "x" }, calls), URL_);
  assert.strictEqual(r4.ok, false);
}

// diagnostic metadata on failure: only the six safe fields, query string dropped
{
  const calls: Call[] = [];
  const r = await requestSemrushBalance(() => user(), mkFetch(502, { ok: false, error: "Semrush returned an unexpected response to the balance request.", checkedAt: "t", diagnostic: { httpStatus: 403, contentType: "text/html", redirected: true, finalPath: "https://www.semrush.com/login/?key=SECRET", responseFormat: "html", bodyLength: 12431, body: "<html>SECRET</html>" } }, calls), URL_);
  assert.strictEqual(r.ok, false);
  const d = (r as { diagnostic?: Record<string, unknown> }).diagnostic;
  assert.deepStrictEqual(d, { httpStatus: 403, contentType: "text/html", redirected: true, finalPath: "https://www.semrush.com/login/", responseFormat: "html", bodyLength: 12431 });
  assert.ok(!JSON.stringify(r).includes("SECRET"), "no key / body / query leaks to the UI");
  const j = await requestSemrushBalance(() => user(), mkFetch(502, { ok: false, error: "x", checkedAt: "t", diagnostic: { httpStatus: 200, contentType: "application/json", redirected: false, finalPath: null, responseFormat: "json", bodyLength: 23 } }, calls), URL_);
  assert.strictEqual((j as { diagnostic?: { responseFormat: string } }).diagnostic?.responseFormat, "json");
  const bad = await requestSemrushBalance(() => user(), mkFetch(502, { ok: false, error: "x", checkedAt: "t", diagnostic: { responseFormat: "evil" } }, calls), URL_);
  assert.strictEqual((bad as { diagnostic?: { responseFormat: string } }).diagnostic?.responseFormat, "unknown");
  // success never carries a diagnostic
  const ok = await requestSemrushBalance(() => user(), mkFetch(200, { ok: true, currentBalance: 7, checkedAt: "t", diagnostic: { httpStatus: 200 } }, calls), URL_);
  assert.deepStrictEqual(ok, { ok: true, currentBalance: 7, checkedAt: "t" });
  const page = readFileSync(new URL("../src/pages/business/SemrushBalanceCheck.tsx", import.meta.url), "utf8");
  assert.ok(/פרטי אבחון/.test(page) && /result && !result\.ok/.test(page), "diagnostics shown only in the failure branch");
}

// structured JSON error fields: validated independently, bounded, no raw body
{
  const calls: Call[] = [];
  const r = await requestSemrushBalance(() => user(), mkFetch(502, { ok: false, error: "x", checkedAt: "t", diagnostic: { httpStatus: 400, contentType: "application/json", redirected: false, finalPath: "https://www.semrush.com/users/countapiunits.html?key=SECRET", responseFormat: "json", bodyLength: 126, errorCode: "40001", errorMessage: "Invalid key", errorDescription: "see https://x.example/a?key=SECRET", requestId: "req-1", rawBody: "{SECRET}" } }, calls), URL_);
  const d = (r as { diagnostic?: Record<string, unknown> }).diagnostic!;
  assert.deepStrictEqual(d, { httpStatus: 400, contentType: "application/json", redirected: false, finalPath: "https://www.semrush.com/users/countapiunits.html", responseFormat: "json", bodyLength: 126, errorCode: "40001", errorMessage: "Invalid key", errorDescription: "see [url redacted]", requestId: "req-1" });
  assert.ok(!JSON.stringify(r).includes("SECRET"), "no key / query / raw body");
  const long = await requestSemrushBalance(() => user(), mkFetch(502, { ok: false, error: "x", checkedAt: "t", diagnostic: { responseFormat: "json", errorMessage: "m".repeat(999), errorCode: 5, requestId: { a: 1 } } }, calls), URL_);
  const ld = (long as { diagnostic?: Record<string, unknown> }).diagnostic!;
  assert.strictEqual((ld.errorMessage as string).length, 200);
  assert.strictEqual("errorCode" in ld, false, "non-string values dropped");
  assert.strictEqual("requestId" in ld, false);
  const none = await requestSemrushBalance(() => user(), mkFetch(502, { ok: false, error: "x", checkedAt: "t", diagnostic: { responseFormat: "json" } }, calls), URL_);
  assert.strictEqual("errorMessage" in (none as { diagnostic: Record<string, unknown> }).diagnostic, false);
}

// no automatic invocation: the control calls getSemrushBalance only from the click handler
{
  const src = readFileSync(new URL("../src/pages/business/SemrushBalanceCheck.tsx", import.meta.url), "utf8");
  assert.ok(!/useEffect|onSnapshot|listen[A-Z]/.test(src), "no effect or listener in the control");
  const uses = src.match(/getSemrushBalance\(/g) || [];
  assert.strictEqual(uses.length, 1, "called in exactly one place");
  const handler = src.slice(src.indexOf("async function check()"), src.indexOf("const when"));
  assert.ok(/getSemrushBalance\(\)/.test(handler), "the one call is inside the click handler");
  assert.ok(/onClick=\{check\}/.test(src), "the handler is bound to the button only");
  assert.ok(/isAuthorized/.test(src), "rendered only for an authorized admin");
  const fn = readFileSync(new URL("../src/lib/functions.ts", import.meta.url), "utf8");
  assert.ok(/visibilityGetSemrushBalance/.test(fn));
  assert.ok(!/SEMRUSH_API_KEY|countapiunits/.test(fn + src), "no key or direct Semrush call in the client");
}

console.log("All Semrush balance client checks passed (auth, request, safe fields, no automatic call).");
