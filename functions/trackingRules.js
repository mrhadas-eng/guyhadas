// GuyHadas Visibility OS - M7 tracking rules (docs/M7_DESIGN.md §5, §6, §7,
// §8, §9.1): dates, observation windows, M7 time states, experiment
// grouping, window extension / saturation, churn-hold state, crawl
// verification, before-snapshot selection and request validation.
//
// PURE and deterministic: no Firestore, no network, no clock - `nowMs` is
// always passed in. Input order never changes the output.
//
// M7 sets ONLY time-based and structural states. Every state that claims
// something about performance (NO_SIGNAL_YET ... FAILED) belongs to M8 and
// needs measurement evidence; `assertNoSignalState` guards every M7 writer.

const cfg = require("./predictionConfig");
const P = require("./predictionRules");

const DAY = P.DAY_MS;
const M7_STATES = Object.freeze(["PENDING_PUBLICATION", "TOO_EARLY", "PENDING_MEASUREMENT", "CHANGE_IN_OBSERVATION_WINDOW", "INCONCLUSIVE"]);
const SIGNAL_STATES = Object.freeze(["NO_SIGNAL_YET", "EARLY_SIGNAL", "SEO_SIGNAL", "MEANINGFUL_IMPACT", "UNDERPERFORMING", "FAILED"]);
const LIVE_STATUSES = Object.freeze(["recorded", "verified", "not_observed", "not_verifiable"]);
const MATCH = Object.freeze(["full", "partial", "different"]);
const ACTOR_TYPES = Object.freeze(["owner", "contractor", "agency", "system"]);

// --- dates (owner-reported calendar dates in the business time zone) -------

function parseYmd(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms).toISOString().slice(0, 10);
  return back === s ? { y, m, d, utcMidnightMs: ms } : null;
}

// Offset of `tz` from UTC at instant `ms`, in ms (Intl only - deterministic).
function tzOffsetMs(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const v = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  return Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second) - Math.floor(ms / 1000) * 1000;
}

// Start of the calendar day `ymd` in `tz`, as epoch ms (P3: the strictest
// reading of a calendar date - its very first instant).
function startOfDayMs(ymd, tz = cfg.DEFAULT_TIME_ZONE) {
  const p = parseYmd(ymd);
  if (!p) return null;
  let guess = p.utcMidnightMs;
  for (let i = 0; i < 3; i++) guess = p.utcMidnightMs - tzOffsetMs(guess, tz);
  return guess;
}

