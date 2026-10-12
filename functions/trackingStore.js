// GuyHadas Visibility OS - M7 Prediction, Change & Experiment Tracking:
// orchestration (docs/M7_DESIGN.md §3, §6, §7, §8, §10, §11).
//
//   accepted actionable M6 decisions + M4 evidence (seoPages,
//   topicIntelligence, intelligenceRuns, immutable baselines, existing
//   Search Console / GA4 snapshots)
//     -> impactPredictions   (provisional -> committed; content-addressed,
//                             create-only content; superseded never deleted)
//     -> seoChangeEvents     (one per recorded implementation; owner_reported)
//     -> seoExperiments      (deterministic grouping, windows, holds)
//     -> trackingRuns        (one per input fingerprint)
//
// No provider is called: Firestore reads/writes only. The only other module
// with side effects used here is M4's captureBaseline (Firestore-only), and
// only for the P3 "capture from stored pre-change state" case - never a crawl.
//
// Run safety (the M6 pattern, docs/M6_IMPLEMENTATION_NOTES.md §3a):
//   - a tracking run is a cache hit (zero writes) only when the input
//     fingerprint AND the output-state fingerprint equal the last completed
//     run's;
//   - one tracking run / implementation record per business at a time
//     (lease lock trackingRunLocks/{businessId}, shared by both endpoints);
//   - all reads happen before any write; writes are chunked batches of
//     full-document or field updates with deterministic ids; a failure marks
//     the run "failed" (phase + chunks) and the next run repairs the state.

const crypto = require("crypto");
const admin = require("firebase-admin");
const P = require("./predictionRules");
const T = require("./trackingRules");
const cfg = require("./predictionConfig");
const { pageKey: pageKeyOf, bareHost } = require("./webUtils");
const { captureBaseline } = require("./searchIntelligenceStore");

const FINGERPRINT_VERSION = 1;
const LOCK_LEASE_MS = 5 * 60 * 1000;
const BATCH_SIZE = 400;
const HISTORY_CAP = 30;

function clean(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined).map(clean);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = clean(v);
    return out;
  }
  return value;
}

const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const byId = (list) => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));
const latestCompleted = (list) => list.filter((r) => r.status === "completed").sort((a, b) => (b.completedAtMs || 0) - (a.completedAtMs || 0) || String(b.id).localeCompare(String(a.id)))[0] || null;
const stripPrivate = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith("_")));
const capHistory = (list) => (list.length > HISTORY_CAP ? list.slice(list.length - HISTORY_CAP) : list);

class TrackingError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// inputs

async function loadInputs(businessId) {
  const db = admin.firestore();
  const byBiz = (c) => db.collection(c).where("businessId", "==", businessId).get();
  const names = ["decisions", "searchIntents", "seoPages", "topicIntelligence", "intelligenceRuns", "baselines", "searchSnapshots", "trafficSnapshots", "impactPredictions", "seoChangeEvents", "seoExperiments", "trackingRuns"];
  const [bizDoc, ...snaps] = await Promise.all([db.collection("businesses").doc(businessId).get(), ...names.map(byBiz)]);
  const data = Object.fromEntries(names.map((n, i) => [n, rows(snaps[i])]));
  const run = latestCompleted(data.intelligenceRuns);
  return {
    business: { id: businessId, ...(bizDoc.exists ? bizDoc.data() : {}) },
    decisions: data.decisions,
    intents: data.searchIntents,
    seoPages: data.seoPages,
    run,
    intelligenceRuns: data.intelligenceRuns,
    topicIntel: run ? data.topicIntelligence.filter((t) => t.runId === run.id && !t.superseded) : [],
    baselines: data.baselines,
    searchSnapshots: data.searchSnapshots,
    trafficSnapshots: data.trafficSnapshots,
    predictions: data.impactPredictions,
    events: data.seoChangeEvents,
    experiments: data.seoExperiments,
    trackingRuns: data.trackingRuns,
    lastRun: latestCompleted(data.trackingRuns)
  };
}

const timeZoneOf = (inputs) => inputs.business.timeZone || cfg.DEFAULT_TIME_ZONE;
const snapMs = (s) => P.toMs(s.retrievedAt) ?? P.toMs(s.retrievedAtMs);
const latestSnap = (list) => [...list].filter((s) => snapMs(s) != null).sort((a, b) => snapMs(b) - snapMs(a) || String(b.id).localeCompare(String(a.id)))[0] || null;

// ---------------------------------------------------------------------------
// prediction inputs

function targetOf(decision, effectiveDecision, recommendedPage) {
  if (decision.scope === "site") return { scope: "site", kind: "site", pageKey: "site" };
  if (effectiveDecision === "CREATE") return { scope: decision.scope, kind: "new_page", pageKey: null };
  const rp = recommendedPage || decision.recommendedPage || {};
  return { scope: decision.scope, kind: "existing", pageKey: decision.scope === "page" ? decision.pageKey : rp.pageKey || null };
}

function normalizeLivePage(p) {
  if (!p) return null;
  const st = (x) => (x && typeof x === "object" ? x.state : x) || "unknown";
  return {
    crawlStatus: p.crawlStatus || null,
    indexability: st(p.indexability),
    robots: st(p.robots),
    canonical: st(p.canonical),
    sitemap: st(p.sitemap),
    structuredData: st(p.structuredData),
    inboundInternalCount: p.links && typeof p.links.inboundInternalCount === "number" ? p.links.inboundInternalCount : null,
    orphan: st(p.orphan),
    role: p.role && p.role.role ? p.role.role : null,
    wordCount: typeof p.wordCount === "number" ? p.wordCount : null
  };
}

function normalizeBaselinePage(p) {
  if (!p) return null;
  return {
    crawlStatus: p.crawlStatus || null,
    indexability: p.indexability || "unknown",
    robots: p.robots || "unknown",
    canonical: p.canonical || "unknown",
    sitemap: p.sitemap || "unknown",
    structuredData: p.structuredData || "unknown",
    inboundInternalCount: typeof p.inboundInternalCount === "number" ? p.inboundInternalCount : null,
    orphan: p.orphan || "unknown",
    role: null,
    wordCount: typeof p.wordCount === "number" ? p.wordCount : null
  };
}

