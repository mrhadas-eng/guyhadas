// GuyHadas Visibility OS - generic external-API governor (Universal
// External API Cost-Control Rule - see claude/visibility-os-api-cost-control-rule.md).
// Every paid/quota-limited provider call goes through runGoverned(), so
// "we have an API key" never means "the system may call the API whenever
// it wants".
//
// Flow (order matters - the cache is checked before anything that could
// spend money):
//
//   normalize input -> cache identity (inputHash + model)
//   -> cache lookup
//        HIT  -> record a $0 cache_hit ledger row -> return stored result
//        MISS -> circuit breaker -> budget/quota -> provider call
//                -> record usage (+ the result, which becomes the cache)
//
// FAIL CLOSED (permanent rule): if any safety/cost control cannot be
// verified - the cache lookup, the circuit breaker or the budget/quota
// check throws (missing index, Firestore outage, bad config) - the
// provider is NOT called. The run stops with a `blocked_*_unavailable`
// reason. A failed check is never treated as "cache miss" or "within
// budget". Never spend money because a check failed.
//
// `apiUsage` docs are the ledger AND the cache: a prior success row for
// the same provider/operation/businessId/inputHash/model IS the cached
// result. Admin-read-only for clients, written only here via the Admin SDK.

const admin = require("firebase-admin");
const crypto = require("crypto");
const LIMITS = require("./apiLimits");

// How many candidate rows the cache lookup reads before filtering by model.
const CACHE_LOOKUP_CANDIDATES = 10;

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeysDeep(value[k]);
        return acc;
      }, {});
  }
  return value;
}

// Deterministic regardless of key order. UNCHANGED from the first version
// on purpose: results already in the ledger keep their hashes and stay
// reusable.
function hashInput(value) {
  const json = JSON.stringify(sortKeysDeep(value));
  return crypto.createHash("sha256").update(json).digest("hex");
}

function getLimits(provider, operation) {
  const limits = LIMITS[provider] && LIMITS[provider][operation];
  if (!limits) {
    throw new Error(`No apiLimits configured for ${provider}.${operation} - add an entry to functions/apiLimits.js before calling runGoverned for it`);
  }
  return limits;
}

// The model a ledger row was produced with. Rows written before the model
// was recorded have none; apiLimits.<op>.legacyModel names the only model
// that operation ever used before then (documented there), so those rows
// stay reusable for that model and are never reused for a different one.
function rowModel(row, limits) {
  // Only a MISSING field means "written before this was recorded"; an
  // explicit null means "no model" and must match only null.
  if (row.model !== undefined) return row.model;
  return limits.legacyModel !== undefined ? limits.legacyModel : null;
}

// Same idea for the analysis version (the version of the deterministic
// pipeline around the provider call: crawl/extraction/post-processing
// contract). Rows written before it was recorded count as
// apiLimits.<op>.legacyAnalysisVersion.
function rowAnalysisVersion(row, limits) {
  if (row.analysisVersion !== undefined) return row.analysisVersion;
  return limits.legacyAnalysisVersion !== undefined ? limits.legacyAnalysisVersion : null;
}

// Throws if the lookup itself cannot run (e.g. missing index) - the caller
// turns that into a fail-closed block. Returns the cached row or null.
async function findCachedUsage({ provider, operation, businessId, inputHash, model, analysisVersion, limits }) {
  const db = admin.firestore();
  const snap = await db
    .collection("apiUsage")
    .where("provider", "==", provider)
    .where("operation", "==", operation)
    .where("businessId", "==", businessId)
    .where("status", "==", "success")
    .where("inputHash", "==", inputHash)
    .orderBy("retrievedAtMs", "desc")
    .limit(CACHE_LOOKUP_CANDIDATES)
    .get();
  for (const doc of snap.docs) {
    const row = doc.data();
    if (rowModel(row, limits) !== (model ?? null)) continue;
    if (rowAnalysisVersion(row, limits) !== (analysisVersion ?? null)) continue;
    if (limits.cacheTtlMs != null && Date.now() - row.retrievedAtMs > limits.cacheTtlMs) continue;
    return { id: doc.id, ...row };
  }
  return null;
}

