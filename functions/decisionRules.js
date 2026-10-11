// GuyHadas Visibility OS - M6 Decision Engine: pure decision logic
// (docs/M6_DECISION_ENGINE_DESIGN.md §C–§K).
//
//   approved Search Topics (M3.2) + topic intelligence (M4) + seoPages (M4)
//   + confirmed services / owner geographies / brand (M3.1)
//   + active M5 opportunities
//     -> SearchIntents (intent type, user task, entity refs, cluster,
//        ownership, cannibalization)
//     -> ONE decision per canonical unit (intent / page / site):
//        CREATE | IMPROVE | CONSOLIDATE | WAIT | MONITOR | REJECT
//
// Pure and deterministic: no Firestore, no network, no provider, no clock
// (time is injected). Inputs are sorted before use, so the output does not
// depend on input order.
//
// What this module never does: claim which URL Google selected as canonical
// (googleSelectedCanonical is always null), treat Search Console visibility
// as market demand, emit a URL / slug / title / brief for a new page, or
// produce a decision per query or per opportunity.

const crypto = require("crypto");
const { matchesTerm } = require("./topicQualification");
const cfg = require("./decisionConfig");

const APPROVED = ["relevant", "priority", "brand_strategic"];
const TOPIC_OPP_TYPES = new Set(["ranking_upside", "ctr_upside", "coverage_gap", "page_not_visible", "page_overlap_observed"]);
const PAGE_OPP_TYPES = new Set(["technical_blocker", "internal_linking"]);
const LEVEL = { high: 3, medium: 2, low: 1 };
const LEVEL_NAME = { 3: "high", 2: "medium", 1: "low" };
const SEVERITY = { NO_COLLISION: 0, RELATED_BUT_DISTINCT: 1, POTENTIAL_COLLISION: 2, HIGH_COLLISION: 3, DUPLICATE: 4 };
const HIRE_LIKE = new Set(["hire", "check_price", "evaluate", "find_business"]);