// Visibility of the target (page key) within the given topics, from either
// live topicIntelligence or a baseline's topics (same gscCurrent shape).
function visibilityFrom(topicDocs, pageKey) {
  if (!topicDocs.length) return { status: "unknown" };
  const avail = topicDocs.filter((t) => t.gscCurrent && t.gscCurrent.status === "available");
  if (!avail.length) {
    const none = topicDocs.every((t) => t.gscCurrent && t.gscCurrent.status === "no_observation");
    return none ? { status: "zero", impressions: 0, clicks: 0, position: null, queryCount: 0 } : { status: "unknown" };
  }
  let list = avail.flatMap((t) => t.gscCurrent.pages || []);
  if (pageKey) list = list.filter((p) => p.pageKey === pageKey);
  if (!list.length) return { status: "zero", impressions: 0, clicks: 0, position: null, queryCount: 0 };
  const impressions = list.reduce((a, p) => a + (p.impressions || 0), 0);
  const clicks = list.reduce((a, p) => a + (p.clicks || 0), 0);
  const position = impressions > 0 ? Math.round((list.reduce((a, p) => a + (p.position || 0) * (p.impressions || 0), 0) / impressions) * 10) / 10 : null;
  const queries = new Set(list.flatMap((p) => p.queries || []));
  return { status: impressions > 0 ? "observed" : "zero", impressions, clicks, position, queryCount: queries.size || null };
}

function topicIdsOf(decision, inputs) {
  const intent = decision.intentId ? inputs.intents.find((i) => i.id === decision.intentId || i.intentId === decision.intentId) : null;
  return intent ? [...(intent.topicIds || [])].sort() : [];
}

function topicsForTarget(decision, target, topicIds, topicDocs) {
  if (target.kind === "site") return [];
  if (topicIds.length) return topicDocs.filter((t) => topicIds.includes(t.topicId));
  // page-scope decision: every topic whose observed pages include the target
  return topicDocs.filter((t) => t.gscCurrent && t.gscCurrent.status === "available" && (t.gscCurrent.pages || []).some((p) => p.pageKey === target.pageKey));
}

function marketDemandOf(topicDocs) {
  const avail = topicDocs.filter((t) => t.semrush && t.semrush.status === "available");
  if (!avail.length) return { status: "not_available" };
  return { status: "available", monthlyVolume: avail.reduce((a, t) => a + (t.semrush.totalMonthlyVolume || 0), 0) };
}

function siteOf(searchSnaps, trafficSnap) {
  const traffic = trafficSnap && trafficSnap.data ? (() => {
    const organic = (trafficSnap.data.byChannel || []).find((c) => /organic search/i.test(c.channel || ""));
    return { status: "available", organicSessions: organic ? organic.sessions : null, conversions: typeof trafficSnap.data.conversions === "number" ? trafficSnap.data.conversions : null };
  })() : { status: "unknown" };
  return { searchConsole: P.siteActivityOf(latestSnap(searchSnaps)), volatility: P.volatilityOf(searchSnaps), traffic };
}

function intentOf(decision, inputs) {
  const i = decision.intentId ? inputs.intents.find((x) => x.id === decision.intentId || x.intentId === decision.intentId) : null;
  return i ? { intentType: i.intentType || null, intentConfidence: i.intentConfidence || null, queryCount: i.queryCount ?? null } : null;
}

function decisionView(d, rec) {
  return { decisionId: d.id, decision: rec.effectiveDecision, actionDetail: rec.actionDetails[0] || null, actionDetails: rec.actionDetails, scope: d.scope, intentId: d.intentId || null, opportunityIds: d.opportunityIds || [], confidence: d.confidence || null };
}

// Provisional input: current (live) evidence.
function provisionalInput(d, rec, inputs) {
  const target = targetOf(d, rec.effectiveDecision, rec.recommendedPage);
  const topicIds = topicIdsOf(d, inputs);
  const topics = topicsForTarget(d, target, topicIds, inputs.topicIntel);
  const page = target.kind === "existing" ? inputs.seoPages.find((p) => p.pageKey === target.pageKey) || null : null;
  const cand = target.kind === "site" ? latestBaseline(inputs.baselines) : latestBaseline(inputs.baselines.filter((b) => T.baselineContains(b, { ...target, topicIds })));
  const searchLatest = latestSnap(inputs.searchSnapshots);
  const trafficLatest = latestSnap(inputs.trafficSnapshots);
  const evidenceAsOfMs = Math.max(inputs.run ? inputs.run.completedAtMs || 0 : 0, searchLatest ? snapMs(searchLatest) : 0, trafficLatest ? snapMs(trafficLatest) : 0) || null;
  return {
    businessId: inputs.business.id,
    kind: "provisional",
    unitKey: d.id,
    decision: decisionView(d, rec),
    change: null,
    target: target.kind === "site" ? null : { pageKey: target.pageKey, page: normalizeLivePage(page), pageBasis: page ? "live_seo_pages" : "none" },
    visibility: target.kind === "site" ? { status: "unknown" } : visibilityFrom(topics, target.kind === "existing" ? target.pageKey : null),
    site: siteOf(inputs.searchSnapshots, trafficLatest),
    intent: intentOf(d, inputs),
    marketDemand: marketDemandOf(topics),
    baseline: cand ? { status: "candidate", baselineId: cand.baselineId || cand.id, targetType: target.kind === "site" ? "business" : target.kind === "new_page" ? "topic" : "page", targetId: target.kind === "site" ? inputs.business.id : target.pageKey || topicIds[0] || null } : { status: "missing" },
    retroactive: false,
    derivation: "provisional",
    evidenceAsOfMs,
    sources: { intelligenceRunId: inputs.run ? inputs.run.id : null }
  };
}

const latestBaseline = (list) => [...list].sort((a, b) => (b.capturedAtMs || 0) - (a.capturedAtMs || 0) || (b.version || 0) - (a.version || 0))[0] || null;

