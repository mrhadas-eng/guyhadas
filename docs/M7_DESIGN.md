# M7 — Prediction, Change & Experiment Tracking — Design

**Status:** DESIGN ONLY. No runtime code accompanies this document.
**Canonical parent:** `docs/MASTER.md` — §3 loop, §21 Decision Engine, §22 Evidence & Confidence, §32 Caching, §34 Governance, **§38 Time-to-Impact (38.1–38.11)**, §41 M7–M9, §43 rules, §46 freshness. Where this document and MASTER differ, MASTER wins. §16 of this document lists the clarifications proposed for MASTER.
**Builds on:** M4 (`seoPages`, `topicIntelligence`, `intelligenceRuns`, immutable `baselines`), M5 (`opportunities`, `impactInputs`), M6 (`decisions`, `searchIntents`, owner review, run safety) — all live-validated on Hagar.
**Repository state at design time:** `main` @ `d5d1f94` (M6 merged and validated; #36 fixed).

Every number in this document — every prior, multiplier, threshold, cap and window — is an **internal heuristic (ASSUMPTION)**. None is a Google-published timeline or a promise. All of them are versioned in a future `predictionConfig` so M9 can calibrate them.

---

## 0. Freshness gate (MASTER §46) — re-verified 2026-10-11

| External claim M7 relies on | Source (last updated) | Status | How M7 uses it |
|---|---|---|---|
| "Crawling can take anywhere from a few days to a few weeks." | Google, *Ask Google to recrawl your URLs* (2025-12-10) | CURRENT | Lower bound of stage A (first observable signal) is days, upper bound is weeks. There is never an "instant" stage A. |
| "Some changes might take effect in a few hours, others could take several months." Also: "wait a few weeks to assess whether your work had beneficial effects." | Google, *SEO Starter Guide* (2025-12-10) | CURRENT | Ranges, not dates. Stage B/C ranges reach into months. Nothing is evaluated before "a few weeks". |
| Redirect methods differ in how quickly search engines notice them; no timeframe is given for canonical processing. | Google, *Consolidate duplicate URLs* (2026-07-10) | CURRENT | Consolidation gets the widest stage-B range and an expected temporary-volatility note. No processing time is claimed. |

**Historical practice M7 does NOT encode:** fixed "wait 90 days" rules, "ranking in 2 weeks" promises, or numeric traffic forecasts.

---

## 1. Summary: the quality-bar questions answered

| # | Question | Answer |
|---|---|---|
| 1 | What exactly is predicted? | For one implemented (or about-to-be-implemented) change on one target, three **separate time ranges** in days: A first observable signal, B meaningful SEO signal, C meaningful business impact. Plus **ordinal** expectations of direction and size for visibility, ranking and traffic. Plus a confidence level with reasons and a full factor list. No dates, no numbers of clicks, leads or revenue (§4). |
| 2 | When is it predicted? | Lifecycle rule **D**. A *provisional* prediction is computed only for **owner-accepted** decisions, on an explicit tracking run. It is **committed** (frozen) when the implementation is recorded, using only pre-implementation evidence. No predictions are made for decisions nobody accepted (§3, AD-1). |
| 3 | What data supports it? | Only stored M2–M6 evidence: site-level Search Console and GA4 snapshots, page crawl state (indexability, canonical, robots, sitemap, internal links, orphan), current-period query × page visibility, Semrush demand when stored, M6 intent and decision confidence, the owner-recorded change elements, and the immutable baseline (§4.2). |
| 4 | What is unknown? | Authority/backlinks, page age, SERP volatility and competition, seasonality, algorithm updates, competitor movement, Google's own index and crawl activity, page-level history, and historical responsiveness (no completed experiments yet). Each is listed explicitly as `unknown` on every prediction and never treated as zero (§4.3). |
| 5 | Who records implementation? | The owner (or the operator acting for them), through an explicit form in the app → server endpoint. Acceptance is **not** implementation. Future automated execution (M11) records through the same endpoint with `responsibleActor.type = "system"` (§6). |
| 6 | What proves an implementation actually happened? | Two layers. (a) **Owner attestation** (`basis: owner_reported`) at record time. (b) **Crawl verification** on the next M4 run: the observable changed elements (title, H1/H2, canonical, indexability, robots, sitemap, internal links, structured data, page exists) are compared with the before-snapshot → `verified`, `not_observed`, `not_verifiable` or `contradicted` (§6.4). Verification checks the change, not the outcome. |
| 7 | When does the observation window begin? | At the **publication date** (the date the change went live). If no publication date is given, at the implementation date. If the date is in the future, the window has not started (`PENDING_PUBLICATION`) (§5.1). |
| 8 | When does it end? | Dynamically: start + the predicted stage-B maximum + a tail, bounded by caps. It is extended (bounded) when related changes join the same experiment. The business-impact stage has its own later end (§5.2–5.4). |
| 9 | How is churn prevented? | Inside **M6**, using M7 experiment state as an input (AD-2). Overlapping decisions on a page under observation become **WAIT** (or **MONITOR** for the implemented decision itself) with an evidence-backed reason code, a blocking condition, a dependency on the experiment, and the held recommendation preserved. There is no new decision type. Explicit, deterministic override reasons apply (§9). |
| 10 | How do multiple changes become one experiment? | Same target page + published within the **grouping window** of the experiment's first change → same `SEOExperiment`. A later change inside the observation window joins as a *late* change, flags `CHANGE_IN_OBSERVATION_WINDOW` and extends the window (bounded). Different pages are separate experiments, linked when they share an intent. A site-wide change is its own experiment and an interference note on page experiments (§8). |
| 11 | What does M7 own? | Predictions, implementation capture, change events, crawl verification of changes, observation windows and their **time-based** lifecycle states, experiment containers, and churn-hold state (§2). |
| 12 | What does M8 own? | Measurement: post-change observations, after-snapshots, every **signal** state (NO_SIGNAL_YET … FAILED), pre/post and control comparisons, attribution confidence, outcome (§2). |
| 13 | What does M9 own? | Prediction error, calibration of priors/multipliers/caps/confidence, numeric confidence, learned models, recommendation success scoring (§2). |
| 14 | How does it stay deterministic, cacheable and auditable? | Pure prediction/window/grouping modules. Content-addressed ids (prediction id = hash of its full input). Full input + output-state fingerprints as in M6. Per-business lease lock. Chunked idempotent writes with failed/abandoned run states. Create-only prediction content. Append-only change-event history. Immutable baselines as before-snapshots (§11). |

---

## 2. Scope and the M7 / M8 / M9 boundary

| Capability | M7 | M8 | M9 |
|---|---|---|---|
| `ImpactPrediction` (heuristic, versioned, ranges, factors, confidence) | ✅ creates, commits, supersedes | reads | calibrates priors; computes prediction error |
| Implementation capture + `SEOChangeEvent` | ✅ | reads | reads |
| Crawl **verification** that a change is live (title / H1 / canonical / …) | ✅ (change tracking, from existing M4 crawls) | — | — |
| `SEOExperiment` container, grouping, window, extension | ✅ | attaches measurements | reads |
| Time-based states: `PENDING_PUBLICATION`, `TOO_EARLY`, `PENDING_MEASUREMENT`; structural `INCONCLUSIVE`; `CHANGE_IN_OBSERVATION_WINDOW` | ✅ | may override with evidence | — |
| Signal states: `NO_SIGNAL_YET`, `EARLY_SIGNAL`, `SEO_SIGNAL`, `MEANINGFUL_IMPACT`, `UNDERPERFORMING`, `FAILED` | ❌ never | ✅ only with measurement evidence | — |
| `after_snapshot_id` | ❌ stays `pending` | ✅ captures | — |
| Pre/post, target vs control, site trend, attribution confidence, outcome | ❌ | ✅ | — |
| Churn hold (decision held because a page is under observation) | ✅ state, applied in M6 | — | calibrates hold lengths |
| GA4 attribution, statistical significance, causal inference | ❌ | ✅ (where possible, never "proven") | — |
| Prediction error, learned models, success scoring | ❌ | ❌ | ✅ |

**Explicitly out of M7:**
- new provider calls of any kind (Search Console, GA4, Semrush, SERP, LLM, URL Inspection);
- autonomous publishing or any website change;
- tasks;
- numeric traffic, lead or revenue forecasts;
- any reading of post-change performance to judge a change.

---

## 3. Architecture decisions

### AD-1 — When predictions are created (question 16): **D, a lifecycle rule**

The options:
- **A** (every active decision) is rejected. It produces large numbers of speculative predictions for decisions that are WAIT, MONITOR or REJECT, or that are never implemented. That is noise, and it invites anchoring on unaccepted recommendations.
- **C** (only at implementation) is too late on its own. MASTER §3/§38 order the loop PREDICT → IMPLEMENT, and §38.9 needs the *original* prediction. A prediction first computed after the change has been made — possibly weeks later, when post-change crawls already exist — risks hindsight contamination.
- **B** (accepted decisions) bounds the count to what the owner intends to do, but it alone does not freeze anything.

**Chosen (D):**
1. **Provisional prediction.** Computed for decisions with `ownerStatus = accepted` and `decision ∈ {IMPROVE, CREATE, CONSOLIDATE}`, on an explicit **tracking run** (button) only — never on render and never on acceptance itself, which is a client write. It is revisable: if its inputs change, a new provisional version supersedes it. It answers the owner's question "if I do this, what should I expect?".
2. **Committed prediction.** When the implementation is recorded, the prediction is **frozen**:
   - **Ex-ante (normal):** if a provisional prediction exists whose inputs all predate the implementation date, *that* exact document is committed.
   - **Re-derived:** if not (no provisional, or one computed from evidence captured after the implementation date), a new prediction is computed **only from evidence captured before the implementation date**. Its inputs are the before-snapshot (§7) and the latest intelligence run completed before that date. It is flagged `retroactive: true`, with confidence −1.
   - **Actual change class:** the committed prediction uses the change class the owner says was actually implemented (`changedElements`), not only the decision's `actionDetail`. If the two differ, `implementationMatch` records it (§6.3).
3. **Experiment prediction.** When several changes form one experiment (§8), an experiment-level prediction is derived deterministically from the committed change predictions (§4.7). The experiment points to it (`predictionId`, MASTER §38.11).
4. **Immutability.** Committed predictions are never edited. Re-prediction creates a new document. Lifecycle fields (`status`, `supersededBy`, `committedTo`) are the only fields that change, and only server-side.

**Bounded count:** ≤ 1 active provisional per accepted actionable decision, ≤ 1 committed per change event, and ≤ 1 active per experiment.

### AD-2 — Where the churn guard lives (question 17): **B, inside M6 using M7 state**

- M7 **owns the state**: every open `SEOExperiment` carries a deterministic `hold` block computed by M7 — the page, the intents, the change classes, `holdUntilMs`, materiality, release reasons and verification state.
- M6 **owns the decision**: M6 already loads Firestore inputs, decides per unit, and has `reasonCodes`, `blockingConditions`, `dependencies` and owner-review lifecycle rules. A new rule row in `decisionRules` reads the active holds and turns overlapping recommendations into WAIT/MONITOR (§9). The held recommendation is preserved in a `churnHold` field.
- Rejected alternatives:
  - **A** (a guard inside M7 that "surfaces a signal") would still need M6 to change its output, so it only moves code around.
  - **C** (a shared service) adds a third component for one rule.
- **Smallest change to M6:**
  - one input collection (`seoExperiments`, open only);
  - one rule row;
  - three reason codes and one blocking condition;
  - the owner-review reset exemption described in §9.5;
  - the active holds added to M6's input fingerprint (so expiry triggers recomputation).

  No new decision type is added and no existing rule is reordered.

### AD-3 — First-class collections, not fields on M6 documents

Predictions, change events and experiments have their own identity, lifecycle and history (MASTER §38.1/38.6/38.11). M6 `decisions` documents are not modified by M7. M7 documents reference `decisionId`, and the UI joins them. This keeps M6's rules (owner may change only `ownerStatus` / `ownerNote`) and its fingerprints untouched.

### AD-4 — "Implemented" is evidence, not a status flip

A decision being accepted never implies implementation. Implementation exists only as an `SEOChangeEvent`:
- created by an explicit record action;
- carrying owner attestation;
- later crawl-verified where the change is observable.

### AD-5 — Magnitudes are ordinal in v1

`predicted_*_impact` fields hold `{direction, band, basis, note}` with bands `none | small | moderate | large | unknown`. Numeric ranges (for example "+10–30 % impressions") are reserved for M9, once calibrated. Until then they would be false precision, which MASTER §22 and §38.2 forbid.

### AD-6 — Confidence is ordinal and capped at `medium` in v1

Priors are uncalibrated until M9. A `high` prediction confidence is therefore unreachable in v1. The MASTER example "Confidence: 78%" is illustrative; numeric calibrated confidence is an M9 deliverable (§16).

### AD-7 — M7 never claims a signal

M7 sets only time-based and structural states. Every state that asserts something about performance belongs to M8 (§5.5).

---

## 4. Prediction engine (deterministic, heuristic, v1)

### 4.1 Change classes

The class comes from the M6 `actionDetail` for a provisional prediction, and from the owner-recorded `changedElements` for a committed one. A multi-class change takes the class with the largest stage-B maximum, and keeps all classes in `changeClasses[]`.

| Class | From M6 `actionDetail` | From recorded `changedElements` |
|---|---|---|
| `technical_eligibility` | `fix_eligibility` | `noindex_removed`, `robots_rule`, `canonical_tag` (self) |
| `snippet` | `improve_snippet` | only `title` and/or `meta_description` |
| `internal_linking` | `add_internal_links` | only `internal_links_added` |
| `content` | `strengthen_content` | `body_content`, `headings`, `h1` (± title/meta) |
| `intent_correction` | `rework_intent` | content elements + `intent_change: true` |
| `consolidation` | `consolidate_into_owner` | `redirect`, `canonical_tag` (to another URL), `content_merged` |
| `new_page` | `new_page` (CREATE) | `new_page_published` |
| `entity_facts` | `clarify_business_facts` | `business_facts`, `structured_data` (site) |

### 4.2 Inputs that exist today (with their source)

| Group | Factor | Source (field) | Basis |
|---|---|---|---|
| Website | Site Search Console activity (28-day totals) | `searchSnapshots[latest].data` (daily sync) | observed |
| Website | Volatility proxy — coefficient of variation of daily-snapshot impressions | `searchSnapshots` series (≥ 14 snapshots required) | inference |
| Website | Organic sessions / conversions available? | `trafficSnapshots[latest]` | observed |
| Website | Technical health — share of crawled pages with blocking diagnostics | `seoPages[].indexability/canonical/robots` | observed (crawl-derived) |
| Website | Crawl inventory size — "≥ N pages" (the crawl is capped) | latest `intelligenceRuns.report` | observed (lower bound) |
| Page | Impressions, clicks, CTR, position, query count for the target and intent | `topicIntelligence.gscCurrent.pages[]` (current period) | observed |
| Page | Indexability, canonical, robots, sitemap, structured data | `seoPages` | observed (crawl-derived) |
| Page | Inbound internal links, orphan | `seoPages.links`, `seoPages.orphan` | observed (within crawled set) |
| Page | Role, word count | `seoPages.role`, `wordCount` | inference / observed |
| Query / intent | Market demand | `topicIntelligence.semrush` (usually `not_available`) | observed / unknown |
| Query / intent | Intent type and confidence, query-family size | `searchIntents` | inference |
| Query / intent | Commercial value, decision type, decision confidence | `decisions.businessValue`, `decision`, `confidence` | from M6 |
| Recommendation | Change class(es), number of changed elements, implementation match | change event (owner_reported) | owner_reported |
| Baseline | Valid before-snapshot exists and contains the target | `baselines` (§7) | observed |

### 4.3 Explicitly unknown in v1 (recorded on every prediction as `unknownFactors[]`)

- authority proxy and referring domains / backlinks (no provider);
- page age (no publication date is stored);
- page-level historical trajectory (`topicIntelligence` keeps the latest run only);
- Google's index state and crawl activity (crawl-derived only; no URL Inspection or crawl stats);
- SERP volatility and competition, competitor movement, seasonality, algorithm-update periods, market-demand change;
- historical responsiveness to SEO changes (no completed experiments until M8);
- page authority proxy and topical authority.

**Rule:** an unknown factor is never 0. It contributes `effect: none` and, if it belongs to a **critical group**, a confidence reduction (§4.5).

### 4.4 Ranges: priors × modifiers

**Priors (days after publication; ASSUMPTION, `predictionConfig.priors`, v1):**

| Class | A first signal | B meaningful SEO signal | C meaningful business impact |
|---|---|---|---|
| technical_eligibility | 3–21 | 14–56 | 28–120 |
| snippet | 3–21 | 14–42 | 28–90 |
| internal_linking | 7–28 | 21–70 | 42–120 |
| content | 7–35 | 28–90 | 56–150 |
| intent_correction | 7–35 | 28–112 | 56–180 |
| consolidation | 7–28 | 28–112 | 56–180 |
| new_page | 3–42 | 42–120 | 90–180 |
| entity_facts | 14–56 | — (stage B `not_applicable`: no query-level SEO metric is targeted) | — (`unknown`) |

**Modifiers.** These are deterministic multipliers on the stage bounds, applied in a fixed order. Each produces a factor record `{key, value, basis, effect}`.

| # | Factor | Condition | Effect |
|---|---|---|---|
| M1 | Target visibility | ≥ the M5 impression floor and position ≤ 20 | B × 0.85 (snippet, content, internal_linking, intent_correction) |
| | | Zero impressions observed | A × 1.2, B × 1.3, C × 1.3 |
| | | GSC unavailable | no effect; critical unknown |
| M2 | Position band | 1–3 | content B magnitude `small` (ranking already top) |
| | | 4–10 | no time change |
| | | 11–20 | B × 1.1 |
| | | > 20 | B × 1.25 |
| M3 | Discoverability | Orphan, or 0 inbound internal links | A × 1.3 (content, new_page, intent_correction) |
| | | Not in sitemap | A × 1.15 |
| M4 | Eligibility of target | Not indexable / robots-blocked / canonical elsewhere, and the class is not `technical_eligibility` | prediction `status: blocked_by_eligibility` (no ranges; the blocker must be fixed first) |
| M5 | Site Search Console activity | Low (below `lowActivityImpressions`, ASSUMPTION) | A × 1.25, B × 1.25 |
| | | Unknown | critical unknown |
| M6 | Volatility proxy | High (CV > `highVolatilityCv`) | B and C upper bounds × 1.25; confidence −1 |
| | | Insufficient history | unknown, non-critical |
| M7 | Change magnitude | ≥ 3 changed elements across ≥ 2 classes | the class bound plus B upper × 1.1 |
| M8 | New page discovery | `new_page` with no internal link from an eligible page recorded | A × 1.3 |

**Rounding.** Bounds are rounded **outward** to whole days (floor the minimum, ceil the maximum), then:
- each stage has minimum ≥ 1 and maximum > minimum;
- stage A max ≤ stage B max ≤ stage C max (otherwise the later stage is raised to match);
- each range is capped at 365 days (ASSUMPTION).

Display converts to weeks ("2–5 weeks") with outward rounding. A single date is never shown or stored as a target.

### 4.5 Confidence (ordinal, capped at `medium` in v1)

```text
start = medium                                    (AD-6 cap)
−1 for each critical gap:
   no valid before-snapshot (§7)
   target visibility unknown (GSC unavailable for the intent/page)
   site Search Console activity unknown
   retroactive prediction (§3 AD-1)
   intent unclassified (M6)
   high volatility proxy
floor = low; plus weakest link with the M6 decision confidence
```

Every reduction adds a plain reason to `confidenceReasons[]`. `low` is a valid, displayed outcome, never a reason to hide the prediction.

### 4.6 Ordinal magnitudes (AD-5)

| Field | Rule (v1) |
|---|---|
| `predictedVisibilityImpact` | snippet → `none` (visibility), plus a CTR note. content / intent_correction / internal_linking at position 4–20 → `increase · moderate`. Position > 20 → `increase · small`. technical_eligibility on a blocked page with observed history → `increase · large`. consolidation → `temporary_volatility_then_increase · moderate`. new_page → `increase · unknown`. entity_facts → `unknown`. |
| `predictedRankingImpact` | Same table, expressed against the current position band (for example "toward the 1–3 band possible"). `unknown` when the position is unknown. |
| `predictedTrafficImpact` | Follows visibility one band lower when the target has observed clicks; otherwise `unknown`. Never numeric. |
| Business impact (stage C) | `measurable: false` unless `trafficSnapshots` provides organic sessions or conversions. Even then it is site-level only (page-level GA4 is deferred), noted. |

Every magnitude carries `basis: "assumption"` and the note "ordinal expectation, not a promise".

### 4.7 Experiment-level prediction (grouped changes)

The experiment prediction is derived from the committed predictions of its change events:
- per stage, min(mins) and max(maxes);
- `changeClasses` = the union;
- confidence = the minimum;
- `derivedFrom: [predictionIds]`.

Its input hash covers the member predictions, so it is deterministic.

### 4.8 Worked example (illustrative — the numbers follow from the v1 rules above, not from a hard-coded answer)

**Input:** accepted IMPROVE `strengthen_content` on a service page.
- The page has 380 impressions at position 8.2.
- The page is linked, eligible and in the sitemap.
- Site Search Console activity is known and normal; volatility history is insufficient.
- A valid before-snapshot exists. No Semrush data.

**Computation:**
- Prior `content`: A 7–35, B 28–90, C 56–150.
- M1 (visible, position ≤ 20): B × 0.85 → 23.8–76.5 → 23–77 after rounding.
- M2 (4–10): no change. M3 and M5: no effect.

**Output:**
- A **1–5 weeks** (7–35 days), B **3–11 weeks** (23–77 days), C **8–22 weeks** (56–150 days) — whole weeks rounded outward;
- visibility `increase · moderate`, traffic `increase · small`;
- confidence **medium**. Its reasons: v1 priors are uncalibrated; market demand, authority, history and SERP volatility are unknown.

---

## 5. Observation-window model

### 5.1 Start

`windowStart = publicationDate ?? implementationDate`. These are owner-reported calendar dates, stored with the business time zone and converted to UTC midnight.

| Situation | Result |
|---|---|
| Neither date given | The change event cannot be recorded. Implementation date is mandatory. |
| A date in the future | `PENDING_PUBLICATION`, no window yet. |
| `implementationDate` later than "now" | Rejected. |

### 5.2 Stage windows (from the committed prediction)

```text
A: [start + A.min, start + A.max]    first observable signal
B: [start + B.min, start + B.max]    meaningful SEO signal
C: [start + C.min, start + C.max]    meaningful business impact
```

### 5.3 End

- `observationWindowEnd = start + ceil(B.max × 1.25)`, bounded to [28, 210] days (ASSUMPTION; the tail exists because stage B is a range, not a deadline).
- `businessWindowEnd = start + C.max` (later; only used when stage C is measurable).
- `holdUntil` (churn): **major** classes (content, intent_correction, consolidation, new_page, technical_eligibility) → `start + B.max`; **moderate** classes (snippet, internal_linking) → `start + A.max`; entity_facts → `start + A.max`.

### 5.4 Extension

When a change joins an experiment late (§8.2), the end is extended. `observationWindowEnd = max(currentEnd, lateStart + ceil(lateB.max × 1.25))`, bounded by `maxExperimentSpanDays = 240` (ASSUMPTION) from the experiment start.

If the cap would be exceeded:
- the experiment becomes `INCONCLUSIVE` (structural reason `window_saturated`) and is closed;
- the late change opens a new experiment;
- both are linked.

Extensions are counted (`extensions`) and listed (`extensionHistory[]`).

### 5.5 States and who may set them

| State | Set by | Condition (all deterministic) |
|---|---|---|
| `PENDING_PUBLICATION` *(M7 lifecycle addition)* | M7 | publicationDate > now |
| `TOO_EARLY` | M7 | now < start + A.min |
| `PENDING_MEASUREMENT` *(M7 lifecycle addition; no signal claim)* | M7 | now ≥ start + A.min and M8 has not yet evaluated |
| `CHANGE_IN_OBSERVATION_WINDOW` | M7 | a late material change joined, or a site-wide change was published inside the window (also kept as `interferences[]`) |
| `INCONCLUSIVE` (structural) | M7 | window saturated; change `reverted`; verification `contradicted`; experiment superseded |
| `NO_SIGNAL_YET`, `EARLY_SIGNAL`, `SEO_SIGNAL`, `MEANINGFUL_IMPACT` | **M8 only** | with measurement evidence |
| `UNDERPERFORMING` | **M8 only** | only when now > start + B.max |
| `FAILED` | **M8 only** | only when now > observationWindowEnd, **and** measurement evidence. Never from elapsed time alone (MASTER §38.7). |
| `INCONCLUSIVE` (measurement) | M8 | measurement-based |

**Transitions M7 can perform:**

```text
PENDING_PUBLICATION ─(date reached)→ TOO_EARLY ─(A.min reached)→ PENDING_MEASUREMENT
          any open state ─(late change / site-wide change)→ CHANGE_IN_OBSERVATION_WINDOW (flag + state)
          any open state ─(reverted / contradicted / saturated)→ INCONCLUSIVE (closed)
```

**Early-warning states (M7, time-based, informational):**
- `approaching_window_end` (≥ 80 % of the window elapsed and no M8 evaluation);
- `unverified_implementation` (two crawls after publication without verification);
- `missing_baseline`.

These are flags (`warnings[]`), not states.

The UI computes the current **time phase** from stored dates (pure, no write). Persisted states change only on tracking runs.

---

## 6. Implementation capture and the change-event lifecycle

### 6.1 Lifecycle

```text
decision (M6)  ownerStatus: pending
   │ owner accepts (client write, rules: ownerStatus only)
   ▼
decision accepted ──(tracking run)──► provisional ImpactPrediction (revisable)
   │ owner implements OUTSIDE the system
   ▼
owner records implementation (form → visibilityRecordImplementation, POST, admin)
   │ validates: decision exists, accepted, actionable; dates; target page
   ▼
SEOChangeEvent created (deterministic id; owner_reported)
   ├─► before-snapshot linked (§7) or marked missing
   ├─► prediction committed (ex-ante) or re-derived (retroactive)
   ├─► experiment created / joined / extended (§8)
   └─► window starts at publication (§5)
   │ next M4 crawl + tracking run
   ▼
verification: verified | not_observed | not_verifiable | contradicted
   │ (M8, later) measurements, after-snapshot, signal states, outcome
```

### 6.2 Endpoint `visibilityRecordImplementation` (POST, `requireAdmin`, explicit action)

**Request:**

```text
businessId, decisionId                          required
implementedDate (YYYY-MM-DD)                    required
publishedDate (YYYY-MM-DD)                      optional (null = same as implementedDate)
targetUrl                                       required for page scope and for CREATE (the new URL); site scope: none
changedElements[]                               required, ≥ 1, closed enum:
    title, meta_description, h1, headings, body_content, internal_links_added,
    redirect, canonical_tag, noindex_removed, robots_rule, structured_data,
    business_facts, new_page_published, content_merged, other
intentChange (bool)                             optional
implementationMatch: full | partial | different required
deviationNote                                   required unless match = full
responsibleActor: { type: owner | contractor | agency | system, name? }   required
implementationNotes                             optional (≤ 2,000 chars)
```

**Validation.** Each failure returns a 4xx with a reason and writes nothing.
- The decision must exist, have `ownerStatus = accepted`, and have `decision ∈ {IMPROVE, CREATE, CONSOLIDATE}`. WAIT, MONITOR and REJECT cannot be "implemented".
- The dates must be valid (rules in §5.1).
- `targetUrl` must be on the business's site. For IMPROVE and CONSOLIDATE it must equal (by pageKey) the decision's recommended page, or the record is accepted with `implementationMatch` forced to at least `partial` and a deviation required.

### 6.3 `SEOChangeEvent` record

```text
seoChangeEvents/{businessId}_chg_{sha16(decisionId | targetPageKey | implementedDate)}
  changeEventId, businessId
  decisionId, opportunityIds[] (from the decision), intentId | null, scope
  targetPageKey, targetUrl                       (site scope: "site")
  changeType (class), changeClasses[], changedElements[], intentChange
  implementationDate, publicationDate, timeZone   (owner_reported)
  implementationStatus: recorded | verified | not_observed | not_verifiable | contradicted | reverted
  implementationMatch: full | partial | different, deviationNote
  responsibleActor { type, name }
  implementationNotes                            (owner-editable)
  beforeSnapshot { status: linked | missing | contaminated, baselineId, targetType, targetId, capturedAtMs, reason }
  afterSnapshot  { status: "pending", baselineId: null, reservedFor: "M8", earliestCaptureFromMs }
  predictionId (committed), experimentId
  verification { status, checkedInRunId, checks[]: { element, before, after, result }, atMs } | null
  basis: "owner_reported"
  history[] (append-only: recorded, verified, reverted, notes_edited …)
  createdAtMs, recordedBy (uid), modelVersion, configVersion
```

**Mandatory at creation:** ids, decision link, target, change classes and elements, implementationDate, implementationStatus = `recorded`, implementationMatch, responsibleActor, beforeSnapshot (linked or explicitly missing), predictionId, experimentId.

**Pending until later:**
- `publicationDate` (if unknown, set once later);
- `verification` (next crawl);
- `afterSnapshot` (M8);
- everything outcome-related (M8, in separate collections).

**Idempotency:**
- The same `(decisionId, targetPageKey, implementedDate)` produces the same id. A repeated request returns the existing event with `duplicate: true` and writes nothing.
- A genuinely different implementation (another date) creates a separate event, which then follows the grouping rules.
- A correction of a wrong date is a `reverted` mark on the old event (status only, history kept) plus a new event — never an edit of `implementationDate`.

**Revert:** the endpoint action `revert` sets `implementationStatus = reverted`. The experiment then becomes `INCONCLUSIVE` (structural) if it has no other live change, and the hold is released.

### 6.4 Crawl verification (provider-free)

On each tracking run, for change events whose publicationDate is earlier than the latest completed M4 run, the observable elements are compared between the before-snapshot (`baselines.pages[]` / `seoPages` at capture) and the current `seoPages`:

| Element | Comparison |
|---|---|
| `title` | title changed |
| `h1`, `headings` | H1 / H2 lists changed |
| `canonical_tag`, `noindex_removed`, `robots_rule` | state changed in the stated direction |
| `internal_links_added` | inbound count increased |
| `structured_data` | state or types changed |
| `new_page_published` | page fetched and indexable (crawl-derived) |
| `redirect` | finalUrl ≠ url |

**Result:**
- `verified`: every observable element is confirmed;
- `not_observed`: a stated change cannot be seen yet (a re-check follows);
- `not_verifiable`: body content, meta description (not compared in v1) and business facts are owner-reported only;
- `contradicted`: the crawl shows the opposite, for example noindex still present.

Verification is **change tracking**, not outcome. It reads no performance metric.

---

## 7. Before / after snapshots

**`baseline_snapshot_id` / before-snapshot selection.** This is deterministic. Take the most recent immutable baseline `b` that satisfies all of:
1. `b.capturedAtMs ≤ implementationDate`;
2. the intelligence run behind `b` (`b.sourceRunId`) completed ≤ implementationDate;
3. `b` contains the target: `referenceKeys.pageKeys` contains the target page, or, for CREATE, `referenceKeys.topicIds` contains the intent's topics. Site scope accepts any `b`.

The reference is stored as `{baselineId, targetType, targetId}` (the composite reference anticipated in `captureBaseline`).

**If no such baseline exists:**
- **At record time**, and only if the latest completed intelligence run finished **before** `implementationDate`, the endpoint captures a new immutable baseline through the existing `captureBaseline` (Firestore-only, provider-free) and links it as `linked`, `capturedAtRecording: true`.
- Otherwise it is `missing` (no clean pre-change state exists) or `contaminated` (only post-change data exists). The prediction records a critical gap, and M8 must treat attribution as low.

**After-snapshot.** It is `pending` at creation and never fabricated. M8 captures a new immutable baseline after `start + B.min` and attaches it. Baselines are never mutated; M7 and M8 only add references.

**Known gap (backlog):** `captureBaseline` keeps at most 100 pages, sorted by pageKey. A target page can fall outside it, which makes the before-snapshot `missing` for a reason unrelated to the change. M7 implementation should make baselines include every page referenced by an accepted decision or an open experiment (a small change to M4 baseline selection, §15).

---

## 8. Experiment grouping

### 8.1 Unit

- page scope (IMPROVE / CONSOLIDATE) → the target pageKey;
- CREATE → the new page's pageKey;
- site scope (entity_facts) → `site`.

A CONSOLIDATE that touches several pages forms its experiment on the **recommended owner** page. The merged or redirected pages are listed in `affectedPageKeys[]`, which also holds them for churn.

### 8.2 Deterministic rules

Rules are applied in the order of `publicationDate`, then `changeEventId`.

| Situation | Result |
|---|---|
| No open experiment for the unit | **New experiment**: `{biz}_exp_{sha16(unitKey | firstChangeEventId)}`. |
| Open experiment, and the new change is published ≤ `groupingWindowDays` (ASSUMPTION 14 d) after the experiment start | **Join (grouped)**. The window is recomputed from the experiment start with the experiment-level prediction (§4.7). Example: title + H1 + content + internal links within two weeks → one experiment. |
| Open experiment, published after the grouping window but before `observationWindowEnd` | **Join late**. Sets `CHANGE_IN_OBSERVATION_WINDOW` and an interference record, and extends the window (§5.4) — or saturates it, closing the experiment and opening a new one. If M6 held a decision for this page, the record also carries `churnOverride` (§9.4). |
| Open experiment and the window has ended (awaiting M8 / closed) | **New experiment**, linked as `previousExperimentId`. |
| Different page, same intent | **Separate experiments**. Each lists the other in `relatedExperimentIds` (`relation: same_intent`) for M8 attribution. |
| Site-wide change (site unit) | Its own experiment. Every page experiment that is open at its publication gets `interferences[] += {type: site_wide_change, experimentId}`. Their state is not changed (attribution note only). |
| Reverted change in a grouped experiment | Removed from `liveChangeEventIds`. If none is left → `INCONCLUSIVE` (structural). |

**No duplicates.** The experiment id derives from the unit and the first change event. A re-run recomputes the same assignment from the same ordered events (idempotent).

### 8.3 `SEOExperiment` record

```text
seoExperiments/{experimentId}
  experimentId, businessId, unit: { scope, pageKey | "site" }, affectedPageKeys[]
  intentIds[], decisionIds[], opportunityIds[]
  changeEventIds[], liveChangeEventIds[], lateChangeEventIds[]
  baselineSnapshot { baselineId, targetType, targetId } (from the first change)
  predictionId (experiment-level), memberPredictionIds[]
  startDate, observationWindowEnd, businessWindowEnd, extensions, extensionHistory[]
  timeState (M7 states, §5.5), warnings[], interferences[]
  hold { active, holdUntilMs, materiality: major|moderate, classes[], releasedBy: null | { reason, atMs } }
  ownerHoldRelease { released: bool, note, atMs } | null          (owner field)
  relatedExperimentIds[], previousExperimentId
  outcome: null, attributionConfidence: null, signalState: null    (reserved for M8, written only by M8)
  status: open | closed
  history[] (append-only), modelVersion, configVersion, lastEvaluatedAtMs, trackingRunId
```

---

## 9. Recommendation churn prevention (in M6, AD-2)

### 9.1 Definitions

- **Recent material change:** an `SEOExperiment` with `status = open`, `hold.active = true` (now < `holdUntil`), at least one change in status `recorded | verified | not_observed | not_verifiable` (not reverted or contradicted), and no owner hold release.
- **Materiality:** `major` = content, intent_correction, consolidation, new_page, technical_eligibility. `moderate` = snippet, internal_linking. `site` = entity_facts.
- **Candidate decision class:** derived from the M6 decision's `actionDetail` (§4.1), computed before the hold is applied.

### 9.2 Overlap matrix

D is the M6 decision being computed; E is the active experiment.

| Relation of D to E | D class | Result |
|---|---|---|
| D's unit is E's source decision (the implemented decision itself) | any | **MONITOR** `IMPLEMENTED_UNDER_OBSERVATION`, dependency `{experimentId, relation: under_observation}` |
| Same page, same intent | major | **WAIT** `RECENT_CHANGE_UNDER_OBSERVATION`, blocking `WAIT_FOR_OBSERVATION_WINDOW` |
| Same page, same intent | moderate | WAIT if E is major; allowed (with `RECENT_CHANGE_ON_PAGE` noted) if E is moderate **and** now > E.start + A.max of E |
| Same page, different intent | major | **WAIT** (page-level confound) |
| Same page, different intent | moderate | allowed, `RECENT_CHANGE_ON_PAGE` noted (non-blocking) |
| Different page, same intent | IMPROVE | allowed, `RELATED_EXPERIMENT_ACTIVE` noted (attribution interference for M8) |
| Different page, same intent | CREATE or CONSOLIDATE (touches E's intent or pages) | **WAIT** (would confound the experiment and the intent ownership) |
| Site-wide experiment active | page-scope D | allowed (noted) |
| Site-wide experiment active | site-scope D, same signal | **WAIT** |

A held decision keeps everything M6 computed: `churnHold = { experimentId, overlap, heldDecision, heldActionDetail, holdUntilMs, reasons }`. Its `newPageJustification`, alternatives and evidence are preserved, and the evidence adds an item referencing `seoExperiments/{id}#hold` and the change event. Nothing is destroyed or rewritten: when the hold ends, the next M6 run returns the held decision, with a history entry.

### 9.3 Where in the M6 table

The hold is applied **after** M6 has computed a unit's decision (rules 1–17 unchanged), as a final, single "hold filter" row:
- REJECT and WAIT are never changed by the hold.
- IMPROVE, CREATE, CONSOLIDATE and MONITOR are evaluated against the matrix.

CREATE selection (G5/G11) runs **after** the hold filter, so a held CREATE does not consume budget.

### 9.4 Strong reasons to override (deterministic; the decision proceeds, with `CHURN_OVERRIDE_<reason>` and the experiment interference recorded)

1. **Eligibility regression.** D is `fix_eligibility` for a blocker first observed **after** E's publication (crawl-derived). A newly broken page is always fixable.
2. **Change not in effect.** Every live change of E is `contradicted` or `reverted`, or the experiment is closed or `INCONCLUSIVE`. In that case there is nothing to protect, so the hold is not active.
3. **Owner release.** `seoExperiments.ownerHoldRelease.released = true`, with a note. This is the owner's explicit choice and is recorded as interference.
4. **Opportunity created after publication.** The M5 opportunity behind D was first detected after E's publication **and** D is a different class than E's on a different intent. This applies to same-page, different-intent moderate cases only.

### 9.5 M6 integration points (the only M6 changes M7 needs)

- **I-1. Input.** `loadInputs` reads open `seoExperiments`. The "active holds as of nowMs" `[experimentId, holdUntilMs, releasedBy, liveChangeEventIds]` are added to M6's input fingerprint, so a hold starting or expiring changes the cache identity. Time passing alone does not invalidate the cache unless a hold boundary is crossed.
- **I-2. Owner-review exemption.** M6 currently resets `accepted` → `pending` when the decision value changes. When the change is due to the decision's **own implementation** (IMPROVE → MONITOR `IMPLEMENTED_UNDER_OBSERVATION`), the owner status stays `accepted`, with a history event `implemented` and no reset. Any other change follows the existing rule.
- **I-3. Vocabulary.**
  - Reason codes: `IMPLEMENTED_UNDER_OBSERVATION`, `RECENT_CHANGE_UNDER_OBSERVATION`, `RECENT_CHANGE_ON_PAGE`, `RELATED_EXPERIMENT_ACTIVE`, `CHURN_OVERRIDE_ELIGIBILITY_REGRESSION`, `CHURN_OVERRIDE_CHANGE_NOT_IN_EFFECT`, `CHURN_OVERRIDE_OWNER_RELEASE`, `CHURN_OVERRIDE_NEW_OPPORTUNITY`.
  - Blocking condition: `WAIT_FOR_OBSERVATION_WINDOW`.
  - Dependency relations: `under_observation`, `held_by_observation`.
- **I-4.** `DECISION_CONFIG_VERSION` is bumped, and M6 tests are extended (§13).

---

## 10. API, cost governance and the run model

**Provider-free.** M7 makes no Search Console, GA4, Semrush, SERP, LLM or URL Inspection call. Every input is stored Firestore data. A predictor that would need external data is `unknown` (§4.3).

**Endpoints (POST, `requireAdmin`, explicit owner action — never on render, listener, page load, deploy or schedule):**

| Endpoint | Purpose | Writes |
|---|---|---|
| `visibilityRunTracking` | Tracking run: provisional predictions for accepted actionable decisions; crawl verification; time-state transitions; hold computation; experiment-prediction refresh. | predictions, change-event lifecycle fields, experiments, run record |
| `visibilityRecordImplementation` | Record (or `revert`) an implementation. | change event, committed or derived prediction, experiment, maybe a baseline (via the existing `captureBaseline`) |

**No scheduled tracking in v1.** Time-based phases are computed client-side for display (pure). A scheduled refresh is a backlog option (§15).

---

## 11. Cache, determinism and history

**Pure modules (planned):**
- `predictionRules.js` (prediction from an explicit input object);
- `trackingRules.js` (windows, states, grouping, holds, verification from inputs plus `nowMs`);
- `predictionConfig.js` (versioned priors and multipliers, all labelled ASSUMPTION).

None of them performs I/O or reads a clock, and all are input-order independent.

**Content-addressed predictions.**
- `impactPredictions/{biz}_pred_{unitKey}_{inputHash[0:16]}`.
- `inputHash` = hash of every input the prediction reads: decision fields, target page and intent evidence, site snapshots used, baseline reference, change event (for committed predictions), and the prediction model and config versions.
- The same inputs give the same id: no rewrite and no duplicate. Changed inputs give a new id, a new `predictionVersion` (a sequence per unit), and the previous one gets `status = superseded` (provisional only).
- Committed predictions never get superseded by input drift; only an explicit revert or re-record does that.

**Tracking-run cache boundary.** The run is a cache hit (zero writes) only when the **input fingerprint** and the **output-state fingerprint** both match the last completed run (the M6 pattern).
- **Input fingerprint** — every relevant document in full, minus the fields M7 itself writes:
  - accepted actionable decisions;
  - change events (owner fields and status);
  - experiments' owner fields;
  - the referenced baselines' ids and metadata;
  - the latest intelligence run id;
  - `seoPages` of target pages;
  - the `searchSnapshots` ids used;
  - `trafficSnapshots[latest]` id;
  - versions and config;
  - the **time-phase vector**: for each open experiment, its M7 state and hold activity at `nowMs`. Time passing changes the fingerprint only when a boundary is crossed.
- **Output-state fingerprint:** predictions (id, status), change events (id, implementationStatus, verification status), experiments (id, timeState, hold.active, status).

**Run safety (same as M6):**
- reads first, then a read-only cache check;
- a per-business lease lock `trackingRunLocks/{biz}`, shared by `visibilityRunTracking` and `visibilityRecordImplementation`, so recording and a tracking run never interleave;
- re-read under the lock;
- chunked batch writes;
- runs marked `failed` (phase and chunks) or `abandoned` on lease takeover;
- idempotent full-document writes, deterministic ids, `clean()` against undefined values.

**History and immutability:**
- Prediction content is create-only.
- Change events and experiments carry append-only `history[]`.
- Baselines stay immutable.
- No M7 write ever deletes a document. Superseded, reverted and closed records remain.

**Cross-engine consistency.** M6 reads experiments without the M7 lock (read-only, eventually consistent). A hold written by M7 is applied on the next M6 run. This is acceptable and documented: M6 never writes experiments.

---

## 12. Security model (Firestore)

| Collection | Client read | Client write | Server (Admin SDK) |
|---|---|---|---|
| `impactPredictions` | admin | **none** | create; lifecycle fields only |
| `seoChangeEvents` | admin | update **only** `implementationNotes`, `updatedAt` | create (endpoint); lifecycle and verification fields |
| `seoExperiments` | admin | update **only** `ownerHoldRelease`, `updatedAt` | create/update engine fields |
| `trackingRuns`, `trackingRunLocks` | admin (runs) / none (locks) | none | all |
| `impactObservations`, `experimentOutcomes` *(reserved for M8; not created by M7)* | admin | none | M8 only |
| `decisions` | unchanged (`ownerStatus`, `ownerNote`, `updatedAt`) | — | M6 |

No client can create or alter prediction confidence or ranges, model or config versions, implementation status, verification, time state, holds, attribution or outcome. The owner-reported facts (dates, elements, match, actor) enter only through the validated endpoint, labelled `owner_reported`.

---

## 13. Minimal UI (inspection, functional only)

Under **פעולות**:

- **On a decision row (החלטות):**
  - *Prediction* panel: provisional or committed, stages A/B/C in weeks, magnitudes (ordinal), confidence with reasons, factors and unknowns. The text says "תחזית לא מבטיחה תוצאה".
  - *Record implementation* button. It appears only when the decision is accepted and actionable, and opens a form (§6.2).
  - Held decisions show "מוחזק: שינוי קודם בדף נמצא במעקב עד <date>", plus the held recommendation and the override reasons.
- **New tab מעקב שינויים:**
  - Change events: target, elements, dates, actor, match, verification, before-snapshot status, after-snapshot "pending (M8)", notes (editable).
  - Experiments: unit, member changes, window bar with stage ranges, time state, warnings, interferences, hold, and the owner "release hold" action with a note.
  - A *Run tracking* button.
  - No signal or outcome is shown in M7: "measurement starts in M8".

All function calls are button handlers; the existing no-call-on-render test covers the new pages.

---

## 14. Test strategy (to be implemented with M7)

Tests use the index-enforcing fake Firestore, are deterministic, and make no network calls.

**Prediction:**
- same input → same prediction id and content; input order does not change it;
- every relevant input changed recomputes (mutation tests in the style of the M6 cache tests);
- every unknown factor is listed and never 0;
- confidence is reduced per critical gap and never `high` in v1;
- every stage has min < max, A ≤ B ≤ C, values are whole days, and no single date appears in any field;
- stages A, B and C stay separate;
- `prediction model/config versions` are stored;
- `blocked_by_eligibility` for a non-technical change on an ineligible page;
- a retroactive prediction uses only pre-implementation inputs (a fixture with post-implementation crawl data proves it is ignored) and is flagged.

**Change events:**
- accepting a decision creates no change event and no committed prediction;
- recording creates exactly one deterministic event;
- a duplicate request is idempotent (`duplicate: true`, zero writes);
- non-accepted, non-actionable and future-dated requests are rejected and write nothing;
- before-snapshot selection covers: linked, captured at recording (only when clean), missing, contaminated;
- the after-snapshot stays `pending`;
- owner notes are preserved, and the client can edit only notes;
- revert → structural `INCONCLUSIVE` and hold released;
- verification covers verified, not_observed, not_verifiable and contradicted for each observable element.

**Observation windows:**
- the window is dynamic per class and modifiers;
- the cap and minimum are applied;
- the transition sequence `PENDING_PUBLICATION → TOO_EARLY → PENDING_MEASUREMENT` follows time;
- M7 can never set NO_SIGNAL_YET … FAILED (a guard test over all M7 writers);
- no premature FAILED or UNDERPERFORMING is possible;
- a late change extends the window, and saturation gives INCONCLUSIVE plus a new linked experiment.

**Churn:**
- every row of the overlap matrix (§9.2);
- unrelated recommendations are not held;
- each of the four override reasons;
- a hold expiring changes M6's fingerprint and returns the held decision with history;
- the owner-review exemption applies for the decision's own implementation;
- a held CREATE consumes no G5/G11 budget;
- results are deterministic.

**Experiments:**
- the same-page title + H1 + content + links within the grouping window give one experiment;
- after the grouping window → late join and the flag;
- different page, same intent → separate experiments, related;
- site-wide change → separate experiment plus interference notes;
- no duplicate experiments on re-run;
- the experiment-level prediction is derived deterministically.

**Governance and run safety:**
- modules import no provider adapters;
- no write on render;
- a cache hit gives zero writes;
- a read failure fails closed;
- a mid-write failure marks the run `failed` and the retry repairs it;
- concurrent run and record → one proceeds, the other gets `in_progress`;
- M3–M6 documents are untouched (except M6 reading experiments);
- written documents contain no `undefined`.

---

## 15. Assumptions, open policy questions and discovered backlog

### Assumptions (explicit, to be confirmed by the owner)

| # | Assumption | Why |
|---|---|---|
| A1 | The prior table (§4.4), modifiers, caps (28–210 d window, 240 d max span, 365 d range cap), grouping window (14 d) and materiality classes are internal heuristics. | No calibrated data until M9. |
| A2 | Prediction confidence is capped at `medium` in v1. | Uncalibrated priors. |
| A3 | Only `accepted` IMPROVE, CREATE and CONSOLIDATE decisions can be implemented, so WAIT, MONITOR and REJECT are not recordable. | Clean lifecycle. |
| A4 | Owner-reported dates are calendar dates in the business time zone (Asia/Jerusalem for Hagar). | No timestamps are available from outside systems. |
| A5 | Business-impact stage C is measurable only at site level (trafficSnapshots). | No page-level GA4 yet. |
| A6 | Crawl verification compares title, H1/H2, canonical, indexability, robots, sitemap, internal links, structured data and page existence. Body text and meta description are not compared in v1. | `seoPages` stores no body text. |

### Policy questions (not invented here — owner decision before implementation)

- **P1.** Should the owner be able to record an implementation for a **pending** (not yet accepted) decision? The design says no (accept first).
- **P2.** Should the owner hold release be time-limited or permanent for the experiment? The design says permanent for that experiment, recorded as interference.
- **P3.** Should M7 auto-capture a baseline at recording when one is missing and the latest analysis is clean (§7)? The design says yes (provider-free, immutable).

### Backlog items discovered while studying the repo (added to the project backlog)

1. **Baseline page cap selects arbitrarily.** `captureBaseline` keeps the first 100 pages by pageKey (and 200 topics by topicId), so pages that matter can be missing from the before-snapshot. Fix: include every page and topic referenced by active decisions and open experiments first.
2. **No page/topic-level history.** `topicIntelligence` and `seoPages` keep only the latest run (`topicIntelligence` docs are rewritten per run). `searchSnapshots` are site-level totals plus the top 20 queries. This limits M7 (trajectory and volatility are unknown) and is a prerequisite for M8 measurement. Proposal for M8: periodic, provider-free immutable baselines, or a per-run query × page history.
3. **MASTER §41 lists M7 without ImpactPrediction**, while MASTER §38, the M6 design and this design place ImpactPrediction in M7. This PR clarifies it (§16).
4. **MASTER §40/§41 and the M6 implementation notes still say "M6 not merged / not deployed".** Updated in this PR, because M6 is live-validated.
5. **No scheduled tracking refresh.** Time-based states persist only on explicit runs; a daily provider-free refresh could be added later. This is an option, not a blocker.
6. **Date provenance.** Implementation and publication dates are owner-reported and unverifiable beyond crawl verification of the change itself. A future CMS or webhook integration (M11) could supply verified timestamps.
7. **Unresolved citation markers in MASTER.** §34.1 (Semrush v3/v4 and API-unit statements) still carries literal `cite-source-needed` markers. These are claims the §46 freshness layer requires to be sourced. Resolve them, with sources, in the next MASTER freshness pass.

---

## 16. MASTER clarifications proposed (made explicit in this PR)

1. **Stage ownership in the §38 loop.** PREDICT, IMPLEMENT (capture) and MONITOR (time-based lifecycle) belong to **M7**. MEASURE, COMPARE PREDICTION vs ACTUAL and attribution belong to **M8**. LEARN and calibration belong to **M9**.
2. **Observation-state ownership.** M7 may set only time-based and structural states (`PENDING_PUBLICATION` and `PENDING_MEASUREMENT` are lifecycle additions that make no signal claim; plus `TOO_EARLY`, `CHANGE_IN_OBSERVATION_WINDOW`, structural `INCONCLUSIVE`). Signal states are M8-only.
3. **Confidence in predictions** is ordinal in M7 v1, capped at medium. The §38.2 "78 %" example is illustrative of a calibrated (M9) output.
4. **Predicted impact magnitudes** are ordinal in M7 v1. Numeric impact ranges require M9 calibration.
5. **§41 M7** gains "ImpactPrediction (heuristic, versioned)" and "implementation capture"; M8 and M9 are unchanged.

---

## 17. ADR summary

1. Predictions follow a lifecycle (D): provisional for accepted decisions, frozen at implementation, retroactive only from pre-change evidence.
2. The churn guard lives in M6 and consumes M7 experiment state (B). There is no new decision type, and held recommendations are preserved.
3. Predictions, change events and experiments are first-class collections. M6 documents are not modified by M7.
4. Implementation is evidence (owner attestation plus crawl verification), never inferred from acceptance.
5. Magnitudes and confidence are ordinal in v1. Calibration and numbers are M9.
6. M7 never sets a signal or outcome state. M8 does, with evidence.
7. Provider-free. Every external predictor is `unknown`.
8. M6's run-safety pattern is reused: content-addressed ids, input and output-state fingerprints, lease lock, chunked idempotent writes, failed/abandoned runs.
