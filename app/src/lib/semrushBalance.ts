// Client wrapper core for the deployed admin-only free Semrush balance check
// (functions/semrushBalance.js -> visibilityGetSemrushBalance). Free-standing
// (no Firebase import) so it is unit-testable; functions.ts binds it to the
// app's existing Firebase Auth session. The function calls ONLY Semrush's free
// balance request (0 API units) - never a paid report. The API key never
// reaches the browser; only { ok, currentBalance, checkedAt } / error come back.

export interface SemrushBalanceDiagnostic {
  httpStatus: number | null;
  contentType: string | null;
  redirected: boolean;
  finalPath: string | null;
  responseFormat: "html" | "json" | "csv" | "text" | "unknown";
  bodyLength: number | null;
  // optional, only when the response was JSON with a structured error
  errorCode?: string;
  errorMessage?: string;
  errorDescription?: string;
  requestId?: string;
}

const ERROR_FIELDS: [keyof SemrushBalanceDiagnostic, number][] = [["errorCode", 40], ["errorMessage", 200], ["errorDescription", 300], ["requestId", 80]];
// bounded, control chars stripped, and anything URL-with-query-like removed
function safeField(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/https?:\/\/\S*\?\S*/gi, "[url redacted]").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  return t || undefined;
}

export type SemrushBalanceResult = { ok: true; currentBalance: number; checkedAt: string } | { ok: false; error: string; checkedAt: string | null; diagnostic?: SemrushBalanceDiagnostic };

const FORMATS = ["html", "json", "csv", "text", "unknown"];

// Picks only the six safe diagnostic fields, type-checked; finalPath keeps
// origin + path only (any query string is dropped).
function safeDiagnostic(x: unknown): SemrushBalanceDiagnostic | undefined {
  if (!x || typeof x !== "object") return undefined;
  const d = x as Record<string, unknown>;
  let finalPath: string | null = null;
  if (typeof d.finalPath === "string") {
    try {
      const u = new URL(d.finalPath);
      finalPath = `${u.origin}${u.pathname}`;
    } catch {
      finalPath = null;
    }
  }
  const out: SemrushBalanceDiagnostic = {
    httpStatus: typeof d.httpStatus === "number" ? d.httpStatus : null,
    contentType: typeof d.contentType === "string" ? d.contentType.slice(0, 80) : null,
    redirected: d.redirected === true,
    finalPath,
    responseFormat: (typeof d.responseFormat === "string" && FORMATS.includes(d.responseFormat) ? d.responseFormat : "unknown") as SemrushBalanceDiagnostic["responseFormat"],
    bodyLength: typeof d.bodyLength === "number" ? d.bodyLength : null
  };
  for (const [k, max] of ERROR_FIELDS) {
    const v = safeField(d[k], max);
    if (v) (out as unknown as Record<string, string>)[k] = v;
  }
  return out;
}

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
  const diagnostic = safeDiagnostic(body.diagnostic);
  return diagnostic ? { ok: false, error, checkedAt, diagnostic } : { ok: false, error, checkedAt };
}
