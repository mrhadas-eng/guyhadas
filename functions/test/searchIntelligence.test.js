// M4 Search Intelligence & Baseline tests. Index-enforcing in-memory
// Firestore, a fake crawler (fixture HTML parsed by the real cheerio) and a
// counting fake GSC adapter - no network.
// Run with: node functions/test/searchIntelligence.test.js

const assert = require("assert");
const path = require("path");
const cheerio = require("cheerio");
const { createFakeFirestore, loadWithFake } = require("./helpers/fakeFirestore");
const { parseRobotsTxt, robotsDecision, analyzePage, buildInventory } = require("../pageInventory");

const STORE = path.join(__dirname, "..", "searchIntelligenceStore.js");
const BIZ = "hagar";
const ORIGIN = "https://www.hagarlushi.com";
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

const html = (body, head = "") => `<html lang="he"><head>${head}</head><body>${body}</body></html>`;
const PAGES = {
  [`${ORIGIN}/`]: html(
    `<header><nav><a href="/אדריכלות">אדריכלות</a><a href="/צור-קשר">צור קשר</a><a href="/noindex-page">x</a></nav></header>
     <h1>הגר לושי אדריכלות ועיצוב</h1><p>סטודיו לאדריכלות למגורים בקיסריה. טלפון 054-1234567</p>
     <a href="tel:0541234567">חייגו</a><a href="mailto:studio@hagarlushi.com">מייל</a>`,
    `<title>הגר לושי - אדריכלות</title><meta name="description" content="סטודיו לאדריכלות"><link rel="canonical" href="${ORIGIN}/">
     <script type="application/ld+json">{"@type":"LocalBusiness","name":"Hagar Lushi Studio","telephone":"054-1234567","areaServed":"קיסריה"}</script>`
  ),
  [`${ORIGIN}/אדריכלות`]: html(`<h1>אדריכלות למגורים</h1><h2>תכנון בתים פרטיים</h2><p>אדריכלות למגורים בקיסריה ובשרון</p><a href="/">בית</a>`, `<title>אדריכלות למגורים</title><link rel="canonical" href="${ORIGIN}/אדריכלות">`),
  [`${ORIGIN}/צור-קשר`]: html(`<h1>צור קשר</h1><h1>שני</h1><p>טלפון 052-6123987</p><a href="/">בית</a>`, `<title>הגר לושי - אדריכלות</title><link rel="canonical" href="${ORIGIN}/other"><link rel="canonical" href="${ORIGIN}/third">`),
  [`${ORIGIN}/noindex-page`]: html(`<h1>דף</h1>`, `<title>דף</title><meta name="robots" content="noindex,follow"><script type="application/ld+json">{bad json</script>`),
  [`${ORIGIN}/orphan`]: html(`<h1>יתום</h1>`, `<title>יתום</title><link rel="canonical" href="${ORIGIN}/orphan">`)
};

function fakeCrawl({ fail = [] } = {}) {
  return async () => {
    const urls = Object.keys(PAGES).filter((u) => !fail.includes(u));
    return {
      pages: urls.map((u) => ({ url: u, html: PAGES[u], status: 200, finalUrl: u, xRobotsTag: null })),
      report: { startUrl: ORIGIN, siteHost: "hagarlushi.com", sitemap: "sitemap urlset", pagesDiscovered: 6, pagesSelected: 5, pagesFetched: urls.length, discoveredVia: {}, failed: fail.map((u) => ({ url: u, reason: "timeout" })), skipped: [{ url: `${ORIGIN}/privacy`, reason: "utility page" }] },
      sitemapPageKeys: ["hagarlushi.com/", "hagarlushi.com/אדריכלות", "hagarlushi.com/orphan"],
      origin: ORIGIN,
      sitemapRead: true
    };
  };
}
const fakeFetch = async (url) => (url.endsWith("/robots.txt") ? { ok: true, status: 200, html: "User-agent: *\nDisallow: /orphan\n" } : { ok: false, status: 404, error: "HTTP 404" });

function fakeGsc() {
  const calls = [];
  return {
    calls,
    fetchQueryPageRows: async (siteUrl, inp) => {
      calls.push({ siteUrl, ...inp });
      return [
        { query: "אדריכלות למגורים", page: `${ORIGIN}/אדריכלות`, clicks: 5, impressions: 100, position: 6 },
        { query: "אדריכלות למגורים", page: `${ORIGIN}/`, clicks: 1, impressions: 50, position: 12 },
        { query: "אדריכלית בקיסריה", page: `${ORIGIN}/`, clicks: 0, impressions: 20, position: 25 },
        { query: "שאילתה לא מאושרת", page: `${ORIGIN}/`, clicks: 9, impressions: 900, position: 2 }
      ];
    }
  };
}

