# SEO ENGINE — MASTER ARCHITECTURE & PRODUCT SPECIFICATION
## vNext Final — Business Understanding, Entity, Intent, Decision, Measurement & Learning

**Status:** CANONICAL — product, architecture, implementation roadmap and acceptance specification  
**Date:** 2026-10-09
**Freshness status:** Re-verified against current official Google Search / Search Console documentation and current Semrush API documentation on 2026-10-09. Time-sensitive external claims must be re-verified before major milestone implementation.  
**Purpose:** This is the single Source of Truth shared by Guy, ChatGPT and Claude for the GuyHadas Visibility OS. It consolidates the SEO/GEO architecture, the NAZA-derived improvements already incorporated into vNext, M3.1 implementation decisions and acceptance results, Search Universe, Time-to-Impact / Outcome Learning, API governance, LLM website understanding, implementation boundaries, milestones and production-readiness criteria.

---

# 1. Executive Definition

The SEO Engine is not a keyword-to-content generator.

It is an **evidence-driven SEO + GEO Decision Engine**.

Its purpose is to:

> Understand the business → discover search demand → qualify and model it → understand entities and intent → establish ownership → identify opportunities → decide what should change → predict expected impact → execute → measure → compare prediction with reality → learn.

The system must ultimately answer:

1. What does this business actually offer?
2. What does the market search for?
3. What entities, topics and intents are involved?
4. Which page currently owns an intent?
5. Should an existing page be improved or should a new page exist?
6. What evidence supports the decision?
7. What is the expected business/SEO/GEO value?
8. What should be done?
9. When should we reasonably expect evidence of impact?
10. Did the outcome match the prediction?
11. What should the system learn?
12. What should it do next?

The system is a closed-loop operating system, not a one-time research tool.

---

# 2. Canonical Product Principle

The fundamental intelligence chain is:

```text
Business
  ↓
Business Knowledge
  ↓
Business Understanding
  ↓
Service / Offer Map
  ↓
Search Discovery
  ↓
Search Universe
  ↓
Search Topic
  ↓
Query / Query Family
  ↓
Entity
  ↓
Intent
  ↓
User Task
  ↓
Canonical Page Ownership
  ↓
Opportunity
  ↓
Decision
  ↓
Impact Prediction
  ↓
Implementation
  ↓
Measurement
  ↓
Outcome
  ↓
Learning
  ↺
```

The system's unit of intelligence is therefore **not the keyword**.

A keyword/query is an observation.

The system reasons about:

> **Query → Intent → Entity → Topic → User Task → Page → Outcome**

Therefore:

> Search demand is not page demand.

And:

> A new query does not automatically justify a new URL.

---

# 3. Canonical Architecture Loop

The complete architecture is:

```text
BUSINESS KNOWLEDGE
        ↓
BUSINESS UNDERSTANDING
        ↓
SERVICE / OFFER MAP
        ↓
SEARCH DISCOVERY
        ↓
SEARCH UNIVERSE
        ↓
SEARCH TOPIC QUALIFICATION
        ↓
ENTITY RESOLUTION / ENTITY GRAPH
        ↓
SEARCH INTENT CLASSIFICATION
        ↓
INTENT OWNERSHIP / CANNIBALIZATION
        ↓
SEO + GEO INTELLIGENCE
        ↓
BASELINE
        ↓
OPPORTUNITY ENGINE
        ↓
DECISION ENGINE
        ↓
IMPACT PREDICTION
   ┌────┼───────────────┐
   ↓    ↓               ↓
CREATE IMPROVE        WAIT /
PAGE   PAGE            MONITOR
   └────┬───────────────┘
        ↓
PAGE / CONTENT STRATEGY
        ↓
IMPLEMENTATION
        ↓
PUBLISH / UPDATE
        ↓
OBSERVATION WINDOW
        ↓
SEARCH CONSOLE + ANALYTICS + SERP + GEO OBSERVATIONS
        ↓
OUTCOME MEASUREMENT
        ↓
PREDICTION VS ACTUAL
        ↓
LEARNING ENGINE
        ↺
```

The system must be capable of returning:

- CREATE
- IMPROVE
- CONSOLIDATE
- WAIT
- MONITOR
- REJECT
- NO ACTION

**NO ACTION is a valid and valuable decision.**

---

# 4. Business Knowledge

`Business Knowledge` represents what the owner/business explicitly tells the system.

Examples:

- business description
- services
- products
- audiences
- markets
- geographies
- positioning
- business priorities
- strategic terms
- commercial priorities

Owner-provided information is strategic truth unless explicitly changed by the owner.

AI must not overwrite owner truth.

---

# 5. Business Understanding

Business Understanding is a distinct intelligence layer between Business Knowledge and Search Discovery.

It represents what the system understands about what the business actually does.

This layer may combine:

- owner-provided information
- website evidence
- structured data
- future external business sources
- AI interpretation/inference

Business Understanding is **not** the Search Universe.

It is the system's structured understanding of the business.

---

# 6. Service / Offer Map

The Service / Offer Map is the first structured, owner-reviewable representation of Business Understanding.

It is a first-class M3.1 object.

It may contain:

- Service
- Project Type
- Audience
- Market
- Offering
- Geography
- Positioning
- Need

Not every candidate requires every facet.

The system must preserve the semantic distinction between these dimensions.

A service can therefore be represented as:

```text
Service
+
Project Type
+
Audience
+
Geography
+
Need
+
Positioning
```

These structured dimensions later become inputs to Search Discovery.

The Service Map is not a keyword list.

It is not disposable.

It is the bridge between understanding the business and discovering market search demand.

---

# 7. Website = Evidence, Not Search Universe

This is a permanent architecture rule.

Correct:

```text
WEBSITE
  ↓
CRAWL
  ↓
PAGE-LEVEL EVIDENCE
  ↓
BUSINESS UNDERSTANDING
  ↓
SERVICE / OFFER CANDIDATES
  ↓
OWNER VALIDATION
  ↓
CONFIRMED SERVICE MAP
  ↓
SEARCH DISCOVERY
```

Incorrect:

```text
WEBSITE WORDS
  ↓
KEYWORDS
  ↓
SEARCH TOPICS
```

The website may be marketing-oriented rather than SEO-oriented.

Therefore:

- website terminology is evidence
- website pages are evidence sources
- website concepts can produce candidate services
- website concepts must not automatically become approved Search Topics

The retired `visibilityDiscoverFromWebsite` direct-topic-scanner behavior must not return.

---

# 8. M3.1 Business & Service Discovery

M3.1 owns:

```text
Business Knowledge
        ↓
Business Understanding
        ↓
Service / Offer Map
```

M3.1 must:

1. ingest onboarding information
2. crawl the website beyond the homepage
3. extract page-level evidence
4. understand what the business offers
5. discover candidate services/offers/facets
6. preserve provenance
7. allow owner validation
8. persist the validated Service Map
9. prevent rejected items from silently returning
10. expose confirmed Service Map as the input contract for M3.2

