// GuyHadas Visibility OS - M7 ImpactPrediction rules (docs/M7_DESIGN.md §4).
//
// PURE and deterministic: no Firestore, no network, no clock. Every input is
// passed in explicitly; the same input always produces the same prediction
// (content and id), whatever order its arrays arrive in.
//
// What a prediction says - and only this:
//   - three SEPARATE time ranges in whole days after publication:
//       A first observable signal, B meaningful SEO signal,
//       C meaningful business impact;
//   - ORDINAL direction/size for visibility, ranking and traffic;
//   - an ordinal confidence (capped at medium in v1) with plain reasons;
//   - every factor used, and every factor that is unknown.
// Never a date, never a number of clicks, leads or revenue. Unknown inputs
// stay unknown - they are never replaced by 0.

const crypto = require("crypto");
const cfg = require("./predictionConfig");

const LEVEL = { low: 1, medium: 2, high: 3 };
const LEVEL_NAME = { 1: "low", 2: "medium", 3: "high" };
const BAND_ORDER = ["none", "small", "moderate", "large"];
const CLASS_ORDER = ["technical_eligibility", "snippet", "internal_linking", "content", "intent_correction", "consolidation", "new_page", "entity_facts"];
const DAY_MS = 86400000;

// --- helpers -----------------------------------------------------------------

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(sortKeysDeep(value))).digest("hex");
}

const sha16 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
const uniqSorted = (arr) => [...new Set((arr || []).filter((x) => x != null))].sort();

function toMs(ts) {
  if (ts == null) return null;
  if (typeof ts === "number") return ts;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts._seconds === "number") return ts._seconds * 1000;
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return null;
}

// --- change classes (§4.1) ---------------------------------------------------

function classesFromActionDetails(details) {
  return uniqSorted((details || []).map((d) => cfg.ACTION_DETAIL_CLASS[d]).filter(Boolean));
}

// Recorded elements -> classes. `decision` is the M6 decision value
// (CONSOLIDATE turns canonical tags into consolidation), `scope` the M6 unit
// scope (site-wide structured data = business facts).
function classesFromElements(elements, { intentChange = false, decision = null, scope = null, fallbackDetails = [] } = {}) {
  const el = new Set(elements || []);
  const out = new Set();
  const contentEls = ["body_content", "headings", "h1"].some((e) => el.has(e));
  if (el.has("noindex_removed") || el.has("robots_rule")) out.add("technical_eligibility");
  if (el.has("canonical_tag")) out.add(decision === "CONSOLIDATE" ? "consolidation" : "technical_eligibility");
  if (el.has("redirect") || el.has("content_merged")) out.add("consolidation");
  if (el.has("internal_links_added")) out.add("internal_linking");
  if (contentEls) out.add(intentChange ? "intent_correction" : "content");
  if (el.has("new_page_published")) out.add("new_page");
  if (el.has("business_facts")) out.add("entity_facts");
  if (el.has("structured_data")) out.add(scope === "site" ? "entity_facts" : "snippet");
  // title / meta description alone are a snippet change; with content
  // changes they are part of the content change ("± title/meta").
  if ((el.has("title") || el.has("meta_description")) && !contentEls) out.add("snippet");
  if (!out.size) for (const c of classesFromActionDetails(fallbackDetails)) out.add(c);
  return [...out].sort();
}

const bMaxOf = (cls) => {
  const p = cfg.PRIORS[cls];
  return p ? (p.B ? p.B[1] : p.A[1]) : 0;
};

// A multi-class change takes the class with the largest stage-B maximum.
function primaryClassOf(classes) {
  const list = (classes || []).filter((c) => cfg.PRIORS[c]);
  if (!list.length) return null;
  return [...list].sort((a, b) => bMaxOf(b) - bMaxOf(a) || CLASS_ORDER.indexOf(a) - CLASS_ORDER.indexOf(b))[0];
}