async function setup({ gscConnected = true } = {}) {
  const fake = createFakeFirestore();
  const store = loadWithFake(fake, STORE);
  const db = fake.admin.firestore();
  await db.collection("businesses").doc(BIZ).set({ name: "Hagar Lushi Studio", website: "hagarlushi.com", geographicMarkets: ["קיסריה"] });
  await db.collection("businessServices").doc("svcArch").set({ businessId: BIZ, name: "אדריכלות למגורים", ownerStatus: "confirmed", priority: "high", facets: { audiences: [{ value: "משפחות", provenance: "website", sourceUrl: `${ORIGIN}/אדריכלות` }] } });
  if (gscConnected) await db.collection("integrations").doc(`${BIZ}_search_console`).set({ status: "connected", propertyId: "sc-domain:hagarlushi.com" });
  const topic = (id, title, status, queries) => db.collection("searchTopics").doc(id).set({ businessId: BIZ, title, queries, status, source: "gsc", sources: ["gsc", "semrush"], addedBy: "system", seedRefs: [{ seedKey: "k1", phrase: "אדריכלות למגורים", kind: "service", serviceId: "svcArch", serviceName: "אדריכלות למגורים", components: [{ dimension: "services", value: "אדריכלות למגורים", provenance: "owner" }] }], qualificationReasons: [{ code: "matches_confirmed_service", detail: "אדריכלות למגורים" }] });
  await topic("tApproved", "אדריכלות למגורים", "priority", ["אדריכלות למגורים", "אדריכלית בקיסריה"]);
  await topic("tNew", "שאילתה לא מאושרת", "new", ["שאילתה לא מאושרת"]);
  await topic("tExcluded", "עיצוב משרדים", "exclude", ["עיצוב משרדים"]);
  await db.collection("keywords").doc("kw1").set({ businessId: BIZ, topicId: "tApproved", query: "אדריכלות למגורים", source: "gsc", sourceList: ["gsc", "semrush"], sources: { gsc: { metrics: { impressions: 300, clicks: 9, position: 8 } }, semrush: { volume: 170, difficulty: 22, report: "phrase_related" } }, excludedByRule: null });
  await db.collection("keywords").doc("kw2").set({ businessId: BIZ, topicId: "tApproved", query: "אדריכלית בקיסריה", source: "gsc", sourceList: ["gsc"], sources: { gsc: { metrics: { impressions: 40, clicks: 0, position: 22 } } }, excludedByRule: null });
  await db.collection("searchSnapshots").add({ businessId: BIZ, retrievedAt: { toMillis: () => NOW - 3600000 }, dateRange: { startDate: "2026-09-10", endDate: "2026-10-08" }, data: { clicks: 20, impressions: 1500, ctr: 0.013, avgPosition: 14 } });
  await db.collection("trafficSnapshots").add({ businessId: BIZ, retrievedAt: { toMillis: () => NOW - 3600000 }, dateRange: { startDate: "28daysAgo", endDate: "today" }, data: { sessions: 400, totalUsers: 300, conversions: 3, engagementRate: 0.5, byChannel: [{ channel: "Organic Search", sessions: 150 }] } });
  const gsc = fakeGsc();
  const deps = (extra = {}) => ({ cheerio, crawlSite: fakeCrawl(extra), fetchPage: fakeFetch, gscAdapter: gsc, nowMs: extra.nowMs || NOW });
  return { fake, store, db, gsc, deps };
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

(async () => {
  await test("1/2 only approved Search Topics are analyzed", async () => {
    const t = await setup();
    const run = await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    assert.deepStrictEqual(run.inputs.approvedTopicIds, ["tApproved"]);
    const ti = t.fake.rows("topicIntelligence");
    assert.deepStrictEqual(ti.map((x) => x.topicId), ["tApproved"], "new / excluded topics are not M4 targets");
    assert.strictEqual(run.inputs.topicStatusCounts.new, 1);
  });

  await test("3/4 GSC and Semrush stay distinct; aggregation keeps raw-query provenance", async () => {
    const t = await setup();
    const before = JSON.stringify(t.fake.rows("keywords"));
    await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    const ti = t.fake.rows("topicIntelligence")[0];
    assert.strictEqual(ti.gscCurrent.status, "available");
    assert.strictEqual(ti.gscCurrent.impressions, 170, "only the topic's queries (not the unapproved one)");
    assert.strictEqual(ti.gscCurrent.clicks, 6);
    assert.strictEqual(ti.gscCurrent.avgPosition, 10, "impression-weighted: (600+600+500)/170");
    assert.deepStrictEqual(ti.gscCurrent.rankingDistribution, { "1-3": 0, "4-10": 1, "11-20": 0, "21-50": 1, "51+": 0 });
    assert.strictEqual(ti.gscCurrent.multiplePagesObserved, true, "two pages observed - preserved, not judged");
    assert.strictEqual(ti.gscDiscovery.impressions, 340, "90-day discovery evidence kept as its own block");
    assert.strictEqual(ti.semrush.status, "available");
    assert.strictEqual(ti.semrush.totalMonthlyVolume, 170);
    assert.deepStrictEqual(ti.sourceMix, { gsc: 2, semrush: 1 });
    assert.strictEqual(JSON.stringify(t.fake.rows("keywords")), before, "raw keyword rows untouched");
  });

  await test("5/6 inventory holds only fetched pages; failures and skips are recorded honestly", async () => {
    const t = await setup();
    await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    assert.strictEqual(t.fake.rows("seoPages").length, 5);
    const run2 = await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps({ fail: [`${ORIGIN}/orphan`] }) });
    const pages = t.fake.rows("seoPages");
    assert.ok(!pages.some((p) => p.url === `${ORIGIN}/privacy`), "skipped page never enters the inventory");
    const orphan = pages.find((p) => p.url === `${ORIGIN}/orphan`);
    assert.strictEqual(orphan.crawlStatus, "failed_last_run", "previous observation kept but marked, not presented as current");
    assert.strictEqual(orphan.lastRunReason, "timeout");
    assert.ok(run2.crawl.report.failed.some((f) => f.url === `${ORIGIN}/orphan`));
    assert.strictEqual(run2.summary.pagesAnalyzed, 4);
  });

  await test("7 technical state is observed and deterministic", async () => {
    const robots = { available: true, groups: parseRobotsTxt("User-agent: *\nDisallow: /orphan\n") };
    const ctx = { isSameSite: (u) => u.includes("hagarlushi.com"), robots, sitemapRead: true, sitemapKeys: new Set(["hagarlushi.com/", "hagarlushi.com/אדריכלות"]) };
    const analyzeAll = () => buildInventory(Object.keys(PAGES).map((u) => analyzePage({ url: u, html: PAGES[u], status: 200, finalUrl: u }, cheerio, ctx)), { serviceNames: ["אדריכלות למגורים"] });
    const a = analyzeAll();
    assert.deepStrictEqual(a, analyzeAll(), "same input -> same output");
    const by = (p) => a.find((x) => x.url === `${ORIGIN}${p}`);
    assert.strictEqual(by("/").indexability.state, "indexable");
    assert.strictEqual(by("/").canonical.state, "valid");
    assert.strictEqual(by("/").structuredData.state, "present");
    assert.strictEqual(by("/noindex-page").indexability.state, "non_indexable");
    assert.ok(by("/noindex-page").indexability.reasons.includes("meta robots noindex"));
    assert.strictEqual(by("/noindex-page").structuredData.state, "invalid");
    assert.strictEqual(by("/צור-קשר").canonical.state, "conflicting");
    assert.ok(by("/צור-קשר").diagnostics.some((d) => d.code === "title_duplicate"));
    assert.ok(by("/צור-קשר").diagnostics.some((d) => d.code === "h1_multiple"));
    assert.strictEqual(by("/orphan").robots.state, "blocked");
    assert.strictEqual(by("/orphan").indexability.state, "non_indexable");
    assert.strictEqual(by("/orphan").orphan.state, "no_inbound_from_crawled_pages");
    assert.strictEqual(by("/orphan").orphan.scope, "crawled pages only");
    assert.strictEqual(by("/צור-קשר").sitemap.state, "absent");
    assert.strictEqual(by("/אדריכלות").links.inboundInternalCount, 1);
    assert.strictEqual(by("/אדריכלות").role.role, "service");
    assert.strictEqual(by("/אדריכלות").role.basis, "inferred");
    assert.strictEqual(robotsDecision(parseRobotsTxt("User-agent: *\nDisallow: /a\nAllow: /a/b"), "/a/b/c").state, "crawlable", "longest match wins");
  });

  await test("unknown when the input was not available (robots.txt / sitemap)", async () => {
    const ctx = { isSameSite: () => true, robots: { available: false, reason: "robots.txt: timeout", groups: [] }, sitemapRead: false, sitemapKeys: new Set() };
    const p = analyzePage({ url: `${ORIGIN}/x`, html: PAGES[`${ORIGIN}/orphan`], status: 200 }, cheerio, ctx);
    assert.strictEqual(p.robots.state, "unknown");
    assert.strictEqual(p.sitemap.state, "unknown");
  });

  await test("8/9/10 baselines are immutable, versioned, and reference-ready", async () => {
    const t = await setup();
    await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    const b1 = await t.store.captureBaseline({ businessId: BIZ, capturedBy: "owner@x", nowMs: NOW });
    const v1Snapshot = JSON.stringify(t.fake.rows("baselines")[0]);
    const b2 = await t.store.captureBaseline({ businessId: BIZ, capturedBy: "owner@x", nowMs: NOW + 1000 });
    assert.strictEqual(b1.version, 1);
    assert.strictEqual(b2.version, 2);
    assert.strictEqual(b2.previousBaselineId, `${BIZ}_v1`);
    assert.strictEqual(b2.identicalToPrevious, true, "same content, still a new version");
    const rows = t.fake.rows("baselines");
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(JSON.stringify(rows.find((r) => r.version === 1)), v1Snapshot, "v1 unchanged after v2");
    await assert.rejects(() => t.store.createOnce(t.db.collection("baselines").doc(`${BIZ}_v1`), { x: 1 }), /ALREADY_EXISTS/);
    const topic = b1.topics[0];
    for (const f of ["impressions", "clicks", "ctr", "avgPosition", "rankingDistribution", "period", "pages"]) assert.ok(topic.gscCurrent[f] !== undefined, `topic baseline has ${f}`);
    assert.ok(topic.queryCount === 2);
    const page = b1.pages.find((p) => p.url === `${ORIGIN}/אדריכלות`);
    assert.strictEqual(page.indexability, "indexable");
    assert.ok(b1.business.traffic.organicSessions === 150);
    assert.ok(b1.period.gscQueryPage.startDate && b1.period.gscQueryPage.endDate);
    assert.deepStrictEqual(b1.referenceKeys.topicIds, ["tApproved"]);
    assert.strictEqual(b1.availability.semrush, "not_available");
    assert.strictEqual(t.fake.rows("businesses").find((x) => x.id === BIZ).latestBaselineId, `${BIZ}_v2`);
  });

  await test("baseline without any intelligence run records what is missing", async () => {
    const t = await setup();
    const b = await t.store.captureBaseline({ businessId: BIZ, nowMs: NOW });
    assert.strictEqual(b.availability.intelligenceRun, "not_available");
    assert.deepStrictEqual(b.topics, []);
    assert.strictEqual(b.business.searchConsole.status, "available");
  });

  await test("11 identical run reuses the governed GSC result at $0", async () => {
    const t = await setup();
    const r1 = await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    const r2 = await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    assert.strictEqual(r1.gsc.decision, "cache_miss");
    assert.strictEqual(r2.gsc.decision, "cache_hit");
    assert.strictEqual(r2.gsc.providerCalled, false);
    assert.strictEqual(t.gsc.calls.length, 1);
    const hit = t.fake.rows("apiUsage").find((r) => r.status === "cache_hit");
    assert.strictEqual(hit.actualCostUsd, 0);
    assert.strictEqual(hit.provider, "google");
    assert.deepStrictEqual(t.fake.rows("topicIntelligence")[0].gscCurrent.impressions, 170, "same intelligence from cache");
  });

  await test("12 changed analysis period is a cache miss", async () => {
    const t = await setup();
    await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    const r = await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps({ nowMs: NOW + 86400000 }) });
    assert.strictEqual(r.gsc.decision, "cache_miss");
    assert.strictEqual(t.gsc.calls.length, 2);
  });

  await test("13 cache lookup failure fails closed: no GSC call, data marked not available", async () => {
    const t = await setup();
    // loadInputs = 5 queries + 3 doc gets; the governor's cache lookup is next
    t.fake.failQueriesAfter(5);
    const r = await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() }).catch((e) => ({ thrown: e.message }));
    t.fake.failQueriesAfter(Infinity);
    assert.strictEqual(t.gsc.calls.length, 0, "provider not called");
    const usage = t.fake.rows("apiUsage");
    assert.ok(usage.some((u) => u.status === "blocked_cache_unavailable" && u.providerCalled === false));
    void r;
  });

  await test("13b quota exhausted: blocked, provider not called, run still honest", async () => {
    const t = await setup();
    for (let i = 0; i < 10; i++) t.fake.seed("apiUsage", { provider: "google", operation: "searchConsoleQueryPage", businessId: BIZ, status: "success", providerCalled: true, inputHash: `x${i}`, retrievedAtMs: Date.now() - 1000 });
    const r = await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    assert.strictEqual(r.gsc.status, "not_available");
    assert.strictEqual(r.gsc.blockedReason, "blocked_by_quota");
    assert.strictEqual(t.gsc.calls.length, 0);
    const ti = t.fake.rows("topicIntelligence")[0];
    assert.strictEqual(ti.gscCurrent.status, "not_available");
    assert.ok(ti.missing.includes("gsc_current_not_available"));
  });

  await test("GSC not connected -> not available, no call", async () => {
    const t = await setup({ gscConnected: false });
    const r = await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    assert.strictEqual(r.gsc.status, "not_available");
    assert.strictEqual(t.gsc.calls.length, 0);
    assert.strictEqual(t.fake.rows("apiUsage").length, 0);
  });

  await test("15/16 no tasks/opportunities/pages created; owner status untouched", async () => {
    const t = await setup();
    const before = JSON.stringify(t.fake.rows("searchTopics"));
    await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    await t.store.captureBaseline({ businessId: BIZ, nowMs: NOW });
    assert.strictEqual(JSON.stringify(t.fake.rows("searchTopics")), before);
    for (const c of ["tasks", "opportunities", "contentAssets", "pages", "decisions", "impactPredictions"]) assert.strictEqual(t.fake.rows(c).length, 0, c);
  });

  await test("17 GEO readiness is evidence-based and never claims AI visibility", async () => {
    const t = await setup();
    const r = await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    const s = Object.fromEntries(r.geoReadiness.signals.map((x) => [x.key, x]));
    assert.strictEqual(s.business_identity.status, "present");
    assert.ok(s.business_identity.evidencePages.includes(`${ORIGIN}/`));
    assert.strictEqual(s.services_explicit.status, "present");
    assert.strictEqual(s.locations_explicit.status, "present");
    assert.strictEqual(s.contact_details.status, "present");
    assert.strictEqual(s.fact_consistency.status, "partial", "two different phone numbers on different pages");
    // issue #36: each number is traceable to its page and source
    const byNum = Object.fromEntries(s.fact_consistency.details.map((d) => [d.normalized, d]));
    assert.ok(byNum["+972541234567"].pages.some((p) => p.url === `${ORIGIN}/` && p.sources.some((x) => x.source === "tel_link")));
    assert.ok(byNum["+972526123987"].pages.some((p) => p.url === `${ORIGIN}/צור-קשר` && p.sources.some((x) => x.source === "visible_text" && x.strength === "labelled")));
    assert.ok(!/,.*,.*,/.test(s.fact_consistency.observation), "concise observation, no dump");
    assert.strictEqual(s.structured_data_coverage.status, "partial");
    assert.ok(r.geoReadiness.signals.every((x) => x.basis === "observed" && ["present", "partial", "missing", "unknown"].includes(x.status)));
    assert.ok(/not external AI visibility/.test(r.geoReadiness.scope));
  });

  await test("18 SERP and Semrush context are not_available, never fabricated", async () => {
    const t = await setup();
    const r = await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    assert.strictEqual(r.serpContext.status, "not_available");
    assert.strictEqual(r.semrush.status, "not_available");
    assert.strictEqual(t.fake.rows("topicIntelligence")[0].serpContext.status, "not_available");
    assert.ok(!t.fake.rows("apiUsage").some((u) => u.provider === "semrush"));
  });

  await test("topics no longer approved are marked superseded, not deleted", async () => {
    const t = await setup();
    await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    await t.db.collection("searchTopics").doc("tApproved").update({ status: "exclude" });
    await t.store.runSearchIntelligence({ businessId: BIZ, deps: t.deps() });
    const ti = t.fake.rows("topicIntelligence");
    assert.strictEqual(ti.length, 1);
    assert.strictEqual(ti[0].superseded, true);
  });

  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL"));
  if (failed.length) {
    console.error(`\n${failed.length} search-intelligence test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll search-intelligence tests passed.");
})();