M3.1 must NOT implement the full Search Universe.

---

# 9. M3.1 → M3.2 Contract

M3.2 begins with:

```text
CONFIRMED SERVICE / OFFER MAP
+
BUSINESS CONTEXT
+
OWNER PRIORITIES
+
EVIDENCE / PROVENANCE
```

and produces:

```text
SEARCH SEEDS
↓
MARKET DISCOVERY
↓
RAW QUERIES
↓
NORMALIZATION / DEDUPLICATION
↓
QUERY FAMILIES
↓
SEARCH TOPICS
↓
PRELIMINARY INTENT
↓
QUALIFICATION
↓
OWNER REVIEW
↓
APPROVED SEARCH UNIVERSE
```

Sources may include:

- Semrush
- Google Search Console
- SERP data
- competitor research
- AI research
- other replaceable providers

Search volume is evidence, not strategy.

GSC represents actual current visibility, not the complete market universe.

---

# 10. M3.1 Website Crawling

The crawler must:

- follow redirects
- handle sitemap indexes
- tolerate www/non-www differences when appropriate
- use internal links for prioritization
- fetch a bounded number of relevant pages
- skip utility pages where appropriate
- record crawl results
- preserve page URLs
- record failure/skipping reasons

A crawl report should retain:

- pages discovered
- pages fetched
- pages parsed
- pages failed
- pages skipped
- reasons
- URLs analyzed

The system must never claim that a page was analyzed if it was not actually fetched and parsed.

Current implementation has successfully demonstrated multi-page crawling on the Hagar Lushi site.

---

# 11. Page-Level Provenance

Every website-derived observation must retain the actual originating page.

Example:

```text
Service:
Residential Architecture

Evidence:
- quote A → /architecture
- quote B → /projects/project-x
- quote C → /about
```

Do not automatically credit evidence to the homepage.

If AI claims that a concept is present on a specific page:

1. verify that the evidence exists there
2. retain that page as the source
3. if it does not exist there, use the actual source page
4. preserve multiple supporting pages where appropriate

Evidence should include:

- observation/quote
- source URL
- originating page
- provenance
- related service/facet
- timestamp where appropriate

---

# 12. Provenance Model

The system must distinguish:

### OWNER

Explicitly provided by the business owner.

### WEBSITE

Actually found in website evidence.

### AI_INFERENCE

Interpreted/inferred by AI from available evidence.

These are materially different.

Owner-provided values must never be silently overwritten by AI.

Website provenance must only be assigned when the value is actually supported by website evidence.

AI inference must not be presented as direct website fact.

---

# 13. Owner Validation

The owner must be able to:

- Confirm
- Reject
- Edit
- Add
- Prioritize

The UI should remain simple.

The owner should validate business truth rather than manually classify thousands of attributes.

States include:

```text
NEEDS_REVIEW
CONFIRMED
REJECTED
```

Rejected items must not silently reappear in future analysis.

---

# 14. Service Map Data Model

Conceptually:

```text
businessServices
{
  businessId
  name
  description

  source
  confidence
  ownerStatus
  priority

  facets:
    service
    projectType
    audience
    market
    offering
    geography
    positioning
    need

  provenance per facet

  evidenceSources[]
  sourceUrls[]

  createdAt
  updatedAt
}
```

The exact schema may evolve.

The semantic distinction between the facets must remain.

---

# 15. Entity Graph

The system should maintain an Entity Graph alongside Search Topics.

Initial entity types:

- Organization
- Brand
- Product
- Service
- Person
- Place
- Problem
- Solution
- Topic
- Concept
- Event
- Claim
- Source
- Evidence
- Content Asset
- Page
- Video
- Dataset
- Competitor
- Market
- Language / Locale

The schema must allow additional entity types without redesign.

Example relationships:

```text
Brand
 ├── offers → Product
 ├── operates_in → Market
 ├── competes_with → Competitor
 └── owns → Content

Problem
 ├── searched_by → Query
 ├── solved_by → Solution
 ├── relevant_to → Audience
 └── represented_by → Search Topic

Search Topic
 ├── contains → Query
 ├── targets → Intent
 ├── concerns → Entity
 ├── maps_to → Page
 └── generates → Opportunity

Page
 ├── owns → Search Intent
 ├── targets → Entity
 ├── covers → Search Topics
 ├── links_to → Page
 └── produces → Search Outcome
```

Do not implement the entire Entity Graph prematurely in M3.1.

M3.1 must remain compatible with it.

---

# 16. Search Topic

A Search Topic is not a keyword row.

A query is an observation.

A Search Topic is a normalized strategic concept that may contain many related queries.

Future Search Topic relationships should support:

- query/query family
- entity
- intent
- user task
- audience
- geography
- business relevance
- commercial value
- owner priority
- SEO signals
- GEO signals
- current visibility
- competitors
- evidence
- opportunities
- page ownership
- cannibalization

Do not implement the full Search Topic intelligence layer in M3.1.

Do not create a schema that prevents it.

---

# 17. Search Intent

Create/maintain a persistent `SearchIntent` concept.

Minimum conceptual fields:

```text
intent_id
intent_type
user_task
entity_ids[]
topic_ids[]
query_ids[]
primary_owner_page_id
candidate_owner_page_ids[]
ownership_confidence
cannibalization_risk
business_value
status
last_evaluated_at
```

Initial intent taxonomy should remain extensible and support:

- informational
- commercial investigation
- transactional
- navigational
- local
- comparison
- problem discovery
- solution discovery
- definition / meaning
- how-to
- review
- pricing
- availability
- location
- entity-specific
- media/video
- research/evidence

---

# 18. Intent Ownership

For each meaningful intent:

> Identify the canonical page that should own the intent.

If an existing page already owns the intent:

> Default action = IMPROVE.

A second page is justified only when:

- entity is materially different
- user task is materially different
- information required is materially different

This rule prevents keyword-driven page proliferation.

---

# 19. Cannibalization

Cannibalization is a system-level concept.

For candidate pages evaluate:

- target queries
- intent
- entity
- user task
- SERP overlap
- existing coverage
- semantic similarity
- expected canonical ownership

States:

```text
NO_COLLISION
RELATED_BUT_DISTINCT
POTENTIAL_COLLISION
HIGH_COLLISION
DUPLICATE
```

Every new-page recommendation must eventually explain:

```text
existing_owner_page
collision_status
collision_reason
why_new_page_is_or_is_not_justified
```

---

# 20. Opportunity Engine

An Opportunity is not simply a high-volume keyword.

It is a potential business/SEO action supported by evidence.

Types include:

- CREATE_PAGE
- IMPROVE_PAGE
- CONSOLIDATE_PAGES
- REDIRECT
- UPDATE_CONTENT
- ADD_INTERNAL_LINKS
- REWORK_INTENT
- ADD_ENTITY_COVERAGE
- ADD_STRUCTURED_DATA
- ADD_SOURCE / EVIDENCE
- LOCALIZE
- DEINDEX / NOINDEX
- WAIT_FOR_DATA
- MONITOR

