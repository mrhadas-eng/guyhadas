import { auth } from "../firebase";
import type { Ga4SnapshotData, SearchConsoleSnapshotData, CrawlReport, CostControlDecision, SeedBuildResult, SeedRef } from "../types";

// Thin wrapper around the Visibility OS Cloud Functions (functions/visibility.js,
// Milestone 2+). Same deployment shape as the existing public-site functions
// (functions.https.onRequest, manual CORS, us-central1 - see public/*.js),
// but every one of these additionally requires a Firebase ID token, which
// the function verifies server-side against the admin allowlist.
const FUNCTIONS_BASE = "https://us-central1-guyhadas-e38c4.cloudfunctions.net";

async function callFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error("לא מחובר");
  const idToken = await user.getIdToken();

  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify(body)
  });

  const json = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok || json.success === false) {
    const message = typeof json.error === "string" ? json.error : `${name} נכשל (${res.status})`;
    // Keep the governor's fields (blockedReason, cacheDecision,
    // providerCalled) so the UI can say exactly what happened.
    throw Object.assign(new Error(message), { details: json });
  }
  return json as T;
}

export interface Ga4PropertyOption {
  propertyId: string;
  displayName: string;
  accountName: string;
}

export interface SearchConsoleSiteOption {
  siteUrl: string;
  permissionLevel: string;
}

export async function listGa4Properties(): Promise<Ga4PropertyOption[]> {
  const res = await callFunction<{ properties: Ga4PropertyOption[] }>("visibilityListGa4Properties", {});
  return res.properties;
}

export async function listSearchConsoleSites(): Promise<SearchConsoleSiteOption[]> {
  const res = await callFunction<{ sites: SearchConsoleSiteOption[] }>("visibilityListSearchConsoleSites", {});
  return res.sites;
}

export function connectIntegration(
  businessId: string,
  provider: "ga4" | "search_console",
  propertyId: string,
  propertyLabel: string
): Promise<void> {
  return callFunction<void>("visibilityConnectIntegration", { businessId, provider, propertyId, propertyLabel });
}

export function disconnectIntegration(businessId: string, provider: "ga4" | "search_console"): Promise<void> {
  return callFunction<void>("visibilityDisconnectIntegration", { businessId, provider });
}

// Ga4SnapshotData / SearchConsoleSnapshotData live in types.ts - they're the
// same shape functions/visibility.js writes into trafficSnapshots/
// searchSnapshots, which the Traffic/Search tabs read back directly from
// Firestore (see lib/firestore.ts), so there's one definition, not two.

export async function syncGa4(businessId: string): Promise<Ga4SnapshotData> {
  const res = await callFunction<{ data: Ga4SnapshotData }>("visibilitySyncGa4", { businessId });
  return res.data;
}

export async function syncSearchConsole(businessId: string): Promise<SearchConsoleSnapshotData> {
  const res = await callFunction<{ data: SearchConsoleSnapshotData }>("visibilitySyncSearchConsole", { businessId });
  return res.data;
}

// --- Search Universe discovery (functions/searchUniverse.js) ---
// Each call runs Discovery + automatic Filtering + Normalization server-side
// and writes straight into searchTopics/keywords/competitors (see
// firestore.rules) - Owner Validation then happens as plain client writes
// to those same collections (see the search-topic functions below), not
// through another Cloud Function call.

export interface DiscoveryResult {
  discovered: number;
  topicsCreated: number;
  topicsMerged: number;
  excluded: number;
  refreshed: number;
  ignored?: number;
  competitorsFound?: number;
  // Governed (Semrush) calls only - see functions/apiUsage.js.
  cacheHit?: boolean;
  cacheDecision?: string;
  providerCalled?: boolean;
  providerUnitsUsed?: number;
  seed?: SeedRef;
}

export interface GovernedErrorDetails {
  blockedReason?: string;
  cacheDecision?: string;
  providerCalled?: boolean;
}

export function governedDetails(err: unknown): GovernedErrorDetails | null {
  const d = (err as { details?: GovernedErrorDetails } | null)?.details;
  return d && typeof d === "object" ? d : null;
}

