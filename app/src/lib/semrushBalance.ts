// Client wrapper core for the deployed admin-only free Semrush balance check
// (functions/semrushBalance.js -> visibilityGetSemrushBalance). Free-standing
// (no Firebase import) so it is unit-testable; functions.ts binds it to the
// app's existing Firebase Auth session. The function calls ONLY Semrush's free
// balance request (0 API units) - never a paid report. The API key never
// reaches the browser; only { ok, currentBalance, checkedAt } / error come back.

export type SemrushBalanceResult = { ok: true; currentBalance: number; checkedAt: string } | { ok: false; error: string; checkedAt: string | null };

interface IdTokenUser {
  getIdToken: () => Promise<string>;
}
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export async function requestSemrushBalance(getUser: () => IdTokenUser | null, fetchImpl: FetchLike, url: string): Promise<SemrushBalanceResult> {
  const user = getUser();
  if (!user) return { ok: false, error: "לא מחובר - צריך להתחבר מחדש", checkedAt: null };
  let token: string;
  try {
    token = await user.getIdToken();
  } catch {
    return { ok: false, error: "לא ניתן לאמת את ההתחברות - נסה להתחבר מחדש", checkedAt: null };
  }
  let status = 0;
  let json: unknown;
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "{}" });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch {
    return { ok: false, error: "אין חיבור לשרת - נסה שוב", checkedAt: null };
  }
  const body = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const checkedAt = typeof body.checkedAt === "string" ? body.checkedAt : null;
  if (body.ok === true && typeof body.currentBalance === "number" && Number.isFinite(body.currentBalance) && checkedAt) {
    // only the safe fields - nothing else from the response is passed on
    return { ok: true, currentBalance: body.currentBalance, checkedAt };
  }
  const error = typeof body.error === "string" && body.error ? body.error : `בדיקת היתרה נכשלה (${status || "ללא תגובה"})`;
  return { ok: false, error, checkedAt };
}