Opportunity scoring may consider:

- search demand
- demand trend
- intent clarity
- business relevance
- commercial value
- audience relevance
- SERP opportunity
- competition
- existing visibility
- current position
- CTR gap
- content gap
- entity coverage gap
- evidence availability
- content uniqueness potential
- internal-link potential
- GEO relevance
- freshness
- cannibalization risk
- implementation cost
- expected value
- confidence

Weights must be configurable by project.

---

# 21. Decision Engine

Every Opportunity eventually passes through a Decision Engine.

Outputs:

```text
CREATE
IMPROVE
CONSOLIDATE
WAIT
MONITOR
REJECT
```

Decision concept:

```text
decision_id
opportunity_id
decision
confidence
evidence_ids[]
existing_page_id
recommended_page_id
reason_codes[]
blocking_conditions[]
estimated_effort
estimated_value
created_at
model_version
```

Recommendations must be explainable through structured evidence.

---

# 22. Evidence & Confidence

Every important recommendation must separate:

### OBSERVED
Directly measured or retrieved.

### INFERENCE
System interpretation.

### ASSUMPTION
Modeling choice.

### HYPOTHESIS
Something to test.

### RECOMMENDATION
Proposed action.

Evidence concept:

```text
evidence_id
source_id
observation
evidence_type
source_quality
captured_at
related_entity_ids[]
related_topic_ids[]
confidence
```

Recommendation trace:

```text
Recommendation
 → Opportunity
   → Signals
     → Sources
       → Raw observations
```

---

# 23. Internal Linking Intelligence

Internal links are part of the SEO graph.

Evaluate:

- source page
- target page
- target entity
- target intent
- relationship type
- anchor recommendation
- contextual placement
- expected value
- existing link

The system should identify:

- orphan pages
- underlinked pages
- overlinked pages
- cluster connectivity
- authority distribution
- missing contextual relationships

---

# 24. Content Family Boundaries

Each content family should eventually define:

```text
Purpose
Primary intents
Entities owned
Allowed content
Adjacent content
Forbidden content
Canonical owners
```

This prevents content sprawl and overlapping page purposes.

---

# 25. Entity Consistency

Maintain canonical entity facts where appropriate:

- name
- alternate names
- category
- attributes
- official URLs
- relationships
- identifiers
- schema IDs
- last reviewed

Detect conflicting values across pages.

---

# 26. Localization

Localization is demand-led.

Do not translate everything automatically.

Evidence may include:

- local search demand
- impressions
- traffic
- market distribution
- commercial opportunity
- audience need
- press/distribution activity

Possible decisions:

```text
DISPLAY_TRANSLATION
INDEX_LOCALIZED_PAGE
DO_NOT_LOCALIZE
WAIT
```

Default principle:

> Translate winners, not the entire inventory.

---

# 27. Scale Gates

The system must not equate more pages with more SEO.

Stages:

```text
Stage 0 — Research
Stage 1 — Core pages
Stage 2 — Proven expansion
Stage 3 — Programmatic expansion
Stage 4 — Large-scale ecosystem
```

Progression should depend on evidence such as:

- indexed core pages
- proven query demand
- stable publishing
- low duplication
- reliable data
- Search Console feedback

---

# 28. Measurement Model

Measure outcomes at four levels.

## 28.1 Query

- impressions
- clicks
- CTR
- position
- query emergence
- query volatility

## 28.2 Page

- impressions
- clicks
- CTR
- rankings
- indexed state
- traffic
- engagement
- conversions

## 28.3 Topic / Intent

- visibility
- owned-query coverage
- competing pages
- intent coverage
- opportunity coverage

## 28.4 Business

- qualified traffic
- leads
- revenue/conversion where available
- commercial intent
- acquisition efficiency

Measurement must preserve the distinction between observation, interpretation, attribution and outcome.

---

# 29. Technical SEO Layer

Technical SEO is a gate and diagnostic layer, not the main strategic engine.

Checks should include where data is available:

- indexability
- canonical
- robots
- sitemap
- lastmod
- structured data
- breadcrumbs
- page speed / Core Web Vitals
- internal links
- orphan pages
- duplicate content
- broken links
- rendering
- metadata

---

# 30. Content Page Specification

Every proposed page should eventually have a machine-readable Page Brief.

Minimum conceptual fields:

```text
page_id
canonical_url
page_type
primary_intent
secondary_intents
primary_entity
related_entities
target_query_family
existing_owner
reason_to_exist
content_requirements
unique_information_required
source_requirements
internal_links_in
internal_links_out
schema_requirements
localization_status
publish_gate
quality_score
cannibalization_status
decision
```

Claude and other implementation/content agents should receive this structured Decision/Page Brief rather than an unstructured keyword list.

---

# 31. Content Workflow

Recommended workflow:

```text
Research
 ↓
Draft
 ↓
Source / Evidence Review
 ↓
Intent Review
 ↓
Entity Review
 ↓
Quality Gate
 ↓
Cannibalization Gate
 ↓
Technical Gate
 ↓
Internal Link Pass
 ↓
Publish
 ↓
Measurement
 ↓
Scheduled Re-review
```

For sensitive or current content, `last_reviewed_at` is mandatory.

---

# 32. Caching & Reuse

All expensive research and analysis operations should be reusable.

Conceptually:

```text
analysis_key =
hash(
  project
  + task
  + normalized_inputs
  + provider
  + model
  + prompt_version
  + analysis_version
)
```

If the same analysis is requested with unchanged semantic inputs and versions:

```text
CACHE HIT
→ stored result
→ no provider/API call
→ cost = $0
```

Cache identity must exclude timestamps, run IDs and request IDs.

A cache miss records the provider call and result.

The system must expose whether a result was cached/reused rather than silently executing the provider again.

A failed cache/safety/quota lookup is a fail-closed condition. It must not be interpreted as a cache miss.

---

# 33. Provider Independence

External providers are replaceable adapters.

The decision/intelligence layer should consume normalized observations rather than depend on provider-specific terminology.

Conceptually:

```text
Semrush
Search Console
Google SERP data
LLM analysis
Website crawler
Other providers
      ↓
Provider adapters
      ↓
Normalized observations
      ↓
Evidence / Intelligence layer
      ↓
Opportunity / Decision layer
```

---

# 34. Universal API Governance

All external APIs are potentially expensive, quota-limited or failure-prone.

Therefore:

