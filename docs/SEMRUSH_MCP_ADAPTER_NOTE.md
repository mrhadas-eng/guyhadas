# Semrush MCP adapter — implementation note (future work; not implemented)

**Status:** decision recorded, no code (backlog #62). Canonical source: `docs/MASTER.md` §33.1 (decisions A–M). Where this note and MASTER differ, MASTER wins.

**Why it exists.** On 2026-10-14 the owner reported that the account's Semrush units are MCP API units, with no Standard API entitlement; the V4 REST pilot call returned 403 (#61). A controlled MCP evaluation succeeded. This note fixes what a future application-side adapter must and must not do, so it can be built later without reopening the decision.

## Role

The adapter is an **evidence / enrichment provider** behind the existing provider boundary (§33).

Its primary job is single-keyword market-demand metrics for queries that already belong to qualified Search Topics. It does not generate the Search Universe.

## The adapter MUST

1. **Sit behind an application-owned service boundary.**
   - It is a server-side adapter called from Cloud Functions.
   - It is never Claude Code, or an interactive agent session, at runtime (decision M).
   - How the application authenticates to Semrush MCP is verified at implementation time against current Semrush documentation (§46 freshness gate). Nothing here assumes it.
2. **Go through `runGoverned` for every call.**
   - Cache first, with a deterministic identity: business + normalized keyword + database + month/period + provider/report version.
   - The cache is checked before anything else, and a cache hit makes $0 / 0 units.
   - It is quota-aware, uses the circuit breaker and fails closed.
   - Every call is recorded in `apiUsage` (`providerCalled`, `estimatedUnits`, `providerUnitsUsed`) with safe error diagnostics. Secrets are never logged or stored.
3. **Enforce a hard per-call unit cap from a pre-call estimate.**
   - Single-keyword metrics were observed at 10 units.
   - Row-priced reports were observed at 20 units per row (`phrase_fullsearch`) and 40 per row (`phrase_questions`).
   - The estimate for a row-priced report is `rows × rate` at the requested limit, and the call is refused when the estimate cannot be confirmed within the cap.
4. **Record actual units from the provider's response metadata** when it reports them (`usage.api_units` was present in MCP responses), and reconcile them against the estimate (#56).
5. **Map every response into the provider-neutral market-demand structure** (as `keywords.marketDemand` already does for the V4 REST pilot).
   - Fields: `keyword, country/database, month, searchVolume, keywordDifficulty, intents, competitiveDensity, cpc, numberOfResults, serpFeatures, trends, source, retrievedAt`.
   - Plus `report`, `unitsUsed` and `dataQuality`.
   - Downstream engines never see Semrush field or report names (decision L).
6. **Attach a data-quality assessment** (decisions H and I).
   - Flag: KD = 0 or missing; intent empty; volume at a bucket floor or 0; trend history shorter than 12 points; CPC 0 with non-zero competition; `NOTHING FOUND`.
   - Flagged values are kept as reported, never "corrected", and are labelled so that, for example, KD = 0 is never read as "easy to rank".
7. **Treat absence as unknown** (decision K).
   - `NOTHING FOUND`, a missing row or an empty metric is stored as `unavailable` or `null`, never as zero demand.
8. **Keep observed provider demand separate** from inferred demand, strategic relevance and measurement confidence (decision J). GSC visibility is never mixed into it.
9. **Make explicit owner-triggered calls only.**
   - No call on render, listener, page load, deploy or schedule.
   - One keyword per enrichment call, unless a batched single-keyword report is separately approved and capped.
10. **Persist only server-written evidence.** Clients can never create or change provider metrics; this matches the existing `keywords.marketDemand` rule.

## The adapter MUST NOT

1. Create, approve, merge or reject Search Topics, or decide business relevance, commercial intent, service classification or Search Universe membership (decisions E and F).
2. Run broad-match, question or related-keyword reports automatically, or treat their output as anything but **candidates** for normal qualification and owner review (decision E).
3. Make the Search Universe depend on `phrase_related` or any other single discovery report (decision E: it returned `NOTHING FOUND` for an IL seed).
4. Run domain, competitor or backlink reports as part of enrichment.
5. Retry automatically, batch silently, paginate beyond the requested limit, or expand a second layer without a new explicit owner action.
6. Overwrite owner truth, GSC evidence, discovery sources (`sources` / `sourceList`) or other providers' evidence.
7. Present Semrush figures as observed Google traffic or Search Console visibility.
8. Leak provider specifics (report names, CSV columns, unit rates) outside the adapter and its config.

## Before building (checklist)

- The owner approves the build, and the MCP-vs-REST account entitlement is confirmed on the live account.
- Re-verify the MCP report names, parameters, unit costs and authentication (§46).
- Decide the fate of the V4 REST pilot (`functions/semrushV4.js`, `semrush.enrichKeywordMetrics`). The MCP adapter should be a second implementation of the same provider-neutral operation, not a parallel data model.
- Address #55 (the M5 demand tier is relative, so a single enriched topic is always "high") before enriching more than a handful of topics.