function materialityOf(classes) {
  const m = (classes || []).map((c) => cfg.MATERIALITY[c]).filter(Boolean);
  if (m.includes("major")) return "major";
  if (m.includes("moderate")) return "moderate";
  if (m.includes("site")) return "site";
  return null;
}

// --- eligibility (M4 modifier) ----------------------------------------------

function eligibilityBlockerOf(page) {
  if (!page) return null;
  const idx = page.indexability && page.indexability.state ? page.indexability.state : page.indexability;
  const rob = page.robots && page.robots.state ? page.robots.state : page.robots;
  const can = page.canonical && page.canonical.state ? page.canonical.state : page.canonical;
  if (idx === "non_indexable") return "non_indexable";
  if (rob === "blocked") return "blocked_by_robots";
  if (can === "points_elsewhere") return "canonical_points_elsewhere";
  return null;
}

// --- site-level series (bands, so a new daily snapshot does not churn ids) --

function volatilityOf(searchSnapshots) {
  const m = cfg.MODIFIERS;
  const series = (searchSnapshots || [])
    .map((s) => ({ ms: toMs(s.retrievedAt) ?? toMs(s.retrievedAtMs), impressions: s.data && typeof s.data.impressions === "number" ? s.data.impressions : null, id: s.id }))
    .filter((s) => s.ms != null && s.impressions != null)
    .sort((a, b) => a.ms - b.ms || String(a.id).localeCompare(String(b.id)))
    .slice(-m.volatilitySnapshots);
  if (series.length < m.minSnapshotsForVolatility) return { status: "insufficient_history", snapshots: series.length, band: "unknown" };
  const vals = series.map((s) => s.impressions);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean <= 0) return { status: "computed", snapshots: series.length, cv: null, band: "unknown" };
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
  const cv = Math.round((sd / mean) * 1000) / 1000;
  return { status: "computed", snapshots: series.length, cv, band: cv > m.highVolatilityCv ? "high" : "normal" };
}

function siteActivityOf(latestSearchSnapshot) {
  if (!latestSearchSnapshot || !latestSearchSnapshot.data || typeof latestSearchSnapshot.data.impressions !== "number") return { status: "unknown", band: "unknown" };
  const impressions = latestSearchSnapshot.data.impressions;
  return { status: "available", impressions28d: impressions, band: impressions < cfg.MODIFIERS.lowActivityImpressions ? "low" : "normal" };
}

// Retroactive filter (AD-1): only evidence whose timestamp is strictly
// before `cutoffMs` may feed a prediction re-derived at recording time.
// Each list item is {ms, ...}; returns the newest qualifying item or null.
function latestBefore(items, cutoffMs, msOf = (x) => x.ms) {
  return (
    (items || [])
      .filter((x) => msOf(x) != null && msOf(x) < cutoffMs)
      .sort((a, b) => msOf(b) - msOf(a) || String(b.id || "").localeCompare(String(a.id || "")))[0] || null
  );
}

function preChangeEvidence({ intelligenceRuns = [], searchSnapshots = [], trafficSnapshots = [], baselines = [] }, cutoffMs) {
  const run = latestBefore(intelligenceRuns.filter((r) => r.status === "completed"), cutoffMs, (r) => r.completedAtMs);
  const snaps = searchSnapshots.filter((s) => {
    const ms = toMs(s.retrievedAt) ?? toMs(s.retrievedAtMs);
    return ms != null && ms < cutoffMs;
  });
  const latestSearch = latestBefore(snaps, cutoffMs, (s) => toMs(s.retrievedAt) ?? toMs(s.retrievedAtMs));
  const latestTraffic = latestBefore(trafficSnapshots, cutoffMs, (s) => toMs(s.retrievedAt) ?? toMs(s.retrievedAtMs));
  const baseline = latestBefore(baselines, cutoffMs, (b) => b.capturedAtMs);
  return { run, searchSnapshots: snaps, latestSearch, latestTraffic, baseline };
}