// Counts only attempts that actually reached the provider (success or
// error). Cache hits cost nothing, and blocked attempts never called the
// provider - counting either would make the quota wrong.
function reachedProvider(row) {
  if (row.providerCalled === true) return true;
  if (row.providerCalled === false) return false;
  return row.status === "success" || row.status === "error"; // rows written before providerCalled existed
}

async function sumUsage({ provider, operation, businessId, sinceMs, untilMs = null }) {
  const db = admin.firestore();
  let query = db
    .collection("apiUsage")
    .where("provider", "==", provider)
    .where("operation", "==", operation)
    .where("retrievedAtMs", ">=", sinceMs);
  // same field as the lower bound, so the existing composite index serves it
  if (untilMs != null) query = query.where("retrievedAtMs", "<", untilMs);
  if (businessId) query = query.where("businessId", "==", businessId);
  const snap = await query.get();
  const real = snap.docs.map((d) => d.data()).filter(reachedProvider);
  return {
    count: real.length,
    costUsd: real.reduce((sum, d) => sum + (d.actualCostUsd != null ? d.actualCostUsd : d.estimatedCostUsd || 0), 0)
  };
}

// --- daily quota window ------------------------------------------------------
// Default (every operation without `dailyWindow`): "PerDay" = rolling 24 h.
// An operation can declare `dailyWindow: { type: "calendar_day", timeZone }`
// in apiLimits.js: "PerDay" then means the CALENDAR DAY in that IANA time
// zone, [local 00:00:00, next local 00:00:00), computed with Intl - never
// from the server's own time zone. DST days are simply 23 or 25 hours long
// (Israel changes clocks at 02:00, so local midnight always exists).

function zonedParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) if (type !== "literal") p[type] = Number(value);
  return p;
}

// Offset of `timeZone` from UTC at instant ms (local wall clock - UTC).
function zoneOffsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// UTC instant of local 00:00:00 on (year, month, day) in timeZone.
function zonedMidnightMs(year, month, day, timeZone) {
  const wall = Date.UTC(year, month - 1, day);
  let t = wall - zoneOffsetMs(wall, timeZone);
  t = wall - zoneOffsetMs(t, timeZone); // second pass settles a DST change between the guess and the answer
  return t;
}

