// GuyHadas Visibility OS - per-provider/operation cost & quota limits
// (Universal External API Cost-Control Rule - see the permanent rule in
// the project docs: claude/visibility-os-api-cost-control-rule.md).
//
// Plain, easily-tunable numbers - no logic lives here. functions/apiUsage.js
// reads this config to decide blocked_by_budget / blocked_by_quota /
// cache-validity before any provider is actually called. Raise these
// numbers as real usage proves they're safe to raise, not before - they
// are deliberately conservative starting points for a system with a
// handful of real businesses on it today, not a load-tested ceiling.

module.exports = {
  anthropic: {
    analyzeBusinessServices: {
      // claude-sonnet-5-5, verified against
      // platform.claude.com/docs/en/about-claude/pricing at implementation
      // time (see the cost-control rule doc for the citation) - not
      // guessed. Used both for the pre-call estimate (from a chars/4
      // heuristic on the prompt) and, more importantly, for the real
      // post-call cost computed from Anthropic's own reported
      // input_tokens/output_tokens - that second number is what actually
      // gets recorded and budget-checked against.
      // The only model this operation used before the model was recorded on
      // each ledger row (2026-10-07). Ledger rows with no `model` field are
      // treated as produced by it, so they stay reusable for this model and
      // are never reused for a different one. Do not change this value when
      // switching models - change ANTHROPIC_MODEL in businessUnderstanding.js.
      legacyModel: "claude-sonnet-5-5",
      // Same for the analysis version (see ANALYSIS_VERSION in
      // businessUnderstanding.js): rows from before it was recorded are v1.
      legacyAnalysisVersion: 1,
      inputPricePerMTokUsd: 2,
      outputPricePerMTokUsd: 10,
      maxEstimatedCostPerCallUsd: 0.5,
      maxRequestsPerBusinessPerDay: 5,
      maxRequestsPerBusinessPerMonth: 30,
      maxRequestsGlobalPerDay: 50,
      maxRequestsGlobalPerMonth: 500,
      // null = the cached result stays valid until the input hash itself
      // changes (the website evidence or confirmed-service list changed),
      // not on a timer - there's no reason to re-ask Claude about an
      // unchanged website just because a day passed.
      cacheTtlMs: null,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 15 * 60 * 1000
    }
  },
  semrush: {
    // M3.2: Semrush discovery is split into two governed operations so a
    // per-seed run never re-buys domain-level data. Semrush has no public
    // $/unit price (it depends on the subscription), so usage is recorded in
    // API units: per-line rates from developer.semrush.com (current data).
    // Each ledger row records providerUnitsUsed = lines returned x rate.
    // (The former single operation "discoverFromSemrush" - ~2,100 units per
    // call - is retired; its ledger rows remain as history.)
    discoverRelatedForSeed: {
      // phrase_related, 30 lines max x 40 units = 1,200 units per call max
      unitsPerLine: 40,
      maxUnitsPerCall: 30 * 40,
      maxRequestsPerBusinessPerDay: 20,
      maxRequestsPerBusinessPerMonth: 120,
      maxRequestsGlobalPerDay: 100,
      maxRequestsGlobalPerMonth: 1000,
      // Search demand drifts, so cached results expire after 24 h even for
      // an unchanged seed (unlike the Anthropic analysis cache).
      cacheTtlMs: 24 * 60 * 60 * 1000,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 15 * 60 * 1000
    },
    discoverDomainOrganic: {
      // domain_organic 50 lines x 10 + domain_organic_organic 10 lines x 40
      // = 900 units per call max
      unitsPerKeywordLine: 10,
      unitsPerCompetitorLine: 40,
      maxUnitsPerCall: 50 * 10 + 10 * 40,
      maxRequestsPerBusinessPerDay: 3,
      maxRequestsPerBusinessPerMonth: 30,
      maxRequestsGlobalPerDay: 30,
      maxRequestsGlobalPerMonth: 300,
      cacheTtlMs: 24 * 60 * 60 * 1000,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 15 * 60 * 1000
    },
    // Semrush V4 Keyword Metrics pilot (semrushV4.js / keywordMetricsStore.js):
    // enrichment of ONE approved query, 20 API units per request
    // (developer.semrush.com "Get keyword metrics", verified 2026-10-13).
    // maxEstimatedUnitsPerCall is a HARD cap enforced by the governor before
    // the call (runGoverned refuses when the unit estimate is missing or
    // above it). Pilot limits are deliberately tiny; raise them only after
    // the pilot has been evaluated. A failed provider call counts toward
    // the quota (it may have been billed).
    enrichKeywordMetrics: {
      unitsPerRequest: 20,
      maxEstimatedUnitsPerCall: 20,
      maxRequestsPerBusinessPerDay: 1,
      maxRequestsPerBusinessPerMonth: 5,
      maxRequestsGlobalPerDay: 2,
      maxRequestsGlobalPerMonth: 10,
      // The cache identity includes the month, so a cached answer is reused
      // for the rest of that month and a new month is a new identity.
      cacheTtlMs: 31 * 24 * 60 * 60 * 1000,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 60 * 60 * 1000
    }
  },
  google: {
    // M4: Search Console query x page performance (which pages appear for
    // which queries). The first Google call routed through the governor
    // (MASTER §34). No $ cost - Google quota - so limits are on request
    // counts; actualCostUsd is recorded as 0.
    searchConsoleQueryPage: {
      maxRequestsPerBusinessPerDay: 10,
      maxRequestsPerBusinessPerMonth: 120,
      maxRequestsGlobalPerDay: 100,
      maxRequestsGlobalPerMonth: 2000,
      // The analysis period ends 3 days ago and moves daily, so the input
      // (and cache identity) changes once a day; within a day, re-runs reuse.
      cacheTtlMs: 12 * 60 * 60 * 1000,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 15 * 60 * 1000
    }
  }
};
