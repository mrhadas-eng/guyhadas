// GuyHadas Visibility OS - M6 Decision Engine - HTTP endpoint.
// Auth + parsing only; logic in decisionEngineStore.js / decisionRules.js.
// Explicit owner action only (POST from a button) - never on render,
// listener, page load, deploy or schedule. Reads and writes Firestore only:
// no provider is called, nothing can be spent.

const functions = require("firebase-functions");
const { setCors, requireAdmin } = require("./visibility");
const store = require("./decisionEngineStore");

exports.visibilityRunDecisionEngine = functions.runWith({ timeoutSeconds: 120, memory: "512MB" }).https.onRequest(async (req, res) => {
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
  const { businessId } = req.body || {};
  if (!businessId) {
    res.status(400).json({ success: false, error: "businessId is required" });
    return;
  }
  try {
    const r = await store.runDecisionEngine({ businessId });
    res.status(200).json({ success: true, ...r });
  } catch (err) {
    console.error("visibilityRunDecisionEngine error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