// ---------------------------------------------------------------------------
// text helpers (same normalization as M3.2's normalizePhrase)

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[.,!?"'()[\]{}:;|\-–—/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text) {
  return new Set(normalize(text).split(" ").filter((t) => t.length > 0));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function containsPhrase(text, phrase) {
  const p = normalize(phrase);
  return p.length > 0 && ` ${normalize(text)} `.includes(` ${p} `);
}

function round(n, d = 2) {
  return n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d;
}

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function byStr(key) {
  return (a, b) => String(a[key]).localeCompare(String(b[key]));
}

function uniq(arr) {
  return [...new Set(arr)];
}

function minLevel(...levels) {
  return Math.min(...levels.filter((l) => l != null));
}

function pageText(page) {
  if (!page) return "";
  return `${page.title || ""} ${(page.h1 || []).join(" ")} ${(page.h2 || []).join(" ")}`;
}

function pageRole(page) {
  if (!page) return null;
  if (page.role && page.role.role) return page.role.role;
  return null;
}

function blockerOf(page) {
  if (!page) return null;
  if (page.indexability && page.indexability.state === "non_indexable") return "non_indexable";
  if (page.robots && page.robots.state === "blocked") return "blocked_by_robots";
  if (page.canonical && page.canonical.state === "conflicting") return "canonical_conflicting";
  if (page.canonical && page.canonical.state === "points_elsewhere") return "canonical_points_elsewhere";
  return null;
}

// Crawl-derived eligibility (never Google's index status).
function eligibilityOf(page) {
  if (!page || page.crawlStatus !== "fetched") return { state: "unknown", blocker: null, basis: "observed", note: "page not crawled in the latest analysis" };
  const blocker = blockerOf(page);
  if (blocker) return { state: "blocked", blocker, basis: "observed", note: "crawl-derived; a fixable blocker" };
  return { state: "eligible", blocker: null, basis: "observed", note: "crawl-derived: indexable, canonical not conflicting, not robots-blocked" };
}

function pageKeyOf(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "") || "/"}`;
  } catch (err) {
    return String(url || "");
  }
}

// ---------------------------------------------------------------------------
// context

function buildContext(input) {
  const business = input.business || {};
  const businessId = business.id;
  const services = [...(input.services || [])].filter((s) => s.ownerStatus === "confirmed").sort(byStr("id"));
  const serviceById = new Map();
  const ownerGeographies = new Map(); // norm -> label
  for (const g of business.geographicMarkets || []) if (normalize(g)) ownerGeographies.set(normalize(g), g);
  for (const s of services) {
    const facets = s.facets || {};
    const terms = uniq([s.name, ...(s.aliases || []), ...((facets.services || []).filter((f) => f.provenance === "owner" || f.provenance === "website").map((f) => f.value))].filter((t) => normalize(t)));
    const audiences = (facets.audiences || []).filter((f) => f.provenance === "owner" || f.provenance === "website").map((f) => f.value).filter((v) => normalize(v));
    for (const g of facets.geographies || []) if (g.provenance === "owner" && normalize(g.value) && !ownerGeographies.has(normalize(g.value))) ownerGeographies.set(normalize(g.value), g.value);
    serviceById.set(s.id, { id: s.id, name: s.name, terms, audiences });
  }
  const knownPlaces = new Map(ownerGeographies);
  for (const s of services) for (const g of (s.facets && s.facets.geographies) || []) if (normalize(g.value) && !knownPlaces.has(normalize(g.value))) knownPlaces.set(normalize(g.value), g.value);
  const brandTerms = uniq([business.name, ...(input.knowledge || []).filter((k) => k.type === "brand_terminology").map((k) => k.content)].filter((t) => normalize(t)));
  const seoPages = [...(input.seoPages || [])].sort(byStr("pageKey"));
  const pagesByKey = new Map(seoPages.map((p) => [p.pageKey, p]));
  const topics = [...(input.searchTopics || [])].sort(byStr("id"));
  const statusById = new Map(topics.map((t) => [t.id, t.status]));
  const intelByTopic = new Map();
  for (const ti of [...(input.topicIntel || [])].filter((t) => !t.superseded).sort(byStr("id"))) intelByTopic.set(ti.topicId, ti);
  const opps = [...(input.opportunities || [])].filter((o) => o.source === "opportunity_engine" && o.engineState === "active").sort(byStr("id"));
  return {
    input,
    business,
    businessId,
    services,
    serviceById,
    ownerGeographies,
    knownPlaces,
    brandTerms,
    seoPages,
    pagesByKey,
    topics,
    statusById,
    intelByTopic,
    opps,
    baseline: input.baseline || null,
    nowMs: input.nowMs,
    policy: input.policy || cfg.resolvePolicy(null),
    singleService: services.length === 1
  };
}

// Named service / place entities on a page (title + H1 + H2 only - M4 does
// not store body text). Inference.
function pageEntities(page, ctx) {
  const text = pageText(page);
  const services = [];
  for (const s of ctx.serviceById.values()) if (s.terms.some((t) => matchesTerm(text, t))) services.push(s.id);
  const places = [];
  for (const [norm] of ctx.knownPlaces) if (containsPhrase(text, norm)) places.push(norm);
  return { services, places };
}

// ---------------------------------------------------------------------------
// §D SearchIntent: per-topic profile

function serviceRefsOf(topic, ti, texts, ctx) {
  const refs = new Map();
  const add = (id, basis, via) => {
    if (!id || !ctx.serviceById.has(id) || refs.has(id)) return;
    refs.set(id, { id: `service:${id}`, serviceId: id, type: "service", label: ctx.serviceById.get(id).name, basis, via });
  };
  for (const r of topic.seedRefs || []) add(r.serviceId, "observed", "seed lineage");
  for (const l of ((ti && ti.business && ti.business.linkedServices) || []).filter((x) => x.confirmed)) add(l.serviceId, "observed", "linked service");
  for (const r of (topic.qualificationReasons || []).filter((x) => x.code === "matches_confirmed_service")) {
    const s = [...ctx.serviceById.values()].find((x) => normalize(x.name) === normalize(r.detail));
    if (s) add(s.id, "inference", "query text matches a confirmed service");
  }
  for (const s of ctx.serviceById.values()) if (s.terms.some((term) => texts.some((t) => matchesTerm(t, term)))) add(s.id, "inference", "query text matches a confirmed service");
  return [...refs.values()].sort((a, b) => (a.basis === b.basis ? a.serviceId.localeCompare(b.serviceId) : a.basis === "observed" ? -1 : 1));
}

function placeRefsOf(topic, ti, texts, ctx) {
  const refs = new Map();
  const add = (value, ownerDeclared, basis, via) => {
    const norm = normalize(value);
    if (!norm) return;
    const prev = refs.get(norm);
    if (prev && (prev.ownerDeclared || !ownerDeclared)) return;
    refs.set(norm, { id: `place:${norm}`, type: "place", label: value, ownerDeclared, basis, via });
  };
  for (const [norm, label] of ctx.ownerGeographies) if (texts.some((t) => containsPhrase(t, norm))) add(label, true, "observed", "owner-declared geography named in the queries");
  for (const r of topic.seedRefs || []) for (const c of (r.components || []).filter((x) => x.dimension === "geographies")) add(c.value, c.provenance === "owner", c.provenance === "owner" ? "observed" : "inference", "seed lineage");
  for (const g of ((ti && ti.business && ti.business.geography) || [])) add(g.value, g.provenance === "owner", g.basis === "observed" ? "observed" : "inference", "topic intelligence");
  for (const [norm, label] of ctx.knownPlaces) if (!ctx.ownerGeographies.has(norm) && texts.some((t) => containsPhrase(t, norm))) add(label, false, "inference", "place named in the queries");
  return [...refs.values()].sort(byStr("id"));
}

function classify(topic, ti, texts, prof, ctx) {
  const rows = [];
  const brandTerm = ctx.brandTerms.find((b) => texts.some((t) => containsPhrase(t, b)));
  if (brandTerm) rows.push({ type: "navigational", evidence: `brand term „${brandTerm}“`, strength: 3 });
  for (const [type, words] of Object.entries(cfg.INTENT_MODIFIERS)) {
    const w = words.find((m) => texts.some((t) => containsPhrase(t, m)));
    if (w) rows.push({ type, evidence: `modifier „${w}“`, strength: 3 });
  }
  const ownerPlace = prof.places.find((p) => p.ownerDeclared);
  if (ownerPlace && prof.primaryServiceId) rows.push({ type: "local", evidence: `owner geography „${ownerPlace.label}“ + confirmed service`, strength: 3 });
  const prelim = topic.preliminaryIntent || (ti && ti.business && ti.business.preliminaryIntent) || null;
  const commercialModifier = (topic.qualificationReasons || []).find((r) => r.code === "commercial_modifier") || (ti && ti.business && ti.business.commercialSignal && ti.business.commercialSignal.present ? { detail: "commercial modifier" } : null);
  if ((prelim === "commercial" || commercialModifier) && prof.primaryServiceId) rows.push({ type: "commercial_investigation", evidence: commercialModifier ? `commercial modifier „${commercialModifier.detail}“ + confirmed service` : "M3.2 preliminary intent commercial + confirmed service", strength: commercialModifier ? 3 : 2 });
  if (prelim === "informational") rows.push({ type: "informational", evidence: "M3.2 preliminary intent informational", strength: 2 });

  const extended = [];
  for (const [type, words] of Object.entries(cfg.EXTENDED_MODIFIERS)) {
    const w = words.find((m) => texts.some((t) => containsPhrase(t, m)));
    if (w) extended.push({ type, evidence: `modifier „${w}“ (extended taxonomy)`, strength: 2 });
  }
  if (prof.places.length && !prof.primaryServiceId) extended.push({ type: "location", evidence: `place „${prof.places[0].label}“ without a confirmed service`, strength: 2 });

  const ordered = [...rows, ...extended].filter((r, i, a) => a.findIndex((x) => x.type === r.type) === i);
  const primary = ordered[0] || { type: "unclassified", evidence: "no rule matched", strength: 1 };
  const secondary = ordered.slice(1).map((r) => r.type);
  if (prof.primaryServiceId && primary.type === "unclassified") secondary.push("entity_specific");
  return {
    intentType: primary.type,
    secondaryIntentTypes: secondary,
    intentEvidence: ordered.length ? ordered.map((r) => ({ type: r.type, evidence: r.evidence, basis: "inference" })) : [{ type: "unclassified", evidence: "no approved classification rule matched", basis: "inference" }],
    intentConfidence: primary.type === "unclassified" ? 1 : primary.strength
  };
}

function profileTopic(topic, ctx) {
  const ti = ctx.intelByTopic.get(topic.id) || null;
  const queries = uniq([...(topic.queries || []), ...((ti && ti.queries) || [])].filter(Boolean)).sort();
  const texts = [topic.title, ...queries].filter(Boolean);
  const serviceRefs = serviceRefsOf(topic, ti, texts, ctx);
  const places = placeRefsOf(topic, ti, texts, ctx);
  const primaryServiceId = serviceRefs[0] ? serviceRefs[0].serviceId : null;
  const audiences = [];
  for (const s of serviceRefs.map((r) => ctx.serviceById.get(r.serviceId))) {
    for (const a of s.audiences) if (texts.some((t) => containsPhrase(t, a)) && !audiences.some((x) => x.id === `audience:${normalize(a)}`)) audiences.push({ id: `audience:${normalize(a)}`, type: "audience", label: a, basis: "observed", via: "owner/website audience facet named in the queries" });
  }
  const brand = ctx.brandTerms.some((b) => texts.some((t) => containsPhrase(t, b)));
  const prof = { topic, ti, queries, texts, serviceRefs, places, primaryServiceId, audiences, brand };
  Object.assign(prof, classify(topic, ti, texts, prof, ctx));
  const g = (ti && ti.gscCurrent) || null;
  prof.gscStatus = !ti ? "not_available" : g && (g.status === "available" || g.status === "no_observation") ? g.status : "not_available";
  prof.gscQueries = new Set(g && g.status === "available" ? (g.queries || []).map((q) => normalize(q.query)) : []);
  return prof;
}

// §D.4 grouping (G4). Union-find over approved topics, deterministic.
function groupTopics(profiles) {
  const H = cfg.HEURISTICS.grouping;
  const parent = new Map(profiles.map((p) => [p.topic.id, p.topic.id]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  const placeKey = (p) => p.places.map((x) => x.id).sort().join("|");
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const a = profiles[i];
      const b = profiles[j];
      const sameEntity = a.primaryServiceId ? a.primaryServiceId === b.primaryServiceId : !b.primaryServiceId && a.brand && b.brand;
      if (!sameEntity || a.intentType !== b.intentType || placeKey(a) !== placeKey(b)) continue;
      const titleSim = jaccard(tokens(a.topic.title), tokens(b.topic.title));
      let sharedShare = 0;
      if (a.gscQueries.size && b.gscQueries.size) {
        let shared = 0;
        for (const q of a.gscQueries) if (b.gscQueries.has(q)) shared++;
        sharedShare = Math.max(shared / a.gscQueries.size, shared / b.gscQueries.size);
      }
      if (titleSim >= H.titleJaccard || sharedShare >= H.sharedQueryShare) {
        const ra = find(a.topic.id);
        const rb = find(b.topic.id);
        if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
      }
    }
  }
  const groups = new Map();
  for (const p of profiles) {
    const root = find(p.topic.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a.topic.id.localeCompare(b.topic.id)));
}

function buildIntent(group, ctx) {
  const anchor = group[0];
  const businessId = ctx.businessId;
  const intentId = `${businessId}_${anchor.topic.id}`;
  const entityRefs = new Map();
  for (const p of group) for (const r of [...p.serviceRefs, ...p.places, ...p.audiences]) if (!entityRefs.has(r.id)) entityRefs.set(r.id, r);
  if (group.some((p) => p.brand)) entityRefs.set(`brand:${businessId}`, { id: `brand:${businessId}`, type: "brand", label: ctx.business.name || businessId, basis: "observed", via: "brand term named in the queries" });
  const places = [...new Map(group.flatMap((p) => p.places).map((x) => [x.id, x])).values()].sort(byStr("id"));
  const primaryServiceId = anchor.primaryServiceId;
  const intentType = anchor.intentType;
  const secondary = uniq(group.flatMap((p) => p.secondaryIntentTypes)).filter((t) => t !== intentType).sort();
  const audiences = [...new Map(group.flatMap((p) => p.audiences).map((x) => [x.id, x])).values()];

  // Aggregate Search Console observations (query x page).
  const pages = new Map();
  let impressions = 0;
  let clicks = 0;
  const statuses = group.map((p) => p.gscStatus);
  let period = null;
  for (const p of group) {
    const g = p.ti && p.ti.gscCurrent;
    if (!g || g.status !== "available") continue;
    period = period || g.period || null;
    impressions += g.impressions || 0;
    clicks += g.clicks || 0;
    // gscCurrent.pages carries per-page queries (M4); pages.observed is the
    // same observation without queries - used only if pages are absent.
    const gPages = (g.pages && g.pages.length ? g.pages : (p.ti.pages && p.ti.pages.observed) || []);
    for (const pg of gPages) {
      const cur = pages.get(pg.pageKey) || { url: pg.url, pageKey: pg.pageKey, impressions: 0, clicks: 0, posW: 0, queries: new Set() };
      cur.impressions += pg.impressions || 0;
      cur.clicks += pg.clicks || 0;
      cur.posW += (pg.position || 0) * (pg.impressions || 0);
      for (const q of pg.queries || []) cur.queries.add(normalize(q));
      pages.set(pg.pageKey, cur);
    }
    if (!period && g.period) period = g.period;
  }
  for (const p of group) if (!period && p.ti && p.ti.gscCurrent && p.ti.gscCurrent.period) period = p.ti.gscCurrent.period;
  const gscStatus = statuses.includes("available") ? "available" : statuses.every((s) => s === "no_observation") ? "no_observation" : "not_available";
  const observedPages = [...pages.values()]
    .map((p) => ({ url: p.url, pageKey: p.pageKey, impressions: p.impressions, clicks: p.clicks, position: p.impressions ? round(p.posW / p.impressions, 1) : null, queries: [...p.queries].sort() }))
    .sort((a, b) => b.impressions - a.impressions || a.pageKey.localeCompare(b.pageKey));
  const contentMatched = uniq(group.flatMap((p) => ((p.ti && p.ti.pages && p.ti.pages.contentMatched) || []).map((m) => m.pageKey))).sort();
  const urlOf = new Map();
  for (const p of group) for (const m of (p.ti && p.ti.pages && p.ti.pages.contentMatched) || []) urlOf.set(m.pageKey, m.url);

  const semrush = group.map((p) => p.ti && p.ti.semrush).filter((s) => s && s.status === "available");
  const marketDemand = semrush.length
    ? { status: "available", monthlyVolume: semrush.reduce((a, s) => a + (s.totalMonthlyVolume || 0), 0), basis: "observed", source: "semrush" }
    : { status: "unknown", monthlyVolume: null, basis: "unknown", source: null, note: "no stored Semrush evidence - market demand unknown (never derived from Search Console)" };
  const observedVisibility =
    gscStatus === "available"
      ? { status: "observed", impressions, clicks, basis: "observed", source: "search_console", period, note: "what Search Console measured for this site - not market demand" }
      : gscStatus === "no_observation"
        ? { status: "none_observed", impressions: 0, clicks: 0, basis: "observed", source: "search_console", period, note: "zero impressions in the period - not zero market demand" }
        : { status: "unknown", impressions: null, clicks: null, basis: "unknown", source: null, period: null };

  const statusesOwner = group.map((p) => ctx.statusById.get(p.topic.id));
  const ownerPriority = statusesOwner.some((s) => s === "priority" || s === "brand_strategic");
  const task = cfg.TASK_BY_TYPE[intentType] || null;
  const serviceRef = primaryServiceId ? `service:${primaryServiceId}` : null;
  const userTask = {
    verb: task,
    object: intentType === "navigational" ? `brand:${businessId}` : serviceRef || anchor.topic.title,
    qualifiers: {
      geography: places[0] ? places[0].id : null,
      audience: audiences[0] ? audiences[0].id : null,
      priceSensitivity: intentType === "pricing" || secondary.includes("pricing")
    },
    basis: "inference"
  };
  const clusterId = primaryServiceId ? `${businessId}_cluster_service:${primaryServiceId}` : `${businessId}_cluster_brand`;
  const relevanceLevel = Math.min(3, (ownerPriority ? 3 : 2) + (group.some((p) => p.serviceRefs.some((r) => r.basis === "observed")) ? 1 : 0));
  const commercialLevel = { hire: 3, check_price: 3, evaluate: 3, find_business: 2, compare: 2, learn: 1, find_place: 2 }[task] ?? null;
  return {
    intentId,
    businessId,
    anchorTopicId: anchor.topic.id,
    title: anchor.topic.title,
    topicIds: group.map((p) => p.topic.id),
    topicTitles: group.map((p) => p.topic.title),
    queryFamilyIds: group.map((p) => p.topic.id),
    queryCount: uniq(group.flatMap((p) => p.queries)).length,
    sampleQueries: uniq(group.flatMap((p) => p.queries)).slice(0, 10),
    intentType,
    secondaryIntentTypes: secondary,
    intentBasis: "inference",
    intentEvidence: anchor.intentEvidence,
    intentConfidence: Math.min(...group.map((p) => p.intentConfidence)),
    userTask,
    entityRefs: [...entityRefs.values()].map((r) => ({ id: r.id, type: r.type, label: r.label, basis: r.basis, ...(r.type === "place" ? { ownerDeclared: !!r.ownerDeclared } : {}) })).sort(byStr("id")),
    primaryServiceId,
    places,
    hasBrand: group.some((p) => p.brand),
    clusterId,
    gsc: { status: gscStatus, partial: statuses.includes("available") && statuses.includes("not_available"), impressions, clicks, period, observedPages, statusesByTopic: Object.fromEntries(group.map((p) => [p.topic.id, p.gscStatus])) },
    contentMatched: contentMatched.map((k) => ({ pageKey: k, url: urlOf.get(k) || (ctx.pagesByKey.get(k) || {}).url || k })),
    marketDemand,
    observedVisibility,
    ownerPriority,
    topicStatuses: Object.fromEntries(group.map((p) => [p.topic.id, ctx.statusById.get(p.topic.id)])),
    businessValue: {
      relevance: { level: relevanceLevel, basis: "observed", note: "owner topic status + confirmed service link" },
      commercialValue: { level: commercialLevel, basis: commercialLevel == null ? "unknown" : "inference" },
      marketDemand,
      observedVisibility
    },
    intelIds: group.filter((p) => p.ti).map((p) => p.ti.id)
  };
}

// ---------------------------------------------------------------------------
// §E ownership

function familyOf(intentType) {
  return cfg.TASK_BY_TYPE[intentType] || null;
}

// Role vs intent (inference): "fit" | "unknown" | "mismatch".
function intentFitOf(page, intent, ctx) {
  const t = intent.intentType;
  if (t === "unclassified") return "unknown";
  const fam = familyOf(t);
  let role = pageRole(page);
  if (!role && page && page.url) role = pageKeyOf(page.url).endsWith("/") ? "homepage" : null;
  switch (role) {
    case "homepage":
      if (fam === "find_business" || fam === "find_place") return "fit";
      if (ctx.singleService && !intent.places.length && HIRE_LIKE.has(fam)) return "fit";
      return "mismatch";
    case "contact":
    case "about":
      return fam === "find_business" || fam === "find_place" ? "fit" : "mismatch";
    case "project":
      return fam === "find_business" ? "fit" : "mismatch";
    case "service":
      if (fam === "hire" || fam === "check_price" || fam === "evaluate") return "fit";
      if (fam === "learn") return "mismatch";
      return "unknown";
    case "article":
      if (fam === "learn" || fam === "compare") return "fit";
      if (fam === "hire" || fam === "check_price" || fam === "find_business") return "mismatch";
      return "unknown";
    default:
      return "unknown";
  }
}

function entityFitOf(page, intent, ctx) {
  if (!intent.primaryServiceId && !intent.places.length) return null;
  const text = pageText(page);
  if (!text.trim()) return false;
  const svc = intent.primaryServiceId ? ctx.serviceById.get(intent.primaryServiceId) : null;
  if (svc && svc.terms.some((t) => matchesTerm(text, t))) return true;
  return intent.places.some((p) => containsPhrase(text, p.label));
}

function candidateOf(pageKey, url, sources, intent, ctx, observed) {
  const page = ctx.pagesByKey.get(pageKey) || null;
  return {
    pageKey,
    url: url || (page && page.url) || pageKey,
    sources,
    role: pageRole(page),
    impressions: observed ? observed.impressions : 0,
    clicks: observed ? observed.clicks : 0,
    observedShare: null,
    clickShare: null,
    bestPosition: observed ? observed.position : null,
    eligibility: eligibilityOf(page),
    intentFit: intentFitOf(page || { url }, intent, ctx),
    entityFit: entityFitOf(page, intent, ctx),
    crawled: !!page
  };
}

function servicePagesFor(serviceId, ctx) {
  if (!serviceId) return [];
  return ctx.seoPages.filter((p) => pageRole(p) === "service" && pageEntities(p, ctx).services.includes(serviceId));
}

function ownershipOf(intent, ctx) {
  const H = cfg.HEURISTICS.ownership;
  const cands = new Map();
  for (const op of intent.gsc.observedPages) cands.set(op.pageKey, candidateOf(op.pageKey, op.url, ["search_console"], intent, ctx, op));
  for (const m of intent.contentMatched) {
    if (cands.has(m.pageKey)) cands.get(m.pageKey).sources.push("content_match");
    else cands.set(m.pageKey, candidateOf(m.pageKey, m.url, ["content_match"], intent, ctx, null));
  }
  for (const sp of servicePagesFor(intent.primaryServiceId, ctx)) {
    if (cands.has(sp.pageKey)) {
      if (!cands.get(sp.pageKey).sources.includes("service_page")) cands.get(sp.pageKey).sources.push("service_page");
    } else cands.set(sp.pageKey, candidateOf(sp.pageKey, sp.url, ["service_page"], intent, ctx, null));
  }
  const list = [...cands.values()];
  const totalImpr = list.reduce((a, c) => a + c.impressions, 0);
  const totalClicks = list.reduce((a, c) => a + c.clicks, 0);
  for (const c of list) {
    c.observedShare = totalImpr ? round(c.impressions / totalImpr, 3) : c.sources.includes("search_console") ? 0 : null;
    c.clickShare = totalClicks ? round(c.clicks / totalClicks, 3) : c.sources.includes("search_console") ? 0 : null;
  }
  list.sort((a, b) => (b.impressions || 0) - (a.impressions || 0) || (b.clicks || 0) - (a.clicks || 0) || a.pageKey.localeCompare(b.pageKey));
  const observed = list.filter((c) => c.sources.includes("search_console") && c.impressions > 0);
  const content = list.filter((c) => !c.sources.includes("search_console") || c.impressions === 0);
  const reasons = [];
  let status;
  let owner = null;
  let basis = "inference";
  const gscKnown = intent.gsc.status !== "not_available";
  if (observed.length) {
    basis = "observed";
    const top = observed[0];
    const contested = observed.filter((c) => c.observedShare >= H.contestedShare);
    if (top.observedShare >= H.establishedShare) {
      status = "established";
      owner = top;
      reasons.push(`הדף ${top.url} קיבל ${Math.round(top.observedShare * 100)}% מהחשיפות לכוונה ב-Search Console (סף פנימי ${H.establishedShare * 100}% — הנחה שלנו, לא סף של Google)`);
    } else if (contested.length >= 2) {
      status = "contested";
      reasons.push(`${contested.length} דפים קיבלו כל אחד לפחות ${H.contestedShare * 100}% מהחשיפות (סף פנימי)`);
    } else {
      status = "ambiguous";
      reasons.push("כמה דפים קיבלו חשיפות, אף אחד לא דומיננטי");
    }
  } else if (content.length) {
    const usable = content;
    const fitting = usable.filter((c) => c.intentFit !== "mismatch");
    const withEntity = fitting.filter((c) => c.entityFit);
    if (usable.length === 1) {
      status = "probable";
      owner = usable[0];
    } else if (fitting.length === 1) {
      status = "probable";
      owner = fitting[0];
    } else if (withEntity.length === 1) {
      status = "probable";
      owner = withEntity[0];
    } else {
      status = "ambiguous";
      reasons.push("כמה דפים מתאימים לפי התוכן, אף אחד לא בולט");
    }
    if (owner) reasons.push(`לא נמדדה נראות לכוונה; הדף ${owner.url} מתאים לפי התוכן (הסקה)`);
  } else if (gscKnown) {
    status = "none";
    reasons.push("לא נמדדה נראות לכוונה ב-Search Console ולא נמצא בסריקה דף שעוסק בה");
  } else {
    status = "unknown";
    reasons.push("אין נתוני Search Console לכוונה ולא נמצא דף לפי התוכן");
  }

  let acceptable = false;
  if (owner && (status === "established" || status === "probable")) {
    acceptable = owner.intentFit !== "mismatch";
    if (!acceptable) reasons.push(`הדף ${owner.url} לא מתאים לסוג הכוונה (${pageRole(ctx.pagesByKey.get(owner.pageKey)) || "תפקיד לא ידוע"} מול ${intent.intentType})`);
    if (owner.eligibility.state === "blocked") reasons.push("לדף יש חסימה טכנית שניתנת לתיקון");
    if (owner.eligibility.state === "unknown") reasons.push("הדף לא נבדק בסריקה האחרונה");
  }
  let confidence;
  if (status === "established") confidence = owner.eligibility.state === "eligible" && owner.intentFit === "fit" ? 3 : 2;
  else if (status === "probable") confidence = owner.entityFit ? 2 : 1;
  else if (status === "none") confidence = 2;
  else confidence = 1;
  if (owner && owner.eligibility.state === "unknown") confidence = Math.min(confidence, 2);
  return {
    status,
    basis,
    primaryOwnerPageKey: owner ? owner.pageKey : null,
    primaryOwnerUrl: owner ? owner.url : null,
    owner,
    candidates: list.slice(0, 10),
    confidence,
    acceptable,
    reasons,
    thresholds: { established: H.establishedShare, contested: H.contestedShare, basis: "assumption", note: "internal heuristic - not a Google-defined threshold" }
  };
}

// Pages naming the intent's service, outside the candidate set, that could
// absorb the intent (rule 12 / G6 fallback). Eligible only.
function relatedPagesFor(intent, ownership, ctx, { requireFit = true } = {}) {
  if (!intent.primaryServiceId) return [];
  const taken = new Set(ownership.candidates.map((c) => c.pageKey));
  return ctx.seoPages
    .filter((p) => !taken.has(p.pageKey) && eligibilityOf(p).state === "eligible" && pageEntities(p, ctx).services.includes(intent.primaryServiceId))
    .filter((p) => !requireFit || intentFitOf(p, intent, ctx) !== "mismatch")
    .sort((a, b) => (pageRole(a) === "service" ? 0 : 1) - (pageRole(b) === "service" ? 0 : 1) || a.pageKey.localeCompare(b.pageKey));
}

// ---------------------------------------------------------------------------
// §F cannibalization

function collisionOf(intent, ownership, ctx) {
  const H = cfg.HEURISTICS.collision;
  const pages = intent.gsc.observedPages.filter((p) => p.impressions > 0).slice(0, H.maxPagesCompared);
  const total = intent.gsc.observedPages.reduce((a, p) => a + p.impressions, 0);
  if (pages.length < 2) {
    return { status: "NO_COLLISION", reason: pages.length ? "one page observed for this intent" : "no page observed for this intent", pairs: [], serpOverlap: "missing", declaredCanonicalRelation: false, basis: intent.gsc.status === "not_available" ? "unknown" : "observed" };
  }
  const pairs = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i];
      const b = pages[j];
      const pa = ctx.pagesByKey.get(a.pageKey);
      const pb = ctx.pagesByKey.get(b.pageKey);
      const queryOverlap = round(jaccard(new Set(a.queries), new Set(b.queries)), 2);
      const shareA = total ? a.impressions / total : 0;
      const shareB = total ? b.impressions / total : 0;
      const titleSimilarity = pa && pb ? round(jaccard(tokens(pageText(pa)), tokens(pageText(pb))), 2) : null;
      const ra = pageRole(pa);
      const rb = pageRole(pb);
      const sameRole = !!ra && ra === rb && ra !== "other";
      const ea = pa ? pageEntities(pa, ctx) : { services: [], places: [] };
      const eb = pb ? pageEntities(pb, ctx) : { services: [], places: [] };
      const disjoint = (x, y) => x.length && y.length && !x.some((v) => y.includes(v));
      const differentEntity = disjoint(ea.services, eb.services) || disjoint(ea.places, eb.places);
      const declared =
        (pa && pa.canonical && pa.canonical.state === "points_elsewhere" && pageKeyOf(pa.canonical.target) === b.pageKey) ||
        (pb && pb.canonical && pb.canonical.state === "points_elsewhere" && pageKeyOf(pb.canonical.target) === a.pageKey);
      const ts = titleSimilarity == null ? 0 : titleSimilarity;
      let status;
      if (declared || (ts >= H.duplicateTitle && queryOverlap >= H.duplicateQueryOverlap)) status = "DUPLICATE";
      else if (shareA >= H.highShare && shareB >= H.highShare && queryOverlap >= H.highQueryOverlap && (sameRole || ts >= H.highTitle)) status = "HIGH_COLLISION";
      else if (Math.min(shareA, shareB) >= H.potentialShare && queryOverlap >= H.potentialQueryOverlap) status = "POTENTIAL_COLLISION";
      else status = "RELATED_BUT_DISTINCT";
      const reason = [
        `queryOverlap=${queryOverlap}`,
        `shares=${round(shareA, 2)}/${round(shareB, 2)}`,
        `titleSimilarity=${titleSimilarity == null ? "unknown" : titleSimilarity}`,
        `sameRole=${sameRole}`,
        `differentEntity=${!!differentEntity}`,
        `declaredCanonical=${!!declared}`,
        "serpOverlap=missing"
      ].join("; ");
      pairs.push({ a: a.pageKey, b: b.pageKey, aUrl: a.url, bUrl: b.url, status, queryOverlap, shareA: round(shareA, 3), shareB: round(shareB, 3), titleSimilarity, sameRole, differentEntity: !!differentEntity, declaredCanonicalRelation: !!declared, reason });
    }
  }
  pairs.sort((x, y) => SEVERITY[y.status] - SEVERITY[x.status] || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  const worst = pairs[0];
  return {
    status: worst.status,
    reason: `${worst.aUrl} ↔ ${worst.bUrl}: ${worst.reason} (thresholds are internal heuristics, not Google-defined)`,
    pairs,
    serpOverlap: "missing",
    declaredCanonicalRelation: pairs.some((p) => p.declaredCanonicalRelation && SEVERITY[p.status] >= SEVERITY.HIGH_COLLISION),
    basis: "observed"
  };
}

// §F.2 proposed new page vs existing owners / service pages / page titles.
function proposedCollisionOf(intent, allIntents, ownerships, ctx, justifiedAgainst = null) {
  const H = cfg.HEURISTICS.collision;
  const fam = familyOf(intent.intentType);
  const famGroup = (f) => (HIRE_LIKE.has(f) ? "hire" : f);
  const placeSet = intent.places.map((p) => normalize(p.label)).sort().join("|");
  const pairs = [];
  for (const other of allIntents) {
    if (other.intentId === intent.intentId) continue;
    const own = ownerships.get(other.intentId);
    if (!own || !own.acceptable || !own.owner) continue;
    if (!intent.primaryServiceId || other.primaryServiceId !== intent.primaryServiceId || famGroup(familyOf(other.intentType)) !== famGroup(fam)) continue;
    const otherPlaces = other.places.map((p) => normalize(p.label)).sort().join("|");
    if (otherPlaces === placeSet) pairs.push({ pageKey: own.owner.pageKey, url: own.owner.url, status: "HIGH_COLLISION", relation: "same_service_place_task", via: other.intentId });
    else pairs.push({ pageKey: own.owner.pageKey, url: own.owner.url, status: "POTENTIAL_COLLISION", relation: "location_variant", via: other.intentId });
  }
  for (const sp of servicePagesFor(intent.primaryServiceId, ctx)) {
    if (famGroup(fam) !== "hire") continue;
    const ent = pageEntities(sp, ctx);
    const intentPlaces = intent.places.map((p) => normalize(p.label));
    const covers = intentPlaces.every((p) => ent.places.includes(p));
    pairs.push({ pageKey: sp.pageKey, url: sp.url, status: covers ? "HIGH_COLLISION" : "POTENTIAL_COLLISION", relation: covers ? "same_service_place_task" : "location_variant", via: "service_page" });
  }
  const titles = uniq([intent.title, ...intent.topicTitles]);
  for (const p of ctx.seoPages) {
    // The page the new-page justification already found materially different
    // (§E.4) is not re-counted as a title collision.
    if (justifiedAgainst && p.pageKey === justifiedAgainst) continue;
    const sim = Math.max(...titles.map((t) => jaccard(tokens(t), tokens(`${p.title || ""} ${(p.h1 || []).join(" ")}`))));
    if (sim >= H.proposedTitle) pairs.push({ pageKey: p.pageKey, url: p.url, status: "POTENTIAL_COLLISION", relation: "similar_title", titleSimilarity: round(sim, 2), via: "page_title" });
  }
  const dedup = new Map();
  for (const p of pairs) {
    const prev = dedup.get(p.pageKey);
    if (!prev || SEVERITY[p.status] > SEVERITY[prev.status]) dedup.set(p.pageKey, p);
  }
  const list = [...dedup.values()].sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || a.pageKey.localeCompare(b.pageKey));
  if (!list.length) return { status: "NO_COLLISION", reason: "no existing owner, service page or similar page title for this proposed page", pairs: [], basis: "inference" };
  const worst = list[0];
  const onlyLocationVariants = list.every((p) => p.relation === "location_variant");
  return {
    status: worst.status,
    reason: `${worst.url}: ${worst.relation}${worst.titleSimilarity != null ? ` (titleSimilarity=${worst.titleSimilarity}, internal heuristic)` : ""}`,
    pairs: list,
    onlyLocationVariants,
    worst,
    basis: "inference"
  };
}

// ---------------------------------------------------------------------------
// §E.4 new-page justification

function justify(intent, page, ctx) {
  const fam = familyOf(intent.intentType);
  if (!page) {
    return {
      evaluated: true,
      justified: true,
      distinctOn: ["no_existing_page"],
      comparedWith: null,
      reason: "no existing page serves this intent or its service",
      distinctValue: { task: fam, object: intent.userTask.object, qualifiers: intent.userTask.qualifiers }
    };
  }
  const pageTask = taskOfPage(page, ctx);
  const distinctOn = [];
  if (fam && pageTask && fam !== pageTask && !cfg.SAME_PAGE_TASKS.some(([x, y]) => (x === fam && y === pageTask) || (y === fam && x === pageTask))) distinctOn.push("user_task");
  const ent = pageEntities(page, ctx);
  if (intent.primaryServiceId && ent.services.length && !ent.services.includes(intent.primaryServiceId)) distinctOn.push("entity");
  const ownerPlaces = intent.places.filter((p) => p.ownerDeclared && !ent.places.includes(normalize(p.label)));
  if (ownerPlaces.length) distinctOn.push("entity_place");
  const learnA = cfg.LEARN_TYPES.includes(intent.intentType);
  const learnB = pageTask === "learn";
  if (pageTask && learnA !== learnB) distinctOn.push("information_requirement");
  const justified = distinctOn.length > 0;
  return {
    evaluated: true,
    justified,
    distinctOn,
    comparedWith: { pageKey: page.pageKey, url: page.url, task: pageTask, role: pageRole(page) },
    reason: justified ? `materially different from ${page.url} on: ${distinctOn.join(", ")}` : `${page.url} can serve the same user task - no material difference`,
    distinctValue: justified ? { task: fam, object: intent.userTask.object, qualifiers: intent.userTask.qualifiers, versus: { task: pageTask, pageKey: page.pageKey } } : null
  };
}

function taskOfPage(page, ctx) {
  const role = pageRole(page);
  if (role === "service") return "hire";
  if (role === "article") return "learn";
  if (role === "homepage") return ctx.singleService ? "hire" : "find_business";
  if (role === "contact" || role === "about" || role === "project") return "find_business";
  return null;
}

// ---------------------------------------------------------------------------
// evidence helpers

function ev(id, sourceType, collection, docId, field, observation, basis, capturedAtMs) {
  return { id, sourceType, sourceRef: { collection, docId, field }, observation, basis, capturedAtMs: capturedAtMs || null };
}

function intentEvidence(intent, ownership, collision, ctx) {
  const out = [];
  out.push(ev(`searchIntents/${intent.intentId}#intentType`, "decision_engine", "searchIntents", intent.intentId, "intentType", `סוג הכוונה: ${intent.intentType} (${intent.intentEvidence.map((e) => e.evidence).join("; ")})`, "inference", ctx.nowMs));
  out.push(
    ev(
      `searchIntents/${intent.intentId}#ownership`,
      "decision_engine",
      "searchIntents",
      intent.intentId,
      "ownership",
      `בעלות: ${ownership.status}${ownership.primaryOwnerUrl ? ` · ${ownership.primaryOwnerUrl}` : ""}${ownership.candidates.length ? ` · ${ownership.candidates.slice(0, 4).map((c) => `${c.url} (${c.observedShare != null ? `${Math.round(c.observedShare * 100)}%` : "לפי תוכן"})`).join(" · ")}` : ""}`,
      ownership.basis,
      ctx.nowMs
    )
  );
  out.push(ev(`searchIntents/${intent.intentId}#cannibalization`, "decision_engine", "searchIntents", intent.intentId, "cannibalization", `התנגשות: ${collision.status} — ${collision.reason}`, collision.basis === "observed" ? "observed" : "inference", ctx.nowMs));
  for (const topicId of intent.topicIds) out.push(ev(`searchTopics/${topicId}#status`, "owner_decision", "searchTopics", topicId, "status", `סטטוס הנושא: ${ctx.statusById.get(topicId)}`, "observed", null));
  for (const id of intent.intelIds) {
    const ti = [...ctx.intelByTopic.values()].find((t) => t.id === id);
    const g = ti && ti.gscCurrent;
    if (g) out.push(ev(`topicIntelligence/${id}#gscCurrent`, "search_console", "topicIntelligence", id, "gscCurrent", g.status === "available" ? `${g.impressions} חשיפות, ${g.clicks} קליקים ב-Search Console` : g.status === "no_observation" ? "לא נרשמו חשיפות ב-Search Console בתקופה" : "אין נתוני Search Console", "observed", ti.computedAtMs));
    if (ti && ti.semrush && ti.semrush.status === "available") out.push(ev(`topicIntelligence/${id}#semrush`, "semrush", "topicIntelligence", id, "semrush", `${ti.semrush.totalMonthlyVolume} חיפושים בחודש לפי Semrush (ביקוש בשוק)`, "observed", ti.computedAtMs));
  }
  return out;
}

