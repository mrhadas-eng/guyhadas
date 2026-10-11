import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  arrayUnion,
  limit,
  serverTimestamp,
  type Unsubscribe
} from "firebase/firestore";
import { db } from "../firebase";
import type {
  BusinessAnalysisRun,
  Business,
  Task,
  Opportunity,
  Integration,
  TrafficSnapshot,
  SearchSnapshot,
  BusinessKnowledge,
  SearchTopic,
  TopicStatus,
  Keyword,
  Competitor,
  BusinessService,
  ServiceOwnerStatus,
  TaskPriority,
  TopicIntelligence,
  SeoPage,
  IntelligenceRun,
  Baseline,
  OpportunityRun,
  Decision,
  DecisionOwnerStatus,
  DecisionRun,
  SearchIntent
} from "../types";

// How much history the Traffic/Search trend charts load. Milestone 3's
// scheduled sync adds roughly one snapshot per business per day, so 90
// covers about three months before this needs revisiting.
const SNAPSHOT_HISTORY_LIMIT = 90;

// Thin, typed wrappers around Firestore. No Cloud Functions in Milestone 1 -
// access is enforced entirely by firestore.rules (ADMIN_EMAILS), same
// pattern the existing public-site admin dashboard already uses for
// leads/settings.

// --- Businesses ---

export function listenBusinesses(cb: (businesses: Business[]) => void): Unsubscribe {
  const q = query(collection(db, "businesses"), orderBy("businessNumber", "asc"));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Business, "id">) })));
  });
}

export async function createBusiness(data: Omit<Business, "id" | "createdAt">) {
  return addDoc(collection(db, "businesses"), {
    ...data,
    createdAt: serverTimestamp()
  });
}

export async function updateBusiness(id: string, data: Partial<Business>) {
  return updateDoc(doc(db, "businesses", id), data as Record<string, unknown>);
}

// --- Tasks ---

export function listenTasks(businessId: string, cb: (tasks: Task[]) => void): Unsubscribe {
  const q = query(collection(db, "tasks"), where("businessId", "==", businessId));
  return onSnapshot(q, (snap) => {
    const tasks = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Task, "id">) }));
    tasks.sort((a, b) => {
      const ta = (a.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      const tb = (b.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      return tb - ta;
    });
    cb(tasks);
  });
}

export async function createTask(data: Omit<Task, "id" | "createdAt" | "completedAt">) {
  return addDoc(collection(db, "tasks"), {
    ...data,
    createdAt: serverTimestamp(),
    completedAt: null
  });
}

export async function updateTask(id: string, data: Partial<Task>) {
  return updateDoc(doc(db, "tasks", id), data as Record<string, unknown>);
}

export async function deleteTask(id: string) {
  return deleteDoc(doc(db, "tasks", id));
}

// --- Opportunities ---

export function listenOpportunities(businessId: string, cb: (opps: Opportunity[]) => void): Unsubscribe {
  const q = query(collection(db, "opportunities"), where("businessId", "==", businessId));
  return onSnapshot(q, (snap) => {
    const opps = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Opportunity, "id">) }));
    opps.sort((a, b) => {
      const ta = (a.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      const tb = (b.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      return tb - ta;
    });
    cb(opps);
  });
}

export async function createOpportunity(data: Omit<Opportunity, "id" | "createdAt" | "updatedAt">) {
  return addDoc(collection(db, "opportunities"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function updateOpportunity(id: string, data: Partial<Opportunity>) {
  return updateDoc(doc(db, "opportunities", id), {
    ...data,
    updatedAt: serverTimestamp()
  } as Record<string, unknown>);
}

export async function deleteOpportunity(id: string) {
  return deleteDoc(doc(db, "opportunities", id));
}

// --- Integrations (read-only in Milestone 1; Milestone 2 writes these from
// Cloud Functions once real Google/Semrush connections exist) ---

export function listenIntegrations(businessId: string, cb: (items: Integration[]) => void): Unsubscribe {
  const q = query(collection(db, "integrations"), where("businessId", "==", businessId));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Integration, "id">) })));
  });
}

export function listenAllTasksAcrossBusinesses(cb: (tasks: Task[]) => void): Unsubscribe {
  const q = query(collection(db, "tasks"));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Task, "id">) })));
  });
}

export function listenAllOpportunitiesAcrossBusinesses(cb: (opps: Opportunity[]) => void): Unsubscribe {
  const q = query(collection(db, "opportunities"));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Opportunity, "id">) })));
  });
}