1. No expensive external API call directly from the UI.
2. Route provider work through a governed operation/job path.
3. Require an explicit reason for the operation.
4. Check cache/history before calling the provider.
5. Build a deterministic request/input fingerprint.
6. Prefer local deterministic processing before paid reasoning.
7. Minimize, deduplicate and batch requests.
8. Enforce operation, business and global budgets where applicable.
9. Enforce record/output caps.
10. Use retries/backoff/idempotency and circuit breakers.
11. Maintain a generic `apiUsage` ledger.
12. Maintain provider-specific limits and application-level hard limits.
13. Force refresh must be explicit, non-sticky and still subject to hard limits.
14. Never re-run paid analysis merely because a page rendered, a deploy happened or a component mounted.
15. Capture cost and provider-call state for every governed operation.

Ledger states should distinguish at least:

```text
cache_hit
cache_miss
force_refresh
provider_called
blocked
error
success
```

A cache hit must have providerCalled=false and cost=$0.

### 34.1 Semrush API access and version strategy

Semrush currently exposes both Version 3 and Version 4 APIs, with version-specific API keys and different supported endpoint coverage. Current Semrush documentation recommends Version 4 for new Keyword Reports integrations; existing Version 3 Keyword Reports integrations remain temporarily supported while migration continues. Version 4 Keyword Reports are currently in Early Access and can change before General Availability. cite-source-needed

For this product, **do not upgrade the Semrush subscription solely to obtain or preserve Version 3 access**.

The operating rule is:

- Use the Semrush API capabilities that are actually available on the user's current account.
- Prefer Version 4 when the required capability exists in Version 4.
- Do not build a dependency on Version 3 merely because an older implementation used it.
- If a required capability is not available through the user's current Version 4 access, **defer that capability** rather than requiring a plan upgrade solely for an older API version, unless the owner explicitly approves the cost/benefit.
- Treat the Semrush account's available API units as a recurring budget and govern consumption through the existing API governance layer.
- Cache/reuse aggressively; do not spend units on page render, duplicate research or unnecessary re-runs.
- Keep provider-specific version details inside the adapter layer, never in the core intelligence model.

Semrush's current documentation states that Standard API access is an add-on to the Business tier and that purchased API units are included in the recurring subscription and renew on the subscription renewal date; unused units expire rather than rolling forward. The exact account entitlement must always be verified from the live Semrush account rather than assumed from the plan name. cite-source-needed

Sources:
https://developer.semrush.com/api/v4/seo/keyword-reports/
https://developer.semrush.com/api/v4/get-started/authorization/
https://www.semrush.com/kb/5-api
https://developer.semrush.com/api/v3/introduction/api-versions/

The governance contract is:

```text
CACHE / HISTORY
      ↓
SAFETY / QUOTA CHECK
      ↓
COST ESTIMATE
      ↓
PROVIDER CALL
      ↓
STORE RESULT + LEDGER
```

If cache lookup, quota lookup or governance infrastructure fails, the system must stop rather than spend blindly.

### Current production-readiness note

Anthropic and Semrush operations are governed by the current cost-control architecture. Since M4, the Search Console query × page request used by Search Intelligence (`google.searchConsoleQueryPage`) is governed too.

The other Google APIs used by visibility/analytics flows (GA4 / GSC daily sync, GSC discovery) are not yet normalized under the same governance path and remain a production-hardening gap. Do not treat this as permission to add new ungoverned calls.

---

# 35. Claude / AI Agent Handoff

Claude is an implementation agent, not the strategic owner of the SEO universe.

A coding/content implementation task should be generated from structured intelligence:

```text
Decision
  ↓
Page Brief / Task Brief
  ↓
Evidence IDs
  ↓
Acceptance Criteria
  ↓
Claude / Agent
```

The handoff should tell the agent:

- what to change
- why
- which entity/intent/page is involved
- what evidence supports it
- what must not change
- acceptance criteria
- measurement implications

The agent should execute a decision rather than invent a new strategic SEO direction.

---

# 36. Admin / Strategy UI

The strategic UI should eventually expose:

## Search Universe

- topics
- query families
- entities
- evidence
- relevance
- intent
- business value
- owner status

## Opportunities

- CREATE
- IMPROVE
- CONSOLIDATE
- WAIT
- MONITOR
- REJECT

## Pages

- current owner
- intent
- entity
- rankings
- Search Console queries
- technical health
- uniqueness
- internal links
- active predictions

## Learning

- predictions
- outcomes
- misses
- prediction error
- attribution confidence
- repeated patterns

---

# 37. Core KPIs

### Strategic

- % of important intents with a canonical owner
- % of pages with a defined primary intent
- % of opportunities backed by evidence
- % of new pages passing publish gate
- cannibalization rate
- duplicate-page rejection rate
- page improvement vs page creation ratio
- orphan-page rate
- internal-link coverage
- entity consistency rate

### Learning

- predicted vs actual intent accuracy
- predicted vs actual opportunity value
- Search Console discovery rate
- recommendation acceptance rate
- recommendation success rate
- time from signal → opportunity → action
- % of recommendations reused from cache

### Cost

- provider calls
- cache hit rate
- API cost per analysis
- API cost per opportunity
- API cost per published page

---

# 38. Time-to-Impact Prediction & Outcome Learning

Time-to-Impact is a first-class capability integrated into Opportunity, Decision, Measurement and Learning.

The closed loop becomes:

```text
OBSERVE
  ↓
DIAGNOSE
  ↓
RECOMMEND
  ↓
PREDICT
  ↓
IMPLEMENT
  ↓
MONITOR
  ↓
MEASURE
  ↓
COMPARE PREDICTION vs ACTUAL
  ↓
LEARN
  ↺
```

Do not create a separate prediction subsystem.

## 38.1 ImpactPrediction

Persistent conceptual object:

```text
prediction_id
opportunity_id
decision_id
project_id
target_type
target_id
prediction_version
model_version
baseline_snapshot_id
predicted_first_signal_min_days
predicted_first_signal_max_days
predicted_meaningful_impact_min_days
predicted_meaningful_impact_max_days
predicted_traffic_impact
predicted_visibility_impact
predicted_ranking_impact
confidence
prediction_factors[]
observation_window_start
observation_window_end
status
created_at
updated_at
```

The exact schema may evolve; the distinction between prediction and observation must remain explicit.

## 38.2 Ranges, not exact dates

Never promise a single exact SEO-impact date.

Predictions should be ranges, for example:

```text
Expected first signal: 2–5 weeks
Expected meaningful impact: 6–12 weeks
Confidence: 78%
```

## 38.3 Three impact stages

1. Discovery / indexation signal
2. SEO signal
3. Meaningful business impact

These stages must remain separate.

## 38.4 Prediction factors

Consider, where observable:

### Website

- domain age (contextual metadata only; not treated as a direct ranking factor)
- historical organic visibility
- authority proxy (explicitly a proxy, never a claimed Google score)
- referring domains/backlink strength
- existing organic traffic
- indexed pages
- crawl activity
- Search Console activity
- historical responsiveness to SEO changes
- technical health
- site size
- topical authority
- historical volatility

### Page

- current ranking
- impressions
- clicks
- CTR
- query coverage
- page age
- page authority proxy (explicitly a proxy)
- internal links
- orphan status
- indexation status
- historical trajectory