// --- the prediction ----------------------------------------------------------

function factor(key, value, basis, effect, note = null) {
  return { key, value: value === undefined ? null : value, basis, effect, ...(note ? { note } : {}) };
}

// Ranges in days -> outward-rounded, bounded integers (§4.4).
function finalizeStages(raw) {
  const out = {};
  for (const s of ["A", "B", "C"]) {
    if (!raw[s]) {
      out[s] = null;
      continue;
    }
    let min = Math.max(1, Math.floor(raw[s][0] + 1e-9));
    let max = Math.min(cfg.RANGE_CAP_DAYS, Math.ceil(raw[s][1] - 1e-9));
    min = Math.min(min, cfg.RANGE_CAP_DAYS - 1);
    if (max <= min) max = min + 1;
    out[s] = [min, max];
  }
  // A max <= B max <= C max: a later stage is raised to match.
  if (out.A && out.B && out.B[1] < out.A[1]) out.B[1] = out.A[1];
  if (out.B && out.C && out.C[1] < out.B[1]) out.C[1] = out.B[1];
  if (!out.B && out.A && out.C && out.C[1] < out.A[1]) out.C[1] = out.A[1];
  return out;
}

const weeks = (r) => (r ? [Math.max(1, Math.floor(r[0] / 7)), Math.max(1, Math.ceil(r[1] / 7))] : null);

function stageDoc(range, label, unavailable) {
  if (!range) return { status: unavailable, minDays: null, maxDays: null, minWeeks: null, maxWeeks: null, label, basis: cfg.BASIS };
  const w = weeks(range);
  return { status: "range", minDays: range[0], maxDays: range[1], minWeeks: w[0], maxWeeks: w[1], label, basis: cfg.BASIS };
}

function lowerBand(band) {
  const i = BAND_ORDER.indexOf(band);
  return i > 1 ? BAND_ORDER[i - 1] : band;
}

function magnitudesOf(primary, input) {
  const vis = input.visibility || { status: "unknown" };
  const pos = vis.status === "observed" && typeof vis.position === "number" ? vis.position : null;
  const note = "ordinal expectation, not a promise";
  const mk = (direction, band, extra = null) => ({ direction, band, basis: cfg.BASIS, note: extra ? `${note}; ${extra}` : note });
  let visibility;
  let ranking;
  switch (primary) {
    case "snippet":
      visibility = mk("none", "none", "a title/description change targets click-through rate, not visibility");
      ranking = mk("none", "none", "a snippet change is not expected to move the position");
      break;
    case "content":
    case "intent_correction":
    case "internal_linking":
      if (pos == null) {
        visibility = mk("increase", "unknown", "current position unknown");
        ranking = mk("unknown", "unknown", "current position unknown");
      } else if (pos <= 3) {
        visibility = mk("increase", "small", "already in the 1-3 band");
        ranking = mk("hold", "small", "already in the 1-3 band");
      } else if (pos <= 20) {
        visibility = mk("increase", "moderate");
        ranking = mk("increase", "moderate", pos <= 10 ? "toward the 1-3 band possible" : "toward the 4-10 band possible");
      } else {
        visibility = mk("increase", "small");
        ranking = mk("increase", "small", "from beyond position 20");
      }
      break;
    case "technical_eligibility": {
      const blocked = !!eligibilityBlockerOf(input.target && input.target.page);
      const history = vis.status === "observed" && (vis.impressions || 0) > 0;
      visibility = blocked && history ? mk("increase", "large", "the page is currently not eligible and had observed visibility") : mk("increase", "unknown");
      ranking = pos == null ? mk("unknown", "unknown", "current position unknown") : mk(visibility.direction, visibility.band);
      break;
    }
    case "consolidation":
      visibility = mk("temporary_volatility_then_increase", "moderate", "redirects and canonical signals are processed by Google on its own timeline");
      ranking = mk("temporary_volatility_then_increase", pos == null ? "unknown" : "moderate");
      break;
    case "new_page":
      visibility = mk("increase", "unknown", "a new URL has no observed history");
      ranking = mk("unknown", "unknown", "a new URL has no position yet");
      break;
    default:
      visibility = mk("unknown", "unknown", "site-wide business facts target no query-level metric");
      ranking = mk("unknown", "unknown");
  }
  const clicks = vis.status === "observed" && (vis.clicks || 0) > 0;
  let traffic;
  if (primary === "snippet") traffic = vis.status === "observed" && (vis.impressions || 0) > 0 ? mk("increase", "small", "via click-through rate") : mk("unknown", "unknown", "no observed impressions");
  else if (clicks && visibility.band !== "unknown" && visibility.direction !== "unknown") traffic = mk(visibility.direction, lowerBand(visibility.band), "one band below the visibility expectation");
  else traffic = mk("unknown", "unknown", clicks ? "visibility expectation unknown" : "no observed clicks on the target");
  const t = (input.site && input.site.traffic) || { status: "unknown" };
  const measurable = t.status === "available" && (t.organicSessions != null || t.conversions != null);
  const business = {
    measurable,
    scope: measurable ? "site" : null,
    basis: cfg.BASIS,
    note: measurable ? "site-level organic sessions / conversions only - page-level GA4 is deferred" : "no organic-sessions or conversion data stored - business impact cannot be measured yet"
  };
  return { visibility, ranking, traffic, business };
}

