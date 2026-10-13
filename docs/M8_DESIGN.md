# M8 — Measurement — Design

**Status:** DESIGN ONLY. No runtime code accompanies this document.
**Canonical parent:** `docs/MASTER.md` — §3 loop, §22 Evidence & Confidence, §32 Caching, §34 Governance, §38.5–38.12 (baseline, change event, observation states, attribution, prediction error, SEOExperiment, stage ownership), §43 rules, §46 freshness. Where this document and MASTER differ, MASTER wins. §17 lists the MASTER clarifications this design needs.
**Builds on:** M7 (`seoChangeEvents`, committed `impactPredictions`, `seoExperiments`, immutable before-snapshots, observation windows, time states, churn holds; `docs/M7_DESIGN.md`, `docs/M7_IMPLEMENTATION_NOTES.md`). M4 (`baselines`, `seoPages`, governed Search Console query × page). M2 (daily `searchSnapshots`, `trafficSnapshots`).
**Repository state at design time:** `main` @ `53ca86a` (M7 merged as #47 and deployed; its final live acceptance is still pending one controlled implementation).

Every threshold, band, floor and period length in this document is an **internal heuristic (ASSUMPTION)**. None of them is a Google value or a statistical guarantee. They are versioned in a future `measurementConfig` so M9 can calibrate them.

---

## 0. Freshness gate (MASTER §46) — verified 2026-10-13

| External claim M8 relies on | Source (last updated) | How M8 uses it |
|---|---|---|
| Search Analytics `dataState`: omitted/`final` returns "only finalized data"; `all` includes fresh (incomplete) data. | Google, *Search Analytics: query* (2026-08-11) | M8 measures with **final data only**. A checkpoint is due only once its whole period is old enough to be final. |
| `rowLimit` 1–25,000 (default 1,000), paging with `startRow`; the API "does not guarantee to return all data rows but rather top ones". | same | Measurement requests are **filtered to the experiment's pages**, so row counts stay small. Truncation is recorded (`possiblyTruncated`), never silently ignored. |
| Grouping by `date` is supported. | same | Daily (`date`) series per page give the history M8 needs (§10). |
| Quotas: 1,200 queries per minute per site and per user; 30,000,000 per day per project. | Google, *Search Console API usage limits* (2025-08-28) | M8 makes a few governed calls per experiment checkpoint, far below the quotas. The governor still enforces our own request limits. |
| The newest Search Console data "can be preliminary … might change in the next few hours". | Google, *Search Console Performance report* help | Same rule as above: final data only, plus the existing internal lag of 3 days (`GSC_LAG_DAYS`, ASSUMPTION, already used by M4). |

**Not verified and therefore not relied on:**
- the exact Search Console data-retention period (commonly cited as 16 months);
- the exact latency until data becomes final.

The design treats both as **availability facts learned per request**: if a period returns no data, it is recorded as unavailable, never as zero. The year-over-year check (§7) is used only when the data actually comes back.

---

## 1. The M8 question, and five things that stay separate

> **"What happened after the implementation, and what evidence do we have that the observed change is related to the implementation?"**

| Concept | Meaning | Where it lives | Written by |
|---|---|---|---|
| **Observation** | A measured fact for a period: for example, page X had 1,240 impressions from 6–19 Oct (Search Console, final data). It says nothing about the change. | `impactObservations` (immutable) | M8 server |
| **Signal** | An interpretation of observations *over time*: whether the observed change, after a defined point, meets a defined rule in the predicted direction. | `experimentOutcomes.signal` (state + history) | M8 server |
| **Outcome** | The classification of the experiment once its window has ended (or it became structurally inconclusive): did something change, in the predicted direction, size and timing, with enough evidence? | `experimentOutcomes.outcome` | M8 server |
| **Attribution confidence** | How confident we are that the observed change is **related to this implementation**. It is separate from prediction confidence and from the outcome. | `experimentOutcomes.attribution` | M8 server |
| **Learning** | What the outcome means for future predictions: calibration, error statistics, priors. | **M9**: M8 writes no learning field | M9 |

One status never stands in for another. A `MEANINGFUL_IMPACT` signal with **low** attribution is a valid, honest combination.

---

## 2. Scope and the M7 / M8 / M9 boundary

| Stage | M7 | M8 | M9 |
|---|---|---|---|
| PREDICT (committed prediction, ranges, ordinal magnitudes) | ✅ owns | reads | calibrates |
| IMPLEMENT (change event, owner attestation, crawl verification) | ✅ owns | reads | — |
| OBSERVE WINDOW / time and structural states (`PENDING_PUBLICATION`, `TOO_EARLY`, `PENDING_MEASUREMENT`, `CHANGE_IN_OBSERVATION_WINDOW`, structural `INCONCLUSIVE`) | ✅ owns | reads, never changes | — |
| Before-snapshot eligibility (P3) | ✅ owns | reads; never overwrites | — |
| Churn holds | ✅ state, applied in M6 | — | calibrates hold lengths |
| **MEASURE** (after observations, after-snapshot) | ❌ | ✅ | reads |
| **COMPARE** (pre/post, site trend, year over year) | ❌ | ✅ | reads |
| **SIGNAL STATES** (`NO_SIGNAL_YET` … `FAILED`) | ❌ never | ✅ | reads |
| **CLASSIFY OUTCOME** | ❌ | ✅ | reads |
| **ATTRIBUTION confidence** | ❌ | ✅ | reads |
| **PREDICTION vs ACTUAL** (structured comparison) | ❌ | ✅ records | ✅ turns into error / calibration |
| LEARN / CALIBRATE / REPRIORITIZE | ❌ | ❌ | ✅ |

**Explicitly out of M8:**
- calibration coefficients, learned models, numeric prediction error statistics, re-prioritisation of recommendations (M9);
- any change to M7 states, windows, holds or predictions;
- causal claims;
- SERP / competitor / backlink providers;
- page-level GA4 (deferred, §9);
- any website change.

---

## 3. Architecture decisions

### AD-1 — M8 never writes `seoExperiments`; outcomes live in `experimentOutcomes`

M7 reserved `seoExperiments.outcome`, `signalState` and `attributionConfidence`. However, M7's experiment recompute (`trackingStore.planExperiments`) writes the **full** experiment document with those fields set to `null` on every change. If M8 wrote them, the next M7 tracking run would silently erase M8's results.

**Decision:**
- M8 writes **only** its own collections: `impactObservations` and `experimentOutcomes`. Its one narrow cross-collection write is `seoChangeEvents.afterSnapshot` (AD-4).
- The three reserved `seoExperiments` fields stay `null` forever and are documented as superseded by `experimentOutcomes` (§17).
- M7 runtime is unchanged (the owner constraint for this design).

### AD-2 — Measurement is per experiment, at deterministic checkpoints derived from M7

M8 creates no parallel timing system. Its checkpoints come from the experiment M7 already computed:
- `startMs`;
- `stageWindows.A/B/C`;
- `observationWindowEnd`, `businessWindowEnd`;
- `lateChangeEventIds`.

The **run unit** is one *(experiment, checkpoint)* pair (§4). A business-level measurement run processes every checkpoint that is due.

### AD-3 — Search Console is both the after-source and the history store; observations make it immutable

Issue #40 (no page/topic history) is solved **for measurement** without a general history system:
- Search Console keeps daily data that can be queried per page with the `date` dimension.
- M8 requests exactly the periods it needs (before, after, site trend, year over year), filtered to the experiment's pages.
- It writes the results as **immutable `impactObservations`**.

Those observations *are* the page/topic history from then on. Before and after are measured **with the same method and the same filters**.
- The M7 before-snapshot (immutable baseline) remains the provenance anchor and the crawl/structural reference.
- It is **not** compared number-for-number with a differently aggregated after period.

### AD-4 — The after-snapshot is a new immutable baseline, linked, never an overwrite

The structural after-state (title, H1, indexability, …) comes from a **new** immutable baseline version. It is captured via the existing `captureBaseline` from the stored state of an M4 analysis completed after `start + B.min`.

M8 links it on the change event:
- it sets `seoChangeEvents.afterSnapshot = {status: "linked", baselineId, capturedAtMs, sourceRunId}` (server-only update of that one field);
- and it records it in `experimentOutcomes`.

The before-snapshot is never touched. If no qualifying M4 analysis exists yet, the after-snapshot is `awaiting_analysis`. The Search Console metrics do not depend on it.

### AD-5 — Analytic thresholds, not statistical claims

Samples are small: one business, a few pages, weeks of daily data. M8 therefore uses **deterministic analytic rules**:
- volume floors;
- relative-change bands;
- divergence from the site trend;
- persistence across consecutive weekly buckets.

It never reports p-values, "significance" or a numeric attribution probability. Every rule is labelled ASSUMPTION. Where a sample is below its floor, the result is `insufficient_data`, never a guess.

### AD-6 — Attribution confidence is its own ordinal model, and is never raised by improvement alone

Attribution is a weakest-link model (§7) over interference, verification, baseline quality, volume, trend divergence, persistence, timing and seasonality evidence. How much the metric improved is **not** an input to attribution; it can only be an input to the signal.

### AD-7 — Explicit runs only, through the existing governor

The only external calls are Search Console requests, through `runGoverned`:
- a new operation `google.searchConsoleMeasurement`;
- cache-aware, quota-aware, fail-closed and recorded in `apiUsage`.

No GA4 call is added: business impact uses the existing daily `trafficSnapshots`. Nothing runs on render, on a listener, on dashboard open, on deploy, or on a schedule in v1 (#46 remains the opt-in scheduled-refresh option).

---

## 4. Checkpoints and the after-period

### 4.1 Checkpoints (per experiment; deterministic; ids `{experimentId}_cp_{name}`)

| Checkpoint | Due at (calendar date in business time zone) | Purpose |
|---|---|---|
| `cp_a` | `start + A.max` + lag | First-signal check (stage A range fully elapsed) |
| `cp_b` | `start + B.max` + lag | SEO-signal check |
| `cp_end` | `observationWindowEnd` + lag | Final SEO outcome |
| `cp_c` | `businessWindowEnd` + lag | Business-impact check, only if stage C is measurable (`trafficSnapshots` provide organic sessions or conversions) |

- `lag = GSC_LAG_DAYS` (3, ASSUMPTION; already used by M4), so every day in the after-period is final.
- `cp_a` measures the after-period `[start, start + A.max]`. It also scans weekly buckets from `start + A.min`, to find *when* a signal first appeared (§8).
- **Due rule:** `now ≥ dueAt`, the experiment is not structurally `INCONCLUSIVE` in M7, and the checkpoint has no observation yet. A checkpoint is measured **once**. Re-measuring needs an explicit `forceRemeasure` (owner action, recorded).
- **Missing a checkpoint is fine.** If the owner runs measurement late, all past-due checkpoints are measured in order, each with its own fixed period. The result is identical whatever day the run happens.
- **Window changes.** If M7 extends the window (late change), `cp_end` / `cp_c` move with it: they are recomputed from the current experiment on each run. `cp_a` / `cp_b` stay fixed to the experiment's grouped prediction. Already-measured checkpoints are never rewritten.

### 4.2 Periods compared

| Period | Definition |
|---|---|
| **Before** | `[start − L, start − 1 day]` |
| **After** | `[start + offset, start + offset + L − 1]` for that checkpoint, where `offset = A.min` for `cp_a`, `B.min` for `cp_b`, and `observationWindowEnd − L` for `cp_end` |
| **Site trend** | The same two date ranges for the whole property, **excluding** the experiment's pages (§5.3) |
| **Year over year** (optional) | The same after-period one year earlier, and the same before-period one year earlier, when Search Console returns data for them |

- `L` = 28 days (ASSUMPTION). It is always a **whole number of weeks**, so weekday mix is identical, and it is shortened only to fit the elapsed time, with a minimum of 14 days (ASSUMPTION).
- If fewer than 14 after-days are available, the checkpoint is `insufficient_data`.
- `start` is M7's `startMs`: publication date, or implementation date when there is no publication date.
- For a **late join**, the late change gets its own sub-comparison anchored on its own start. The experiment-level comparison stays anchored on the experiment start, with the late change recorded as interference (§7).

### 4.3 Scope per experiment

| Experiment unit | Measured scopes |
|---|---|
| Page (IMPROVE / CONSOLIDATE) | **page** (target page), **query set** (the queries that page received in the before-period, plus queries emerging after), **intent** (queries of the intent's topics, all pages), and for CONSOLIDATE the **affected pages** combined with the owner page |
| New page (CREATE) | **page** (the new URL; before = absent), **intent** (the intent's topic queries, all pages; the main comparison, because the new page has no before) |
| Site (business facts) | **site** totals, branded queries (brand terms from `businessKnowledge`) |
| Any, when measurable | **business** (site-level organic sessions and conversions from `trafficSnapshots`) |

---

## 5. Pre / post comparison

### 5.1 Dimensions (per scope, per period)

| Dimension | Source | Note |
|---|---|---|
| impressions, clicks | Search Console, final data | sums over the period |
| CTR | clicks / impressions | only when impressions ≥ floor |
| position | impression-weighted average | reported as a band change (1–3, 4–10, 11–20, >20), not just a number |
| query emergence | queries with impressions after but not before | count, plus up to 20 examples |
| query loss | the reverse | count |
| page visibility | the page appears for ≥ 1 query | yes / no per period |
| topic / intent visibility | the same measures over the intent's query set | |
| traffic, conversions | `trafficSnapshots` organic sessions and conversions (site-level, 28-day snapshots nearest the period) | site-level only |

### 5.2 Change measures

| Measure | Rule |
|---|---|
| **Absolute change** | after − before |
| **Relative change** | (after − before) / before; `null` when before = 0 (reported as "new visibility" instead) |
| **Direction** | `up` / `down` / `flat`: flat if \|relative\| < 10 % (ASSUMPTION) or below the volume floor |
| **Weekly persistence** | the after-period split into weekly buckets: share of buckets that move in the same direction versus the before weekly mean |
| **Site-adjusted change** | target relative change − site relative change (excluding target pages) |
| **Analytically meaningful** | **all** of the following hold: (a) volume floor met (impressions ≥ 100 in each period, ASSUMPTION); (b) \|relative change\| ≥ 25 % (ASSUMPTION); (c) the site-adjusted change has the same sign and \|site-adjusted\| ≥ 15 % (ASSUMPTION); (d) persistence ≥ ⅔ of weekly buckets (ASSUMPTION) |

Anything that misses the volume floor is `insufficient_data`. M8 never reports statistical significance, p-values or confidence intervals (AD-5).

### 5.3 Site trend (the comparison baseline)

The site trend comes from the same Search Console property over the same dates, **with the experiment's pages filtered out**. For small sites where the remainder is below the volume floor, the site trend is `unavailable` and condition (c) is not met: the result is `insufficient_data`, never a pass.

### 5.4 Ordinal observed magnitude (to compare with M7's ordinal prediction)

| Band | Relative change of the stage's main metric (ASSUMPTION) |
|---|---|
| `none` | \|change\| < 10 % or not meaningful |
| `small` | 10–25 % |
| `moderate` | 25–60 % |
| `large` | > 60 % |
| `unknown` | insufficient data |

The **main metric** depends on the change class:
- impressions for visibility predictions;
- position band for ranking;
- clicks for traffic;
- CTR for `snippet` changes.

---

## 6. Signal states and outcomes

### 6.1 Taxonomy: the existing MASTER §38.7 names are kept

MASTER §38.7 and the M7 design already define the M8-reserved states. They map to the progression suggested for M8 like this:

| Suggested name | Name used (MASTER §38.7 / M7 reservation) |
|---|---|
| `NO_SIGNAL_YET` | `NO_SIGNAL_YET` |
| `SIGNAL_DETECTED` | `EARLY_SIGNAL` |
| `MEANINGFUL_SIGNAL` | `SEO_SIGNAL` |
| `BUSINESS_IMPACT_DETECTED` | `MEANINGFUL_IMPACT` |
| `INCONCLUSIVE` | `INCONCLUSIVE` (measurement) |
| `FAILED` | `FAILED`, plus `UNDERPERFORMING` |

M7 already guards these exact names, and the UI and docs already use them, so no rename is introduced. Every signal also carries a **direction** (`toward_prediction` / `against_prediction` / `none`). A strong move *against* the prediction is not "a signal for the change" and is never shown as success.

### 6.2 State machine (written only by the M8 server; persisted in `experimentOutcomes.signal`)

| State | Entry condition | Evidence required | Exit |
|---|---|---|---|
| `NO_SIGNAL_YET` | A checkpoint was measured and **no** dimension shows a meaningful change in the predicted direction; the window is still open | a measured `cp_a`/`cp_b` observation with sufficient data | to `EARLY_SIGNAL` / `SEO_SIGNAL` at a later checkpoint; to `UNDERPERFORMING` at `cp_b`; to `FAILED` / `INCONCLUSIVE` at `cp_end` |
| `EARLY_SIGNAL` | At `cp_a` or later, a **leading** dimension (query emergence, impressions or page visibility) is directional toward the prediction, and its weekly persistence is ≥ ½ (ASSUMPTION), but it is not yet "meaningful" (§5.2) | volume floor met for the leading dimension | to `SEO_SIGNAL`; back to `NO_SIGNAL_YET` is **not** allowed (history keeps it; a later checkpoint without signal becomes `UNDERPERFORMING` or `FAILED`) |
| `SEO_SIGNAL` | At `cp_b` or later, the stage-B main metric is **analytically meaningful** (§5.2, all four conditions) toward the prediction | a meaningful comparison at the target scope | to `MEANINGFUL_IMPACT`; stays `SEO_SIGNAL` at `cp_end` if no business data |
| `MEANINGFUL_IMPACT` | `SEO_SIGNAL` holds, **and** at `cp_c` the site-level organic sessions or conversions are meaningful toward the prediction | business data available (stage C measurable) | final |
| `UNDERPERFORMING` | At `cp_b` (never earlier: `now > start + B.max`), the main metric is not meaningful toward the prediction, with sufficient data | a measured `cp_b` with sufficient data | to `SEO_SIGNAL` if `cp_end` meets it (a late success), else to `FAILED` |
| `FAILED` | At `cp_end` (never earlier: `now > observationWindowEnd`), the main metric is not meaningful toward the prediction (or is meaningfully against it), with sufficient data, and the change was verified or not contradicted | `cp_end` measured with sufficient data. **Never from elapsed time alone** (MASTER §38.7) | final |
| `INCONCLUSIVE` (measurement) | Any measured checkpoint where data is insufficient (volume floor, missing periods, no site trend for a meaningful claim), **or** the experiment is structurally `INCONCLUSIVE` in M7 (reverted / contradicted / saturated) | the reason is recorded: `insufficient_volume`, `data_unavailable`, `structural_m7`, `excessive_interference` | final at `cp_end`; before `cp_end` it is provisional and can move to a signal state at a later checkpoint with sufficient data |

**Before the first checkpoint:**
- there is **no** M8 state (`signal = null`);
- the UI shows M7's time state (`TOO_EARLY` / `PENDING_MEASUREMENT`).

### 6.3 Outcome (`experimentOutcomes.outcome`, set once at `cp_end`, or `cp_c` when measurable, or on a structural M7 `INCONCLUSIVE`)

The outcome answers six separate questions, each with its own field:

| Question | Field | Values |
|---|---|---|
| Did something change? | `changed` | `yes` / `no` / `unknown` |
| In the predicted direction? | `directionMatch` | `match` / `opposite` / `none` / `unknown` |
| Magnitude inside the predicted ordinal band? | `magnitudeMatch` | `within` / `below` / `above` / `unknown` |
| Timing inside the predicted range? | `timingMatch` (per stage A / B / C) | `within` / `early` / `late` / `not_observed` / `unknown` |
| Was the evidence sufficient? | `evidence` | `sufficient` / `partial` / `insufficient` |
| Classification | `classification` | `CONFIRMED_AS_PREDICTED`, `POSITIVE_BUT_DIFFERENT` (direction ok, magnitude or timing off), `NO_MEASURABLE_CHANGE`, `NEGATIVE`, `INCONCLUSIVE` |

`classification = INCONCLUSIVE` whenever `evidence = insufficient`, whatever the metrics did. The outcome carries **no** causal claim; attribution is a separate field (§7).

---

## 7. Attribution confidence (separate from prediction confidence)

- **Prediction confidence** (M7): how sure we were *before* the implementation.
- **Attribution confidence** (M8): how sure we are that the observed change is **related** to this implementation.

It is ordinal (`low` / `medium` / `high`) with explicit reasons, computed only when a change was observed (`changed = yes`). Otherwise it is `not_applicable`.

### 7.1 Model (weakest link; start at `high`, every unmet requirement caps it)

| Factor | Requirement | Cap if not met |
|---|---|---|
| Change actually in place | the M7 change event is `verified` (or `not_verifiable` with owner attestation) | `contradicted` → no attribution, structural INCONCLUSIVE; `not_observed` → **low** |
| Clean before-state | before-snapshot `linked` (P3) | `missing` → **medium**; `contaminated` → **low** |
| No overlapping change on the same unit | no `lateChangeEventIds`, no other live experiment on the same page or intent in the measured period | late change or overlapping experiment → **low** |
| Grouped changes | one change class, or several classes grouped by M7 | several classes → **medium** (the effect cannot be split between them) |
| No site-wide change in the period | no `site_wide_change` interference in the period | → **medium** |
| Multiple pages changed | single-page experiment (CONSOLIDATE / CREATE counted separately) | consolidation or multi-page → **medium** |
| Volume | impressions ≥ 300 per period (ASSUMPTION; higher than the signal floor) | → **medium** |
| Divergence from site trend | the site-adjusted change meets §5.2(c) | not met or site trend unavailable → **low** |
| Persistence | ≥ ⅔ weekly buckets (§5.2(d)) at two consecutive checkpoints | single checkpoint only → **medium** |
| Timing plausibility | the first signal appeared inside or after the predicted stage-A range, never **before** publication | signal began before the start → **low** (something else moved it) |
| Seasonality | a year-over-year comparison is available **and** last year's same-period change does not explain the observed change (\|YoY change\| < half the observed change, ASSUMPTION) | no YoY data → **medium** |
| SERP volatility, competitor moves, algorithm updates, backlinks | no provider in v1: always **unknown** | contributes to the stated unknowns; caps nothing beyond the seasonality and trend rules |

**Two rules hold regardless of the table:**
- **High** is reachable only when every row is met, so improvement alone can never produce it (AD-6).
- Every cap adds a plain reason to `attribution.reasons[]`, and every unknown is listed in `attribution.unknowns[]`.

---

## 8. Prediction vs actual (structured observation for M9; no calibration)

Stored in `experimentOutcomes.predictionVsActual`, one entry per committed member prediction plus one for the experiment-level prediction:

```text
predictionId, changeType
stages:
  A: predicted {minDays, maxDays}  actual {firstSignalDay | null, basis: "weekly_bucket", resolutionDays: 7}  timing: within|early|late|not_observed|unknown
  B: predicted {...}                actual {seoSignalDay | null, ...}                                         timing: ...
  C: predicted {...} | not_applicable  actual {...}                                                          timing: ...
direction:
  visibility: predicted {direction, band}  actual {direction, band}  match
  ranking:    predicted {...}               actual {fromBand, toBand}  match
  traffic:    predicted {...}               actual {...}               match
evidence: sufficient | partial | insufficient
attributionConfidence: low | medium | high | not_applicable
```

- The **first-signal day** is the start of the first weekly bucket (from `start + A.min`) in which the leading dimension meets the `EARLY_SIGNAL` rule. Its resolution is **7 days**, and it is stored as such ("observed around day 14 ± 7"), never as an exact day.
- M8 writes **no** error metric, coefficient, score or prior. M9 consumes this record.

---

## 9. Data sources

| Source | Status | M8 use |
|---|---|---|
| Search Console Search Analytics (page × date, query × page × date, filtered to experiment pages; property × date for the site trend) | **available now**: the existing service-account connection and `googleSearchConsole.js` adapter, extended with filters and the `date` dimension | all SEO dimensions; before / after / site trend / year over year |
| M2 daily `searchSnapshots` (site totals) | available | sanity check of the site trend only; too coarse for pages |
| GA4 via `trafficSnapshots` (site-level 28-day organic sessions, conversions) | available when GA4 is connected | stage C at **site level only** |
| Page-level GA4 (landing-page report) | **requires a new governed GA4 call**: deferred | stage C stays site-level and attribution-limited |
| M4 crawl (`seoPages`, `intelligenceRuns`) | available on explicit M4 runs | the after-snapshot (structural); verification remains M7 |
| M7 experiments, change events, committed predictions, before-snapshots | available | timing, scope, prediction, before anchor |
| Immutable baselines | available | before-snapshot (M7), after-snapshot (M8, AD-4) |
| Semrush (market demand) | deferred (V4 Keyword Metrics only; balance check under diagnosis) | not needed for measurement |
| SERP / rank tracking / backlinks | **unavailable** | recorded as unknowns in attribution |
| Per business | Search Console or GA4 may be disconnected | that scope is `data_unavailable`, never zero |

---

## 10. History gap (#40): the minimum M8 needs

| Need | M8 approach | Rejected / deferred |
|---|---|---|
| Page metrics over time | `impactObservations` built from Search Console `date`-dimension rows for the experiment pages, stored immutably per checkpoint | a full per-run history of every page (not needed for measurement) |
| Query × page over time | stored only for the experiment's page set, with top-N query rows (≤ 200 per period, ASSUMPTION), plus totals | site-wide query × page history (cost, size) |
| Topic / intent over time | derived from the intent's query set at measurement time, stored in the observation | a separate topic-history collection |
| Crawl state over time | immutable baselines (before = M7, after = M8) | per-run `seoPages` versions |
| Volatility / trend | the site trend from the same request family | a general volatility store |

What this leaves open in #40: the M4 / M5 / M6 engines still see only the latest run. That is not an M8 problem and stays in #40 for a later decision.

---

## 11. Data model

### 11.1 `impactObservations/{id}`: immutable, create-only

**Id.** `{biz}_obs_{sha16(experimentId | checkpointId | scope | unitKey | period | measurementConfigVersion)}`. Content-addressed per checkpoint, so a re-run creates nothing new.

```text
observationId, businessId, experimentId, checkpointId, changeEventIds[]
scope: page | query_set | intent | site | business
unitKey (pageKey | intentId | "site")
period: { role: before | after | site_before | site_after | yoy_before | yoy_after, startDate, endDate, days }
source: { provider: "search_console" | "ga4_snapshot", operation, dataState: "final", apiUsageId | snapshotId, siteProperty }
filters: { pageKeys[], excludedPageKeys[], queries? }   (provenance of what was asked)
metrics: { impressions, clicks, ctr, position, queriesWithImpressions } | null
weekly[]: { weekStart, impressions, clicks, position }
queries: { top[] (≤ 200: query, impressions, clicks, position), emerged[] (≤ 20), lost[] (≤ 20), possiblyTruncated }
availability: available | partial | unavailable, reason
baselineRef: { beforeBaselineId (M7), afterBaselineId | null (M8) }
capturedAtMs, measurementConfigVersion, measurementEngineVersion
basis: "observed"
```

### 11.2 `experimentOutcomes/{experimentId}`: one per experiment, server-written

```text
experimentId, businessId, changeEventIds[], predictionId (experiment-level), memberPredictionIds[]
checkpoints: { cp_a|cp_b|cp_end|cp_c: { status: not_due | due | measured | insufficient_data | data_unavailable, measuredAtMs, observationIds[], comparison{...} } }
signal: { state | null, direction, sinceCheckpoint, history[] (append-only: {state, direction, checkpointId, atMs, reasons[]}) }
outcome: null | { classification, changed, directionMatch, magnitudeMatch, timingMatch{A,B,C}, evidence, reasons[], finalizedAtMs, final: true }
attribution: { confidence: low|medium|high|not_applicable, reasons[], unknowns[], interferences[] }
predictionVsActual: [...] (§8)
afterSnapshot: { status: awaiting_analysis | linked, baselineId, capturedAtMs, sourceRunId }
ownerNote (owner-editable)
measurementConfigVersion, measurementEngineVersion, lastRunId, history[] (append-only), createdAtMs, updatedAtMs
// reserved for M9 (M8 never writes): calibration: null, predictionError: null, learnedAtMs: null
```

### 11.3 Immutability rules

- Observations are never updated or deleted.
- Once `outcome.final = true`, the outcome is frozen. A deliberate re-measure (`forceRemeasure`, a new config version) creates a **new** outcome version: the previous one is moved into `outcomeHistory[]`, never erased.
- The signal history is append-only.
- `seoChangeEvents.afterSnapshot` is the only M8 field on an M7 document. It is written once per link and is never cleared.

---

## 12. Firestore security

| Collection / field | Client read | Client write | Server |
|---|---|---|---|
| `impactObservations` | admin | **none** | create only |
| `experimentOutcomes` | admin | update **only** `ownerNote` (string ≤ 2,000), `updatedAt` | everything else |
| `measurementRuns` | admin | none | all |
| `measurementRunLocks` | none | none | all |
| `seoChangeEvents.afterSnapshot` | admin | **none** (the existing rule allows only `implementationNotes`) | M8 update of this one field |
| `seoExperiments` | unchanged | unchanged | M7 only; M8 never writes |
| M9 fields (`calibration`, `predictionError`, `learnedAtMs`) | admin | none | M9 only |

Today `impactObservations` and `experimentOutcomes` are admin-read / no-write placeholders (from M7). M8 changes only `experimentOutcomes` (the owner-note rule) and adds the run and lock collections. Emulator tests for these rules depend on #45 (§16).

---

## 13. API / cost governance

- **New governed operation:** `google.searchConsoleMeasurement` in `apiLimits.js`. Request-count limits per business and globally, a cache TTL of 12 h (final data does not change once final), a circuit breaker, fail closed.
- **Cache identity:** `siteUrl`, dimensions, filters (sorted page keys / excluded keys), dates, `dataState`, row limit, `measurementConfigVersion`. The same checkpoint re-run is a cache hit with `providerCalled: false`, $0.
- **Calls per checkpoint (typical page experiment):** before + after for the target pages (`date` + `query` dimensions), the site trend excluding the pages (2 date-only calls), and optionally year over year (2). That is at most 6 calls, each small.
- **No GA4 call** (`trafficSnapshots` only).
- **Never on render, listener, dashboard open, deploy or schedule.** Covered by the existing app test, extended to the new callable.
- **Failures.** A provider failure marks that checkpoint `data_unavailable`, records the reason, and creates **no** observation. The next explicit run retries through the governor (fail closed, no blind retry loop).

---

## 14. Run safety (the M6 / M7 pattern)

- **Run unit:** *(experiment, checkpoint)*. Business-level run: `visibilityRunMeasurement` (POST, admin, explicit).
- **Input fingerprint:**
  - each experiment's M8-relevant fields (`startMs`, stage windows, window end, late and live change ids, interference, status);
  - the committed predictions' stage ranges;
  - change-event verification statuses;
  - before and after baseline ids;
  - `measurementConfig` and versions;
  - the **due-checkpoint vector** at `nowMs` (time changes the fingerprint only when a checkpoint becomes due).
- **Output-state fingerprint:** observation ids, outcome checkpoint statuses, signal state, outcome classification.
- **Cache hit** (both fingerprints match the last completed `measurementRuns` record) = zero writes.
- **Lease lock** `measurementRunLocks/{biz}`. It is separate from M7's lock, because M8 reads M7 without writing it. M7 data read mid-run is a consistent snapshot read before any write.
- **Writes:** chunked batches, deterministic ids, create-only observations, `failed` / `abandoned` run states, and idempotent repair on the next run. Provider calls happen **before** any write; a provider failure aborts that checkpoint only.

---

## 15. UI (owner-facing; small)

On each experiment card in פעולות › מעקב שינויים, a **מדידה** section reads as one line of story, in plain Hebrew:

**תחזית → ביצוע → תצפית → מה השתנה → תוצאה → עד כמה זה קשור לשינוי**

Example: "צפינו לסימן ראשון תוך 1–5 שבועות · השינוי פורסם ב-8.10 · נמדד עד 5.11 · החשיפות לדף עלו בערך 30% (האתר כולו: +4%) · תוצאה: כצפוי · קשר לשינוי: בינוני — אין השוואה לשנה שעברה".

- The comparison numbers sit behind **פירוט**, as a table with before, after and site trend.
- Signal-state labels use the MASTER names, translated. M7's time state is shown before the first checkpoint.
- An **עדכון מדידה** button is the only trigger, with a note when nothing is due ("הבדיקה הבאה: 15.11").
- An owner note field.
- No charts beyond a small weekly sparkline per scope (optional), and no dashboard.

---

## 16. Backlog classification

| Issue | Classification | Why |
|---|---|---|
| **#35** runtime / dependencies (Node 20 decommissioned on **2026-10-30**) | **M8 blocker (deploy)** | New M8 functions cannot be deployed on a decommissioned runtime. Migrate before M8 deploy. |
| **#40** page/topic history | **M8 prerequisite, resolved inside M8 phase 1** (AD-3, §10) | Measurement needs period data; Search Console page × date + immutable observations supply it. The engine-wide part stays in #40. |
| **#45** CI + rules emulator | **M8 prerequisite** (strongly recommended before M8 rules ship) | M8 adds server-only collections and one owner field; static rule checks are the only guard today. |
| **#44** same-day before-snapshot | **can defer** | It lowers attribution (before `contaminated` → low) but does not block measurement. |
| **#46** scheduled tracking refresh | **can defer** | Measurement is explicit; checkpoints are measured late without loss (§4.1). |
| **M7 live acceptance** (one controlled implementation) | **M8 blocker (live acceptance)** | M8's live flow needs a real committed prediction, change event, before-snapshot and experiment. |
| **#53** `seoExperiments` reserved M8 fields are rewritten to `null` by every M7 recompute | **resolved by design** (AD-1); clean-up can defer | M8 must never rely on them. |

---

## 17. MASTER clarifications proposed

1. **§38.7 / §38.12.** Signal and outcome state for an experiment live in `experimentOutcomes/{experimentId}`. The reserved `seoExperiments.outcome / signalState / attributionConfidence` fields stay `null` (superseded; M7 rewrites experiments wholesale).
2. **§38.6.** `after_snapshot_id` is a new immutable baseline linked by M8 on the change event. The before-snapshot is never modified.
3. **§38.8.** The comparison baseline for attribution is the **site trend excluding the experiment's pages**, plus year over year when available. Attribution is ordinal (low / medium / high), weakest-link, and never raised by improvement alone.
4. **§38.9.** M8 records a structured prediction-vs-actual. **Prediction error as a number** and calibration are M9.

---

## 18. Acceptance (summary; full list in `docs/M8_IMPLEMENTATION_BRIEF.md`)

**Prerequisite:** M7 live acceptance is done for one real Hagar implementation.

**Live Hagar flow:**
1. An M7 change event, a committed prediction, a linked before-snapshot and an open experiment exist.
2. The first checkpoint becomes due.
3. An explicit measurement run captures before and after observations through governed Search Console calls (rows in `apiUsage`).
4. It sets a signal state, or `NO_SIGNAL_YET` / `INCONCLUSIVE` with reasons.
5. The before/after/site-trend comparison is visible.
6. Attribution confidence is explicit, with reasons and unknowns.
7. Prediction vs actual is recorded for stage A.
8. A repeated run is a cache hit with zero writes, and the governed calls are cache hits at $0.
9. No call happens on render.
10. The M9 fields stay `null`.
11. M7 documents are unchanged except `afterSnapshot`.

Full outcome classification arrives only at `cp_end` (about 13–14 weeks after publication for a content change). Fixtures prove it before then.
