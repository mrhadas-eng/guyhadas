// Account-level Semrush status from evidence (balance snapshots + the
// current session's check), never from the key's presence or a business.
// Run: node --experimental-strip-types app/test/semrushStatus.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { deriveSemrushStatus, SEMRUSH_STATUS_LABELS } from "../src/lib/semrushStatus.ts";

// no snapshot, no check -> not checked
assert.deepStrictEqual(deriveSemrushStatus(null, null), { status: "not_checked", checkedAt: null, basis: "none" });
assert.strictEqual(SEMRUSH_STATUS_LABELS.not_checked, "לא נבדק");

// successful balance snapshot -> connected
const snap = { checkedAt: "2026-10-13T05:40:00.000Z" };
assert.deepStrictEqual(deriveSemrushStatus(snap, null), { status: "connected", checkedAt: snap.checkedAt, basis: "balance_snapshot" });
assert.strictEqual(SEMRUSH_STATUS_LABELS.connected, "מחובר");

// failed check in this session -> error (failures are not persisted, so the
// session result is the only failure evidence) - and it is the most recent
// evidence, so it wins over an older successful snapshot
const failed = { ok: false as const, error: "Semrush rejected the balance request", checkedAt: "2026-10-13T06:00:00.000Z" };
assert.deepStrictEqual(deriveSemrushStatus(null, failed), { status: "error", checkedAt: failed.checkedAt, basis: "session_check" });
assert.strictEqual(deriveSemrushStatus(snap, failed).status, "error");
assert.strictEqual(SEMRUSH_STATUS_LABELS.error, "שגיאה");

// successful check in this session -> connected
assert.strictEqual(deriveSemrushStatus(null, { ok: true, currentBalance: 10, checkedAt: "t" }).status, "connected");

// account-level: the derivation takes no business id, and the snapshot
// listener is not filtered by business
assert.strictEqual(deriveSemrushStatus.length, 2);
const fs = readFileSync(new URL("../src/lib/firestore.ts", import.meta.url), "utf8");
const listener = fs.slice(fs.indexOf("export function listenLatestSemrushBalanceSnapshot"));
assert.ok(!/businessId/.test(listener.slice(0, listener.indexOf("\n}\n"))), "snapshot listener is account-level");
const page = readFileSync(new URL("../src/pages/business/BusinessIntegrations.tsx", import.meta.url), "utf8");
assert.ok(/useEffect\(\(\) => listenLatestSemrushBalanceSnapshot\(setSemrushSnapshot\), \[\]\)/.test(page), "listener does not depend on the current business");
assert.ok(!/SEMRUSH_API_KEY/.test(page), "status never inferred from the key's presence");
assert.ok(/provider === "semrush"/.test(page), "the Semrush row uses the evidence-based status, not the integrations record");

console.log("All Semrush status checks passed (not checked / connected / error, account-level).");