// [startMs, endMs) of the calendar day containing nowMs in timeZone.
function calendarDayWindow(nowMs, timeZone) {
  const p = zonedParts(nowMs, timeZone);
  const startMs = zonedMidnightMs(p.year, p.month, p.day, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const endMs = zonedMidnightMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
  if (!(startMs <= nowMs && nowMs < endMs)) throw new Error(`calendar-day window for ${timeZone} could not be determined`);
  return { startMs, endMs };
}

function dailyWindowFor(limits, nowMs) {
  const w = limits.dailyWindow;
  if (w && w.type === "calendar_day") {
    if (!w.timeZone) throw new Error("dailyWindow.calendar_day requires a timeZone");
    const { startMs, endMs } = calendarDayWindow(nowMs, w.timeZone);
    return { sinceMs: startMs, untilMs: endMs, label: `today (calendar day, ${w.timeZone})` };
  }
  return { sinceMs: nowMs - 24 * 60 * 60 * 1000, untilMs: null, label: "today" };
}

async function checkBudget({ provider, operation, businessId, estimatedCostUsd, limits, nowMs = Date.now() }) {
  const now = nowMs;
  // throws on a bad time zone -> caught by runGoverned -> fail closed
  const day = dailyWindowFor(limits, now);
  const monthStart = now - 30 * 24 * 60 * 60 * 1000; // rolling 30 days (unchanged)

  if (limits.maxEstimatedCostPerCallUsd != null && estimatedCostUsd != null && estimatedCostUsd > limits.maxEstimatedCostPerCallUsd) {
    return {
      allowed: false,
      reason: "blocked_by_budget",
      message: `Estimated cost $${estimatedCostUsd.toFixed(4)} exceeds the $${limits.maxEstimatedCostPerCallUsd} per-call limit for ${provider}.${operation}`
    };
  }

  const checks = [
    ["maxRequestsPerBusinessPerDay", () => sumUsage({ provider, operation, businessId, sinceMs: day.sinceMs, untilMs: day.untilMs }), day.label],
    ["maxRequestsPerBusinessPerMonth", () => sumUsage({ provider, operation, businessId, sinceMs: monthStart }), "this month"],
    ["maxRequestsGlobalPerDay", () => sumUsage({ provider, operation, sinceMs: day.sinceMs, untilMs: day.untilMs }), `${day.label} (all businesses)`],
    ["maxRequestsGlobalPerMonth", () => sumUsage({ provider, operation, sinceMs: monthStart }), "this month (all businesses)"]
  ].filter(([key]) => limits[key] != null);

  const resolved = await Promise.all(checks.map(([, run]) => run()));
  for (let i = 0; i < checks.length; i++) {
    const [key, , windowLabel] = checks[i];
    if (resolved[i].count >= limits[key]) {
      return {
        allowed: false,
        reason: "blocked_by_quota",
        message: `${provider}.${operation} already made ${resolved[i].count} calls ${windowLabel} (limit ${limits[key]})`
      };
    }
  }
  return { allowed: true };
}

async function getCircuitBreakerDoc(provider, operation) {
  const db = admin.firestore();
  const ref = db.collection("apiCircuitBreakers").doc(`${provider}_${operation}`);
  const snap = await ref.get();
  return { ref, data: snap.exists ? snap.data() : { consecutiveFailures: 0, openUntilMs: 0 } };
}

async function checkCircuitBreaker(provider, operation) {
  const { data } = await getCircuitBreakerDoc(provider, operation);
  if (data.openUntilMs && Date.now() < data.openUntilMs) {
    return {
      allowed: false,
      reason: "blocked_by_safety_limit",
      message: `${provider}.${operation} circuit breaker is open (${data.consecutiveFailures} consecutive failures) until ${new Date(data.openUntilMs).toISOString()}`
    };
  }
  return { allowed: true };
}

async function recordCircuitResult(provider, operation, success, limits) {
  const { ref, data } = await getCircuitBreakerDoc(provider, operation);
  if (success) {
    await ref.set({ consecutiveFailures: 0, openUntilMs: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return;
  }
  const consecutiveFailures = (data.consecutiveFailures || 0) + 1;
  const openUntilMs = consecutiveFailures >= limits.circuitBreakerThreshold ? Date.now() + limits.circuitBreakerCooldownMs : 0;
  await ref.set({ consecutiveFailures, openUntilMs, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function recordUsage(record) {
  const db = admin.firestore();
  await db.collection("apiUsage").add({
    jobId: null,
    requestId: null,
    result: null,
    recordsRequested: null,
    recordsReturned: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    estimatedCostUsd: null,
    actualCostUsd: null,
    currency: "USD",
    retryCount: 0,
    errorMessage: null,
    model: null,
    analysisVersion: null,
    decision: null,
    reason: null,
    forceRefresh: false,
    providerCalled: false,
    cacheHit: false,
    estimatedUnits: null,
    ...record,
    retrievedAt: admin.firestore.FieldValue.serverTimestamp(),
    retrievedAtMs: Date.now()
  });
}

// Ledger writes for non-provider outcomes (hit / blocked) must never turn a
// safe outcome into an error, so a failed write is logged, not thrown.
async function recordUsageSafely(record) {
  try {
    await recordUsage(record);
  } catch (err) {
    console.error(`apiUsage: could not record ${record.provider}.${record.operation} ${record.status}:`, err.message);
  }
}

// Safe, bounded provider error metadata for the ledger. Only typed scalar
// fields an adapter put on its error are read; strings are bounded and
// stripped of control characters and URL-with-query patterns.
function boundedText(v, max) {
  if (typeof v !== "string") return null;
  const t = v.replace(/https?:\/\/\S*\?\S*/gi, "[url redacted]").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  return t || null;
}
function providerErrorFields(err) {
  const e = err || {};
  return {
    providerHttpStatus: Number.isInteger(e.httpStatus) ? e.httpStatus : null,
    providerErrorCode: boundedText(e.errorCode, 40),
    providerRequestId: boundedText(e.requestId, 80),
    providerRetryable: typeof e.retryable === "boolean" ? e.retryable : null,
    providerContentType: boundedText(e.contentType, 80),
    providerResponseFormat: boundedText(e.responseFormat, 10),
    providerBodyLength: Number.isInteger(e.bodyLength) ? e.bodyLength : null
  };
}

// The one entry point every governed provider call goes through.
//
//   provider, operation: keys into functions/apiLimits.js
//   businessId: required - every provider call in this app is business-scoped
//   input: everything that determines the result - hashed for the cache
//   model: the provider model/variant that will produce the result (part of
//     the cache identity alongside the input hash; null if not applicable)
//   forceRefresh: skip the cache lookup. Only ever set from an explicit,
//     confirmed owner action - never a default. Never bypasses the circuit
//     breaker or budget/quota checks.
//   estimateCost: optional (input) => USD estimate checked before the call
//   estimateUnits: optional (input) => provider-unit estimate. REQUIRED when
//     apiLimits.<op>.maxEstimatedUnitsPerCall is set: a missing, invalid or
//     too-high estimate blocks the call (blocked_by_budget) - fail closed.
//   execute: async (input) => ({ result, usage }) - the provider call
//
// Always returns (only a provider execution error is rethrown, after it has
// been recorded):
//   { ok, cacheHit, result, usage, blocked, inputHash, model, decision, providerCalled }
// decision: "cache_hit" | "cache_miss" | "forced_refresh" |
//           "blocked_cache_unavailable" | "blocked_safety_check_unavailable" |
//           "blocked_by_budget" | "blocked_by_quota" | "blocked_by_safety_limit"
async function runGoverned({ provider, operation, businessId, input, model = null, analysisVersion = null, forceRefresh = false, reason = null, estimateCost, estimateUnits, execute, nowMs }) {
  if (!businessId) throw new Error("runGoverned requires a businessId - every provider call in this app is business-scoped");
  const limits = getLimits(provider, operation);
  const inputHash = hashInput(input);
  // `reason`: why this operation was requested (master architecture §35) -
  // recorded on every ledger row for audit.
  const base = { provider, operation, businessId, inputHash, model, analysisVersion, forceRefresh: !!forceRefresh, reason };
  const outcome = (fields) => ({ ok: false, cacheHit: false, result: null, usage: null, blocked: null, inputHash, model, analysisVersion, providerCalled: false, ...fields });

  // 1. Cache lookup - before anything that could spend money.
  if (!forceRefresh) {
    let cached;
    try {
      cached = await findCachedUsage({ provider, operation, businessId, inputHash, model, analysisVersion, limits });
    } catch (err) {
      const message = `Cache lookup could not be performed (${err.message}). The provider was NOT called.`;
      console.error(`apiUsage FAIL CLOSED ${provider}.${operation}:`, message);
      await recordUsageSafely({ ...base, status: "blocked_cache_unavailable", decision: "blocked_cache_unavailable", errorMessage: message });
      return outcome({ decision: "blocked_cache_unavailable", blocked: { reason: "blocked_cache_unavailable", message } });
    }
    if (cached) {
      await recordUsageSafely({
        ...base,
        status: "cache_hit",
        decision: "cache_hit",
        cacheHit: true,
        providerCalled: false,
        actualCostUsd: 0,
        providerUnitsUsed: 0,
        cachedFromUsageId: cached.id
      });
      return outcome({ ok: true, cacheHit: true, result: cached.result, decision: "cache_hit", cachedFromUsageId: cached.id });
    }
  }
  const missDecision = forceRefresh ? "forced_refresh" : "cache_miss";

  // 2. Circuit breaker and budget/quota - fail closed if they can't run.
  let estimatedCostUsd = null;
  let estimatedUnits = null;
  try {
    const circuit = await checkCircuitBreaker(provider, operation);
    if (!circuit.allowed) {
      await recordUsageSafely({ ...base, status: circuit.reason, decision: circuit.reason, errorMessage: circuit.message });
      return outcome({ decision: circuit.reason, blocked: { reason: circuit.reason, message: circuit.message } });
    }
    estimatedCostUsd = estimateCost ? estimateCost(input) : null;
    // Hard per-call unit cap (provider-unit priced operations, e.g. Semrush V4).
    if (limits.maxEstimatedUnitsPerCall != null) {
      estimatedUnits = estimateUnits ? estimateUnits(input) : null;
      if (typeof estimatedUnits !== "number" || !Number.isFinite(estimatedUnits) || estimatedUnits <= 0 || estimatedUnits > limits.maxEstimatedUnitsPerCall) {
        const message = `${provider}.${operation}: the unit estimate (${estimatedUnits}) could not be confirmed within the ${limits.maxEstimatedUnitsPerCall}-unit per-call cap. The provider was NOT called.`;
        await recordUsageSafely({ ...base, status: "blocked_by_budget", decision: "blocked_by_budget", errorMessage: message, estimatedUnits: typeof estimatedUnits === "number" && Number.isFinite(estimatedUnits) ? estimatedUnits : null });
        return outcome({ decision: "blocked_by_budget", blocked: { reason: "blocked_by_budget", message } });
      }
    }
    // nowMs: only for the quota windows (tests pin the clock); defaults to the real clock
    const budget = await checkBudget({ provider, operation, businessId, estimatedCostUsd, limits, nowMs: nowMs != null ? nowMs : Date.now() });
    if (!budget.allowed) {
      await recordUsageSafely({ ...base, status: budget.reason, decision: budget.reason, errorMessage: budget.message, estimatedCostUsd, estimatedUnits });
      return outcome({ decision: budget.reason, blocked: { reason: budget.reason, message: budget.message } });
    }
  } catch (err) {
    const message = `A cost/safety check could not be performed (${err.message}). The provider was NOT called.`;
    console.error(`apiUsage FAIL CLOSED ${provider}.${operation}:`, message);
    await recordUsageSafely({ ...base, status: "blocked_safety_check_unavailable", decision: "blocked_safety_check_unavailable", errorMessage: message });
    return outcome({ decision: "blocked_safety_check_unavailable", blocked: { reason: "blocked_safety_check_unavailable", message } });
  }

  // 3. Provider call - the only place money is spent.
  try {
    const { result, usage } = await execute(input);
    await recordUsage({
      ...base,
      status: "success",
      decision: missDecision,
      providerCalled: true,
      result: result != null ? result : null,
      requestId: (usage && usage.requestId) || null,
      recordsRequested: usage && usage.recordsRequested != null ? usage.recordsRequested : null,
      recordsReturned: usage && usage.recordsReturned != null ? usage.recordsReturned : null,
      inputTokens: usage && usage.inputTokens != null ? usage.inputTokens : null,
      outputTokens: usage && usage.outputTokens != null ? usage.outputTokens : null,
      cachedTokens: usage && usage.cachedTokens != null ? usage.cachedTokens : null,
      estimatedCostUsd,
      estimatedUnits,
      actualCostUsd: usage && usage.actualCostUsd != null ? usage.actualCostUsd : null,
      providerUnitsUsed: usage && usage.providerUnitsUsed != null ? usage.providerUnitsUsed : null
    });
    await recordCircuitResult(provider, operation, true, limits).catch((e) => console.error("apiUsage circuit update failed:", e.message));
    return { ok: true, cacheHit: false, result, usage: usage || null, blocked: null, inputHash, model, analysisVersion, providerCalled: true, decision: missDecision };
  } catch (err) {
    err.providerCalled = true;
    err.inputHash = inputHash;
    err.decision = missDecision;
    // A failed call may still have been billed (e.g. a reply cut off at the
    // output limit) - record its real usage/cost when the provider reported it.
    const u = err.usage || {};
    await recordUsageSafely({
      ...base,
      status: "error",
      decision: missDecision,
      providerCalled: true,
      errorMessage: err.message,
      estimatedCostUsd,
      estimatedUnits,
      // unknown unless the provider reported it (a failed call may be billed)
      providerUnitsUsed: u.providerUnitsUsed != null ? u.providerUnitsUsed : null,
      // safe provider error metadata (adapters set these; never bodies or headers)
      ...providerErrorFields(err),
      requestId: u.requestId || null,
      inputTokens: u.inputTokens != null ? u.inputTokens : null,
      outputTokens: u.outputTokens != null ? u.outputTokens : null,
      actualCostUsd: u.actualCostUsd != null ? u.actualCostUsd : null
    });
    await recordCircuitResult(provider, operation, false, limits).catch((e) => console.error("apiUsage circuit update failed:", e.message));
    throw err;
  }
}

module.exports = { hashInput, runGoverned, calendarDayWindow, dailyWindowFor };