### Query

- search demand
- competition
- SERP volatility
- current position
- distance to page one
- distance to target position
- intent clarity
- query-family size
- commercial value

### Recommendation

- recommendation type
- change magnitude
- content expansion
- intent correction
- internal linking
- metadata change
- technical fix
- schema change
- consolidation
- new page
- authority work
- freshness update
- entity coverage
- content quality improvement

### External

- SERP volatility
- competitor movement
- seasonality
- major search ecosystem changes
- algorithm/update periods
- market demand changes

## 38.5 Baseline

No impact prediction should be evaluated without a baseline.

Capture an immutable baseline snapshot before implementation where applicable:

```text
target URL
target query family
average position
impressions
clicks
CTR
indexed state
organic sessions where available
conversions where available
ranking distribution
query count
date range
competitor/SERP context where available
```

## 38.6 Change event

Every implemented recommendation must produce an `SEOChangeEvent`:

```text
change_event_id
opportunity_id
decision_id
target_page_id
change_type
implementation_timestamp
publication_timestamp
implementation_status
before_snapshot_id
after_snapshot_id
changed_elements[]
responsible_actor
implementation_notes
```

## 38.7 Observation states

Use dynamic observation windows.

Suggested states:

```text
TOO_EARLY
NO_SIGNAL_YET
EARLY_SIGNAL
SEO_SIGNAL
MEANINGFUL_IMPACT
UNDERPERFORMING
FAILED
INCONCLUSIVE
CHANGE_IN_OBSERVATION_WINDOW
```

A recommendation must not be marked failed merely because it has not yet reached its predicted evaluation window.

## 38.8 Attribution

Distinguish:

> the page improved after the change

from:

> the change caused the improvement.

Consider:

- algorithm changes
- seasonality
- competitor changes
- site-wide changes
- backlinks
- other content changes
- technical changes
- demand changes

Where possible compare:

- pre/post period
- target vs non-target queries
- target page vs comparable pages
- target query family vs control families
- site-wide trend

Never present correlation as proven causation.

## 38.9 Prediction error and learning

Every completed observation should preserve:

```text
original recommendation
original baseline
prediction
implementation
observation window
actual result
prediction error
attribution confidence
final outcome
```

Then learn by:

- recommendation type
- website
- authority level / authority proxy (never treated as a direct Google metric)
- starting position
- industry
- query difficulty
- page type

Phase 1 is heuristic/configurable priors.

Phase 2 is an empirical learned model once sufficient historical observations exist.

Do not introduce ML prematurely.

## 38.10 Recommendation churn prevention

If a page has a recent material SEO change and remains inside its expected observation window, the system should generally avoid recommending another major overlapping change unless there is a strong reason.

This protects measurement quality and avoids self-interference.

## 38.11 SEOExperiment

When multiple recommendations affect the same page close together, group them into:

```text
SEOExperiment
{
  experiment_id
  page_id
  opportunity_ids[]
  change_event_ids[]
  baseline_snapshot_id
  prediction_id
  start_date
  observation_end_date
  status
  outcome
  attribution_confidence
}
```

---

## 38.12 Stage ownership by milestone (clarification, M7 design)

This makes explicit what §38 implies; it does not change §38's semantics.

| Loop stage | Milestone | Notes |
|---|---|---|
| PREDICT | M7 | Heuristic, versioned priors; ranges per stage (A first signal, B SEO signal, C business impact); ordinal magnitudes and ordinal confidence in v1 (numeric calibrated confidence such as "78%" in §38.2 is an M9 output). Predictions are created for owner-accepted decisions and frozen when the implementation is recorded. |
| IMPLEMENT (capture) | M7 | Owner/operator records the implementation; an `SEOChangeEvent` is created; the change itself is crawl-verified where observable. Accepting a decision is never implementation. |
| MONITOR (lifecycle) | M7 | Observation windows and time-based / structural states only: `TOO_EARLY`, `CHANGE_IN_OBSERVATION_WINDOW`, structural `INCONCLUSIVE`, plus lifecycle additions `PENDING_PUBLICATION` and `PENDING_MEASUREMENT` that make no signal claim. Churn-prevention holds. |
| MEASURE, COMPARE PREDICTION vs ACTUAL, attribution | M8 | Signal states `NO_SIGNAL_YET`, `EARLY_SIGNAL`, `SEO_SIGNAL`, `MEANINGFUL_IMPACT`, `UNDERPERFORMING`, `FAILED` are set only by M8 with measurement evidence; after-snapshots; attribution confidence; outcome. |
| LEARN | M9 | Prediction error, calibration of priors / windows / holds, numeric confidence, learned models. |

---

# 39. LLM Website Understanding

The system must eventually include a dedicated **LLM Website Understanding** capability.

This must remain distinct from Google's own Search guidance. As of October 2026, Google states that existing foundational SEO practices remain relevant for AI Overviews and AI Mode and that there are no additional technical requirements or special optimizations required specifically to appear in those features. A page must still be indexed and eligible to appear in Google Search; eligibility does not guarantee crawling, indexing or serving.

Google also provides first-party generative-AI performance reporting in Search Console. The OS should therefore distinguish:

1. Google AI Search measurement — first-party observations where Search Console exposes them.
2. External AI visibility measurement — observations from ChatGPT, Gemini, Copilot, Perplexity and other systems.
3. LLM Website Understanding — what an LLM can infer about the business and site, regardless of whether that inference results in an observed AI citation.

The system must never imply that there is a separate publicly documented "GEO ranking factor" merely because we use GEO as our internal intelligence framework.

Sources:
https://developers.google.com/search/docs/appearance/ai-features
https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports


This is not a separate keyword research system.

It must connect to the same model:

```text
Business
 → Business Understanding
 → Entities
 → Services / Offers
 → Search Topics
 → Intent
 → Pages
 → Outcomes
```

The system should periodically be able to ask, using one or more supported LLMs:

### What does the model understand this business to be?

Evaluate:

- business identity
- services
- products/offers
- audiences
- locations
- markets
- positioning
- differentiators
- entities associated with the business
- what the website appears to specialize in

### What evidence is the model relying on?

Record:

- pages
- sections
- structured data
- canonical facts
- cited/extracted evidence
- confidence
- contradictions

### What does the model think is missing or unclear?

Identify:

- unclear services
- ambiguous entities
- weak positioning
- missing location context
- incomplete offer descriptions
- unclear relationships
- poor machine-readable structure

### Does the model associate the business with the wrong things?

Detect:

- hallucinated services
- wrong geography
- incorrect category
- competitor confusion
- stale facts
- entity collisions
- unsupported claims

### Is the website AI-readable?

Evaluate whether the important business facts are:

- explicit
- consistent
- discoverable
- structured
- attributable to clear pages
- represented consistently across the site

This capability should produce evidence and recommendations, not merely a textual LLM summary.

