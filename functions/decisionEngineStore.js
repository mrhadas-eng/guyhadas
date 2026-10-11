// GuyHadas Visibility OS - M6 Decision Engine: run orchestration
// (docs/M6_DECISION_ENGINE_DESIGN.md §J, §K, §L, §M, §O;
// docs/M6_IMPLEMENTATION_NOTES.md §3a run safety).
//
//   latest completed M5 opportunityRun (must be current) + its active
//   engine opportunities + M3.2 topics / M3.1 services + M4 intelligence
//     -> decisionRules.decide()  (pure, deterministic)
//     -> searchIntents (one per intent; superseded, never deleted)
//     -> decisions (one per intent / page / site unit; history kept)
//     -> decisionRuns (one per input fingerprint; status running ->
//        completed | failed | abandoned)
//     -> opportunities.decisionId (the only field M6 writes outside its
//        own collections)
//
// No provider is called - Firestore reads and writes only.
//
// Run safety:
//   - CACHE: a run is a cache hit only when (a) the input fingerprint -
//     every M6-relevant input document, not timestamps or counts - equals
//     the last completed run's, AND (b) the current decisions / intents /
//     opportunity links are exactly the state that run produced. Anything
//     else recomputes. A cache hit performs zero writes.
//   - CONCURRENCY: one run per business at a time, through a lease lock
//     (decisionRunLocks/{businessId}, created atomically). A concurrent
//     request returns "in_progress" and writes nothing. Run documents have
//     a deterministic id per input fingerprint, so retries of the same input
//     reuse one run record instead of piling up new ones.
//   - FAIL CLOSED / RECOVERY: all reads happen before any data write. Writes
//     are committed in chunked batches; a failure marks the run "failed"
//     (phase + chunks committed) and releases the lock. A crash that skips
//     even that leaves a lock whose lease expires and a run still marked
//     "running" - the next run takes over the lock and marks that run
//     "abandoned". Every write is idempotent (deterministic ids, full-document
//     sets), so the next run repairs any partial state, and a partial state
//     can never produce a cache hit (state fingerprint check).

const crypto = require("crypto");
const admin = require("firebase-admin");
const { hashInput } = require("./apiUsage");
const { decide, APPROVED } = require("./decisionRules");
const { holdStatusAt } = require("./trackingRules");
const cfg = require("./decisionConfig");

const OPP_SOURCE = "opportunity_engine";
const OWNER_REVIEWED = ["accepted", "rejected"];
const FINGERPRINT_VERSION = 3; // v3: M7 active holds are an input (I-1)
const LOCK_LEASE_MS = 5 * 60 * 1000; // > function timeout (120 s)
const BATCH_SIZE = 400; // Firestore limit is 500 operations per batch

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
  const [bizDoc, servicesSnap, knowledgeSnap, topicsSnap, runsSnap, tiSnap, pagesSnap, baselinesSnap, oppSnap, oppRunsSnap, intentsSnap, decisionsSnap, decisionRunsSnap, experimentsSnap] = await Promise.all([
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
    byBiz("decisionRuns"),
    byBiz("seoExperiments")
  ]);
  const run = latestCompleted(rows(runsSnap));
  const decisionRuns = rows(decisionRunsSnap);
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
    decisionRuns,
    lastRun: latestCompleted(decisionRuns),
    // M7 (I-1): open experiments only - M6 reads them, never writes them
    experiments: rows(experimentsSnap).filter((x) => x.status === "open")
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

const omit = (doc, keys) => {
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!keys.includes(k)) out[k] = v;
  return out;
};
const byId = (list) => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));

