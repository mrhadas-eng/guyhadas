#!/usr/bin/env node
// Issue #36 - local before/after probe for phone-number evidence.
// Not deployed logic: a developer tool. Fetches the given pages (plain GET,
// no provider, no Firestore) and prints, per page, what the pre-#36
// extractor found versus the new evidence, then the cross-page verdict.
//
//   cd functions && node tools/phoneEvidenceProbe.js https://www.hagarlushi.com/ https://www.hagarlushi.com/contact
//
// Tip: pass the same pages the M4 crawl selected (seoPages URLs).

const cheerio = require("cheerio");
const { extractPhones, comparePhones } = require("../phoneEvidence");

const OLD_PHONE_RE = /(?:\+972[-\s]?|0)(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}/g;

function jsonLdTelephones($) {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n.telephone === "string") out.push(n.telephone);
    Object.values(n).forEach(visit);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).html()));
    } catch (err) {
      // invalid JSON-LD ignored
    }
  });
  return out;
}

function oldPhones($, tels) {
  const fullText = $("body").text().replace(/\s+/g, " ").trim();
  const telLinks = $('a[href^="tel:"]').map((_, el) => $(el).attr("href").slice(4)).get();
  const norm = (p) => {
    const d = String(p).replace(/\D/g, "");
    return d.startsWith("972") ? `0${d.slice(3)}` : d;
  };
  return [...new Set([...(fullText.match(OLD_PHONE_RE) || []), ...telLinks, ...tels].map(norm).filter((d) => d.length >= 9))];
}

(async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("usage: node tools/phoneEvidenceProbe.js <url> [<url> ...]");
    process.exit(2);
  }
  const pages = [];
  const oldAll = new Set();
  for (const url of urls) {
    const res = await fetch(url, { headers: { "User-Agent": "GuyHadasVisibilityOS-probe/1.0" } });
    const $ = cheerio.load(await res.text());
    const tels = jsonLdTelephones($);
    const before = oldPhones($, tels);
    before.forEach((p) => oldAll.add(p));
    const contact = extractPhones($, tels);
    pages.push({ url, pageKey: url, contact });
    console.log(`\n${url}  (HTTP ${res.status})`);
    console.log(`  BEFORE (pre-#36): ${before.length} value(s)${before.length ? `: ${before.slice(0, 25).join(", ")}${before.length > 25 ? " …" : ""}` : ""}`);
    console.log(`  AFTER: ${contact.phoneEvidence.length} accepted, ${contact.phoneRejected} rejected`);
    for (const e of contact.phoneEvidence) console.log(`    ${e.display.padEnd(16)} ${e.normalized.padEnd(15)} ${e.source}/${e.location} (${e.strength})  raw="${e.raw}"`);
  }
  const verdict = comparePhones(pages);
  console.log(`\nBEFORE verdict: ${oldAll.size > 1 ? `partial - "${oldAll.size} different phone numbers across crawled pages"` : oldAll.size ? "present" : "unknown"}`);
  console.log(`AFTER verdict:  ${verdict.status}${verdict.insufficientEvidence ? " (insufficient evidence)" : ""} - ${verdict.observation}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
