// Semrush free balance check tests - no network (fetch is injected), no
// Semrush request, index-enforcing fake Firestore.
// Run: node functions/test/semrushBalance.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createFakeFirestore, loadWithFake } = require("./helpers/fakeFirestore");

const KEY = "v4KEY_abcdefghijklmnopqrstuvwxyz_0123456789";
const NOW = Date.UTC(2026, 9, 12, 13, 0, 0);
const STORE = path.join(__dirname, "..", "semrushBalanceStore.js");

function setup() {
  const fake = createFakeFirestore();
  const mod = loadWithFake(fake, STORE);
  const logs = [];
  const log = { error: (...a) => logs.push(a.join(" ")), log: (...a) => logs.push(a.join(" ")) };
  const calls = [];
  const fetcher = (status, body, throwErr) => async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw new Error(`fetch failed for ${url}`);
    return { status, text: async () => body };
  };
  const check = (fetchImpl, env = { SEMRUSH_API_KEY: KEY }, nowMs = NOW) => mod.checkSemrushBalance({ env, fetchImpl, nowMs, db: fake.admin.firestore(), log });
  return { fake, mod, logs, calls, fetcher, check, snaps: () => fake.rows("semrushBalanceSnapshots") };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
  }
}
const noKey = (s, x) => assert.ok(!JSON.stringify(x).includes(KEY), "API key leaked");