export function listenAllIntegrations(cb: (items: Integration[]) => void): Unsubscribe {
  const q = query(collection(db, "integrations"));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Integration, "id">) })));
  });
}

// --- Historical snapshots (Milestone 3, read-only - see types.ts) ---

export function listenTrafficSnapshots(businessId: string, cb: (snapshots: TrafficSnapshot[]) => void): Unsubscribe {
  const q = query(
    collection(db, "trafficSnapshots"),
    where("businessId", "==", businessId),
    orderBy("retrievedAt", "asc"),
    limit(SNAPSHOT_HISTORY_LIMIT)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TrafficSnapshot, "id">) })));
  });
}

export function listenSearchSnapshots(businessId: string, cb: (snapshots: SearchSnapshot[]) => void): Unsubscribe {
  const q = query(
    collection(db, "searchSnapshots"),
    where("businessId", "==", businessId),
    orderBy("retrievedAt", "asc"),
    limit(SNAPSHOT_HISTORY_LIMIT)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SearchSnapshot, "id">) })));
  });
}

// --- Business & Service Discovery (roadmap Milestone 3.1) ---
// Business Understanding -> Service Map -> (owner validation below) ->
// Search Discovery seeds. visibilityAnalyzeBusiness (lib/functions.ts)
// populates this collection server-side; everything here is the owner
// reviewing/confirming/rejecting/editing what it proposed, or adding a
// service by hand.

export function listenBusinessServices(businessId: string, cb: (services: BusinessService[]) => void): Unsubscribe {
  const q = query(collection(db, "businessServices"), where("businessId", "==", businessId));
  return onSnapshot(q, (snap) => {
    const services = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<BusinessService, "id">) }));
    services.sort((a, b) => {
      const ta = (a.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      const tb = (b.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      return tb - ta;
    });
    cb(services);
  });
}

// The owner's three decisions on a proposed/existing service - a plain
// status+notes-free update, same shape as updateSearchTopicStatus.
export async function updateServiceStatus(id: string, ownerStatus: ServiceOwnerStatus) {
  return updateDoc(doc(db, "businessServices", id), { ownerStatus, updatedAt: serverTimestamp() });
}

export async function updateServicePriority(id: string, priority: TaskPriority) {
  return updateDoc(doc(db, "businessServices", id), { priority, updatedAt: serverTimestamp() });
}

// previousName: when the owner renames an item, its old name is kept in
// `aliases` so later analyses (incl. free cache-hit re-merges) still
// recognize it - a rename must never bring the AI's original wording back
// as a "new" candidate (functions/serviceMapMerge.js findKnownMatch).
export async function updateServiceDetails(
  id: string,
  data: { name?: string; description?: string; geographies?: string[] },
  previousName?: string
) {
  const renamed = previousName && data.name && data.name !== previousName;
  return updateDoc(doc(db, "businessServices", id), {
    ...data,
    ...(renamed ? { aliases: arrayUnion(previousName) } : {}),
    updatedAt: serverTimestamp()
  });
}

