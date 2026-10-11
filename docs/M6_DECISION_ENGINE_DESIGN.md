# M6 — Decision Engine — Design Specification

**Status:** DESIGN, revision 2 (owner review of PR #33 applied: §R2 change log at the end) — written before any implementation. No runtime code changes accompany this document.
**Canonical parent:** `docs/MASTER.md` (§2 chain, §3 loop, §15 Entity Graph, §16 Search Topic, **§17 Search Intent, §18 Intent Ownership, §19 Cannibalization, §20 Opportunity Engine, §21 Decision Engine**, §22 Evidence & Confidence, §24 Content Family Boundaries, §27 Scale Gates, §32 Caching, §34 Governance, §38 Time-to-Impact boundary, §43 rules, §46 freshness). Where this document and MASTER differ, MASTER wins.
**Input milestone:** M5 Opportunity Engine — `docs/M5_OPPORTUNITY_ENGINE_DESIGN.md`, merged at `2fbb43d`; **live-validated on Hagar** (October 2026): a real M5 run completed, and a second identical run returned the cache-hit / no-change result with no writes.
**Repository state at design time:** `main` @ `2fbb43d`.

---

## 0. Freshness gate (MASTER §46) — re-verified 2026-10-11

| External claim M6 relies on | Source (last updated) | Status | Effect on design |
|---|---|---|---|
| Doorway abuse includes "multiple … pages targeted at specific regions or cities that funnel users to one page" | Google spam policies (2026-08-28) | CURRENT | Location-variant pages are the highest proliferation risk → guardrail G6 (§G.4) |
| Scaled content abuse: "many pages are generated for the primary purpose of manipulating search rankings and not helping users" | Google spam policies (2026-08-28) | CURRENT | CREATE is gated, budgeted per run, limited per content cluster and never produced in batches (G1–G5, G11) |
| Canonicalization: redirects and `rel=canonical` are *strong signals*, sitemap inclusion a weak signal, none mandatory | Google "consolidate duplicate URLs" (2026-07-10) | CURRENT | Signals the site declares are inputs, not outcomes |
| "Indicating a canonical preference is a hint, not a rule"; Google selects the canonical from its own signals and may choose a different page | Google "canonicalization" (2026-08-20) | CURRENT | **CONSOLIDATE is our recommendation from our evidence, never a statement of Google's selected canonical** (§G.5); implementation (redirect / canonical / merge) is a human choice and is measured later |
| No special requirements or markup for AI Overviews / AI Mode | Google AI features (2025-12-10; re-checked for M5) | CURRENT | No "AI page" decisions; GEO/entity decisions stay IMPROVE-only |

Historical SEO practice that M6 does **not** encode as rules: "one page per keyword", "one page per city", fixed word-count targets, keyword-density targets.

---

## A. Scope

M6 converts evidence-backed M5 opportunities into **explicit, explainable decisions** at the **canonical intent / page / site level**:

1. Build a persistent **SearchIntent** layer over the approved Search Universe (MASTER §17): intent type, user task, entity references, topics, query family.
2. Resolve **ownership** for each intent (MASTER §18): existing canonical owner page, candidate owners, ownership confidence, whether the owner is acceptable.
3. Assess **cannibalization** among pages for an intent, and between any proposed new page and existing pages (MASTER §19), with the canonical states.
4. Produce one **Decision** per intent (and per page / site finding outside intents): CREATE · IMPROVE · CONSOLIDATE · WAIT · MONITOR · REJECT, with confidence, reason codes, blocking conditions, alternatives considered, new-page justification and structured evidence (MASTER §21–22).
5. Enforce **content-proliferation guardrails** (§G.4) as invariants, not suggestions.
6. Let the owner accept / reject / defer decisions; preserve those choices durably.
7. Minimal inspection UI.

## B. Non-scope

- ImpactPrediction, SEOChangeEvent, SEOExperiment, observation windows, churn prevention (M7).
- Outcome measurement and attribution (M8). Learning / calibration (M9).
- Page briefs, content generation, internal-link anchor drafting, schema drafting (M11). Publishing, redirects, outreach — no execution of any kind.
- Task creation from decisions (a decision is not a task; tasks remain manual until M11 handoff).
- A full Entity Graph (MASTER §15) — M6 uses lightweight entity references only (§D.3).
- Any new external provider call (§O). Any change to M3.2 / M4 / M5 detection logic, except the one compatibility fix in §M.3.

---

## C. Decision model

### C.1 Decision unit (the core anti-proliferation choice)

A decision is made **per canonical unit**, never per query and never per opportunity:

| Scope | Unit | Typical source opportunities |
|---|---|---|
| `intent` | one SearchIntent (one or more approved topics that share one user need) | ranking_upside, ctr_upside, coverage_gap, page_not_visible, page_overlap_observed |
| `page` | one page (pageKey) | technical_blocker, internal_linking |
| `site` | one site-level signal | entity_clarity |

All active M5 opportunities that map to the same unit are folded into **one** decision (`opportunityIds[]`). 100 queries in one intent → 1 decision. 10 opportunities on one intent → 1 decision.

### C.2 Decision record (extends MASTER §21)

```text
decisions/{businessId}_{scope}_{unitKey}
  decisionId, businessId
  scope: intent | page | site
  intentId | pageKey | signalKey          // the unit
  opportunityIds[]                         // all M5 opportunities folded in
  decision: CREATE | IMPROVE | CONSOLIDATE | WAIT | MONITOR | REJECT
  actionDetail                             // sub-kind, e.g. IMPROVE:{fix_eligibility|improve_snippet|strengthen_content|rework_intent|add_internal_links|clarify_business_facts}
  confidence: high | medium | low
  confidenceReasons[]
  reasonCodes[]                            // §H.2 vocabulary
  blockingConditions[]                     // what must be true/known before acting (§H.3)
  existingOwnerPageKey, existingOwnerUrl   // null when none
  recommendedPage: { kind: existing | new_page_placeholder | none, pageKey|null, url|null }
  collision: { status, reason, pairs[] }   // §F
  newPageJustification: { evaluated, justified, distinctOn[], reason, distinctValue }   // §E.4
  cluster: { clusterId, siblingIntentIds[], parentPageKey|null, basis: inference }       // §D.6, G11
  dependencies[]: { decisionId, relation: same_cluster | blocked_by | subsumed_by }      // G11, §G.2
  consolidation: { recommendedOwnerPageKey, otherPageKeys[], basis: recommendation,
                   declaredCanonicals[] /* site's own tags, crawl-observed */,
                   googleSelectedCanonical: null /* not observed in M6 */ } | null       // §G.5
  alternativesConsidered[]: { decision, rejectedBecause[] }    // why not CREATE / why not IMPROVE …
  businessValue: { relevance, commercialValue, marketDemand, observedVisibility }  // ordinal, copied from M5 factors with basis
  estimatedEffort, estimatedValue          // ordinal + basis (from M5; no new numbers)
  evidence[]                               // M5 evidence ids + ownership/cannibalization evidence (§H.1)
  basis: "recommendation"                  // the decision itself is RECOMMENDATION (MASTER §22)
  ownerStatus: pending | accepted | rejected | deferred      // OWNER field
  ownerNote
  engineState: active | superseded
  decisionHistory[] (capped, append-only): { decision, confidence, at, decisionRunId, reasonCodes }
  firstDecidedAtMs, lastEvaluatedAtMs, decisionRunId, sourceOpportunityRunId, intelligenceRunId, baselineId
  impactInputs                             // passed through from M5 for M7 — no prediction
  modelVersion, configVersion
```

Decision meanings (MASTER §3, §21):

| Decision | Meaning in M6 |
|---|---|
| CREATE | A **new page** is justified for an intent that has no acceptable owner and passes every CREATE gate (§G.3). Never a URL, slug or content brief — only a placeholder bound to the intent. |
| IMPROVE | Act on an **existing** page (or site-wide facts). Default whenever an acceptable owner exists (MASTER §18). |
| CONSOLIDATE | Based on **our** evidence, two or more existing pages compete for the same intent (high / duplicate collision); we recommend one page as the intended owner. This is a recommendation, not a statement about which URL Google has selected as canonical (§G.5). Implementation (merge / redirect / canonical tag) is a human choice. |
| WAIT | Not enough evidence to decide safely (missing intent, ownership, demand, data, or a CREATE gate blocked by missing data). |
| MONITOR | Something is observed but not actionable yet (e.g. potential collision, early/low visibility); re-evaluate on later runs. |
| REJECT | Do not act: owner rejected, topic no longer approved, evidence contradicts the opportunity, or nothing needs doing (`reasonCodes: NO_ACTION_NEEDED`). |

---

## D. SearchIntent model

### D.1 Record

```text
searchIntents/{businessId}_{anchorTopicId}
  intentId, businessId
  anchorTopicId                // stable id anchor (see D.4)
  topicIds[], queryFamilyIds[] // M3.2 topics == query families today
  queryCount, sampleQueries[]
  intentType                   // MASTER §17 taxonomy (D.2)
  secondaryIntentTypes[]
  intentBasis: inference       // always inference in M6 v1
  intentEvidence[]             // which modifiers/fields produced the type
  userTask: { verb, object, qualifiers{ geography?, audience?, priceSensitivity? }, basis: inference }
  entityRefs[]                 // D.3
  clusterId                    // D.6 — broader content cluster (inference)
  ownership { status, primaryOwnerPageKey, candidates[], confidence, acceptable, reasons[] }   // §E
  cannibalization { status, reason, pairs[] }                                              // §F
  businessValue { relevance, commercialValue, marketDemand, observedVisibility }           // from M5 (ordinal + basis)
  status: active | superseded  // superseded when its topics are no longer approved
  lastEvaluatedAtMs, decisionRunId, modelVersion, configVersion
```

### D.2 Intent type (rule-based, deterministic, **inference**)

Inputs: M3.2 `preliminaryIntent` and `qualificationReasons`, the topic's raw queries, confirmed services, owner geographies, brand terms. First match wins for `intentType`; other matches go to `secondaryIntentTypes`.

| Signal (any query in the family) | intentType |
|---|---|
| brand term / business name | `navigational` |
| price words (מחיר, עלות, כמה עולה, price, cost) | `pricing` |
| comparison words (השוואה, לעומת, vs, או) | `comparison` |
| review words (המלצות, ביקורות, reviews) | `review` |
| how-to words (איך, how to, מדריך, שלבים) | `how_to` |
| definition words (מה זה, מהו, מהי, what is) | `definition` |
| owner geography + confirmed service | `local` |
| commercial preliminary intent / commercial modifier + confirmed service | `commercial_investigation` |
| informational preliminary intent | `informational` |
| none | `unclassified` |

`unclassified` is a valid state; it blocks CREATE and lowers confidence (§I). An LLM classifier is **not** used in M6 v1 (§T ADR-4).

### D.3 Entity references (lightweight; not the Entity Graph)

`entityRefs[] = { id, type, label, basis }` with ids:

- `service:{serviceId}` — a confirmed Service Map item linked via `seedRefs` (observed) or qualification match (inference).
- `place:{normalizedName}` — owner-declared geography (observed) or a place in the queries (inference).
- `audience:{normalizedValue}` — owner / website-verified audience facet (observed).
- `brand:{businessId}` — brand term in queries (observed).

These ids are stable and forward-compatible with a future Entity Graph (M6 does not create entity documents). M5's `targetEntityIds[]` placeholder is filled from these refs on the decision, not on the opportunity.

### D.4 Intent grouping and identity (guardrail G4)

Default: **one SearchIntent per approved topic** (M3.2 topics are already semantic groups).

Equivalent topics are merged into one intent when **all** hold (deterministic):

- same primary `service:` entity (or both have none and share the brand), **and**
- same `intentType`, **and**
- same geography set (including "none"), **and**
- title token Jaccard ≥ 0.5 **or** ≥ 50 % of one topic's GSC queries also appear in the other's.

The 0.5 thresholds above are **internal heuristics (ASSUMPTION, `decisionConfig`)**, not values defined by Google; they are calibrated in M9.

The merged intent's id is anchored on the **lexicographically smallest topicId** in the group (`{businessId}_{anchorTopicId}`), so it is stable while that topic stays approved. If grouping changes, the old intent is marked `superseded` (never deleted) and its decision is superseded with a history entry. Merging only ever reduces the number of decision units — it is a guardrail, not a recommendation to merge topics in the Search Universe (topics stay as the owner approved them).

### D.5 User task (inference)

Structured, never free text: `{ verb, object, qualifiers }`, e.g.

- `local` / `commercial_investigation` → `{ verb: "hire", object: service:X, qualifiers: { geography: place:Y } }`
- `pricing` → `{ verb: "check_price", object: service:X }`
- `how_to` / `definition` / `informational` → `{ verb: "learn", object: service:X | topic title }`
- `comparison` → `{ verb: "compare", object: … }`
- `navigational` → `{ verb: "find_business", object: brand }`

The user task is what the **new-page justification** compares (§E.4).

### D.6 Content cluster (inference; anti-fragmentation input)

Intents that stay **distinct** after §D.4 can still belong to one broader content cluster (e.g. "kitchen design", "kitchen design prices" and "small kitchen design ideas"). M6 records this so that topic-level distinctions are not turned into independent CREATE actions:

- `clusterId` = `{businessId}_cluster_{primary service entity id}`; intents without a `service:` entity cluster under the brand (`…_cluster_brand`). Basis: inference.
- `parentPageKey` = the cluster's existing service page for that entity if one is eligible (same rules as §E.2), else null.
- Clusters are **derived, not stored as a separate collection** in M6: `clusterId` is a field on `searchIntents` and on each decision (`cluster{}`), and `decisionRuns.summary.byCluster` counts decisions per cluster.
- Clusters are an input to guardrail G11 (§G.4) and are the hand-off point for the **M11 content portfolio layer**, which will plan pages per cluster. M6 does not plan the cluster; it only prevents uncoordinated CREATEs inside one.

---

## E. Ownership model (MASTER §18)

### E.1 Candidate owner pages (per intent)

| Source | Basis |
|---|---|
| Pages observed in Search Console for the intent's queries (`topicIntelligence.gscCurrent.pages`, with per-page queries, impressions, clicks, position) | observed |
| Pages whose title/H1/H2 contain the topic title (`topicIntelligence.pages.contentMatched`) | inference |
| Pages whose role is `service` and whose title/H1 name the intent's `service:` entity (from `seoPages`) | inference |

### E.2 Per-candidate attributes (ordinal, explainable)

- `observedShare` — share of the intent's impressions on this page (observed); `clickShare` (observed); `bestPosition` (observed).
- `eligibility` — from `seoPages`: crawled in the latest run, crawl-derived indexable, canonical `valid`/`missing` (not `conflicting` / `points_elsewhere`), not robots-blocked (observed, crawl-derived — never Google's index status).
- `intentFit` — role vs intent type (inference): service page ↔ local/commercial/pricing; article ↔ how_to/definition/informational; homepage ↔ navigational (and acceptable for a single-service business); contact/about/project pages fit only navigational/brand.
- `entityFit` — title/H1/H2 name the service / place entity (inference).

### E.3 Ownership status

| Status | Rule | Basis |
|---|---|---|
| `established` | One eligible candidate holds ≥ 60 % of the intent's observed impressions | observed |
| `contested` | ≥ 2 candidates each hold ≥ 25 % observed share | observed |
| `probable` | No observed owner, but exactly one eligible candidate with intentFit + entityFit by content | inference |
| `ambiguous` | Several content candidates, none dominant | inference |
| `none` | No candidate at all | inference (crawl + GSC absence) |
| `unknown` | GSC unavailable for the intent **and** no content candidates | — |

The share thresholds (60 % / 25 %) are **internal heuristics (ASSUMPTION)**, not Google-defined values.

`ownershipConfidence`: high (established + eligible + intentFit), medium (established with a fit/eligibility gap, or probable with entityFit), low (ambiguous / contested / probable without entityFit).

**Acceptable owner** = an `established` or `probable` owner that is eligible **or** whose only problem is a fixable blocker found by M5 (then the decision is IMPROVE:fix_eligibility), **and** has `intentFit`. Homepage owning a navigational/brand intent is acceptable; homepage "owning" a specific service+place intent by default is **not** automatically acceptable — it goes to the new-page justification test (§E.4).

### E.4 New-page justification (MASTER §18, §19)

Evaluated only when CREATE is a candidate. A new page is justified only if, versus the existing owner (or the closest existing page for the same `service:` entity), at least one is **materially different** — deterministically:

| Dimension | Materially different when | Basis |
|---|---|---|
| user task | `userTask.verb` differs **and** the pair is not in the "same page can serve both" set (`hire`↔`check_price`, `hire`↔`find_business`) | inference |
| entity | different `service:` entity, or the intent's `place:` is an **owner-declared target geography** that the existing page does not cover **and** G6 passes | observed (owner) + inference |
| information requirement | intent type family differs (learn-type vs hire-type) | inference |

Stored as `newPageJustification = { evaluated, justified, distinctOn[], reason, distinctValue }`, where `distinctValue` states — in structured form — what the new page would provide that the owner cannot (e.g. `{ task: "learn", object: service:X }` vs owner `{ task: "hire", object: service:X }`). If no dimension is materially different → **not justified** → IMPROVE the existing page (reason `NEW_PAGE_NOT_JUSTIFIED_SAME_TASK`).

---

## F. Cannibalization model (MASTER §19)

### F.1 Between existing pages for one intent

For each pair of candidate pages (observed in GSC for the intent):

- `queryOverlap` — Jaccard of the queries each page received impressions for (observed).
- `shareSplit` — both pages' observed shares (observed).
- `titleSimilarity` — token Jaccard of title + H1 + H2 (inference; no full text is stored in M4 `seoPages`).
- `sameRole`, `sameEntity` (inference).
- `canonicalRelation` — one page's own `rel=canonical` tag points to the other (observed in our crawl). This is the **site's declared preference**, not Google's selected canonical.
- `serpOverlap` — **not available** (no SERP provider) → recorded as missing.

All numeric thresholds in this table and in §F.2 (Jaccard 0.3 / 0.5 / 0.6 / 0.8, shares 10 % / 25 %) are **our internal heuristics (ASSUMPTION, versioned in `decisionConfig`)**. They are **not** Google-defined cannibalization thresholds — Google publishes none — and they carry no claim about how Google evaluates the pages. They are calibrated in M9 against measured outcomes.

| State | Rule (first match) |
|---|---|
| `DUPLICATE` | canonicalRelation, **or** titleSimilarity ≥ 0.8 **and** queryOverlap ≥ 0.6 |
| `HIGH_COLLISION` | both shares ≥ 25 % **and** queryOverlap ≥ 0.5 **and** (sameRole **or** titleSimilarity ≥ 0.5) |
| `POTENTIAL_COLLISION` | second page share ≥ 10 % **and** queryOverlap ≥ 0.3 |
| `RELATED_BUT_DISTINCT` | several pages observed but queryOverlap < 0.3, **or** different `service:`/`place:` entity per page |
| `NO_COLLISION` | one observed page, or none |

The intent's status is the most severe pair. `collision.reason` is a structured string listing the metrics that triggered it. Without SERP data the most severe state reachable on inference alone is `HIGH_COLLISION`; `DUPLICATE` requires a declared canonical relation or both strong overlaps. No state in this model asserts what Google has done with the pages.

### F.2 Between a proposed new page and existing pages (CREATE gate)

Before any CREATE, the proposed intent signature (`service:` + `place:` + `intentType` + `userTask.verb`) is compared with **every active intent's owner** and every service page:

- Same `service:` + same `place:` + same task family as an existing owner → `HIGH_COLLISION` → CREATE blocked → IMPROVE that owner.
- Same `service:` + task family, different `place:` → `POTENTIAL_COLLISION` (location variant) → CREATE blocked unless G6 passes.
- Title token Jaccard ≥ 0.5 (internal heuristic) with any existing page title → `POTENTIAL_COLLISION` → CREATE blocked.
- Otherwise `RELATED_BUT_DISTINCT` / `NO_COLLISION`.

Every new-page recommendation therefore carries `existing_owner_page`, `collision_status`, `collision_reason` and `why_new_page_is_or_is_not_justified` (MASTER §19).

---

## G. Decision rules

### G.1 Intent-scope decision table (evaluated in order; first match wins)

| # | Condition | Decision | actionDetail / key reason codes |
|---|---|---|---|
| 1 | Owner rejected **all** folded opportunities | REJECT | `OWNER_REJECTED` |
| 2 | No intent topic is still approved | REJECT (superseded) | `TOPIC_NO_LONGER_APPROVED` |
| 3 | Intelligence data unavailable for the intent (GSC `not_available` and no candidates) | WAIT | `MISSING_VISIBILITY_DATA` |
| 4 | Cannibalization `DUPLICATE` or `HIGH_COLLISION` among existing pages (per our evidence) | CONSOLIDATE (recommendation, §G.5) | recommended owner = strongest eligible candidate (share → clicks → position → intentFit); `COLLISION_HIGH`/`COLLISION_DUPLICATE`; blocking: `HUMAN_REVIEW_REQUIRED` |
| 5 | Cannibalization `POTENTIAL_COLLISION` | MONITOR | `COLLISION_POTENTIAL`; blocking: `NEEDS_SERP_OVERLAP_OR_MORE_DATA` |
| 6 | Acceptable owner exists and it has an M5 technical blocker | IMPROVE | `fix_eligibility`; `OWNER_HAS_BLOCKER`; blocking: `CONFIRM_BLOCKER_UNINTENDED` |
| 7 | Acceptable owner exists and M5 found ranking / CTR upside | IMPROVE | `strengthen_content` / `improve_snippet`; `OWNER_ESTABLISHED`; alternative CREATE rejected: `EXISTING_OWNER` |
| 8 | Acceptable `probable` owner with no observed visibility (M5 `page_not_visible`) and intent classified | IMPROVE | `rework_intent`; `OWNER_PROBABLE_NO_VISIBILITY` |
| 9 | Acceptable owner exists and nothing to improve | REJECT | `NO_ACTION_NEEDED` |
| 10 | Owner exists but **not** acceptable (intent/entity mismatch) and new-page justification **passes** and all CREATE gates (§G.3) pass | CREATE | `NEW_PAGE_JUSTIFIED_*`; `existing_owner_page` recorded |
| 11 | Owner exists but not acceptable, justification fails | IMPROVE | `rework_intent` on the owner; `NEW_PAGE_NOT_JUSTIFIED_SAME_TASK` |
| 12 | No owner (`none`) and a related page for the same `service:` exists whose task family matches | IMPROVE | `strengthen_content` on that page (add the missing angle); `EXTEND_RELATED_PAGE` |
| 13 | No owner and all CREATE gates pass | CREATE | `NO_OWNER_GATES_PASSED` |
| 14 | No owner and a CREATE gate fails **because of missing data** | WAIT | gate-specific (`MISSING_MARKET_DEMAND`, `INTENT_UNCLASSIFIED`, `ENTITY_UNKNOWN`) |
| 15 | No owner and a CREATE gate fails **on evidence** (collision, G6, G11, budget) | IMPROVE an existing related page **only if one exists and is eligible**; otherwise MONITOR (collision) or WAIT (G6, G11, budget) | per gate (§G.3); never IMPROVE without a target page (G10) |
| 16 | Ownership `ambiguous` / `contested` without collision ≥ potential | MONITOR | `OWNERSHIP_UNCLEAR` |
| 17 | Fallback | WAIT | `INSUFFICIENT_EVIDENCE` |

### G.2 Page- and site-scope decisions

| Source | Decision |
|---|---|
| technical_blocker on a page that owns (or is a candidate for) an approved intent | IMPROVE:fix_eligibility (blocking `CONFIRM_BLOCKER_UNINTENDED` — the system cannot know whether a noindex is deliberate). If the page is also in a CONSOLIDATE decision as the non-owner, the page decision defers to the CONSOLIDATE decision (`SUBSUMED_BY_DECISION`). |
| internal_linking on an owner page | IMPROVE:add_internal_links (sources unspecified — M11) |
| internal_linking on a page that is not an owner of any intent | MONITOR (`NOT_AN_OWNER_PAGE`) |
| entity_clarity (conflicting facts, observed) | IMPROVE:clarify_business_facts |
| entity_clarity (missing/partial, assumption-based) | IMPROVE with low/medium confidence, or MONITOR when the only evidence is assumption |

Page/site decisions never produce CREATE.

### G.3 CREATE gates (all must pass)

1. **No acceptable owner** for the intent (§E.3).
2. **New-page justification** passes when any owner/related page exists (§E.4).
3. **Proposed-page collision** is `NO_COLLISION` or `RELATED_BUT_DISTINCT` (§F.2).
4. **Intent classified** (`intentType ≠ unclassified`) and **entity known** (a `service:` entity or the brand).
5. **Value evidence** — one of the following, each kept as a **separate signal with its own label** (the M5 distinction is preserved, never merged into one "demand" number):
   - **Market demand** (Semrush, observed): the only signal that says how many people search for this in the market.
   - **Observed visibility** (Search Console, observed): impressions > 0 for the intent's queries prove that the intent **was observed for this site** — it occurs and Google showed the site for it. It **does not prove sufficient market demand** and is never relabelled as demand. When it is the only value signal: reason code `VISIBILITY_OBSERVED_NOT_DEMAND`, `missing: market_demand`, and CREATE confidence is capped at **medium**.
   - **Owner priority** (`priority` / `brand_strategic`, owner truth — MASTER §43.5).
   Zero visibility is **not** zero demand; unknown demand never blocks a priority topic, but lowers confidence.
6. **G6 location-variant gate** (see §G.4).
7. **G7 informational gate:** for learn-type intents (`how_to`, `definition`, `informational`), CREATE additionally requires market demand **or**, as the weaker substitute, observed visibility for the intent; owner priority alone is not enough. With visibility only, the decision also carries blocking condition `NEEDS_MARKET_DEMAND` (the owner confirms before acting).
8. **G11 cluster gate** (see §G.4).
9. **G5 CREATE budget** for the run not exceeded (budget may be 0).

Missing data on gates 4, 5, 7 → WAIT. Evidence-based failure on 1–3, 6, 8 → IMPROVE an existing eligible page if there is one, otherwise MONITOR / WAIT (G10). Budget overflow or budget 0 → WAIT (`CREATE_BUDGET_EXCEEDED` / `CREATE_DISABLED_BY_POLICY`).

### G.4 Content-proliferation guardrails (invariants, tested)

| ID | Invariant |
|---|---|
| G1 | **One decision per unit.** Any number of queries / opportunities in one intent → exactly one intent decision. |
| G2 | **CREATE never coexists with an acceptable owner** for the same intent; if an acceptable owner exists the decision is never CREATE. |
| G3 | **CREATE never proceeds past a collision** ≥ `POTENTIAL_COLLISION` with an existing page. |
| G4 | **Equivalent topics merge into one intent** (§D.4) before decisions. |
| G5 | **CREATE budget per run** — a **temporary, configurable safety assumption**, not an architectural constant. Resolved as `min(system default, project policy, business policy)`; current system default **3**, and policy may lower it to any value **including 0** (CREATE disabled: every would-be CREATE becomes WAIT `CREATE_DISABLED_BY_POLICY`, with the full CREATE rationale kept so nothing is lost). Policy can only lower the default, never raise it above the system ceiling in M6. Slots are filled by business value then confidence (deterministic tie-break by intentId); the rest become WAIT `CREATE_BUDGET_EXCEEDED`. The value used is recorded on `decisionRuns`. Calibration is M9. |
| G6 | **Location variants** (same service, different place) are CREATE-eligible only for **owner-declared target geographies** with market demand for that place **or**, as the weaker substitute, observed visibility for that place (labelled as visibility, not demand; confidence ≤ medium; blocking `NEEDS_MARKET_DEMAND`). When the gate fails: if an **eligible existing service page for that service** exists → IMPROVE it (add the area, `LOCATION_VARIANT_NOT_JUSTIFIED`); if **no such page exists** → **WAIT** (`LOCATION_VARIANT_NOT_JUSTIFIED` + `NO_PAGE_TO_EXTEND`, blocking `NEEDS_OWNER_GEOGRAPHY_CONFIRMATION` or `NEEDS_MARKET_DEMAND`) — never an IMPROVE pointing at nowhere and never a CREATE. Directly addresses Google's doorway-abuse policy. |
| G7 | **Learn-type pages** need market demand or (weaker) observed visibility; owner priority alone is insufficient. |
| G8 | **CREATE output is a placeholder bound to the intent** (`recommendedPage.kind = new_page_placeholder`) — never a URL, slug list, title batch, task or content brief. |
| G9 | **No side effects:** M6 writes only `searchIntents`, `decisions`, `decisionRuns` and the `decisionId` link on opportunities — no tasks, pages, content, redirects. |
| G10 | **Every IMPROVE and CONSOLIDATE targets an existing page** (`recommendedPage.kind = existing`, non-null `pageKey`) or, for site scope, the business facts. A rule that would yield IMPROVE without a target yields WAIT (`NO_PAGE_TO_EXTEND`) instead. |
| G11 | **Cluster-fragmentation guard.** Distinct intents in one content cluster (§D.6) must not become independent CREATEs. Per run, at most **one** CREATE per cluster (configurable, may be 0; ASSUMPTION). Further CREATE candidates in the same cluster become WAIT `CLUSTER_CREATE_PENDING` with `dependencies: [{ decisionId: <the cluster's CREATE>, relation: same_cluster }]`. When the cluster has a `parentPageKey`, every CREATE in it names that page and states the relation (the new page supports / is linked from the parent) in its rationale, and the alternatives list includes "IMPROVE parent page" with why it was rejected. If ≥ 2 CREATE candidates exist in one cluster, all of them carry `CLUSTER_FRAGMENTATION_RISK`. The cluster view is passed to the M11 content portfolio layer; M6 does not plan the cluster. |

### G.5 What CONSOLIDATE claims — and does not claim

- CONSOLIDATE is a **RECOMMENDATION derived from our evidence**: Search Console query overlap and impression split (observed), on-site similarity of title/H1/H2 (inference), and the site's own `rel=canonical` tags as crawled (observed — the site's *declared* preference).
- M6 **never states which URL Google has selected as canonical**, never says pages "are duplicates in Google" and never says Google "will" consolidate them. Per Google, a canonical preference is a hint, not a rule; redirects and `rel=canonical` are strong signals, but the final canonical choice is Google's.
- A Google-selected canonical can only be stated from **direct Google evidence** (e.g. URL Inspection's "Google-selected canonical"), which M6 does not have; the field `consolidation.googleSelectedCanonical` is therefore always `null` in M6 and listed in `missing[]`.
- UI and reason-code wording say "according to our data, these pages compete for the same search intent; we recommend keeping X as the main page" — never "Google sees these as duplicates".
- The recommended owner and the method (merge content / 301 redirect / canonical tag / differentiate the pages) are chosen by a human; the effect is measured in M7/M8.

---

## H. Explainability / evidence model

### H.1 Evidence

Every decision carries `evidence[]` in the M5 format (`id`, `sourceType`, `sourceRef {collection, docId, field}`, `observation`, `basis`, `capturedAtMs`):

- all evidence of the folded M5 opportunities (by reference, deduplicated by id);
- **ownership evidence** — `searchIntents/{id}#ownership` with per-candidate observed shares (observed) and fit judgements (inference);
- **cannibalization evidence** — `searchIntents/{id}#cannibalization` with the pair metrics (observed overlaps, inferred similarities);
- **intent evidence** — modifiers/fields that produced `intentType` (inference).

Basis layering per MASTER §22: OBSERVED (GSC shares, overlaps, crawl states, owner statuses) → INFERENCE (intent type, user task, fits, similarity) → ASSUMPTION (thresholds in §E–§G, labelled as such in config) → HYPOTHESIS (e.g. "consolidation will lift the owner" — stated, not asserted) → RECOMMENDATION (the decision).

### H.2 Reason codes (closed vocabulary)

`OWNER_ESTABLISHED`, `OWNER_PROBABLE_NO_VISIBILITY`, `OWNER_HAS_BLOCKER`, `OWNER_NOT_ACCEPTABLE_INTENT_MISMATCH`, `EXISTING_OWNER`, `EXTEND_RELATED_PAGE`, `NEW_PAGE_JUSTIFIED_DISTINCT_TASK`, `NEW_PAGE_JUSTIFIED_DISTINCT_ENTITY`, `NEW_PAGE_JUSTIFIED_DISTINCT_INFORMATION`, `NEW_PAGE_NOT_JUSTIFIED_SAME_TASK`, `NO_OWNER_GATES_PASSED`, `COLLISION_DUPLICATE`, `COLLISION_HIGH`, `COLLISION_POTENTIAL`, `PROPOSED_PAGE_COLLIDES`, `LOCATION_VARIANT_NOT_JUSTIFIED`, `INFORMATIONAL_NEEDS_DEMAND`, `CREATE_BUDGET_EXCEEDED`, `MISSING_MARKET_DEMAND`, `MISSING_VISIBILITY_DATA`, `INTENT_UNCLASSIFIED`, `ENTITY_UNKNOWN`, `OWNERSHIP_UNCLEAR`, `NOT_AN_OWNER_PAGE`, `SUBSUMED_BY_DECISION`, `OWNER_REJECTED`, `TOPIC_NO_LONGER_APPROVED`, `NO_ACTION_NEEDED`, `INSUFFICIENT_EVIDENCE`, `VISIBILITY_OBSERVED_NOT_DEMAND`, `NO_PAGE_TO_EXTEND`, `CREATE_DISABLED_BY_POLICY`, `CLUSTER_CREATE_PENDING`, `CLUSTER_FRAGMENTATION_RISK`.

Wording rules for reason codes: visibility codes never use the word "demand"; collision / consolidation codes say "according to our data" and never describe Google's canonical choice (§G.5).

UI maps each to one plain-Hebrew sentence (as M4/M5 do).

### H.3 Blocking conditions (closed vocabulary)

`HUMAN_REVIEW_REQUIRED`, `CONFIRM_BLOCKER_UNINTENDED`, `NEEDS_MARKET_DEMAND`, `NEEDS_SERP_OVERLAP_OR_MORE_DATA`, `NEEDS_INTENT_CLASSIFICATION`, `NEEDS_ENTITY_CONFIRMATION`, `NEEDS_OWNER_GEOGRAPHY_CONFIRMATION`, `WAIT_FOR_NEXT_ANALYSIS`.

### H.4 "Why not …?" — alternatives considered

Each decision lists the other plausible decisions and why they were rejected, e.g. IMPROVE with `alternativesConsidered: [{ decision: CREATE, rejectedBecause: [EXISTING_OWNER, NEW_PAGE_NOT_JUSTIFIED_SAME_TASK] }]`. This is how "where the correct action is IMPROVE, the decision explicitly avoids CREATE" is made visible and testable.

### H.5 Decision confidence

Weakest-link, ordinal: `confidence = min(intentConfidence, ownershipConfidence, collisionConfidence, evidenceConfidence)` where evidenceConfidence is the lowest confidence among the folded M5 opportunities that drove the rule. Each reduction contributes a reason. A CREATE is never `high` while market demand is unknown; a CREATE whose only value signal is observed visibility is at most `medium` (§G.3.5); a CONSOLIDATE is never `high` without a declared canonical relation (site's own tag) or SERP data — and even at `high` it remains our recommendation, not a statement about Google's canonical.

---

## I. Missing-data behavior

| Missing | Effect |
|---|---|
| Search Console for the intent (`not_available`) | No ownership from observation; if no content candidates → WAIT (`MISSING_VISIBILITY_DATA`); confidence −1 |
| Market demand (Semrush) | Never treated as low demand; CREATE needs another value signal (§G.3.5); learn-type CREATE → WAIT (`MISSING_MARKET_DEMAND`); CREATE confidence capped at medium |
| Intent type (`unclassified`) | CREATE → WAIT (`INTENT_UNCLASSIFIED`); IMPROVE still possible on an established owner (confidence −1) |
| Entity (no confirmed service) | CREATE → WAIT (`ENTITY_UNKNOWN`) |
| SERP overlap | Cannibalization capped below DUPLICATE without a declared canonical relation; POTENTIAL → MONITOR, not CONSOLIDATE |
| Page not crawled in latest run | Candidate eligibility `unknown`; cannot be the basis of an IMPROVE:fix_eligibility; confidence −1 |
| No baseline | Decision still made; `missing: no_baseline`; confidence −1 (measurement in M8 needs it) |
| No M5 run / stale M5 run | No decisions; run outcome `WAIT_FOR_DATA` |

Certainty is never invented: every missing input appears in `missing[]`, in `confidenceReasons`, or as a blocking condition.

---

## J. Data model / Firestore changes

| Collection | Change | Writer | Client rules |
|---|---|---|---|
| `searchIntents` | **new** (one per intent; `superseded`, never deleted) | Cloud Function (Admin SDK) | read-only |
| `decisions` | **new** (one per unit; history appended; `superseded`, never deleted) | Cloud Function | read; client may update **only** `ownerStatus`, `ownerNote`, `updatedAt` |
| `decisionRuns` | **new** (one per run; inputs hash, counts, outcomes) | Cloud Function | read-only |
| `opportunities` | existing field `decisionId` populated for engine opportunities | Cloud Function | unchanged (engine fields already protected) |

Justification for new collections (MASTER §43.1 "no parallel subsystems"): SearchIntent and Decision are distinct first-class concepts in MASTER §17 and §21 with their own identity and lifecycle (one decision folds many opportunities; one intent spans several topics). Storing them inside `opportunities` would duplicate them per opportunity and break G1. Opportunities stay the single opportunity system; decisions reference them.

No composite indexes are needed (all queries are `businessId ==` equality; ordering in memory), consistent with M4/M5.

---

## K. Deterministic decision logic

- Pure module (planned `functions/decisionRules.js`): `(approved topics, topicIntelligence, seoPages, services, owner geographies, active M5 opportunities, owner statuses, config) → { intents[], decisions[], runSummary }`. No I/O, no clock reads (time injected), stable sort orders everywhere, no randomness.
- Deterministic ids: intents `{businessId}_{anchorTopicId}`; decisions `{businessId}_{scope}_{unitKey}` (`intentId` / `pageKey` hash / `signalKey`).
- Config (planned `functions/decisionConfig.js`): every threshold in §D–§G (shares 60/25/10 %, Jaccard 0.3/0.5/0.6/0.8, CREATE budget default 3, per-cluster CREATE limit default 1, intent keyword lists), versioned (`DECISION_CONFIG_VERSION`) and labelled **ASSUMPTION — internal heuristics, not Google-defined values**. Policy overrides (project and per business) may only **lower** the CREATE budget and the per-cluster limit (to 0 included) or make gates stricter; the effective values are recorded on every `decisionRuns` document.
- Reproducibility: given the stored inputs (identified by ids + timestamps in the run's input fingerprint) and the config version, a decision recomputes identically. Tests assert byte-identical output for identical input.

**What is decided deterministically:** decision-unit construction, intent grouping (G4), ownership status from observed shares, eligibility from crawl states, collision states from overlaps/similarity thresholds (deterministic, but the thresholds themselves are heuristics), cluster assignment and the G11 limit, every gate and guardrail, decision selection, confidence aggregation, ids, history.

**What remains inference (labelled, never presented as fact):** intent type, user task, entity fit, intent fit, title similarity, "probable" ownership, new-page justification dimensions, content-cluster membership. Also: observed visibility is evidence that an intent occurs for this site — reading it as market demand would be an unlabelled inference and is not allowed.

**What remains WAIT / MONITOR by design:** potential collisions without SERP data, contested/ambiguous ownership, CREATE with missing intent/entity/demand, learn-type CREATE without demand/visibility, location variants without owner geography + evidence, internal-link findings on non-owner pages, assumption-only entity-clarity findings, CREATE overflow beyond the budget or with budget 0, second-and-later CREATE candidates in one content cluster (G11), failed location variants with no service page to extend (G6), any IMPROVE that would have no target page (G10).

**What requires M7 data:** whether a recent change is still inside its observation window (churn prevention, MASTER §38.10), change events per page, experiments grouping several decisions on one page. Until M7, M6 cannot suppress a decision because a page was just changed; it records `impactInputs` only.

**What requires M8/M9:** whether IMPROVE vs CREATE actually worked for this site; calibration of shares/Jaccard thresholds, CREATE budget, per-cluster limit and gate strictness; decision-acceptance learning (owner accepted vs rejected per reason code); empirical time-to-impact.

---

## L. Lifecycle / re-evaluation

- **Trigger:** explicit owner action ("קבלת החלטות"), after an M5 run. Never on render, deploy or listener activity. (Optionally the same button can run M5 then M6 server-side in one request — both are provider-free.)
- **Cache:** input fingerprint = M6 engine/config version + latest completed `opportunityRuns` id and inputHash + intelligence run id + baseline id + approved topics/statuses + owner statuses on engine opportunities and on decisions + `seoPages` fingerprints + confirmed services/geographies fingerprint. Identical → `cache_hit`, no writes.
- **Re-evaluation of an existing decision:**
  - same decision recomputed → update evidence/confidence, `lastEvaluatedAtMs`; `ownerStatus` untouched;
  - decision **changes** → append to `decisionHistory`; if `ownerStatus` was `accepted`/`rejected`, set it to `pending` with `ownerNote` system flag `decision_changed_since_owner_review` (the owner's previous choice stays in history; nothing is silently overwritten);
  - unit no longer exists (topic unapproved, opportunity resolved, intent superseded) → `engineState: superseded`, kept.
- **Owner rejection is durable:** a rejected decision recomputed unchanged stays rejected; rejected M5 opportunities fold into REJECT (rule 1).
- **No time-based expiry in M6.** Observation windows are M7.

---

## M. Interaction with M5

1. M6 **consumes** active engine opportunities (`source: "opportunity_engine"`, `engineState: "active"`) from the latest completed M5 run; it never re-detects, re-scores or edits them (except §M.3).
2. Business value on decisions is **copied** (ordinal + basis) from M5 factors: relevance, commercial value, market demand, observed visibility — preserving the M5 market-demand ≠ visibility distinction. No new scoring numbers.
3. **Compatibility fix required in M5 (implementation phase):** `opportunityEngineStore.js` currently writes `decisionId: null` on every update, which would erase M6's link on each M5 run. M6 implementation will change M5 to set `decisionId` only on creation (null) and leave it untouched on update. This is the only M5 change.
4. M5 candidate actions are inputs, not decisions: M6 picks one decision per unit from them and the rules above.
5. M5 opportunities that M6 folds into REJECT keep their own owner status; M6 never changes opportunity status.

## N. Interaction with M7–M9

- **M7:** reads accepted decisions → creates `SEOChangeEvent` / `SEOExperiment` / `ImpactPrediction` using `decision.impactInputs` (baseline id, target, current metrics) and `decisionId`. M6 writes none of these.
- **M8:** measures outcomes per decision against `baselineId`.
- **M9:** learns from `decisionHistory`, `ownerStatus` (acceptance) and outcomes per reason code to calibrate `decisionConfig`.
- Ids, reason codes and config versions are stable precisely so M7–M9 can join on them.

## O. API / caching / governance

- **No provider calls in M6 v1.** All inputs are already in Firestore (M3.2, M4, M5). No Semrush, Google, SERP or LLM call. M6 cannot spend money or quota.
- Considered and **deferred** (each would require a governed `runGoverned` operation and owner approval before introduction): SERP overlap for cannibalization (no provider configured; Semrush v4-first policy §34.1), LLM intent classification / semantic similarity (Anthropic, cached by input hash), GSC URL Inspection for index status.
- Analysis cache as in §L; fail closed on Firestore read failure (no partial writes before all reads succeed).
- Writes are idempotent (deterministic ids, `set`/`update`, no `add` for intents/decisions).
- Endpoint (planned): `visibilityRunDecisionEngine` (`requireAdmin`, explicit POST).

## P. UI requirements (minimal inspection UI)

Under **פעולות**, a third local tab **החלטות** (functional, not polished — final UX after M9):

- Run button ("קבלת החלטות"), last run time, counts per decision.
- List grouped by decision (CREATE, IMPROVE, CONSOLIDATE, MONITOR, WAIT, REJECT) with unit (intent title / page / site signal), confidence, owner status selector (accepted / rejected / deferred).
- Row details: intent (type, user task, entities, topics, sample queries), ownership (owner page, candidates with shares), collision (status + reason), new-page justification, alternatives considered ("למה לא דף חדש?"), blocking conditions, folded opportunities, evidence; "פרטים טכניים" for ids, codes, versions, history.
- CONSOLIDATE rows read "לפי הנתונים שלנו, הדפים האלה מתחרים על אותה כוונת חיפוש — מומלץ להשאיר את X כדף הראשי"; never a claim about Google's canonical. Visibility is labelled "נראות שנמדדה (Search Console)" and never "ביקוש".
- Cluster shown on each decision (siblings, parent page, dependencies).
- Plain Hebrew for every reason code and blocking condition; CREATE rows say explicitly that no page, URL or content is created by the system.
- No function call on render (existing static test covers new page effects).

## Q. Test strategy

Deterministic, index-enforcing fake Firestore (as M3.2–M5). Planned `functions/test/decisionEngine.test.js`:

- **Intent:** type classification per modifier class; unclassified handling; user task; entity refs; grouping of equivalent topics (G4) and non-grouping of different places/services; stable anchor id; supersede on unapproval.
- **Ownership:** established / contested / probable / ambiguous / none / unknown; eligibility from crawl states; intent fit; acceptable-owner rules (homepage + service+place intent not automatically acceptable).
- **Cannibalization:** each state from fixture pairs; DUPLICATE requires canonical relation or both strong overlaps; SERP missing recorded; proposed-page collisions (same service+place → HIGH; location variant → POTENTIAL).
- **Decision table:** every row of §G.1 and §G.2 reachable and selected.
- **Guardrails:** G1 (100 queries / 10 opportunities → 1 decision); G2 (never CREATE with acceptable owner — property test over generated fixtures); G3; G5 budget (N eligible CREATEs → budget CREATE + rest WAIT, deterministic order; budget 0 → zero CREATE, all WAIT `CREATE_DISABLED_BY_POLICY` with rationale kept; policy cannot raise the ceiling); G6 location variant (pass; fail with service page → IMPROVE that page; fail without service page → WAIT, no target); G7 learn-type; G8 no URL/slug/title on CREATE; G9 no writes outside the four collections/fields; G10 no IMPROVE/CONSOLIDATE with null target; G11 (three distinct intents in one cluster all eligible → one CREATE + two WAIT `CLUSTER_CREATE_PENDING` with `dependencies`; parent page named in rationale; per-cluster limit 0 respected).
- **Demand vs visibility:** visibility-only CREATE carries `VISIBILITY_OBSERVED_NOT_DEMAND`, `missing: market_demand`, confidence ≤ medium; no output field or text labels visibility as demand; zero visibility never yields "no demand".
- **CONSOLIDATE wording:** `googleSelectedCanonical` always null; reason/UI strings contain no claim about Google's canonical or duplicates "in Google" (string test over the Hebrew label map).
- **Explainability:** every decision has ≥ 1 reason code, evidence ids resolving to existing documents, alternatives considered for IMPROVE (incl. "why not CREATE"), new-page justification evaluated whenever CREATE was a candidate.
- **Missing data:** each row of §I.
- **Lifecycle:** cache hit with no writes; changed input recomputes; owner accepted/rejected preserved; decision change resets to pending with history; superseded units kept; M5 rerun does not erase `decisionId` (§M.3).
- **Boundary:** no provider imports/network; no `tasks`, `impactPredictions`, `seoChangeEvents`, pages; M3/M4/M5 data byte-identical after a run (except `opportunities.decisionId`).
- **Determinism:** identical inputs → identical output; input order independence.
- App: no-call-on-render test extended automatically; type check/build.

## R. Acceptance criteria

1. Every active M5 opportunity maps to exactly one active decision; every decision is one of the six outputs.
2. Decision count ≤ number of intents + pages-with-findings + site signals — never proportional to query count.
3. No CREATE where an acceptable owner exists; no CREATE past a collision ≥ potential; CREATEs per run ≤ effective budget (0 respected); ≤ per-cluster limit per content cluster; no IMPROVE/CONSOLIDATE without an existing target page.
4. Every CREATE has `existing_owner_page` (or explicit none), `collision_status`, `collision_reason`, `newPageJustification` with `distinctOn` and `distinctValue`, and a placeholder (no URL).
5. Every IMPROVE that had a CREATE candidate lists "why not CREATE".
6. Every decision is explainable: reason codes + evidence ids that resolve + confidence with reasons + blocking conditions where relevant; basis layers labelled.
7. Missing intent / ownership / demand / SERP data yields WAIT / MONITOR / lower confidence — never a confident CREATE or CONSOLIDATE. Observed visibility is never presented as market demand.
8. Owner decisions are preserved; changes are visible in history; nothing deleted.
9. Identical re-run is a cache hit with zero writes; no provider calls; reproducible from stored inputs + config version.
10. All test suites green; app builds; live Hagar run reviewed by the owner (decisions make sense for the real site).
11. CONSOLIDATE is always presented as our recommendation; nothing claims Google's selected canonical.
12. Distinct intents in one content cluster never yield more CREATEs than the per-cluster limit; the others show their dependency on the cluster's CREATE.

## S. Known limitations

- Intent typing, user task and similarity are rule-based on Hebrew/English keyword lists; Hebrew morphology is not normalized (inherited from M3.2), so some modifiers and title matches are missed.
- `seoPages` stores title/H1/H2 but not body text, so content similarity is shallow; no embeddings.
- No SERP data → cannibalization relies on GSC query overlap and on-site similarity; DUPLICATE/CONSOLIDATE certainty is limited.
- GSC query × page is capped at 1,000 rows per period in M4 (25,000 now supported — follow-up); long-tail queries may be missing from overlaps.
- Market demand is unknown for most topics (Semrush deferred) → many CREATE candidates will WAIT or carry medium confidence.
- Owner geography quality determines G6; English-only profile markets limit location intents (known M3.2 limitation).
- M6 cannot see whether a page was recently changed (M7) → it may re-recommend IMPROVE on a page just edited.
- All thresholds (shares, Jaccard, CREATE budget, per-cluster limit) are internal heuristics until M9 calibration; none is a Google-defined value.
- Content clusters are keyed on the primary service entity only; a cluster that spans services (e.g. a buyer's-guide topic across several services) is not detected in M6 and is left to the M11 portfolio layer.
- M6 has no Google-selected canonical data (no URL Inspection), so consolidation is judged on our evidence only.
- M5 is live-validated on Hagar (real run + identical cache-hit rerun); M6 calibration still depends on the volume and kind of opportunities that real runs produce.

## T. ADRs

1. **Decision unit = intent / page / site, not opportunity.** One decision folds many opportunities (G1); prevents per-keyword or per-opportunity page proliferation. MASTER §21's `opportunity_id` becomes `opportunityIds[]`.
2. **New first-class collections `searchIntents`, `decisions`, `decisionRuns`.** They are distinct MASTER concepts with their own identity and lifecycle; opportunities remain the single opportunity system and link via `decisionId`.
3. **Intent = approved topic by default; deterministic merge of equivalent topics.** Reduces units, keeps the owner's Search Universe untouched, stable ids via anchor topic.
4. **No LLM / SERP in M6 v1.** Deterministic, provider-free, reproducible; LLM classification and SERP overlap are deferred governed options that would require explicit approval.
5. **IMPROVE is the default whenever an acceptable owner exists** (MASTER §18); CREATE must pass all gates, a per-cluster limit and a per-run budget. The budget (default 3) and per-cluster limit (default 1) are **temporary, policy-lowerable safety assumptions (0 allowed)**, not architecture; M9 calibrates them.
6. **CREATE yields a placeholder, never a URL/brief.** Page specification is M11; this keeps decisions from turning into publishing batches.
7. **Location-variant gate (G6)** grounded in Google's current doorway-abuse policy (re-verified 2026-10-11).
8. **Weakest-link confidence.** A decision is only as confident as its least certain input; avoids false precision.
9. **Owner status separate from engine state; decision changes reset owner review with history.** Nothing the owner decided is silently overwritten.
10. **One M5 change only:** stop overwriting `decisionId` on update (§M.3).
11. **Visibility ≠ demand, carried into decisions.** Observed visibility proves the intent occurs for this site; it may substitute for unknown market demand only as a weaker, labelled signal with capped confidence.
12. **CONSOLIDATE is our recommendation, not Google's canonical.** Google treats canonical preferences as hints and makes the final choice; M6 has no direct Google canonical evidence and says so.
13. **Cluster-fragmentation guard (G11) with derived clusters.** Prevents distinct-but-related intents from becoming many independent CREATEs; clusters are fields (not a collection) until the M11 portfolio layer owns them.
14. **No IMPROVE without a target (G10).** When there is nothing to extend, the honest decision is WAIT.

---

## R2. Revision log

**Revision 2 — owner review of PR #33 (2026-10-11).** Not a redesign; decision rules tightened before implementation.

| # | Review point | Change |
|---|---|---|
| 1 | M5 validation status stale | Header and §S: M5 live-validated on Hagar (real run + identical cache-hit rerun). MASTER status synced. |
| 2 | CREATE budget = 3 is an assumption | G5: temporary, configurable, policy-lowerable to 0 (`CREATE_DISABLED_BY_POLICY`); effective value recorded per run; calibration in M9 (§K, ADR-5). |
| 3 | G6 fallback with no service page | G6: fail + no eligible service page → WAIT (`NO_PAGE_TO_EXTEND`), never IMPROVE to nowhere; new invariant G10. |
| 4 | Visibility ≠ demand | §G.3.5 separates market demand, observed visibility and owner priority; visibility-only → `VISIBILITY_OBSERVED_NOT_DEMAND`, confidence ≤ medium; G6/G7 wording (ADR-11). |
| 5 | Jaccard thresholds are ours | Labelled internal heuristics / ASSUMPTION, not Google-defined, in §D.4, §E.3, §F.1, §F.2, §K, §S. |
| 6 | Cluster fragmentation | §D.6 content clusters; G11 per-cluster CREATE limit with `dependencies[]` and parent-page rationale; hand-off to M11 (ADR-13). |
| 7 | CONSOLIDATE vs Google canonical | §G.5; `canonicalRelation` = site's declared tag; `googleSelectedCanonical: null`; freshness row for Google canonicalization page (2026-08-20) (ADR-12). |
