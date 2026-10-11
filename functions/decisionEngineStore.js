// GuyHadas Visibility OS - M6 Decision Engine: run orchestration
// (docs/M6_DECISION_ENGINE_DESIGN.md §J, §K, §L, §M, §O).
//
//   latest completed M5 opportunityRun (must be current) + its active
//   engine opportunities + M3.2 topics / M3.1 services + M4 intelligence
//     -> decisionRules.decide()  (pure, deterministic)
//     -> searchIntents (one per intent; superseded, never deleted)
//     -> decisions (one per intent / page / site unit; history kept)
//     -> decisionRuns (one per computed run)
//     -> opportunities.decisionId (the only field M6 writes outside its
//        own collections)
//
// No provider is called - Firestore reads and writes only. All reads happen
// before any write (fail closed). An identical semantic input is a cache
// hit with zero writes. Owner fields (ownerStatus, ownerNote) are written
// only when a decision is first created, or reset to "pending" when the
// decision value itself changes (the previous owner status stays in the
// history).

const admin = require("firebase-admin");
const { hashInput } = require("./apiUsage");
const { decide, APPROVED } = require("./decisionRules");
const cfg = require("./decisionConfig");

const OPP_SOURCE = "opportunity_engine";
const OWNER_REVIEWED = ["accepted", "rejected"];

// Firestore rejects `undefined` values (ignoreUndefinedProperties is not
// set). Drop them defensively from plain objects/arrays; FieldValue
// sentinels and other class instances pass through untouched.
function clean(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined).map(clean);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = clean(v);
    return out;
  }
  return value;
}

