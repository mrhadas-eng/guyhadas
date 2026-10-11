// GuyHadas Visibility OS - shared data model types.
// Collections are top-level in Firestore with a businessId field, not
// nested subcollections (see architecture assessment in the project docs).

export type BusinessStatus = "active" | "paused" | "onboarding";

export interface Business {
  id: string;
  businessNumber: number; // 1, 2, 3... purely a display label, not used in logic
  name: string;
  website?: string;
  industry?: string;
  description?: string;
  primaryMarket?: string;
  geographicMarkets?: string[];
  languages?: string[];
  targetAudience?: string;
  services?: string[];
  businessObjectives?: string;
  primaryConversionGoals?: string;
  status: BusinessStatus;
  createdAt: unknown; // Firestore Timestamp
  baselineDate?: string | null; // ISO date of the latest immutable baseline (M4 sets it server-side; pointer only)
  latestBaselineId?: string | null; // baselines/{id} - the immutable snapshot (M4)
}

export type IntegrationProvider = "ga4" | "search_console" | "semrush" | "openai" | "anthropic" | "xai" | "n8n";
export type IntegrationStatus = "connected" | "not_connected" | "auth_required" | "error";

export interface Integration {
  id: string;
  businessId: string | null; // null for account-level integrations (e.g. Semrush key itself)
  provider: IntegrationProvider;
  status: IntegrationStatus;
  propertyId?: string | null;
  propertyLabel?: string | null;
  lastSyncedAt?: unknown | null;
  errorMessage?: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export type TaskStatus = "todo" | "in_progress" | "waiting_for_human" | "completed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: string;
  businessId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner?: string;
  dueDate?: string | null; // ISO date
  source?: string; // e.g. "manual", later: "opportunity_engine", "ai_agent"
  opportunityId?: string | null;
  expectedOutcome?: string;
  createdAt: unknown;
  completedAt?: unknown | null;
}

export type OpportunityStatus =
  | "new"
  | "researching"
  | "approved"
  | "in_progress"
  | "completed"
  | "rejected"
  | "monitoring";

export interface Opportunity {
  id: string;
  businessId: string;
  title: string;
  query?: string;
  topic?: string;
  type?: string;
  description?: string;
  priority: TaskPriority;
  score?: number | null;
  status: OpportunityStatus;
  source?: string; // e.g. "manual", later: "opportunity_engine"
  relatedPage?: string | null;
  potentialValue?: string | null;
  createdAt: unknown;
  updatedAt: unknown;
  // --- M5 Opportunity Engine fields (source "opportunity_engine"; written
  // by the Cloud Function only - see firestore.rules) ---
  dedupeKey?: string;
  candidateActions?: string[];
  targetTopicIds?: string[];
  targetPageKeys?: string[];
  factors?: OpportunityFactor[];
  evidence?: OpportunityEvidence[];
  confidence?: "high" | "medium" | "low";
  confidenceReasons?: string[];
  estimatedEffort?: { level: number; basis: string };
  missing?: string[];
  engineState?: "active" | "resolved";
  firstDetectedAtMs?: number;
  lastDetectedAtMs?: number;
  detectionCount?: number;
  baselineId?: string | null;
  baselineMatchesRun?: boolean;
  sourceRunId?: string;
  ownerNote?: string;
  decisionId?: string | null; // M6 link (written by the Decision Engine)
}

export interface OpportunityFactor {
  key: string;
  level: number | null;
  weight: number;
  contribution: number | null;
  basis: string;
  explanation: string;
  notApplicable?: boolean;
}

export interface OpportunityEvidence {
  id: string;
  sourceType: string;
  sourceRef: { collection: string; docId: string; field: string | null };
  observation: string | null;
  basis: string;
  capturedAtMs: number | null;
}

export interface OpportunityRun {
  id: string;
  businessId: string;
  status: "running" | "completed";
  completedAtMs?: number;
  outcome?: string;
  reason?: string;
  intelligenceRunId: string | null;
  baselineId: string | null;
  baselineMatchesRun?: boolean;
  topicEvaluations: { topicId: string; title: string; outcome: "opportunities" | "NO_ACTION" | "WAIT_FOR_DATA"; reasons?: string[]; types?: string[] }[];
  summary: { opportunities: number; created?: number; updated?: number; resolved?: number; byPriority: Record<string, number>; byType: Record<string, number>; noAction: number; waitForData: number; approvedTopics: number };
  weightsOverride?: Record<string, number>;
  engineVersion?: number;
  configVersion?: number;
}

