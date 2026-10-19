# M5 — Opportunity Engine — Design & Implementation Notes

**`docs/MASTER.md` is canonical** (§20 Opportunity Engine, §21 Decision Engine boundary, §22 Evidence & Confidence, §32 Caching, §38.5 Baseline, §43 rules, §46 freshness). This document records the M5 design that was written before code, the decisions taken, and the implementation status. Where it and MASTER differ, MASTER wins.

Repository state at design time: `main` @ `bf8f3a7` (M4 merged and live-validated; UX refactor #23–#27 merged; MASTER refreshed 2026-10-09).

---

## 0. Freshness gate (MASTER §46) — re-verified 2026-10-09

| Claim used by M5 | Status | Effect on design |
|---|---|---|
| Google: no additional technical requirements, special optimizations or special schema.org markup are needed to appear in AI Overviews / AI Mode (developers.google.com/search/docs/appearance/ai-features, last updated 2025-12-10) | CURRENT | GEO opportunities are framed as *making business facts explicit and consistent on the site*, labelled ASSUMPTION, never as an "AI ranking factor" or "AI schema" |
| FAQ rich results retired in 2026 | CURRENT (multiple sources) | M5 never proposes FAQ markup |
| Search Analytics rowLimit up to 25,000 rows | CURRENT (MASTER §46.4) | M4 still requests 1,000 rows — noted as a data gap/follow-up, not changed in M5 |
| "Striking distance" (positions ~4–20 respond best to improvement), industry CTR-by-position curves | HISTORICAL PRACTICE / HYPOTHESIS | Used only as a labelled ASSUMPTION for an ordinal upside level; no external CTR curve is used — CTR is compared only to the business's own observed site CTR |

---

## 1. Scope

M5 answers: *given what the system knows now (approved Search Universe, M4 topic intelligence, page inventory, GEO readiness, baseline), which evidence-backed opportunities may deserve action?*

- Deterministic detection of opportunity **candidates** from existing M3/M4 data.
- Transparent, configurable scoring → priority band + confidence + effort (labelled).
- Evidence embedded in every opportunity with references to the source documents.
- Explicit **NO_ACTION / WAIT_FOR_DATA** evaluations per approved topic.
- Deduplication and a lifecycle that preserves owner decisions across runs.
- Tie to the current intelligence run and baseline.
- Minimal inspection UI (פעולות → הזדמנויות).

## 2. Non-scope (M6–M9)

- SearchIntent object, canonical ownership, cannibalization engine (M6).
- Final CREATE / IMPROVE / CONSOLIDATE / WAIT / MONITOR / REJECT decisions (M6). M5 lists *candidate* actions only.
- ImpactPrediction, SEOChangeEvent, SEOExperiment, churn prevention (M7), measurement (M8), learning (M9).
- Any new external provider call. No task creation. No change to M3/M4 data.

## 3. Gap analysis — can M5 be built without new providers?

**Yes.** Everything M5 needs for a first, honest version exists:

| Need | Source (existing) | Basis |
|---|---|---|
| Business relevance | `searchTopics.status` (owner), `topicIntelligence.business.linkedServices` | observed (owner decision) |
| Observed search visibility (impressions, clicks, position, CTR, pages per topic) | `topicIntelligence.gscCurrent` (governed GSC query × page) | observed |
| Market demand | `topicIntelligence.semrush` when already stored (Semrush) — otherwise **unknown** | observed / unknown |
| Site CTR reference | `intelligenceRuns.businessContext.searchConsole` | observed |
| Page coverage | `topicIntelligence.pages.observed` / `.contentMatched` | observed / inferred |
| Technical state | `seoPages` (indexability, canonical, robots, links, diagnostics) | observed (crawl-derived) |
| Entity / fact clarity | `intelligenceRuns.geoReadiness.signals` | observed |
| Commercial value | `topicIntelligence.business.preliminaryIntent`, commercial modifier | inference |
| Baseline | `baselines` (immutable) | observed |

**Missing (represented as unknown, never fabricated):**

- **Market demand** (search volume / difficulty) — Semrush live discovery deferred (§34.1). Market demand is therefore **unknown** for most topics; it is never derived from Search Console (see §9a).
- Demand trend — only one 28-day query × page window exists; no history yet.
- SERP features / competitors — no SERP provider.
- Page-level traffic and conversions — no governed GA4 landing-page report.
- Entity graph — not built (M6+).
- GSC rows beyond 1,000 per period — M4 row limit (could be raised to 25,000; follow-up).

None of these block M5; each lowers confidence where relevant and is listed in the opportunity's `missing[]`.

## 4. Opportunity model

M5 **extends the existing `opportunities` collection** (manual opportunities, owner-managed). No parallel collection. Engine opportunities are marked `source: "opportunity_engine"`; manual ones keep working unchanged.

```text
opportunities/{businessId}_{dedupeKey}
  businessId
  source: "opportunity_engine"
  dedupeKey                  // see §7
  type                       // see §5
  title, description         // plain Hebrew, generated from the evidence
  candidateActions[]         // MASTER §20 vocabulary — candidates, not decisions
  targetTopicIds[], targetQueryFamilyIds[] (= topic ids in M3.2), targetPageKeys[], targetEntityIds[] (empty until M6)
  signals: { businessRelevance, commercialValue, marketDemand {level, basis, source}, visibility {impressions, clicks, ctr, position, level, basis, source: "search_console"}, technical, content, entity, geo }
  factors[]                  // scoring breakdown: key, level, weight, contribution, basis, explanation
  score, priority (high|medium|low), confidence (high|medium|low) + confidenceReasons[]
  estimatedEffort { level, basis: "assumption" }
  estimatedValue  { level, basis, note }   // ordinal, never a promised number
  evidence[]                 // §6
  missing[]                  // what is unknown
  status                     // OWNER field (existing enum) — engine sets "new" only on first creation
  engineState: active | resolved
  firstDetectedAt(Ms), lastDetectedAt(Ms), lastEvaluatedAt(Ms), detectionCount
  sourceRunId, firstSourceRunId, opportunityRunId
  baselineId, baselineMatchesRun
  impactInputs { targetType, targetId, baselineId, current metrics, period }   // inputs for future ImpactPrediction (M7) — no prediction
  decisionId: null           // M6 placeholder
  analysisVersion, modelVersion (engine version), configVersion
  priority (existing field reused: high|medium|low), topic (title, existing field), relatedPage (first page URL, existing field)
```

## 5. Taxonomy (minimal viable)

M5 detects **opportunity kinds**; each maps to MASTER §20 candidate actions. M6 decides.

| Type | Detected when (all deterministic) | Candidate actions |
|---|---|---|
| `technical_blocker` | A page that serves an approved topic (observed in GSC for it, or content-matched) and was fetched in the latest crawl is, per the crawl, non-indexable, robots-blocked, or has a conflicting / elsewhere-pointing canonical | IMPROVE_PAGE, DEINDEX_NOINDEX_REVIEW (confirm the blocker is unintended) |
| `ranking_upside` | Approved topic with an observed page whose impression-weighted position is 4–20 and impressions above the business's own floor | IMPROVE_PAGE, UPDATE_CONTENT, ADD_INTERNAL_LINKS |
| `ctr_upside` | Approved topic with average position ≤ 10, meaningful impressions, and CTR well below the **site's own** CTR | IMPROVE_PAGE (title/description) |
| `coverage_gap` | Approved, business-relevant topic with **no** observed page and **no** content-matched page | CREATE_PAGE, IMPROVE_PAGE (extend an existing page) — M6 chooses |
| `page_not_visible` | Approved topic with a content-matched page (inferred) but no GSC visibility for its queries | IMPROVE_PAGE, REWORK_INTENT, WAIT_FOR_DATA |
| `internal_linking` | A page that serves an approved topic has **no** inbound internal link from the crawled pages | ADD_INTERNAL_LINKS |
| `page_overlap_observed` | More than one page observed in GSC for the same approved topic | MONITOR, CONSOLIDATE_PAGES (review in M6) — explicitly *not* a cannibalization verdict |
| `entity_clarity` | Site-level GEO readiness signal (identity, services, locations, contact, fact consistency) is missing/partial | ADD_ENTITY_COVERAGE, ADD_STRUCTURED_DATA (Organization/LocalBusiness only; never FAQ) |

Topic outcomes that are **not** opportunities (stored on the run, not in the list):

- `NO_ACTION` — topic evaluated, nothing met any rule (e.g. already top-3 with healthy CTR and a healthy page).
- `WAIT_FOR_DATA` — not enough evidence to judge (e.g. GSC unavailable and no page/demand evidence).

Deliberately **not** in M5: freshness/content-decay (needs history), localization (needs locale demand), REDIRECT, ADD_SOURCE/EVIDENCE (needs content analysis), competitor gaps (no SERP data).

## 6. Evidence model (MASTER §22)

Embedded in each opportunity (no separate collection yet — ADR 3):

```text
evidence[] = {
  id            // stable: "<collection>/<docId>#<field>"
  sourceType    // search_console | crawl | owner_decision | service_map | geo_readiness | baseline | semrush
  sourceRef     { collection, docId, field }
  observation   // human-readable fact, e.g. "position 8.4, 120 impressions (2026-09-08 – 2026-10-05)"
  basis         // observed | inference | assumption | hypothesis
  capturedAtMs
}
```

Trace: `Opportunity → factors/signals → evidence → sourceRef → originating document`. A future `evidence` collection (M6) can be materialized from these ids without changing opportunities.

## 7. Deduplication

`dedupeKey = sha256(businessId | type | target)` (first 20 hex), where the target is the topic for topic-level types (ranking, CTR, coverage, not-visible, overlap — the page may change and it is still the same opportunity), the page for page-level types (blocker, internal links — several topics can share one page problem) and the signal for site-level types. The document id is `{businessId}_{dedupeKey}`, so the same situation found again **updates** the same document (detection count, evidence, scores) instead of creating a duplicate. Two different types on the same page/topic are different opportunities (e.g. a technical blocker and an internal-linking gap). The same page serving two topics with the same issue (e.g. a blocker) is deduped on the page, listing both topics.

## 8. Lifecycle

Two independent fields:

- `status` — **owner's** decision (existing enum: new, researching, approved, in_progress, completed, rejected, monitoring). The engine writes `"new"` only when it first creates a document and **never changes it afterwards**. `rejected` is a durable negative signal: re-detection keeps it rejected (MASTER §43.18).
- `engineState` — the **system's** view: `active` (detected in the latest run) or `resolved` (not detected in the latest run; kept, never deleted).

## 9. Scoring model (explainable, no fake precision)

Ordinal levels 0–3 per factor; `null` = unknown (excluded from the score, lowers confidence).

| Factor | Level rule | Basis |
|---|---|---|
| `businessRelevance` | owner status priority / brand_strategic = 3; relevant = 2; +1 (max 3) if linked to a confirmed service; site-level = 2 | observed (owner) |
| `commercialValue` | preliminary intent commercial / local or commercial modifier = 3; navigational = 2; informational = 1; unclassified = null | inference |
| `marketDemand` | Demand-provider (Semrush today) monthly volume tier relative to this business's approved topics. It is tiered **only when evidence exists** and **at least 4 approved topics have positive demand** (`THRESHOLDS.minDemandTierSample`, see §9b). With fewer, the value is kept but left untiered: `null`, basis `insufficient_sample`. With no evidence it is `null` (unknown). Both are excluded from the score and lower confidence. Never derived from Search Console | observed / insufficient_sample / unknown |
| `observedVisibility` | Search Console impressions tier relative to this business's approved topics. It is tiered only when **at least 4 approved topics have positive impressions** (`THRESHOLDS.minVisibilityTierSample`, see §9c); with fewer, a positive value is kept but untiered (`null`, basis `insufficient_sample`). No impressions observed = 0, always. Scored only where existing visibility is the value at stake (ranking / CTR / overlap, and page findings on pages observed for a topic). For coverage gaps and pages without visibility it is **not applicable**: the missing visibility is the reason for the opportunity, not evidence of low value | observed |
| `upside` | type-specific: blocker on a visible page = 3; position 4–10 = 3, 11–20 = 2; CTR < 50 % of site CTR = 3; coverage gap = 2; … | observed + assumption (position tiers) |
| `effortInverse` | technical / CTR / internal links = 3 (small), ranking/content/entity = 2, new page / overlap review = 1 | assumption |

`score = Σ weight × level` over known factors, normalized to 0–100 for sorting only. **Priority** = band from the score (high ≥ 75, medium ≥ 50, else low), with guards: technical blockers on an approved-topic page are at least medium; site-level clarity items and any low-confidence finding are at most medium; overlap observations are capped at low (monitor). (Thresholds were raised from a first draft of 65/40 after a fixture run put almost everything in "high".) The UI shows the band and the factor list, not the number. Weights live in `functions/opportunityConfig.js` (versioned) and can be overridden per business via `businesses.opportunityWeights` (known keys only).

**Confidence** (separate from priority): starts high; −1 per: GSC current data not available for the target, a key factor unknown, the main page evidence is inferred, the target page was not crawled in the latest run, no baseline. high / medium / low with the reasons listed.

## 9a. Market demand vs observed search visibility

Two different things, kept apart everywhere (factors, signals, evidence, wording):

| | Market demand | Observed search visibility |
|---|---|---|
| Meaning | How much the market searches for the topic | What Search Console observed **for this business** in the analysis period |
| Source | Semrush (or a future demand provider) | Search Console (governed query × page) |
| When unavailable | `null` / unknown — never 0 | `not_available` |
| Used for | Value of demand-dependent opportunities | Ranking / CTR / overlap rules, and value where visibility already exists |

Rules:

- Search Console impressions are **never** interpreted as market demand (MASTER: *GSC is actual current visibility, not the complete market universe*). A topic can have zero impressions for this site and large demand in the market.
- Zero impressions is an observation about **this site's visibility in the period**, not "zero demand". For `coverage_gap` and `page_not_visible`, absent visibility is the reason the opportunity exists, so it is not scored as low value.
- Unknown market demand lowers confidence (with the reason "ביקוש בשוק לא ידוע") and caps demand-dependent kinds (`coverage_gap`, `page_not_visible`) at medium; it never implies low demand.
- *Search volume is evidence, not strategy*: when Semrush evidence exists it raises the market-demand factor, but never creates an opportunity by itself.
- Wording follows the evidence: "no visibility in Search Console for the topic's queries during {period}" — never "the page does not appear in Google" or "is not indexed" without direct evidence.

This split was made in review of PR #31 (config version 2). Priorities on the reference fixture were unchanged by it; scores moved, and confidence dropped to medium wherever market demand is unknown.

## 9b. Minimum sample for relative demand tiers (#55, config version 3)

**Problem.** Market demand is tiered by terciles of the positive volumes of the approved topics, with cut points at indexes ⌊(n−1)/3⌋ and ⌊2(n−1)/3⌋.
- With 1 or 2 enriched topics, both cut points are the smallest value, so **every** enriched topic was tier 3 ("high demand"), whatever its absolute volume.
- With 3, the smallest was tier 2 and the rest tier 3.
- 4 is the smallest sample whose cut points can separate all three tiers.

**Rule.** The demand factor is tiered only when at least `minDemandTierSample` (4) approved topics have a positive demand value. This is a sample-size rule (ASSUMPTION), not an absolute search-volume threshold, and it doesn't refer to any specific provider.

Below the minimum:
- a positive value gets `level: null` and `basis: "insufficient_sample"`, with the volume and the sample size in the explanation (e.g. "1300 חיפושים בחודש … לא דורג: יש נתוני ביקוש רק ל-1 נושאים מאושרים, ונדרשים לפחות 4");
- the signal keeps `source` and adds `tierStatus: "insufficient_sample"`;
- `missing` gets `factor_untiered_insufficient_sample:marketDemand`, which is distinct from `factor_unknown:marketDemand`;
- confidence drops one step, exactly as for unknown demand, with its own reason ("יש נתון אך אין מספיק נושאים להשוואה");
- the factor is withheld from the score, and demand-dependent kinds are capped at medium (same mechanics as unknown);
- it is **never** shown as low or high demand;
- a reported 0 stays level 0, as before.

**Unchanged.**
- At or above the minimum, tiers are identical to the previous rule (test DT4 compares against the old tercile function).
- The topic-intelligence demand value and its provenance are untouched; only the derived tier changes.
- M6 uses its own absolute demand sum and is unaffected.

The Search Console visibility tier (`imprT`) had the same sparse-sample behaviour; it is fixed by the same principle in §9c (#64).

## 9c. Minimum sample for relative visibility tiers and the impressions threshold (#64, config version 4)

**Problem.** `imprT` is the terciles of the approved topics' positive Search Console impressions. It caused two errors:
- **Tiers.** With 1–2 positive topics every one was visibility tier 3; with 3, the smallest was tier 2 and the rest tier 3. The topic was being compared with itself or a tiny sample.
- **Threshold.** `minImpr = max(minImpressionsAbsolute, imprT.low)` turned into the smallest positive value, so a single topic with 400 impressions set its own threshold to 400.

**Rule.** Relative visibility tiers are derived only when at least `minVisibilityTierSample` (4) approved topics have **positive** impressions. This is a sample-size ASSUMPTION; it contains no provider-specific logic.

Below the minimum:
- **The tier.** A positive value gets `level: null` and `basis: "insufficient_sample"`, with `source: "search_console"`. The explanation states the impressions, the period and the sample size.
- **The signal.** `signals.visibility` keeps the impressions, clicks and period, keeps `source: "search_console"`, and adds `tierStatus: "insufficient_sample"`.
- **Scoring and confidence.** The same generic handling as §9b applies:
  - the factor is excluded from the score;
  - `missing` gets `factor_untiered_insufficient_sample:observedVisibility`, which is distinct from `factor_unknown`;
  - confidence drops one step, shared with any other unknown or untiered factor, with the reason "יש נתון אך אין מספיק נושאים להשוואה".
- **`no_observation`, or a value of 0 impressions,** stays an observed **level 0**. It never becomes unknown or untiered.
- **`minImpr`** is the absolute floor (`minImpressionsAbsolute`, 20). The lower tercile is not used.

**Which topics pass the threshold doesn't change.** In a sparse sample the old threshold was `max(20, smallest positive)`, and every positive topic is at or above the smallest positive value. So under both rules a topic passed exactly when it had 20 or more impressions. Only the threshold *reported* in reasons and in `context.minImpressions` changes.

**What does change for sparse samples.** Ranking, CTR and overlap opportunities are still detected. Their visibility factor is withheld from the score, which is renormalised over the known factors, and their confidence drops one step, so their priority can move.

**Unchanged.**
- With 4 or more positive topics, tiers and `minImpr` are identical to before (tests VT4 and VT5 compare against the old rule).
- Weights and priority bands.
- The market-demand rule (§9b).
- M6, which uses its own absolute observed-visibility figures.

**Edge case.** Page-level opportunities take the best visibility level among the topics a page was observed for. If those include an observed 0 next to an untiered positive value, the page shows 0.

## 10. Relationship to the M4 baseline

Each run records the latest baseline id and whether it was captured from the same intelligence run (`baselineMatchesRun`). Each opportunity stores `baselineId` and `impactInputs` (target, current metrics, period) so a future ImpactPrediction can reference `baseline_snapshot_id` without recomputation. Baselines are only read, never written.

## 11. Relationship to M6

M5 output = candidates with evidence. M6 consumes them: builds the SearchIntent object, resolves ownership and cannibalization, and turns `candidateActions[]` into one decision (`decisionId` placeholder). `page_overlap_observed` and `coverage_gap` are the main M6 inputs; M5 never states ownership.

## 12. API / caching / governance

- **No provider calls.** M5 reads Firestore only (inputs written by M3.2/M4). It cannot spend money or quota.
- Deterministic analysis cache (MASTER §32): `inputHash = hash(engineVersion, configVersion, weights, sourceRunId, baselineId, approved topics + owner statuses, topicIntelligence ids+computedAt, seoPages pageKeys+lastCrawledAt+crawlStatus)`. Owner statuses on opportunities are not part of it: they never change detection. If the latest `opportunityRuns` row has the same hash, the run returns `cache_hit` and writes nothing else. Timestamps of the request itself are not part of the hash.
- Triggered only by an explicit owner action (`visibilityRunOpportunityEngine`); never on render.
- Rules: engine-written fields are protected — clients may update only `status` / `updatedAt` / owner notes on engine opportunities and may not create them; `opportunityRuns` is read-only for clients.

## 13. UI (minimal inspection)

פעולות → הזדמנויות: a "הזדמנויות שהמערכת זיהתה" section with the run button, counts, a compact list (priority, type, title, target, confidence, owner status select) and an expandable row: why it appeared (factors), evidence, candidate actions, baseline, what's missing. Topics with no action are summarized from the run. Manual opportunities stay below, unchanged. No polish — final UX after M9.

## 14. Test strategy

Deterministic, index-enforcing fake Firestore (`functions/test/opportunityEngine.test.js`): creation per type, dedupe across runs, evidence linkage, scoring and band ordering, confidence reductions, NO_ACTION / WAIT_FOR_DATA, identical run = cache hit with no writes, changed input = recompute, owner status preserved and rejection durable, resolved marking, no intelligence run / no approved topics / GSC unavailable / page not crawled / zero impressions edge cases, weight override (unknown keys ignored), no provider modules imported and no `apiUsage` rows, boundary (no tasks / decisions / impactPredictions / baselines / searchTopics writes). App: existing no-call-on-render test extended automatically.

## 15. Schema decisions that need care for M6–M9

- Opportunity ids are deterministic → M6 decisions and M7 change events can reference them stably.
- `candidateActions` uses MASTER §20 vocabulary so M6 can map 1:1.
- `impactInputs.baselineId` + target → ImpactPrediction (`baseline_snapshot_id`, `target_type`, `target_id`).
- Owner `status` vs system `engineState` separation → M9 learning can compare system detection with owner acceptance (recommendation acceptance rate, MASTER §37).
- `engineVersion` / `configVersion` on every opportunity → calibration in M9.

---

## Implementation status

**Implemented and tested on `feature/m5-opportunity-engine`** (PR). Live Hagar validation pending deploy (`functions`, `hosting:app`, `firestore:rules`).

| Component | File |
|---|---|
| Config (weights, thresholds, effort, candidate actions; versioned) | `functions/opportunityConfig.js` |
| Detection + scoring + evidence (pure) | `functions/opportunityRules.js` |
| Run orchestration, cache, lifecycle, writes | `functions/opportunityEngineStore.js` |
| HTTP endpoint `visibilityRunOpportunityEngine` | `functions/opportunityEngine.js` |
| Rules: engine opportunities protected; `opportunityRuns` read-only | `firestore.rules` |
| Inspection UI (פעולות → הזדמנויות) | `app/src/pages/business/EngineOpportunities.tsx` |
| Tests (24) | `functions/test/opportunityEngine.test.js` |

### Known limitations

- Market demand is unknown for topics without stored Semrush evidence (most topics today); confidence is lowered accordingly and demand-dependent gaps are capped at medium.
- No trend, SERP, page-level traffic or conversions → no freshness/decay, competitor or conversion-value opportunities.
- Topic ↔ page association inherits M4: observed (GSC) or text-containment inference; Hebrew morphology is not normalized.
- GSC query × page is limited to 1,000 rows per period in M4 (25,000 is now supported — follow-up).
- Score thresholds and effort levels are this engine's assumptions (labelled); they will be calibrated in M9.
- Firestore rules changes are not covered by an emulator test in this repo (rules are reviewed; the fake Firestore doesn't evaluate rules).
- A run interrupted mid-write leaves an `opportunityRuns` row in `running`; the next run recomputes (no partial cache hit, because only `completed` rows are reused).

### Deferred

- **M6:** SearchIntent, canonical ownership, cannibalization, final CREATE / IMPROVE / CONSOLIDATE / WAIT / MONITOR / REJECT, materialized `evidence` collection.
- **M7:** ImpactPrediction (uses `impactInputs`), SEOChangeEvent, SEOExperiment, churn prevention.
- **M8:** outcome measurement against `baselineId`.
- **M9:** weight/threshold calibration from owner acceptance (`status`) vs detection (`engineState`) and outcomes.

Decisions taken during implementation are appended below.

### ADR log

1. **Extend `opportunities`, don't add a collection.** One opportunity concept; manual and engine opportunities share the list, distinguished by `source`.
2. **No provider calls in M5.** Semrush evidence is used only if already stored; otherwise market demand is unknown.
3. **Embedded evidence with stable ids** instead of an `evidence` collection — fewer writes, still traceable; materializable later.
4. **Ordinal factors, band priority.** Avoids false precision; the numeric score is internal.
5. **Owner status is never written after creation.** Lifecycle split into owner `status` and system `engineState`.
6. **NO_ACTION / WAIT_FOR_DATA live on the run**, not as opportunity documents, so the list is never padded.
7. **Two complementary findings may coexist on one topic** (e.g. position 4–10 *and* CTR far below the site's): different candidate actions, different evidence; M6 decides.
8. **Page-level findings use only pages fetched in the latest crawl** — a stale observation never creates a new opportunity.
9. **Site-level `entity_clarity` excludes structured-data coverage and audience/positioning**: Google documents no special markup requirement for AI features, and positioning needs M6 entity work. A *conflicting* fact (e.g. two phone numbers) is observed and gets high confidence; "missing" signals are assumption-based and capped at medium confidence.
10. **Market demand ≠ observed visibility** (§9a): `demand` split into `marketDemand` (Semrush only, unknown otherwise) and `observedVisibility` (Search Console). Config version 2; the old `demand` weight key is ignored.
11. **Relative market-demand tiers need a minimum sample** (#55, §9b). Below 4 approved topics with positive demand, the value is kept but untiered (`insufficient_sample`), never shown as low or high. Config version 3.
12. **Relative visibility tiers and the tercile part of `minImpr` need a minimum sample** (#64, §9c). Below 4 approved topics with positive impressions:
    - a positive value is kept but untiered (`insufficient_sample`, source Search Console);
    - an observed zero stays level 0;
    - `minImpr` is the absolute floor (20).

    Which topics pass the threshold is unchanged; adequate samples are unchanged. Config version 4.