function rows(snap) {
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

const latestCompleted = (list) =>
  list.filter((r) => r.status === "completed").sort((a, b) => (b.completedAtMs || 0) - (a.completedAtMs || 0) || String(b.id).localeCompare(String(a.id)))[0] || null;

async function loadInputs(businessId) {
  const db = admin.firestore();
  const byBiz = (c) => db.collection(c).where("businessId", "==", businessId).get();
  const [bizDoc, servicesSnap, knowledgeSnap, topicsSnap, runsSnap, tiSnap, pagesSnap, baselinesSnap, oppSnap, oppRunsSnap, intentsSnap, decisionsSnap, decisionRunsSnap] = await Promise.all([
    db.collection("businesses").doc(businessId).get(),
    byBiz("businessServices"),
    byBiz("businessKnowledge"),
    byBiz("searchTopics"),
    byBiz("intelligenceRuns"),
    byBiz("topicIntelligence"),
    byBiz("seoPages"),
    byBiz("baselines"),
    byBiz("opportunities"),
    byBiz("opportunityRuns"),
    byBiz("searchIntents"),
    byBiz("decisions"),
    byBiz("decisionRuns")
  ]);
  const run = latestCompleted(rows(runsSnap));
  return {
    business: { id: businessId, ...(bizDoc.exists ? bizDoc.data() : {}) },
    services: rows(servicesSnap),
    knowledge: rows(knowledgeSnap),
    searchTopics: rows(topicsSnap),
    run,
    topicIntel: run ? rows(tiSnap).filter((t) => t.runId === run.id && !t.superseded) : [],
    seoPages: rows(pagesSnap),
    baseline: rows(baselinesSnap).sort((a, b) => (b.version || 0) - (a.version || 0))[0] || null,
    opportunities: rows(oppSnap).filter((o) => o.source === OPP_SOURCE),
    oppRun: latestCompleted(rows(oppRunsSnap)),
    intents: rows(intentsSnap),
    decisions: rows(decisionsSnap),
    lastRun: latestCompleted(rows(decisionRunsSnap))
  };
}

// M6 consumes M5; it never re-detects. The M5 run must belong to the latest
// intelligence run and cover exactly the currently approved topics.
function m5Freshness(inputs) {
  if (!inputs.run) return { ok: false, reason: "no completed search-intelligence run - run the analysis first" };
  if (!inputs.oppRun) return { ok: false, reason: "no completed opportunity-detection run - run opportunity detection first" };
  if (inputs.oppRun.intelligenceRunId !== inputs.run.id) return { ok: false, reason: "opportunity detection is older than the latest search-intelligence analysis - run opportunity detection again" };
  const approved = inputs.searchTopics.filter((t) => APPROVED.includes(t.status)).map((t) => t.id).sort();
  const evaluated = [...new Set((inputs.oppRun.topicEvaluations || []).map((e) => e.topicId))].sort();
  if (JSON.stringify(approved) !== JSON.stringify(evaluated)) return { ok: false, reason: "approved topics changed since the last opportunity detection - run opportunity detection again" };
  return { ok: true };
}

// Everything that can change the result - and nothing else. Owner statuses
// on decisions count only once the owner set them (not the initial
// "pending"), so the engine's own writes never change its cache identity.
function semanticInput(inputs, policy) {
  const svc = inputs.services
    .filter((s) => s.ownerStatus === "confirmed")
    .map((s) => [s.id, s.name, s.aliases || [], (s.facets && s.facets.services) || [], (s.facets && s.facets.geographies) || [], (s.facets && s.facets.audiences) || []])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return {
    engineVersion: cfg.DECISION_ENGINE_VERSION,
    configVersion: cfg.DECISION_CONFIG_VERSION,
    heuristics: cfg.HEURISTICS,
    policy: { createBudgetPerRun: policy.createBudgetPerRun, createsPerClusterPerRun: policy.createsPerClusterPerRun },
    intelligenceRunId: inputs.run ? inputs.run.id : null,
    oppRunId: inputs.oppRun ? inputs.oppRun.id : null,
    oppRunInputHash: inputs.oppRun ? inputs.oppRun.inputHash || null : null,
    baselineId: inputs.baseline ? inputs.baseline.id : null,
    topics: inputs.searchTopics.map((t) => [t.id, t.status, t.title, t.preliminaryIntent || null, (t.queries || []).length]).sort((a, b) => a[0].localeCompare(b[0])),
    opportunities: inputs.opportunities.map((o) => [o.id, o.status, o.engineState, o.lastEvaluatedAtMs || null]).sort((a, b) => a[0].localeCompare(b[0])),
    ownerDecisionStatuses: inputs.decisions.filter((d) => d.ownerStatus && d.ownerStatus !== "pending").map((d) => [d.id, d.ownerStatus]).sort((a, b) => a[0].localeCompare(b[0])),
    pages: inputs.seoPages.map((p) => [p.pageKey, p.lastCrawledAtMs || null, p.crawlStatus || null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    services: svc,
    business: { name: inputs.business.name || null, geographicMarkets: inputs.business.geographicMarkets || [] },
    brandTerms: inputs.knowledge.filter((k) => k.type === "brand_terminology").map((k) => k.content).sort()
  };
}

const ENGINE_FIELDS_EXCLUDED = new Set(["ownerStatus", "ownerNote", "decisionHistory", "firstDecidedAtMs", "createdAt"]);

function engineFields(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) if (!ENGINE_FIELDS_EXCLUDED.has(k) && v !== undefined) out[k] = v;
  return out;
}

function historyEntry(d, nowMs, runId, extra = {}) {
  return { decision: d.decision, confidence: d.confidence, at: nowMs, decisionRunId: runId, reasonCodes: d.reasonCodes, ...extra };
}

function capHistory(list) {
  return list.length > cfg.HISTORY_CAP ? list.slice(list.length - cfg.HISTORY_CAP) : list;
}

async function runDecisionEngine({ businessId, nowMs = Date.now() }) {
  const db = admin.firestore();
  const inputs = await loadInputs(businessId); // throws on any read failure -> nothing written
  const policy = cfg.resolvePolicy(inputs.business.decisionPolicy);
  const inputHash = hashInput(semanticInput(inputs, policy));

  if (inputs.lastRun && inputs.lastRun.inputHash === inputHash) {
    return { cacheHit: true, decision: "cache_hit", runId: inputs.lastRun.id, providerCalled: false, summary: inputs.lastRun.summary, written: 0 };
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const fresh = m5Freshness(inputs);
  if (!fresh.ok) {
    const summary = { intents: 0, decisions: 0, byDecision: {}, byScope: {}, byCluster: {}, creates: 0, createCandidates: 0 };
    const ref = await db.collection("decisionRuns").add(clean({
      businessId,
      status: "completed",
      startedAtMs: nowMs,
      completedAtMs: nowMs,
      completedAt: now,
      inputHash,
      outcome: "WAIT_FOR_DATA",
      reason: fresh.reason,
      engineVersion: cfg.DECISION_ENGINE_VERSION,
      configVersion: cfg.DECISION_CONFIG_VERSION,
      policy,
      intelligenceRunId: inputs.run ? inputs.run.id : null,
      sourceOpportunityRunId: inputs.oppRun ? inputs.oppRun.id : null,
      baselineId: inputs.baseline ? inputs.baseline.id : null,
      summary,
      providerCalled: false
    }));
    return { cacheHit: false, decision: "computed", outcome: "WAIT_FOR_DATA", reason: fresh.reason, runId: ref.id, providerCalled: false, summary, written: 1 };
  }

  const result = decide({
    business: inputs.business,
    services: inputs.services,
    knowledge: inputs.knowledge,
    searchTopics: inputs.searchTopics,
    topicIntel: inputs.topicIntel,
    seoPages: inputs.seoPages,
    opportunities: inputs.opportunities,
    baseline: inputs.baseline,
    policy,
    nowMs
  });

  const runRef = await db.collection("decisionRuns").add({ businessId, status: "running", startedAtMs: nowMs, inputHash });
  const runId = runRef.id;
  let written = 1;
  const stamp = {
    decisionRunId: runId,
    sourceOpportunityRunId: inputs.oppRun.id,
    intelligenceRunId: inputs.run.id,
    baselineId: inputs.baseline ? inputs.baseline.id : null,
    lastEvaluatedAtMs: nowMs,
    updatedAt: now
  };

  // --- searchIntents ------------------------------------------------------
  const newIntentIds = new Set(result.intents.map((i) => i.intentId));
  const intentOfTopic = new Map();
  for (const i of result.intents) for (const t of i.topicIds) intentOfTopic.set(t, i.intentId);
  const prevIntents = new Map(inputs.intents.map((i) => [i.id, i]));
  for (const i of result.intents) {
    const prev = prevIntents.get(i.intentId);
    await db.collection("searchIntents").doc(i.intentId).set(clean({
      ...i,
      ...stamp,
      status: "active",
      supersededAtMs: null,
      supersededByIntentIds: [],
      firstSeenAtMs: prev && prev.firstSeenAtMs ? prev.firstSeenAtMs : nowMs,
      createdAt: prev && prev.createdAt ? prev.createdAt : now
    }));
    written++;
  }
  let intentsSuperseded = 0;
  for (const prev of inputs.intents) {
    if (newIntentIds.has(prev.id) || prev.status === "superseded") continue;
    const successors = [...new Set((prev.topicIds || []).map((t) => intentOfTopic.get(t)).filter(Boolean))].sort();
    await db.collection("searchIntents").doc(prev.id).update({ status: "superseded", supersededAtMs: nowMs, supersededByIntentIds: successors, supersededByRunId: runId, updatedAt: now });
    intentsSuperseded++;
    written++;
  }

  // --- decisions ------------------------------------------------------------
  const prevDecisions = new Map(inputs.decisions.map((d) => [d.id, d]));
  const newIds = new Set(result.decisions.map((d) => d.decisionId));
  let created = 0;
  let changed = 0;
  let unchanged = 0;
  let ownerReset = 0;
  for (const d of result.decisions) {
    const prev = prevDecisions.get(d.decisionId);
    const fields = { ...engineFields(d), ...stamp, engineState: "active", supersededAtMs: null };
    if (!prev) {
      await db.collection("decisions").doc(d.decisionId).set(clean({
        ...fields,
        ownerStatus: "pending",
        ownerNote: "",
        ownerStatusResetReason: null,
        previousDecision: null,
        decisionHistory: [historyEntry(d, nowMs, runId, { event: "created" })],
        firstDecidedAtMs: nowMs,
        createdAt: now
      }));
      created++;
    } else if (prev.decision !== d.decision || prev.engineState === "superseded") {
      const history = capHistory([...(prev.decisionHistory || []), historyEntry(d, nowMs, runId, { event: prev.engineState === "superseded" ? "reactivated" : "changed", previousDecision: prev.decision, ownerStatusAtChange: prev.ownerStatus || null })]);
      const reset = prev.decision !== d.decision && OWNER_REVIEWED.includes(prev.ownerStatus);
      await db.collection("decisions").doc(d.decisionId).update(clean({
        ...fields,
        previousDecision: prev.decision,
        decisionHistory: history,
        ...(reset ? { ownerStatus: "pending", ownerStatusResetReason: "decision_changed_since_owner_review" } : {})
      }));
      if (reset) ownerReset++;
      changed++;
    } else {
      await db.collection("decisions").doc(d.decisionId).update(clean(fields));
      unchanged++;
    }
    written++;
  }
  let superseded = 0;
  for (const prev of inputs.decisions) {
    if (newIds.has(prev.id) || prev.engineState === "superseded") continue;
    const topicsGone = prev.scope === "intent" && prevIntents.get(prev.intentId) && (prevIntents.get(prev.intentId).topicIds || []).every((t) => !intentOfTopic.has(t));
    const successors = prev.scope === "intent" && prevIntents.get(prev.intentId) ? [...new Set((prevIntents.get(prev.intentId).topicIds || []).map((t) => intentOfTopic.get(t)).filter(Boolean))] : [];
    const update = {
      engineState: "superseded",
      supersededAtMs: nowMs,
      decisionRunId: runId,
      lastEvaluatedAtMs: nowMs,
      updatedAt: now
    };
    if (topicsGone) {
      Object.assign(update, { decision: "REJECT", previousDecision: prev.decision, reasonCodes: ["TOPIC_NO_LONGER_APPROVED"], summary: "הנושא כבר לא מאושר.", recommendedPage: { kind: "none", pageKey: null, url: null } });
    } else if (successors.length) {
      Object.assign(update, { reasonCodes: [...new Set([...(prev.reasonCodes || []), "SUBSUMED_BY_DECISION"])], dependencies: successors.map((s) => ({ decisionId: `${businessId}_intent_${s}`, relation: "subsumed_by" })) });
    } else {
      Object.assign(update, { reasonCodes: [...new Set([...(prev.reasonCodes || []), "NO_ACTION_NEEDED"])] });
    }
    update.decisionHistory = capHistory([...(prev.decisionHistory || []), { decision: update.decision || prev.decision, confidence: prev.confidence || null, at: nowMs, decisionRunId: runId, reasonCodes: update.reasonCodes, event: "superseded", previousDecision: prev.decision }]);
    await db.collection("decisions").doc(prev.id).update(clean(update));
    superseded++;
    written++;
  }

  // --- opportunities.decisionId (the only M6 write on an M5 document) -------
  const linkOf = new Map();
  for (const d of result.decisions) for (const oid of d.opportunityIds) linkOf.set(oid, d.decisionId);
  let linked = 0;
  for (const o of inputs.opportunities) {
    const target = linkOf.get(o.id);
    if (!target || o.decisionId === target) continue;
    await db.collection("opportunities").doc(o.id).update({ decisionId: target });
    linked++;
    written++;
  }

  const summary = { ...result.summary, created, changed, unchanged, superseded, ownerReset, intentsSuperseded, linkedOpportunities: linked };
  await db.collection("decisionRuns").doc(runId).set(clean({
    businessId,
    status: "completed",
    startedAtMs: nowMs,
    completedAtMs: nowMs,
    completedAt: now,
    inputHash,
    outcome: "DECISIONS",
    engineVersion: cfg.DECISION_ENGINE_VERSION,
    configVersion: cfg.DECISION_CONFIG_VERSION,
    heuristics: cfg.HEURISTICS,
    policy,
    intelligenceRunId: inputs.run.id,
    sourceOpportunityRunId: inputs.oppRun.id,
    baselineId: inputs.baseline ? inputs.baseline.id : null,
    decisionIds: result.decisions.map((d) => d.decisionId),
    intentIds: result.intents.map((i) => i.intentId),
    unmappedOpportunities: result.unmappedOpportunities,
    summary,
    providerCalled: false
  }));
  return { cacheHit: false, decision: "computed", outcome: "DECISIONS", runId, providerCalled: false, summary, written };
}

module.exports = { runDecisionEngine, loadInputs, semanticInput, m5Freshness };