// --- M6 Decision Engine (engine-generated; owner may set only ownerStatus /
// ownerNote - see firestore.rules) ---
export type DecisionValue = "CREATE" | "IMPROVE" | "CONSOLIDATE" | "WAIT" | "MONITOR" | "REJECT";
export type DecisionOwnerStatus = "pending" | "accepted" | "rejected" | "deferred";

export interface DecisionCandidate {
  pageKey: string;
  url: string;
  sources: string[];
  role?: string | null;
  observedShare: number | null;
  clickShare: number | null;
  bestPosition: number | null;
  eligibility: string;
  blocker: string | null;
  intentFit: string;
  entityFit: boolean | null;
}

export interface Decision {
  id: string;
  decisionId: string;
  businessId: string;
  scope: "intent" | "page" | "site";
  intentId: string | null;
  pageKey: string | null;
  signalKey: string | null;
  unitTitle: string;
  opportunityIds: string[];
  decision: DecisionValue;
  actionDetail: string | null;
  actionDetails?: string[];
  confidence: "high" | "medium" | "low";
  confidenceReasons: string[];
  reasonCodes: string[];
  blockingConditions: string[];
  existingOwnerPageKey: string | null;
  existingOwnerUrl: string | null;
  recommendedPage: { kind: string; pageKey: string | null; url: string | null; intentId?: string; note?: string };
  ownership: { status: string; acceptable: boolean; confidence: string; candidates: DecisionCandidate[] } | null;
  collision: { status: string; reason: string; pairs: { a: string; b: string; status: string; reason: string }[] } | null;
  proposedPageCollision?: { status: string; reason: string };
  newPageJustification: { evaluated: boolean; justified: boolean; distinctOn: string[]; reason: string | null; distinctValue: Record<string, unknown> | null };
  cluster: { clusterId: string; siblingIntentIds: string[]; parentPageKey: string | null; parentPageUrl?: string | null } | null;
  dependencies: { decisionId: string; relation: string }[];
  consolidation: { recommendedOwnerPageKey: string; recommendedOwnerUrl: string; otherPageKeys: string[]; statement: string; declaredCanonicals: { pageKey: string; declaredCanonical: string; note: string }[]; googleSelectedCanonical: null } | null;
  alternativesConsidered: { decision: string; target?: string; rejectedBecause: string[] }[];
  deferredCreate?: { reason: string } | null;
  businessValue: {
    relevance: { level: number | null; basis: string };
    commercialValue: { level: number | null; basis: string };
    marketDemand: { status: string; monthlyVolume: number | null; basis: string; source: string | null };
    observedVisibility: { status: string; impressions: number | null; clicks: number | null; basis: string; source: string | null };
  } | null;
  evidence: OpportunityEvidence[];
  missing: string[];
  summary: string;
  ownerStatus: DecisionOwnerStatus;
  ownerNote?: string;
  ownerStatusResetReason?: string | null;
  engineState: "active" | "superseded";
  previousDecision?: string | null;
  decisionHistory: { decision: string; confidence: string | null; at: number; event?: string; previousDecision?: string; reasonCodes: string[] }[];
  firstDecidedAtMs?: number;
  lastEvaluatedAtMs?: number;
  decisionRunId?: string;
  modelVersion?: number;
  configVersion?: number;
}

export interface SearchIntent {
  id: string;
  intentId: string;
  businessId: string;
  title: string;
  topicIds: string[];
  topicTitles?: string[];
  queryCount: number;
  sampleQueries: string[];
  intentType: string;
  secondaryIntentTypes: string[];
  intentConfidence: string;
  userTask: { verb: string | null; object: string; qualifiers: { geography: string | null; audience: string | null; priceSensitivity: boolean } };
  entityRefs: { id: string; type: string; label: string; basis: string; ownerDeclared?: boolean }[];
  clusterId: string;
  status: "active" | "superseded";
}

