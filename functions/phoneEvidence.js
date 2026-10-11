// GuyHadas Visibility OS - M4 phone-number evidence (issue #36).
//
// Extracts realistic business phone numbers from ONE crawled page, with
// provenance, and compares them across pages for the GEO readiness
// `fact_consistency` signal. Pure and deterministic: no network, no LLM.
//
// Principles:
//   - Candidates come from three sources, each recorded:
//       tel_link        <a href="tel:...">                (strong)
//       structured_data JSON-LD "telephone"               (strong)
//       visible_text    rendered text nodes only - never <script>, <style>,
//                       <noscript>, <template>, <svg>, ... (labelled | weak)
//   - Visible-text matches must stand alone (digit boundaries - never a
//     window inside a longer number) and must look like a phone number to a
//     reader: either labelled (a phone word such as "טלפון"/"phone" just
//     before it) or written in phone formatting (separators or +972).
//     Bare unlabelled digit runs (IDs, order numbers) are rejected.
//   - Every candidate is validated against the Israeli numbering plan
//     (mobile 05X, VoIP 07X, landline 02/03/04/08/09, 1-700/1-800/1-599) and
//     normalized to E.164 (+972...), so "054-1234567", "+972 54 123 4567",
//     "+972 (0)54-123-4567" and "00972541234567" are one number. Explicit
//     tel: links / JSON-LD in another country code are kept as E.164.
//   - Placeholder subscriber numbers (all one repeated digit) are rejected.
//
// Limitation (documented): visible-text detection targets Israeli formats;
// non-Israeli numbers are recognised only from tel: links and JSON-LD.

const PHONE_EVIDENCE_VERSION = 2;

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "canvas", "select", "textarea", "head"]);
const CHROME_TAGS = new Set(["header", "footer", "nav"]);
const CHROME_ROLES = new Set(["banner", "contentinfo", "navigation"]);
const KEYWORDS = ["טלפון", "טל'", "טל.", "טל:", "טל ", "נייד", "פלאפון", "סלולרי", "חייגו", "התקשרו", "וואטסאפ", "ווטסאפ", "phone", "tel", "call", "mobile", "whatsapp", "☎", "📞", "📱"];
const LABEL_WINDOW = 40;

// separator between digit groups: "-", ".", a space, or " - "
const SEP = "(?:\\s?[\\-.]\\s?|\\s)?";
// prefix: +972 / 00972 / 972 (optionally "(0)"), or a national 0X / 05X / 07X area
// code, optionally in parentheses: "(052) 612-3987"
const IL_RE = new RegExp(`(?<![\\w+./-])(?:(?:\\+|00)?972${SEP}(?:\\(0\\)${SEP})?(?:[23489]|5\\d|7\\d)|\\(?0(?:[23489]|5\\d|7\\d)\\)?)(?:${SEP}\\d){7}(?![\\w])(?![\\-./]\\d)`, "g");
const TOLL_RE = new RegExp(`(?<![\\w+./-])1${SEP}(?:700|800|599)${SEP}\\d{2,3}${SEP}\\d{3,4}(?![\\w])(?![\\-./]\\d)`, "g");

function placeholder(subscriber) {
  return /^(\d)\1+$/.test(subscriber);
}

// Israeli national number (leading 0, or 1-700/1-800/1-599) -> classified
// record, or null when it is not a valid number in the numbering plan.
function classifyIsraeli(national) {
  let kind = null;
  if (/^05\d{8}$/.test(national)) kind = "mobile";
  else if (/^07[1-9]\d{7}$/.test(national)) kind = "voip";
  else if (/^0[23489][2-9]\d{6}$/.test(national)) kind = "landline";
  else if (/^1(700|800|599)\d{6}$/.test(national)) kind = "toll_free";
  if (!kind) return null;
  if (kind !== "toll_free" && placeholder(national.slice(-7))) return null;
  const e164 = kind === "toll_free" ? `+972${national}` : `+972${national.slice(1)}`;
  return { normalized: e164, national, kind, display: displayOf(national, kind) };
}

function displayOf(national, kind) {
  if (kind === "toll_free") return `${national.slice(0, 1)}-${national.slice(1, 4)}-${national.slice(4, 7)}-${national.slice(7)}`;
  if (kind === "landline") return `${national.slice(0, 2)}-${national.slice(2)}`;
  return `${national.slice(0, 3)}-${national.slice(3)}`;
}

// Normalize any raw candidate. Returns null for anything that is not a
// valid phone number.
function normalizePhoneCandidate(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/^tel:/i, "");
  try {
    s = decodeURIComponent(s);
  } catch (err) {
    // keep the raw string
  }
  s = s.replace(/\(0\)/g, "").trim();
  const international = /^(\+|00)/.test(s);
  let digits = s.replace(/\D/g, "");
  if (s.startsWith("00")) digits = digits.slice(2);
  if (!digits) return null;
  if (digits.startsWith("972")) {
    const rest = digits.slice(3);
    return classifyIsraeli(rest.startsWith("1") ? rest : `0${rest}`);
  }
  if (international) {
    // explicit number in another country (only tel: links / JSON-LD reach here)
    if (digits.length >= 8 && digits.length <= 15 && !/^(\d)\1+$/.test(digits)) return { normalized: `+${digits}`, national: null, kind: "international", display: `+${digits}` };
    return null;
  }
  return classifyIsraeli(digits);
}