function pageEv(page, field, observation) {
  return ev(`seoPages/${page.id}#${field}`, "crawl", "seoPages", page.id, field, observation, "observed", page.lastCrawledAtMs);
}

function foldEvidence(opps, extra) {
  const seen = new Set();
  const out = [];
  for (const e of [...opps.flatMap((o) => o.evidence || []), ...extra]) {
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// decisions

const CONF_TEXT = {
  intent: "סוג הכוונה הוא הסקה מכללים",
  intentUnclassified: "סוג הכוונה לא סווג",
  ownership: "הבעלות על הכוונה לא ודאית",
  collision: "אין נתוני SERP — ההערכה מבוססת על Search Console ועל דמיון כותרות בלבד",
  gscMissing: "אין נתוני Search Console לכוונה",
  evidence: "הביטחון בהזדמנויות שזוהו נמוך יותר",
  demand: "ביקוש בשוק לא ידוע (אין נתוני Semrush)",
  visibilityOnly: "יש נראות שנמדדה ב-Search Console אבל ביקוש בשוק לא ידוע — נראות אינה ביקוש",
  noBaseline: "אין בייסליין להשוואה עתידית",
  uncrawled: "הדף לא נבדק בסריקה האחרונה",
  consolidate: "המלצת איחוד בלי תגית canonical של האתר ובלי נתוני SERP"
};

function aggregateConfidence(parts, caps) {
  let level = 3;
  const reasons = [];
  for (const [l, why] of parts) {
    if (l == null) continue;
    if (l < 3 && why && !reasons.includes(why)) reasons.push(why);
    level = Math.min(level, l);
  }
  for (const [cap, why] of caps) {
    if (cap == null) continue;
    if (level > cap) {
      level = cap;
      if (why && !reasons.includes(why)) reasons.push(why);
    } else if (why && cap < 3 && !reasons.includes(why)) reasons.push(why);
  }
  return { confidence: LEVEL_NAME[Math.max(1, level)], confidenceReasons: reasons };
}

function oppConfidenceLevel(opps) {
  if (!opps.length) return null;
  return Math.min(...opps.map((o) => LEVEL[o.confidence] || 1));
}

function pickImpactInputs(opps, fallback) {
  const o = opps.find((x) => x.impactInputs);
  return o ? o.impactInputs : fallback;
}

function effortValue(opps) {
  if (!opps.length) return { estimatedEffort: { level: null, basis: "unknown" }, estimatedValue: { level: null, basis: "unknown" } };
  const best = [...opps].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] ?? 3) - ({ high: 0, medium: 1, low: 2 }[b.priority] ?? 3) || (b.score || 0) - (a.score || 0) || a.id.localeCompare(b.id))[0];
  return { estimatedEffort: best.estimatedEffort || { level: null, basis: "unknown" }, estimatedValue: best.estimatedValue || { level: null, basis: "unknown" } };
}