// input: see docs/M7_IMPLEMENTATION_NOTES.md §2 (normalized prediction input).
function predict(input) {
  const m = cfg.MODIFIERS;
  const factors = [];
  const confReasons = ["v1 priors are uncalibrated internal heuristics - confidence is capped at medium until M9"];
  const decision = input.decision || {};
  const change = input.change || null;
  const scope = decision.scope || null;
  const classes = change
    ? classesFromElements(change.changedElements, { intentChange: !!change.intentChange, decision: decision.decision, scope, fallbackDetails: decision.actionDetails || [decision.actionDetail] })
    : classesFromActionDetails(decision.actionDetails && decision.actionDetails.length ? decision.actionDetails : [decision.actionDetail]);
  const primary = primaryClassOf(classes);
  if (!primary) throw new Error("predict: no change class - the decision has no actionable detail");
  const page = input.target ? input.target.page : null;
  const vis = input.visibility || { status: "unknown" };
  const site = input.site || {};
  factors.push(factor("change_class", primary, change ? "owner_reported" : "inference", "selects the prior", classes.length > 1 ? `classes: ${classes.join(", ")}` : null));

  // M4 eligibility block (no ranges until the blocker is fixed)
  const blocker = primary === "technical_eligibility" || primary === "new_page" || primary === "entity_facts" ? null : eligibilityBlockerOf(page);
  const prior = cfg.PRIORS[primary];
  const raw = { A: prior.A ? [...prior.A] : null, B: prior.B ? [...prior.B] : null, C: prior.C ? [...prior.C] : null };
  const mul = (stage, f, which = "both") => {
    if (!raw[stage]) return;
    if (which !== "upper") raw[stage][0] *= f;
    if (which !== "lower") raw[stage][1] *= f;
  };
  const pageClass = primary !== "new_page" && primary !== "entity_facts";

  // M1 target visibility / M2 position band
  if (primary !== "entity_facts") {
    if (vis.status === "unknown") factors.push(factor("target_visibility", null, "unknown", "none", "Search Console visibility for the target is unavailable"));
    else if (vis.status === "zero" || (vis.status === "observed" && !(vis.impressions > 0))) {
      if (pageClass) {
        mul("A", m.zeroVisibility.A);
        mul("B", m.zeroVisibility.B);
        mul("C", m.zeroVisibility.C);
        factors.push(factor("target_visibility", 0, "observed", "A x1.2, B x1.3, C x1.3", "zero impressions observed in the analysis period"));
      } else factors.push(factor("target_visibility", 0, "observed", "none", "zero impressions observed for the intent"));
    } else {
      const visible = vis.impressions >= m.visibleImpressionFloor && typeof vis.position === "number" && vis.position <= m.visiblePositionMax;
      if (visible && m.visibleClasses.includes(primary)) {
        mul("B", m.visibleB);
        factors.push(factor("target_visibility", vis.impressions, "observed", "B x0.85", `position ${vis.position}`));
      } else factors.push(factor("target_visibility", vis.impressions, "observed", "none", visible ? null : "below the visibility floor or beyond position 20"));
      if (typeof vis.position === "number" && m.visibleClasses.includes(primary)) {
        if (vis.position > 20) {
          mul("B", m.positionOver20B);
          factors.push(factor("position_band", "over_20", "observed", "B x1.25"));
        } else if (vis.position > 10) {
          mul("B", m.position11to20B);
          factors.push(factor("position_band", "11_20", "observed", "B x1.1"));
        } else factors.push(factor("position_band", vis.position <= 3 ? "1_3" : "4_10", "observed", "none"));
      } else if (vis.position == null) factors.push(factor("position_band", null, "unknown", "none"));
    }
  }

  // M3 discoverability
  if (pageClass || primary === "new_page") {
    if (!page) factors.push(factor("discoverability", null, "unknown", "none", primary === "new_page" ? "the new page has not been crawled yet" : "target page not in the crawl"));
    else {
      const inbound = typeof page.inboundInternalCount === "number" ? page.inboundInternalCount : null;
      const orphan = page.orphan === "no_inbound_from_crawled_pages" || inbound === 0;
      if (orphan && m.orphanClasses.includes(primary)) {
        mul("A", m.orphanA);
        factors.push(factor("discoverability", inbound, "observed", "A x1.3", "no inbound internal link from crawled pages"));
      } else factors.push(factor("discoverability", inbound, inbound == null ? "unknown" : "observed", "none"));
      if (page.sitemap === "absent") {
        mul("A", m.notInSitemapA);
        factors.push(factor("sitemap", "absent", "observed", "A x1.15"));
      } else factors.push(factor("sitemap", page.sitemap || "unknown", page.sitemap && page.sitemap !== "unknown" ? "observed" : "unknown", "none"));
    }
  }

  // M5 site Search Console activity
  const act = site.searchConsole || { status: "unknown" };
  if (act.status !== "available") factors.push(factor("site_search_console_activity", null, "unknown", "none", "no Search Console snapshot"));
  else if (act.band === "low") {
    mul("A", m.lowActivity.A);
    mul("B", m.lowActivity.B);
    factors.push(factor("site_search_console_activity", "low", "observed", "A x1.25, B x1.25", `below ${m.lowActivityImpressions} impressions in 28 days (ASSUMPTION)`));
  } else factors.push(factor("site_search_console_activity", "normal", "observed", "none"));

  // M6 volatility proxy
  const volat = site.volatility || { status: "insufficient_history", band: "unknown" };
  if (volat.band === "high") {
    mul("B", m.highVolatilityUpper, "upper");
    mul("C", m.highVolatilityUpper, "upper");
    factors.push(factor("volatility_proxy", volat.cv, "inference", "B and C upper x1.25", "coefficient of variation of daily 28-day impression totals"));
  } else factors.push(factor("volatility_proxy", volat.band === "normal" ? volat.cv : null, volat.band === "normal" ? "inference" : "unknown", "none", volat.band === "normal" ? null : "insufficient snapshot history"));

  // M7 change magnitude
  if (change) {
    const n = (change.changedElements || []).length;
    if (n >= m.magnitudeMinElements && classes.length >= m.magnitudeMinClasses) {
      mul("B", m.magnitudeBUpper, "upper");
      factors.push(factor("change_magnitude", n, "owner_reported", "B upper x1.1", `${n} elements across ${classes.length} classes`));
    } else factors.push(factor("change_magnitude", n, "owner_reported", "none"));
  }

  // M8 new page discovery
  if (primary === "new_page") {
    if (change && !(change.changedElements || []).includes("internal_links_added")) {
      mul("A", m.newPageNoLinkA);
      factors.push(factor("new_page_internal_link", false, "owner_reported", "A x1.3", "no internal link from an eligible page was recorded"));
    } else factors.push(factor("new_page_internal_link", change ? true : null, change ? "owner_reported" : "unknown", "none"));
  }

  // market demand (never derived from impressions)
  const md = input.marketDemand || { status: "not_available" };
  factors.push(factor("market_demand", md.status === "available" ? md.monthlyVolume ?? null : null, md.status === "available" ? "observed" : "unknown", "none", md.status === "available" ? "stored Semrush evidence" : "no stored market-demand evidence"));
  if (input.intent) factors.push(factor("intent", input.intent.intentType || null, "inference", "none", input.intent.intentConfidence ? `intent confidence ${input.intent.intentConfidence}` : null));

  const stages = blocker ? { A: null, B: null, C: null } : finalizeStages(raw);

  // confidence (§4.5)
  let level = LEVEL[cfg.CONFIDENCE_CAP];
  const gap = (text) => {
    level = Math.max(1, level - 1);
    confReasons.push(text);
  };
  const bl = input.baseline || { status: "missing" };
  if (!(bl.status === "linked" || bl.status === "candidate")) gap(bl.status === "contaminated" ? "the only stored snapshot is post-change - no clean before-snapshot" : "no valid before-snapshot contains the target");
  if (primary !== "entity_facts" && vis.status === "unknown") gap("target visibility is unknown (Search Console unavailable for the target)");
  if (act.status !== "available") gap("site Search Console activity is unknown");
  if (input.retroactive) gap("retroactive prediction - computed at recording, from pre-implementation evidence only");
  if (input.intent && input.intent.intentType === "unclassified") gap("the search intent is unclassified");
  if (volat.band === "high") gap("high volatility in the site's Search Console series");
  const decConf = LEVEL[decision.confidence];
  if (decConf && decConf < level) {
    level = decConf;
    confReasons.push(`weakest link: the M6 decision confidence is ${decision.confidence}`);
  }
  if (md.status !== "available") confReasons.push("market demand is unknown (not reduced: visibility is never relabelled as demand)");
  confReasons.push("authority, page history and SERP volatility are unknown");

  const mag = magnitudesOf(primary, input);
  const targetType = primary === "entity_facts" || scope === "site" ? "site" : primary === "new_page" ? "new_page" : "page";
  const targetId = targetType === "site" ? "site" : (input.target && input.target.pageKey) || (decision.intentId ? `intent:${decision.intentId}` : null);

  // identity: hash of every input this prediction read + versions
  const hashed = {
    v: [cfg.PREDICTION_MODEL_VERSION, cfg.PREDICTION_CONFIG_VERSION],
    kind: input.kind,
    unitKey: input.unitKey,
    decision: { id: decision.decisionId, decision: decision.decision, actionDetails: uniqSorted(decision.actionDetails && decision.actionDetails.length ? decision.actionDetails : [decision.actionDetail]), scope, intentId: decision.intentId || null, confidence: decision.confidence || null },
    change: change ? { id: change.changeEventId || null, elements: uniqSorted(change.changedElements), intentChange: !!change.intentChange } : null,
    target: { pageKey: (input.target && input.target.pageKey) || null, page: page || null, pageBasis: (input.target && input.target.pageBasis) || null },
    visibility: vis,
    site: { searchConsole: act.status === "available" ? { status: act.status, band: act.band } : { status: "unknown" }, volatility: { band: volat.band }, traffic: { measurable: mag.business.measurable } },
    intent: input.intent || null,
    marketDemand: md,
    baseline: { status: bl.status, baselineId: bl.baselineId || null },
    retroactive: !!input.retroactive,
    sources: { intelligenceRunId: (input.sources && input.sources.intelligenceRunId) || null }
  };
  const inputHash = stableHash(hashed);
  const predictionId = `${input.businessId}_pred_${sha16(input.unitKey)}_${inputHash.slice(0, 16)}`;
  const known = new Set((input.knownFactors || []).map(String));
  const unknownFactors = cfg.UNKNOWN_FACTORS.filter((u) => !known.has(u.key)).map((u) => ({ ...u, value: null, effect: "none", basis: "unknown" }));
  if (md.status !== "available") unknownFactors.push({ key: "market_demand", label: "market demand", reason: "no stored market-demand evidence", value: null, effect: "none", basis: "unknown" });

  return {
    predictionId,
    inputHash,
    businessId: input.businessId,
    kind: input.kind,
    unitKey: input.unitKey,
    decisionId: decision.decisionId || null,
    opportunityIds: uniqSorted(decision.opportunityIds),
    intentId: decision.intentId || null,
    changeEventId: change ? change.changeEventId || null : null,
    targetType,
    targetId,
    changeType: primary,
    changeClasses: classes,
    materiality: materialityOf(classes),
    predictionState: blocker ? "blocked_by_eligibility" : "ranges",
    eligibility: blocker ? { state: "blocked", blocker, note: "the page is not eligible - the blocker must be fixed first; no ranges are predicted" } : { state: "ok", blocker: null },
    stages: {
      A: stageDoc(stages.A, "first observable signal", blocker ? "blocked_by_eligibility" : "unknown"),
      B: stageDoc(stages.B, "meaningful SEO signal", blocker ? "blocked_by_eligibility" : "not_applicable"),
      C: stageDoc(stages.C, "meaningful business impact", blocker ? "blocked_by_eligibility" : "unknown")
    },
    // MASTER §38.1 field names (days, never dates)
    predictedFirstSignalMinDays: stages.A ? stages.A[0] : null,
    predictedFirstSignalMaxDays: stages.A ? stages.A[1] : null,
    predictedMeaningfulImpactMinDays: stages.B ? stages.B[0] : null,
    predictedMeaningfulImpactMaxDays: stages.B ? stages.B[1] : null,
    predictedBusinessImpactMinDays: stages.C ? stages.C[0] : null,
    predictedBusinessImpactMaxDays: stages.C ? stages.C[1] : null,
    predictedVisibilityImpact: mag.visibility,
    predictedRankingImpact: mag.ranking,
    predictedTrafficImpact: mag.traffic,
    businessImpact: mag.business,
    confidence: LEVEL_NAME[level],
    confidenceReasons: confReasons,
    predictionFactors: factors,
    unknownFactors,
    baselineSnapshot: { status: bl.status, baselineId: bl.baselineId || null, targetType: bl.targetType || null, targetId: bl.targetId || null },
    retroactive: !!input.retroactive,
    derivation: input.derivation || (input.kind === "provisional" ? "provisional" : "ex_ante"),
    evidenceAsOfMs: input.evidenceAsOfMs ?? null,
    sources: input.sources || {},
    predictionModelVersion: cfg.PREDICTION_MODEL_VERSION,
    predictionConfigVersion: cfg.PREDICTION_CONFIG_VERSION,
    basis: cfg.BASIS,
    disclaimer: "תחזית לא מבטיחה תוצאה - טווחים פנימיים (הנחה), לא לוח זמנים של Google."
  };
}

