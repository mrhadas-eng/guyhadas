import { useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { getSemrushBalance, type SemrushBalanceResult } from "../../lib/functions";

// Temporary admin-only control: checks the Semrush API unit balance through
// the deployed free balance function (0 API units). Runs ONLY when the button
// is clicked - never on page load, render or a listener. Not the final usage
// dashboard.
export default function SemrushBalanceCheck({ onResult }: { onResult?: (r: SemrushBalanceResult) => void } = {}) {
  const { isAuthorized } = useAuth();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SemrushBalanceResult | null>(null);
  if (!isAuthorized) return null;

  async function check() {
    setBusy(true);
    try {
      const r = await getSemrushBalance();
      setResult(r);
      if (onResult) onResult(r);
    } finally {
      setBusy(false);
    }
  }

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("he-IL") : "—");
  return (
    <div className="section-block" style={{ marginTop: "var(--space-5)" }}>
      <h3 className="section-title">Semrush — יתרת יחידות API</h3>
      <p className="text-muted">בדיקה חינמית (0 יחידות). המפתח נשאר בשרת; כל בדיקה מוצלחת נשמרת כתמונת מצב.</p>
      <button type="button" className="btn btn-outline" disabled={busy} onClick={check}>
        {busy ? "בודק…" : "בדיקת יתרת Semrush"}
      </button>
      {result && result.ok && (
        <div className="notice-ok" role="status" style={{ marginTop: "var(--space-3)" }}>
          יתרה נוכחית: <strong>{result.currentBalance.toLocaleString("he-IL")}</strong> יחידות · נבדק: {when(result.checkedAt)}
        </div>
      )}
      {result && !result.ok && (
        <div className="login-error" role="alert" style={{ marginTop: "var(--space-3)" }}>
          הבדיקה נכשלה: {result.error}
          {result.checkedAt ? ` · ${when(result.checkedAt)}` : ""}
          {result.diagnostic && (
            <div style={{ marginTop: "var(--space-2)" }}>
              <strong>פרטי אבחון</strong>
              <ul className="tech-list" dir="ltr" style={{ textAlign: "left" }}>
                <li>HTTP: {result.diagnostic.httpStatus ?? "—"}</li>
                <li>Content-Type: {result.diagnostic.contentType || "—"}</li>
                <li>Redirected: {result.diagnostic.redirected ? "yes" : "no"}</li>
                {result.diagnostic.finalPath && <li>Final path: {result.diagnostic.finalPath}</li>}
                <li>Format: {result.diagnostic.responseFormat}</li>
                <li>Body: {result.diagnostic.bodyLength ?? "—"} bytes</li>
                {result.diagnostic.errorCode && <li>Error code: {result.diagnostic.errorCode}</li>}
                {result.diagnostic.errorMessage && <li>Error message: {result.diagnostic.errorMessage}</li>}
                {result.diagnostic.errorDescription && <li>Error description: {result.diagnostic.errorDescription}</li>}
                {result.diagnostic.requestId && <li>Request ID: {result.diagnostic.requestId}</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