// Seeds from the confirmed Service Map (Firestore reads only - no
// provider call, no cost).
export function buildSearchSeeds(businessId: string): Promise<SeedBuildResult> {
  return callFunction<SeedBuildResult>("visibilityBuildSearchSeeds", { businessId });
}

export function discoverFromSearchConsole(businessId: string): Promise<DiscoveryResult> {
  return callFunction<DiscoveryResult>("visibilityDiscoverFromSearchConsole", { businessId });
}

// Market discovery for one seed. Normal run: a cached result is reused for
// $0; on a miss it is a governed paid call (quota-checked). The server
// rebuilds the phrase from the confirmed Service Map - only the key is sent.
export function discoverFromSemrushSeed(businessId: string, seedKey: string): Promise<DiscoveryResult> {
  return callFunction<DiscoveryResult>("visibilityDiscoverFromSemrush", { businessId, seedKey });
}

// PAID: bypasses the cache. Only after explicit owner confirmation
// (components/review/ConfirmPaidRunDialog).
export function discoverFromSemrushSeedNewPaidRun(businessId: string, seedKey: string): Promise<DiscoveryResult> {
  return callFunction<DiscoveryResult>("visibilityDiscoverFromSemrush", { businessId, seedKey, forceRefresh: true });
}

export function discoverDomainFromSemrush(businessId: string): Promise<DiscoveryResult> {
  return callFunction<DiscoveryResult>("visibilityDiscoverDomainFromSemrush", { businessId });
}

export function discoverDomainFromSemrushNewPaidRun(businessId: string): Promise<DiscoveryResult> {
  return callFunction<DiscoveryResult>("visibilityDiscoverDomainFromSemrush", { businessId, forceRefresh: true });
}

// --- Business & Service Discovery (functions/businessUnderstanding.js) ---
// Runs BEFORE search discovery in the corrected pipeline: seeds confirmed
// services from onboarding's services[] field (no AI, no cost), then - only
// if ANTHROPIC_API_KEY is configured - scrapes the business's website for
// evidence and asks Claude to propose additional services, landing as
// ownerStatus "needs_review" in businessServices (see lib/firestore.ts for
// the owner-validation writes: confirm/reject/edit/manual add).

export interface AnalyzeBusinessResult {
  ownerServicesSeeded: number;
  aiServicesProposed: number;
  aiServicesMerged: number;
  pagesScanned: number;
  aiAvailable: boolean;
  aiError: string | null;
  // Universal External API Cost-Control Rule fields (see
  // functions/apiUsage.js and the project doc). aiBlockedReason is set
  // instead of aiError when the call was never attempted because a
  // budget/quota/circuit-breaker limit was already hit -
  // "blocked_by_budget" | "blocked_by_quota" | "blocked_by_safety_limit".
  // aiCacheHit means the website evidence + confirmed services were
  // unchanged since the last successful analysis, so Claude was not
  // called again - the services shown are the same ones from that run.
  // aiCostUsd is the real, token-based cost of this specific call (null
  // on a cache hit, a block, or when AI isn't configured).
  aiBlockedReason: "blocked_by_budget" | "blocked_by_quota" | "blocked_by_safety_limit" | null;
  aiCacheHit: boolean;
  aiCostUsd: number | null;
  // null when the business has no website set.
  crawl: CrawlReport | null;
  // AI proposals that matched an owner-rejected item and were ignored.
  aiRejectedSkipped?: number;
  costControl: CostControlDecision;
  status: "completed" | "blocked" | "ai_error";
  analysisRunId: string | null;
}

// CrawlReport lives in types.ts (shared with businessAnalysisRuns records).
export type { CrawlReport, CostControlDecision };

// Normal analysis: reuses the cached AI result when the input is unchanged
// ($0). Never bypasses the cache.
export function analyzeBusiness(businessId: string): Promise<AnalyzeBusinessResult> {
  return callFunction<AnalyzeBusinessResult>("visibilityAnalyzeBusiness", { businessId });
}

// PAID: bypasses the cache and calls Claude. Only call after the owner
// explicitly confirmed a new paid run (components/review/ConfirmPaidRunDialog).
export function analyzeBusinessNewPaidRun(businessId: string): Promise<AnalyzeBusinessResult> {
  return callFunction<AnalyzeBusinessResult>("visibilityAnalyzeBusiness", { businessId, forceRefresh: true });
}

