import { useState } from "react";
import { Modal } from "../../../components/Modal";
import { recordImplementation, type RecordImplementationInput, type RecordImplementationResult } from "../../../lib/functions";
import type { Decision } from "../../../types";
import { BEFORE, ELEMENTS, STATES, tr } from "./m7Labels";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });

// Explicit owner form (P1: only for an accepted IMPROVE / CREATE /
// CONSOLIDATE). Accepting a decision is NOT implementation - this form is
// the only way a change event is created.
export function RecordImplementationModal({ businessId, d, onClose }: { businessId: string; d: Decision; onClose: () => void }) {
  const held = d.churnHold && d.reasonCodes.includes("IMPLEMENTED_UNDER_OBSERVATION") ? d.churnHold : null;
  const effective = held ? held.heldDecision : d.decision;
  const page = held ? held.heldRecommendedPage : d.recommendedPage;
  const [implementedDate, setImplementedDate] = useState(today());
  const [publishedDate, setPublishedDate] = useState("");
  const [targetUrl, setTargetUrl] = useState(page && page.kind === "existing" ? page.url || "" : "");
  const [elements, setElements] = useState<string[]>([]);
  const [intentChange, setIntentChange] = useState(false);
  const [match, setMatch] = useState<RecordImplementationInput["implementationMatch"]>("full");
  const [deviationNote, setDeviationNote] = useState("");
  const [actorType, setActorType] = useState<RecordImplementationInput["responsibleActor"]["type"]>("owner");
  const [actorName, setActorName] = useState("");
  const [notes, setNotes] = useState("");
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecordImplementationResult | null>(null);

  const toggle = (e: string) => setElements((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await recordImplementation(businessId, {
        decisionId: d.id,
        implementedDate,
        publishedDate: publishedDate || null,
        targetUrl: d.scope === "site" ? null : targetUrl || null,
        changedElements: elements,
        intentChange,
        implementationMatch: match,
        deviationNote: deviationNote || null,
        responsibleActor: { type: actorType, name: actorName || null },
        implementationNotes: notes,
        ownerAttestation: attested
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "הרישום נכשל");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Modal title="רישום ביצוע" onClose={onClose}>
        {result.decision === "in_progress" ? (
          <p>פעולת מעקב אחרת רצה כרגע לעסק — לא נרשם דבר. אפשר לנסות שוב בעוד דקה.</p>
        ) : result.duplicate ? (
          <p>הביצוע הזה כבר נרשם קודם — לא נוצר רישום כפול.</p>
        ) : (
          <ul className="info-list">
            <li>הביצוע נרשם (שינוי {result.changeEventId}).</li>
            <li>תמונת מצב מלפני השינוי: {tr(BEFORE, result.beforeSnapshot?.status)}{result.beforeSnapshot?.reason ? ` — ${result.beforeSnapshot.reason}` : ""}</li>
            <li>מצב המעקב: {tr(STATES, result.experimentState)}</li>
            <li className="text-muted">האימות שהשינוי באמת באתר יקרה אחרי הניתוח הבא במודיעין חיפוש והרצת המעקב. אימות כזה בודק רק שהשינוי קיים — לא את התוצאה.</li>
          </ul>
        )}
        <div className="form-actions"><button type="button" className="btn btn-primary" onClick={onClose}>סגירה</button></div>
      </Modal>
    );
  }

  return (
    <Modal title="רישום ביצוע של ההמלצה" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="text-muted">ממלאים אחרי שהשינוי בוצע בפועל באתר. אישור ההמלצה לבדו אינו ביצוע.</p>
        <div className="form-row">
          <div className="form-field">
            <label htmlFor="impl-date">תאריך ביצוע *</label>
            <input id="impl-date" type="date" max={today()} value={implementedDate} onChange={(e) => setImplementedDate(e.target.value)} required />
          </div>
          <div className="form-field">
            <label htmlFor="pub-date">תאריך פרסום (אם שונה)</label>
            <input id="pub-date" type="date" value={publishedDate} onChange={(e) => setPublishedDate(e.target.value)} />
          </div>
        </div>
        {d.scope !== "site" && (
          <div className="form-field">
            <label htmlFor="impl-url">כתובת הדף ששונה {effective === "CREATE" ? "* (הכתובת של הדף החדש)" : ""}</label>
            <input id="impl-url" dir="ltr" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} required={effective === "CREATE"} />
          </div>
        )}
        <fieldset className="form-field">
          <legend>מה שונה בפועל? *</legend>
          {Object.entries(ELEMENTS).map(([k, l]) => (
            <label key={k} style={{ display: "inline-flex", gap: 6, marginInlineEnd: 12 }}>
              <input type="checkbox" checked={elements.includes(k)} onChange={() => toggle(k)} /> {l}
            </label>
          ))}
          <label style={{ display: "block", marginTop: 8 }}>
            <input type="checkbox" checked={intentChange} onChange={(e) => setIntentChange(e.target.checked)} /> השינוי שינה את מה שהדף עונה עליו (כוונת החיפוש)
          </label>
        </fieldset>
        <div className="form-row">
          <div className="form-field">
            <label htmlFor="impl-match">האם בוצע כפי שהומלץ? *</label>
            <select id="impl-match" value={match} onChange={(e) => setMatch(e.target.value as RecordImplementationInput["implementationMatch"])}>
              <option value="full">כן, במלואו</option>
              <option value="partial">חלקית</option>
              <option value="different">בוצע משהו אחר</option>
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="impl-actor">מי ביצע *</label>
            <select id="impl-actor" value={actorType} onChange={(e) => setActorType(e.target.value as RecordImplementationInput["responsibleActor"]["type"])}>
              <option value="owner">אני</option>
              <option value="contractor">פרילנסר / ספק</option>
              <option value="agency">סוכנות</option>
            </select>
          </div>
        </div>
        {actorType !== "owner" && (
          <div className="form-field">
            <label htmlFor="impl-actor-name">שם</label>
            <input id="impl-actor-name" value={actorName} onChange={(e) => setActorName(e.target.value)} />
          </div>
        )}
        {match !== "full" && (
          <div className="form-field">
            <label htmlFor="impl-dev">מה היה שונה מההמלצה? *</label>
            <textarea id="impl-dev" rows={2} value={deviationNote} onChange={(e) => setDeviationNote(e.target.value)} required />
          </div>
        )}
        <div className="form-field">
          <label htmlFor="impl-notes">הערות</label>
          <textarea id="impl-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <label style={{ display: "block", margin: "var(--space-3) 0" }}>
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} required /> אני מאשר שהשינוי בוצע בפועל באתר
        </label>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !elements.length || !attested}>{busy ? "רושם…" : "רישום ביצוע"}</button>
          <button type="button" className="btn btn-outline" onClick={onClose}>ביטול</button>
        </div>
      </form>
    </Modal>
  );
}