// INPUT FINGERPRINT. Every document decide() and the freshness gate read is
// hashed in FULL (all fields), sorted by id - not timestamps or counts -
// so any change to a query, qualification reason, seed ref, topic
// intelligence block, page title/H1/H2/role/canonical/indexability, service
// facet, opportunity field or brand term changes the hash. Over-inclusion
// only costs an extra (idempotent) recomputation; under-inclusion would be a
// false "nothing changed", which is never acceptable.
// Excluded on purpose:
//   - opportunities.decisionId: written by M6 itself (would defeat the cache);
//   - business doc fields other than name / geographicMarkets /
//     decisionPolicy: decide() reads only those (other processes update the
//     business doc for unrelated reasons);
//   - decisions/searchIntents contents: M6's own output - covered by the
//     separate STATE fingerprint below; only owner-set review statuses count
//     as input.
// M7 hold vector (I-1): what the churn filter reads, with the hold status
// evaluated at nowMs - so time passing changes the fingerprint only when a
// hold starts, expires or is released.
function holdVector(experiments, nowMs) {
  return experiments
    .map((x) => {
      const st = holdStatusAt(x, nowMs);
      return {
        id: x.id,
        status: st.reason,
        holdUntilMs: x.hold ? x.hold.holdUntilMs : null,
        materiality: x.hold ? x.hold.materiality : null,
        classes: x.hold ? x.hold.classes || [] : [],
        beforeEligibility: x.hold ? x.hold.beforeEligibility || {} : {},
        released: !!(x.ownerHoldRelease && x.ownerHoldRelease.released),
        unit: x.unit || null,
        affectedPageKeys: x.affectedPageKeys || [],
        intentIds: x.intentIds || [],
        decisionIds: x.decisionIds || [],
        signalKeys: x.signalKeys || [],
        liveChangeEventIds: x.liveChangeEventIds || [],
        startMs: x.startMs || null,
        stageAEndPassed: x.stageWindows && x.stageWindows.A ? nowMs > x.stageWindows.A.toMs : null
      };
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function semanticInput(inputs, policy, nowMs = Date.now()) {
  return {
    activeHolds: holdVector(inputs.experiments || [], nowMs),
    fingerprintVersion: FINGERPRINT_VERSION,
    engineVersion: cfg.DECISION_ENGINE_VERSION,
    configVersion: cfg.DECISION_CONFIG_VERSION,
    heuristics: cfg.HEURISTICS,
    intentModifiers: cfg.INTENT_MODIFIERS,
    extendedModifiers: cfg.EXTENDED_MODIFIERS,
    policy: { createBudgetPerRun: policy.createBudgetPerRun, createsPerClusterPerRun: policy.createsPerClusterPerRun },
    business: { id: inputs.business.id, name: inputs.business.name || null, geographicMarkets: inputs.business.geographicMarkets || [], decisionPolicy: inputs.business.decisionPolicy || null },
    services: byId(inputs.services),
    knowledge: byId(inputs.knowledge),
    searchTopics: byId(inputs.searchTopics),
    intelligenceRunId: inputs.run ? inputs.run.id : null,
    topicIntel: byId(inputs.topicIntel),
    seoPages: byId(inputs.seoPages),
    baselineId: inputs.baseline ? inputs.baseline.id : null,
    opportunities: byId(inputs.opportunities.map((o) => omit(o, ["decisionId"]))),
    oppRun: inputs.oppRun ? { id: inputs.oppRun.id, inputHash: inputs.oppRun.inputHash || null, intelligenceRunId: inputs.oppRun.intelligenceRunId || null, topicIds: [...new Set((inputs.oppRun.topicEvaluations || []).map((e) => e.topicId))].sort() } : null,
    ownerDecisionStatuses: inputs.decisions.filter((d) => d.ownerStatus && d.ownerStatus !== "pending").map((d) => [d.id, d.ownerStatus]).sort((a, b) => a[0].localeCompare(b[0]))
  };
}

// STATE fingerprint: what M6 itself wrote. A cache hit additionally requires
// the current state to equal the state the last completed run produced, so
// partial writes, deleted or edited engine records are repaired, never
// reported as "nothing changed".
function stateFingerprint(decisions, intents, opportunities) {
  return hashInput({
    decisions: decisions.map((d) => [d.id, d.decision || null, d.engineState || null]).sort((a, b) => a[0].localeCompare(b[0])),
    intents: intents.map((i) => [i.id, i.status || null]).sort((a, b) => a[0].localeCompare(b[0])),
    links: opportunities.map((o) => [o.id, o.decisionId || null]).sort((a, b) => a[0].localeCompare(b[0]))
  });
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

// ---------------------------------------------------------------------------
// lease lock (one run per business)

function isAlreadyExists(err) {
  return err && (err.code === 6 || err.code === "already-exists" || /ALREADY_EXISTS|already exists/i.test(err.message || ""));
}

async function acquireLock(db, businessId, nowMs, owner) {
  const ref = db.collection("decisionRunLocks").doc(businessId);
  const lock = { businessId, owner, acquiredAtMs: nowMs, leaseExpiresAtMs: nowMs + LOCK_LEASE_MS };
  try {
    await ref.create(lock);
    return { ok: true, ref };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  const snap = await ref.get();
  const held = snap.exists ? snap.data() : null;
  if (held && held.leaseExpiresAtMs > nowMs) return { ok: false, held };
  // The previous holder crashed or timed out (lease expired): take over and
  // confirm we are the owner before doing anything else.
  await ref.set({ ...lock, tookOverFrom: held ? held.owner : null });
  const check = await ref.get();
  if (!check.exists || check.data().owner !== owner) return { ok: false, held: check.exists ? check.data() : null };
  return { ok: true, ref, tookOver: held };
}

async function releaseLock(ref, owner) {
  try {
    const snap = await ref.get();
    if (snap.exists && snap.data().owner === owner) await ref.delete();
  } catch (err) {
    // Lease expiry is the fallback; never mask the run's own outcome.
    console.error("decisionRunLocks release failed:", err.message);
  }
}

async function commitInBatches(db, ops, progress, batchSize = BATCH_SIZE) {
  for (let i = 0; i < ops.length; i += batchSize) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + batchSize)) {
      if (op.kind === "set") batch.set(op.ref, clean(op.data));
      else batch.update(op.ref, clean(op.data));
    }
    await batch.commit();
    progress.chunksCommitted++;
    progress.opsCommitted += Math.min(batchSize, ops.length - i);
  }
}

// ---------------------------------------------------------------------------

// `batchSize` exists for tests (multi-chunk failure scenarios); production
// uses BATCH_SIZE.
async function runDecisionEngine({ businessId, nowMs = Date.now(), batchSize = BATCH_SIZE }) {
  const db = admin.firestore();
  const fingerprints = (inputs) => {
    const policy = cfg.resolvePolicy(inputs.business.decisionPolicy);
    return { policy, inputHash: hashInput(semanticInput(inputs, policy, nowMs)), stateHash: stateFingerprint(inputs.decisions, inputs.intents, inputs.opportunities) };
  };
  const cacheHitOf = (inputs, fp) =>
    inputs.lastRun && inputs.lastRun.inputHash === fp.inputHash && inputs.lastRun.outputStateHash === fp.stateHash
      ? { cacheHit: true, decision: "cache_hit", runId: inputs.lastRun.id, providerCalled: false, summary: inputs.lastRun.summary, written: 0 }
      : null;

  // 1. Read-only cache check: an unchanged business never takes the lock
  //    and performs zero writes.
  let inputs = await loadInputs(businessId);
  let fp = fingerprints(inputs);
  const early = cacheHitOf(inputs, fp);
  if (early) return early;

  // 2. One run per business at a time.
  const owner = `${nowMs}_${crypto.randomUUID()}`;
  const lock = await acquireLock(db, businessId, nowMs, owner);
  if (!lock.ok) {
    return { cacheHit: false, decision: "in_progress", inProgress: true, providerCalled: false, written: 0, lockedSinceMs: lock.held ? lock.held.acquiredAtMs : null, summary: null };
  }
  try {
    // 3. Re-read under the lock (a concurrent run may have just finished).
    inputs = await loadInputs(businessId);
    fp = fingerprints(inputs);
    const hit = cacheHitOf(inputs, fp);
    if (hit) return hit;
    return await computeAndWrite({ db, businessId, nowMs, inputs, fp, owner, tookOver: lock.tookOver || null, batchSize });
  } finally {
    await releaseLock(lock.ref, owner);
  }
}

async function computeAndWrite({ db, businessId, nowMs, inputs, fp, owner, tookOver, batchSize }) {
  const { policy, inputHash } = fp;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const runId = `${businessId}_run_${inputHash.slice(0, 24)}`;
  const runRef = db.collection("decisionRuns").doc(runId);
  const sameInputRun = inputs.decisionRuns.find((r) => r.id === runId) || null;
  const attempt = ((sameInputRun && sameInputRun.attempt) || 0) + 1;
  // Runs left "running" while we hold the lock were interrupted (their lease
  // expired) - they are recorded as abandoned, never left running forever.
  const abandoned = inputs.decisionRuns.filter((r) => r.status === "running" && r.id !== runId);
  const base = {
    businessId,
    inputHash,
    attempt,
    lockOwner: owner,
    startedAtMs: nowMs,
    engineVersion: cfg.DECISION_ENGINE_VERSION,
    configVersion: cfg.DECISION_CONFIG_VERSION,
    policy,
    intelligenceRunId: inputs.run ? inputs.run.id : null,
    sourceOpportunityRunId: inputs.oppRun ? inputs.oppRun.id : null,
    baselineId: inputs.baseline ? inputs.baseline.id : null,
    providerCalled: false,
    ...(tookOver ? { tookOverLockFrom: tookOver.owner || null } : {})
  };
  const progress = { phase: "start", chunksCommitted: 0, opsCommitted: 0, totalOps: 0 };
  await runRef.set(clean({ ...base, status: "running", completedAtMs: null, error: null }));

  try {
    const ops = [];
    for (const r of abandoned) ops.push({ ref: db.collection("decisionRuns").doc(r.id), kind: "update", data: { status: "abandoned", abandonedAtMs: nowMs, abandonedByRunId: runId } });

    const fresh = m5Freshness(inputs);
    if (!fresh.ok) {
      progress.phase = "write";
      progress.totalOps = ops.length;
      await commitInBatches(db, ops, progress, batchSize);
      const summary = { intents: 0, decisions: 0, byDecision: {}, byScope: {}, byCluster: {}, creates: 0, createCandidates: 0 };
      progress.phase = "finalize";
      await runRef.set(clean({ ...base, status: "completed", completedAtMs: nowMs, completedAt: now, outcome: "WAIT_FOR_DATA", reason: fresh.reason, summary, outputStateHash: fp.stateHash, abandonedRunIds: abandoned.map((r) => r.id) }));
      return { cacheHit: false, decision: "computed", outcome: "WAIT_FOR_DATA", reason: fresh.reason, runId, providerCalled: false, summary, written: ops.length + 2 };
    }

    progress.phase = "compute";
    const result = decide({
      business: inputs.business,
      services: inputs.services,
      knowledge: inputs.knowledge,
      searchTopics: inputs.searchTopics,
      topicIntel: inputs.topicIntel,
      seoPages: inputs.seoPages,
      opportunities: inputs.opportunities,
      baseline: inputs.baseline,
      experiments: inputs.experiments,
      policy,
      nowMs
    });
    const stamp = {
      decisionRunId: runId,
      sourceOpportunityRunId: inputs.oppRun.id,
      intelligenceRunId: inputs.run.id,
      baselineId: inputs.baseline ? inputs.baseline.id : null,
      lastEvaluatedAtMs: nowMs,
      updatedAt: now
    };
    // In-memory model of the final state (for the state fingerprint).
    const finalDecisions = new Map(inputs.decisions.map((d) => [d.id, { id: d.id, decision: d.decision, engineState: d.engineState }]));
    const finalIntents = new Map(inputs.intents.map((i) => [i.id, { id: i.id, status: i.status }]));
    const finalLinks = new Map(inputs.opportunities.map((o) => [o.id, { id: o.id, decisionId: o.decisionId || null }]));

    // --- searchIntents ----------------------------------------------------
    const newIntentIds = new Set(result.intents.map((i) => i.intentId));
    const intentOfTopic = new Map();
    for (const i of result.intents) for (const t of i.topicIds) intentOfTopic.set(t, i.intentId);
    const prevIntents = new Map(inputs.intents.map((i) => [i.id, i]));
    for (const i of result.intents) {
      const prev = prevIntents.get(i.intentId);
      ops.push({
        ref: db.collection("searchIntents").doc(i.intentId),
        kind: "set",
        data: { ...i, ...stamp, status: "active", supersededAtMs: null, supersededByIntentIds: [], firstSeenAtMs: prev && prev.firstSeenAtMs ? prev.firstSeenAtMs : nowMs, createdAt: prev && prev.createdAt ? prev.createdAt : now }
      });
      finalIntents.set(i.intentId, { id: i.intentId, status: "active" });
    }
    let intentsSuperseded = 0;
    for (const prev of inputs.intents) {
      if (newIntentIds.has(prev.id) || prev.status === "superseded") continue;
      const successors = [...new Set((prev.topicIds || []).map((t) => intentOfTopic.get(t)).filter(Boolean))].sort();
      ops.push({ ref: db.collection("searchIntents").doc(prev.id), kind: "update", data: { status: "superseded", supersededAtMs: nowMs, supersededByIntentIds: successors, supersededByRunId: runId, updatedAt: now } });
      finalIntents.set(prev.id, { id: prev.id, status: "superseded" });
      intentsSuperseded++;
    }

    // --- decisions ----------------------------------------------------------
    const prevDecisions = new Map(inputs.decisions.map((d) => [d.id, d]));
    const newIds = new Set(result.decisions.map((d) => d.decisionId));
    let created = 0;
    let changed = 0;
    let unchanged = 0;
    let ownerReset = 0;
    for (const d of result.decisions) {
      const prev = prevDecisions.get(d.decisionId);
      const fields = { ...engineFields(d), ...stamp, engineState: "active", supersededAtMs: null };
      const ref = db.collection("decisions").doc(d.decisionId);
      if (!prev) {
        ops.push({ ref, kind: "set", data: { ...fields, ownerStatus: "pending", ownerNote: "", ownerStatusResetReason: null, previousDecision: null, decisionHistory: [historyEntry(d, nowMs, runId, { event: "created" })], firstDecidedAtMs: nowMs, createdAt: now } });
        created++;
      } else if (prev.decision !== d.decision || prev.engineState === "superseded") {
        // I-2: the decision's OWN implementation (-> MONITOR under
        // observation) keeps the owner's accepted status; any other change
        // follows the existing reset rule.
        const ownImplementation = d.decision === "MONITOR" && (d.reasonCodes || []).includes("IMPLEMENTED_UNDER_OBSERVATION");
        const history = capHistory([...(prev.decisionHistory || []), historyEntry(d, nowMs, runId, { event: ownImplementation ? "implemented" : prev.engineState === "superseded" ? "reactivated" : "changed", previousDecision: prev.decision, ownerStatusAtChange: prev.ownerStatus || null, ...(d.churnHold ? { experimentId: d.churnHold.experimentId } : {}) })]);
        const reset = prev.decision !== d.decision && OWNER_REVIEWED.includes(prev.ownerStatus) && !ownImplementation;
        ops.push({ ref, kind: "update", data: { ...fields, previousDecision: prev.decision, decisionHistory: history, ...(reset ? { ownerStatus: "pending", ownerStatusResetReason: "decision_changed_since_owner_review" } : {}) } });
        if (reset) ownerReset++;
        changed++;
      } else {
        ops.push({ ref, kind: "update", data: fields });
        unchanged++;
      }
      finalDecisions.set(d.decisionId, { id: d.decisionId, decision: d.decision, engineState: "active" });
    }
    let superseded = 0;
    for (const prev of inputs.decisions) {
      if (newIds.has(prev.id) || prev.engineState === "superseded") continue;
      const prevIntent = prev.scope === "intent" ? prevIntents.get(prev.intentId) : null;
      const topicsGone = !!prevIntent && (prevIntent.topicIds || []).every((t) => !intentOfTopic.has(t));
      const successors = prevIntent ? [...new Set((prevIntent.topicIds || []).map((t) => intentOfTopic.get(t)).filter(Boolean))] : [];
      const update = { engineState: "superseded", supersededAtMs: nowMs, decisionRunId: runId, lastEvaluatedAtMs: nowMs, updatedAt: now };
      if (topicsGone) {
        Object.assign(update, { decision: "REJECT", previousDecision: prev.decision, reasonCodes: ["TOPIC_NO_LONGER_APPROVED"], summary: "הנושא כבר לא מאושר.", recommendedPage: { kind: "none", pageKey: null, url: null } });
      } else if (successors.length) {
        Object.assign(update, { reasonCodes: [...new Set([...(prev.reasonCodes || []), "SUBSUMED_BY_DECISION"])], dependencies: successors.map((s) => ({ decisionId: `${businessId}_intent_${s}`, relation: "subsumed_by" })) });
      } else {
        Object.assign(update, { reasonCodes: [...new Set([...(prev.reasonCodes || []), "NO_ACTION_NEEDED"])] });
      }
      update.decisionHistory = capHistory([...(prev.decisionHistory || []), { decision: update.decision || prev.decision, confidence: prev.confidence || null, at: nowMs, decisionRunId: runId, reasonCodes: update.reasonCodes, event: "superseded", previousDecision: prev.decision }]);
      ops.push({ ref: db.collection("decisions").doc(prev.id), kind: "update", data: update });
      finalDecisions.set(prev.id, { id: prev.id, decision: update.decision || prev.decision, engineState: "superseded" });
      superseded++;
    }

    // --- opportunities.decisionId (the only M6 write on an M5 document) ---
    const linkOf = new Map();
    for (const d of result.decisions) for (const oid of d.opportunityIds) linkOf.set(oid, d.decisionId);
    let linked = 0;
    for (const o of inputs.opportunities) {
      const target = linkOf.get(o.id);
      if (!target || o.decisionId === target) continue;
      ops.push({ ref: db.collection("opportunities").doc(o.id), kind: "update", data: { decisionId: target } });
      finalLinks.set(o.id, { id: o.id, decisionId: target });
      linked++;
    }

    progress.phase = "write";
    progress.totalOps = ops.length;
    await commitInBatches(db, ops, progress, batchSize);

    progress.phase = "finalize";
    const outputStateHash = stateFingerprint([...finalDecisions.values()], [...finalIntents.values()], [...finalLinks.values()]);
    const summary = { ...result.summary, created, changed, unchanged, superseded, ownerReset, intentsSuperseded, linkedOpportunities: linked, abandonedRuns: abandoned.length };
    await runRef.set(
      clean({
        ...base,
        status: "completed",
        completedAtMs: nowMs,
        completedAt: now,
        error: null,
        outcome: "DECISIONS",
        heuristics: cfg.HEURISTICS,
        decisionIds: result.decisions.map((d) => d.decisionId),
        intentIds: result.intents.map((i) => i.intentId),
        unmappedOpportunities: result.unmappedOpportunities,
        abandonedRunIds: abandoned.map((r) => r.id),
        writes: { ops: ops.length, chunks: progress.chunksCommitted },
        outputStateHash,
        summary
      })
    );
    return { cacheHit: false, decision: "computed", outcome: "DECISIONS", runId, providerCalled: false, summary, written: ops.length + 2 };
  } catch (err) {
    // Never leave the run silently "running": record where it failed. The
    // next run recomputes (no cache hit is possible from a failed run) and
    // its idempotent writes repair any partial state.
    try {
      await runRef.set(clean({ ...base, status: "failed", failedAtMs: nowMs, error: String(err && err.message ? err.message : err).slice(0, 500), failedPhase: progress.phase, chunksCommitted: progress.chunksCommitted, opsCommitted: progress.opsCommitted, totalOps: progress.totalOps, recovery: "re-run the decision engine; writes are idempotent and the next run repairs partial state" }));
    } catch (markErr) {
      console.error("decisionRuns failure mark failed:", markErr.message);
    }
    throw err;
  }
}

module.exports = { runDecisionEngine, loadInputs, semanticInput, stateFingerprint, m5Freshness, LOCK_LEASE_MS };