function hasLabel(text, index, matchLength) {
  const before = text.slice(Math.max(0, index - LABEL_WINDOW), index).toLowerCase();
  const after = text.slice(index + matchLength, index + matchLength + 12).toLowerCase();
  return KEYWORDS.some((k) => before.includes(k.toLowerCase())) || /^\s*[(:]?\s*(טל|phone|tel)/i.test(after);
}

function isFormatted(raw) {
  return /[\s\-.]/.test(raw.trim()) || /^(\+|00)?972/.test(raw.trim());
}

// Rendered text by location; text nodes joined with " · " so numbers from
// different elements can never merge.
function visibleTextSegments(root) {
  const out = { page_content: [], site_chrome: [] };
  const walk = (node, chrome) => {
    if (!node) return;
    if (node.type === "text") {
      const t = String(node.data || "").replace(/\s+/g, " ").trim();
      if (t) out[chrome ? "site_chrome" : "page_content"].push(t);
      return;
    }
    if (node.type !== "tag" && node.type !== "root") return; // script/style/comment/directive nodes
    const name = (node.name || "").toLowerCase();
    if (SKIP_TAGS.has(name)) return;
    const attribs = node.attribs || {};
    if ("hidden" in attribs) return;
    const isChrome = chrome || CHROME_TAGS.has(name) || CHROME_ROLES.has(String(attribs.role || "").toLowerCase());
    for (const c of node.children || []) walk(c, isChrome);
  };
  walk(root, false);
  return { page_content: out.page_content.join(" · "), site_chrome: out.site_chrome.join(" · ") };
}

// $: cheerio instance for the page; jsonLdTelephones: raw strings from
// JSON-LD. Returns { phones, phoneEvidence, phoneRejected }.
function extractPhones($, jsonLdTelephones = []) {
  const evidence = [];
  let rejected = 0;
  const push = (raw, source, location, labelled) => {
    const n = normalizePhoneCandidate(raw);
    if (!n) {
      rejected++;
      return;
    }
    const strength = source === "visible_text" ? (labelled ? "labelled" : "weak") : "strong";
    evidence.push({ raw: String(raw).trim().slice(0, 40), ...n, source, location, labelled: !!labelled, strength });
  };
  $('a[href^="tel:"], a[href^="TEL:"]').each((_, el) => push($(el).attr("href"), "tel_link", "link", true));
  for (const t of jsonLdTelephones) push(t, "structured_data", "json_ld", true);
  const body = $("body")[0] || $.root()[0];
  const segs = visibleTextSegments(body);
  for (const [location, text] of Object.entries(segs)) {
    for (const re of [IL_RE, TOLL_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const raw = m[0];
        const labelled = hasLabel(text, m.index, raw.length);
        if (!labelled && !isFormatted(raw)) {
          rejected++; // bare unlabelled digit run - an ID, not a phone
          continue;
        }
        push(raw, "visible_text", location, labelled);
      }
    }
  }
  // de-duplicate: one entry per (number, source, location), strongest first
  const rank = { strong: 0, labelled: 1, weak: 2 };
  const seen = new Set();
  const phoneEvidence = evidence
    .sort((a, b) => rank[a.strength] - rank[b.strength] || a.normalized.localeCompare(b.normalized))
    .filter((e) => {
      const k = `${e.normalized}|${e.source}|${e.location}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 12);
  const phones = [...new Set(phoneEvidence.map((e) => e.national || e.normalized))].sort();
  return { phones, phoneEvidence, phoneRejected: rejected };
}

// --- cross-page comparison (GEO readiness fact_consistency) ----------------

const TRUSTED = new Set(["strong", "labelled"]);

function pathOf(url) {
  try {
    return decodeURI(new URL(url).pathname) || "/";
  } catch (err) {
    return url;
  }
}

// pages: analyzePage() results ({ url, pageKey, contact: { phoneEvidence } }).
// Returns { status, observation, evidencePages, values, details, ... } for
// the fact_consistency signal. A discrepancy is reported only when two
// pages each show a TRUSTED number (tel: link, JSON-LD or labelled text)
// and their trusted numbers do not overlap, or when JSON-LD declarations
// disagree between pages. Several numbers shown together are not a
// discrepancy; a difference resting only on weak evidence is reported as
// insufficient, never as a conflict.
function comparePhones(pages) {
  const numbers = new Map();
  const trustedByPage = new Map();
  const declaredByPage = new Map();
  for (const p of pages) {
    const ev = (p.contact && p.contact.phoneEvidence) || [];
    for (const e of ev) {
      const cur = numbers.get(e.normalized) || { normalized: e.normalized, display: e.display, kind: e.kind, trusted: false, pages: new Map() };
      if (TRUSTED.has(e.strength)) cur.trusted = true;
      const pg = cur.pages.get(p.pageKey) || { url: p.url, pageKey: p.pageKey, path: pathOf(p.url), sources: [], raw: e.raw };
      if (!pg.sources.some((s) => s.source === e.source && s.location === e.location)) pg.sources.push({ source: e.source, location: e.location, strength: e.strength, raw: e.raw });
      cur.pages.set(p.pageKey, pg);
      numbers.set(e.normalized, cur);
      if (TRUSTED.has(e.strength)) {
        if (!trustedByPage.has(p.pageKey)) trustedByPage.set(p.pageKey, new Set());
        trustedByPage.get(p.pageKey).add(e.normalized);
      }
      if (e.source === "structured_data") {
        if (!declaredByPage.has(p.pageKey)) declaredByPage.set(p.pageKey, new Set());
        declaredByPage.get(p.pageKey).add(e.normalized);
      }
    }
  }
  const list = [...numbers.values()].sort((a, b) => b.pages.size - a.pages.size || a.normalized.localeCompare(b.normalized));
  const details = list.slice(0, 6).map((n) => ({
    normalized: n.normalized,
    display: n.display,
    kind: n.kind,
    trusted: n.trusted,
    pageCount: n.pages.size,
    pages: [...n.pages.values()].sort((a, b) => a.pageKey.localeCompare(b.pageKey)).slice(0, 5)
  }));
  const rejected = pages.reduce((a, p) => a + ((p.contact && p.contact.phoneRejected) || 0), 0);
  const base = { method: `phone-evidence v${PHONE_EVIDENCE_VERSION}: numbering-plan validated, E.164-normalized, page provenance`, details, values: list.map((n) => n.display), rejectedCandidates: rejected };

  if (!list.length) return { ...base, status: "unknown", insufficientEvidence: true, observation: `no trustworthy phone number found on the crawled pages${rejected ? ` (${rejected} numeric strings rejected as not phone numbers)` : ""}`, evidencePages: [] };
  if (list.length === 1) {
    const n = list[0];
    return { ...base, status: "present", observation: `one phone number (${n.display}) used consistently on ${n.pages.size} crawled page(s)`, evidencePages: [...n.pages.values()].map((p) => p.url) };
  }

  const disjoint = (a, b) => ![...a].some((x) => b.has(x));
  const conflictPairs = (byPage) => {
    const keys = [...byPage.keys()].sort();
    const pairs = [];
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (disjoint(byPage.get(keys[i]), byPage.get(keys[j]))) pairs.push([keys[i], keys[j]]);
    return pairs;
  };
  const declaredPairs = conflictPairs(declaredByPage);
  const trustedPairs = conflictPairs(trustedByPage);
  const urlOf = new Map(pages.map((p) => [p.pageKey, p.url]));
  if (declaredPairs.length || trustedPairs.length) {
    const pairs = declaredPairs.length ? declaredPairs : trustedPairs;
    const involvedPages = [...new Set(pairs.flat())];
    const involvedNumbers = list.filter((n) => n.trusted && [...n.pages.keys()].some((k) => involvedPages.includes(k)));
    const describe = involvedNumbers.slice(0, 4).map((n) => `${n.display} (${n.pages.size} page${n.pages.size === 1 ? "" : "s"}, e.g. ${[...n.pages.values()][0].path})`);
    return {
      ...base,
      status: "partial",
      conflict: { kind: declaredPairs.length ? "structured_data_disagrees" : "different_numbers_on_different_pages", pagePairs: pairs.slice(0, 5).map(([a, b]) => ({ a: urlOf.get(a), b: urlOf.get(b) })) },
      observation: `${involvedNumbers.length} different phone numbers on different pages${declaredPairs.length ? " (structured data disagrees)" : ""}: ${describe.join("; ")}`,
      evidencePages: involvedPages.map((k) => urlOf.get(k))
    };
  }
  // No trusted disagreement. Either several numbers are shown together, or
  // a difference rests only on weak evidence.
  const allByPage = new Map();
  for (const n of list) for (const k of n.pages.keys()) {
    if (!allByPage.has(k)) allByPage.set(k, new Set());
    allByPage.get(k).add(n.normalized);
  }
  if (conflictPairs(allByPage).length) {
    return {
      ...base,
      status: "unknown",
      insufficientEvidence: true,
      observation: `possibly different phone numbers (${list.slice(0, 4).map((n) => n.display).join(", ")}), but only from unlabelled page text - not enough evidence to call it an inconsistency`,
      evidencePages: [...new Set(list.flatMap((n) => [...n.pages.values()].map((p) => p.url)))]
    };
  }
  return {
    ...base,
    status: "present",
    observation: `${list.length} phone numbers (${list.slice(0, 4).map((n) => n.display).join(", ")}) shown together on the same pages - the business uses more than one number; not an inconsistency`,
    evidencePages: [...new Set(list.flatMap((n) => [...n.pages.values()].map((p) => p.url)))]
  };
}

module.exports = { extractPhones, comparePhones, normalizePhoneCandidate, visibleTextSegments, PHONE_EVIDENCE_VERSION };
