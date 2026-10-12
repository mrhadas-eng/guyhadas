# M6 — Decision Engine — Implementation Notes

**Status:** DONE — merged (`7378618`), deployed and live-validated on Hagar (October 2026). Live validation found an M4 phone-evidence defect (#36), fixed in the evidence layer (`d5d1f94`) without changing M6 semantics. *(Status line updated during the M7 design; the notes below describe the implementation as merged.)*
**Design:** `docs/M6_DECISION_ENGINE_DESIGN.md` (approved, revision 2). Where this file and the design differ, this file lists the difference under §6 *Deviations and interpretations*.
**Provider calls:** none. M6 reads and writes Firestore only (no Semrush, Search Console API, SERP, LLM or URL Inspection).

---

## 1. What was built

| Piece | File | Notes |
|---|---|---|
| Versioned configuration | `functions/decisionConfig.js` | Every threshold is labelled an internal heuristic (ASSUMPTION), not a Google value. `DECISION_ENGINE_VERSION = 1`, `DECISION_CONFIG_VERSION = 1`. Safety ceilings and policy resolution (G5 / G11). |
| Pure decision logic | `functions/decisionRules.js` | `decide(input)`: SearchIntents → ownership → cannibalization → one decision per unit → run-level CREATE selection (G11, G5). No I/O, no clock, input-order independent. |
| Run orchestration | `functions/decisionEngineStore.js` | `runDecisionEngine({ businessId, nowMs })`: read-only cache check → per-business lease lock → re-read → M5 freshness gate → compute → chunked batch writes of `searchIntents`, `decisions`, `opportunities.decisionId` → run record. See §3a. |
| HTTP endpoint | `functions/decisionEngine.js` → `visibilityRunDecisionEngine` | `requireAdmin`, POST only, explicit owner action. Registered in `functions/index.js`. |
| M5 compatibility fix | `functions/opportunityEngineStore.js` | `decisionId: null` is now written **only on creation**; updates never touch it (design §M.3). |
| Firestore rules | `firestore.rules` | `searchIntents`, `decisionRuns`: read-only for clients. `decisions`: no client create/delete; client update limited to `ownerStatus` (pending/accepted/rejected/deferred), `ownerNote`, `updatedAt`. M5 protections unchanged. |
| Minimal UI | `app/src/pages/business/BusinessDecisions.tsx`, tab **החלטות** under **פעולות** | Run button, latest run, counts, decisions grouped by decision, per-row detail (intent, user task, entities, topics, owner page, candidates, collision, justification, alternatives, dependencies, blocking conditions, evidence, technical details). Owner review selector only. |
| App data layer | `app/src/lib/firestore.ts`, `app/src/lib/functions.ts`, `app/src/types.ts` | Listeners (`listenDecisions`, `listenSearchIntents`, `listenLatestDecisionRun`), `updateDecisionReview`, `runDecisionEngine` (button only). |
| Tests | `functions/test/decisionEngine.test.js` (41 tests) + 1 new M5 regression test | Added to `functions` `npm test`. |

No new composite index: every query is `businessId ==` (ordering in memory).

## 2. Data written

- `searchIntents/{businessId}_{anchorTopicId}` — §D.1 fields + `cluster`, `ownership` (candidates with shares, eligibility, fit), `cannibalization` (pairs, `serpOverlap: "missing"`, `googleSelectedCanonical: null`, thresholds labelled as assumptions), `businessValue`, `status: active|superseded`, `supersededByIntentIds`.
- `decisions/{businessId}_{scope}_{unitKey}` — unitKey = intentId (intent scope), `sha16(pageKey)` (page), signal key (site). §C.2 fields. Owner fields `ownerStatus`, `ownerNote`; engine fields everything else; `decisionHistory` (capped at 20, append-only), `previousDecision`, `ownerStatusResetReason`.
- `decisionRuns/{businessId}_run_{inputHash[0:24]}` (deterministic per input fingerprint; a retry of the same input reuses it, `attempt` counts) — `status: running | completed | failed | abandoned`, inputHash, `outputStateHash`, outcome (`DECISIONS` | `WAIT_FOR_DATA`), effective `policy` (with sources), heuristics, ids, summary (`byDecision`, `byScope`, `byCluster`, `creates`, `createCandidates`, `created/changed/unchanged/superseded/ownerReset`, `linkedOpportunities`), `unmappedOpportunities`, `providerCalled: false`.
- `decisionRunLocks/{businessId}` — transient lease lock (created atomically, deleted on release; server-only in rules).
- `opportunities.decisionId` — the only M6 write on an M5 document.

Nothing else: no tasks, pages, content, redirects, predictions, change events or experiments (tested).

## 3. Decision logic as implemented

**Intent type** — the approved §D.2 rows in the approved order (brand → navigational; pricing; comparison; review; how_to; definition; owner geography + confirmed service → local; commercial preliminary intent / commercial modifier + confirmed service → commercial_investigation; informational preliminary intent → informational). `unclassified` stays valid and blocks CREATE. Intent confidence: explicit-word rows = high, preliminary-intent-only rows and extended types = medium, unclassified = low (always basis *inference*).

**Grouping (G4)** — union-find over approved topics; merge only when same primary service (or both brand-only), same intent type, same place set, and title Jaccard ≥ 0.5 or ≥ 50 % shared observed GSC queries. Anchor = smallest topicId.

**Ownership** — candidates from Search Console pages, content-matched pages and service-role pages naming the intent's service. Established ≥ 60 % observed share; contested ≥ 2 pages ≥ 25 %; probable = single content candidate (or single fitting / single entity-fitting one); ambiguous; none; unknown. Acceptable owner = established/probable + intent fit ≠ mismatch (a crawl blocker is a fixable problem → IMPROVE fix_eligibility). Homepage fits only navigational/place intents, or a single-service business without a place in the intent.

**Cannibalization** — pairs of observed pages (top 6): query-set Jaccard, impression shares, title/H1/H2 Jaccard, same role (not "other"), entity difference, the site's own `rel=canonical` relation. States in the approved first-match order. SERP overlap always recorded as missing.

**Decision table** — §G.1 rows 1–17 in order, §G.2 for page and site scope. CREATE candidates then go through the run-level G11 (per-cluster limit) and G5 (budget) selection, ordered by owner priority → market demand → observed visibility → confidence → intentId.

**Confidence** — weakest link of intent, ownership, collision and folded M5 opportunity confidence, then caps: unknown market demand / visibility-only CREATE ≤ medium; CONSOLIDATE without a declared canonical relation ≤ medium; no baseline ≤ medium; target page not crawled ≤ medium. Every reduction carries a reason.

**Lifecycle** — deterministic ids; cache rules in §3a. Identical input and intact output state → `cache_hit`, zero writes. Unchanged decision → engine fields refreshed, owner fields and history untouched. Changed decision → history entry (with the owner status at change); `accepted`/`rejected` reset to `pending` with `ownerStatusResetReason: "decision_changed_since_owner_review"`; `deferred` and the owner's note are kept. Vanished unit → `engineState: "superseded"` (never deleted): topics no longer approved → REJECT `TOPIC_NO_LONGER_APPROVED`; regrouped → `SUBSUMED_BY_DECISION` with a `subsumed_by` dependency on the successor.

## 3a. Run safety (PR #34 review)

**Cache = input fingerprint AND output-state fingerprint.**
- *Input fingerprint* (`semanticInput`, `FINGERPRINT_VERSION = 2`): every document `decide()` and the freshness gate read is hashed **in full** (all fields, sorted by id): `searchTopics` (queries, qualification reasons, seed refs, preliminary intent…), the latest run's `topicIntelligence` (GSC pages + per-page queries, Semrush, content matches, linked services, geography…), `seoPages` (title, H1, H2, role, canonical, indexability, robots…), `businessServices`, `businessKnowledge`, engine `opportunities` (all fields except `decisionId`), the M5 run identity (id, inputHash, intelligence run, evaluated topic ids), baseline id, owner-set decision review statuses, engine/config versions, heuristics, modifier lists and effective policy. Exclusions are deliberate and listed in the code: `opportunities.decisionId` (M6's own write), business-doc fields other than `name` / `geographicMarkets` / `decisionPolicy` (decide() reads nothing else; other processes touch that doc), and M6's own output documents. Over-inclusion costs at most an idempotent recomputation; under-inclusion would be a false "nothing changed".
- *Output-state fingerprint* (`stateFingerprint`): decisions (id, decision, engineState), intents (id, status) and opportunity links. Stored on the completed run as `outputStateHash`; a cache hit also requires the current state to equal it, so deleted/edited engine records or a partial write are repaired instead of reported as unchanged.
- The cache check runs first, read-only: an unchanged business takes no lock and writes nothing.