// Manual service add (source: "owner", confirmed immediately) - the owner
// typing it in IS the validation step, same precedent as createManualTopic.
export async function createManualService(businessId: string, name: string, description?: string, geographies?: string[]) {
  return addDoc(collection(db, "businessServices"), {
    businessId,
    name,
    description: description || "",
    source: "owner",
    confidence: "observed",
    ownerStatus: "confirmed",
    priority: "medium",
    geographies: geographies || [],
    evidence: [],
    // Same deterministic owner facets the server gives onboarding services
    // (functions/serviceFacets.js ownerFacets) - the owner's own words are
    // the core service; nothing else is guessed.
    facets: {
      services: [{ value: name, provenance: "owner", sourceUrl: null }],
      geographies: (geographies || []).map((g) => ({ value: g, provenance: "owner", sourceUrl: null }))
    },
    facetsVersion: 2,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

// Latest business-analysis run (crawl report + results), written by
// visibilityAnalyzeBusiness. Read-only here.
export function listenLatestAnalysisRun(businessId: string, cb: (run: BusinessAnalysisRun | null) => void): Unsubscribe {
  const q = query(
    collection(db, "businessAnalysisRuns"),
    where("businessId", "==", businessId),
    orderBy("completedAt", "desc"),
    limit(1)
  );
  return onSnapshot(
    q,
    (snap) => cb(snap.empty ? null : { id: snap.docs[0].id, ...(snap.docs[0].data() as Omit<BusinessAnalysisRun, "id">) }),
    // Missing index while it builds, or no permission: show "no run yet"
    // rather than breaking the page.
    () => cb(null)
  );
}

export async function deleteBusinessService(id: string) {
  return deleteDoc(doc(db, "businessServices", id));
}

// --- Search Universe & Qualification (roadmap Milestone 3.2) ---
// Discovery itself (populating searchTopics/keywords/competitors) runs
// server-side - see lib/functions.ts's discoverFromSearchConsole/Website/
// Semrush. Everything here is Owner Validation: the owner reading what was
// discovered and approving/rejecting/prioritizing/marking brand-strategic/
// leaving unsure/manually adding - all plain client writes, matching
// firestore.rules (admin read+write on all four collections).

// --- Business Knowledge ("what the system knows/learns about the
// business" - see types.ts for why this is separate from `businesses`) ---

export function listenBusinessKnowledge(businessId: string, cb: (items: BusinessKnowledge[]) => void): Unsubscribe {
  const q = query(collection(db, "businessKnowledge"), where("businessId", "==", businessId));
  return onSnapshot(q, (snap) => {
    const items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<BusinessKnowledge, "id">) }));
    items.sort((a, b) => {
      const ta = (a.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      const tb = (b.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      return tb - ta;
    });
    cb(items);
  });
}

// Owner-authored knowledge only (source: "owner", confidence: "observed") -
// the system itself doesn't write discovered_fact/learned_insight entries
// until a later milestone (see types.ts).
export async function createBusinessKnowledge(
  data: Omit<BusinessKnowledge, "id" | "source" | "confidence" | "createdAt" | "updatedAt">
) {
  return addDoc(collection(db, "businessKnowledge"), {
    ...data,
    source: "owner",
    confidence: "observed",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function deleteBusinessKnowledge(id: string) {
  return deleteDoc(doc(db, "businessKnowledge", id));
}

// --- Search Topics ---

export function listenSearchTopics(businessId: string, cb: (topics: SearchTopic[]) => void): Unsubscribe {
  const q = query(collection(db, "searchTopics"), where("businessId", "==", businessId));
  return onSnapshot(q, (snap) => {
    const topics = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SearchTopic, "id">) }));
    topics.sort((a, b) => {
      const ta = (a.updatedAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      const tb = (b.updatedAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      return tb - ta;
    });
    cb(topics);
  });
}

// The five owner decisions (relevant/priority/brand_strategic/exclude/
// unsure) plus moving a topic back to "new" - always a plain status+notes
// update, never a volume-based filter: manual/strategic topics must stay
// valid regardless of search volume (spec requirement), which this
// satisfies simply by never looking at volume here at all.
export async function updateSearchTopicStatus(id: string, status: TopicStatus, notes?: string) {
  return updateDoc(doc(db, "searchTopics", id), {
    status,
    ...(notes !== undefined ? { notes } : {}),
    updatedAt: serverTimestamp()
  });
}

// Manual topic/keyword add (source: "manual", addedBy: "owner") - the
// owner's own provenance tag, distinct from anything a discovery function
// would write. Defaults straight to "relevant" rather than "new", since the
// owner typing it in is itself the validation step.
export async function createManualTopic(businessId: string, title: string, notes?: string) {
  const topicRef = await addDoc(collection(db, "searchTopics"), {
    businessId,
    title,
    queries: [title],
    status: "relevant",
    source: "manual",
    sources: ["manual"],
    sourceCount: 1,
    addedBy: "owner",
    notes: notes || "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  await addDoc(collection(db, "keywords"), {
    businessId,
    topicId: topicRef.id,
    query: title,
    source: "manual",
    sourceProperty: null,
    volume: null,
    difficulty: null,
    metrics: null,
    sources: { manual: { report: "owner_added" } },
    sourceList: ["manual"],
    seedRefs: [],
    grouping: { rule: "new_topic", score: null, topicTitle: title },
    excludedByRule: null,
    discoveredAt: serverTimestamp()
  });
  return topicRef;
}

export function listenKeywordsForTopic(topicId: string, cb: (keywords: Keyword[]) => void): Unsubscribe {
  const q = query(collection(db, "keywords"), where("topicId", "==", topicId));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Keyword, "id">) })));
  });
}