It should ultimately connect to:

```text
LLM Understanding
      ↓
Entity / Business Understanding
      ↓
Search Universe
      ↓
Intent
      ↓
SEO + GEO Intelligence
      ↓
Opportunity / Decision
```

Monitoring AI visibility in ChatGPT, Gemini, Copilot, Perplexity and other AI systems remains a later implementation milestone, but the architecture must support it.

---

# 40. Implementation Roadmap

## Completed

### M1 — Foundation
System foundation, Firestore, application structure and core plumbing.

### M2 — GA4 + Search Console
Analytics and Search Console connectivity and baseline visibility flows.

### M3.1 — Business & Service Discovery
Completed and accepted.

### M3.1 acceptance outcome

Real-world acceptance validated:

- multi-page website crawl/report
- candidate services beyond onboarding
- page-level evidence on inner pages
- multiple provenance types
- useful facets
- owner confirm/reject/edit/add/prioritize
- durable rejection
- renamed/rejected item protection through alias handling
- repeated identical runs reused from cache at $0
- changed-input run blocked by daily quota at $0
- no silent provenance corruption
- final paid run completed within the expected cost envelope

M3.1 is therefore treated as **DONE**.

---

## Current

### M3.2 — Search Universe & Qualification

M3.2 is DONE (merged `3aadc0b`; live Hagar acceptance validated; live Semrush discovery deferred — no usable direct API access).

Contract:

```text
CONFIRMED SERVICE / OFFER MAP
        ↓
DETERMINISTIC SEED BUILDER
        ↓
MARKET DISCOVERY
        ↓
RAW QUERIES
        ↓
FILTERING
        ↓
NORMALIZATION
        ↓
QUERY FAMILIES
        ↓
SEARCH TOPICS
        ↓
LIGHTWEIGHT QUALIFICATION
        ↓
OWNER REVIEW
        ↓
APPROVED SEARCH UNIVERSE
```

M3.2 must:

- use confirmed Service Map data only
- use owner-first facet precedence
- use service-area geography as a primary seed
- treat project-only locations as evidence/context unless explicitly validated as target geography
- use governed provider access
- preserve raw query provenance
- normalize deterministically
- group query families without losing raw queries
- persist durable owner rejection
- keep Search Topics above raw query rows
- provide traceability from seed → query → topic → evidence
- avoid low-volume deletion as an automatic strategy rule
- fail closed on governance/cache/quota failures
- avoid page/task/opportunity side effects
- avoid provider calls on page render

### M3.2 scope boundary

M3.2 does NOT implement:

- full Entity Graph
- full Search Intent ownership
- full cannibalization engine
- Opportunity automation
- Decision automation
- Time-to-Impact
- prediction learning
- autonomous content publishing
- advanced GEO monitoring
- full LLM Website Understanding monitoring

Those remain future milestones.

### M3.2 implementation status (PR #21, issue #20)

**Status: DONE — merged and live-validated on Hagar. Live Semrush discovery deferred (path covered by deterministic tests).** Details and decisions: `docs/M3.2_IMPLEMENTATION_NOTES.md`.

Implemented:

- Deterministic seed builder from confirmed Service Map items only; owner service areas first; website/AI places on fewer than 3 crawled pages reported as project locations, never seeded; rejected names/aliases never seed; caps round-robin by priority; full seed lineage.
- Semrush as two governed operations (`discoverRelatedForSeed`, `discoverDomainOrganic`); the client sends only a seed key, the phrase is rebuilt server-side from the confirmed Service Map.
- Raw queries keep per-source evidence (`sources.{gsc,semrush,manual}`), seed lineage and grouping reason; re-discovery refreshes evidence and never nulls another source's metrics.
- Normalization: exact match first, then token overlap against the topic title with a place guard; no stemming.
- Owner-rule exclusions stored with the rule (`excludedByRule`, raw query kept); re-found queries stay in their topic, so excluded topics stay excluded.
- Lightweight explained qualification + preliminary intent on topics (not the §17 Search Intent object); discovery never changes owner status or creates pages/tasks/opportunities.
- UI: seed list from the Service Map (no free-text seed box), skipped inputs with reasons, per-source badges and metrics, qualification reasons, excluded history, cache/paid/blocked decision shown.

Acceptance (implementation brief §12): items 1–14, 16–18 covered by automated tests (`functions/test/searchUniverse.test.js`, `app/test/noProviderCallOnRender.test.ts`); 15 by the input contract below; 19 (browser on the real app) and the live parts of 1–5 pending deploy; 3–5 live Semrush blocked by quota; 20 verified by review.

M3.2 → M4 input: `searchTopics` with status relevant / priority / brand_strategic, their `keywords` (per-source evidence, `seedRefs` to confirmed services/facets) and qualification reasons; negative signals = excluded topics + `keywords.excludedByRule`.

Known limitations: Hebrew morphology not normalized (e.g. אדריכל / אדריכלות); the place guard knows only recorded places; English-only profile markets produce no geography seeds for Hebrew services (the UI asks for the Hebrew name). Google API governance gap: see §34 and §42.


### M4 — Search Intelligence & Baseline

**Status: DONE — implemented, merged, deployed and live-validated on Hagar in October 2026.** Contract: `docs/M4_IMPLEMENTATION_BRIEF.md`; decisions and evidence: `docs/M4_IMPLEMENTATION_NOTES.md`.

Implemented: page inventory with observed technical SEO state (`seoPages`); per-approved-topic intelligence with GSC current (query × page), GSC discovery and Semrush as separate evidence, observed vs inferred pages and explicit missing data (`topicIntelligence`); GEO readiness from website signals only (not AI visibility); run records (`intelligenceRuns`); immutable, versioned baselines (`baselines`, create-only; `businesses.baselineDate` is now a server-set pointer). One governed provider call (GSC query × page); no Semrush, GA4 or LLM call; SERP context `not_available`.

Not implemented (M5+): opportunities, decisions, intent ownership, cannibalization, ImpactPrediction, change events, measurement/learning, AI visibility monitoring, LLM Website Understanding.

### M5 — Opportunity Engine

**Status: DONE — merged to `main` (`2fbb43d`) and live-validated on Hagar in October 2026 (real run; identical rerun = cache hit, no writes).** Design and decisions: `docs/M5_OPPORTUNITY_ENGINE_DESIGN.md`.