const existing = (pageKey, url) => ({ kind: "existing", pageKey, url });
const NONE = { kind: "none", pageKey: null, url: null };

function intentDecisionBase(intent, opps, ownership, collision, cluster, ctx) {
  return {
    decisionId: `${ctx.businessId}_intent_${intent.intentId}`,
    businessId: ctx.businessId,
    scope: "intent",
    intentId: intent.intentId,
    pageKey: null,
    signalKey: null,
    unitTitle: intent.title,
    opportunityIds: opps.map((o) => o.id),
    existingOwnerPageKey: ownership.primaryOwnerPageKey,
    existingOwnerUrl: ownership.primaryOwnerUrl,
    ownership: { status: ownership.status, acceptable: ownership.acceptable, confidence: LEVEL_NAME[ownership.confidence], candidates: ownership.candidates.slice(0, 6).map((c) => ({ pageKey: c.pageKey, url: c.url, sources: c.sources, observedShare: c.observedShare, clickShare: c.clickShare, bestPosition: c.bestPosition, eligibility: c.eligibility.state, blocker: c.eligibility.blocker, intentFit: c.intentFit, entityFit: c.entityFit })) },
    collision: { status: collision.status, reason: collision.reason, pairs: collision.pairs.slice(0, 6) },
    cluster,
    dependencies: [],
    consolidation: null,
    newPageJustification: { evaluated: false, justified: false, distinctOn: [], reason: null, distinctValue: null },
    businessValue: intent.businessValue,
    ...effortValue(opps),
    impactInputs: pickImpactInputs(opps, { targetType: "intent", targetId: intent.intentId, pageKey: ownership.primaryOwnerPageKey, baselineId: ctx.baseline ? ctx.baseline.id : null, current: intent.observedVisibility.status === "unknown" ? null : { impressions: intent.observedVisibility.impressions, clicks: intent.observedVisibility.clicks }, period: intent.observedVisibility.period || null }),
    targetEntityIds: intent.entityRefs.map((r) => r.id),
    basis: "recommendation",
    missing: []
  };
}

