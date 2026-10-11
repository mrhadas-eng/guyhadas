// GuyHadas Visibility OS - M7 Prediction, Change & Experiment Tracking -
// HTTP endpoints. Auth + parsing only; logic in trackingStore.js /
// trackingRules.js / predictionRules.js. Explicit owner action only (POST
// from a button or the record form) - never on render, listener, page load,
// deploy or schedule. Firestore only: no provider is called, nothing can be
// spent.

const functions = require("firebase-functions");
const { setCors, requireAdmin } = require("./visibility");
const store = require("./trackingStore");

function handler(fn) {
  return functions.runWith({ timeoutSeconds: 120, memory: "512MB" }).https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ success: false, error: "POST only" });
      return;
    }
    const user = await requireAdmin(req, res);
    if (!user) return;
    const body = req.body || {};
    if (!body.businessId) {
      res.status(400).json({ success: false, error: "businessId is required" });
      return;
    }
    try {
      const r = await fn(body, user);
      res.status(200).json({ success: true, ...r });
    } catch (err) {
      const status = err instanceof store.TrackingError ? err.status : 500;
      if (status === 500) console.error("M7 tracking endpoint error:", err.message);
      res.status(status).json({ success: false, error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
    }
  });
}

// Tracking run: provisional predictions for accepted actionable decisions,
// crawl verification of recorded changes, experiment windows and holds.
exports.visibilityRunTracking = handler((body) => store.runTracking({ businessId: body.businessId }));

// Record (or revert) an implementation the owner made outside the system.
exports.visibilityRecordImplementation = handler((body, user) => store.recordImplementation({ businessId: body.businessId, body, uid: user.uid || user.email || null }));
