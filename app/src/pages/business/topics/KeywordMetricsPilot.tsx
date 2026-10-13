import { useState } from "react";
import { enrichKeywordMetrics, governedDetails, type KeywordMetricsResult } from "../../../lib/functions";
import type { Keyword, MarketDemand, SearchTopic } from "../../../types";

// Semrush V4 Keyword Metrics pilot: enrich ONE stored query of ONE approved
// Search Topic. Two explicit steps (choose -> confirm the paid call); nothing
// runs on render, listener or page load. Not a Semrush dashboard.

const INTENT_HE: Record<string, string> = { commercial: "מסחרית", informational: "מידע", navigational: "ניווט", transactional: "רכישה" };
const n = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("he-IL", { maximumFractionDigits: d }));

// Safe provider diagnostics from a failed call (display only; typed + bounded).
interface ProviderDiagnostic {
  httpStatus: number | null;
  errorCode: string | null;
  requestId: string | null;
  retryable: boolean | null;
  contentType: string | null;
  responseFormat: string | null;
  bodyLength: number | null;
}
function providerDiagnostic(d: unknown): ProviderDiagnostic | null {
  if (!d || typeof d !== "object") return null;
  const x = d as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : null);
  const out: ProviderDiagnostic = {
    httpStatus: typeof x.httpStatus === "number" ? x.httpStatus : null,
    errorCode: str(x.errorCode, 40),
    requestId: str(x.requestId, 80),
    retryable: typeof x.retryable === "boolean" ? x.retryable : null,
    contentType: str(x.contentType, 80),
    responseFormat: str(x.responseFormat, 10),
    bodyLength: typeof x.bodyLength === "number" ? x.bodyLength : null
  };
  return out.httpStatus !== null || out.errorCode || out.requestId ? out : null;
}

export function MarketDemandSummary({ md }: { md: MarketDemand }) {
  return (
    <div className="text-dim" style={{ fontSize: "0.8rem" }}>
      <strong>נתוני שוק Semrush V4</strong> (הערכת ביקוש בשוק — לא תנועה שנמדדה בגוגל ולא Search Console) · {md.keyword} · {md.country} · {md.month}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 2 }}>
        {md.metricsAvailable ? (
          <>
            <span>נפח חיפוש חודשי: {n(md.searchVolume)}</span>
            <span>קושי: {n(md.keywordDifficulty)}</span>
            <span>כוונה: {md.intents.length ? md.intents.map((i) => INTENT_HE[i] || i).join(", ") : "—"}</span>
            <span>CPC: {md.cpc === null ? "—" : `$${n(md.cpc, 2)}`}</span>
            <span>תחרות מודעות: {n(md.competitiveDensity, 2)}</span>
            <span>תוצאות: {n(md.numberOfResults)}</span>
            {md.serpFeatures.length > 0 && <span>SERP: {md.serpFeatures.join(", ")}</span>}
          </>
        ) : (
          <span>Semrush לא החזיר נתונים לשאילתה הזו</span>
        )}
        <span>נשלף: {new Date(md.retrievedAt).toLocaleString("he-IL")}</span>
      </div>
    </div>
  );
}

export function KeywordMetricsPilot({ topic, keywords }: { topic: SearchTopic; keywords: Keyword[] }) {
  const options = keywords.filter((k) => !k.excludedByRule);
  const [query, setQuery] = useState<string>(() => (options.find((k) => k.query === topic.title) || options[0])?.query || "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeywordMetricsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diag, setDiag] = useState<ProviderDiagnostic | null>(null);
  if (!options.length) return null;

  async function run() {
    setBusy(true);
    setError(null);
    setDiag(null);
    try {
      setResult(await enrichKeywordMetrics(topic.businessId, topic.id, query));
    } catch (err) {
      const d = governedDetails(err);
      const why = d?.blockedReason ? ` (${d.blockedReason})` : "";
      const units = d?.providerCalled ? " · הבקשה נשלחה ל-Semrush (ייתכן שחויבו עד 20 יחידות)" : " · לא נשלחה בקשה ל-Semrush";
      setError(`${(err as Error).message}${why}${units}`.slice(0, 600));
      setDiag(providerDiagnostic(d));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="section-block" style={{ marginTop: "var(--space-3)", padding: "var(--space-3)" }}>
      <strong>בדיקת Semrush לנושא</strong> <span className="text-dim">(פיילוט V4 — בקשה אחת לשאילתה אחת)</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 6 }}>
        <label className="inline-field-label">
          שאילתה
          <select className="select-quiet" value={query} disabled={busy || confirming} onChange={(e) => setQuery(e.target.value)}>
            {options.map((k) => (
              <option key={k.id} value={k.query}>{k.query}</option>
            ))}
          </select>
        </label>
        {!confirming ? (
          <button type="button" className="btn btn-outline btn-sm" disabled={busy || !query} onClick={() => setConfirming(true)}>
            בדיקת Semrush לנושא
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-confirm btn-sm" disabled={busy} onClick={run}>
              {busy ? "שולח…" : "אישור — בקשה אחת בתשלום"}
            </button>
            <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => setConfirming(false)}>ביטול</button>
          </>
        )}
      </div>
      <div className="text-dim" style={{ fontSize: "0.8rem", marginTop: 4 }}>
        תישלח השאילתה המדויקת: <strong>„{query}“</strong> · מדינה: IL · עלות משוערת: <strong>20 יחידות API</strong> (0 אם כבר נבדקה החודש)
      </div>
      {result && (
        <div className="notice-ok" role="status" style={{ marginTop: "var(--space-2)" }}>
          {result.cacheHit ? "מהמטמון — לא נשלחה בקשה, 0 יחידות" : `נשלחה בקשה אחת ל-Semrush · יחידות לפי היומן שלנו: ${result.providerUnitsUsed}`} · {result.cacheDecision}
          <div style={{ marginTop: 4 }}>
            <MarketDemandSummary md={result.marketDemand} />
          </div>
        </div>
      )}
      {error && (
        <div className="login-error" role="alert" style={{ marginTop: "var(--space-2)" }}>
          הבדיקה לא בוצעה: {error}
          {diag && (
            <div style={{ marginTop: "var(--space-2)" }}>
              <strong>פרטי אבחון</strong>
              <ul className="tech-list" dir="ltr" style={{ textAlign: "left" }}>
                <li>HTTP: {diag.httpStatus ?? "—"}</li>
                <li>Error code: {diag.errorCode ?? "—"}</li>
                <li>Request ID: {diag.requestId ?? "—"}</li>
                <li>Retryable: {diag.retryable === null ? "—" : diag.retryable ? "yes" : "no"}</li>
                {diag.contentType && <li>Content-Type: {diag.contentType}</li>}
                {diag.responseFormat && <li>Format: {diag.responseFormat}</li>}
                {diag.bodyLength !== null && <li>Body: {diag.bodyLength} bytes</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
