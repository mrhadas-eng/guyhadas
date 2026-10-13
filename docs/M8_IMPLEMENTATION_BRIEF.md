# M8 — Measurement — Implementation Brief

Contract for implementing `docs/M8_DESIGN.md`, once the owner has approved it. `docs/MASTER.md` is canonical.

## Preconditions (before implementation starts)

- Owner approval of `docs/M8_DESIGN.md`, including the ASSUMPTION thresholds in §4–§7.
- #35: the Node 20 runtime is migrated before any M8 deploy (decommission on 2026-10-30).
- Recommended: #45 (CI + rules emulator), before the M8 rules ship.

## Order of work (each step has passing tests before the next)

1. **Config and pure comparison.**
   - Add `functions/measurementConfig.js`: periods, floors, bands, persistence and attribution thresholds, all ASSUMPTION and versioned.
   - Add `functions/measurementRules.js`, a pure module: checkpoint derivation from an M7 experiment, period construction, comparison measures, signal state machine, outcome classification, attribution model, prediction-vs-actual.
   - Tests: determinism, every state transition, no state before `cp_a`, no `FAILED` before window end, `insufficient_data` paths, attribution never `high` from improvement alone, timing at weekly resolution.
2. **Search Console adapter extension.**
   - Extend `googleSearchConsole.js` with filtered requests (page filters, page exclusion, the `date` dimension).
   - Register the governed operation `google.searchConsoleMeasurement` in `apiLimits.js`.
   - Tests: cache identity, cache hit at $0, fail closed, quota block, truncation flag.
3. **Store and endpoint.**
   - Add `functions/measurementStore.js` and `visibilityRunMeasurement`, following the M6/M7 run pattern:
     - lock `measurementRunLocks/{biz}`;
     - input and output-state fingerprints, with zero writes on a cache hit;
     - chunked idempotent writes, plus `failed` / `abandoned` runs.
   - Write create-only `impactObservations` and the `experimentOutcomes` summary.
   - After-snapshot via `captureBaseline` from stored state, linked on `seoChangeEvents.afterSnapshot`. No other write on M7 documents, and never `seoExperiments`.
4. **Firestore rules.**
   - `impactObservations`: server create only.
   - `experimentOutcomes`: owner `ownerNote` only.
   - Runs and locks: server-only.
   - M9 fields: server-only (M9).
   - Emulator tests if #45 has landed; static tests otherwise.
5. **UI.** The מדידה section on experiment cards (design §15), the explicit עדכון מדידה button, and the owner note. Extend the no-call-on-render test.
6. **Docs.** Add `docs/M8_IMPLEMENTATION_NOTES.md`, update the MASTER status, update the backlog.

## Definition of done

**Tests:**
- every M8 test passes, plus all existing suites (functions `npm test`, app `npm test` and build);
- M7 tests are unchanged and green;
- no M8 module writes `seoExperiments`.

**Governance:** the only provider calls are governed Search Console calls; every one is recorded in `apiUsage`; there is no GA4 call; nothing runs on render.

**Live Hagar (after M7 live acceptance):**
1. An M7 implementation, committed prediction, linked before-snapshot and open experiment exist.
2. The first checkpoint is due; the next due date shows correctly before that.
3. An explicit run creates the before / after / site-trend observations (rows in `apiUsage`).
4. A signal state (or `NO_SIGNAL_YET` / `INCONCLUSIVE`) is shown with reasons.
5. The before-vs-after comparison is visible, including the site-adjusted change.
6. Attribution confidence is shown with reasons and unknowns.
7. Prediction vs actual is recorded for the measured stage.
8. A repeated run is a cache hit with zero writes, and its Search Console calls are cache hits at $0.
9. Opening the page makes no call.
10. M9 fields are `null`.
11. M7 documents are unchanged except `afterSnapshot`.

**Not required for done:** a final outcome at `cp_end`. It arrives about 13–14 weeks after publication for content changes. Tests prove the outcome logic with fixtures, and the live outcome is checked when due.

- **Deploy (owner):** `npx firebase-tools deploy --only functions:visibilityRunMeasurement,firestore:rules,hosting:app`. This is a targeted deploy, so the Semrush V3 discovery functions are not redeployed.