// The value gates of §G.3.5 / G6 / G7. Visibility and market demand are
// separate signals - visibility is never relabelled as demand.
function valueSignals(intent) {
  const demand = intent.marketDemand.status === "available" && (intent.marketDemand.monthlyVolume || 0) > 0;
  const visibility = intent.observedVisibility.status === "observed" && (intent.observedVisibility.impressions || 0) > 0;
  return { demand, visibility, priority: intent.ownerPriority, demandKnown: intent.marketDemand.status === "available" };
}

function evaluateCreateGates(intent, ownership, proposed, justification, ctx) {
  const v = valueSignals(intent);
  const fails = [];
  const notes = { reasonCodes: [], blocking: [], caps: [], missing: [] };
  // 2 justification
  if (!justification.justified) fails.push({ gate: 2, kind: "evidence", code: "NEW_PAGE_NOT_JUSTIFIED_SAME_TASK" });
  // 3 proposed-page collision (location variants are left to G6)
  const blockingCollision = proposed.status !== "NO_COLLISION" && proposed.status !== "RELATED_BUT_DISTINCT" && !(proposed.onlyLocationVariants && proposed.status === "POTENTIAL_COLLISION");
  if (blockingCollision) fails.push({ gate: 3, kind: "evidence", code: "PROPOSED_PAGE_COLLIDES" });
  // 4 classified + entity
  if (intent.intentType === "unclassified") fails.push({ gate: 4, kind: "missing", code: "INTENT_UNCLASSIFIED", blocking: "NEEDS_INTENT_CLASSIFICATION" });
  if (!intent.primaryServiceId && !intent.hasBrand) fails.push({ gate: 4, kind: "missing", code: "ENTITY_UNKNOWN", blocking: "NEEDS_ENTITY_CONFIRMATION" });
  // 5 value evidence
  if (!v.demand && !v.visibility && !v.priority) fails.push({ gate: 5, kind: "missing", code: "MISSING_MARKET_DEMAND", blocking: "NEEDS_MARKET_DEMAND" });
  // 6 G6 location variant
  const isLocationVariant = intent.places.length > 0 && !!intent.primaryServiceId;
  let g6 = null;
  if (isLocationVariant) {
    const allOwnerDeclared = intent.places.every((p) => p.ownerDeclared);
    const pass = allOwnerDeclared && (v.demand || v.visibility);
    g6 = { applies: true, pass, ownerDeclared: allOwnerDeclared, demand: v.demand, visibility: v.visibility };
    if (!pass) fails.push({ gate: 6, kind: "evidence", code: "LOCATION_VARIANT_NOT_JUSTIFIED", blocking: allOwnerDeclared ? "NEEDS_MARKET_DEMAND" : "NEEDS_OWNER_GEOGRAPHY_CONFIRMATION" });
  } else if (proposed.onlyLocationVariants && proposed.status === "POTENTIAL_COLLISION") {
    fails.push({ gate: 3, kind: "evidence", code: "PROPOSED_PAGE_COLLIDES" });
  }
  // 7 G7 learn-type
  const learn = cfg.LEARN_TYPES.includes(intent.intentType);
  if (learn && !v.demand && !v.visibility) fails.push({ gate: 7, kind: "missing", code: "INFORMATIONAL_NEEDS_DEMAND", blocking: "NEEDS_MARKET_DEMAND" });

  // value notes when the gates pass on weaker signals
  if (!v.demand) {
    notes.missing.push("market_demand");
    notes.caps.push([2, CONF_TEXT.demand]);
    if (v.visibility) {
      notes.reasonCodes.push("VISIBILITY_OBSERVED_NOT_DEMAND");
      notes.caps.push([2, CONF_TEXT.visibilityOnly]);
      if (learn || isLocationVariant) notes.blocking.push("NEEDS_MARKET_DEMAND");
    } else notes.reasonCodes.push("MISSING_MARKET_DEMAND");
  }
  return { pass: fails.length === 0, fails, notes, g6, isLocationVariant, learn, values: v };
}

