# M7 — Prediction, Change & Experiment Tracking — Implementation Notes

**`docs/MASTER.md` is canonical.** Design: `docs/M7_DESIGN.md` (approved with owner decisions P1–P3, §15). Contract: `docs/M7_IMPLEMENTATION_BRIEF.md`. This file records what was actually built, the implementation decisions, deviations, tests and the validation state.

**Status: IMPLEMENTED and TESTED on branch `feature/m7-tracking` (PR against `main`, not merged by Claude). Live Hagar validation: NOT YET PERFORMED.** It needs the owner to merge and deploy; the checklist is in §6.

---

## 1. What was built (by phase)

| Phase | Files | Content |
|---|---|---|
| 1 Prediction engine | `functions/predictionConfig.js`, `functions/predictionRules.js` | Versioned priors, modifiers M1–M8, caps, materiality, unknown-factor list, all labelled ASSUMPTION. `predict()` is pure, with three separate stage ranges in whole days, ordinal magnitudes, confidence capped at medium, explicit unknowns and an eligibility block. Also `deriveExperimentPrediction()` and the pre-change evidence filter `preChangeEvidence()`. |
| 2 Tracking rules | `functions/trackingRules.js` | Covers: <ul><li>business-time-zone dates;</li><li>request validation;</li><li>P1 `recordableDecision()`;</li><li>dynamic bounded windows;</li><li>M7-only states with a signal-state guard;</li><li>experiment grouping (grouped / late join / extension / saturation / previous), site-wide interference and same-intent links;</li><li>`holdStatusAt()`;</li><li>crawl verification;</li><li>P3 `selectBeforeSnapshot()`.</li></ul> |
| 3 Store + endpoints | `functions/trackingStore.js`, `functions/trackingEngine.js`, `functions/index.js` | `visibilityRunTracking` and `visibilityRecordImplementation` (including `action: "revert"`). Both are POST with `requireAdmin` and use the M6 run-safety pattern (§3). |
| 4 Before-snapshot | `trackingStore.js` + `functions/searchIntelligenceStore.js` | P3 order: linked, then captured from stored pre-change state, then missing or contaminated. The #39 fix is in `captureBaseline`. |
| 5 Experiments | `trackingRules.buildExperiments` + `trackingStore.planExperiments` | Deterministic recompute from all change events on every run or record. Diff-written, and `engineHash` skips unchanged documents. |
| 6 M6 churn integration | `functions/decisionRules.js`, `functions/decisionEngineStore.js`, `functions/decisionConfig.js` | Hold filter after rules 1–17 and before G11/G5. Adds the reason codes, blocking condition and dependency relations; the I-2 owner-review exemption; the I-1 hold vector in the fingerprint (fingerprint v3); and `DECISION_CONFIG_VERSION` 2. |
| 7 Security | `firestore.rules` | See design §12. Hold release cannot be withdrawn from the client (P2). |
| 8 UI | `app/src/pages/business/BusinessDecisions.tsx`, `BusinessActions.tsx`, `BusinessTracking.tsx`, `tracking/*` | Prediction panel, record-implementation form, held-decision explanation, and a new tab פעולות › מעקב שינויים. |

No new provider, no LLM, no Google/Semrush/SERP/URL Inspection call, no scheduled job, no website change and no task. No M8 measurement or M9 learning.

## 2. Normalized prediction input

`predictionRules.predict(input)` reads only:

- `decision`: the M6 view, with the effective value and action details (for a held MONITOR, the held ones);
- `change`: committed predictions only, with the recorded elements and `intentChange`;
- `target.page`: crawl states only (indexability / robots / canonical / sitemap / structured data / inbound links / orphan / role / word count);
- `visibility`: Search Console page × topic rows for the target, as `observed | zero | unknown`;
- `site`: activity band, volatility band and whether traffic is measurable;
- `intent` and `marketDemand` (stored Semrush only);
- `baseline` status, `retroactive`, `derivation`, `evidenceAsOfMs` and `sources.intelligenceRunId`.

