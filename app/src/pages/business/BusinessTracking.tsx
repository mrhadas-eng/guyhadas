import { Fragment, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { EmptyState } from "../../components/EmptyState";
import { Disclosure } from "../../components/ui/Disclosure";
import { StatusPill, type StatusTone } from "../../components/ui/StatusPill";
import { listenChangeEvents, listenExperiments, listenImpactPredictions, listenLatestTrackingRun, releaseExperimentHold, updateChangeEventNotes } from "../../lib/firestore";
import { revertImplementation, runTracking } from "../../lib/functions";
import { when } from "../../lib/plainLanguage";
import type { ImpactPrediction, SeoChangeEvent, SeoExperiment, TrackingRun } from "../../types";
import type { BusinessContext } from "./BusinessWorkspace";
import { PredictionPanel } from "./tracking/PredictionPanel";
import { BEFORE, CHANGE_CLASS, CHECK_RESULT, ELEMENTS, IMPL_STATUS, STATES, WARNINGS, day, holdActiveNow, phaseNow, tr } from "./tracking/m7Labels";

// M7 - minimal inspection UI for change events and experiments (functional,
// not polished; final UX after M9). Firestore listeners only; the only
// function calls are explicit buttons. No signal or outcome is shown here:
// measurement starts in M8.

const STATUS_TONE: Record<string, StatusTone> = { verified: "good", recorded: "neutral", not_observed: "warn", not_verifiable: "neutral", contradicted: "bad", reverted: "neutral" };

function NotesEditor({ e }: { e: SeoChangeEvent }) {
  const [value, setValue] = useState(e.implementationNotes || "");
  const [saved, setSaved] = useState(false);
  return (
    <div className="form-field">
      <label htmlFor={`notes-${e.id}`}>הערות (אפשר לערוך)</label>
      <textarea id={`notes-${e.id}`} rows={2} maxLength={2000} value={value} onChange={(x) => { setValue(x.target.value); setSaved(false); }} />
      <button type="button" className="btn btn-outline" disabled={value === (e.implementationNotes || "")} onClick={async () => { await updateChangeEventNotes(e.id, value); setSaved(true); }}>שמירת הערות</button>
      {saved && <span className="text-dim"> נשמר</span>}
    </div>
  );
}

function EventDetail({ e, businessId, prediction }: { e: SeoChangeEvent; businessId: string; prediction?: ImpactPrediction }) {
  const [revertNote, setRevertNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="row-detail">
      <ul className="info-list">
        <li>מה שונה: {e.changedElements.map((x) => tr(ELEMENTS, x)).join(" · ")} ({tr(CHANGE_CLASS, e.changeType)})</li>
        <li>תאריך ביצוע: {e.implementationDate}{e.publicationDate ? ` · פרסום: ${e.publicationDate}` : ""} (דיווח שלך)</li>
        <li>בוצע על ידי: {e.responsibleActor.type === "owner" ? "אני" : e.responsibleActor.name || e.responsibleActor.type} · התאמה להמלצה: {e.implementationMatch === "full" ? "מלאה" : e.implementationMatch === "partial" ? "חלקית" : "שונה"}{e.deviationNote ? ` — ${e.deviationNote}` : ""}</li>
        {e.recommendedPageKey && e.recommendedPageKey !== e.targetPageKey && <li>הומלץ על <span dir="auto">{e.recommendedPageKey}</span>, שונה <span dir="auto">{e.targetPageKey}</span></li>}
        <li>תמונת מצב מלפני השינוי: {tr(BEFORE, e.beforeSnapshot.status)}{e.beforeSnapshot.capturedAtRecording ? " (נשמרה ברישום, מנתונים שלפני השינוי)" : ""}{e.beforeSnapshot.reason ? <span className="text-dim"> — {e.beforeSnapshot.reason}</span> : null}</li>
        <li>תמונת מצב אחרי: ממתינה (תיאסף בשלב המדידה, M8)</li>
      </ul>
      {e.verification && (
        <section className="detail-section">
          <h5 className="detail-heading">אימות בסריקה: {tr(IMPL_STATUS, e.verification.status)}</h5>
          <ul className="info-list">{e.verification.checks.map((c, i) => <li key={i}>{tr(ELEMENTS, c.element)}: {tr(CHECK_RESULT, c.result)}{c.note ? <span className="text-dim"> — {c.note}</span> : null}</li>)}</ul>
          <p className="panel-meta">האימות בודק רק שהשינוי קיים באתר — הוא לא אומר דבר על תוצאות SEO.</p>
        </section>
      )}
      {prediction && <PredictionPanel p={prediction} />}
      <NotesEditor e={e} />
      {e.implementationStatus !== "reverted" && (
        <Disclosure label="ביטול רישום (למשל תאריך שגוי)">
          <div className="form-field">
            <label htmlFor={`rv-${e.id}`}>למה מבטלים?</label>
            <input id={`rv-${e.id}`} value={revertNote} onChange={(x) => setRevertNote(x.target.value)} />
          </div>
          <button type="button" className="btn btn-outline" disabled={!revertNote.trim()} onClick={async () => {
            try {
              const r = await revertImplementation(businessId, e.id, revertNote.trim());
              setMsg(r.decision === "in_progress" ? "פעולת מעקב אחרת רצה כרגע — נסה שוב בעוד דקה." : "הרישום בוטל. ההיסטוריה נשמרת; תאריך מתוקן נרשם כביצוע חדש.");
            } catch (err) {
              setMsg(err instanceof Error ? err.message : "הביטול נכשל");
            }
          }}>ביטול הרישום</button>
          {msg && <p className="text-muted">{msg}</p>}
        </Disclosure>
      )}
      <Disclosure label="פרטים טכניים" tone="technical">
        <ul className="tech-list">
          <li>id: {e.id} · decision: {e.decisionId} · experiment: {e.experimentId || "—"}{e.lateJoin ? " (late)" : ""}</li>
          <li>prediction: {e.predictionId} · before: {e.beforeSnapshot.baselineId || "—"}</li>
          <li>history: {e.history.map((h) => `${h.event}@${when(h.at)}`).join(" → ")}</li>
        </ul>
      </Disclosure>
    </div>
  );
}

function ExperimentCard({ x, events, prediction }: { x: SeoExperiment; events: SeoChangeEvent[]; prediction?: ImpactPrediction }) {
  const now = Date.now();
  const phase = phaseNow(x, now);
  const holdActive = holdActiveNow(x, now);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const w = x.stageWindows;
  return (
    <div className="panel" style={{ marginBottom: "var(--space-4)" }}>
      <h4 className="section-title" dir="auto">{x.unit.scope === "site" ? "האתר כולו" : x.unit.pageKey}</h4>
      <p>
        <StatusPill tone={x.status === "closed" ? "neutral" : "warn"}>{tr(STATES, phase)}</StatusPill> {x.status === "closed" ? `נסגר: ${x.closedReason}` : ""}
      </p>
      <ul className="info-list">
        <li>שינויים בניסוי: {x.changeEventIds.length} ({x.groupedChangeEventIds.length} יחד{x.lateChangeEventIds.length ? `, ${x.lateChangeEventIds.length} מאוחרים` : ""}) · פעילים: {x.liveChangeEventIds.length}</li>
        <li>התחלת המעקב (פרסום): {day(x.startMs)} · סוף חלון המעקב: {day(x.observationWindowEndMs)}{x.extensions ? ` (הוארך ${x.extensions} פעמים)` : ""}</li>
        {w.A && <li>סימן ראשון צפוי: {day(w.A.fromMs)}–{day(w.A.toMs)}</li>}
        {w.B && <li>סימן SEO משמעותי צפוי: {day(w.B.fromMs)}–{day(w.B.toMs)}</li>}
        {w.C && <li>השפעה עסקית צפויה: {day(w.C.fromMs)}–{day(w.C.toMs)}</li>}
        <li className="text-dim">הטווחים הם הערכה (הנחה פנימית), לא התחייבות ולא לוח זמנים של Google.</li>
      </ul>
      {x.warnings.length > 0 && <p className="text-muted">שים לב: {x.warnings.map((k) => tr(WARNINGS, k)).join(" · ")}</p>}
      {x.interferences.length > 0 && <p className="text-muted">הפרעות למדידה: {x.interferences.map((i) => (i.type === "site_wide_change" ? "שינוי באתר כולו באותה תקופה" : "שינוי נוסף מאוחר יותר")).join(" · ")}</p>}
      {x.relatedExperimentIds.length > 0 && <p className="text-dim">קשור ל: {x.relatedExperimentIds.map((r) => `${r.experimentId} (${r.relation === "same_intent" ? "אותה כוונת חיפוש" : r.relation})`).join(" · ")}</p>}
      <section className="detail-section">
        <h5 className="detail-heading">החזקת המלצות חופפות</h5>
        {x.ownerHoldRelease?.released ? (
          <p>שחררת את ההחזקה ({x.ownerHoldRelease.note}). השחרור תקף עד סוף הניסוי הזה.</p>
        ) : holdActive ? (
          <>
            <p>המלצות חופפות על {x.unit.scope === "site" ? "האתר" : "הדף הזה"} מוחזקות עד {day(x.hold.holdUntilMs)} — כדי לא לבלבל את המדידה של השינוי שבוצע. ההמלצות לא נמחקות; הן יחזרו בסוף ההחזקה.</p>
            <div className="form-field">
              <label htmlFor={`rel-${x.id}`}>שחרור ההחזקה (נשאר בתוקף עד סוף הניסוי)</label>
              <input id={`rel-${x.id}`} maxLength={500} placeholder="למה לשחרר עכשיו?" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button type="button" className="btn btn-outline" disabled={busy || !note.trim()} onClick={async () => { setBusy(true); try { await releaseExperimentHold(x.id, note.trim()); } finally { setBusy(false); } }}>שחרור ההחזקה</button>
            <p className="panel-meta">ההחלטות יתעדכנו בהרצה הבאה של ״קבלת החלטות״.</p>
          </>
        ) : (
          <p className="text-muted">אין החזקה פעילה.</p>
        )}
      </section>
      <p className="panel-meta">מדידה ותוצאות: מתחילות בשלב M8. אין כאן קביעה של הצלחה או כישלון.</p>
      {prediction && (
        <Disclosure label="תחזית הניסוי">
          <PredictionPanel p={prediction} />
        </Disclosure>
      )}
      <Disclosure label="פרטים טכניים" tone="technical">
        <ul className="tech-list">
          <li>id: {x.id} · state: {x.timeState} · phase now: {phase}</li>
          <li>changes: {events.map((e) => e.id).join(", ")}</li>
          <li>decisions: {x.decisionIds.join(", ")} · intents: {x.intentIds.join(", ") || "—"}</li>
          <li>baseline: {x.baselineSnapshot.baselineId || x.baselineSnapshot.status} · prediction: {x.predictionId || "—"}</li>
        </ul>
      </Disclosure>
    </div>
  );
}

export default function BusinessTracking() {
  const { business } = useOutletContext<BusinessContext>();
  const [events, setEvents] = useState<SeoChangeEvent[] | null>(null);
  const [experiments, setExperiments] = useState<SeoExperiment[]>([]);
  const [predictions, setPredictions] = useState<ImpactPrediction[]>([]);
  const [run, setRun] = useState<TrackingRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!business) return;
    const a = listenChangeEvents(business.id, setEvents);
    const b = listenExperiments(business.id, setExperiments);
    const c = listenImpactPredictions(business.id, setPredictions);
    const d = listenLatestTrackingRun(business.id, setRun);
    return () => {
      a();
      b();
      c();
      d();
    };
  }, [business]);

  if (!business) return <div className="loading-row">טוען…</div>;
  const predById = new Map(predictions.map((p) => [p.id, p]));

  async function doRun() {
    if (!business) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await runTracking(business.id);
      if (r.decision === "in_progress") setNotice("פעולת מעקב אחרת רצה כרגע — לא בוצע דבר. אפשר לנסות שוב בעוד דקה.");
      else if (r.cacheHit) setNotice("לא השתנה דבר מאז הריצה הקודמת.");
      else setNotice(`המעקב עודכן: ${r.summary?.predictionsCreated || 0} תחזיות חדשות, ${r.summary?.verified || 0} אימותים, ${r.summary?.experiments || 0} ניסויים.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "הריצה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section-block">
      <header className="page-head">
        <div>
          <h2 className="page-title">מעקב שינויים</h2>
          <div className="page-meta">{run ? `עדכון מעקב אחרון: ${when(run.completedAtMs)}` : "עדיין לא הורץ מעקב"} · תחזיות, ביצועים שנרשמו וחלונות מעקב — בלי פניות חיצוניות</div>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={doRun}>{busy ? "מעדכן…" : "עדכון מעקב"}</button>
      </header>
      {notice && <div className="notice-ok">{notice}</div>}
      <p className="text-muted">״עדכון מעקב״ מחשב תחזית זמנית להמלצות שאישרת, בודק בסריקה האחרונה אם שינויים שרשמת נראים באתר, ומעדכן את חלונות המעקב. הוא לא מבצע שינוי באתר ולא מודד תוצאות (זה שלב M8).</p>

      <h3 className="section-title">ביצועים שנרשמו</h3>
      {events === null && <div className="loading-row">טוען…</div>}
      {events && events.length === 0 && <EmptyState title="עוד לא נרשם ביצוע" subtitle="אחרי שביצעת המלצה שאישרת, לוחצים ״רישום ביצוע״ בהחלטה." />}
      {events && events.length > 0 && (
        <div className="data-table-wrap table-sticky">
          <table className="data-table">
            <thead><tr><th>מצב</th><th>דף</th><th>מה שונה</th><th>תאריך</th><th><span className="visually-hidden">פירוט</span></th></tr></thead>
            <tbody>
              {events.map((e) => {
                const open = openId === e.id;
                return (
                  <Fragment key={e.id}>
                    <tr className={open ? "row-open" : ""}>
                      <td><StatusPill tone={STATUS_TONE[e.implementationStatus] || "neutral"}>{tr(IMPL_STATUS, e.implementationStatus)}</StatusPill></td>
                      <td className="url-text" dir="auto">{e.targetPageKey === "site" ? "האתר כולו" : e.targetPageKey}</td>
                      <td>{tr(CHANGE_CLASS, e.changeType)}</td>
                      <td>{e.publicationDate || e.implementationDate}</td>
                      <td style={{ textAlign: "end" }}>
                        <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpenId(open ? null : e.id)}>פירוט <span className="chev" aria-hidden="true">▾</span></button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="detail-row"><td colSpan={5}><EventDetail e={e} businessId={business.id} prediction={predById.get(e.predictionId)} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title" style={{ marginTop: "var(--space-5)" }}>ניסויים (חלונות מעקב)</h3>
      {experiments.length === 0 && <p className="text-muted">אין עדיין ניסויים. ניסוי נפתח כשנרשם ביצוע.</p>}
      {experiments.map((x) => (
        <ExperimentCard key={x.id} x={x} events={(events || []).filter((e) => x.changeEventIds.includes(e.id))} prediction={x.predictionId ? predById.get(x.predictionId) : undefined} />
      ))}
    </section>
  );
}