export interface DecisionRun {
  id: string;
  businessId: string;
  status: "running" | "completed";
  completedAtMs?: number;
  outcome?: "DECISIONS" | "WAIT_FOR_DATA";
  reason?: string;
  policy?: { createBudgetPerRun: number; createsPerClusterPerRun: number; sources: Record<string, string> };
  summary: { intents: number; decisions: number; byDecision: Record<string, number>; creates?: number; createCandidates?: number; created?: number; changed?: number; superseded?: number };
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "לביצוע",
  in_progress: "בתהליך",
  waiting_for_human: "ממתין לאדם",
  completed: "הושלם",
  cancelled: "בוטל"
};

export const OPPORTUNITY_STATUS_LABELS: Record<OpportunityStatus, string> = {
  new: "חדש",
  researching: "במחקר",
  approved: "אושר",
  in_progress: "בתהליך",
  completed: "הושלם",
  rejected: "נדחה",
  monitoring: "במעקב"
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "נמוכה",
  medium: "בינונית",
  high: "גבוהה"
};

// --- Historical snapshots (Milestone 3) ---
// Written only by the visibilitySyncGa4 / visibilitySyncSearchConsole /
// visibilityDailySync Cloud Functions (functions/visibility.js) - this is
// the read-only shape the Traffic/Search tabs chart and compare against the
// business's baselineDate.

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface Ga4SnapshotData {
  sessions: number;
  totalUsers: number;
  conversions: number;
  engagementRate: number;
  byChannel: { channel: string; sessions: number }[];
}

export interface TrafficSnapshot {
  id: string;
  businessId: string;
  source: "ga4";
  sourceProperty: string;
  retrievedAt: unknown; // Firestore Timestamp
  dateRange: DateRange;
  data: Ga4SnapshotData;
}

export interface SearchConsoleSnapshotData {
  clicks: number;
  impressions: number;
  ctr: number;
  avgPosition: number;
  topQueries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
}

export interface SearchSnapshot {
  id: string;
  businessId: string;
  source: "search_console";
  sourceProperty: string;
  retrievedAt: unknown; // Firestore Timestamp
  dateRange: DateRange;
  data: SearchConsoleSnapshotData;
}

export const INTEGRATION_LABELS: Record<IntegrationProvider, string> = {
  ga4: "Google Analytics 4",
  search_console: "Google Search Console",
  semrush: "Semrush",
  openai: "OpenAI",
  anthropic: "Anthropic / Claude",
  xai: "xAI / Grok",
  n8n: "n8n"
};

// --- Search Universe & Qualification (roadmap Milestone 3) ---
// Discovery → Filtering → Normalization → Owner Validation → Approved
// Search Universe. See functions/searchUniverse.js for the discovery/
// filtering/normalization pipeline that writes these, and
// claude/visibility-os-search-universe-plan.md (project docs) for the
// reasoning behind this shape.

// "What the system knows/learns about the business" - distinct from
// `businesses`, which is "what the business is" (the static profile from
// Milestone 1). Owner-entered entries (exclusion_rule, strategic_priority,
// brand_terminology, business_rule) are source="owner", confidence=
// "observed" - a direct statement from the person who knows. System-entered
// entries (discovered_fact, learned_insight) aren't written by this
// milestone yet (that starts in M4/M9) but the shape supports them now so
// nothing needs to migrate later: confidence distinguishes a directly
// measured fact ("observed") from a system judgment/pattern ("inferred").
export type KnowledgeType =
  | "exclusion_rule"
  | "strategic_priority"
  | "brand_terminology"
  | "business_rule"
  | "discovered_fact"
  | "learned_insight";
export type KnowledgeSource = "owner" | "system";
export type KnowledgeConfidence = "observed" | "inferred";