**Identity.** `predictionId = {biz}_pred_{sha16(unitKey)}_{inputHash16}`. The `inputHash` covers the above plus the model and config versions.

**Bands, not raw numbers.** Site Search Console activity and the volatility proxy enter the hash as **bands**. A new daily snapshot in the same band therefore does not create a new prediction version (deviation D6).

## 3. Run safety and caching (same pattern as M6)

- **Cache hit only on two matches.** The input fingerprint (`trackingStore.semanticInput`) and the output-state fingerprint (`stateFingerprint`) must both equal the last completed `trackingRuns` record. A cache hit performs zero writes (tested with `failWritesAfter(0)`).
  - The input fingerprint includes a **time vector**: each experiment's phase, state, hold activity and warnings at `nowMs`. It also includes owner-originated event facts and experiment owner fields.
  - It excludes M7's own lifecycle output and volatile stamps.
- **Shared lease lock** `trackingRunLocks/{businessId}`. Tracking runs, records and reverts never interleave; a concurrent call returns `in_progress` and writes nothing.
- **Write order.** All reads happen first. Writes are chunked batches with deterministic ids.
- **Failure handling.**
  - A failure marks the run `failed`, with the phase and the chunks committed.
  - An expired lease is taken over, and a stale `running` run is marked `abandoned`.
  - The next run repairs any partial state; a partial state can never produce a cache hit.
- **Duplicate records.** A duplicate implementation is detected **before** the P1 check and before the lock. It returns `duplicate: true` with zero writes, even after M6 has turned the decision into MONITOR.
- **M6 inputs.** M6 reads `seoExperiments` without the M7 lock (read-only). The **hold vector** — status evaluated at M6's `nowMs`, `holdUntil`, release, live changes, units, intents, decisions, materiality, before-eligibility and whether stage A has passed — is part of M6's input fingerprint. Time passing re-computes M6 only when a hold boundary is crossed (tested).

## 4. Implementation decisions and deviations from the design

