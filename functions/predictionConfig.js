// GuyHadas Visibility OS - M7 prediction & tracking configuration
// (docs/M7_DESIGN.md §4, §5, §8, §9). Plain values, no logic.
//
// EVERY number below - every prior, multiplier, threshold, cap and window -
// is an INTERNAL HEURISTIC of this system: an ASSUMPTION, versioned so M9
// can calibrate it against measured outcomes. None of them is a timeline
// published by Google and none is a promise. Google says only that crawling
// "can take anywhere from a few days to a few weeks" and that some changes
// take effect "in a few hours, others could take several months" (Google
// Search Central, re-verified 2026-10-11 - docs/M7_DESIGN.md §0).
//
// Bump PREDICTION_CONFIG_VERSION whenever a value here changes: it is part
// of every prediction's input hash and is stored on every M7 record.

const PREDICTION_MODEL_VERSION = 1;
const PREDICTION_CONFIG_VERSION = 1;
const TRACKING_ENGINE_VERSION = 1;

const BASIS = "assumption";
const NOTE = "internal heuristic (ASSUMPTION) - not a Google timeline and not a promise; calibrated in M9";

// §4.4 priors: days after publication, per change class and stage.
//   A = first observable signal, B = meaningful SEO signal,
//   C = meaningful business impact. null = stage not applicable/unknown.
const PRIORS = Object.freeze({
  technical_eligibility: Object.freeze({ A: [3, 21], B: [14, 56], C: [28, 120] }),
  snippet: Object.freeze({ A: [3, 21], B: [14, 42], C: [28, 90] }),
  internal_linking: Object.freeze({ A: [7, 28], B: [21, 70], C: [42, 120] }),
  content: Object.freeze({ A: [7, 35], B: [28, 90], C: [56, 150] }),
  intent_correction: Object.freeze({ A: [7, 35], B: [28, 112], C: [56, 180] }),
  consolidation: Object.freeze({ A: [7, 28], B: [28, 112], C: [56, 180] }),
  new_page: Object.freeze({ A: [3, 42], B: [42, 120], C: [90, 180] }),
  // Site-wide business facts: no query-level SEO metric is targeted
  // (stage B not applicable) and the business effect is unknown.
  entity_facts: Object.freeze({ A: [14, 56], B: null, C: null })
});

// §4.1 change class of an M6 actionDetail (provisional predictions).
const ACTION_DETAIL_CLASS = Object.freeze({
  fix_eligibility: "technical_eligibility",
  improve_snippet: "snippet",
  add_internal_links: "internal_linking",
  strengthen_content: "content",
  rework_intent: "intent_correction",
  consolidate_into_owner: "consolidation",
  new_page: "new_page",
  clarify_business_facts: "entity_facts"
});

// §6.2 closed enum of recorded changed elements.
const CHANGE_ELEMENTS = Object.freeze([
  "title",
  "meta_description",
  "h1",
  "headings",
  "body_content",
  "internal_links_added",
  "redirect",
  "canonical_tag",
  "noindex_removed",
  "robots_rule",
  "structured_data",
  "business_facts",
  "new_page_published",
  "content_merged",
  "other"
]);

const ACTIONABLE_DECISIONS = Object.freeze(["IMPROVE", "CREATE", "CONSOLIDATE"]);

// §5.3 / §9.1 materiality of a change class (churn hold length + overlap).
const MATERIALITY = Object.freeze({
  content: "major",
  intent_correction: "major",
  consolidation: "major",
  new_page: "major",
  technical_eligibility: "major",
  snippet: "moderate",
  internal_linking: "moderate",
  entity_facts: "site"
});

// §4.4 modifiers M1-M8 (deterministic multipliers on stage bounds).
const MODIFIERS = Object.freeze({
  // M1 target visibility
  visibleImpressionFloor: 20, // same absolute floor as M5 (opportunityConfig.minImpressionsAbsolute)
  visiblePositionMax: 20,
  visibleB: 0.85,
  visibleClasses: Object.freeze(["snippet", "content", "internal_linking", "intent_correction"]),
  zeroVisibility: Object.freeze({ A: 1.2, B: 1.3, C: 1.3 }),
  // M2 position band (same classes as M1)
  position11to20B: 1.1,
  positionOver20B: 1.25,
  // M3 discoverability
  orphanA: 1.3,
  orphanClasses: Object.freeze(["content", "new_page", "intent_correction"]),
  notInSitemapA: 1.15,
  // M5 site Search Console activity (28-day impressions)
  lowActivityImpressions: 300,
  lowActivity: Object.freeze({ A: 1.25, B: 1.25 }),
  // M6 volatility proxy: coefficient of variation of daily-snapshot
  // 28-day impression totals
  minSnapshotsForVolatility: 14,
  volatilitySnapshots: 28,
  highVolatilityCv: 0.35,
  highVolatilityUpper: 1.25,
  // M7 change magnitude
  magnitudeMinElements: 3,
  magnitudeMinClasses: 2,
  magnitudeBUpper: 1.1,
  // M8 new page discovery
  newPageNoLinkA: 1.3
});

// §4.4 rounding / bounds.
const RANGE_CAP_DAYS = 365;

// §5.3 / §5.4 observation window.
const WINDOW = Object.freeze({
  tailFactor: 1.25,
  minDays: 28,
  maxDays: 210,
  maxExperimentSpanDays: 240,
  approachingEndShare: 0.8
});

// §8.2 experiment grouping.
const GROUPING_WINDOW_DAYS = 14;

// Implementation dates are calendar dates in the business time zone (A4).
const DEFAULT_TIME_ZONE = "Asia/Jerusalem";

// §4.3 factors with no stored source in v1 - always listed, never 0.
const UNKNOWN_FACTORS = Object.freeze([
  { key: "authority_backlinks", label: "authority proxy and referring domains / backlinks", reason: "no backlink provider is connected" },
  { key: "page_age", label: "page age", reason: "no publication date is stored for pages" },
  { key: "page_history", label: "page-level historical trajectory", reason: "topicIntelligence / seoPages keep the latest run only (backlog #40)" },
  { key: "google_index_state", label: "Google's own index state and crawl activity", reason: "crawl-derived only; no URL Inspection or crawl stats" },
  { key: "serp_volatility", label: "SERP volatility and competition", reason: "no SERP data provider" },
  { key: "competitor_movement", label: "competitor movement", reason: "not tracked" },
  { key: "seasonality", label: "seasonality", reason: "no multi-year history" },
  { key: "algorithm_updates", label: "algorithm / update context", reason: "not tracked" },
  { key: "historical_responsiveness", label: "historical responsiveness to SEO changes", reason: "no completed experiments until M8" },
  { key: "topical_authority", label: "page and topical authority proxies", reason: "not stored" }
]);

const CONFIDENCE_CAP = "medium"; // AD-6: high is unreachable in v1

module.exports = {
  PREDICTION_MODEL_VERSION,
  PREDICTION_CONFIG_VERSION,
  TRACKING_ENGINE_VERSION,
  BASIS,
  NOTE,
  PRIORS,
  ACTION_DETAIL_CLASS,
  CHANGE_ELEMENTS,
  ACTIONABLE_DECISIONS,
  MATERIALITY,
  MODIFIERS,
  RANGE_CAP_DAYS,
  WINDOW,
  GROUPING_WINDOW_DAYS,
  DEFAULT_TIME_ZONE,
  UNKNOWN_FACTORS,
  CONFIDENCE_CAP
};