function decideIntent(intent, opps, ownership, collision, cluster, allIntents, ownerships, ctx) {
  const d = intentDecisionBase(intent, opps, ownership, collision, cluster, ctx);
  const types = new Set(opps.map((o) => o.type));
  const owner = ownership.owner;
  const ownerPage = owner ? ctx.pagesByKey.get(owner.pageKey) || null : null;
  const gscKnown = intent.gsc.status !== "not_available";
  const caps = [];
  const parts = [
    [intent.intentConfidence, intent.intentType === "unclassified" ? CONF_TEXT.intentUnclassified : CONF_TEXT.intent],
    [ownership.confidence, CONF_TEXT.ownership],
    [gscKnown ? (SEVERITY[collision.status] >= SEVERITY.POTENTIAL_COLLISION ? 2 : 3) : 1, gscKnown ? CONF_TEXT.collision : CONF_TEXT.gscMissing],
    [oppConfidenceLevel(opps), CONF_TEXT.evidence]
  ];
  if (!ctx.baseline) {
    caps.push([2, CONF_TEXT.noBaseline]);
    d.missing.push("no_baseline");
  }
  if (intent.marketDemand.status !== "available") d.missing.push("market_demand");
  d.missing.push("serp_overlap");
  if (!gscKnown) d.missing.push("search_console_visibility");
  const extraEvidence = intentEvidence(intent, ownership, collision, ctx);
  const set = (fields) => Object.assign(d, fields);
  const altCreateRejected = (codes) => ({ decision: "CREATE", rejectedBecause: codes });
  const finish = () => {
    if (d.recommendedPage && d.recommendedPage.kind === "existing") {
      const p = ctx.pagesByKey.get(d.recommendedPage.pageKey);
      if (p) extraEvidence.push(pageEv(p, "indexability", `סטטוס סריקה: ${eligibilityOf(p).state}`));
      if (!p || p.crawlStatus !== "fetched") caps.push([2, CONF_TEXT.uncrawled]);
    }
    Object.assign(d, aggregateConfidence(parts, caps));
    d.evidence = foldEvidence(opps, extraEvidence);
    d.missing = uniq(d.missing);
    return d;
  };

  // 1 owner rejected every folded opportunity
  if (opps.length && opps.every((o) => o.status === "rejected")) {
    set({ decision: "REJECT", actionDetail: null, reasonCodes: ["OWNER_REJECTED"], blockingConditions: [], recommendedPage: NONE, alternativesConsidered: [{ decision: "IMPROVE", rejectedBecause: ["OWNER_REJECTED"] }, altCreateRejected(["OWNER_REJECTED"])] });
    return finish();
  }
  // 3 missing critical visibility data
  if (!gscKnown && ownership.status === "unknown") {
    set({ decision: "WAIT", actionDetail: null, reasonCodes: ["MISSING_VISIBILITY_DATA"], blockingConditions: ["WAIT_FOR_NEXT_ANALYSIS"], recommendedPage: NONE, alternativesConsidered: [altCreateRejected(["MISSING_VISIBILITY_DATA"])] });
    return finish();
  }
  // 4 HIGH / DUPLICATE among existing pages -> CONSOLIDATE (our recommendation)
  if (collision.status === "HIGH_COLLISION" || collision.status === "DUPLICATE") {
    const involved = uniq(collision.pairs.filter((p) => SEVERITY[p.status] >= SEVERITY.HIGH_COLLISION).flatMap((p) => [p.a, p.b]));
    const cands = ownership.candidates.filter((c) => involved.includes(c.pageKey));
    const fitRank = { fit: 0, unknown: 1, mismatch: 2 };
    const sorted = [...cands].sort((a, b) => (a.eligibility.state === "eligible" ? 0 : 1) - (b.eligibility.state === "eligible" ? 0 : 1) || (b.observedShare || 0) - (a.observedShare || 0) || (b.clicks || 0) - (a.clicks || 0) || (a.bestPosition ?? 999) - (b.bestPosition ?? 999) || fitRank[a.intentFit] - fitRank[b.intentFit] || a.pageKey.localeCompare(b.pageKey));
    const rec = sorted[0];
    if (rec) {
      const declared = involved
        .map((k) => ctx.pagesByKey.get(k))
        .filter((p) => p && p.canonical && p.canonical.state === "points_elsewhere")
        .map((p) => ({ pageKey: p.pageKey, declaredCanonical: p.canonical.target, basis: "observed", note: "the site's own rel=canonical tag (declared preference) - not Google's selected canonical" }));
      if (!collision.declaredCanonicalRelation) caps.push([2, CONF_TEXT.consolidate]);
      if (rec.eligibility.state !== "eligible") caps.push([1, "הדף המומלץ כדף ראשי אינו כשיר כרגע לפי הסריקה"]);
      set({
        decision: "CONSOLIDATE",
        actionDetail: "consolidate_into_owner",
        reasonCodes: [collision.status === "DUPLICATE" ? "COLLISION_DUPLICATE" : "COLLISION_HIGH"],
        blockingConditions: ["HUMAN_REVIEW_REQUIRED"],
        recommendedPage: existing(rec.pageKey, rec.url),
        consolidation: {
          recommendedOwnerPageKey: rec.pageKey,
          recommendedOwnerUrl: rec.url,
          otherPageKeys: involved.filter((k) => k !== rec.pageKey).sort(),
          basis: "recommendation",
          statement: "Our evidence indicates these pages compete for the same search intent and we recommend consolidation. This is not a statement about which URL Google has selected as canonical.",
          declaredCanonicals: declared,
          googleSelectedCanonical: null,
          googleSelectedCanonicalNote: "not observed - M6 has no direct Google evidence (e.g. URL Inspection); Google treats canonical preferences as hints and makes the final choice",
          implementationOptions: ["merge_content", "redirect_301", "canonical_tag", "differentiate_pages"],
          implementationBy: "human"
        },
        alternativesConsidered: [altCreateRejected(["COLLISION_HIGH"]), { decision: "IMPROVE", rejectedBecause: ["COLLISION_HIGH"] }, { decision: "MONITOR", rejectedBecause: ["COLLISION_HIGH"] }]
      });
      d.missing.push("google_selected_canonical");
      return finish();
    }
  }
  // 5 POTENTIAL -> MONITOR
  if (collision.status === "POTENTIAL_COLLISION") {
    set({ decision: "MONITOR", actionDetail: null, reasonCodes: ["COLLISION_POTENTIAL"], blockingConditions: ["NEEDS_SERP_OVERLAP_OR_MORE_DATA"], recommendedPage: owner ? existing(owner.pageKey, owner.url) : NONE, alternativesConsidered: [altCreateRejected(["COLLISION_POTENTIAL"]), { decision: "CONSOLIDATE", rejectedBecause: ["COLLISION_POTENTIAL"] }] });
    return finish();
  }

  if (ownership.acceptable && owner) {
    const createAlt = altCreateRejected(["EXISTING_OWNER"]);
    const j = { evaluated: false, justified: false, distinctOn: [], reason: "an acceptable owner page exists - CREATE excluded by G2", distinctValue: null };
    const target = existing(owner.pageKey, owner.url);
    // 6 blocker on the owner
    if (owner.eligibility.state === "blocked") {
      set({ decision: "IMPROVE", actionDetail: "fix_eligibility", reasonCodes: ["OWNER_HAS_BLOCKER", "EXISTING_OWNER"], blockingConditions: ["CONFIRM_BLOCKER_UNINTENDED"], recommendedPage: target, newPageJustification: j, alternativesConsidered: [createAlt] });
      return finish();
    }
    // 7 ranking / CTR upside
    if (types.has("ranking_upside") || types.has("ctr_upside")) {
      const details = [types.has("ranking_upside") ? "strengthen_content" : null, types.has("ctr_upside") ? "improve_snippet" : null].filter(Boolean);
      set({ decision: "IMPROVE", actionDetail: details[0], actionDetails: details, reasonCodes: ["OWNER_ESTABLISHED", "EXISTING_OWNER"], blockingConditions: [], recommendedPage: target, newPageJustification: j, alternativesConsidered: [createAlt] });
      return finish();
    }
    // 8 probable owner without observed visibility
    if (ownership.status === "probable" && (types.has("page_not_visible") || intent.observedVisibility.status === "none_observed")) {
      if (intent.intentType !== "unclassified") {
        set({ decision: "IMPROVE", actionDetail: "rework_intent", reasonCodes: ["OWNER_PROBABLE_NO_VISIBILITY", "EXISTING_OWNER"], blockingConditions: [], recommendedPage: target, newPageJustification: j, alternativesConsidered: [createAlt] });
      } else {
        set({ decision: "WAIT", actionDetail: null, reasonCodes: ["INTENT_UNCLASSIFIED", "EXISTING_OWNER"], blockingConditions: ["NEEDS_INTENT_CLASSIFICATION"], recommendedPage: target, newPageJustification: j, alternativesConsidered: [createAlt, { decision: "IMPROVE", rejectedBecause: ["INTENT_UNCLASSIFIED"] }] });
      }
      return finish();
    }
    if (!gscKnown) {
      set({ decision: "WAIT", actionDetail: null, reasonCodes: ["MISSING_VISIBILITY_DATA", "EXISTING_OWNER"], blockingConditions: ["WAIT_FOR_NEXT_ANALYSIS"], recommendedPage: target, newPageJustification: j, alternativesConsidered: [createAlt] });
      return finish();
    }
    // 9 nothing actionable
    set({ decision: "REJECT", actionDetail: null, reasonCodes: ["NO_ACTION_NEEDED", "EXISTING_OWNER"], blockingConditions: [], recommendedPage: target, newPageJustification: j, alternativesConsidered: [createAlt, { decision: "IMPROVE", rejectedBecause: ["NO_ACTION_NEEDED"] }] });
    return finish();
  }

  // 10 / 11 owner exists but is not acceptable; 12-15 no owner
  const ownerExists = owner && (ownership.status === "established" || ownership.status === "probable");
  if (ownerExists || ownership.status === "none") {
    const related = relatedPagesFor(intent, ownership, ctx);
    // 12 no owner but a related page with the same task family can absorb it
    if (!ownerExists && related.length) {
      const r = related[0];
      set({ decision: "IMPROVE", actionDetail: "strengthen_content", reasonCodes: ["EXTEND_RELATED_PAGE", "NO_ACCEPTABLE_OWNER"], blockingConditions: [], recommendedPage: existing(r.pageKey, r.url), newPageJustification: { evaluated: true, justified: false, distinctOn: [], comparedWith: { pageKey: r.pageKey, url: r.url }, reason: `${r.url} covers the same service and can serve this user task`, distinctValue: null }, alternativesConsidered: [altCreateRejected(["EXTEND_RELATED_PAGE"])] });
      return finish();
    }
    const comparePage = ownerExists ? ownerPage || { pageKey: owner.pageKey, url: owner.url } : relatedPagesFor(intent, ownership, ctx, { requireFit: false })[0] || null;
    const j = justify(intent, comparePage, ctx);
    d.newPageJustification = j;
    // 11 owner exists, no material difference -> IMPROVE (rework) the owner
    if (ownerExists && !j.justified) {
      set({ decision: "IMPROVE", actionDetail: "rework_intent", reasonCodes: ["OWNER_NOT_ACCEPTABLE_INTENT_MISMATCH", "NEW_PAGE_NOT_JUSTIFIED_SAME_TASK"], blockingConditions: [], recommendedPage: existing(owner.pageKey, owner.url), alternativesConsidered: [altCreateRejected(["NEW_PAGE_NOT_JUSTIFIED_SAME_TASK"])] });
      return finish();
    }
    const proposed = proposedCollisionOf(intent, allIntents, ownerships, ctx, j.justified && j.comparedWith ? j.comparedWith.pageKey : null);
    d.proposedPageCollision = { status: proposed.status, reason: proposed.reason, pairs: proposed.pairs.slice(0, 6) };
    const gates = evaluateCreateGates(intent, ownership, proposed, j, ctx);
    d.createGates = { pass: gates.pass, failed: gates.fails.map((f) => ({ gate: f.gate, kind: f.kind, code: f.code })), g6: gates.g6, values: gates.values };
    const ownerAlt = ownerExists ? [{ decision: "IMPROVE", target: owner.pageKey, rejectedBecause: ["OWNER_NOT_ACCEPTABLE_INTENT_MISMATCH", ...j.distinctOn.map((x) => `NEW_PAGE_JUSTIFIED_${x === "user_task" ? "DISTINCT_TASK" : x === "information_requirement" ? "DISTINCT_INFORMATION" : "DISTINCT_ENTITY"}`)] }] : [];
    if (gates.pass) {
      // Candidate - the run-level G11 / G5 selection decides CREATE vs WAIT.
      const justCodes = uniq(j.distinctOn.map((x) => (x === "user_task" ? "NEW_PAGE_JUSTIFIED_DISTINCT_TASK" : x === "information_requirement" ? "NEW_PAGE_JUSTIFIED_DISTINCT_INFORMATION" : x === "no_existing_page" ? "NO_OWNER_GATES_PASSED" : "NEW_PAGE_JUSTIFIED_DISTINCT_ENTITY")));
      for (const c of gates.notes.caps) caps.push(c);
      set({
        decision: "CREATE",
        actionDetail: "new_page",
        reasonCodes: uniq([...(ownerExists ? ["OWNER_NOT_ACCEPTABLE_INTENT_MISMATCH"] : ["NO_ACCEPTABLE_OWNER"]), ...justCodes, "NO_OWNER_GATES_PASSED", ...gates.notes.reasonCodes]),
        blockingConditions: uniq(gates.notes.blocking),
        recommendedPage: { kind: "new_page_placeholder", pageKey: null, url: null, intentId: intent.intentId, note: "placeholder bound to the intent - M6 creates no page, URL, slug, title or content" },
        alternativesConsidered: [...ownerAlt, ...(cluster.parentPageKey ? [{ decision: "IMPROVE", target: cluster.parentPageKey, rejectedBecause: justCodes.length ? justCodes : ["NO_OWNER_GATES_PASSED"] }] : [])]
      });
      d.missing.push(...gates.notes.missing);
      d._createCandidate = true;
      return finish();
    }
    // gate failures
    const allCodes = uniq(gates.fails.map((f) => f.code));
    const allBlocking = uniq(gates.fails.map((f) => f.blocking).filter(Boolean));
    const collisionFail = gates.fails.find((f) => f.gate === 3);
    const missingFail = gates.fails.find((f) => f.kind === "missing");
    const g6Fail = gates.fails.find((f) => f.gate === 6);
    const justFail = gates.fails.find((f) => f.gate === 2);
    const createAlt = altCreateRejected(allCodes);
    d.missing.push(...gates.notes.missing);
    if (collisionFail) {
      const w = proposed.worst;
      const wp = w && ctx.pagesByKey.get(w.pageKey);
      if (w && wp && eligibilityOf(wp).state === "eligible") {
        set({ decision: "IMPROVE", actionDetail: "strengthen_content", reasonCodes: uniq(["PROPOSED_PAGE_COLLIDES", ...allCodes]), blockingConditions: allBlocking, recommendedPage: existing(w.pageKey, w.url), alternativesConsidered: [createAlt, ...ownerAlt] });
      } else {
        set({ decision: "MONITOR", actionDetail: null, reasonCodes: uniq(["PROPOSED_PAGE_COLLIDES", ...allCodes]), blockingConditions: uniq(["NEEDS_SERP_OVERLAP_OR_MORE_DATA", ...allBlocking]), recommendedPage: NONE, alternativesConsidered: [createAlt, { decision: "IMPROVE", rejectedBecause: ["NO_PAGE_TO_EXTEND"] }] });
      }
      return finish();
    }
    if (missingFail) {
      set({ decision: "WAIT", actionDetail: null, reasonCodes: allCodes.includes("INFORMATIONAL_NEEDS_DEMAND") ? uniq(["MISSING_MARKET_DEMAND", ...allCodes]) : allCodes, blockingConditions: allBlocking, recommendedPage: ownerExists ? existing(owner.pageKey, owner.url) : NONE, alternativesConsidered: [createAlt, ...ownerAlt] });
      return finish();
    }
    if (g6Fail) {
      const svc = relatedPagesFor(intent, { candidates: [] }, ctx, { requireFit: false }).filter((p) => intentFitOf(p, { ...intent, intentType: "local" }, ctx) !== "mismatch")[0] || null;
      if (svc) set({ decision: "IMPROVE", actionDetail: "strengthen_content", reasonCodes: uniq(["LOCATION_VARIANT_NOT_JUSTIFIED", ...allCodes]), blockingConditions: allBlocking, recommendedPage: existing(svc.pageKey, svc.url), alternativesConsidered: [createAlt, ...ownerAlt] });
      else set({ decision: "WAIT", actionDetail: null, reasonCodes: uniq(["LOCATION_VARIANT_NOT_JUSTIFIED", "NO_PAGE_TO_EXTEND", ...allCodes]), blockingConditions: allBlocking, recommendedPage: NONE, alternativesConsidered: [createAlt, { decision: "IMPROVE", rejectedBecause: ["NO_PAGE_TO_EXTEND"] }] });
      return finish();
    }
    if (justFail) {
      // only reachable without an owner page (owner case returned above)
      set({ decision: "WAIT", actionDetail: null, reasonCodes: allCodes, blockingConditions: allBlocking, recommendedPage: NONE, alternativesConsidered: [createAlt] });
      return finish();
    }
  }
  // 16 ownership unclear
  if (ownership.status === "ambiguous" || ownership.status === "contested") {
    set({ decision: "MONITOR", actionDetail: null, reasonCodes: ["OWNERSHIP_UNCLEAR"], blockingConditions: ["WAIT_FOR_NEXT_ANALYSIS"], recommendedPage: NONE, alternativesConsidered: [altCreateRejected(["OWNERSHIP_UNCLEAR"]), { decision: "CONSOLIDATE", rejectedBecause: ["OWNERSHIP_UNCLEAR"] }] });
    return finish();
  }
  // 17 fallback
  set({ decision: "WAIT", actionDetail: null, reasonCodes: ["INSUFFICIENT_EVIDENCE"], blockingConditions: ["WAIT_FOR_NEXT_ANALYSIS"], recommendedPage: NONE, alternativesConsidered: [altCreateRejected(["INSUFFICIENT_EVIDENCE"])] });
  return finish();
}

