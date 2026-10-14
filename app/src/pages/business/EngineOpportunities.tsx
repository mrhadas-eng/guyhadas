import { Fragment, useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Disclosure } from "../../components/ui/Disclosure";
import { StatusPill, type StatusTone } from "../../components/ui/StatusPill";
import { listenLatestOpportunityRun, updateOpportunity } from "../../lib/firestore";
import { runOpportunityEngine } from "../../lib/functions";
import { when } from "../../lib/plainLanguage";
import { OPPORTUNITY_STATUS_LABELS } from "../../types";
import type { Opportunity, OpportunityRun, OpportunityStatus } from "../../types";

// M5 - minimal inspection UI for engine opportunities (functional, not
// polished; final UX after M9). Data comes from Firestore listeners; the
// only function call is the explicit run button. Owner can only change the
// status (rules protect the engine's evidence and scores).

const TYPE_LABELS: Record<string, string> = {
  technical_blocker: "בעיה טכנית",
  ranking_upside: "שיפור מיקום",
  ctr_upside: "יותר קליקים",
  coverage_gap: "לא נמצא דף לנושא",
  page_not_visible: "דף בלי נראות ב-Search Console",
  internal_linking: "קישורים פנימיים",
  page_overlap_observed: "כמה דפים עם חשיפות לנושא",
  entity_clarity: "בהירות פרטי העסק"
};
const ACTION_LABELS: Record<string, string> = {
  IMPROVE_PAGE: "שיפור דף קיים",
  DEINDEX_NOINDEX_REVIEW: "לבדוק אם החסימה מכוונת",
  UPDATE_CONTENT: "עדכון תוכן",
  ADD_INTERNAL_LINKS: "הוספת קישורים פנימיים",
  CREATE_PAGE: "דף חדש",
  REWORK_INTENT: "התאמת הדף למה שמחפשים",
  WAIT_FOR_DATA: "להמתין לנתונים",
  MONITOR: "מעקב",
  CONSOLIDATE_PAGES: "איחוד דפים",
  ADD_ENTITY_COVERAGE: "הבהרת פרטי העסק באתר",
  ADD_STRUCTURED_DATA: "מידע מובנה על העסק"
};
const FACTOR_LABELS: Record<string, string> = {
  businessRelevance: "חשיבות לעסק",
  commercialValue: "ערך מסחרי",
  marketDemand: "ביקוש בשוק (Semrush)",
  observedVisibility: "נראות שנמדדה (Search Console)",
  upside: "פוטנציאל שיפור",
  effortInverse: "קלות ביצוע"
};
const BASIS_LABELS: Record<string, string> = { observed: "נמדד", inference: "הסקה", assumption: "הנחה", hypothesis: "השערה", unknown: "לא ידוע", not_applicable: "לא רלוונטי", insufficient_sample: "לא דורג — מעט נושאים להשוואה" };
const PRIORITY: Record<string, { tone: StatusTone; text: string }> = { high: { tone: "bad", text: "גבוהה" }, medium: { tone: "warn", text: "בינונית" }, low: { tone: "neutral", text: "נמוכה" } };
const CONF: Record<string, string> = { high: "גבוה", medium: "בינוני", low: "נמוך" };
const OUTCOME_LABELS: Record<string, string> = { NO_ACTION: "אין צורך בפעולה", WAIT_FOR_DATA: "ממתין לנתונים" };