// Committed / re-derived input: ONLY evidence from before `cutoffMs`.
// The stored seoPages / topicIntelligence are the latest run's state, so
// they qualify only when that run completed before the cutoff; otherwise the
// pre-change before-snapshot provides page and visibility evidence.
function committedInput({ d, rec, inputs, cutoffMs, change, target, beforeSnapshot, baselineDoc, derivation }) {
  const topicIds = topicIdsOf(d, inputs);
  const ev = P.preChangeEvidence({ intelligenceRuns: inputs.intelligenceRuns, searchSnapshots: inputs.searchSnapshots, trafficSnapshots: inputs.trafficSnapshots, baselines: [] }, cutoffMs);
  const liveIsPreChange = !!inputs.run && inputs.run.completedAtMs < cutoffMs;
  let page = null;
  let pageBasis = "none";
  let visibility = { status: "unknown" };
  let topics = [];
  if (target.kind !== "site") {
    if (liveIsPreChange) {
      topics = topicsForTarget(d, target, topicIds, inputs.topicIntel);
      const live = target.kind === "existing" ? inputs.seoPages.find((p) => p.pageKey === target.pageKey) : null;
      page = target.kind === "existing" ? normalizeLivePage(live || null) : null;
      pageBasis = live ? "live_seo_pages_pre_change" : "none";
      visibility = visibilityFrom(topics, target.kind === "existing" ? target.pageKey : null);
    } else if (baselineDoc) {
      topics = topicsForTarget(d, target, topicIds, baselineDoc.topics || []);
      const bp = target.kind === "existing" ? (baselineDoc.pages || []).find((p) => p.pageKey === target.pageKey) : null;
      page = normalizeBaselinePage(bp || null);
      pageBasis = bp ? "before_snapshot" : "none";
      visibility = visibilityFrom(topics, target.kind === "existing" ? target.pageKey : null);
    }
  }
  const md = topics.length ? marketDemandOf(topics) : { status: "not_available" };
  const evidenceAsOfMs = Math.max(liveIsPreChange && inputs.run ? inputs.run.completedAtMs : baselineDoc ? baselineDoc.capturedAtMs || 0 : 0, ev.latestSearch ? snapMs(ev.latestSearch) : 0, ev.latestTraffic ? snapMs(ev.latestTraffic) : 0) || null;
  return {
    businessId: inputs.business.id,
    kind: "committed",
    unitKey: change.changeEventId,
    decision: decisionView(d, rec),
    change,
    target: target.kind === "site" ? null : { pageKey: target.pageKey, page, pageBasis },
    visibility,
    site: siteOf(ev.searchSnapshots, ev.latestTraffic),
    intent: intentOf(d, inputs),
    marketDemand: md,
    baseline: { status: beforeSnapshot.status, baselineId: beforeSnapshot.baselineId || null, targetType: beforeSnapshot.targetType || null, targetId: beforeSnapshot.targetId || null },
    retroactive: derivation === "retroactive",
    derivation,
    evidenceAsOfMs,
    sources: { intelligenceRunId: liveIsPreChange && inputs.run ? inputs.run.id : ev.run ? ev.run.id : null, evidenceCutoffMs: cutoffMs, pageBasis }
  };
}

// ---------------------------------------------------------------------------
// fingerprints

const VOLATILE = new Set(["updatedAt", "lastEvaluatedAtMs", "decisionRunId", "createdAt", "lastCrawledAt", "computedAt", "completedAt", "capturedAt", "trackingRunId"]);
const stable = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !VOLATILE.has(k)));

function semanticInput(inputs, nowMs) {
  const s = siteOf(inputs.searchSnapshots, latestSnap(inputs.trafficSnapshots));
  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    versions: [cfg.PREDICTION_MODEL_VERSION, cfg.PREDICTION_CONFIG_VERSION, cfg.TRACKING_ENGINE_VERSION],
    priors: cfg.PRIORS,
    modifiers: cfg.MODIFIERS,
    window: cfg.WINDOW,
    grouping: cfg.GROUPING_WINDOW_DAYS,
    timeZone: timeZoneOf(inputs),
    decisions: byId(inputs.decisions.filter((d) => d.ownerStatus === "accepted" || inputs.events.some((e) => e.decisionId === d.id) || inputs.predictions.some((p) => p.decisionId === d.id && p.status === "provisional")).map(stable)),
    intents: byId(inputs.intents.map((i) => ({ id: i.id, topicIds: i.topicIds || [], intentType: i.intentType || null, intentConfidence: i.intentConfidence || null, queryCount: i.queryCount ?? null }))),
    seoPages: byId(inputs.seoPages.map(stable)),
    topicIntel: byId(inputs.topicIntel.map((t) => ({ id: t.id, runId: t.runId, gscCurrent: t.gscCurrent || null, semrush: t.semrush || null }))),
    runs: byId(inputs.intelligenceRuns.map((r) => ({ id: r.id, status: r.status, completedAtMs: r.completedAtMs || null }))),
    baselines: byId(inputs.baselines.map((b) => ({ id: b.id, capturedAtMs: b.capturedAtMs || null, sourceRunId: b.sourceRunId || null, referenceKeys: b.referenceKeys || null }))),
    site: { activity: s.searchConsole.band, volatility: s.volatility.band, traffic: s.traffic.status },
    // owner-originated facts only (M7's own lifecycle output is the state fingerprint)
    events: byId(inputs.events.map((e) => ({ id: e.id, decisionId: e.decisionId, startMs: e.startMs, changedElements: e.changedElements, reverted: e.implementationStatus === "reverted", predictionId: e.predictionId, beforeSnapshot: e.beforeSnapshot || null }))),
    experimentOwnerFields: byId(inputs.experiments.map((x) => ({ id: x.id, ownerHoldRelease: x.ownerHoldRelease || null }))),
    // time passing changes the fingerprint only when a boundary is crossed
    timeVector: byId(inputs.experiments.map((x) => ({ id: x.id, ...pick(T.timeStateOf(x, nowMs), ["timePhase", "timeState", "holdActive", "warnings"]) })))
  };
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

function stateFingerprint(predictions, events, experiments) {
  return P.stableHash({
    predictions: predictions.map((p) => [p.id, p.status || null]).sort((a, b) => a[0].localeCompare(b[0])),
    events: events.map((e) => [e.id, e.implementationStatus || null, e.verification ? e.verification.status : null, e.experimentId || null]).sort((a, b) => a[0].localeCompare(b[0])),
    experiments: experiments.map((x) => [x.id, x.timeState || null, x.hold ? x.hold.holdUntilMs : null, x.status || null, x.engineHash || null]).sort((a, b) => a[0].localeCompare(b[0]))
  });
}

// ---------------------------------------------------------------------------
// lease lock (shared by tracking runs and implementation records)

function isAlreadyExists(err) {
  return err && (err.code === 6 || err.code === "already-exists" || /ALREADY_EXISTS|already exists/i.test(err.message || ""));
}

