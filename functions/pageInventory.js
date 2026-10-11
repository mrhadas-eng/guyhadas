// GuyHadas Visibility OS - M4 page inventory + technical SEO state
// (docs/MASTER.md §29 Technical SEO Layer, §28.2 Page, §41 M4).
//
// Pure functions over what the crawler actually fetched. Every field is
// either OBSERVED from the fetched HTML/headers/robots.txt/sitemap, or
// explicitly "unknown". Nothing is guessed: a page that was not fetched is
// not in the inventory, and a check whose input was unavailable reports
// "unknown" with the reason.
//
// Scope notes kept on the records themselves:
//   - indexability is CRAWL-DERIVED (status, meta robots, X-Robots-Tag,
//     canonical, robots.txt). Google's own index status is not verified.
//   - inbound links / orphan status are counted among the CRAWLED pages
//     only (crawl is capped), never presented as site-wide truth.
//   - no JavaScript rendering: content injected client-side is not seen.
//
// Diagnostics are observations for M5 to consume - never tasks.

const { extractPhones } = require("./phoneEvidence");
const crypto = require("crypto");
const { canonicalUrl, pageKey } = require("./webUtils");

const INVENTORY_VERSION = 2; // 2: phone evidence with provenance (issue #36)

// --- robots.txt --------------------------------------------------------------

// Minimal, standard-following parser: groups for "*" (and our UA token),
// Allow/Disallow with * and $ wildcards, longest match wins, Allow wins ties.
function parseRobotsTxt(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!current) continue;
      if (field === "allow" || field === "disallow") current.rules.push({ type: field, path: value });
    }
  }
  return groups;
}

function ruleRegex(path) {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path)
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

// returns "crawlable" | "blocked"
function robotsDecision(groups, urlPath, agentToken = "guyhadasvisibilityos") {
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agentToken.includes(a)));
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const g of applicable) {
    for (const r of g.rules) {
      if (r.type === "disallow" && r.path === "") continue; // "Disallow:" = allow all
      let path = urlPath;
      try {
        path = decodeURI(urlPath);
      } catch (err) {
        // keep raw
      }
      if (!ruleRegex(r.path).test(urlPath) && !ruleRegex(r.path).test(path)) continue;
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.type === "allow")) best = { len, type: r.type, path: r.path };
    }
  }
  return best && best.type === "disallow" ? { state: "blocked", rule: `Disallow: ${best.path}` } : { state: "crawlable", rule: best ? `Allow: ${best.path}` : null };
}

// --- single page -------------------------------------------------------------

function textOf($, sel) {
  return $(sel)
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean);
}

function hasNoindex(value) {
  return /(^|[\s,])(noindex|none)([\s,]|$)/i.test(value || "");
}

function parseJsonLd($) {
  const blocks = [];
  let invalid = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      blocks.push(JSON.parse(raw));
    } catch (err) {
      invalid++;
    }
  });
  const types = new Set();
  const facts = { names: [], telephones: [], addresses: [], areaServed: [], urls: [] };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const t = node["@type"];
    (Array.isArray(t) ? t : t ? [t] : []).forEach((x) => types.add(String(x)));
    if (typeof node.name === "string") facts.names.push(node.name);
    if (typeof node.telephone === "string") facts.telephones.push(node.telephone);
    if (node.address) facts.addresses.push(typeof node.address === "string" ? node.address : JSON.stringify(node.address));
    if (node.areaServed) facts.areaServed.push(typeof node.areaServed === "string" ? node.areaServed : JSON.stringify(node.areaServed));
    if (typeof node.url === "string") facts.urls.push(node.url);
    Object.values(node).forEach((v) => typeof v === "object" && visit(v));
  };
  blocks.forEach(visit);
  return { blockCount: blocks.length, invalidCount: invalid, types: [...types].sort(), facts };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Analyze one fetched page. `fetched` = { url, html, status, finalUrl, xRobotsTag }.