// §4.7 experiment-level prediction from the committed member predictions.
function deriveExperimentPrediction(members, { businessId, experimentId }) {
  const list = [...(members || [])].sort((a, b) => String(a.predictionId).localeCompare(String(b.predictionId)));
  if (!list.length) return null;
  const ranged = list.filter((p) => p.predictionState === "ranges");
  const stage = (s) => {
    const r = ranged.map((p) => p.stages[s]).filter((x) => x && x.status === "range");
    if (!r.length) return null;
    return [Math.min(...r.map((x) => x.minDays)), Math.max(...r.map((x) => x.maxDays))];
  };
  const stages = finalizeStages({ A: stage("A"), B: stage("B"), C: stage("C") });
  const conf = Math.min(...list.map((p) => LEVEL[p.confidence] || 1));
  const classes = uniqSorted(list.flatMap((p) => p.changeClasses || []));
  const memberIds = list.map((p) => p.predictionId);
  const inputHash = stableHash({ v: [cfg.PREDICTION_MODEL_VERSION, cfg.PREDICTION_CONFIG_VERSION], experimentId, memberIds, memberHashes: list.map((p) => p.inputHash) });
  const blocked = !ranged.length;
  return {
    predictionId: `${businessId}_pred_${sha16(`exp:${experimentId}`)}_${inputHash.slice(0, 16)}`,
    inputHash,
    businessId,
    kind: "experiment",
    unitKey: `exp:${experimentId}`,
    experimentId,
    decisionId: null,
    decisionIds: uniqSorted(list.map((p) => p.decisionId)),
    opportunityIds: uniqSorted(list.flatMap((p) => p.opportunityIds || [])),
    changeEventId: null,
    targetType: list[0].targetType,
    targetId: list[0].targetId,
    changeType: primaryClassOf(classes),
    changeClasses: classes,
    materiality: materialityOf(classes),
    predictionState: blocked ? "blocked_by_eligibility" : "ranges",
    stages: {
      A: stageDoc(stages.A, "first observable signal", blocked ? "blocked_by_eligibility" : "unknown"),
      B: stageDoc(stages.B, "meaningful SEO signal", blocked ? "blocked_by_eligibility" : "not_applicable"),
      C: stageDoc(stages.C, "meaningful business impact", blocked ? "blocked_by_eligibility" : "unknown")
    },
    predictedFirstSignalMinDays: stages.A ? stages.A[0] : null,
    predictedFirstSignalMaxDays: stages.A ? stages.A[1] : null,
    predictedMeaningfulImpactMinDays: stages.B ? stages.B[0] : null,
    predictedMeaningfulImpactMaxDays: stages.B ? stages.B[1] : null,
    predictedBusinessImpactMinDays: stages.C ? stages.C[0] : null,
    predictedBusinessImpactMaxDays: stages.C ? stages.C[1] : null,
    confidence: LEVEL_NAME[conf],
    confidenceReasons: ["the weakest member prediction's confidence (§4.7)"],
    derivedFrom: memberIds,
    retroactive: list.some((p) => p.retroactive),
    derivation: "experiment",
    predictionModelVersion: cfg.PREDICTION_MODEL_VERSION,
    predictionConfigVersion: cfg.PREDICTION_CONFIG_VERSION,
    basis: cfg.BASIS,
    disclaimer: "תחזית לא מבטיחה תוצאה - טווחים פנימיים (הנחה), לא לוח זמנים של Google."
  };
}

// Stage bounds used by windows/holds (whole days or null).
function stageRange(pred, s) {
  const x = pred && pred.stages && pred.stages[s];
  return x && x.status === "range" ? [x.minDays, x.maxDays] : null;
}

module.exports = {
  predict,
  deriveExperimentPrediction,
  classesFromActionDetails,
  classesFromElements,
  primaryClassOf,
  materialityOf,
  eligibilityBlockerOf,
  volatilityOf,
  siteActivityOf,
  preChangeEvidence,
  latestBefore,
  stageRange,
  stableHash,
  sha16,
  toMs,
  DAY_MS,
  LEVEL
};