async function acquireLock(db, businessId, nowMs, owner, purpose) {
  const ref = db.collection("trackingRunLocks").doc(businessId);
  const lock = { businessId, owner, purpose, acquiredAtMs: nowMs, leaseExpiresAtMs: nowMs + LOCK_LEASE_MS };
  try {
    await ref.create(lock);
    return { ok: true, ref };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  const snap = await ref.get();
  const held = snap.exists ? snap.data() : null;
  if (held && held.leaseExpiresAtMs > nowMs) return { ok: false, held };
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
    console.error("trackingRunLocks release failed:", err.message);
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
// the plan: desired M7 state from the inputs (deterministic) -> write ops

function eventView(e, inputs) {
  const crawlsSinceStart = inputs.intelligenceRuns.filter((r) => r.status === "completed" && (r.completedAtMs || 0) > e.startMs).length;
  return {
    changeEventId: e.id,
    unitKey: e.unitKey,
    scope: e.scope,
    decisionId: e.decisionId,
    intentId: e.intentId || null,
    signalKey: e.signalKey || null,
    opportunityIds: e.opportunityIds || [],
    affectedPageKeys: e.affectedPageKeys || [],
    startMs: e.startMs,
    startDate: e.publicationDate || e.implementationDate,
    implementationStatus: e.implementationStatus,
    predictionId: e.predictionId,
    baselineSnapshot: e.beforeSnapshot ? { status: e.beforeSnapshot.status, baselineId: e.beforeSnapshot.baselineId || null, targetType: e.beforeSnapshot.targetType || null, targetId: e.beforeSnapshot.targetId || null } : { status: "missing" },
    beforeEligibility: e.beforeEligibility || {},
    crawlsSinceStart
  };
}

function engineHashOf(doc) {
  const { timePhase, warnings, holdActive, holdReason, ...rest } = doc;
  return P.stableHash({ ...rest, timePhase, warnings, holdActive, holdReason });
}

function planExperiments({ db, inputs, events, predictionsById, nowMs, runId, ops, history }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const existing = new Map(inputs.experiments.map((x) => [x.id, x]));
  const { experiments, eventExperiment, eventLate } = T.buildExperiments({ businessId: inputs.business.id, events: events.map((e) => eventView(e, inputs)), predictions: predictionsById, existing, nowMs });
  const finalExperiments = new Map(inputs.experiments.map((x) => [x.id, x]));
  const expPredictions = [];
  for (const x of experiments) {
    const doc = stripPrivate(x);
    const engineHash = engineHashOf(doc);
    const prev = existing.get(x.experimentId);
    if (x._expPred) expPredictions.push(x._expPred);
    if (prev && prev.engineHash === engineHash) continue;
    const entry = { at: nowMs, event: prev ? "updated" : "created", trackingRunId: runId || null, timeState: doc.timeState, status: doc.status, changeEventIds: doc.changeEventIds };
    const data = { ...doc, engineHash, ownerHoldRelease: prev ? prev.ownerHoldRelease || null : null, history: capHistory([...((prev && prev.history) || []), entry]), createdAtMs: prev && prev.createdAtMs ? prev.createdAtMs : nowMs, lastEvaluatedAtMs: nowMs, trackingRunId: runId || null, updatedAt: now };
    ops.push({ ref: db.collection("seoExperiments").doc(x.experimentId), kind: "set", data });
    finalExperiments.set(x.experimentId, { id: x.experimentId, ...data });
    history.experiments++;
  }
  // experiment-level predictions (content-addressed; previous ones superseded)
  const predIds = new Set(inputs.predictions.map((p) => p.id));
  const currentExpPred = new Map(expPredictions.map((p) => [p.experimentId, p.predictionId]));
  for (const p of expPredictions) {
    if (predIds.has(p.predictionId)) continue;
    ops.push({ ref: db.collection("impactPredictions").doc(p.predictionId), kind: "set", data: { ...p, status: "active", supersededBy: null, createdAtMs: nowMs, createdAt: now } });
    predIds.add(p.predictionId);
    history.predictionsCreated++;
  }
  for (const p of inputs.predictions) {
    if (p.kind !== "experiment" || p.status !== "active") continue;
    const cur = currentExpPred.get(p.experimentId);
    if (cur && cur !== p.id) {
      ops.push({ ref: db.collection("impactPredictions").doc(p.id), kind: "update", data: { status: "superseded", supersededBy: cur, supersededAtMs: nowMs, updatedAt: now } });
      history.predictionsSuperseded++;
    }
  }
  // change events: experiment link / late flag
  const eventUpdates = new Map();
  for (const e of events) {
    const expId = eventExperiment[e.id] || null;
    const late = !!eventLate[e.id];
    if (e.experimentId !== expId || !!e.lateJoin !== late) eventUpdates.set(e.id, { experimentId: expId, lateJoin: late });
  }
  return { experiments, finalExperiments, eventUpdates, expPredictions };
}

function verificationPlan(inputs, nowMs) {
  const out = new Map();
  const run = inputs.run;
  if (!run) return out;
  const pagesByKey = new Map(inputs.seoPages.map((p) => [p.pageKey, p]));
  const baselinesById = new Map(inputs.baselines.map((b) => [b.baselineId || b.id, b]));
  for (const e of inputs.events) {
    if (e.implementationStatus === "reverted") continue;
    if (!(run.completedAtMs > e.startMs) || e.startMs > nowMs) continue; // no crawl after publication yet
    const current = e.scope === "site" ? null : pagesByKey.get(e.targetPageKey) || null;
    if (e.scope !== "site" && current && !(current.lastCrawledAtMs > e.startMs) && current.crawlStatus === "fetched") continue;
    const b = e.beforeSnapshot && e.beforeSnapshot.status === "linked" ? baselinesById.get(e.beforeSnapshot.baselineId) : null;
    const before = b ? (b.pages || []).find((p) => p.pageKey === e.targetPageKey) || null : null;
    const affected = (e.affectedPageKeys || []).map((k) => pagesByKey.get(k)).filter(Boolean);
    const v = T.verifyChange({ changedElements: e.changedElements || [], changeClasses: e.changeClasses || [], before, current, affected });
    const verification = { status: v.status, checks: v.checks, note: v.note, checkedInRunId: run.id, atMs: run.completedAtMs };
    const prev = e.verification || null;
    if (prev && prev.status === v.status && prev.checkedInRunId === run.id && JSON.stringify(prev.checks) === JSON.stringify(v.checks)) continue;
    out.set(e.id, verification);
  }
  return out;
}

// Provisional predictions for accepted actionable decisions that have no
// live implementation yet (AD-1 lifecycle D).
function provisionalPlan(inputs) {
  const live = new Set(inputs.events.filter((e) => T.LIVE_STATUSES.includes(e.implementationStatus)).map((e) => e.decisionId));
  const wanted = new Map();
  for (const d of inputs.decisions) {
    if (live.has(d.id)) continue;
    const rec = T.recordableDecision(d);
    if (!rec.ok) continue;
    try {
      wanted.set(d.id, P.predict(provisionalInput(d, rec, inputs)));
    } catch (err) {
      // a decision without an actionable detail cannot be predicted - skip
    }
  }
  return wanted;
}

// ---------------------------------------------------------------------------
// tracking run (explicit button only)

async function runTracking({ businessId, nowMs = Date.now(), batchSize = BATCH_SIZE }) {
  const db = admin.firestore();
  const fps = (inputs) => ({ inputHash: P.stableHash(semanticInput(inputs, nowMs)), stateHash: stateFingerprint(inputs.predictions, inputs.events, inputs.experiments) });
  const hitOf = (inputs, fp) =>
    inputs.lastRun && inputs.lastRun.inputHash === fp.inputHash && inputs.lastRun.outputStateHash === fp.stateHash
      ? { cacheHit: true, decision: "cache_hit", runId: inputs.lastRun.id, providerCalled: false, summary: inputs.lastRun.summary, written: 0 }
      : null;
  let inputs = await loadInputs(businessId);
  let fp = fps(inputs);
  const early = hitOf(inputs, fp);
  if (early) return early;
  const owner = `${nowMs}_${crypto.randomUUID()}`;
  const lock = await acquireLock(db, businessId, nowMs, owner, "tracking_run");
  if (!lock.ok) return { cacheHit: false, decision: "in_progress", inProgress: true, providerCalled: false, written: 0, lockedSinceMs: lock.held ? lock.held.acquiredAtMs : null, summary: null };
  try {
    inputs = await loadInputs(businessId);
    fp = fps(inputs);
    const hit = hitOf(inputs, fp);
    if (hit) return hit;
    return await computeAndWriteTracking({ db, businessId, nowMs, inputs, fp, owner, tookOver: lock.tookOver || null, batchSize });
  } finally {
    await releaseLock(lock.ref, owner);
  }
}

async function computeAndWriteTracking({ db, businessId, nowMs, inputs, fp, owner, tookOver, batchSize }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const runId = `${businessId}_trk_${fp.inputHash.slice(0, 24)}`;
  const runRef = db.collection("trackingRuns").doc(runId);
  const sameInputRun = inputs.trackingRuns.find((r) => r.id === runId) || null;
  const attempt = ((sameInputRun && sameInputRun.attempt) || 0) + 1;
  const abandoned = inputs.trackingRuns.filter((r) => r.status === "running" && r.id !== runId);
  const base = { businessId, kind: "tracking_run", inputHash: fp.inputHash, attempt, lockOwner: owner, startedAtMs: nowMs, engineVersion: cfg.TRACKING_ENGINE_VERSION, predictionModelVersion: cfg.PREDICTION_MODEL_VERSION, predictionConfigVersion: cfg.PREDICTION_CONFIG_VERSION, intelligenceRunId: inputs.run ? inputs.run.id : null, providerCalled: false, ...(tookOver ? { tookOverLockFrom: tookOver.owner || null } : {}) };
  const progress = { phase: "start", chunksCommitted: 0, opsCommitted: 0, totalOps: 0 };
  await runRef.set(clean({ ...base, status: "running", completedAtMs: null, error: null }));
  try {
    progress.phase = "compute";
    const ops = [];
    const history = { predictionsCreated: 0, predictionsSuperseded: 0, predictionsWithdrawn: 0, verified: 0, experiments: 0, eventsLinked: 0 };
    for (const r of abandoned) ops.push({ ref: db.collection("trackingRuns").doc(r.id), kind: "update", data: { status: "abandoned", abandonedAtMs: nowMs, abandonedByRunId: runId } });

    // 1. provisional predictions
    const wanted = provisionalPlan(inputs);
    const finalPredictions = new Map(inputs.predictions.map((p) => [p.id, { id: p.id, status: p.status }]));
    const existingIds = new Set(inputs.predictions.map((p) => p.id));
    const activeProvisional = inputs.predictions.filter((p) => p.kind === "provisional" && p.status === "provisional");
    for (const [decisionId, pred] of [...wanted.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!existingIds.has(pred.predictionId)) {
        const version = inputs.predictions.filter((p) => p.kind === "provisional" && p.decisionId === decisionId).length + 1;
        ops.push({ ref: db.collection("impactPredictions").doc(pred.predictionId), kind: "set", data: { ...pred, predictionVersion: version, status: "provisional", supersededBy: null, committedTo: null, trackingRunId: runId, createdAtMs: nowMs, createdAt: now } });
        finalPredictions.set(pred.predictionId, { id: pred.predictionId, status: "provisional" });
        history.predictionsCreated++;
      }
      for (const old of activeProvisional.filter((p) => p.decisionId === decisionId && p.id !== pred.predictionId)) {
        ops.push({ ref: db.collection("impactPredictions").doc(old.id), kind: "update", data: { status: "superseded", supersededBy: pred.predictionId, supersededAtMs: nowMs, updatedAt: now } });
        finalPredictions.set(old.id, { id: old.id, status: "superseded" });
        history.predictionsSuperseded++;
      }
    }
    for (const old of activeProvisional.filter((p) => !wanted.has(p.decisionId))) {
      ops.push({ ref: db.collection("impactPredictions").doc(old.id), kind: "update", data: { status: "withdrawn", withdrawnReason: "the decision is no longer an accepted actionable decision", withdrawnAtMs: nowMs, updatedAt: now } });
      finalPredictions.set(old.id, { id: old.id, status: "withdrawn" });
      history.predictionsWithdrawn++;
    }

    // 2. crawl verification of recorded changes
    const verifications = verificationPlan(inputs, nowMs);
    const events = inputs.events.map((e) => {
      const v = verifications.get(e.id);
      return v ? { ...e, verification: v, implementationStatus: v.status } : e;
    });

    // 3. experiments (+ experiment-level predictions, event links)
    const predictionsById = new Map(inputs.predictions.map((p) => [p.id, p]));
    const exp = planExperiments({ db, inputs, events, predictionsById, nowMs, runId, ops, history });
    for (const p of exp.expPredictions) if (!finalPredictions.has(p.predictionId)) finalPredictions.set(p.predictionId, { id: p.predictionId, status: "active" });
    for (const p of inputs.predictions) if (p.kind === "experiment" && p.status === "active" && !exp.expPredictions.some((x) => x.predictionId === p.id) && exp.expPredictions.some((x) => x.experimentId === p.experimentId)) finalPredictions.set(p.id, { id: p.id, status: "superseded" });

    const finalEvents = [];
    for (const e of events) {
      const v = verifications.get(e.id);
      const link = exp.eventUpdates.get(e.id);
      const data = {};
      if (v) {
        Object.assign(data, { verification: v, implementationStatus: v.status, history: capHistory([...(e.history || []), { at: nowMs, event: "verification", status: v.status, intelligenceRunId: inputs.run.id, trackingRunId: runId }]) });
        history.verified++;
      }
      if (link) {
        Object.assign(data, link);
        history.eventsLinked++;
      }
      if (Object.keys(data).length) ops.push({ ref: db.collection("seoChangeEvents").doc(e.id), kind: "update", data: { ...data, updatedAt: now } });
      finalEvents.push({ ...e, ...data });
    }

    progress.phase = "write";
    progress.totalOps = ops.length;
    await commitInBatches(db, ops, progress, batchSize);

    progress.phase = "finalize";
    const outputStateHash = stateFingerprint([...finalPredictions.values()], finalEvents, [...exp.finalExperiments.values()]);
    const summary = {
      acceptedActionableDecisions: wanted.size,
      ...history,
      changeEvents: inputs.events.length,
      experiments: exp.experiments.length,
      openExperiments: exp.experiments.filter((x) => x.status === "open").length,
      activeHolds: exp.experiments.filter((x) => x.holdActive).length,
      abandonedRuns: abandoned.length
    };
    await runRef.set(clean({ ...base, status: "completed", completedAtMs: nowMs, completedAt: now, error: null, writes: { ops: ops.length, chunks: progress.chunksCommitted }, outputStateHash, summary, abandonedRunIds: abandoned.map((r) => r.id) }));
    return { cacheHit: false, decision: "computed", runId, providerCalled: false, summary, written: ops.length + 2 };
  } catch (err) {
    try {
      await runRef.set(clean({ ...base, status: "failed", failedAtMs: nowMs, error: String(err && err.message ? err.message : err).slice(0, 500), failedPhase: progress.phase, chunksCommitted: progress.chunksCommitted, opsCommitted: progress.opsCommitted, totalOps: progress.totalOps, recovery: "re-run tracking; writes are idempotent and the next run repairs partial state" }));
    } catch (markErr) {
      console.error("trackingRuns failure mark failed:", markErr.message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// implementation recording (explicit form) and revert

function siteHostOf(business) {
  try {
    return bareHost(new URL(business.website).hostname);
  } catch (err) {
    return null;
  }
}

function resolveTarget(d, rec, value, business) {
  const target = targetOf(d, rec.effectiveDecision, rec.recommendedPage);
  let match = value.implementationMatch;
  const host = siteHostOf(business);
  const onSite = (u) => {
    try {
      return !host || bareHost(new URL(u).hostname) === host;
    } catch (err) {
      return false;
    }
  };
  if (target.kind === "site") return { target, targetUrl: null, match };
  if (target.kind === "new_page") {
    if (!value.targetUrl) throw new TrackingError(400, "targetUrl (the new page's URL) is required for a CREATE implementation");
    if (!onSite(value.targetUrl)) throw new TrackingError(400, "targetUrl must be on the business's own website");
    return { target: { ...target, pageKey: pageKeyOf(value.targetUrl) }, targetUrl: value.targetUrl, match };
  }
  if (!target.pageKey) throw new TrackingError(409, "the decision has no existing target page to implement against");
  let targetUrl = (rec.recommendedPage && rec.recommendedPage.url) || null;
  if (value.targetUrl) {
    if (!onSite(value.targetUrl)) throw new TrackingError(400, "targetUrl must be on the business's own website");
    if (pageKeyOf(value.targetUrl) !== target.pageKey) {
      // implemented on a different page than recommended: recorded, but never as a full match
      if (match === "full") match = "partial";
      if (!value.deviationNote) throw new TrackingError(400, "the change was made on a different page than recommended - add a deviation note");
      return { target: { ...target, pageKey: pageKeyOf(value.targetUrl), deviatedFrom: target.pageKey }, targetUrl: value.targetUrl, match };
    }
    targetUrl = value.targetUrl;
  }
  return { target, targetUrl, match };
}

async function withLock(businessId, nowMs, purpose, fn) {
  const db = admin.firestore();
  const owner = `${nowMs}_${crypto.randomUUID()}`;
  const lock = await acquireLock(db, businessId, nowMs, owner, purpose);
  if (!lock.ok) return { decision: "in_progress", inProgress: true, providerCalled: false, written: 0, lockedSinceMs: lock.held ? lock.held.acquiredAtMs : null };
  try {
    return await fn(db);
  } finally {
    await releaseLock(lock.ref, owner);
  }
}

async function recordImplementation({ businessId, body, uid = null, nowMs = Date.now(), batchSize = BATCH_SIZE }) {
  if (body && body.action === "revert") return revertImplementation({ businessId, body, uid, nowMs, batchSize });
  let inputs = await loadInputs(businessId);
  const tz = timeZoneOf(inputs);
  const v = T.validateRecordRequest(body, { nowMs, timeZone: tz });
  if (!v.ok) throw new TrackingError(400, v.errors.join("; "), { errors: v.errors });
  const value = v.value;
  const d0 = inputs.decisions.find((x) => x.id === value.decisionId);
  if (!d0) throw new TrackingError(404, "decision not found");
  const rec0 = T.recordableDecision(d0);
  // Duplicate check FIRST (idempotent): the same implementation recorded
  // again returns the existing event and writes nothing - even after M6 has
  // turned the decision into MONITOR because of it.
  const probe = rec0.ok ? resolveTarget(d0, rec0, value, inputs.business) : null;
  const idFor = (t) => T.changeEventIdOf(businessId, value.decisionId, t.target.kind === "site" ? "site" : t.target.pageKey, value.implementedDate);
  if (probe) {
    const existing = inputs.events.find((e) => e.id === idFor(probe));
    if (existing) return { duplicate: true, changeEventId: existing.id, predictionId: existing.predictionId, experimentId: existing.experimentId || null, providerCalled: false, written: 0 };
  } else {
    const any = inputs.events.find((e) => e.decisionId === value.decisionId && e.implementationDate === value.implementedDate);
    if (any) return { duplicate: true, changeEventId: any.id, predictionId: any.predictionId, experimentId: any.experimentId || null, providerCalled: false, written: 0 };
  }
  if (!rec0.ok) throw new TrackingError(409, rec0.reason);

  return withLock(businessId, nowMs, "record_implementation", async (db) => {
    inputs = await loadInputs(businessId);
    const d = inputs.decisions.find((x) => x.id === value.decisionId);
    const rec = T.recordableDecision(d);
    if (!rec.ok) throw new TrackingError(409, rec.reason);
    const resolved = resolveTarget(d, rec, value, inputs.business);
    const target = resolved.target;
    const unitKey = target.kind === "site" ? "site" : target.pageKey;
    const changeEventId = T.changeEventIdOf(businessId, d.id, unitKey, value.implementedDate);
    const dup = inputs.events.find((e) => e.id === changeEventId);
    if (dup) return { duplicate: true, changeEventId, predictionId: dup.predictionId, experimentId: dup.experimentId || null, providerCalled: false, written: 0 };

    const now = admin.firestore.FieldValue.serverTimestamp();
    const cutoffMs = T.startOfDayMs(value.implementedDate, tz);
    const startDate = value.publishedDate || value.implementedDate;
    const startMs = T.startOfDayMs(startDate, tz);
    const topicIds = topicIdsOf(d, inputs);
    const snapTarget = { scope: d.scope, kind: target.kind, pageKey: target.pageKey, topicIds };

    // --- before-snapshot (P3: strictly pre-change, never a crawl) ---------
    const sel = T.selectBeforeSnapshot({ baselines: inputs.baselines, intelligenceRuns: inputs.intelligenceRuns, target: snapTarget, cutoffMs });
    let baselineDoc = null;
    let beforeSnapshot;
    const targetType = target.kind === "site" ? "business" : target.kind === "new_page" ? "topic" : "page";
    const targetId = target.kind === "site" ? businessId : target.kind === "new_page" ? topicIds[0] || null : target.pageKey;
    if (sel.status === "linked") {
      baselineDoc = sel.baseline;
      beforeSnapshot = { status: "linked", baselineId: baselineDoc.baselineId || baselineDoc.id, targetType, targetId, capturedAtMs: baselineDoc.capturedAtMs, sourceRunId: baselineDoc.sourceRunId || null, capturedAtRecording: false, reason: sel.reason };
    } else if (sel.status === "capture") {
      // build a NEW immutable baseline from the stored pre-change state
      // (Firestore-only; the target page is included first - #39)
      const extra = target.kind === "existing" ? [target.pageKey] : [];
      baselineDoc = await captureBaseline({ businessId, capturedBy: uid, note: `M7 before-snapshot for ${changeEventId} (stored pre-change analysis ${sel.run.id})`, nowMs, includePageKeys: extra, includeTopicIds: topicIds });
      const contains = T.baselineContains(baselineDoc, snapTarget);
      if (baselineDoc.sourceRunId !== sel.run.id) {
        // a concurrent M4 run changed the stored state - never use it as "before"
        beforeSnapshot = { status: "contaminated", baselineId: null, targetType, targetId, reason: "the stored analysis changed while recording - only post-change state is available" };
        baselineDoc = null;
      } else if (!contains) {
        beforeSnapshot = { status: "missing", baselineId: null, targetType, targetId, reason: "the target was not part of the last pre-change crawl" };
        baselineDoc = null;
      } else beforeSnapshot = { status: "linked", baselineId: baselineDoc.baselineId, targetType, targetId, capturedAtMs: baselineDoc.capturedAtMs, sourceRunId: baselineDoc.sourceRunId, capturedAtRecording: true, reason: sel.reason };
    } else beforeSnapshot = { status: sel.status, baselineId: null, targetType, targetId, reason: sel.reason };
    const beforePage = baselineDoc && target.kind === "existing" ? (baselineDoc.pages || []).find((p) => p.pageKey === target.pageKey) || null : null;
    const beforeEligibility = {};
    if (beforePage) beforeEligibility[target.pageKey] = P.eligibilityBlockerOf(beforePage) || "eligible";

    // --- prediction: commit the ex-ante provisional or re-derive ----------
    const change = { changeEventId, changedElements: value.changedElements, intentChange: value.intentChange };
    const classes = P.classesFromElements(value.changedElements, { intentChange: value.intentChange, decision: rec.effectiveDecision, scope: d.scope, fallbackDetails: rec.actionDetails });
    const provisional = inputs.predictions.find((p) => p.kind === "provisional" && p.status === "provisional" && p.decisionId === d.id) || null;
    const exAnte = !!provisional && provisional.evidenceAsOfMs != null && provisional.evidenceAsOfMs < cutoffMs;
    const ops = [];
    let predictionId;
    let committed;
    if (exAnte && JSON.stringify(provisional.changeClasses) === JSON.stringify(classes)) {
      predictionId = provisional.id;
      committed = provisional;
      ops.push({ ref: db.collection("impactPredictions").doc(provisional.id), kind: "update", data: { status: "committed", committedTo: changeEventId, committedAtMs: nowMs, commitBasis: "ex_ante", updatedAt: now } });
    } else {
      const derivation = exAnte ? "re_derived" : "retroactive";
      committed = P.predict(committedInput({ d, rec, inputs, cutoffMs, change, target, beforeSnapshot, baselineDoc, derivation }));
      predictionId = committed.predictionId;
      const existing = inputs.predictions.find((p) => p.id === predictionId);
      if (!existing) ops.push({ ref: db.collection("impactPredictions").doc(predictionId), kind: "set", data: { ...committed, predictionVersion: 1, status: "committed", committedTo: changeEventId, committedAtMs: nowMs, commitBasis: derivation, supersededBy: null, createdAtMs: nowMs, createdAt: now } });
      if (provisional) ops.push({ ref: db.collection("impactPredictions").doc(provisional.id), kind: "update", data: { status: "superseded", supersededBy: predictionId, supersededAtMs: nowMs, supersededReason: exAnte ? "implemented change class differs from the provisional prediction" : "provisional evidence was not pre-change", updatedAt: now } });
    }

    const event = {
      changeEventId,
      businessId,
      decisionId: d.id,
      decision: rec.effectiveDecision,
      opportunityIds: [...(d.opportunityIds || [])].sort(),
      intentId: d.intentId || null,
      signalKey: d.signalKey || null,
      scope: d.scope,
      unitKey,
      targetPageKey: target.kind === "site" ? "site" : target.pageKey,
      targetUrl: resolved.targetUrl,
      recommendedPageKey: target.deviatedFrom || (target.kind === "existing" ? target.pageKey : null),
      affectedPageKeys: d.consolidation && rec.effectiveDecision === "CONSOLIDATE" ? [...(d.consolidation.otherPageKeys || [])].sort() : [],
      changeType: P.primaryClassOf(classes),
      changeClasses: classes,
      changedElements: value.changedElements,
      intentChange: value.intentChange,
      implementationDate: value.implementedDate,
      publicationDate: value.publishedDate,
      timeZone: tz,
      startMs,
      evidenceCutoffMs: cutoffMs,
      implementationStatus: "recorded",
      implementationMatch: resolved.match,
      deviationNote: value.deviationNote,
      responsibleActor: value.responsibleActor,
      implementationNotes: value.implementationNotes,
      ownerAttestation: { attested: true, byUid: uid, atMs: nowMs },
      beforeSnapshot,
      beforeEligibility,
      afterSnapshot: { status: "pending", baselineId: null, reservedFor: "M8", earliestCaptureFromMs: startMs + (P.stageRange(committed, "B") || P.stageRange(committed, "A") || [7])[0] * T.DAY },
      predictionId,
      experimentId: null,
      lateJoin: false,
      verification: null,
      basis: "owner_reported",
      history: [{ at: nowMs, event: "recorded", byUid: uid, implementationMatch: resolved.match }],
      createdAtMs: nowMs,
      createdAt: now,
      recordedBy: uid,
      modelVersion: cfg.TRACKING_ENGINE_VERSION,
      configVersion: cfg.PREDICTION_CONFIG_VERSION
    };
    ops.unshift({ ref: db.collection("seoChangeEvents").doc(changeEventId), kind: "set", data: event });

    // --- experiments ---------------------------------------------------------
    const events = [...inputs.events, { id: changeEventId, ...event }];
    const predictionsById = new Map(inputs.predictions.map((p) => [p.id, p]));
    predictionsById.set(predictionId, { ...committed, id: predictionId, predictionId });
    const history = { experiments: 0, predictionsCreated: 0, predictionsSuperseded: 0 };
    const exp = planExperiments({ db, inputs, events, predictionsById, nowMs, runId: null, ops, history });
    for (const e of events) {
      const link = exp.eventUpdates.get(e.id);
      if (!link) continue;
      if (e.id === changeEventId) Object.assign(ops[0].data, link);
      else ops.push({ ref: db.collection("seoChangeEvents").doc(e.id), kind: "update", data: { ...link, updatedAt: now } });
    }
    const progress = { phase: "write", chunksCommitted: 0, opsCommitted: 0, totalOps: ops.length };
    await commitInBatches(db, ops, progress, batchSize);
    const experimentId = exp.eventUpdates.get(changeEventId) ? exp.eventUpdates.get(changeEventId).experimentId : null;
    const x = exp.experiments.find((e) => e.experimentId === experimentId) || null;
    return {
      duplicate: false,
      changeEventId,
      predictionId,
      predictionDerivation: committed.derivation === "provisional" ? "ex_ante" : committed.derivation,
      experimentId,
      experimentState: x ? x.timeState : null,
      lateJoin: !!(exp.eventUpdates.get(changeEventId) || {}).lateJoin,
      beforeSnapshot,
      implementationMatch: resolved.match,
      providerCalled: false,
      written: ops.length
    };
  });
}

async function revertImplementation({ businessId, body, uid, nowMs, batchSize }) {
  const id = body && body.changeEventId;
  if (!id) throw new TrackingError(400, "changeEventId is required to revert");
  return withLock(businessId, nowMs, "revert_implementation", async (db) => {
    const inputs = await loadInputs(businessId);
    const e = inputs.events.find((x) => x.id === id);
    if (!e) throw new TrackingError(404, "change event not found");
    if (e.implementationStatus === "reverted") return { duplicate: true, changeEventId: id, providerCalled: false, written: 0 };
    const now = admin.firestore.FieldValue.serverTimestamp();
    const note = typeof body.revertNote === "string" ? body.revertNote.trim().slice(0, 2000) : null;
    const update = { implementationStatus: "reverted", revertedAtMs: nowMs, revertNote: note, history: capHistory([...(e.history || []), { at: nowMs, event: "reverted", byUid: uid, note }]), updatedAt: now };
    const ops = [{ ref: db.collection("seoChangeEvents").doc(id), kind: "update", data: update }];
    const events = inputs.events.map((x) => (x.id === id ? { ...x, ...update } : x));
    const exp = planExperiments({ db, inputs, events, predictionsById: new Map(inputs.predictions.map((p) => [p.id, p])), nowMs, runId: null, ops, history: { experiments: 0, predictionsCreated: 0, predictionsSuperseded: 0 } });
    for (const [eid, link] of exp.eventUpdates) {
      if (eid === id) Object.assign(ops[0].data, link);
      else ops.push({ ref: db.collection("seoChangeEvents").doc(eid), kind: "update", data: { ...link, updatedAt: now } });
    }
    await commitInBatches(db, ops, { chunksCommitted: 0, opsCommitted: 0 }, batchSize);
    const x = exp.experiments.find((y) => y.changeEventIds.includes(id)) || null;
    return { duplicate: false, reverted: true, changeEventId: id, experimentId: x ? x.experimentId : null, experimentState: x ? x.timeState : null, providerCalled: false, written: ops.length };
  });
}

module.exports = { runTracking, recordImplementation, loadInputs, semanticInput, stateFingerprint, TrackingError, LOCK_LEASE_MS };
