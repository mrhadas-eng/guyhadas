// GuyHadas Visibility OS - M5 Opportunity Engine: run orchestration
// (docs/M5_OPPORTUNITY_ENGINE_DESIGN.md §4, §7, §8, §10, §12).
//
//   latest completed intelligenceRun + its topicIntelligence (M4)
//   + current owner topic statuses (M3.2) + seoPages + latest baseline
//     -> opportunityRules.detect()  (pure, deterministic)
//     -> opportunities (existing collection, source "opportunity_engine")
//     -> opportunityRuns (one per run: topic outcomes incl. NO_ACTION)
//
// No provider is called - this module reads and writes Firestore only.
// Analysis cache (MASTER §32): an identical semantic input returns the
// previous run (cache_hit) and writes nothing.
//
// Invariants: owner `status` is written only when a document is first
// created; `rejected` stays rejected; undetected opportunities are marked
// resolved, never deleted; no tasks / decisions / predictions / baselines /
// searchTopics / topicIntelligence writes.

const admin = require("firebase-admin");
const { hashInput } = require("./apiUsage");
const { detect, APPROVED } = require("./opportunityRules");
const { ENGINE_VERSION, CONFIG_VERSION, resolveWeights, THRESHOLDS } = require("./opportunityConfig");

const SOURCE = "opportunity_engine";

