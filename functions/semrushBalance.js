// GuyHadas Visibility OS - Semrush API unit balance (admin-only endpoint).
// Auth + response shaping only; logic in semrushBalanceStore.js.
//
// Bound to the SEMRUSH_API_KEY secret on THIS function only. It is
// intentionally independent of the V3 discovery adapter (functions/semrush.js)
// and of visibilityDiscoverFromSemrush / visibilityDiscoverDomainFromSemrush.
// It makes only Semrush's free balance request (0 API units) - never a report.
// Explicit owner action only: never on render, listener, page load or schedule.

const functions = require("firebase-functions");
const { setCors, requireAdmin } = require("./visibility");
const { checkSemrushBalance } = require("./semrushBalanceStore");

// Exported for tests (req/res fakes, injected auth + check).
async function handleBalanceRequest(req, res, { auth = requireAdmin, check = checkSemrushBalance, cors = setCors } = {}) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only", checkedAt: new Date().toISOString() });
    return;
  }
  const user = await auth(req, res);
  if (!user) return; // requireAdmin already answered 401/403
  try {
    const r = await check();
    // only the documented safe fields ever leave the function
    const body = r.ok ? { ok: true, currentBalance: r.currentBalance, checkedAt: r.checkedAt } : { ok: false, error: r.error, checkedAt: r.checkedAt };
    // additional, failure-only: rebuilt from the six safe fields, nothing else
    if (!r.ok && r.diagnostic) {
      const d = r.diagnostic;
      body.diagnostic = { httpStatus: d.httpStatus ?? null, contentType: d.contentType ?? null, redirected: !!d.redirected, finalPath: d.finalPath ?? null, responseFormat: d.responseFormat ?? "unknown", bodyLength: d.bodyLength ?? null };
    }
    res.status(r.ok ? 200 : 502).json(body);
  } catch (err) {
    console.error("visibilityGetSemrushBalance: unexpected failure");
    res.status(500).json({ ok: false, error: "The balance check failed unexpectedly.", checkedAt: new Date().toISOString() });
  }
}

exports.visibilityGetSemrushBalance = functions
  .runWith({ secrets: ["SEMRUSH_API_KEY"], timeoutSeconds: 30, memory: "256MB" })
  .https.onRequest((req, res) => handleBalanceRequest(req, res));

exports.handleBalanceRequest = handleBalanceRequest;