**Concurrency.** One run per business: `decisionRunLocks/{businessId}` is created with `create()` (atomic; fails if it exists) with a 5-minute lease (> the 120 s function timeout). A second request while the lock is live returns `decision: "in_progress"` and writes nothing. Under the lock, inputs are re-read and the cache re-checked (a concurrent identical run that just finished turns this one into a cache hit). The lock is released (deleted, only by its owner) in `finally`. An expired lease is taken over (owner re-read to confirm); the run records `tookOverLockFrom`.

**Partial writes.** All data reads happen before any data write. The run record is written `running` first; data writes are committed in batches of 400 (each batch atomic); on any failure the run is marked `failed` with `failedPhase`, `chunksCommitted`, `opsCommitted`, `totalOps` and a recovery note, the lock is released and the error is returned. If the process dies before it can mark the failure, the lease expires and the next run marks the left-over `running` record `abandoned` (`abandonedByRunId`). Every write is idempotent (deterministic ids, full-document sets, history appended only on a real change), so the next run repairs the state exactly (tested: the repaired state equals a clean run's, with no duplicated history), and a failed or partial state can never produce a cache hit. The UI shows when the latest attempt failed or is still running.

## 4. Policy (G5 / G11)

- System ceilings (= defaults): 3 CREATE per run, 1 CREATE per cluster per run.
- Project policy: `PROJECT_POLICY` in `decisionConfig.js` (null = system value).
- Business policy: `businesses/{id}.decisionPolicy = { createBudgetPerRun, createsPerClusterPerRun }` (no UI yet; set in the Firestore console).
- Effective = min(ceiling, project, business); values above the ceiling are clamped, negatives become 0. 0 disables CREATE: every would-be CREATE becomes WAIT `CREATE_DISABLED_BY_POLICY` with the rationale kept in `deferredCreate`, `newPageJustification` and `alternativesConsidered`. The effective values and their source are recorded on every `decisionRuns` document.

## 5. Tests

`node functions/test/decisionEngine.test.js` — 68 tests, all passing. They cover every item in design §Q and the implementation brief:

- intent types per rule, unclassified valid, user task, entity refs, cluster id, G4 grouping and non-grouping of different places;
- 100 queries → 1 decision; 10 opportunities → 1 decision; decision count bounded by units;
- ownership states, thresholds labelled as heuristics, homepage not an automatic owner of a service + place intent;
- every decision-table branch exercised (REJECT owner-rejected, WAIT missing visibility, CONSOLIDATE high + duplicate, MONITOR potential, IMPROVE blocker / ranking / rework, REJECT no action, CREATE, WAITs for unclassified / unknown entity / missing demand);
- G2 property test (60 generated fixtures): an acceptable owner never yields CREATE;
- G5 budget 3 and 0 (and that policy cannot raise the ceiling), G11 per-cluster 1 and 0 with `same_cluster` dependencies and the parent page named;
- G6 pass / fail-with-page → IMPROVE / fail-without-page → WAIT / undeclared place;
- visibility ≠ demand (visibility-only CREATE labelled, demand unknown, confidence ≤ medium), zero visibility ≠ zero demand, missing demand caps confidence;
- CONSOLIDATE wording, `googleSelectedCanonical` always null, declared canonical stored as a declared preference only, a forbidden-claim detector run over every decision and the UI file;
- universal invariants on every scenario: canonical decision values, explainability fields, no IMPROVE/CONSOLIDATE without an existing target (G10), CREATE placeholder only (G8), no slug/brief/task fields, no `undefined` values;
- lifecycle: cache hit with zero writes, owner rejection durable, decision change with history and owner reset, unapproved topic superseded, regrouping superseded with dependency, fail closed on read failure, stale / missing M5 run → WAIT_FOR_DATA;
- integration: real M5 run then M6 — every active opportunity folded into exactly one active decision and linked by `decisionId`;
- M5 regression: an M5 re-run after M6 linked a decision preserves `opportunities.decisionId` (also added to `opportunityEngine.test.js`);
- boundary: provider-free modules, M3/M4 data byte-identical, only `opportunities.decisionId` changes on M5 docs, no tasks/pages/content/predictions;
- determinism: identical output for identical input in reversed order;
- **cache correctness** (21 mutation tests): with ids, titles, counts and timestamps unchanged, changing a topic's query text, qualification reason, seed ref or preliminary intent; topic-intelligence page queries, market demand or content match; a page's title, H1, H2, role, canonical, indexability or robots; a service alias or facet geography; business geographies; brand terminology; an opportunity's owner status or confidence; or the business decision policy — each recomputes. Verified that the previous count/timestamp fingerprint fails 14 of them. An unrelated business field does not invalidate the cache; a deleted decision or a lost opportunity link is repaired and only then becomes a cache hit again;
- **concurrency:** two simultaneous runs → one `computed`, one `in_progress` with zero writes, exactly one run record, no duplicated history, lock released; a live foreign lock → `in_progress`, never released by the wrong owner;
- **recovery:** a failure in the second write chunk → run `failed` (phase, chunks committed), lock released, partial state; the retry reuses the same run record (`attempt: 2`), completes, and the state equals a clean run's; a crashed run (expired lease + `running` record) is taken over and recorded `abandoned`.

Other suites: `opportunityEngine` (incl. the new regression), `searchUniverse`, `serviceMapMerge`, `costControl.regression` pass. App: `npm test` (paid-run flow, no-provider-call-on-render — now 14 effects / 18 callables, page priority) and `npm run build` pass.

**Pre-existing, unrelated failure:** `searchIntelligence.test.js` test *13b quota exhausted* fails on `main` as well: it seeds usage at a fixed date (2026-10-08) while the governor's quota window uses the real clock, so the seeded calls fall outside today's window. Not changed here (unrelated functionality); logged in the backlog.

## 6. Deviations and interpretations

1. **Extended intent types** (transactional, availability, problem/solution discovery, media, research, location) never override an approved row: they become the primary type only when the approved rows leave the topic `unclassified`; otherwise they are secondary. `entity_specific` is recorded only as a secondary type (a bare service name stays `unclassified`, so it cannot become a confident CREATE). `review` maps to the task `evaluate`, and `hire ↔ evaluate` is a same-page task pair.
2. **M5 freshness gate.** M6 decides only when the latest M5 run belongs to the latest intelligence run *and* evaluated exactly the currently approved topics; otherwise it records a `WAIT_FOR_DATA` run and writes nothing else (design §I "stale M5 run"). Consequence: after approving or excluding a topic, run "זיהוי הזדמנויות" before "קבלת החלטות".
3. **Owner note preserved.** The design suggested an `ownerNote` system flag on a decision change; the owner's note is never overwritten — a separate `ownerStatusResetReason` field carries the flag, and the previous owner status is kept in the history entry.
4. **Site-scope target.** IMPROVE at site scope uses `recommendedPage.kind = "business_facts"` (G10 explicitly allows business facts as the target).
5. **Reason codes added** to the closed vocabulary: `NO_ACCEPTABLE_OWNER`, `BUSINESS_FACTS_CONFLICTING`, `BUSINESS_FACTS_MISSING`. No decision category was added.
6. **Proposed-page title check** (§F.2) skips the one page the new-page justification already found materially different (otherwise every learn-vs-hire page with an overlapping title would be blocked by the very page it was justified against). All other pages are still checked.
7. **Rule 8 with an unclassified intent** → WAIT `INTENT_UNCLASSIFIED` (rather than falling through to REJECT while an opportunity exists). **Acceptable owner + GSC unavailable + nothing actionable** → WAIT `MISSING_VISIBILITY_DATA` (rather than a confident REJECT).
8. **Page scope** folds all page-level opportunities on one page (blocker + linking) into one decision; blocker wins (`actionDetails` lists both when the page is an owner).
9. **Site scope:** conflicting facts → IMPROVE; missing signal → IMPROVE capped at medium (assumed benefit); partial non-conflict signal → MONITOR.
10. **Location variant** = any intent with both a place and a confirmed service (conservative: G6 always applies to such intents).
11. **CREATE selection order** for the budget: owner priority, then market demand, then observed visibility, then confidence, then intentId (deterministic).
12. **In-progress response.** A concurrent request returns HTTP 200 with `decision: "in_progress"` (no error), so the UI can explain it.
13. **Undefined guard:** writes pass through a `clean()` that drops `undefined` (Firestore Admin rejects it; `ignoreUndefinedProperties` is not set). Tests assert the pure output contains no `undefined`, so the guard is a backstop.

## 7. Known limitations

- Hebrew prefix letters defeat whole-token matching (`בקיסריה` ≠ `קיסריה`): a place or service named only with a prefix is not detected, so the intent may be `unclassified` or miss its place (inherited from M3.2; needs a lemmatizer).
- Intent typing, task, fit and similarity are rule-based; `seoPages` has title/H1/H2 only (no body text, no embeddings).
- No SERP data: cannibalization uses Search Console query overlap + on-site similarity; DUPLICATE needs a declared canonical or two strong overlaps.
- Market demand is unknown for most topics (Semrush deferred), so learn-type CREATE usually WAITs and other CREATEs are at most medium confidence.
- Clusters are keyed on the primary service only (no cross-service clusters; M11).
- No M7 data: a page that was just changed can be recommended again.
- Thresholds, budget and cluster limit are assumptions until M9.
- Lease takeover after a crash re-reads the lock to confirm ownership but is not transactional: two runs that both find the same *expired* lease at the same instant could both proceed. Their writes are idempotent and converge; the window exists only after a crash.
- Batches are atomic per chunk (≤ 400 operations), not across chunks; consistency across chunks comes from the failed/abandoned marking + idempotent repair, not from a single transaction.
- Firestore rules are not emulator-tested (same as M5); the rule shape mirrors the tested M5 opportunity rule.
- The UI is an inspection view (final UX after M9). Business policy has no UI yet.

## 8. Deploy (owner)

```bash
cd ~/guyhadas && git checkout main && git pull
cd functions && npm install && cd ../app && npm install && npm run build && cd ..
npx firebase-tools deploy --only functions,hosting:app,firestore:rules
```

Then on Hagar: מודיעין חיפוש (if stale) → פעולות → הזדמנויות → ״זיהוי הזדמנויות״ → פעולות → החלטות → ״קבלת החלטות״. A second click should report that nothing changed (cache hit).
