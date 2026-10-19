// GuyHadas Visibility OS - M5 Opportunity Engine configuration
// (docs/M5_OPPORTUNITY_ENGINE_DESIGN.md §9). Plain numbers, no logic.
//
// Weights are per factor; a business may override them through
// businesses.opportunityWeights (known keys only, numbers 0..5). Thresholds
// are this engine's own modelling choices and are labelled ASSUMPTION
// wherever they influence an opportunity.
//
// Bump CONFIG_VERSION whenever a value here changes: it is part of the
// analysis cache identity and is stored on every opportunity (for M9
// calibration).

const ENGINE_VERSION = 1;
const CONFIG_VERSION = 4; // 2: market demand separated from observed visibility; 3: minimum sample for relative demand tiers (#55); 4: same for observed-visibility tiers and minImpr (#64)

// marketDemand = external market demand (Semrush or another demand
// provider) - unknown when unavailable, never derived from Search Console.
// observedVisibility = what Search Console observed for this business
// (impressions/clicks/position/CTR) - actual current visibility, not the
// market.
const DEFAULT_WEIGHTS = Object.freeze({
  businessRelevance: 3,
  commercialValue: 2,
  marketDemand: 2,
  observedVisibility: 2,
  upside: 3,
  effortInverse: 1
});

const THRESHOLDS = Object.freeze({
  // ranking_upside: impression-weighted position band considered improvable
  // (historical SEO convention -> ASSUMPTION, not a Google rule).
  upsidePositionMin: 4,
  upsidePositionMax: 20,
  upsideStrongMax: 10,
  // ctr_upside: only among results already on page 1, and only when the
  // topic CTR is below this share of the site's own observed CTR.
  ctrPositionMax: 10,
  ctrShareOfSite: 0.5,
  // Minimum impressions for visibility-based rules: the higher of this
  // absolute floor and the business's own lower-tercile of topic impressions
  // (the tercile is used only when the visibility sample is adequate, below).
  minImpressionsAbsolute: 20,
  // Same principle as minDemandTierSample, for Search Console impressions:
  // relative visibility tiers (and the lower-tercile part of the impressions
  // threshold) need at least this many approved topics with positive
  // impressions. Below it a positive value is kept but UNTIERED (basis
  // "insufficient_sample") and the threshold is the absolute floor. An
  // observed zero is still level 0. Sample-size ASSUMPTION (#64).
  minVisibilityTierSample: 4,
  // Market demand is tiered RELATIVE to the business's other approved topics
  // (terciles of positive volumes). Below this many topics with positive
  // demand the tiers are not meaningful (with 1-2 values both cut points are
  // the smallest value, so every topic would be "high"); 4 is the smallest
  // sample whose cut points can separate all three tiers. Below it the value
  // is kept but left UNTIERED (basis "insufficient_sample"). A sample-size
  // rule (ASSUMPTION), not an absolute search-volume threshold (#55).
  minDemandTierSample: 4,
  // Priority bands on the 0..100 normalized score.
  highBand: 75,
  mediumBand: 50
});

// Effort per type (ASSUMPTION): 3 = small change, 1 = large.
const EFFORT_BY_TYPE = Object.freeze({
  technical_blocker: 3,
  ctr_upside: 3,
  internal_linking: 3,
  ranking_upside: 2,
  page_not_visible: 2,
  entity_clarity: 2,
  coverage_gap: 1,
  page_overlap_observed: 1
});

const CANDIDATE_ACTIONS = Object.freeze({
  technical_blocker: ["IMPROVE_PAGE", "DEINDEX_NOINDEX_REVIEW"],
  ranking_upside: ["IMPROVE_PAGE", "UPDATE_CONTENT", "ADD_INTERNAL_LINKS"],
  ctr_upside: ["IMPROVE_PAGE"],
  coverage_gap: ["CREATE_PAGE", "IMPROVE_PAGE"],
  page_not_visible: ["IMPROVE_PAGE", "REWORK_INTENT", "WAIT_FOR_DATA"],
  internal_linking: ["ADD_INTERNAL_LINKS"],
  page_overlap_observed: ["MONITOR", "CONSOLIDATE_PAGES"],
  entity_clarity: ["ADD_ENTITY_COVERAGE", "ADD_STRUCTURED_DATA"]
});

// GEO readiness signals that become entity_clarity opportunities when
// missing/partial. structured_data_coverage alone is housekeeping (Google:
// no special markup needed for AI features), audience_positioning is too
// soft to act on without M6 entity work.
const ENTITY_SIGNALS = Object.freeze(["business_identity", "services_explicit", "locations_explicit", "contact_details", "fact_consistency"]);

function resolveWeights(override) {
  const w = { ...DEFAULT_WEIGHTS };
  const applied = {};
  if (override && typeof override === "object") {
    for (const [k, v] of Object.entries(override)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_WEIGHTS, k) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 5) {
        w[k] = v;
        applied[k] = v;
      }
    }
  }
  return { weights: w, applied };
}

module.exports = { ENGINE_VERSION, CONFIG_VERSION, DEFAULT_WEIGHTS, THRESHOLDS, EFFORT_BY_TYPE, CANDIDATE_ACTIONS, ENTITY_SIGNALS, resolveWeights };