function rows(snap) {
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadInputs(businessId) {
  const db = admin.firestore();
  const byBiz = (c) => db.collection(c).where("businessId", "==", businessId).get();
  const [bizDoc, runsSnap, tiSnap, topicsSnap, pagesSnap, baselinesSnap, oppSnap, oppRunsSnap] = await Promise.all([
    db.collection("businesses").doc(businessId).get(),
    byBiz("intelligenceRuns"),
    byBiz("topicIntelligence"),
    byBiz("searchTopics"),
    byBiz("seoPages"),
    byBiz("baselines"),
    byBiz("opportunities"),
    byBiz("opportunityRuns")
  ]);
  const run = rows(runsSnap)
    .filter((r) => r.status === "completed")
    .sort((a, b) => (b.completedAtMs || 0) - (a.completedAtMs || 0))[0] || null;
  return {
    business: { id: businessId, ...(bizDoc.exists ? bizDoc.data() : {}) },
    run,
    topicIntel: run ? rows(tiSnap).filter((t) => t.runId === run.id && !t.superseded) : [],
    searchTopics: rows(topicsSnap),
    seoPages: rows(pagesSnap),
    baseline: rows(baselinesSnap).sort((a, b) => (b.version || 0) - (a.version || 0))[0] || null,
    engineOpps: rows(oppSnap).filter((o) => o.source === SOURCE),
    lastRun: rows(oppRunsSnap)
      .filter((r) => r.status === "completed")
      .sort((a, b) => (b.completedAtMs || 0) - (a.completedAtMs || 0))[0] || null
  };
}

// Everything that can change the result - and nothing else (no request
// timestamps or ids).
function semanticInput(inputs, weights) {
  const approved = inputs.searchTopics.filter((t) => APPROVED.includes(t.status)).map((t) => [t.id, t.status]).sort();
  return {
    engineVersion: ENGINE_VERSION,
    configVersion: CONFIG_VERSION,
    weights,
    intelligenceRunId: inputs.run ? inputs.run.id : null,
    baselineId: inputs.baseline ? inputs.baseline.id : null,
    approvedTopics: approved,
    topicIntel: inputs.topicIntel.map((t) => [t.id, t.computedAtMs || null]).sort(),
    pages: inputs.seoPages.map((p) => [p.pageKey, p.lastCrawledAtMs || null, p.crawlStatus || null]).sort()
  };
}

async function runOpportunityEngine({ businessId, nowMs = Date.now() }) {
  const db = admin.firestore();
  const inputs = await loadInputs(businessId);
  const { weights, applied } = resolveWeights(inputs.business.opportunityWeights);
  const inputHash = hashInput(semanticInput(inputs, weights));

  if (inputs.lastRun && inputs.lastRun.inputHash === inputHash) {
    return { cacheHit: true, decision: "cache_hit", runId: inputs.lastRun.id, providerCalled: false, summary: inputs.lastRun.summary, written: 0 };
  }

  const approvedNow = inputs.searchTopics.filter((t) => APPROVED.includes(t.status));
  const intelIds = new Set(inputs.topicIntel.map((t) => t.topicId));
  const now = admin.firestore.FieldValue.serverTimestamp();
  const runRef = await db.collection("opportunityRuns").add({ businessId, status: "running", startedAtMs: nowMs, inputHash });
  const runId = runRef.id;

  // Without a completed M4 run there is nothing to reason about - say so.
  if (!inputs.run) {
    const summary = { opportunities: 0, byPriority: { high: 0, medium: 0, low: 0 }, byType: {}, noAction: 0, waitForData: approvedNow.length, resolved: 0, approvedTopics: approvedNow.length };
    const doc = {
      businessId,
      status: "completed",
      completedAtMs: Date.now(),
      completedAt: now,
      inputHash,
      engineVersion: ENGINE_VERSION,
      configVersion: CONFIG_VERSION,
      weights,
      weightsOverride: applied,
      intelligenceRunId: null,
      baselineId: inputs.baseline ? inputs.baseline.id : null,
      outcome: "WAIT_FOR_DATA",
      reason: "no completed search-intelligence run - run the analysis first",
      topicEvaluations: approvedNow.map((t) => ({ topicId: t.id, title: t.title, outcome: "WAIT_FOR_DATA", reasons: ["עדיין לא הורץ ניתוח מודיעין חיפוש"] })),
      summary,
      providerCalled: false
    };
    await db.collection("opportunityRuns").doc(runId).set(doc);
    return { cacheHit: false, decision: "computed", runId, providerCalled: false, summary, written: 0 };
  }

  const result = detect({ business: inputs.business, run: inputs.run, topicIntel: inputs.topicIntel, searchTopics: inputs.searchTopics, seoPages: inputs.seoPages, baseline: inputs.baseline }, weights);

  // Approved topics with no intelligence in this run (approved after it).
  for (const t of approvedNow.filter((x) => !intelIds.has(x.id))) {
    result.topicEvaluations.push({ topicId: t.id, title: t.title, outcome: "WAIT_FOR_DATA", reasons: ["הנושא אושר אחרי הניתוח האחרון — יש להריץ ניתוח מודיעין חיפוש מחדש"] });
  }

  const baselineMatchesRun = !!(inputs.baseline && inputs.baseline.sourceRunId === inputs.run.id);
  const existingById = new Map(inputs.engineOpps.map((o) => [o.id, o]));
  const detectedIds = new Set();
  let created = 0;
  let updated = 0;

  for (const o of result.opportunities) {
    const id = `${businessId}_${o.dedupeKey}`;
    detectedIds.add(id);
    const engineFields = {
      ...o,
      businessId,
      source: SOURCE,
      engineState: "active",
      lastDetectedAtMs: nowMs,
      lastEvaluatedAtMs: nowMs,
      lastEvaluatedAt: now,
      sourceRunId: inputs.run.id,
      opportunityRunId: runId,
      baselineId: inputs.baseline ? inputs.baseline.id : null,
      baselineMatchesRun,
      analysisVersion: inputs.run.analysisVersion || null,
      modelVersion: ENGINE_VERSION,
      configVersion: CONFIG_VERSION,
      potentialValue: o.estimatedValue && o.estimatedValue.level != null ? ["נמוך", "נמוך", "בינוני", "גבוה"][o.estimatedValue.level] : null,
      updatedAt: now
    };
    const prev = existingById.get(id);
    if (prev) {
      // Owner fields (status, notes) and the M6 decision link (decisionId)
      // are not part of this update.
      await db.collection("opportunities").doc(id).update({ ...engineFields, detectionCount: (prev.detectionCount || 1) + 1, resolvedAtMs: null });
      updated++;
    } else {
      await db.collection("opportunities").doc(id).set({
        ...engineFields,
        status: "new",
        // M6 owns this link: initialised only on creation, never reset by a
        // later M5 run (docs/M6_DECISION_ENGINE_DESIGN.md §M.3).
        decisionId: null,
        detectionCount: 1,
        firstDetectedAtMs: nowMs,
        firstDetectedAt: now,
        firstSourceRunId: inputs.run.id,
        resolvedAtMs: null,
        createdAt: now
      });
      created++;
    }
  }

  let resolved = 0;
  for (const prev of inputs.engineOpps) {
    if (detectedIds.has(prev.id) || prev.engineState === "resolved") continue;
    await db.collection("opportunities").doc(prev.id).update({ engineState: "resolved", resolvedAtMs: nowMs, lastEvaluatedAtMs: nowMs, opportunityRunId: runId, updatedAt: now });
    resolved++;
  }

  const byPriority = { high: 0, medium: 0, low: 0 };
  const byType = {};
  for (const o of result.opportunities) {
    byPriority[o.priority]++;
    byType[o.type] = (byType[o.type] || 0) + 1;
  }
  const summary = {
    opportunities: result.opportunities.length,
    created,
    updated,
    resolved,
    byPriority,
    byType,
    noAction: result.topicEvaluations.filter((e) => e.outcome === "NO_ACTION").length,
    waitForData: result.topicEvaluations.filter((e) => e.outcome === "WAIT_FOR_DATA").length,
    approvedTopics: approvedNow.length
  };
  await db.collection("opportunityRuns").doc(runId).set({
    businessId,
    status: "completed",
    startedAtMs: nowMs,
    completedAtMs: Date.now(),
    completedAt: now,
    inputHash,
    engineVersion: ENGINE_VERSION,
    configVersion: CONFIG_VERSION,
    weights,
    weightsOverride: applied,
    thresholds: THRESHOLDS,
    intelligenceRunId: inputs.run.id,
    baselineId: inputs.baseline ? inputs.baseline.id : null,
    baselineMatchesRun,
    context: result.context,
    topicEvaluations: result.topicEvaluations,
    opportunityIds: [...detectedIds],
    summary,
    outcome: result.opportunities.length ? "OPPORTUNITIES" : "NO_ACTION",
    providerCalled: false
  });
  return { cacheHit: false, decision: "computed", runId, providerCalled: false, summary, written: created + updated + resolved };
}

module.exports = { runOpportunityEngine, loadInputs, semanticInput, SOURCE };