| # | Decision / deviation | Why |
|---|---|---|
| D1 | The implemented decision's own unit becomes **MONITOR** `IMPLEMENTED_UNDER_OBSERVATION` from any recomputed value (IMPROVE, CREATE, CONSOLIDATE, MONITOR, WAIT, REJECT NO_ACTION_NEEDED), except owner rejection and topic no longer approved. Design §9.3 says "REJECT and WAIT are never changed by the hold". | That rule is applied to *overlapping* decisions. For the source unit it conflicted with the approved requirement "the implemented decision becomes MONITOR": after the next crawl M6 may recompute WAIT or REJECT for the implemented page, which would hide the observation. The held value is kept in `churnHold`. |
| D2 | Override 4 (new opportunity after publication) is evaluated on the **same page / different intent** rows. Design §9.4 restricts it to "moderate cases", but those rows are already allowed. In practice it applies to the major row (otherwise WAIT). | As written, the override could never fire. This is the narrowest reading that gives it an effect. |
| D3 | A site-wide change adds an `interferences[]` note to open page experiments **without changing their state**. | §8.2 (specific rule) chosen over the one-line §5.5 summary. |
| D4 | The prediction lifecycle `status` (provisional / committed / superseded / withdrawn / active) is separate from `predictionState` (`ranges` / `blocked_by_eligibility`). | One field cannot carry both. |
| D5 | **ex_ante** commits the provisional document when its evidence predates the cutoff and the implemented classes equal its classes. **re_derived**: an ex-ante provisional existed but the classes differ; the new prediction uses pre-change evidence only and is *not* flagged retroactive. **retroactive**: no ex-ante provisional (`retroactive: true`, confidence −1). | Keeps the −1 penalty for real hindsight risk only. |
| D6 | Site activity and volatility are hashed as bands (§2). | Avoids a new provisional version every day. |
| D7 | The experiment-level prediction is derived from the **grouped** members. Late members extend the window from their own start date, using their own prediction. | Late changes have a different start; their ranges are not relative to the experiment start. |
| D8 | Page-scope `structured_data` maps to `snippet`, and site-scope to `entity_facts` (§4.1 lists only the site case). `other` falls back to the decision's class. | Rich-result presentation is snippet-like. |
| D9 | M2 (position band) applies to the M1 class set. M3 (sitemap) applies to every page class with a crawled target. | The design does not name the class sets for these modifiers. |
| D10 | `ownerAttestation: true` is mandatory. A `publishedDate` earlier than `implementedDate` is rejected. | The implementation prompt asks for owner attestation; the date rule is a basic sanity check. |
| D11 | The P2 release cannot be withdrawn: the rules allow only `released == true` with a note, and only on open experiments. | Durable for the experiment's lifetime, as approved. |
| D12 | When a decision is implemented on a **different page** than recommended, the record is accepted, the match is forced to at least `partial`, and a deviation note is required. The experiment unit is the page actually changed. | Design §6.2. |
| D13 | A MONITOR decision that is its own observation (`IMPLEMENTED_UNDER_OBSERVATION`) can receive a further, genuinely different implementation, using its held actionable value. | Otherwise a second change to the same page (for example, a late join) could never be recorded. |
| D14 | When the hold ends and M6 returns the held value (MONITOR → IMPROVE), the existing M6 owner-review reset applies (accepted → pending). I-2 exempts only the transition into MONITOR. | Design §9.5 I-2. After observation the recommendation is reviewed fresh. |
| D15 | A baseline captured at recording (P3 step 2) is written by `captureBaseline` before the M7 batch. If the batch then fails, an extra immutable baseline version exists, which is harmless. If a concurrent M4 run changed the stored state, the capture is not used as "before" (`contaminated`). | `captureBaseline` is M4's existing create-only path. |
| D16 | Persisted time states change only on tracking runs and records. The UI computes the current phase from the stored dates for display only. | No scheduled job in v1 (#46). |
| D17 | Experiments store stage windows as millisecond ranges (`stageWindows`) for display. The prediction itself stores days only, never a date. | "No exact date" applies to the prediction. Windows are lifecycle boundaries. |

**#39 (baseline cap), fixed here.** `captureBaseline` first includes every page and topic referenced by an owner-accepted active decision or an open experiment, plus the target passed by M7. The rest fill up to the **unchanged** caps (100 pages / 200 topics). A `selection` block records the required and excluded counts. New baselines also store H2 (10), `finalUrl`, the canonical target and the structured-data types, additively, for crawl verification. Existing immutable baselines are untouched.

## 5. Tests (all deterministic, no network)

| Suite | Tests | Covers |
|---|---|---|
| `functions/test/prediction.test.js` | 44 | <ul><li>Worked example (A 7–35 / B 23–77 / C 56–150 days).</li><li>Determinism and input-order independence.</li><li>23 mutation tests (identity, ranges or confidence change).</li><li>Bands; unknowns never 0; confidence cap and floor; stage separation and bounds; entity_facts; no dates.</li><li>Eligibility block; committed classes; class mapping; new page; business measurability; ordinal only; versions.</li><li>Experiment derivation; retroactive filter; volatility; provider- and clock-free.</li></ul> |
| `functions/test/trackingRules.test.js` | 29 | <ul><li>Time-zone dates; validation; P1; windows and holds.</li><li>The `PENDING_PUBLICATION → TOO_EARLY → PENDING_MEASUREMENT` state sequence; no premature FAILED; signal-state guard.</li><li>Grouping, late join, extension, saturation, previous, different pages, same intent, site-wide, revert, determinism.</li><li>Hold release and expiry; every verification element.</li><li>P3 linked / same-day / capture / contaminated / missing / target inclusion.</li></ul> |
| `functions/test/tracking.test.js` | 27 | Real M6 decisions on the fake Firestore: <ul><li>acceptance ≠ implementation; provisional only for accepted actionable decisions; cache hit = zero writes; recompute and supersede; withdraw;</li><li>P1 rejections; deterministic record; ex-ante commit; duplicate (also after MONITOR); retroactive; re-derived;</li><li>P3 contaminated (post-change data ignored); P3 capture; #39 cap;</li><li>CREATE URL rules; deviation;</li><li>verification and idempotency; contradicted → INCONCLUSIVE; grouping and late join; revert;</li><li>concurrency; partial-write recovery; abandoned run; held lock; fail closed;</li><li>M3–M6 documents untouched; no provider path.</li></ul> |
| `functions/test/churn.test.js` | 17 | <ul><li>Every overlap-matrix row and all four overrides.</li><li>Expiry and closed experiments; REJECT untouched; determinism.</li><li>Held CREATE takes no budget.</li><li>End to end: MONITOR, accepted status kept, unrelated decisions unaffected; M6 cache hit and hold-expiry recompute with history; P2 release survives tracking runs.</li></ul> |
| `functions/test/m7Security.test.js` | 6 | Static checks of the rule shapes for every M7 collection and the M8-reserved collections. An emulator test is tracked in #45. |

The existing suites all pass unchanged: M3.1, M3.2, M4 (including the baseline tests), M5, M6 (68 tests) and phone evidence. App: `npm test` passes (the no-call-on-render check now covers 21 callables, including `runTracking`, `recordImplementation` and `revertImplementation`), and `npm run build` succeeds.

## 6. Live Hagar validation — NOT YET PERFORMED

It requires merge and deploy by the owner:

```text
npx firebase-tools deploy --only functions,hosting:app,firestore:rules
```

No new composite index is needed: every query is an equality on `businessId`.

**Timing matters (strict P3, #44).** A change implemented on the same calendar day as the latest analysis can never get a clean before-snapshot. To validate the clean path:

- **Day N:**
  1. Run מודיעין חיפוש (analysis), then זיהוי הזדמנויות.
  2. Run קבלת החלטות.
  3. Optionally capture a baseline.
- **Day N+1 or later:**
  1. Accept a real decision, for example an IMPROVE on a service page, under פעולות › החלטות.
  2. פעולות › מעקב שינויים › **עדכון מעקב**: a provisional prediction appears on that decision (and only on accepted actionable ones).
  3. Make the change on the site. Then use **רישום ביצוע** on the decision: date = today, elements as actually changed.
     - Expect a change event, a committed prediction (`ex_ante`), an experiment (TOO_EARLY), and the before-snapshot `linked` (or captured at recording from the day-N analysis).
  4. Submit the same form again: expect "already recorded" with no writes.
  5. Run the next M4 analysis, then **עדכון מעקב**: expect verification (title / H1 etc. seen in the crawl).
  6. Run **קבלת החלטות**:
     - the implemented decision shows MONITOR "בוצע ונמצא במעקב", and your accepted status is kept;
     - an overlapping recommendation on that page/intent shows WAIT with the hold explanation, if one exists;
     - unrelated decisions are unchanged.
  7. **שחרור ההחזקה** on the experiment (with a note), then **קבלת החלטות**: the held recommendation returns. Run **עדכון מעקב** again: the release stays.

Also check that no paid or provider call happens: `apiUsage` gets no new rows from these actions.

## 7. Known limitations

- Dates are owner-reported calendar dates. Same-day changes get a contaminated before-snapshot (#44).
- Page-level history is unknown, so trajectory and responsiveness are always unknown factors (#40).
- Body text and meta description are not crawl-verified in v1 (design A6). H2 and structured-data types are verifiable only against new baselines.
- Firestore rules are checked statically, not in an emulator (#45).
- Persisted time states update only on explicit runs (#46).
- Business impact (stage C) is measurable only at site level (A5).
- All priors, modifiers, caps and windows are uncalibrated internal heuristics until M9.

## 8. Backlog

- **Fixed:** #39 (baseline cap).
- **Opened:** #44 (same-day before-snapshot), #45 (CI + rules emulator), #46 (scheduled tracking refresh).
- **Relevant and unchanged:** #40 (history, M8 prerequisite), #43 (M11 execution feeds M7 change events through the same endpoint with `responsibleActor.type = "system"`, which validation already accepts), #35, #37, #41.