Deterministic, evidence-backed opportunity **candidates** from existing M3.2/M4 data only (no provider calls). Market demand (Semrush, unknown when unavailable) and observed search visibility (Search Console) are separate signals — Search Console impressions are never treated as market demand. Kinds: technical blockers on topic pages, ranking and CTR upside (CTR compared only with the site's own), coverage gaps, pages without visibility, internal linking for topic pages, observed page overlap (monitor, not a cannibalization verdict), and entity/fact clarity. Ordinal, labelled factors; priority band and confidence with reasons; embedded evidence referencing source documents; baseline id and impact inputs on every opportunity. Extends the existing `opportunities` collection (`source: "opportunity_engine"`); owner status never overwritten; rejection durable; NO_ACTION / WAIT_FOR_DATA recorded per topic on `opportunityRuns`; identical analysis is a $0 cache hit with no writes.

Not implemented (M6+): SearchIntent, ownership, cannibalization, final decisions, ImpactPrediction, change events, measurement, learning.

### M6 — Decision Engine

**Status: DONE — merged (`7378618`), deployed and live-validated on Hagar in October 2026** (phone-evidence fix #36 in M4, `d5d1f94`, re-validated). Design: `docs/M6_DECISION_ENGINE_DESIGN.md`; implementation: `docs/M6_IMPLEMENTATION_NOTES.md`.

Persistent SearchIntents, ownership, cannibalization and one explainable decision per intent / page / site unit (CREATE / IMPROVE / CONSOLIDATE / WAIT / MONITOR / REJECT) with proliferation guardrails G1–G11, provider-free, complete input + output-state cache fingerprints, single-flight runs and recoverable writes.

Not implemented (M7+): ImpactPrediction, implementation capture, change events, experiments, observation windows, churn prevention (M7); measurement (M8); learning (M9).

---

# 41. Future Milestones

### M4 — Search Intelligence & Baseline

**Status: DONE — implemented, merged, deployed and live-validated on Hagar in October 2026.**

- full Search Topic intelligence
- SEO intelligence
- GEO intelligence
- technical SEO diagnostics
- immutable baselines
- SERP context

### M5 — Opportunity Engine

**Status: DONE — merged (`2fbb43d`) and live-validated on Hagar in October 2026.**

- evidence-backed opportunities
- CREATE vs IMPROVE candidates
- opportunity scoring
- business value
- prioritization

### M6 — Decision Engine

**Status: DONE — merged (`7378618`), deployed and live-validated on Hagar in October 2026.** Live validation surfaced an M4 evidence-quality defect (phone-number consistency, #36), fixed in the evidence layer (`d5d1f94`) and re-validated in production; M6 decision semantics were unchanged. Email-evidence quality (#37) is tracked separately and is not an M7 blocker. Design: `docs/M6_DECISION_ENGINE_DESIGN.md`; implementation decisions and deviations: `docs/M6_IMPLEMENTATION_NOTES.md`.

- Search Intent object
- canonical ownership
- cannibalization
- CREATE / IMPROVE / CONSOLIDATE / WAIT / MONITOR / REJECT
- explainability

### M7 — Prediction, Change & Experiment Tracking **(CURRENT MILESTONE — design phase)**

**Status: DESIGN — `docs/M7_DESIGN.md` (+ `docs/M7_IMPLEMENTATION_BRIEF.md`); no implementation yet.**

- ImpactPrediction (deterministic, versioned heuristics; ranges for three separate stages; ordinal magnitudes; confidence with reasons; unknowns explicit) — clarification: §38 and the M6 design already place prediction in M7
- implementation capture (owner-recorded; acceptance is never implementation)
- SEOChangeEvent (with crawl verification of the change itself)
- SEOExperiment (deterministic grouping, extension)
- observation windows (dynamic) and time-based lifecycle states only
- recommendation churn prevention (state in M7, applied by M6 as WAIT/MONITOR with evidence)

Boundary: M7 never measures outcomes, sets signal states (NO_SIGNAL_YET … FAILED), computes attribution, or calibrates — see §38.12.

### M8 — Measurement

- outcome measurement
- pre/post comparison
- control/comparison views
- attribution confidence

### M9 — Learning

- prediction error
- recommendation outcomes
- empirical learning dataset
- calibration

### M10 — SEO / GEO Research & Analysis Agents

- repeatable research agents
- structured evidence collection
- specialized diagnosis/analysis

### M11 — Content & Authority Execution

- page briefs
- content workflows
- internal linking
- schema
- authority workflows
- governed publishing

### M12 — Expanded GEO

- AI visibility monitoring
- ChatGPT / Gemini / Copilot / Perplexity observation
- mentions
- citations
- cited URLs/domains
- competitor AI visibility
- entity recognition
- AI answer coverage

### M13 — Continuous Search Visibility Loop

```text
OBSERVE
 → UNDERSTAND
 → DISCOVER
 → QUALIFY
 → ANALYZE
 → DECIDE
 → PREDICT
 → EXECUTE
 → MEASURE
 → LEARN
 → REPRIORITIZE
 → REPEAT
```

### Future Product Directions — post-core milestones

These are architecture/product notes only. They are not current implementation scope.

#### Topic → Market Research → Site

A future mode should accept a Topic rather than an existing business/site and begin with a Market Research Gate:

~~~
TOPIC
  ↓
MARKET RESEARCH
  ↓
TOPIC QUALIFICATION
  ↓
DOMAIN STRATEGY
  ↓
SITE SIZE / PAGE MAP
  ↓
INFORMATION ARCHITECTURE
  ↓
LAUNCH PLAN
  ↓
MEASUREMENT
  ↓
LEARNING
~~~

Market qualification should establish, where data is available:

- real search demand
- search-universe depth
- traffic potential
- languages / countries / markets
- intent/topic families
- commercial intent
- competition
- existing businesses / monetization
- business-model potential
- AI / GEO opportunity
- whether the topic is deep enough to justify a site

The system should be able to return "do not build" as a valid outcome.

#### Stack-Aware SEO Execution

A future implementation layer should detect a site's technology stack and generate technology-specific execution instructions.

Example:

~~~
Astro + Firebase
Next.js
WordPress
Other supported stack
        ↓
Fix capability matrix
        ↓
AUTO-FIX
AGENT-FIX
HUMAN REVIEW
DO NOT AUTO-FIX
        ↓
Implementation Brief
        ↓
Test
        ↓
PR / Deploy
~~~

Technical SEO should become increasingly automatable when the change is deterministic, reversible and safe.

#### External Search Intelligence

A future intelligence layer should continuously ingest and evaluate:

- Google Search / Search Central changes
- Search Console changes
- algorithm and spam updates
- AI Search developments
- practitioner observations
- industry discussions
- Reddit / community observations
- search-demand / trend signals
- relevant platform changes

The output is not a news dump. It is:

~~~
SOURCE
  ↓
CLAIM / SIGNAL
  ↓
EVIDENCE
  ↓
CONFIDENCE
  ↓
CURRENT / CHANGED / UNCERTAIN / HYPOTHESIS / HISTORICAL
  ↓
POSSIBLE IMPACT ON THE OS
~~~

Community discussion can be a useful observation source, but must never become authoritative truth merely through volume of agreement.

#### Hierarchical Architecture + Semantic Graph

The future site-architecture model should combine:

- hierarchy for navigation and topical organization
- semantic relationships between pages/entities/intents
- internal-link prominence and contextual relationships

Do not encode a rigid silo or "link juice ladder" model.

### Future growth domains

The same operating-system architecture may later extend to:

- PPC
- paid social
- CRO
- email
- additional acquisition channels

These are deliberately outside the current SEO/GEO implementation scope.

---

# 42. Production Hardening / Scale Requirements

Before the system is treated as production-grade for broad external use, complete:

- universal API governance for all Google/analytics/visibility flows
- rate limiting and abuse protection
- systematic auth/authorization instead of legacy allowlists
- secret management verification
- operation/job observability
- error budgets and circuit breakers
- idempotency
- audit logs
- cache integrity
- provider failure handling
- automated regression tests
- browser acceptance tests
- deployment safety
- schema migration discipline
- documentation/ADR upkeep

Existing legacy calendar/email functions must not silently become the pattern for new Visibility OS APIs.

---

# 43. Implementation Rules That Must Always Hold

1. Extend existing architecture; do not create parallel subsystems for the same capability.
2. Firestore remains the system of record.
3. External providers remain adapters.
4. Website is evidence, not the Search Universe.
5. Owner truth outranks AI inference.
6. Search volume is evidence, not strategy.
7. Search demand is not page demand.
8. A new query does not automatically justify a new URL.
9. Existing intent ownership should default toward improving the owner page.
10. Every important recommendation must be evidence-backed and explainable.
11. Predictions use ranges, not false precision.
12. Baselines are immutable.
13. Correlation must not be presented as proven causation.
14. Recent material changes should prevent recommendation churn during observation windows.
15. Expensive analysis must be cached and reuse must cost $0.
16. Cache/governance/quota failures are fail-closed.
17. UI rendering must never trigger paid provider calls.
18. Rejected owner decisions are durable negative signals.
19. Do not smuggle later milestones into an earlier milestone.
20. No action is a valid system outcome.
21. Time-sensitive external SEO/GEO/API assumptions must be freshness-verified against current evidence before they drive a major milestone implementation.
22. The system must preserve whether a claim is current fact, observed behavior, inference, hypothesis, or historical practice; stale claims must not silently become architecture.

---

# 44. Master Acceptance Criteria

The architecture is complete only when the system can reliably answer a newly discovered query/topic:

1. What does the business actually offer?
2. What entity is this about?
3. What is the user's task?
4. What intent does it represent?
5. Is the intent already owned?
6. If yes, by which page?
7. Should that page be improved?
8. If not, is a new page justified?
9. What evidence supports the decision?
10. What would make the proposed page unique?
11. What internal links should connect it?
12. What technical/schema requirements apply?
13. What is the expected business/SEO/GEO value?
14. What confidence does the system have?
15. What is the cost of performing the analysis?
16. Was the analysis already performed and cached?
17. What baseline existed before implementation?
18. What is the expected first-signal range?
19. What is the expected meaningful-impact range?
20. When should the system check again?
21. What happened after implementation?
22. Did the result fall inside the predicted range?
23. What was the prediction error?
24. How confident are we that the change caused the result?
25. What should the system learn?
26. What should it do next?
27. Does the LLM correctly understand the business and its important entities?
28. Is the recommendation inside the current milestone boundary?

When these questions can be answered reliably, the system has moved from SEO research automation toward a genuine SEO operating system.

---

# 45. Canonical Document Status

This file is the canonical Source of Truth for the GuyHadas Visibility OS. Section 46 formalizes freshness verification so the document itself can remain current.

Any implementation agent must:

1. read this file first
2. inspect the current repository state
3. respect the current milestone boundary
4. reuse existing architecture
5. update implementation notes/ADRs when architecture changes
6. keep roadmap/status synchronized
7. never invent missing requirements merely because the code does not yet implement them
8. explicitly document blocked or deferred capabilities


## 46. Freshness / Current Truth Layer

The GuyHadas Visibility OS must remain current as the external search ecosystem changes.

This is a permanent architecture requirement, not a future optional feature.

### 46.1 Freshness gate

Before a major milestone is implemented, any time-sensitive external assumption that materially affects the milestone must be re-verified against current evidence.

Prioritize:

1. official Google Search / Search Console documentation
2. official Google Search Status / anomaly information
3. official provider API documentation
4. current platform/product documentation
5. high-quality secondary sources
6. practitioner/community observations as supporting evidence

### 46.2 Claim lifecycle

Important external claims should conceptually support:

~~~
claim
source
source_type
source_date
verified_at
confidence
status
supersedes
contradicted_by
~~~

Suggested statuses:

~~~
CURRENT
CHANGED
UNCERTAIN
HYPOTHESIS
HISTORICAL
~~~

### 46.3 What this protects against

The system must be able to detect when:

- an API capability or limit changes
- a Google Search feature launches or retires
- a structured-data feature changes
- a Search Console reporting surface changes
- a ranking/spam update changes the interpretation window
- an external SEO practice is no longer supported by current evidence
- an old best practice should now be treated as historical rather than current

### 46.4 Current October 2026 verified facts that affect architecture

At the time of this document refresh:

- Search Analytics API rowLimit supports up to 25,000 rows per request; Google documents internal limits and does not guarantee all rows. The daily maximum documented for Search Analytics is 50,000 rows per search type.
- Search Console has current generative-AI performance reporting for Search / Discover, including AI Overviews and AI Mode.
- Search Console has global web multimodal search performance reporting introduced in September 2026.
- Google states there are no additional technical requirements specifically for AI Overviews / AI Mode beyond the normal Search eligibility and best practices.
- Google updated generative-AI content guidance in October 2026 and its spam policies apply to generative-AI responses as well as classic Search.
- FAQ rich results were deprecated beginning May 7, 2026.
- Semrush's current API documentation recommends v4 for new Keyword Reports integrations; v3 Keyword Reports are deprecated, while non-migrated reports remain available in v3.

These facts are external and time-sensitive. They must be re-verified rather than treated as permanent truths.

### 46.5 Canonical external sources

Google Search documentation:
https://developers.google.com/search/

Google Search documentation updates:
https://developers.google.com/search/updates

Search Console API:
https://developers.google.com/webmaster-tools/v1/searchanalytics/query

Search Console data anomalies:
https://support.google.com/webmasters/answer/6211453

Google Search Status Dashboard:
https://status.search.google.com/

Google AI features:
https://developers.google.com/search/docs/appearance/ai-features

Google generative-AI Search performance:
https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports

Google multimodal Search Console reporting:
https://developers.google.com/search/blog/2026/09/web-multimodal-in-sc

Google generative-AI content:
https://developers.google.com/search/docs/fundamentals/using-gen-ai-content

Google spam policies:
https://developers.google.com/search/docs/essentials/spam-policies

Semrush API v4:
https://developer.semrush.com/api/v4/seo/overview/
https://developer.semrush.com/api/v4/seo/keyword-reports/

This section does not authorize implementation of the freshness system yet. It establishes the architecture rule and the evidence baseline.