(async () => {
  await test("success: numeric balance -> ok, snapshot appended with only balance/checkedAt/source", async () => {
    const s = setup();
    const r = await s.check(s.fetcher(200, "1,250,000\n"));
    assert.deepStrictEqual(r, { ok: true, currentBalance: 1250000, checkedAt: "2026-10-12T13:00:00.000Z" });
    const snaps = s.snaps();
    assert.strictEqual(snaps.length, 1);
    const { id, ...fields } = snaps[0];
    assert.deepStrictEqual(fields, { balance: 1250000, checkedAt: "2026-10-12T13:00:00.000Z", source: "semrush_free_balance_check" });
    assert.strictEqual(s.calls.length, 1);
    const u = new URL(s.calls[0].url);
    assert.strictEqual(u.origin + u.pathname, "https://www.semrush.com/users/countapiunits.html", "only the free balance endpoint");
    assert.deepStrictEqual([...u.searchParams.keys()], ["key"]);
    assert.strictEqual(s.calls[0].opts.method, "GET");
  });

  await test("plain number without separators parses", async () => {
    const s = setup();
    assert.strictEqual((await s.check(s.fetcher(200, "2000000"))).currentBalance, 2000000);
  });

  await test("append-only: a second check adds a snapshot, never overwrites (delta derivable)", async () => {
    const s = setup();
    await s.check(s.fetcher(200, "2000000"), undefined, NOW);
    await s.check(s.fetcher(200, "1999980"), undefined, NOW + 60000);
    const snaps = s.snaps().sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
    assert.strictEqual(snaps.length, 2);
    assert.strictEqual(snaps[0].balance - snaps[1].balance, 20, "opening - subsequent = delta");
    assert.notStrictEqual(snaps[0].id, snaps[1].id);
  });

  await test("malformed response -> ok:false, no snapshot", async () => {
    for (const body of ["", "<html>login</html>", "12.5", "-3", "1,2,3", "abc 100"]) {
      const s = setup();
      const r = await s.check(s.fetcher(200, body));
      assert.strictEqual(r.ok, false, body);
      assert.ok(/unexpected response/.test(r.error));
      assert.strictEqual(s.snaps().length, 0);
    }
  });

  await test("Semrush error response -> safe message, no snapshot, key never echoed", async () => {
    const s = setup();
    const r = await s.check(s.fetcher(200, `ERROR 120 :: WRONG KEY - ID PAIR (${KEY})`));
    assert.strictEqual(r.ok, false);
    assert.ok(/rejected/.test(r.error));
    assert.strictEqual(s.snaps().length, 0);
    noKey(s, r);
    noKey(s, s.logs);
  });

  await test("HTTP error status -> ok:false, no snapshot", async () => {
    const s = setup();
    const r = await s.check(s.fetcher(503, "1000"));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(s.snaps().length, 0);
  });

  await test("network failure (error text contains the URL with the key) -> redacted", async () => {
    const s = setup();
    const r = await s.check(s.fetcher(0, "", true));
    assert.strictEqual(r.ok, false);
    noKey(s, r);
    noKey(s, s.logs);
    assert.ok(!s.logs.join(" ").includes("countapiunits.html?"), "full request URL never logged");
    assert.strictEqual(s.snaps().length, 0);
  });

  // --- diagnostics for non-numeric responses (production showed "unexpected response") ---
  const richFetch = (status, body, { contentType = null, url = null, redirected = false } = {}) => async (reqUrl) => ({
    status,
    url: url || reqUrl,
    redirected,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body
  });

  await test("diagnostics: HTML login/redirect page -> logged safely (status, type, final path, length, snippet), no key, no query", async () => {
    const s = setup();
    const html = `<!DOCTYPE html><html><head><title>Log in to Semrush</title></head><body><a href="https://www.semrush.com/login/?redirect_to=/users/countapiunits.html?key=${KEY}">x</a> ${KEY}</body></html>`;
    const r = await s.check(richFetch(200, html, { contentType: "text/html; charset=utf-8", url: `https://www.semrush.com/login/?src=x&key=${KEY}`, redirected: true }));
    assert.deepStrictEqual(Object.keys(r).sort(), ["checkedAt", "error", "ok"], "returned contract unchanged");
    assert.ok(/unexpected response/.test(r.error));
    const line = s.logs.join("\n");
    assert.ok(/status=200/.test(line));
    assert.ok(/contentType=text\/html; charset=utf-8/.test(line));
    assert.ok(/redirected=true/.test(line));
    assert.ok(/finalUrl=https:\/\/www\.semrush\.com\/login\//.test(line), "final origin + path only");
    assert.ok(/format=html_or_xml/.test(line));
    assert.ok(new RegExp(`length=${html.length}`).test(line));
    assert.ok(!line.includes(KEY), "key never logged");
    assert.ok(!/\?src=|key=/.test(line), "no query string logged");
    const snippet = line.match(/bodyStart="([^"]*)"/)[1];
    assert.ok(snippet.length <= 120);
    noKey(s, r);
    assert.strictEqual(s.snaps().length, 0);
  });

  await test("diagnostics: JSON body and HTTP 403 are described; no snapshot", async () => {
    const s = setup();
    await s.check(richFetch(200, '{"error":"invalid key"}', { contentType: "application/json" }));
    assert.ok(/format=json/.test(s.logs.join(" ")));
    assert.ok(/contentType=application\/json/.test(s.logs.join(" ")));
    const t = setup();
    const r = await t.check(richFetch(403, "1000", { contentType: "text/plain" }));
    assert.strictEqual(r.ok, false);
    assert.ok(/HTTP error: status=403/.test(t.logs.join(" ")));
    assert.ok(!t.logs.join(" ").includes(KEY));
    assert.strictEqual(s.snaps().length + t.snaps().length, 0);
  });

  await test("parser: BOM-prefixed and CRLF numeric answers are accepted", async () => {
    const s = setup();
    assert.strictEqual(s.mod.parseBalance("\uFEFF1,500,000\r\n").balance, 1500000);
    assert.strictEqual(s.mod.parseBalance(" 42 ").balance, 42);
    assert.strictEqual(s.mod.parseBalance("<html>").ok, false);
  });

  await test("missing / placeholder secret -> no request at all", async () => {
    for (const env of [{}, { SEMRUSH_API_KEY: "" }, { SEMRUSH_API_KEY: "placeholder-not-configured-yet-xxxx" }, { SEMRUSH_API_KEY: "short" }]) {
      const s = setup();
      const r = await s.check(s.fetcher(200, "1000"), env);
      assert.strictEqual(r.ok, false);
      assert.ok(/not configured/.test(r.error));
      assert.strictEqual(s.calls.length, 0);
      assert.strictEqual(s.snaps().length, 0);
    }
  });

  await test("snapshot write failure still returns the balance but marks it unstored (internal)", async () => {
    const s = setup();
    s.fake.failWritesAfter(0);
    const r = await s.check(s.fetcher(200, "1000"));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.snapshotStored, false);
  });

  // --- endpoint -------------------------------------------------------------
  const { handleBalanceRequest } = require("../semrushBalance");
  const resFake = () => {
    const r = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
    return r;
  };
  const noCors = () => {};

  await test("unauthorized caller -> no check runs", async () => {
    let ran = false;
    const res = resFake();
    await handleBalanceRequest({ method: "POST" }, res, { cors: noCors, auth: async (q, r) => { r.status(403).json({ success: false, error: "Not authorized" }); return null; }, check: async () => { ran = true; } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(ran, false);
  });

  await test("GET / other methods rejected; OPTIONS preflight ok", async () => {
    const res = resFake();
    await handleBalanceRequest({ method: "GET" }, res, { cors: noCors, auth: async () => ({ email: "x" }), check: async () => ({ ok: true }) });
    assert.strictEqual(res.statusCode, 405);
    const pre = resFake();
    await handleBalanceRequest({ method: "OPTIONS" }, pre, { cors: noCors });
    assert.strictEqual(pre.statusCode, 204);
  });

  await test("admin caller: only the safe fields are returned (no key, no internals)", async () => {
    const res = resFake();
    await handleBalanceRequest({ method: "POST" }, res, { cors: noCors, auth: async () => ({ email: "owner" }), check: async () => ({ ok: true, currentBalance: 5, checkedAt: "t", snapshotStored: false, key: KEY }) });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true, currentBalance: 5, checkedAt: "t" });
    const bad = resFake();
    await handleBalanceRequest({ method: "POST" }, bad, { cors: noCors, auth: async () => ({ email: "owner" }), check: async () => ({ ok: false, error: "x", checkedAt: "t", detail: KEY }) });
    assert.strictEqual(bad.statusCode, 502);
    assert.deepStrictEqual(bad.body, { ok: false, error: "x", checkedAt: "t" });
  });

  await test("static: independent of the V3 adapter, no paid report, no apiUsage, secret bound on this function only", async () => {
    const store = fs.readFileSync(STORE, "utf8");
    const ep = fs.readFileSync(path.join(__dirname, "..", "semrushBalance.js"), "utf8");
    const code = (t) => t.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // ignore comments
    for (const src of [code(store), code(ep)]) {
      assert.ok(!/require\(["']\.\/semrush["']\)/.test(src), "never imports functions/semrush.js");
      assert.ok(!/phrase_related|domain_organic|api\.semrush\.com|apis\/v4|runGoverned/.test(src), "no paid report endpoint");
    }
    assert.ok(/secrets: \["SEMRUSH_API_KEY"\]/.test(ep));
    assert.ok(!/console\.(log|error)\([^)]*\burl\b/.test(store), "the request URL is never logged");
    const v3 = fs.readFileSync(path.join(__dirname, "..", "semrush.js"), "utf8");
    assert.ok(/phrase_related/.test(v3), "V3 adapter untouched");
  });

  const failed = results.filter((r) => r.startsWith("FAIL"));
  console.log(results.join("\n"));
  console.log(`\n${results.length - failed.length}/${results.length} Semrush balance tests passed`);
  if (failed.length) process.exit(1);
})();
