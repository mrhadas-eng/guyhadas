// GuyHadas Visibility OS - M4 GEO readiness signals (docs/MASTER.md §39,
// §41 M4 "GEO intelligence").
//
// "GEO readiness" = whether the business's important facts are explicit,
// consistent and machine-readable ON ITS OWN WEBSITE, observed from the
// crawl. It is NOT AI visibility: nothing here asks ChatGPT/Gemini/
// Perplexity anything (that is M12 / the §39 LLM Website Understanding
// capability). Every signal carries its evidence pages and basis; there is
// no single opaque score.
//
// status: present | partial | missing | unknown

const { normalizePhrase } = require("./seedBuilder");
const { comparePhones } = require("./phoneEvidence");

const ORG_TYPES = /^(Organization|LocalBusiness|ProfessionalService|HomeAndConstructionBusiness|GeneralContractor|Corporation|Store|.*Business)$/;

function containsNorm(text, phrase) {
  const p = normalizePhrase(phrase);
  return p.length > 1 && ` ${normalizePhrase(text)} `.includes(` ${p} `);
}

// pages: analyzePage() results (with _text); ctx: { business, services }
function computeGeoReadiness(pages, ctx) {
  const signals = [];
  const add = (key, status, observation, evidencePages = [], extra = {}) =>
    signals.push({ key, status, observation, evidencePages: evidencePages.slice(0, 10), basis: "observed", ...extra });

  if (!pages.length) {
    for (const key of ["business_identity", "services_explicit", "locations_explicit", "contact_details", "structured_data_coverage", "fact_consistency", "audience_positioning"]) {
      add(key, "unknown", "no pages were fetched in this run");
    }
    return { signals, summary: { present: 0, partial: 0, missing: 0, unknown: signals.length }, scope: "no crawl data" };
  }

  const business = ctx.business || {};
  const confirmed = (ctx.services || []).filter((s) => s.ownerStatus === "confirmed");
  const home = pages.find((p) => {
    try {
      return new URL(p.url).pathname === "/";
    } catch (err) {
      return false;
    }
  });

  // 1. Business identity: org-type structured data with a name, and/or the
  //    business name visible on the homepage.
  const orgPages = pages.filter((p) => p.structuredData.types && p.structuredData.types.some((t) => ORG_TYPES.test(t)));
  const nameOnHome = home && business.name ? containsNorm(home._text, business.name) : false;
  const sdNames = [...new Set(pages.flatMap((p) => (p.structuredFacts ? p.structuredFacts.names : [])))].slice(0, 5);
  if (orgPages.length && (nameOnHome || sdNames.length)) add("business_identity", "present", `organization structured data on ${orgPages.length} page(s); names: ${sdNames.join(", ") || "—"}`, orgPages.map((p) => p.url));
  else if (orgPages.length || nameOnHome) add("business_identity", "partial", orgPages.length ? "organization structured data without a matching visible name" : "business name visible on homepage, no organization structured data", orgPages.length ? orgPages.map((p) => p.url) : [home.url]);
  else add("business_identity", "missing", `no organization structured data, and "${business.name || "business name"}" not found on the homepage text`);

  // 2. Services explicit: confirmed service names appear in a page title/H1/H2.
  const svcHits = confirmed.map((s) => {
    const names = [s.name, ...(s.aliases || [])];
    const inHeadings = pages.filter((p) => names.some((n) => containsNorm(`${p.title || ""} ${p.h1.join(" ")} ${p.h2.join(" ")}`, n)));
    const inText = pages.filter((p) => names.some((n) => containsNorm(p._text, n)));
    return { name: s.name, headingPages: inHeadings.map((p) => p.url), textPages: inText.map((p) => p.url) };
  });
  if (!confirmed.length) add("services_explicit", "unknown", "no confirmed services in the Service Map to check against");
  else {
    const inHead = svcHits.filter((h) => h.headingPages.length);
    const anywhere = svcHits.filter((h) => h.textPages.length);
    const status = inHead.length === confirmed.length ? "present" : anywhere.length ? "partial" : "missing";
    add("services_explicit", status, `${inHead.length}/${confirmed.length} confirmed services named in a page title/heading; ${anywhere.length}/${confirmed.length} appear anywhere in crawled text`, [...new Set(svcHits.flatMap((h) => h.headingPages))], { details: svcHits });
  }

  // 3. Locations explicit: owner service areas in page text or areaServed/address.
  const areas = [...new Set([...(business.geographicMarkets || []), ...confirmed.flatMap((s) => ((s.facets && s.facets.geographies) || []).filter((g) => g.provenance === "owner").map((g) => g.value))])];
  if (!areas.length) add("locations_explicit", "unknown", "no owner-declared service areas to check against");
  else {
    const hits = areas.map((a) => ({ area: a, pages: pages.filter((p) => containsNorm(p._text, a) || (p.structuredFacts && [...p.structuredFacts.areaServed, ...p.structuredFacts.addresses].some((x) => containsNorm(x, a)))).map((p) => p.url) }));
    const found = hits.filter((h) => h.pages.length);
    add("locations_explicit", found.length === areas.length ? "present" : found.length ? "partial" : "missing", `${found.length}/${areas.length} owner service areas appear on crawled pages`, [...new Set(found.flatMap((h) => h.pages))], { details: hits });
  }

  // 4. Contact details discoverable.
  const phonePages = pages.filter((p) => p.contact.phones.length);
  const emailPages = pages.filter((p) => p.contact.emails.length);
  add("contact_details", phonePages.length && emailPages.length ? "present" : phonePages.length || emailPages.length ? "partial" : "missing", `phone on ${phonePages.length} page(s), email on ${emailPages.length} page(s)`, [...phonePages, ...emailPages].map((p) => p.url));

  // 5. Structured data coverage.
  const sdPages = pages.filter((p) => p.structuredData.state === "present");
  const invalid = pages.filter((p) => p.structuredData.state === "invalid" || (p.structuredData.invalidJsonLdBlocks || 0) > 0);
  const types = [...new Set(sdPages.flatMap((p) => p.structuredData.types || []))].sort();
  add("structured_data_coverage", sdPages.length === pages.length ? "present" : sdPages.length ? "partial" : "missing", `${sdPages.length}/${pages.length} crawled pages have structured data${types.length ? ` (types: ${types.join(", ")})` : ""}${invalid.length ? `; ${invalid.length} with unparseable JSON-LD` : ""}`, sdPages.map((p) => p.url), { types });

  // 6. Fact consistency: do pages show the same business phone number?
  //    Validated, normalized numbers with page provenance; a discrepancy only
  //    on trusted evidence (functions/phoneEvidence.js, issue #36).
  const pc = comparePhones(pages);
  const { status: pcStatus, observation: pcObservation, evidencePages: pcPages, ...pcExtra } = pc;
  add("fact_consistency", pcStatus, pcObservation, pcPages, pcExtra);

  // 7. Audience / positioning: website-verified facet values from M3.1.
  const verified = confirmed.flatMap((s) => [...((s.facets && s.facets.audiences) || []), ...((s.facets && s.facets.positioning) || [])].filter((v) => v.provenance === "website" || v.provenance === "owner").map((v) => ({ value: v.value, provenance: v.provenance, pages: v.foundOn || (v.sourceUrl ? [v.sourceUrl] : []) })));
  add("audience_positioning", verified.length ? "present" : "missing", verified.length ? `${verified.length} audience/positioning value(s) verified on the website or stated by the owner (M3.1 evidence)` : "no audience or positioning value verified on the website (M3.1 evidence)", [...new Set(verified.flatMap((v) => v.pages))], { values: verified.slice(0, 10) });

  const summary = { present: 0, partial: 0, missing: 0, unknown: 0 };
  for (const s of signals) summary[s.status]++;
  return { signals, summary, scope: `${pages.length} crawled pages; website signals only - not external AI visibility` };
}

module.exports = { computeGeoReadiness };
