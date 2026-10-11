// Issue #36 - phone-number evidence quality. Deterministic, no network.
// Run: node functions/test/phoneEvidence.test.js

const assert = require("assert");
const cheerio = require("cheerio");
const { extractPhones, comparePhones, normalizePhoneCandidate } = require("../phoneEvidence");
const { computeGeoReadiness } = require("../geoReadiness");

const O = "https://www.example-studio.co.il";
const html = (body, head = "") => `<html lang="he"><head>${head}</head><body>${body}</body></html>`;
const jsonLd = (tel) => `<script type="application/ld+json">{"@type":"LocalBusiness","name":"Studio","telephone":"${tel}"}</script>`;

function page(slug, body, head = "") {
  const $ = cheerio.load(html(body, head));
  const telephones = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).html());
      if (typeof j.telephone === "string") telephones.push(j.telephone);
    } catch (err) {
      // invalid JSON-LD is ignored here, as in pageInventory
    }
  });
  const contact = extractPhones($, telephones);
  const url = `${O}/${slug}`;
  return { url, pageKey: `example-studio.co.il/${slug}`, contact };
}

// The pre-#36 extractor, reproduced verbatim for before/after comparison.
const OLD_PHONE_RE = /(?:\+972[-\s]?|0)(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}/g;
function oldExtract(markup) {
  const $ = cheerio.load(html(markup));
  const fullText = $("body").text().replace(/\s+/g, " ").trim();
  const tel = $('a[href^="tel:"]').map((_, el) => $(el).attr("href").slice(4)).get();
  const norm = (p) => {
    const d = String(p).replace(/\D/g, "");
    return d.startsWith("972") ? `0${d.slice(3)}` : d;
  };
  return [...new Set([...(fullText.match(OLD_PHONE_RE) || []), ...tel].map(norm).filter((d) => d.length >= 9))];
}

const numbersOf = (p) => p.contact.phoneEvidence.map((e) => e.normalized);

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
  }
}

// --- A. legitimate formats ----------------------------------------------------
test("A1 Israeli local and international formats normalize to one E.164 number", () => {
  const variants = ["054-1234567", "054 123 4567", "054.123.4567", "0541234567", "+972541234567", "+972 54 123 4567", "+972-54-123-4567", "+972 (0)54-123-4567", "00972541234567", "972541234567", "tel:+972541234567", "tel:%2B972-54-1234567"];
  for (const v of variants) {
    const n = normalizePhoneCandidate(v);
    assert.ok(n, `${v} accepted`);
    assert.strictEqual(n.normalized, "+972541234567", v);
    assert.strictEqual(n.national, "0541234567", v);
  }
  assert.strictEqual(normalizePhoneCandidate("04-6123456").kind, "landline");
  assert.strictEqual(normalizePhoneCandidate("(04) 612-3456").normalized, "+97246123456");
  assert.strictEqual(normalizePhoneCandidate("077-5123456").kind, "voip");
  assert.strictEqual(normalizePhoneCandidate("1-800-123-456").kind, "toll_free");
  assert.strictEqual(normalizePhoneCandidate("+1 (212) 555-0100").normalized, "+12125550100", "explicit foreign tel: kept as E.164");
});

test("A2 labelled and formatted numbers in visible text are found, with spaces / hyphens / parentheses", () => {
  const p = page("contact", `<p>טלפון: 04-612-3456</p><p>נייד 054 123 4567</p><p>Phone (052) 612-3987</p>`);
  assert.deepStrictEqual(numbersOf(p).sort(), ["+97246123456", "+972526123987", "+972541234567"].sort());
  assert.ok(p.contact.phoneEvidence.every((e) => e.source === "visible_text" && e.labelled && e.strength === "labelled"));
});

// --- B. several legitimate phones ------------------------------------------------
test("B1 a business with two real numbers keeps both, distinct, and shown together they are NOT an inconsistency", () => {
  const body = `<footer><p>משרד: 04-612-3456 · נייד: 054-123-4567</p><a href="tel:046123456">חייגו</a></footer>`;
  const pages = [page("", `<h1>בית</h1>${body}`), page("about", `<h1>אודות</h1>${body}`), page("contact", `<h1>צור קשר</h1>${body}`)];
  for (const p of pages) assert.strictEqual(new Set(numbersOf(p)).size, 2);
  const r = comparePhones(pages);
  assert.strictEqual(r.status, "present");
  assert.strictEqual(r.details.length, 2);
  assert.ok(/shown together/.test(r.observation) && /not an inconsistency/.test(r.observation));
});