function ymdInTz(ms, tz = cfg.DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const v = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

// --- request validation (§6.2) -----------------------------------------------

function validateRecordRequest(body, { nowMs, timeZone = cfg.DEFAULT_TIME_ZONE }) {
  const errors = [];
  const b = body || {};
  const today = ymdInTz(nowMs, timeZone);
  if (!b.decisionId || typeof b.decisionId !== "string") errors.push("decisionId is required");
  const impl = parseYmd(b.implementedDate);
  if (!impl) errors.push("implementedDate must be a valid YYYY-MM-DD date");
  else if (b.implementedDate > today) errors.push("implementedDate is in the future - record an implementation only after it happened");
  let published = null;
  if (b.publishedDate != null && b.publishedDate !== "") {
    if (!parseYmd(b.publishedDate)) errors.push("publishedDate must be a valid YYYY-MM-DD date");
    else if (impl && b.publishedDate < b.implementedDate) errors.push("publishedDate cannot be earlier than implementedDate");
    else published = b.publishedDate;
  }
  const elements = [...new Set(Array.isArray(b.changedElements) ? b.changedElements : [])];
  if (!elements.length) errors.push("changedElements needs at least one element");
  const bad = elements.filter((e) => !cfg.CHANGE_ELEMENTS.includes(e));
  if (bad.length) errors.push(`unknown changedElements: ${bad.join(", ")}`);
  if (!MATCH.includes(b.implementationMatch)) errors.push("implementationMatch must be full | partial | different");
  const deviationNote = typeof b.deviationNote === "string" ? b.deviationNote.trim().slice(0, 2000) : "";
  if (b.implementationMatch && b.implementationMatch !== "full" && !deviationNote) errors.push("deviationNote is required unless implementationMatch is full");
  const actor = b.responsibleActor || {};
  if (!ACTOR_TYPES.includes(actor.type)) errors.push("responsibleActor.type must be owner | contractor | agency | system");
  const notes = typeof b.implementationNotes === "string" ? b.implementationNotes : "";
  if (notes.length > 2000) errors.push("implementationNotes is limited to 2,000 characters");
  if (b.ownerAttestation !== true) errors.push("ownerAttestation must be true - confirm that the change was actually made");
  if (b.targetUrl != null && typeof b.targetUrl !== "string") errors.push("targetUrl must be a string");
  return {
    ok: errors.length === 0,
    errors,
    value: errors.length
      ? null
      : {
          decisionId: b.decisionId,
          implementedDate: b.implementedDate,
          publishedDate: published,
          targetUrl: b.targetUrl || null,
          changedElements: elements.sort(),
          intentChange: b.intentChange === true,
          implementationMatch: b.implementationMatch,
          deviationNote: deviationNote || null,
          responsibleActor: { type: actor.type, name: typeof actor.name === "string" ? actor.name.trim().slice(0, 120) || null : null },
          implementationNotes: notes,
          ownerAttestation: true
        }
  };
}

function changeEventIdOf(businessId, decisionId, targetPageKey, implementedDate) {
  return `${businessId}_chg_${P.sha16(`${decisionId}|${targetPageKey}|${implementedDate}`)}`;
}

// P1: only an owner-accepted actionable decision can be implemented. A
// decision M6 already holds as MONITOR because it IS under observation keeps
// its held actionable value (a later, genuinely different implementation of
// the same decision is allowed).
function recordableDecision(d) {
  if (!d) return { ok: false, reason: "decision not found" };
  if (d.engineState === "superseded") return { ok: false, reason: "the decision is superseded - run the decision engine and use the current decision" };
  if (d.ownerStatus !== "accepted") return { ok: false, reason: "only an owner-accepted decision can be recorded as implemented (accept it first; acceptance itself is not implementation)" };
  const held = d.churnHold && (d.reasonCodes || []).includes("IMPLEMENTED_UNDER_OBSERVATION") ? d.churnHold.heldDecision : null;
  const effective = held || d.decision;
  if (!cfg.ACTIONABLE_DECISIONS.includes(effective)) return { ok: false, reason: `${d.decision} decisions cannot be implemented - only IMPROVE, CREATE or CONSOLIDATE` };
  const actionDetails = held ? d.churnHold.heldActionDetails || [d.churnHold.heldActionDetail].filter(Boolean) : d.actionDetails && d.actionDetails.length ? d.actionDetails : [d.actionDetail].filter(Boolean);
  return { ok: true, effectiveDecision: effective, actionDetails, recommendedPage: held ? d.churnHold.heldRecommendedPage || d.recommendedPage : d.recommendedPage };
}

// --- windows (§5) -------------------------------------------------------------

const clampWindowDays = (n) => Math.max(cfg.WINDOW.minDays, Math.min(cfg.WINDOW.maxDays, n));

// Stage ranges used for windows: the prediction's, or - when the
// prediction is blocked by eligibility - the class prior (flagged).
function windowRanges(pred) {
  if (pred && pred.predictionState === "ranges") return { A: P.stageRange(pred, "A"), B: P.stageRange(pred, "B"), C: P.stageRange(pred, "C"), fromPrior: false };
  const prior = cfg.PRIORS[(pred && pred.changeType) || "content"] || cfg.PRIORS.content;
  return { A: prior.A, B: prior.B, C: prior.C, fromPrior: true };
}

function observationDays(r) {
  const anchor = r.B ? r.B[1] : r.A[1];
  return clampWindowDays(Math.ceil(anchor * cfg.WINDOW.tailFactor));
}

function holdDays(pred) {
  const r = windowRanges(pred);
  const mat = (pred && pred.materiality) || P.materialityOf((pred && pred.changeClasses) || []);
  return mat === "major" && r.B ? r.B[1] : r.A[1];
}

// --- crawl verification (§6.4) -------------------------------------------------

const stateOf = (x) => (x && typeof x === "object" ? x.state : x) || "unknown";
const arr = (x) => (Array.isArray(x) ? x : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// before: a baseline page entry (or null); current: the seoPages doc (or
// null); affected: current seoPages docs of the pages a consolidation merged.
function verifyChange({ changedElements, changeClasses = [], before, current, affected = [] }) {
  const checks = [];
  const add = (element, result, b = null, a = null, note = null) => checks.push({ element, result, before: b, after: a, ...(note ? { note } : {}) });
  const fetched = current && current.crawlStatus === "fetched";
  const consolidation = changeClasses.includes("consolidation");
  for (const el of [...changedElements].sort()) {
    if (["meta_description", "body_content", "business_facts", "content_merged", "other"].includes(el)) {
      add(el, "not_verifiable", null, null, "owner-reported only - not compared by the crawl in v1");
      continue;
    }
    if (el === "new_page_published") {
      if (!current) add(el, "not_observed", null, null, "the new page was not found in the crawl yet");
      else if (!fetched) add(el, "not_observed", null, current.crawlStatus);
      else add(el, stateOf(current.indexability) === "non_indexable" ? "contradicted" : "confirmed", null, stateOf(current.indexability));
      continue;
    }
    if (el === "redirect") {
      const pages = consolidation && affected.length ? affected : current ? [current] : [];
      const redirected = pages.filter((p) => p.finalUrl && p.url && p.finalUrl !== p.url);
      add(el, pages.length === 0 ? "not_verifiable" : redirected.length ? "confirmed" : "not_observed", null, redirected.map((p) => p.pageKey));
      continue;
    }
    if (!fetched) {
      add(el, "not_observed", null, current ? current.crawlStatus : null, "target page not fetched in the latest crawl");
      continue;
    }
    switch (el) {
      case "title":
        if (!before) add(el, "not_verifiable", null, current.title || null, "no before-snapshot");
        else add(el, (before.title || null) !== (current.title || null) ? "confirmed" : "not_observed", before.title || null, current.title || null);
        break;
      case "h1":
      case "headings": {
        if (!before) {
          add(el, "not_verifiable", null, null, "no before-snapshot");
          break;
        }
        const h1Changed = !same(arr(before.h1).slice(0, 3), arr(current.h1).slice(0, 3));
        const h2Known = el === "headings" && Array.isArray(before.h2);
        const h2Changed = h2Known && !same(arr(before.h2).slice(0, 10), arr(current.h2).slice(0, 10));
        if (h1Changed || h2Changed) add(el, "confirmed", arr(before.h1).slice(0, 3), arr(current.h1).slice(0, 3));
        else if (el === "headings" && !h2Known) add(el, "not_verifiable", null, null, "H2 not stored in this before-snapshot");
        else add(el, "not_observed", arr(before.h1).slice(0, 3), arr(current.h1).slice(0, 3));
        break;
      }
      case "canonical_tag": {
        if (consolidation) {
          const pointing = affected.filter((p) => stateOf(p.canonical) === "points_elsewhere");
          add(el, affected.length === 0 ? "not_verifiable" : pointing.length ? "confirmed" : "not_observed", null, pointing.map((p) => p.pageKey));
        } else {
          const now = stateOf(current.canonical);
          const was = before ? before.canonical || "unknown" : "unknown";
          add(el, now === "valid" ? (was === "valid" ? "not_observed" : "confirmed") : "contradicted", was, now);
        }
        break;
      }
      case "noindex_removed": {
        const now = stateOf(current.indexability);
        add(el, now === "indexable" ? "confirmed" : now === "non_indexable" ? "contradicted" : "not_observed", before ? before.indexability : null, now);
        break;
      }
      case "robots_rule": {
        const now = stateOf(current.robots);
        add(el, now === "crawlable" ? "confirmed" : now === "blocked" ? "contradicted" : "not_observed", before ? before.robots : null, now);
        break;
      }
      case "internal_links_added": {
        const now = current.links ? current.links.inboundInternalCount : null;
        const was = before ? before.inboundInternalCount : null;
        if (now == null || was == null) add(el, "not_verifiable", was, now);
        else add(el, now > was ? "confirmed" : "not_observed", was, now);
        break;
      }
      case "structured_data": {
        const now = stateOf(current.structuredData);
        const nowTypes = (current.structuredData && current.structuredData.types) || [];
        if (!before) add(el, now === "present" ? "confirmed" : "not_observed", null, now);
        else {
          const typesKnown = Array.isArray(before.structuredDataTypes);
          const changed = (before.structuredData || "unknown") !== now || (typesKnown && !same([...before.structuredDataTypes].sort(), [...nowTypes].sort()));
          add(el, changed ? "confirmed" : "not_observed", before.structuredData || null, now);
        }
        break;
      }
      default:
        add(el, "not_verifiable");
    }
  }
  const results = checks.map((c) => c.result);
  const status = results.includes("contradicted") ? "contradicted" : results.includes("not_observed") ? "not_observed" : results.includes("confirmed") ? "verified" : "not_verifiable";
  return { status, checks, note: "verification checks that the website change is present - it says nothing about SEO results" };
}

// --- before-snapshot selection (§7, P3) ---------------------------------------

function baselineContains(b, target) {
  if (!b) return false;
  if (target.scope === "site") return true;
  const ref = b.referenceKeys || {};
  if (target.pageKey && (ref.pageKeys || []).includes(target.pageKey)) return true;
  if (target.kind === "new_page") return (target.topicIds || []).some((t) => (ref.topicIds || []).includes(t));
  return false;
}

// cutoffMs = start of the implementation date in the business time zone.
// Returns linked | capture | missing | contaminated. "capture" means the
// latest completed intelligence run finished before the cutoff and no later
// run overwrote the stored state, so a NEW immutable baseline may be built
// from that stored state (never from a crawl).
function selectBeforeSnapshot({ baselines = [], intelligenceRuns = [], target, cutoffMs }) {
  const runsById = new Map(intelligenceRuns.map((r) => [r.id, r]));
  const completedRuns = intelligenceRuns.filter((r) => r.status === "completed" && r.completedAtMs != null);
  const qualifying = baselines
    .filter((b) => b.capturedAtMs != null && b.capturedAtMs < cutoffMs)
    .filter((b) => {
      const run = runsById.get(b.sourceRunId);
      return !!run && run.completedAtMs != null && run.completedAtMs < cutoffMs;
    })
    .filter((b) => baselineContains(b, target))
    .sort((a, b) => b.capturedAtMs - a.capturedAtMs || (b.version || 0) - (a.version || 0));
  if (qualifying.length) return { status: "linked", baseline: qualifying[0], reason: "immutable baseline captured from an analysis completed before the implementation date" };
  const latestRun = [...completedRuns].sort((a, b) => b.completedAtMs - a.completedAtMs || String(b.id).localeCompare(String(a.id)))[0] || null;
  if (latestRun && latestRun.completedAtMs < cutoffMs) return { status: "capture", run: latestRun, reason: "no stored baseline contains the target; the stored analysis state is pre-change, so a new immutable baseline is built from it" };
  const anyPreChange = completedRuns.some((r) => r.completedAtMs < cutoffMs);
  if (latestRun) return { status: "contaminated", reason: anyPreChange ? "the only pre-change evidence does not contain the target, and the stored state is from an analysis completed after the implementation date" : "only post-change analyses exist" };
  return { status: "missing", reason: "no completed analysis exists" };
}

// --- churn-hold state (§9.1) -----------------------------------------------------

// Hold status of one experiment at `nowMs` (shared by M7 and M6).
function holdStatusAt(exp, nowMs) {
  const hold = (exp && exp.hold) || {};
  if (!exp || exp.status !== "open") return { active: false, reason: "closed" };
  if (!(exp.liveChangeEventIds || []).length) return { active: false, reason: "change_not_in_effect" };
  if (exp.ownerHoldRelease && exp.ownerHoldRelease.released === true) return { active: false, reason: "owner_release" };
  if (hold.holdUntilMs == null || nowMs >= hold.holdUntilMs) return { active: false, reason: "expired" };
  return { active: true, reason: "active" };
}

// --- experiments (§8) -------------------------------------------------------------

const isLive = (e) => LIVE_STATUSES.includes(e.implementationStatus);

// events: change events (engine view) with {changeEventId, unitKey, scope,
// decisionId, intentId, opportunityIds, affectedPageKeys, startMs,
// implementationStatus, predictionId, baselineSnapshot, crawlsSinceStart};
// predictions: Map/obj predictionId -> committed prediction.
// existing: Map experimentId -> stored experiment (owner fields only read).
function buildExperiments({ businessId, events, predictions, existing = new Map(), nowMs }) {
  const predOf = (id) => (predictions instanceof Map ? predictions.get(id) : predictions[id]) || null;
  const units = new Map();
  for (const e of [...events].sort((a, b) => a.startMs - b.startMs || String(a.changeEventId).localeCompare(String(b.changeEventId)))) {
    if (!units.has(e.unitKey)) units.set(e.unitKey, []);
    units.get(e.unitKey).push(e);
  }
  const experiments = [];
  const eventExperiment = {};
  const eventLate = {};
  const newExp = (unitKey, first, previous) => ({
    experimentId: `${businessId}_exp_${P.sha16(`${unitKey}|${first.changeEventId}`)}`,
    unitKey,
    scope: first.scope === "site" ? "site" : "page",
    first,
    members: [],
    grouped: [],
    late: [],
    extensionHistory: [],
    previousExperimentId: previous ? previous.experimentId : null,
    nextExperimentId: null,
    closedReason: null,
    endMs: null
  });
  for (const [unitKey, list] of [...units.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let cur = null;
    for (const e of list) {
      const pred = predOf(e.predictionId);
      const r = windowRanges(pred);
      const ownEnd = e.startMs + observationDays(r) * DAY;
      if (!cur || cur.closedReason || e.startMs > cur.endMs) {
        const prev = cur;
        cur = newExp(unitKey, e, prev);
        if (prev) prev.nextExperimentId = cur.experimentId;
        cur.members.push(e);
        cur.grouped.push(e);
        cur.endMs = ownEnd;
        experiments.push(cur);
      } else if (e.startMs - cur.first.startMs <= cfg.GROUPING_WINDOW_DAYS * DAY) {
        cur.members.push(e);
        cur.grouped.push(e);
        // window recomputed from the experiment start with the grouped
        // (experiment-level) ranges: the widest member range
        cur.endMs = Math.max(cur.endMs, cur.first.startMs + observationDays(r) * DAY);
      } else {
        const candidate = Math.max(cur.endMs, ownEnd);
        if (candidate - cur.first.startMs > cfg.WINDOW.maxExperimentSpanDays * DAY) {
          // saturated: close it, the late change opens a linked experiment
          cur.closedReason = "window_saturated";
          const prev = cur;
          cur = newExp(unitKey, e, prev);
          prev.nextExperimentId = cur.experimentId;
          cur.members.push(e);
          cur.grouped.push(e);
          cur.endMs = ownEnd;
          experiments.push(cur);
        } else {
          cur.members.push(e);
          cur.late.push(e);
          if (candidate > cur.endMs) cur.extensionHistory.push({ changeEventId: e.changeEventId, fromMs: cur.endMs, toMs: candidate });
          cur.endMs = candidate;
        }
      }
      eventExperiment[e.changeEventId] = cur.experimentId;
      eventLate[e.changeEventId] = cur.late.includes(e);
    }
  }

  const docs = experiments.map((x) => {
    const live = x.members.filter(isLive);
    const memberPreds = x.members.map((e) => predOf(e.predictionId)).filter(Boolean);
    const livePreds = live.map((e) => predOf(e.predictionId)).filter(Boolean);
    const expPred = P.deriveExperimentPrediction(x.grouped.map((e) => predOf(e.predictionId)).filter(Boolean), { businessId, experimentId: x.experimentId });
    const r = windowRanges(expPred);
    const startMs = x.first.startMs;
    const holdUntilMs = live.length ? Math.max(...live.map((e) => e.startMs + holdDays(predOf(e.predictionId)) * DAY)) : null;
    const classes = [...new Set(livePreds.flatMap((p) => p.changeClasses || []))].sort();
    const materiality = P.materialityOf(classes);
    const closed = !!x.closedReason || live.length === 0;
    const closedReason = x.closedReason || (live.length === 0 ? (x.members.some((e) => e.implementationStatus === "contradicted") ? "verification_contradicted" : "reverted") : null);
    const prior = existing.get(x.experimentId) || {};
    const release = prior.ownerHoldRelease && prior.ownerHoldRelease.released === true ? prior.ownerHoldRelease : null;
    const beforeEligibility = {};
    for (const e of x.members) for (const [k, v] of Object.entries(e.beforeEligibility || {})) beforeEligibility[k] = v;
    const doc = {
      experimentId: x.experimentId,
      businessId,
      unit: { scope: x.scope, pageKey: x.scope === "site" ? "site" : x.unitKey },
      affectedPageKeys: [...new Set(x.members.flatMap((e) => e.affectedPageKeys || []))].sort(),
      intentIds: [...new Set(x.members.map((e) => e.intentId).filter(Boolean))].sort(),
      decisionIds: [...new Set(x.members.map((e) => e.decisionId))].sort(),
      opportunityIds: [...new Set(x.members.flatMap((e) => e.opportunityIds || []))].sort(),
      signalKeys: [...new Set(x.members.map((e) => e.signalKey).filter(Boolean))].sort(),
      changeEventIds: x.members.map((e) => e.changeEventId),
      groupedChangeEventIds: x.grouped.map((e) => e.changeEventId),
      lateChangeEventIds: x.late.map((e) => e.changeEventId),
      liveChangeEventIds: live.map((e) => e.changeEventId),
      baselineSnapshot: x.first.baselineSnapshot || { status: "missing" },
      predictionId: expPred ? expPred.predictionId : null,
      memberPredictionIds: memberPreds.map((p) => p.predictionId).sort(),
      windowFromPrior: r.fromPrior,
      startMs,
      startDate: x.first.startDate || null,
      stageWindows: {
        A: r.A ? { fromMs: startMs + r.A[0] * DAY, toMs: startMs + r.A[1] * DAY } : null,
        B: r.B ? { fromMs: startMs + r.B[0] * DAY, toMs: startMs + r.B[1] * DAY } : null,
        C: r.C ? { fromMs: startMs + r.C[0] * DAY, toMs: startMs + r.C[1] * DAY } : null
      },
      observationWindowEndMs: x.endMs,
      businessWindowEndMs: r.C ? Math.max(x.endMs, startMs + r.C[1] * DAY) : null,
      extensions: x.extensionHistory.length,
      extensionHistory: x.extensionHistory,
      hold: { holdUntilMs, materiality, classes, beforeEligibility, releasedBy: release ? { reason: "owner_release", atMs: release.atMs || null, note: release.note || null } : null },
      interferences: x.late.map((e) => ({ type: "late_change", changeEventId: e.changeEventId, atMs: e.startMs })),
      relatedExperimentIds: [],
      previousExperimentId: x.previousExperimentId,
      nextExperimentId: x.nextExperimentId,
      status: closed ? "closed" : "open",
      closedReason,
      // reserved for M8 - M7 never writes a value here
      outcome: null,
      attributionConfidence: null,
      signalState: null,
      modelVersion: cfg.TRACKING_ENGINE_VERSION,
      configVersion: cfg.PREDICTION_CONFIG_VERSION,
      _expPred: expPred,
      _rangesA: r.A,
      _crawls: Math.max(0, ...x.members.filter((e) => ["recorded", "not_observed"].includes(e.implementationStatus)).map((e) => e.crawlsSinceStart || 0))
    };
    return doc;
  });

  // site-wide changes: interference notes on page experiments open at their
  // publication (state unchanged - attribution note only, §8.2)
  for (const s of docs.filter((d) => d.unit.scope === "site" && d.liveChangeEventIds.length)) {
    for (const d of docs) {
      if (d.unit.scope === "site" || d.status !== "open") continue;
      if (d.startMs <= s.startMs && s.startMs <= d.observationWindowEndMs) d.interferences.push({ type: "site_wide_change", experimentId: s.experimentId, atMs: s.startMs });
    }
  }
  // different page, same intent -> related (for M8 attribution)
  for (const a of docs) {
    for (const b of docs) {
      if (a === b || a.unit.pageKey === b.unit.pageKey) continue;
      if (a.intentIds.some((i) => b.intentIds.includes(i))) a.relatedExperimentIds.push({ experimentId: b.experimentId, relation: "same_intent" });
    }
    if (a.previousExperimentId) a.relatedExperimentIds.push({ experimentId: a.previousExperimentId, relation: a.closedReason === "window_saturated" ? "continued_from" : "previous" });
    a.relatedExperimentIds.sort((x, y) => x.experimentId.localeCompare(y.experimentId) || x.relation.localeCompare(y.relation));
    a.interferences.sort((x, y) => x.atMs - y.atMs || String(x.changeEventId || x.experimentId).localeCompare(String(y.changeEventId || y.experimentId)));
  }
  for (const d of docs) Object.assign(d, timeStateOf(d, nowMs));
  return { experiments: docs, eventExperiment, eventLate };
}

// M7 time phase / state / warnings at nowMs (§5.5). Pure; the UI uses the
// same function to display the current phase without a write.
function timeStateOf(d, nowMs) {
  const warnings = [];
  let phase;
  if (d.startMs > nowMs) phase = "PENDING_PUBLICATION";
  else if (d._rangesA ? nowMs < d.startMs + d._rangesA[0] * DAY : d.stageWindows && d.stageWindows.A ? nowMs < d.stageWindows.A.fromMs : false) phase = "TOO_EARLY";
  else phase = "PENDING_MEASUREMENT";
  let state = phase;
  if (d.status === "closed") state = "INCONCLUSIVE";
  else if ((d.lateChangeEventIds || []).length) state = "CHANGE_IN_OBSERVATION_WINDOW";
  if (d.status === "open" && d.startMs <= nowMs) {
    const span = d.observationWindowEndMs - d.startMs;
    if (nowMs >= d.observationWindowEndMs) warnings.push("window_ended_awaiting_measurement");
    else if (span > 0 && (nowMs - d.startMs) / span >= cfg.WINDOW.approachingEndShare) warnings.push("approaching_window_end");
  }
  if (d.baselineSnapshot && d.baselineSnapshot.status !== "linked") warnings.push("missing_baseline");
  if ((d._crawls || 0) >= 2) warnings.push("unverified_implementation");
  if (d.windowFromPrior) warnings.push("prediction_blocked_by_eligibility");
  const h = holdStatusAt(d, nowMs);
  assertNoSignalState(state);
  return { timePhase: phase, timeState: state, warnings, holdActive: h.active, holdReason: h.reason };
}

function assertNoSignalState(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  for (const sig of SIGNAL_STATES) if (new RegExp(`"?${sig}"?`).test(s)) throw new Error(`M7 must not set the M8 signal state ${sig}`);
  return true;
}

module.exports = {
  parseYmd,
  startOfDayMs,
  ymdInTz,
  tzOffsetMs,
  validateRecordRequest,
  changeEventIdOf,
  recordableDecision,
  windowRanges,
  observationDays,
  holdDays,
  verifyChange,
  selectBeforeSnapshot,
  baselineContains,
  holdStatusAt,
  buildExperiments,
  timeStateOf,
  assertNoSignalState,
  M7_STATES,
  SIGNAL_STATES,
  LIVE_STATUSES,
  DAY
};