// --- M4 Search Intelligence & Baseline (functions/searchIntelligence.js) ---
// Button-triggered only. The run crawls the business's own site and makes one
// governed Search Console request (cached; quota-limited; no $ cost). No
// Semrush, GA4 or LLM call.

export interface IntelligenceRunResult {
  runId: string;
  summary: Record<string, unknown>;
  gsc: { status: string; decision: string | null; cacheHit: boolean; providerCalled: boolean; reason: string | null; blockedReason: string | null };
  crawl: { status: string; reason: string | null };
}

export function runSearchIntelligence(businessId: string): Promise<IntelligenceRunResult> {
  return callFunction<IntelligenceRunResult>("visibilityRunSearchIntelligence", { businessId });
}

export interface CaptureBaselineResult {
  baselineId: string;
  version: number;
  identicalToPrevious: boolean;
  availability: Record<string, string>;
}

// Always creates a NEW immutable version - never updates an existing one.
export function captureBaseline(businessId: string, note?: string): Promise<CaptureBaselineResult> {
  return callFunction<CaptureBaselineResult>("visibilityCaptureBaseline", { businessId, note });
}

// --- M5 Opportunity Engine (functions/opportunityEngine.js) ---
// Explicit button only. Reads Firestore only - no provider call, no cost.
export interface OpportunityEngineResult {
  cacheHit: boolean;
  decision: "cache_hit" | "computed";
  runId: string;
  providerCalled: false;
  summary: { opportunities: number; created?: number; updated?: number; resolved?: number; noAction: number; waitForData: number };
}

export function runOpportunityEngine(businessId: string): Promise<OpportunityEngineResult> {
  return callFunction<OpportunityEngineResult>("visibilityRunOpportunityEngine", { businessId });
}

export interface DecisionEngineResult {
  cacheHit: boolean;
  decision: "computed" | "cache_hit" | "in_progress";
  inProgress?: boolean;
  outcome?: "DECISIONS" | "WAIT_FOR_DATA";
  reason?: string;
  runId: string;
  providerCalled: false;
  written: number;
  summary: { intents: number; decisions: number; byDecision: Record<string, number>; creates?: number } | null;
}

// M6 - explicit owner action only (button). Firestore only, no provider.
export function runDecisionEngine(businessId: string): Promise<DecisionEngineResult> {
  return callFunction<DecisionEngineResult>("visibilityRunDecisionEngine", { businessId });
}

// --- M7 Prediction, Change & Experiment Tracking (functions/trackingEngine.js) ---
// Explicit owner actions only (button / form). Firestore only - no provider.
export interface TrackingRunResult {
  cacheHit: boolean;
  decision: "computed" | "cache_hit" | "in_progress";
  runId?: string;
  providerCalled: false;
  written: number;
  summary: Record<string, number> | null;
}

export function runTracking(businessId: string): Promise<TrackingRunResult> {
  return callFunction<TrackingRunResult>("visibilityRunTracking", { businessId });
}

export interface RecordImplementationInput {
  decisionId: string;
  implementedDate: string;
  publishedDate?: string | null;
  targetUrl?: string | null;
  changedElements: string[];
  intentChange?: boolean;
  implementationMatch: "full" | "partial" | "different";
  deviationNote?: string | null;
  responsibleActor: { type: "owner" | "contractor" | "agency" | "system"; name?: string | null };
  implementationNotes?: string;
  ownerAttestation: boolean;
}

export interface RecordImplementationResult {
  decision?: "in_progress";
  duplicate?: boolean;
  reverted?: boolean;
  changeEventId?: string;
  predictionId?: string;
  predictionDerivation?: string;
  experimentId?: string | null;
  experimentState?: string | null;
  beforeSnapshot?: { status: string; reason?: string };
  providerCalled: false;
  written: number;
}

export function recordImplementation(businessId: string, input: RecordImplementationInput): Promise<RecordImplementationResult> {
  return callFunction<RecordImplementationResult>("visibilityRecordImplementation", { businessId, ...input });
}

export function revertImplementation(businessId: string, changeEventId: string, revertNote: string): Promise<RecordImplementationResult> {
  return callFunction<RecordImplementationResult>("visibilityRecordImplementation", { businessId, action: "revert", changeEventId, revertNote });
}