// Raw queries an owner exclusion rule kept out of review (topicId null,
// excludedByRule set) - shown as historical negative signals.
export function listenRuleExcludedKeywords(businessId: string, cb: (keywords: Keyword[]) => void): Unsubscribe {
  const q = query(collection(db, "keywords"), where("businessId", "==", businessId), where("topicId", "==", null));
  return onSnapshot(q, (snap) => {
    cb(
      snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<Keyword, "id">) }))
        .filter((k) => !!k.excludedByRule)
    );
  });
}

// --- Competitors ---

export function listenCompetitors(businessId: string, cb: (items: Competitor[]) => void): Unsubscribe {
  const q = query(collection(db, "competitors"), where("businessId", "==", businessId));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Competitor, "id">) })));
  });
}

export async function addManualCompetitor(businessId: string, domain: string) {
  return addDoc(collection(db, "competitors"), {
    businessId,
    domain,
    discoveredVia: "manual",
    relevanceScore: null,
    sharedKeywordCount: null,
    addedAt: serverTimestamp()
  });
}

export async function deleteCompetitor(id: string) {
  return deleteDoc(doc(db, "competitors", id));
}

// --- M4 Search Intelligence & Baseline (read-only; written by Cloud Functions) ---

function byBusiness<T>(name: string, businessId: string, cb: (rows: T[]) => void): Unsubscribe {
  const q = query(collection(db, name), where("businessId", "==", businessId));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as T)));
}

export function listenTopicIntelligence(businessId: string, cb: (items: TopicIntelligence[]) => void): Unsubscribe {
  return byBusiness<TopicIntelligence>("topicIntelligence", businessId, (rows) => cb(rows.filter((r) => !r.superseded).sort((a, b) => (b.gscCurrent?.impressions || 0) - (a.gscCurrent?.impressions || 0) || a.title.localeCompare(b.title))));
}

export function listenSeoPages(businessId: string, cb: (items: SeoPage[]) => void): Unsubscribe {
  return byBusiness<SeoPage>("seoPages", businessId, (rows) => cb(rows.sort((a, b) => a.url.localeCompare(b.url))));
}

export function listenLatestIntelligenceRun(businessId: string, cb: (run: IntelligenceRun | null) => void): Unsubscribe {
  return byBusiness<IntelligenceRun>("intelligenceRuns", businessId, (rows) => cb(rows.filter((r) => r.status === "completed").sort((a, b) => (b.completedAtMs || 0) - (a.completedAtMs || 0))[0] || null));
}

export function listenBaselines(businessId: string, cb: (items: Baseline[]) => void): Unsubscribe {
  return byBusiness<Baseline>("baselines", businessId, (rows) => cb(rows.sort((a, b) => b.version - a.version)));
}

// --- M5 Opportunity Engine (runs are written by the Cloud Function only) ---
export function listenLatestOpportunityRun(businessId: string, cb: (run: OpportunityRun | null) => void): Unsubscribe {
  const q = query(collection(db, "opportunityRuns"), where("businessId", "==", businessId));
  return onSnapshot(q, (snap) => {
    const runs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<OpportunityRun, "id">) })).filter((r) => r.status === "completed");
    runs.sort((a, b) => (b.completedAtMs || 0) - (a.completedAtMs || 0));
    cb(runs[0] || null);
  });
}

// --- M6 Decision Engine (engine-generated; the owner may only record a review) ---
export function listenDecisions(businessId: string, cb: (items: Decision[]) => void): Unsubscribe {
  return byBusiness<Decision>("decisions", businessId, (rows) => cb(rows.sort((a, b) => a.id.localeCompare(b.id))));
}

export function listenSearchIntents(businessId: string, cb: (items: SearchIntent[]) => void): Unsubscribe {
  return byBusiness<SearchIntent>("searchIntents", businessId, (rows) => cb(rows.filter((r) => r.status === "active")));
}

export function listenLatestDecisionRun(businessId: string, cb: (run: DecisionRun | null) => void): Unsubscribe {
  return byBusiness<DecisionRun>("decisionRuns", businessId, (rows) => cb(rows.filter((r) => r.status === "completed").sort((a, b) => (b.completedAtMs || 0) - (a.completedAtMs || 0))[0] || null));
}

export async function updateDecisionReview(id: string, data: { ownerStatus?: DecisionOwnerStatus; ownerNote?: string }) {
  return updateDoc(doc(db, "decisions", id), { ...data, updatedAt: serverTimestamp() });
}