// ---------------------------------------------------------------------------
// G11 + G5 selection (run level)

function selectCreates(decisions, intentsById, ctx) {
  const policy = ctx.policy;
  const cands = decisions.filter((d) => d._createCandidate);
  const rank = (d) => {
    const it = intentsById.get(d.intentId);
    return [it.ownerPriority ? 0 : 1, -(it.marketDemand.monthlyVolume || 0), -(it.observedVisibility.impressions || 0), -(LEVEL[d.confidence] || 0), d.intentId];
  };
  cands.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1;
    return 0;
  });
  const perCluster = new Map();
  for (const d of cands) perCluster.set(d.cluster.clusterId, (perCluster.get(d.cluster.clusterId) || 0) + 1);
  const firstInCluster = new Map();
  let total = 0;
  const toWait = (d, code, deps = []) => {
    d.decision = "WAIT";
    d.actionDetail = null;
    d.reasonCodes = uniq([code, ...d.reasonCodes]);
    d.blockingConditions = uniq([...d.blockingConditions, "WAIT_FOR_NEXT_ANALYSIS"]);
    d.deferredCreate = { recommendedPage: d.recommendedPage, reason: code, note: "the CREATE rationale is kept; only the run-level limit deferred it" };
    d.recommendedPage = NONE;
    d.alternativesConsidered = [{ decision: "CREATE", rejectedBecause: [code] }, ...d.alternativesConsidered];
    d.dependencies = deps;
  };
  for (const d of cands) {
    const cl = d.cluster.clusterId;
    if (perCluster.get(cl) >= 2) d.reasonCodes = uniq([...d.reasonCodes, "CLUSTER_FRAGMENTATION_RISK"]);
    if (policy.createBudgetPerRun === 0 || policy.createsPerClusterPerRun === 0) toWait(d, "CREATE_DISABLED_BY_POLICY");
    else if ((firstInCluster.get(cl) || []).length >= policy.createsPerClusterPerRun) toWait(d, "CLUSTER_CREATE_PENDING", firstInCluster.get(cl).map((id) => ({ decisionId: id, relation: "same_cluster" })));
    else if (total >= policy.createBudgetPerRun) toWait(d, "CREATE_BUDGET_EXCEEDED");
    else {
      total++;
      firstInCluster.set(cl, [...(firstInCluster.get(cl) || []), d.decisionId]);
    }
    delete d._createCandidate;
  }
  return { createCandidates: cands.length, creates: total };
}

// ---------------------------------------------------------------------------
// page and site scope (§G.2)

function decidePage(pageKey, opps, ownerPageKeys, consolidations, ctx) {
  const page = ctx.pagesByKey.get(pageKey) || null;
  const types = new Set(opps.map((o) => o.type));
  const isOwner = ownerPageKeys.has(pageKey);
  const isCandidate = ctx._candidatePages.has(pageKey);
  const d = {
    decisionId: `${ctx.businessId}_page_${sha(pageKey)}`,
    businessId: ctx.businessId,
    scope: "page",
    intentId: null,
    pageKey,
    signalKey: null,
    unitTitle: page ? page.title || page.url : pageKey,
    opportunityIds: opps.map((o) => o.id),
    existingOwnerPageKey: null,
    existingOwnerUrl: null,
    ownership: null,
    collision: null,
    cluster: null,
    dependencies: [],
    consolidation: null,
    newPageJustification: { evaluated: false, justified: false, distinctOn: [], reason: "page-scope decisions never create pages", distinctValue: null },
    businessValue: null,
    ...effortValue(opps),
    impactInputs: pickImpactInputs(opps, { targetType: "page", targetId: pageKey, baselineId: ctx.baseline ? ctx.baseline.id : null, current: null, period: null }),
    targetEntityIds: [],
    basis: "recommendation",
    missing: ctx.baseline ? [] : ["no_baseline"]
  };
  const caps = ctx.baseline ? [] : [[2, CONF_TEXT.noBaseline]];
  const parts = [[oppConfidenceLevel(opps), CONF_TEXT.evidence]];
  const createAlt = { decision: "CREATE", rejectedBecause: ["EXISTING_OWNER"] };
  const target = page ? existing(page.pageKey, page.url) : NONE;
  const extra = page ? [pageEv(page, "indexability", `סטטוס סריקה: ${eligibilityOf(page).state}`)] : [];
  const consolidation = consolidations.get(pageKey);
  if (opps.length && opps.every((o) => o.status === "rejected")) Object.assign(d, { decision: "REJECT", actionDetail: null, reasonCodes: ["OWNER_REJECTED"], blockingConditions: [], recommendedPage: NONE, alternativesConsidered: [{ decision: "IMPROVE", rejectedBecause: ["OWNER_REJECTED"] }] });
  else if (!page || page.crawlStatus !== "fetched") Object.assign(d, { decision: "WAIT", actionDetail: null, reasonCodes: ["NO_PAGE_TO_EXTEND"], blockingConditions: ["WAIT_FOR_NEXT_ANALYSIS"], recommendedPage: NONE, alternativesConsidered: [{ decision: "IMPROVE", rejectedBecause: ["NO_PAGE_TO_EXTEND"] }] });
  else if (consolidation && consolidation.recommendedOwnerPageKey !== pageKey) Object.assign(d, { decision: "MONITOR", actionDetail: null, reasonCodes: ["SUBSUMED_BY_DECISION"], blockingConditions: ["HUMAN_REVIEW_REQUIRED"], recommendedPage: target, dependencies: [{ decisionId: consolidation.decisionId, relation: "subsumed_by" }], alternativesConsidered: [{ decision: "IMPROVE", rejectedBecause: ["SUBSUMED_BY_DECISION"] }] });
  else if (types.has("technical_blocker") && (isOwner || isCandidate)) {
    const details = ["fix_eligibility", ...(types.has("internal_linking") && isOwner ? ["add_internal_links"] : [])];
    Object.assign(d, { decision: "IMPROVE", actionDetail: "fix_eligibility", actionDetails: details, reasonCodes: ["OWNER_HAS_BLOCKER"], blockingConditions: ["CONFIRM_BLOCKER_UNINTENDED"], recommendedPage: target, alternativesConsidered: [createAlt] });
  } else if (types.has("internal_linking") && isOwner) Object.assign(d, { decision: "IMPROVE", actionDetail: "add_internal_links", reasonCodes: ["OWNER_ESTABLISHED"], blockingConditions: [], recommendedPage: target, alternativesConsidered: [createAlt] });
  else Object.assign(d, { decision: "MONITOR", actionDetail: null, reasonCodes: ["NOT_AN_OWNER_PAGE"], blockingConditions: [], recommendedPage: target, alternativesConsidered: [{ decision: "IMPROVE", rejectedBecause: ["NOT_AN_OWNER_PAGE"] }] });
  Object.assign(d, aggregateConfidence(parts, caps));
  d.evidence = foldEvidence(opps, extra);
  return d;
}