function analyzePage(fetched, cheerio, ctx) {
  const url = fetched.url;
  const $ = cheerio.load(fetched.html || "");
  const isSameSite = ctx.isSameSite;

  const title = textOf($, "head > title")[0] || $("title").first().text().trim() || null;
  const metaDescription = ($('meta[name="description"]').attr("content") || "").trim() || null;
  const h1 = textOf($, "h1");
  const h2 = textOf($, "h2").slice(0, 20);
  const lang = $("html").attr("lang") || null;

  const metaRobots = $('meta[name="robots"], meta[name="googlebot"]')
    .map((_, el) => $(el).attr("content") || "")
    .get()
    .join(", ");

  const canonicalHrefs = $('link[rel="canonical"]')
    .map((_, el) => $(el).attr("href"))
    .get()
    .filter(Boolean);
  const canonicalTargets = [...new Set(canonicalHrefs.map((h) => canonicalUrl(h, url)).filter(Boolean))];
  let canonical;
  if (canonicalHrefs.length === 0) canonical = { state: "missing", target: null };
  else if (canonicalTargets.length > 1) canonical = { state: "conflicting", target: null, targets: canonicalTargets, reason: "multiple different canonical tags" };
  else if (canonicalTargets.length === 1 && pageKey(canonicalTargets[0]) === pageKey(url)) canonical = { state: "valid", target: canonicalTargets[0] };
  else if (canonicalTargets.length === 1) canonical = { state: "points_elsewhere", target: canonicalTargets[0] };
  else canonical = { state: "unknown", target: null, reason: "canonical href could not be parsed" };

  const jsonLd = parseJsonLd($);
  const microdata = $("[itemtype]").length;
  let structuredData;
  if (jsonLd.blockCount === 0 && jsonLd.invalidCount === 0 && microdata === 0) structuredData = { state: "missing", types: [] };
  else if (jsonLd.invalidCount > 0 && jsonLd.blockCount === 0 && microdata === 0) structuredData = { state: "invalid", types: [], reason: `${jsonLd.invalidCount} JSON-LD block(s) failed to parse` };
  else structuredData = { state: "present", types: jsonLd.types, jsonLdBlocks: jsonLd.blockCount, invalidJsonLdBlocks: jsonLd.invalidCount, microdataItems: microdata };

  // Links (before stripping chrome - navigation links are real internal links).
  const outbound = new Set();
  let externalLinks = 0;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    const target = canonicalUrl(href, url);
    if (!target) return;
    if (isSameSite(target)) {
      if (pageKey(target) !== pageKey(url)) outbound.add(pageKey(target));
    } else externalLinks++;
  });
  const mailLinks = $('a[href^="mailto:"]').map((_, el) => $(el).attr("href").slice(7).split("?")[0]).get();

  const $body = cheerio.load(fetched.html || "");
  $body("script, style, noscript, nav, header, footer").remove();
  const bodyText = $body("body").text().replace(/\s+/g, " ").trim();
  const fullText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").filter(Boolean).length : 0;

  // Phone numbers: tel: links, JSON-LD and rendered text only (never
  // script/style), numbering-plan validated, with per-number provenance
  // (functions/phoneEvidence.js, issue #36).
  const { phones, phoneEvidence, phoneRejected } = extractPhones($, jsonLd.facts.telephones);
  const emails = [...new Set([...(fullText.match(EMAIL_RE) || []), ...mailLinks].map((e) => e.toLowerCase()))];

  // Indexability (crawl-derived).
  const reasons = [];
  if (fetched.status && fetched.status !== 200) reasons.push(`HTTP ${fetched.status}`);
  if (hasNoindex(metaRobots)) reasons.push("meta robots noindex");
  if (hasNoindex(fetched.xRobotsTag)) reasons.push("X-Robots-Tag noindex");
  if (canonical.state === "points_elsewhere") reasons.push(`canonical points to ${canonical.target}`);
  const robots = ctx.robots;
  let robotsState;
  if (!robots.available) robotsState = { state: "unknown", reason: robots.reason };
  else {
    let path = "/";
    try {
      path = new URL(url).pathname || "/";
    } catch (err) {
      path = "/";
    }
    robotsState = robotsDecision(robots.groups, path);
  }
  if (robotsState.state === "blocked") reasons.push(`robots.txt ${robotsState.rule}`);
  const indexability = reasons.length ? { state: "non_indexable", reasons } : { state: "indexable", reasons: [], scope: "crawl-derived; Google index status not verified" };

  const sitemap = ctx.sitemapRead ? { state: ctx.sitemapKeys.has(pageKey(url)) ? "present" : "absent" } : { state: "unknown", reason: "sitemap could not be read" };

  return {
    url,
    pageKey: pageKey(url),
    finalUrl: fetched.finalUrl || url,
    httpStatus: fetched.status || null,
    lang,
    title,
    metaDescription,
    h1,
    h2,
    wordCount,
    indexability,
    canonical,
    robots: robotsState,
    metaRobots: metaRobots || null,
    xRobotsTag: fetched.xRobotsTag || null,
    sitemap,
    structuredData,
    structuredFacts: jsonLd.facts,
    links: { outboundInternal: [...outbound].sort(), outboundInternalCount: outbound.size, externalCount: externalLinks },
    contact: { phones, emails, phoneEvidence, phoneRejected },
    // kept for GEO/topic matching in this run only; not persisted in full
    _text: `${title || ""} ${h1.join(" ")} ${h2.join(" ")} ${bodyText}`.slice(0, 20000)
  };
}

// --- whole inventory ---------------------------------------------------------

