# M7 — Implementation Brief (for after design approval)

Contract for implementing `docs/M7_DESIGN.md`. Owner decisions P1–P3 are recorded in design §15: P1 accepted actionable decisions only; P2 a hold release lasts for the experiment; P3 the before-snapshot comes only from demonstrably pre-change stored evidence, and is never produced by a post-change crawl.

## Order of work (incremental; each step has passing tests before the next)

1. **Config and pure prediction.** Add `functions/predictionConfig.js` (priors, modifiers, caps and grouping window, all labelled ASSUMPTION, versioned) and `functions/predictionRules.js` (design §4). Tests: determinism, ranges, unknowns, confidence cap, separate stages, eligibility block, retroactive input filter.
2. **Pure tracking rules.** Add `functions/trackingRules.js`: windows, M7 time states, grouping, extension/saturation, holds, crawl verification (§5, §6.4, §8). Tests: every transition, a guard that M7 never sets signal states, grouping cases, verification cases.
3. **Store and endpoints.** Add `functions/trackingStore.js` with `visibilityRunTracking` and `visibilityRecordImplementation` (§6.2, §10, §11).
   - lease lock `trackingRunLocks/{biz}`;
   - input and output-state fingerprints;
   - chunked idempotent writes and failed/abandoned runs;
   - before-snapshot selection and clean capture at recording (§7);
   - revert.
4. **Firestore rules.** §12: predictions read-only; change events limited to notes; experiments limited to `ownerHoldRelease`; runs and locks server-only; reserved M8 collections denied.
5. **M6 integration (I-1 … I-4, design §9.5).**
   - `loadInputs` reads open experiments;
   - add the hold-filter row after rules 1–17 and before G5/G11;
   - add the new reason codes, blocking condition and dependency relations;
   - owner-review exemption for the decision's own implementation;
   - add active holds to the input fingerprint;
   - bump `DECISION_CONFIG_VERSION`;
   - extend M6 tests (matrix, overrides, expiry recompute, no budget use by held CREATE).
6. **M4 baseline selection (backlog item 1).** Include every page and topic referenced by accepted decisions and open experiments before the cap applies. Small; keeps baselines immutable.
7. **UI (§13).**
   - prediction panel and record-implementation form on decisions;
   - held-decision explanation;
   - מעקב שינויים tab (change events, experiments, run button, notes, hold release);
   - no call on render.
8. **Docs.** Add `docs/M7_IMPLEMENTATION_NOTES.md`, the MASTER status update, and backlog updates.

## Definition of done

- All design §14 tests pass, plus every existing suite (functions `npm test`, app `npm test` and build).
- There are no provider imports in the M7 modules.
- A cache hit performs zero writes.
- A live Hagar run covers:
  1. accept a decision;
  2. run tracking → provisional prediction;
  3. record an implementation → change event, committed prediction, experiment, before-snapshot;
  4. a second identical record → duplicate, no writes;
  5. after the next M4 crawl, the tracking run shows verification;
  6. the M6 run shows the implemented decision as MONITOR, and an overlapping decision on the same page as WAIT with the hold;
  7. owner hold release → the held decision returns on the next M6 run.
- Deploy: `npx firebase-tools deploy --only functions,hosting:app,firestore:rules` (no composite indexes expected — equality queries only; verify while implementing).