function Detail({ o }: { o: Opportunity }) {
  return (
    <div className="row-detail">
      <p style={{ margin: "0 0 var(--space-3)" }}>{o.description}</p>
      <div className="detail-grid" style={{ marginTop: 0 }}>
        <div>
          <div className="detail-label">פעולות אפשריות (ההחלטה בשלב הבא)</div>
          <div>{(o.candidateActions || []).map((a) => ACTION_LABELS[a] || a).join(" · ")}</div>
        </div>
        <div>
          <div className="detail-label">ביטחון</div>
          <div>{CONF[o.confidence || ""] || "—"}{o.confidenceReasons && o.confidenceReasons.length ? ` — ${o.confidenceReasons.join("; ")}` : ""}</div>
        </div>
        <div>
          <div className="detail-label">דף</div>
          <div className="url-text" dir="auto">{o.relatedPage || "—"}</div>
        </div>
        <div>
          <div className="detail-label">בייסליין</div>
          <div>{o.baselineId ? `${o.baselineId}${o.baselineMatchesRun ? "" : " (לא מאותו ניתוח)"}` : "אין עדיין בייסליין"}</div>
        </div>
      </div>
      <section className="detail-section">
        <h5 className="detail-heading">למה זה הופיע</h5>
        <table className="data-table compact-table">
          <thead><tr><th>גורם</th><th>רמה (0–3)</th><th>משקל</th><th>בסיס</th><th>הסבר</th></tr></thead>
          <tbody>
            {(o.factors || []).map((f) => (
              <tr key={f.key}>
                <td>{FACTOR_LABELS[f.key] || f.key}</td>
                <td>{f.level ?? "—"}</td>
                <td>{f.weight}</td>
                <td>{BASIS_LABELS[f.basis] || f.basis}</td>
                <td className="text-muted">{f.explanation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="detail-section">
        <h5 className="detail-heading">ראיות</h5>
        <ul className="info-list">
          {(o.evidence || []).map((e) => (
            <li key={e.id}>
              {e.observation || e.id} <span className="text-dim">· {BASIS_LABELS[e.basis] || e.basis} · {e.sourceRef.collection}/{e.sourceRef.docId}</span>
            </li>
          ))}
        </ul>
      </section>
      <Disclosure label="פרטים טכניים" tone="technical">
        <ul className="tech-list">
          <li>id: {o.id} · type: {o.type} · dedupeKey: {o.dedupeKey}</li>
          <li>score: {o.score} · priority: {o.priority} · confidence: {o.confidence}</li>
          <li>topics: {(o.targetTopicIds || []).join(", ") || "—"} · pages: {(o.targetPageKeys || []).join(", ") || "—"}</li>
          <li>engineState: {o.engineState} · detected {o.detectionCount}× · first {when(o.firstDetectedAtMs)} · last {when(o.lastDetectedAtMs)}</li>
          <li>sourceRunId: {o.sourceRunId} · missing: {(o.missing || []).join(", ") || "—"}</li>
        </ul>
      </Disclosure>
    </div>
  );
}

export function EngineOpportunities({ businessId, opportunities }: { businessId: string; opportunities: Opportunity[] }) {
  const [run, setRun] = useState<OpportunityRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => listenLatestOpportunityRun(businessId, setRun), [businessId]);

  async function doRun() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await runOpportunityEngine(businessId);
      setNotice(r.cacheHit ? "לא השתנה דבר מאז הזיהוי הקודם — התוצאה נשמרה כפי שהיא." : `הזיהוי הושלם: ${r.summary.opportunities} הזדמנויות (${r.summary.created ?? 0} חדשות).`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "הזיהוי נכשל");
    } finally {
      setBusy(false);
    }
  }

  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const active = opportunities.filter((o) => o.engineState !== "resolved" && o.status !== "rejected").sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3) || (b.score ?? 0) - (a.score ?? 0));
  const rejected = opportunities.filter((o) => o.status === "rejected");
  const resolved = opportunities.filter((o) => o.engineState === "resolved" && o.status !== "rejected");
  const quiet = (run?.topicEvaluations || []).filter((e) => e.outcome !== "opportunities");

  const row = (o: Opportunity) => {
    const p = PRIORITY[o.priority] || PRIORITY.low;
    const open = openId === o.id;
    return (
      <Fragment key={o.id}>
        <tr className={open ? "row-open" : ""}>
          <td><StatusPill tone={p.tone}>{p.text}</StatusPill></td>
          <td className="text-muted">{TYPE_LABELS[o.type || ""] || o.type}</td>
          <td><strong>{o.title}</strong></td>
          <td className="text-muted">{CONF[o.confidence || ""] || "—"}</td>
          <td>
            <select className="select-quiet" value={o.status} onChange={(e) => updateOpportunity(o.id, { status: e.target.value as OpportunityStatus })} aria-label="סטטוס">
              {Object.entries(OPPORTUNITY_STATUS_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </td>
          <td style={{ textAlign: "end" }}>
            <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpenId(open ? null : o.id)}>
              פירוט <span className="chev" aria-hidden="true">▾</span>
            </button>
          </td>
        </tr>
        {open && (
          <tr className="detail-row">
            <td colSpan={6}><Detail o={o} /></td>
          </tr>
        )}
      </Fragment>
    );
  };

  const table = (list: Opportunity[]) => (
    <div className="data-table-wrap table-sticky">
      <table className="data-table">
        <thead><tr><th>עדיפות</th><th>סוג</th><th>הזדמנות</th><th>ביטחון</th><th>סטטוס שלך</th><th><span className="visually-hidden">פירוט</span></th></tr></thead>
        <tbody>{list.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <section className="section-block">
      <header className="page-head">
        <div>
          <h2 className="page-title">הזדמנויות שהמערכת זיהתה</h2>
          <div className="page-meta">{run ? `זיהוי אחרון: ${when(run.completedAtMs)}` : "עדיין לא הורץ זיהוי"} · מבוסס על ניתוח מודיעין החיפוש האחרון, בלי פניות חיצוניות</div>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={doRun}>{busy ? "מזהה…" : "זיהוי הזדמנויות"}</button>
      </header>
      {notice && <div className="notice-ok">{notice}</div>}
      {run?.reason && <div className="panel-meta" style={{ marginBottom: "var(--space-3)" }}>{run.reason === "no completed search-intelligence run - run the analysis first" ? "צריך קודם להריץ ניתוח במודיעין חיפוש." : run.reason}</div>}

      {active.length === 0 ? (
        <EmptyState title="אין הזדמנויות פעילות" subtitle={run ? "המערכת לא מצאה כרגע משהו שמצדיק פעולה." : "לוחצים על ״זיהוי הזדמנויות״."} />
      ) : (
        table(active)
      )}

      {quiet.length > 0 && (
        <Disclosure label={`נושאים בלי פעולה כרגע (${quiet.length})`}>
          <ul className="info-list">
            {quiet.map((e) => (
              <li key={e.topicId}><strong>{e.title}</strong> — {OUTCOME_LABELS[e.outcome] || e.outcome}{e.reasons && e.reasons.length ? `: ${e.reasons.join("; ")}` : ""}</li>
            ))}
          </ul>
        </Disclosure>
      )}
      {resolved.length > 0 && <Disclosure label={`לא זוהו בניתוח האחרון (${resolved.length})`}>{table(resolved)}</Disclosure>}
      {rejected.length > 0 && <Disclosure label={`נדחו על ידך (${rejected.length})`}>{table(rejected)}</Disclosure>}
    </section>
  );
}