// --- C. numeric noise ----------------------------------------------------------------
test("C1 IDs, counters, dates, page numbers and long generated sequences are not phones", () => {
  const noise = `
    <p>מספר הזמנה 0541234567890123</p>
    <p>Order #20231015054123456 · SKU 0049351234567 · ID 1696012345678</p>
    <p>צפיות: 1,234,567 · 98765432 לייקים</p>
    <p>תאריך: 2023-05-12 · 12.04.2023 · 05/12/2023</p>
    <p>עמוד 3 מתוך 12 · פרויקט 0457 · 024 תמונות</p>
    <p>ח.פ. 514123456 · ע.מ 039876543</p>
    <p>קוד: 0541234567</p>
    <p>מחיר 05 123 ₪ 4567</p>`;
  const p = page("x", noise);
  assert.deepStrictEqual(numbersOf(p), [], `no phone accepted: ${JSON.stringify(p.contact.phoneEvidence)}`);
  assert.ok(p.contact.phoneRejected >= 1, "bare unlabelled digit runs are counted as rejected");
});

test("C2 placeholder and out-of-plan numbers are rejected", () => {
  for (const v of ["050-0000000", "052-9999999", "01-2345678", "06-1234567", "0541234", "+972 54 123", "tel:123", "tel:+1"]) assert.strictEqual(normalizePhoneCandidate(v), null, v);
});

// --- D. HTML / template noise -----------------------------------------------------
test("D1 script, style, JSON blobs and hidden templates never produce candidates", () => {
  const markup = `
    <script>var cfg={"pageId":"0541234567","ts":1696012345678,"phone":"04-612-3456"};</script>
    <script type="application/json">{"items":[{"id":"0526123987"},{"id":"+972541112233"}]}</script>
    <style>.a{width:0541234567px} .b:after{content:"03-612-3456"}</style>
    <noscript>טלפון 02-612-3456</noscript>
    <template><p>טלפון 08-612-3456</p></template>
    <svg><text>טלפון 09-612-3456</text></svg>
    <div hidden>טלפון 03-712-3456</div>
    <p>טקסט רגיל בלי טלפון</p>`;
  const p = page("x", markup);
  assert.deepStrictEqual(numbersOf(p), [], JSON.stringify(p.contact.phoneEvidence));
  // the old extractor read all of these
  assert.ok(oldExtract(markup).length >= 5, `old extractor: ${oldExtract(markup).join(", ")}`);
});

test("D2 a page-builder style page: old extractor dumps noise, new one keeps only the real number", () => {
  const markup = `
    <nav><a href="/">בית</a><a href="/p/0412345678901">פרויקטים</a></nav>
    <div data-id="0526123987" class="w-0541234567">
      <span>023</span><span>4567890</span><span>0412345678</span>
    </div>
    <script>window.__DATA__={"ids":[0541239876,0731234567,0897654321],"v":"0216549870"}</script>
    <p>גלריה 1 / 054 · 2023</p>
    <footer><p>טלפון: 054-6123987</p><a href="tel:+972546123987">התקשרו</a></footer>`;
  const before = oldExtract(markup);
  const p = page("", markup);
  assert.ok(before.length >= 6, `before: ${before.length} values (${before.join(", ")})`);
  assert.deepStrictEqual([...new Set(numbersOf(p))], ["+972546123987"], JSON.stringify(p.contact.phoneEvidence));
  const footer = p.contact.phoneEvidence.find((e) => e.source === "visible_text");
  assert.strictEqual(footer.location, "site_chrome", "footer text is recorded as site chrome");
});

test("D3 repeated footer/nav template content does not create a discrepancy", () => {
  const footer = `<footer><nav><a href="/1">1</a><a href="/2">2</a></nav><p>טל' 04-612-3456</p><p>© 2024 · 0457 פרויקטים</p></footer>`;
  const pages = ["", "a", "b", "c"].map((s) => page(s, `<h1>${s}</h1><p>עמוד ${s} מתוך 12</p>${footer}`));
  const r = comparePhones(pages);
  assert.strictEqual(r.status, "present");
  assert.strictEqual(r.details.length, 1);
  assert.strictEqual(r.details[0].pageCount, 4);
});

