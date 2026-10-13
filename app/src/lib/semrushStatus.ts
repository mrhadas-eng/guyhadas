// Account-level Semrush integration status, derived from evidence - never
// from the mere presence of SEMRUSH_API_KEY, and never per business.
//
// Evidence:
//   - semrushBalanceSnapshots: written by visibilityGetSemrushBalance ONLY
//     after Semrush accepted the key and returned a balance -> proof that the
//     V4 key worked at that time;
//   - the result of a balance check made in this session (button). Failed
//     checks are NOT persisted by the backend (by design - no raw Semrush
//     errors are stored), so "error" can only come from a check made now.
import type { SemrushBalanceResult } from "./semrushBalance";

export type SemrushAccountStatus = "not_checked" | "connected" | "error";

export interface SemrushStatusView {
  status: SemrushAccountStatus;
  checkedAt: string | null;
  basis: "session_check" | "balance_snapshot" | "none";
}

export function deriveSemrushStatus(latestSnapshot: { checkedAt: string } | null, sessionResult: SemrushBalanceResult | null): SemrushStatusView {
  // A check made in this session is the most recent evidence.
  if (sessionResult) return { status: sessionResult.ok ? "connected" : "error", checkedAt: sessionResult.checkedAt, basis: "session_check" };
  if (latestSnapshot && typeof latestSnapshot.checkedAt === "string") return { status: "connected", checkedAt: latestSnapshot.checkedAt, basis: "balance_snapshot" };
  return { status: "not_checked", checkedAt: null, basis: "none" };
}

export const SEMRUSH_STATUS_LABELS: Record<SemrushAccountStatus, string> = { not_checked: "לא נבדק", connected: "מחובר", error: "שגיאה" };
// reuses the existing status-badge classes
export const SEMRUSH_STATUS_CLASS: Record<SemrushAccountStatus, string> = { not_checked: "not-connected", connected: "connected", error: "error" };
