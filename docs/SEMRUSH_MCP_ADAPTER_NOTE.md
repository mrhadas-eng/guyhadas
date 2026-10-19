# Semrush MCP adapter — implementation note (future work; not implemented)

**Status:** decision recorded, no code (backlog #62). Canonical source: `docs/MASTER.md` §33.1 (decisions A–M). Where this note and MASTER differ, MASTER wins.

**Why it exists.** On 2026-10-14 the owner reported that the account's Semrush units are MCP API units, with no Standard API entitlement; the V4 REST pilot call returned 403 (#61). A controlled MCP evaluation succeeded. This note fixes what a future application-side adapter must and must not do, so it can be built later without reopening the decision.

## Role

The adapter is a **market evidence provider** behind the existing provider boundary (§33):

> Semrush can help us discover the market, but it cannot decide what the market means for this business.

It supports **two bounded capabilities**:

1. **Market candidate discovery.** It finds candidate queries around a seed. Output is candidate evidence for the **Market Discovery Universe**.
2. **Single-candidate / single-keyword enrichment.** It returns market-demand metrics for one known candidate or approved query.

Neither capability decides relevance, intent, service classification, membership or approval. Only qualification plus owner review moves a candidate into the **Approved Search Universe** (MASTER §33.1, §9).

The Hebrew / IL tests (2026-10-14) showed that discovery works but is noisy and sparse. Only 8 of 35 broad-match rows were relevant, 0 of 50 question rows, and the related report returned `NOTHING FOUND`. That is why discovery output is evidence, never authority.

## Common rules (both capabilities)

The adapter MUST:

1. **Sit behind an application-owned service boundary.**
   - It is a server-side adapter called from Cloud Functions.
   - It is never Claude Code, or an interactive agent session, at runtime (decision M).
   - How the application authenticates to Semrush MCP is verified at implementation time against current Semrush documentation (§46 freshness gate). Nothing here assumes it.
2. **Go through `runGoverned` for every call.**
   - Cache first, with a deterministic identity per capability (below). The cache is checked before anything else, and a cache hit makes $0 / 0 units.
   - It is quota-aware, uses the circuit breaker and fails closed.
   - Every call is recorded in `apiUsage` (`providerCalled`, `estimatedUnits`, `providerUnitsUsed`) with safe error diagnostics. Secrets are never logged or stored.
3. **Enforce a hard per-call unit cap from a pre-call estimate.** The call is refused when the estimate cannot be confirmed within the cap. Rates observed via MCP on 2026-10-14, to be re-verified:
   - single-keyword metrics: 10 units;
   - `phrase_fullsearch`: 20 units per row;
   - `phrase_questions`: 40 units per row.
4. **Record actual units from the provider's response metadata** when it reports them (`usage.api_units` was present in MCP responses), and reconcile them against the estimate (#56).
5. **Preserve provenance** on everything stored (decision I): provider, report, database/country, period/month, retrieval time and units.
6. **Attach a data-quality assessment** (decisions H and I).
   - Flag: KD = 0 or missing; intent empty; volume at a bucket floor or 0; trend history shorter than 12 points; CPC 0 with non-zero competition; `NOTHING FOUND`.
   - Flagged values are kept as reported, never "corrected", and are labelled so that, for example, KD = 0 is never read as "easy to rank".
7. **Treat absence as unknown** (decision K). `NOTHING FOUND`, a missing row or an empty metric is stored as `unavailable` or `null`, never as zero demand, and never as "no candidates exist".
8. **Keep the dimensions separate** (decision J): market evidence, inferred demand, strategic relevance, GSC visibility and owner approval. GSC visibility is never mixed into provider evidence.
9. **Make explicit owner-triggered calls only.** No call on render, listener, page load, deploy or schedule.
10. **Persist only server-written evidence.** Clients can never create or change provider evidence; this matches the existing `keywords.marketDemand` rule.

## Capability 1 — market candidate discovery

The adapter MUST:

1. **Start only from a seed rebuilt server-side from the confirmed Service Map.** The client sends a seed key, never free text, exactly as in the existing M3.2 discovery (`discoverSemrushForSeed`).
2. **Produce candidate evidence only.**
   - Each returned row becomes a raw query that enters the existing M3.2 pipeline (`storeDiscoveredCandidates`): owner exclusion rules, normalization, Search Topics and qualification.
   - Any new topic is created as a **candidate** (`status: "new"`) awaiting owner review.
   - Per-row provenance and data quality are kept with the evidence.
3. **Be bounded.**
   - Use one report and one seed per explicit invocation, with an explicit row limit inside the unit cap.
   - Cache identity: business + normalized seed + database + report + row limit + provider version.
4. **Not depend on any single report** (decision E). An empty or `NOTHING FOUND` report simply yields no candidates from that source.

The adapter MUST NOT:

1. Create approved Search Topics, change an existing topic's owner status, or bypass qualification or owner review.
2. Decide business relevance, commercial intent, service classification or Search Universe membership.
3. Run discovery automatically, loop over seeds, paginate beyond the requested limit, or expand a second layer (run discovery on discovered candidates) without a new explicit owner action.
4. Run domain, competitor or backlink reports as part of keyword discovery. Those are separate, separately approved operations.

## Capability 2 — single-candidate / single-keyword enrichment

This keeps the existing governed single-keyword behaviour of the V4 REST pilot (`semrush.enrichKeywordMetrics`). The adapter MUST:

1. Enrich **one** known candidate or approved query per call, unless a batched single-keyword report is separately approved and capped.
2. Use a cache-first identity of business + normalized keyword + database + month/period + provider/report version, with a 0-unit cache hit.
3. Apply the hard unit cap and record actual units in the ledger.
4. Map responses into the **provider-neutral market-demand fields**, as `keywords.marketDemand` already does:
   - `keyword, country/database, month, searchVolume, keywordDifficulty, intents, competitiveDensity, cpc, numberOfResults, serpFeatures, trends, source, retrievedAt`;
   - plus `report`, `unitsUsed` and `dataQuality`.
   - Downstream engines never see Semrush field or report names (decision L).

## The adapter MUST NOT (either capability)

1. Overwrite owner truth, GSC evidence, discovery sources (`sources` / `sourceList`) or other providers' evidence.
2. Present Semrush figures as observed Google traffic or Search Console visibility.
3. Retry automatically or batch silently.
4. Leak provider specifics (report names, CSV columns, unit rates) outside the adapter and its config.

## Before building (checklist)

- The owner approves the build, and the MCP-vs-REST account entitlement is confirmed on the live account.
- Re-verify the MCP report names, parameters, unit costs and authentication (§46).
- Decide the fate of the V4 REST pilot (`functions/semrushV4.js`, `semrush.enrichKeywordMetrics`). The MCP adapter should be a second implementation of the same provider-neutral operation, not a parallel data model.
- Address #55 (the M5 demand tier is relative, so a single enriched topic is always "high"; fix proposed in PR #65) before enriching more than a handful of topics.