// --- E. provenance -------------------------------------------------------------------
test("E1 every accepted number is traceable to page, source, location and raw text", () => {
  const pages = [
    page("", `<p>טלפון 04-612-3456</p>`, jsonLd("+972-4-612-3456")),
    page("contact", `<a href="tel:054-6123987">054-6123987</a>`)
  ];
  for (const p of pages) for (const e of p.contact.phoneEvidence) assert.ok(e.raw && e.normalized && e.display && e.source && e.location && e.strength, JSON.stringify(e));
  const r = comparePhones(pages);
  for (const d of r.details) {
    assert.ok(d.pages.length >= 1);
    for (const pg of d.pages) {
      assert.ok(pg.url.startsWith(O) && pg.pageKey && pg.path);
      assert.ok(pg.sources.length && pg.sources.every((s) => s.source && s.location && s.raw));
    }
  }
  const home = r.details.find((d) => d.normalized === "+97246123456");
  assert.deepStrictEqual(home.pages[0].sources.map((s) => s.source).sort(), ["structured_data", "visible_text"]);
});

// --- F. false-discrepancy protection ------------------------------------------------
test("F1 the same number formatted differently on different pages is ONE number - no finding", () => {
  const pages = [
    page("", `<p>טלפון: 054-6123987</p>`),
    page("about", `<p>Phone +972 54 612 3987</p>`),
    page("contact", `<a href="tel:+972546123987">חייגו</a>`, jsonLd("00972546123987")),
    page("team", `<p>נייד (054) 612-3987</p>`)
  ];
  const r = comparePhones(pages);
  assert.strictEqual(r.status, "present");
  assert.strictEqual(r.details.length, 1);
  assert.strictEqual(r.details[0].pageCount, 4);
});

test("F2 a difference resting only on weak (unlabelled) text is insufficient evidence, not a conflict", () => {
  const pages = [page("", `<p>טלפון: 054-6123987</p>`), page("gallery", `<p>פרויקט 04-612-3456</p>`)];
  const r = comparePhones(pages);
  assert.strictEqual(r.status, "unknown");
  assert.strictEqual(r.insufficientEvidence, true);
  assert.ok(/not enough evidence/.test(r.observation));
});

test("F3 no trustworthy phone at all -> explicit unknown, never a manufactured discrepancy", () => {
  const r = comparePhones([page("", `<p>ID 0541234567890</p>`), page("b", `<script>var x="04-612-3456"</script>`)]);
  assert.strictEqual(r.status, "unknown");
  assert.strictEqual(r.insufficientEvidence, true);
  assert.deepStrictEqual(r.details, []);
});

// --- G. real discrepancy ---------------------------------------------------------------
test("G1 two different legitimate numbers on different pages DO produce the finding, explained per page", () => {
  const pages = [page("", `<footer><a href="tel:046123456">04-612-3456</a></footer>`), page("contact", `<p>טלפון: 054-6123987</p>`)];
  const r = comparePhones(pages);
  assert.strictEqual(r.status, "partial");
  assert.strictEqual(r.conflict.kind, "different_numbers_on_different_pages");
  assert.ok(/2 different phone numbers on different pages/.test(r.observation));
  assert.ok(r.observation.includes("04-6123456") && r.observation.includes("054-6123987"));
  assert.deepStrictEqual(r.evidencePages.sort(), [`${O}/`, `${O}/contact`]);
});

test("G2 structured data declaring different numbers on different pages is a discrepancy", () => {
  const both = `<p>טלפון 04-612-3456</p>`;
  const pages = [page("", both, jsonLd("04-612-3456")), page("contact", both, jsonLd("054-6123987"))];
  const r = comparePhones(pages);
  assert.strictEqual(r.status, "partial");
  assert.strictEqual(r.conflict.kind, "structured_data_disagrees");
});

// --- integration with GEO readiness ----------------------------------------------------
test("GEO readiness fact_consistency uses the validated comparison and carries provenance", () => {
  const pages = [page("", `<p>טלפון: 054-6123987</p>`), page("contact", `<p>Phone +972 54 612 3987</p>`)].map((p) => ({ ...p, title: "t", h1: [], h2: [], _text: "", structuredData: { state: "missing", types: [] }, structuredFacts: { names: [], telephones: [], addresses: [], areaServed: [], urls: [] }, contact: { ...p.contact, emails: [] } }));
  const geo = computeGeoReadiness(pages, { business: { name: "Studio" }, services: [] });
  const s = geo.signals.find((x) => x.key === "fact_consistency");
  assert.strictEqual(s.status, "present");
  assert.strictEqual(s.basis, "observed");
  assert.ok(s.details[0].pages.length === 2);
  assert.ok(/phone-evidence v2/.test(s.method));
  const undef = JSON.stringify(s, (k, v) => (v === undefined ? "__UNDEFINED__" : v));
  assert.ok(!undef.includes("__UNDEFINED__"), "no undefined values (Firestore)");
});

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
if (failed.length) {
  console.error(`\n${failed.length} phone-evidence test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} phone-evidence tests passed.`);