function decideSite(signalKey, opps, ctx) {
  const o = opps[0];
  const conflict = signalKey === "fact_consistency" && ((o.signals && o.signals.geo && o.signals.geo.status) === "partial");
  const status = o.signals && o.signals.geo ? o.signals.geo.status : null;
  const d = {
    decisionId: `${ctx.businessId}_site_${signalKey}`,
    businessId: ctx.businessId,
    scope: "site",
    intentId: null,
    pageKey: null,
    signalKey,
    unitTitle: o.title,
    opportunityIds: opps.map((x) => x.id),
    existingOwnerPageKey: null,
    existingOwnerUrl: null,
    ownership: null,
    collision: null,
    cluster: null,
    dependencies: [],
    consolidation: null,
    newPageJustification: { evaluated: false, justified: false, distinctOn: [], reason: "site-scope decisions never create pages", distinctValue: null },
    businessValue: null,
    ...effortValue(opps),
    impactInputs: pickImpactInputs(opps, null),
    targetEntityIds: [`brand:${ctx.businessId}`],
    basis: "recommendation",
    missing: ctx.baseline ? [] : ["no_baseline"]
  };
  const caps = ctx.baseline ? [] : [[2, CONF_TEXT.noBaseline]];
  const parts = [[oppConfidenceLevel(opps), CONF_TEXT.evidence]];
  if (opps.every((x) => x.status === "rejected")) Object.assign(d, { decision: "REJECT", actionDetail: null, reasonCodes: ["OWNER_REJECTED"], blockingConditions: [], recommendedPage: NONE, alternativesConsidered: [{ decision: "IMPROVE", rejectedBecause: ["OWNER_REJECTED"] }] });
  else if (conflict) Object.assign(d, { decision: "IMPROVE", actionDetail: "clarify_business_facts", reasonCodes: ["BUSINESS_FACTS_CONFLICTING"], blockingConditions: [], recommendedPage: { kind: "business_facts", pageKey: null, url: null }, alternativesConsidered: [{ decision: "CREATE", rejectedBecause: ["NO_ACTION_NEEDED"] }] });
  else if (status === "missing") {
    caps.push([2, "התועלת מבוססת על הנחה, לא על מדידה"]);
    Object.assign(d, { decision: "IMPROVE", actionDetail: "clarify_business_facts", reasonCodes: ["BUSINESS_FACTS_MISSING"], blockingConditions: [], recommendedPage: { kind: "business_facts", pageKey: null, url: null }, alternativesConsidered: [{ decision: "CREATE", rejectedBecause: ["NO_ACTION_NEEDED"] }] });
  } else Object.assign(d, { decision: "MONITOR", actionDetail: null, reasonCodes: ["INSUFFICIENT_EVIDENCE"], blockingConditions: [], recommendedPage: NONE, alternativesConsidered: [{ decision: "IMPROVE", rejectedBecause: ["INSUFFICIENT_EVIDENCE"] }] });
  Object.assign(d, aggregateConfidence(parts, caps));
  d.evidence = foldEvidence(opps, []);
  return d;
}

// ---------------------------------------------------------------------------
// plain-Hebrew summary (one or two sentences). Never claims Google's
// canonical choice; visibility is never called demand.

function summaryOf(d) {
  const page = d.recommendedPage && d.recommendedPage.url;
  switch (d.decision) {
    case "CREATE":
      return `דף חדש מוצדק לכוונת החיפוש „${d.unitTitle}“ (${(d.newPageJustification.distinctOn || []).join(", ") || "אין דף קיים"}). זו המלצה בלבד — המערכת לא יוצרת דף, כתובת או תוכן.`;
    case "IMPROVE":
      if (d.scope === "site") return "לחדד את פרטי העסק באתר (פעולה על האתר כולו, בלי דף חדש).";
      if (d.scope === "page") return `לטפל בדף הקיים ${page} (${d.actionDetail === "fix_eligibility" ? "לבדוק חסימה טכנית" : "להוסיף קישורים פנימיים"}).`;
      return `לשפר את הדף הקיים ${page} במקום ליצור דף חדש.`;
    case "CONSOLIDATE":
      return `לפי הנתונים שלנו, כמה דפים מתחרים על אותה כוונת חיפוש — מומלץ להשאיר את ${page} כדף הראשי. זו המלצה שלנו על סמך הראיות הזמינות, לא החלטה של Google לגבי הכתובת הקנונית.`;
    case "MONITOR":
      return "מעקב — יש תצפית, אבל עדיין אין מספיק ראיות לפעולה.";
    case "WAIT":
      return "ממתינים — חסרים נתונים או שמגבלת בטיחות דחתה את הפעולה. לא נוצר דבר.";
    case "REJECT":
      return d.reasonCodes.includes("OWNER_REJECTED") ? "נדחה על ידך." : d.reasonCodes.includes("TOPIC_NO_LONGER_APPROVED") ? "הנושא כבר לא מאושר." : "אין צורך בפעולה כרגע.";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------

function decide(input) {
  const ctx = buildContext(input);
  const approved = ctx.topics.filter((t) => APPROVED.includes(t.status));
  const profiles = approved.map((t) => profileTopic(t, ctx));
  const groups = groupTopics(profiles);
  const intents = groups.map((g) => buildIntent(g, ctx)).sort(byStr("intentId"));
  const intentsById = new Map(intents.map((i) => [i.intentId, i]));
  const intentByTopic = new Map();
  for (const i of intents) for (const t of i.topicIds) intentByTopic.set(t, i.intentId);

  // ownership + clusters
  const ownerships = new Map(intents.map((i) => [i.intentId, ownershipOf(i, ctx)]));
  const clusters = new Map();
  for (const i of intents) {
    if (!clusters.has(i.clusterId)) clusters.set(i.clusterId, []);
    clusters.get(i.clusterId).push(i.intentId);
  }
  const clusterInfo = (i) => {
    const parent = i.primaryServiceId ? servicePagesFor(i.primaryServiceId, ctx).find((p) => eligibilityOf(p).state === "eligible") || null : null;
    return { clusterId: i.clusterId, siblingIntentIds: clusters.get(i.clusterId).filter((x) => x !== i.intentId), parentPageKey: parent ? parent.pageKey : null, parentPageUrl: parent ? parent.url : null, basis: "inference", note: "derived content cluster (primary service entity); full portfolio planning is M11" };
  };
  ctx._candidatePages = new Set([...ownerships.values()].flatMap((o) => o.candidates.map((c) => c.pageKey)));

  // fold opportunities into units (G1)
  const byIntent = new Map();
  const byPage = new Map();
  const bySite = new Map();
  const unmapped = [];
  for (const o of ctx.opps) {
    if (TOPIC_OPP_TYPES.has(o.type)) {
      const iid = intentByTopic.get((o.targetTopicIds || [])[0]);
      if (!iid) {
        unmapped.push({ id: o.id, reason: "TOPIC_NO_LONGER_APPROVED" });
        continue;
      }
      if (!byIntent.has(iid)) byIntent.set(iid, []);
      byIntent.get(iid).push(o);
    } else if (PAGE_OPP_TYPES.has(o.type)) {
      const key = (o.targetPageKeys || [])[0];
      if (!key) {
        unmapped.push({ id: o.id, reason: "NO_PAGE_TO_EXTEND" });
        continue;
      }
      if (!byPage.has(key)) byPage.set(key, []);
      byPage.get(key).push(o);
    } else if (o.type === "entity_clarity") {
      const key = (o.signals && o.signals.geo && o.signals.geo.signal) || o.dedupeKey;
      if (!bySite.has(key)) bySite.set(key, []);
      bySite.get(key).push(o);
    } else unmapped.push({ id: o.id, reason: "INSUFFICIENT_EVIDENCE" });
  }

  const decisions = [];
  const collisions = new Map();
  for (const i of intents) {
    const own = ownerships.get(i.intentId);
    const col = collisionOf(i, own, ctx);
    collisions.set(i.intentId, col);
    decisions.push(decideIntent(i, byIntent.get(i.intentId) || [], own, col, clusterInfo(i), intents, ownerships, ctx));
  }
  const selection = selectCreates(decisions, intentsById, ctx);

  const ownerPageKeys = new Set([...ownerships.values()].filter((o) => o.acceptable && o.owner).map((o) => o.owner.pageKey));
  const consolidations = new Map();
  for (const d of decisions.filter((x) => x.decision === "CONSOLIDATE")) {
    for (const k of d.consolidation.otherPageKeys) consolidations.set(k, { decisionId: d.decisionId, recommendedOwnerPageKey: d.consolidation.recommendedOwnerPageKey });
  }
  for (const [pageKey, opps] of [...byPage.entries()].sort((a, b) => a[0].localeCompare(b[0]))) decisions.push(decidePage(pageKey, opps, ownerPageKeys, consolidations, ctx));
  for (const [key, opps] of [...bySite.entries()].sort((a, b) => a[0].localeCompare(b[0]))) decisions.push(decideSite(key, opps, ctx));

  for (const d of decisions) {
    d.summary = summaryOf(d);
    d.modelVersion = cfg.DECISION_ENGINE_VERSION;
    d.configVersion = cfg.DECISION_CONFIG_VERSION;
  }
  decisions.sort(byStr("decisionId"));

  const intentDocs = intents.map((i) => {
    const own = ownerships.get(i.intentId);
    const col = collisions.get(i.intentId);
    const ci = clusterInfo(i);
    return {
      intentId: i.intentId,
      businessId: i.businessId,
      anchorTopicId: i.anchorTopicId,
      title: i.title,
      topicIds: i.topicIds,
      queryFamilyIds: i.queryFamilyIds,
      queryCount: i.queryCount,
      sampleQueries: i.sampleQueries,
      intentType: i.intentType,
      secondaryIntentTypes: i.secondaryIntentTypes,
      intentBasis: "inference",
      intentEvidence: i.intentEvidence,
      intentConfidence: LEVEL_NAME[i.intentConfidence],
      userTask: i.userTask,
      entityRefs: i.entityRefs,
      clusterId: i.clusterId,
      cluster: ci,
      ownership: {
        status: own.status,
        basis: own.basis,
        primaryOwnerPageKey: own.primaryOwnerPageKey,
        primaryOwnerUrl: own.primaryOwnerUrl,
        candidates: own.candidates.map((c) => ({ pageKey: c.pageKey, url: c.url, sources: c.sources, role: c.role, observedShare: c.observedShare, clickShare: c.clickShare, bestPosition: c.bestPosition, eligibility: c.eligibility.state, blocker: c.eligibility.blocker, intentFit: c.intentFit, entityFit: c.entityFit })),
        confidence: LEVEL_NAME[own.confidence],
        acceptable: own.acceptable,
        reasons: own.reasons,
        thresholds: own.thresholds
      },
      cannibalization: { status: col.status, reason: col.reason, pairs: col.pairs, serpOverlap: "missing", googleSelectedCanonical: null, thresholds: { ...cfg.HEURISTICS.collision, basis: "assumption", note: "internal heuristics - not Google-defined thresholds" } },
      businessValue: i.businessValue,
      status: "active",
      modelVersion: cfg.DECISION_ENGINE_VERSION,
      configVersion: cfg.DECISION_CONFIG_VERSION
    };
  });

  const count = (key) => decisions.reduce((a, d) => ((a[d[key]] = (a[d[key]] || 0) + 1), a), {});
  const byCluster = {};
  for (const d of decisions.filter((x) => x.cluster)) {
    const c = (byCluster[d.cluster.clusterId] = byCluster[d.cluster.clusterId] || {});
    c[d.decision] = (c[d.decision] || 0) + 1;
  }
  return {
    intents: intentDocs,
    decisions,
    unmappedOpportunities: unmapped,
    summary: {
      intents: intents.length,
      approvedTopics: approved.length,
      decisions: decisions.length,
      byDecision: count("decision"),
      byScope: count("scope"),
      byCluster,
      createCandidates: selection.createCandidates,
      creates: selection.creates,
      foldedOpportunities: ctx.opps.length - unmapped.length,
      unmappedOpportunities: unmapped.length
    },
    policy: ctx.policy
  };
}

module.exports = {
  decide,
  // exported for tests
  normalize,
  jaccard,
  tokens,
  eligibilityOf,
  intentFitOf,
  pageKeyOf,
  APPROVED
};