export interface BusinessKnowledge {
  id: string;
  businessId: string;
  type: KnowledgeType;
  content: string;
  source: KnowledgeSource;
  confidence: KnowledgeConfidence;
  relatedTopicId?: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

// "new" is this app's own addition, not one of the roadmap's five owner
// decisions (Relevant / Priority / Brand-Strategic / Exclude / Unsure) -
// every discovered topic starts here until the owner (or, for an obvious
// exclusion-rule match, automatic filtering) moves it to one of those five.
export type TopicStatus = "new" | "relevant" | "priority" | "brand_strategic" | "exclude" | "unsure";
export type DiscoverySource = "semrush" | "gsc" | "website" | "competitor" | "manual";

export interface SearchTopic {
  id: string;
  businessId: string;
  title: string;
  queries: string[]; // underlying raw queries grouped into this topic - retained per spec 3.4
  status: TopicStatus;
  source: DiscoverySource;
  addedBy: "system" | "owner";
  notes?: string;
  // M3.2 (additive; absent on topics created before it) - lineage and
  // lightweight, explained qualification. Never an owner decision.
  sources?: DiscoverySource[];
  sourceCount?: number;
  seedRefs?: SeedRef[];
  qualification?: TopicQualification;
  qualificationReasons?: QualificationReason[];
  preliminaryIntent?: PreliminaryIntent;
  lastDiscoveredAt?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export type TopicQualification = "likely_relevant" | "needs_review" | "possible_mismatch";
export type PreliminaryIntent = "commercial" | "informational" | "navigational" | "local" | "unclassified";
export type QualificationReasonCode =
  | "matches_confirmed_service"
  | "matches_owner_geography"
  | "matches_brand_term"
  | "matches_strategic_priority"
  | "matches_rejected_service"
  | "commercial_modifier"
  | "informational_modifier"
  | "no_confirmed_service_match";
export interface QualificationReason {
  code: QualificationReasonCode;
  detail: string | null;
}

// Lineage of a discovered query/topic back to the confirmed Service Map.
export interface SeedComponent {
  dimension: FacetDimension;
  value: string;
  provenance: FacetProvenance;
}
export interface SeedRef {
  seedKey: string;
  phrase: string;
  kind: SeedKind;
  serviceId: string;
  serviceName: string;
  components: SeedComponent[];
}
export type SeedKind = "service" | "service_geo" | "service_term" | "service_modifier";
export interface SearchSeed extends SeedRef {
  serviceIds: string[];
  servicePriority: TaskPriority;
  explanation: string;
  components: (SeedComponent & { origin: string; sourceUrl: string | null; pageCount: number | null })[];
}
export type SeedSkipReason =
  | "project_location_signal"
  | "script_mismatch"
  | "geo_cap"
  | "owner_exclusion_rule"
  | "matches_rejected_service"
  | "unverified_ai_inference";
export interface SkippedSeedInput {
  serviceId: string;
  serviceName: string;
  dimension: FacetDimension;
  value: string;
  provenance: FacetProvenance | null;
  reason: SeedSkipReason;
  rule?: string;
  pageCount?: number;
}
export interface SeedBuildResult {
  seeds: SearchSeed[];
  skipped: SkippedSeedInput[];
  droppedByCap: number;
  inputs: { confirmedServiceCount: number; rejectedServiceCount: number; ownerGeographies: string[] };
}

export interface KeywordSourceEvidence {
  sourceProperty?: string;
  report?: string;
  volume?: number;
  difficulty?: number;
  competition?: number;
  position?: number;
  url?: string;
  metrics?: { impressions?: number; clicks?: number; position?: number };
  timesSeen?: number;
  legacy?: boolean;
}

// One row per raw discovered phrase, independent of topic grouping - this
// is the provenance record spec 3.2 asks for ("preserve provenance for
// every discovery"). Not read back by the UI this milestone (a topic's own
// `queries` array is enough to display it) - exists for history/audit and
// for richer per-query data (volume/difficulty trends) later.
export interface Keyword {
  id: string;
  businessId: string;
  topicId: string | null;
  query: string;
  source: DiscoverySource;
  sourceProperty?: string | null;
  volume?: number | null;
  difficulty?: number | null;
  metrics?: { impressions?: number; clicks?: number; position?: number } | null;
  // M3.2: evidence per discovery source (never overwritten by another
  // source), seed lineage, how it was grouped, and - when an owner rule
  // excluded it - which rule (topicId is then null).
  sources?: Partial<Record<DiscoverySource, KeywordSourceEvidence>>;
  sourceList?: DiscoverySource[];
  seedRefs?: SeedRef[];
  grouping?: { rule: "exact" | "title_token_overlap" | "new_topic" | "existing_keyword"; score: number | null; topicTitle: string } | null;
  excludedByRule?: { ruleId: string; rule: string; reason: "owner_exclusion_rule" } | null;
  discoveredAt: unknown;
}

export interface Competitor {
  id: string;
  businessId: string;
  domain: string;
  discoveredVia: "semrush" | "manual";
  relevanceScore?: number | null;
  sharedKeywordCount?: number | null;
  addedAt: unknown;
}

export const TOPIC_STATUS_LABELS: Record<TopicStatus, string> = {
  new: "חדש",
  relevant: "רלוונטי",
  priority: "עדיפות",
  brand_strategic: "מותג / אסטרטגי",
  exclude: "הוחרג",
  unsure: "לא בטוח"
};

export const KNOWLEDGE_TYPE_LABELS: Record<KnowledgeType, string> = {
  exclusion_rule: "כלל החרגה",
  strategic_priority: "עדיפות אסטרטגית",
  brand_terminology: "מינוח מותג",
  business_rule: "כלל עסקי",
  discovered_fact: "עובדה שהתגלתה",
  learned_insight: "תובנה שנלמדה"
};

export const DISCOVERY_SOURCE_LABELS: Record<DiscoverySource, string> = {
  semrush: "Semrush · ביקוש שוק",
  gsc: "Search Console · נראות קיימת",
  website: "סריקת אתר (מושבת)",
  competitor: "מתחרה",
  manual: "ידני"
};

// --- Business & Service Discovery (roadmap Milestone 3.1) ---
// Inserted BEFORE Search Discovery in the corrected pipeline: Business
// Understanding -> Service Map -> (owner validation) -> Search Discovery
// seeds. See functions/businessUnderstanding.js for why this exists as its
// own collection rather than folding into businessKnowledge: a service is a
// structured, individually-validated unit (confirm/reject/edit/priority),
// not a freeform knowledge note.

export type ServiceSource = "owner" | "website" | "ai_inference" | "combined";
export type ServiceOwnerStatus = "confirmed" | "rejected" | "needs_review";

export interface BusinessService {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  source: ServiceSource;
  confidence: KnowledgeConfidence; // reuses "observed" | "inferred" from businessKnowledge
  ownerStatus: ServiceOwnerStatus;
  priority: TaskPriority;
  geographies: string[];
  evidence?: string[]; // short quotes/snippets backing an inferred service, for traceability
  // Milestone 3.1 refinement: per-quote source page, and whether the quote
  // was actually found in the scraped text (functions/serviceFacets.js).
  evidenceSources?: ServiceEvidence[];
  sourceUrls?: string[];
  // Structured interpretation underneath the human-readable `name` - the
  // separate dimensions M3.2 search discovery combines into seeds. Absent
  // on items created before this existed until the next analysis run.
  facets?: ServiceFacets;
  facetsVersion?: number;
  // Previous names after owner renames - still matched by later analyses.
  aliases?: string[];
  createdAt: unknown;
  updatedAt: unknown;
}

// owner = typed by the owner; website = value found verbatim in the
// scraped site text; ai_inference = AI interpretation not found verbatim.
export type FacetProvenance = "owner" | "website" | "ai_inference";

export interface FacetValue {
  value: string;
  provenance: FacetProvenance;
  sourceUrl: string | null;
  // Every crawled page the value appears on (absent on values stored
  // before page-level provenance was fixed).
  foundOn?: string[];
}

export type FacetDimension =
  | "services"
  | "projectTypes"
  | "audiences"
  | "markets"
  | "offerings"
  | "geographies"
  | "positioning"
  | "needs";

export type ServiceFacets = Partial<Record<FacetDimension, FacetValue[]>>;

export interface ServiceEvidence {
  quote: string;
  sourceUrl: string | null; // the page the quote came from - never rewritten
  verified: boolean; // found verbatim on that page in the crawl
  provenance?: "website" | "ai_inference"; // absent on evidence stored before 2026-10-07
  analysisInputHash?: string; // the analysis (cache identity) this evidence came from
}

export const FACET_DIMENSION_LABELS: Record<FacetDimension, string> = {
  services: "שירות",
  projectTypes: "סוג פרויקט",
  audiences: "קהל",
  markets: "שוק",
  offerings: "מודל שירות",
  geographies: "אזור",
  positioning: "מיצוב",
  needs: "צורך"
};

export const FACET_PROVENANCE_LABELS: Record<FacetProvenance, string> = {
  owner: "בעל/ת העסק",
  website: "מופיע באתר",
  ai_inference: "פרשנות AI"
};

export const SERVICE_SOURCE_LABELS: Record<ServiceSource, string> = {
  owner: "בעל/ת העסק",
  website: "אתר",
  ai_inference: "הסקת AI",
  combined: "בעל/ת העסק + AI"
};

export const SERVICE_OWNER_STATUS_LABELS: Record<ServiceOwnerStatus, string> = {
  confirmed: "מאושר",
  rejected: "נדחה",
  needs_review: "ממתין לבדיקה"
};

// What the website crawl actually did in one analysis run
// (functions/webUtils.js crawlSite + parsing in businessUnderstanding.js).
// Also stored permanently in the businessAnalysisRuns collection.
export interface CrawlReport {
  startUrl: string | null;
  siteHost: string | null;
  sitemap: string | null;
  pagesDiscovered: number;
  pagesSelected: number;
  pagesFetched: number;
  pagesParsed: number;
  discoveredVia: { homepageLinks: number; sitemap: number };
  parsedUrls: string[];
  failed: { url: string; reason: string }[];
  failedCount: number;
  skipped: { url: string; reason: string }[];
  skippedCount: number;
}

// What the cost-control layer decided for one analysis run
// (functions/apiUsage.js runGoverned), recorded on every run.
export type CacheDecision =
  | "cache_hit"
  | "cache_miss"
  | "forced_refresh"
  | "blocked_cache_unavailable"
  | "blocked_safety_check_unavailable"
  | "blocked_by_budget"
  | "blocked_by_quota"
  | "blocked_by_safety_limit"
  | "not_applicable";

export interface CostControlDecision {
  provider: string;
  analysisType: string;
  promptVersion: number;
  analysisVersion?: number;
  model: string | null;
  inputHash: string | null;
  cacheDecision: CacheDecision | null;
  cacheHit: boolean;
  forceRefresh: boolean;
  providerCalled: boolean;
  costUsd: number | null;
  cachedFromUsageId: string | null;
}

// One record per visibilityAnalyzeBusiness run (businessAnalysisRuns).
export interface BusinessAnalysisRun {
  id: string;
  businessId: string;
  kind: "service_map";
  completedAt: unknown;
  promptVersion: number;
  crawl: CrawlReport | null;
  ownerServicesSeeded: number;
  aiServicesProposed: number;
  aiServicesMerged: number;
  pagesScanned: number;
  aiAvailable: boolean;
  aiError: string | null;
  aiBlockedReason: string | null;
  aiCacheHit: boolean;
  aiCostUsd: number | null;
  costControl?: CostControlDecision; // absent on runs recorded before 2026-10-07 fix
  status?: "completed" | "blocked" | "ai_error";
}

// --- M3.2 labels ---
export const QUALIFICATION_LABELS: Record<TopicQualification, string> = {
  likely_relevant: "תואם שירות מאושר",
  needs_review: "לבדיקה",
  possible_mismatch: "ייתכן שלא רלוונטי"
};

export const INTENT_LABELS: Record<PreliminaryIntent, string> = {
  commercial: "מסחרי",
  informational: "מידע",
  navigational: "מותג",
  local: "מקומי",
  unclassified: "לא סווג"
};

export const QUALIFICATION_REASON_LABELS: Record<QualificationReasonCode, string> = {
  matches_confirmed_service: "תואם שירות מאושר",
  matches_owner_geography: "כולל אזור שירות שהגדרת",
  matches_brand_term: "כולל מונח מותג",
  matches_strategic_priority: "תואם עדיפות אסטרטגית",
  matches_rejected_service: "דומה לפריט שדחית",
  commercial_modifier: "מילה מסחרית",
  informational_modifier: "מילת מידע/שאלה",
  no_confirmed_service_match: "לא נמצא שירות מאושר תואם"
};

export const SEED_KIND_LABELS: Record<SeedKind, string> = {
  service: "שירות",
  service_geo: "שירות × אזור",
  service_term: "מונח שירות",
  service_modifier: "שירות × מאפיין"
};

export const SEED_SKIP_REASON_LABELS: Record<SeedSkipReason, string> = {
  project_location_signal: "מיקום של פרויקט (לא אזור שירות)",
  script_mismatch: "שפה/כתב שונים משם השירות",
  geo_cap: "מעבר למכסת האזורים לשירות",
  owner_exclusion_rule: "כלל החרגה שלך",
  matches_rejected_service: "תואם פריט שדחית",
  unverified_ai_inference: "פרשנות AI לא מאומתת"
};

// --- M4 Search Intelligence & Baseline (functions/searchIntelligenceStore.js) ---
// Read-only for the client (firestore.rules). Shapes are documented in
// docs/M4_IMPLEMENTATION_BRIEF.md; every block carries status/basis so
// observed facts, inferences and missing data stay distinguishable.

export type Availability = "available" | "not_available" | "no_observation";
export type Basis = "observed" | "inferred" | "unknown";

export interface Diagnostic {
  code: string;
  detail: string | null;
  basis: Basis;
}

export interface SeoPage {
  id: string;
  businessId: string;
  url: string;
  pageKey: string;
  httpStatus: number | null;
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  wordCount: number | null;
  indexability: { state: "indexable" | "non_indexable" | "unknown"; reasons: string[]; scope?: string };
  canonical: { state: "valid" | "missing" | "conflicting" | "points_elsewhere" | "unknown"; target: string | null };
  robots: { state: "crawlable" | "blocked" | "unknown"; rule?: string | null; reason?: string };
  sitemap: { state: "present" | "absent" | "unknown"; reason?: string };
  structuredData: { state: "present" | "missing" | "invalid"; types: string[] };
  links: { inboundInternalCount: number; outboundInternalCount: number; externalCount: number; scope: string };
  orphan: { state: string; scope?: string };
  role: { role: string; basis: Basis; rule: string };
  diagnostics: Diagnostic[];
  crawlStatus: "fetched" | "failed_last_run" | "not_crawled_last_run";
  lastRunReason?: string;
  lastCrawledAtMs: number;
}

export interface GscQueryRow {
  query: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number | null;
  pageCount: number;
}

export interface TopicIntelligence {
  id: string;
  topicId: string;
  businessId: string;
  title: string;
  ownerStatus: TopicStatus;
  queryCount: number;
  queries: string[];
  sourceMix: Record<string, number>;
  gscCurrent: {
    status: Availability;
    reason?: string;
    note?: string;
    period?: { startDate: string; endDate: string };
    impressions?: number;
    clicks?: number;
    ctr?: number;
    avgPosition?: number | null;
    queriesWithImpressions?: number;
    rankingDistribution?: Record<string, number>;
    queries?: GscQueryRow[];
    pages?: { url: string; pageKey: string; impressions: number; clicks: number; position: number | null; crawled: boolean }[];
    multiplePagesObserved?: boolean;
  };
  gscDiscovery: { status: Availability; reason?: string; window?: string; queriesObserved?: number; impressions?: number; clicks?: number };
  semrush: { status: Availability; reason?: string; totalMonthlyVolume?: number; maxDifficulty?: number | null; queriesWithVolume?: number; note?: string };
  pages: { observed: { url: string; pageKey: string; impressions: number; clicks: number; position: number | null }[]; contentMatched: { url: string; pageKey: string; rule: string }[] };
  technical: { pageKey: string; url: string; indexability: string; canonical: string; sitemap: string; structuredData: string; diagnostics: string[] }[];
  business: {
    linkedServices: { serviceId: string | null; name: string; confirmed: boolean; basis: Basis }[];
    geography: { value: string; provenance: string; basis: Basis }[];
    preliminaryIntent: string | null;
    commercialSignal: { present: boolean; basis: Basis };
  };
  serpContext: { status: Availability; reason?: string };
  emergence: { newQueriesLast30Days: number | null; basis: Basis };
  sourceConfidence: "high" | "medium" | "low";
  missing: string[];
  computedAtMs: number;
  superseded?: boolean;
}

export interface GeoSignal {
  key: string;
  status: "present" | "partial" | "missing" | "unknown";
  observation: string;
  evidencePages: string[];
  basis: Basis;
}

export interface IntelligenceRun {
  id: string;
  businessId: string;
  status: "running" | "completed";
  startedAtMs: number;
  completedAtMs?: number;
  inputs?: { approvedTopicIds: string[]; topicStatusCounts: Record<string, number> };
  crawl?: { status: Availability; reason: string | null; report: (CrawlReport & { pagesAnalyzed?: number }) | null; robots: { available: boolean; reason: string | null; note: string | null } | null };
  gsc?: { status: Availability; reason: string | null; blockedReason: string | null; decision: string | null; cacheHit: boolean; providerCalled: boolean; period: { startDate: string; endDate: string }; rowsReturned: number; possiblyTruncated: boolean };
  businessContext?: {
    searchConsole: { status: Availability; reason?: string; clicks?: number; impressions?: number; ctr?: number; avgPosition?: number; retrievedAtMs?: number | null };
    traffic: { status: Availability; reason?: string; sessions?: number; organicSessions?: number | null; conversions?: number; retrievedAtMs?: number | null };
    pageLevelTraffic: { status: Availability; reason?: string };
  };
  geoReadiness?: { signals: GeoSignal[]; summary: Record<string, number>; scope: string };
  semrush?: { status: Availability; reason: string };
  serpContext?: { status: Availability; reason: string };
  summary?: {
    approvedTopics: number;
    topicsWithGscVisibility: number;
    topicsWithSemrushDemand: number;
    topicsWithAssociatedPage: number;
    pagesAnalyzed: number;
    pagesIndexable: number;
    pagesNonIndexable: number;
    pagesWithStructuredData: number;
    pagesInSitemap: number;
    diagnostics: Record<string, number>;
  };
}

export interface Baseline {
  id: string;
  baselineId: string;
  businessId: string;
  version: number;
  capturedAtMs: number;
  capturedBy: string | null;
  note: string | null;
  sourceRunId: string | null;
  identicalToPrevious: boolean;
  contentHash: string;
  topics: { topicId: string; title: string }[];
  pages: { pageKey: string; url: string }[];
  availability: Record<string, string>;
  period: { gscQueryPage: { startDate: string; endDate: string } | null };
}

export const DIAGNOSTIC_LABELS: Record<string, string> = {
  non_indexable: "לא ניתן לאינדוקס",
  canonical_missing: "חסר קנוני",
  canonical_conflicting: "קנוני סותר",
  canonical_points_elsewhere: "קנוני מפנה לדף אחר",
  blocked_by_robots: "חסום ב-robots.txt",
  not_in_sitemap: "לא במפת האתר",
  structured_data_missing: "אין נתונים מובנים",
  structured_data_invalid: "נתונים מובנים לא תקינים",
  title_missing: "חסרה כותרת",
  title_duplicate: "כותרת כפולה",
  meta_description_missing: "חסר תיאור",
  meta_description_duplicate: "תיאור כפול",
  h1_missing: "חסר H1",
  h1_multiple: "כמה H1",
  no_inbound_from_crawled_pages: "אין קישור פנימי אליו (בדפים שנסרקו)",
  underlinked_candidate: "מקושר מדף אחד בלבד"
};

export const GEO_SIGNAL_LABELS: Record<string, string> = {
  business_identity: "זהות העסק",
  services_explicit: "שירותים מפורשים",
  locations_explicit: "אזורי שירות מפורשים",
  contact_details: "פרטי קשר",
  structured_data_coverage: "כיסוי נתונים מובנים",
  fact_consistency: "עקביות עובדות",
  audience_positioning: "קהל ומיצוב"
};

export const MISSING_LABELS: Record<string, string> = {
  gsc_current_not_available: "אין נתוני Search Console עדכניים לפי דף",
  no_gsc_observation_for_topic: "אין חשיפות ב-Search Console לשאילתות הנושא",
  semrush_demand_not_available: "אין נתוני ביקוש מ-Semrush",
  no_associated_page: "לא נמצא דף משויך",
  associated_page_not_in_crawl: "דף משויך לא נסרק",
  serp_context_not_available: "אין נתוני SERP"
};