function inferRole(page, ctx) {
  let path = "/";
  try {
    path = decodeURI(new URL(page.url).pathname);
  } catch (err) {
    path = "/";
  }
  const heading = `${page.title || ""} ${page.h1.join(" ")}`.toLowerCase();
  if (path === "/" || path === "") return { role: "homepage", basis: "observed", rule: "site root" };
  if (/contact|צור-קשר|צרו-קשר|יצירת-קשר/i.test(path)) return { role: "contact", basis: "inferred", rule: "URL contains contact" };
  if (/about|אודות/i.test(path)) return { role: "about", basis: "inferred", rule: "URL contains about" };
  if (/blog|post|מאמר|בלוג/i.test(path)) return { role: "article", basis: "inferred", rule: "URL contains blog/article" };
  const svc = (ctx.serviceNames || []).find((n) => n && heading.includes(n.toLowerCase()));
  if (svc) return { role: "service", basis: "inferred", rule: `title/H1 contains confirmed service "${svc}"` };
  if (/project|portfolio|פרויקט|עבודות/i.test(path)) return { role: "project", basis: "inferred", rule: "URL contains project/portfolio" };
  return { role: "other", basis: "inferred", rule: "no rule matched" };
}

// pages: analyzePage results. Adds inbound links, orphan scope, duplicate
// metadata and diagnostics. Deterministic: sorted by URL.
function buildInventory(pages, ctx) {
  const sorted = pages.slice().sort((a, b) => a.pageKey.localeCompare(b.pageKey));
  const keys = new Set(sorted.map((p) => p.pageKey));
  const inbound = new Map(sorted.map((p) => [p.pageKey, new Set()]));
  for (const p of sorted) for (const target of p.links.outboundInternal) if (inbound.has(target)) inbound.get(target).add(p.pageKey);
  const titles = new Map();
  const descs = new Map();
  for (const p of sorted) {
    if (p.title) titles.set(p.title, (titles.get(p.title) || 0) + 1);
    if (p.metaDescription) descs.set(p.metaDescription, (descs.get(p.metaDescription) || 0) + 1);
  }
  const homeKey = sorted.find((p) => {
    try {
      return new URL(p.url).pathname === "/";
    } catch (err) {
      return false;
    }
  });

  return sorted.map((p) => {
    const inboundFrom = [...inbound.get(p.pageKey)].sort();
    const isHome = homeKey && homeKey.pageKey === p.pageKey;
    const role = inferRole(p, ctx);
    const diagnostics = [];
    const add = (code, detail = null, basis = "observed") => diagnostics.push({ code, detail, basis });
    if (p.indexability.state === "non_indexable") add("non_indexable", p.indexability.reasons.join("; "));
    if (p.canonical.state === "missing") add("canonical_missing");
    if (p.canonical.state === "conflicting") add("canonical_conflicting", (p.canonical.targets || []).join(", "));
    if (p.canonical.state === "points_elsewhere") add("canonical_points_elsewhere", p.canonical.target);
    if (p.robots.state === "blocked") add("blocked_by_robots", p.robots.rule);
    if (p.sitemap.state === "absent") add("not_in_sitemap");
    if (p.structuredData.state === "missing") add("structured_data_missing");
    if (p.structuredData.state === "invalid") add("structured_data_invalid", p.structuredData.reason);
    if (!p.title) add("title_missing");
    else if (titles.get(p.title) > 1) add("title_duplicate", `${titles.get(p.title)} crawled pages share this title`);
    if (!p.metaDescription) add("meta_description_missing");
    else if (descs.get(p.metaDescription) > 1) add("meta_description_duplicate", `${descs.get(p.metaDescription)} crawled pages share this description`);
    if (p.h1.length === 0) add("h1_missing");
    if (p.h1.length > 1) add("h1_multiple", `${p.h1.length} H1 elements`);
    if (!isHome && inboundFrom.length === 0) add("no_inbound_from_crawled_pages", "orphan candidate within the crawled set only");
    else if (!isHome && inboundFrom.length === 1) add("underlinked_candidate", "linked from 1 crawled page", "inferred");

    const { _text, ...rest } = p;
    void _text;
    return {
      ...rest,
      role,
      links: {
        ...p.links,
        inboundInternal: inboundFrom,
        inboundInternalCount: inboundFrom.length,
        scope: `counted among ${keys.size} crawled pages`
      },
      orphan: isHome ? { state: "not_applicable" } : { state: inboundFrom.length === 0 ? "no_inbound_from_crawled_pages" : "linked", scope: "crawled pages only" },
      diagnostics,
      inventoryVersion: INVENTORY_VERSION
    };
  });
}

function pageDocId(businessId, key) {
  return `${businessId}_${crypto.createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

module.exports = { parseRobotsTxt, robotsDecision, analyzePage, buildInventory, inferRole, pageDocId, INVENTORY_VERSION };
