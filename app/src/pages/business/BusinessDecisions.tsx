import { Fragment, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { EmptyState } from "../../components/EmptyState";
import { Disclosure } from "../../components/ui/Disclosure";
import { StatusPill, type StatusTone } from "../../components/ui/StatusPill";
import { listenDecisions, listenLatestDecisionRun, listenSearchIntents, updateDecisionReview } from "../../lib/firestore";
import { runDecisionEngine } from "../../lib/functions";
import { when } from "../../lib/plainLanguage";
import type { Decision, DecisionOwnerStatus, DecisionRun, SearchIntent } from "../../types";
import type { BusinessContext } from "./BusinessWorkspace";

// M6 - minimal inspection UI for Decision Engine output (functional, not
// polished; final UX after M9). Data comes from Firestore listeners; the only
// function call is the explicit run button. The owner can only record a
// review (status + note) - rules protect everything the engine wrote.

const ORDER = ["CREATE", "IMPROVE", "CONSOLIDATE", "MONITOR", "WAIT", "REJECT"] as const;
const DECISION_LABELS: Record<string, { text: string; tone: StatusTone; plural: string }> = {
  CREATE: { text: "דף חדש", tone: "warn", plural: "דף חדש מוצדק" },
  IMPROVE: { text: "שיפור דף קיים", tone: "good", plural: "שיפור דף קיים" },
  CONSOLIDATE: { text: "איחוד דפים", tone: "bad", plural: "המלצה לאיחוד דפים" },
  MONITOR: { text: "מעקב", tone: "neutral", plural: "במעקב" },
  WAIT: { text: "ממתין", tone: "neutral", plural: "ממתינים" },
  REJECT: { text: "אין פעולה", tone: "neutral", plural: "אין פעולה / נדחה" }
};
const OWNER_STATUS: Record<DecisionOwnerStatus, string> = { pending: "ממתין לבדיקה", accepted: "מקובל עליי", rejected: "לא מקובל", deferred: "לא עכשיו" };
const CONF: Record<string, string> = { high: "גבוה", medium: "בינוני", low: "נמוך" };
const SCOPE: Record<string, string> = { intent: "כוונת חיפוש", page: "דף", site: "האתר כולו" };
const ACTION: Record<string, string> = {
  fix_eligibility: "לתקן חסימה טכנית בדף",
  strengthen_content: "לחזק את התוכן בדף",
  improve_snippet: "לשפר כותרת ותיאור בתוצאות",
  rework_intent: "להתאים את הדף למה שמחפשים",
  add_internal_links: "להוסיף קישורים פנימיים לדף",
  clarify_business_facts: "לחדד את פרטי העסק באתר",
  consolidate_into_owner: "לאחד לדף ראשי אחד",
  new_page: "דף חדש (מקום שמור בלבד)"
};
const INTENT_TYPES: Record<string, string> = {
  navigational: "חיפוש העסק עצמו",
  pricing: "מחיר",
  comparison: "השוואה",
  review: "המלצות וחוות דעת",
  how_to: "איך עושים",
  definition: "מה זה",
  local: "שירות באזור מסוים",
  commercial_investigation: "בדיקת שירות לפני פנייה",
  informational: "מידע כללי",
  transactional: "הזמנה / רכישה",
  availability: "זמינות",
  problem_discovery: "זיהוי בעיה",
  solution_discovery: "חיפוש פתרון",
  media: "תמונות / וידאו",
  research: "מחקר ונתונים",
  location: "מקום",
  entity_specific: "שם השירות בלבד",
  unclassified: "לא סווג"
};
const TASKS: Record<string, string> = { hire: "לשכור את השירות", check_price: "לבדוק מחיר", evaluate: "להעריך את השירות", learn: "ללמוד", compare: "להשוות", find_business: "למצוא את העסק", find_place: "למצוא מקום" };
const OWNERSHIP: Record<string, string> = { established: "יש דף ראשי ברור", contested: "כמה דפים חולקים את החשיפות", probable: "דף מתאים לפי התוכן (הסקה)", ambiguous: "לא ברור איזה דף הראשי", none: "אין דף לכוונה", unknown: "לא ידוע (חסרים נתונים)" };
const COLLISION: Record<string, string> = {
  NO_COLLISION: "אין התנגשות",
  RELATED_BUT_DISTINCT: "דפים קשורים אבל שונים",
  POTENTIAL_COLLISION: "ייתכן שדפים מתחרים",
  HIGH_COLLISION: "לפי הנתונים שלנו, דפים מתחרים",
  DUPLICATE: "לפי הנתונים שלנו, דפים כמעט זהים"
};
const FIT: Record<string, string> = { fit: "מתאים", unknown: "לא ידוע", mismatch: "לא מתאים" };
const DISTINCT: Record<string, string> = { user_task: "מה שהגולש רוצה לעשות", entity: "שירות אחר", entity_place: "אזור שהגדרת", information_requirement: "סוג המידע הנדרש", no_existing_page: "אין דף קיים" };
const REASONS: Record<string, string> = {
  OWNER_ESTABLISHED: "יש דף קיים שמשרת את הכוונה",
  OWNER_PROBABLE_NO_VISIBILITY: "יש דף מתאים, אבל לא נמדדה לו נראות ב-Search Console",
  OWNER_HAS_BLOCKER: "לדף יש חסימה טכנית",
  OWNER_NOT_ACCEPTABLE_INTENT_MISMATCH: "הדף הקיים לא מתאים לסוג החיפוש",
  EXISTING_OWNER: "כבר יש דף מתאים — לכן לא דף חדש",
  NO_ACCEPTABLE_OWNER: "אין דף קיים שמתאים",
  EXTEND_RELATED_PAGE: "דף קשור לאותו שירות יכול להכיל את זה",
  NEW_PAGE_JUSTIFIED_DISTINCT_TASK: "דף חדש מוצדק: הגולש רוצה לעשות משהו אחר",
  NEW_PAGE_JUSTIFIED_DISTINCT_ENTITY: "דף חדש מוצדק: שירות או אזור אחר",
  NEW_PAGE_JUSTIFIED_DISTINCT_INFORMATION: "דף חדש מוצדק: נדרש מידע מסוג אחר",
  NEW_PAGE_NOT_JUSTIFIED_SAME_TASK: "דף חדש לא מוצדק: הדף הקיים יכול לשרת את אותו צורך",
  NO_OWNER_GATES_PASSED: "כל תנאי הבטיחות לדף חדש התקיימו",
  COLLISION_DUPLICATE: "לפי הנתונים שלנו הדפים כמעט זהים",
  COLLISION_HIGH: "לפי הנתונים שלנו הדפים מתחרים על אותה כוונה",
  COLLISION_POTENTIAL: "ייתכן שדפים מתחרים — עוד לא מספיק ראיות",
  PROPOSED_PAGE_COLLIDES: "דף חדש היה מתנגש בדף קיים",
  LOCATION_VARIANT_NOT_JUSTIFIED: "דף נפרד לאזור לא מוצדק כרגע",
  INFORMATIONAL_NEEDS_DEMAND: "דף מידע צריך ראיה לביקוש בשוק או נראות שנמדדה",
  CREATE_BUDGET_EXCEEDED: "נדחה בגלל מגבלת דפים חדשים לריצה",
  CREATE_DISABLED_BY_POLICY: "יצירת דפים חדשים כבויה במדיניות",
  CLUSTER_CREATE_PENDING: "כבר הומלץ דף חדש אחר באותו אשכול נושאים",
  CLUSTER_FRAGMENTATION_RISK: "כמה כוונות באותו אשכול — סכנת פיצול לדפים רבים",
  MISSING_MARKET_DEMAND: "ביקוש בשוק לא ידוע (אין נתוני Semrush)",
  VISIBILITY_OBSERVED_NOT_DEMAND: "נמדדה נראות ב-Search Console — זה לא מדד לגודל הביקוש בשוק",
  MISSING_VISIBILITY_DATA: "אין נתוני Search Console",
  INTENT_UNCLASSIFIED: "סוג החיפוש לא סווג",
  ENTITY_UNKNOWN: "לא ברור לאיזה שירות זה שייך",
  OWNERSHIP_UNCLEAR: "לא ברור איזה דף הראשי",
  NOT_AN_OWNER_PAGE: "הדף לא משרת כוונה מאושרת כדף ראשי",
  SUBSUMED_BY_DECISION: "נכלל בהחלטה אחרת",
  NO_PAGE_TO_EXTEND: "אין דף קיים שאפשר להרחיב",
  OWNER_REJECTED: "דחית את ההזדמנויות האלה",
  TOPIC_NO_LONGER_APPROVED: "הנושא כבר לא מאושר",
  NO_ACTION_NEEDED: "אין צורך בפעולה כרגע",
  INSUFFICIENT_EVIDENCE: "אין מספיק ראיות",
  BUSINESS_FACTS_CONFLICTING: "נמצאו באתר פרטי עסק סותרים",
  BUSINESS_FACTS_MISSING: "פרטי עסק חסרים באתר"
};
const BLOCKING: Record<string, string> = {
  HUMAN_REVIEW_REQUIRED: "דורש בדיקה שלך",
  CONFIRM_BLOCKER_UNINTENDED: "לוודא שהחסימה לא מכוונת",
  NEEDS_MARKET_DEMAND: "חסרה ראיה לביקוש בשוק",
  NEEDS_SERP_OVERLAP_OR_MORE_DATA: "צריך עוד נתונים (אין נתוני SERP)",
  NEEDS_INTENT_CLASSIFICATION: "צריך לסווג את סוג החיפוש",
  NEEDS_ENTITY_CONFIRMATION: "צריך לשייך לשירות",
  NEEDS_OWNER_GEOGRAPHY_CONFIRMATION: "צריך לאשר את האזור כאזור שירות",
  WAIT_FOR_NEXT_ANALYSIS: "להמתין לניתוח הבא"
};
const BASIS: Record<string, string> = { observed: "נמדד", inference: "הסקה", inferred: "הסקה", assumption: "הנחה", hypothesis: "השערה", recommendation: "המלצה", unknown: "לא ידוע" };
const tr = (map: Record<string, string>, k: string | null | undefined) => (k ? map[k] || k : "—");

function Detail({ d, intent }: { d: Decision; intent?: SearchIntent }) {
  return (
    <div className="row-detail">
      <p style={{ margin: "0 0 var(--space-3)" }}>{d.summary}</p>
      {d.decision === "CREATE" && <div className="notice-ok">המלצה בלבד: המערכת לא יוצרת דף, כתובת או תוכן. זה מקום שמור לכוונת החיפוש — התכנון והכתיבה הם החלטה שלך.</div>}
      {d.decision === "CONSOLIDATE" && <div className="notice-ok">זו המלצה שלנו על סמך הראיות הזמינות (Search Console וסריקת האתר), לא החלטה של Google לגבי הכתובת הקנונית. Google מתייחס להעדפות כתובת ראשית כרמז ומחליט בעצמו.</div>}
      <div className="detail-grid" style={{ marginTop: "var(--space-3)" }}>
        <div>
          <div className="detail-label">פעולה</div>
          <div>{tr(ACTION, d.actionDetail)}{d.actionDetails && d.actionDetails.length > 1 ? ` · ${d.actionDetails.slice(1).map((a) => tr(ACTION, a)).join(" · ")}` : ""}</div>
        </div>
        <div>
          <div className="detail-label">ביטחון</div>
          <div>{tr(CONF, d.confidence)}{d.confidenceReasons.length ? ` — ${d.confidenceReasons.join("; ")}` : ""}</div>
        </div>
        <div>
          <div className="detail-label">דף יעד</div>
          <div className="url-text" dir="auto">{d.recommendedPage.kind === "existing" ? d.recommendedPage.url : d.recommendedPage.kind === "new_page_placeholder" ? "מקום שמור לדף חדש (בלי כתובת)" : d.recommendedPage.kind === "business_facts" ? "פרטי העסק באתר" : "—"}</div>
        </div>
        <div>
          <div className="detail-label">דף ראשי קיים</div>
          <div className="url-text" dir="auto">{d.existingOwnerUrl || "—"}</div>
        </div>
      </div>

      {intent && (
        <section className="detail-section">
          <h5 className="detail-heading">כוונת החיפוש</h5>
          <ul className="info-list">
            <li>סוג: <strong>{tr(INTENT_TYPES, intent.intentType)}</strong> (הסקה, ביטחון {tr(CONF, intent.intentConfidence)}){intent.secondaryIntentTypes.length ? ` · גם: ${intent.secondaryIntentTypes.map((t) => tr(INTENT_TYPES, t)).join(", ")}` : ""}</li>
            <li>מה הגולש רוצה: {tr(TASKS, intent.userTask.verb)}{intent.userTask.qualifiers.geography ? ` · אזור: ${intent.userTask.qualifiers.geography.replace("place:", "")}` : ""}</li>
            <li>ישויות: {intent.entityRefs.map((e) => `${e.label}${e.type === "place" && e.ownerDeclared ? " (אזור שהגדרת)" : ""}`).join(" · ") || "—"}</li>
            <li>נושאים: {(intent.topicTitles || intent.topicIds).join(" · ")} · {intent.queryCount} שאילתות</li>
            {intent.sampleQueries.length > 0 && <li className="text-muted">דוגמאות: {intent.sampleQueries.slice(0, 5).join(" · ")}</li>}
          </ul>
        </section>
      )}

      {d.ownership && (
        <section className="detail-section">
          <h5 className="detail-heading">בעלות: {tr(OWNERSHIP, d.ownership.status)}{d.ownership.acceptable ? " · הדף מתאים" : ""}</h5>
          {d.ownership.candidates.length > 0 && (
            <table className="data-table compact-table">
              <thead><tr><th>דף</th><th>חלק מהחשיפות</th><th>מקור</th><th>כשירות (סריקה)</th><th>התאמה לחיפוש</th></tr></thead>
              <tbody>
                {d.ownership.candidates.map((c) => (
                  <tr key={c.pageKey}>
                    <td className="url-text" dir="auto">{c.url}</td>
                    <td>{c.observedShare != null ? `${Math.round(c.observedShare * 100)}%` : "—"}</td>
                    <td className="text-muted">{c.sources.map((s) => (s === "search_console" ? "Search Console" : s === "content_match" ? "תוכן" : "דף שירות")).join(", ")}</td>
                    <td>{c.eligibility === "eligible" ? "כשיר" : c.eligibility === "blocked" ? "חסום" : "לא נבדק"}</td>
                    <td>{tr(FIT, c.intentFit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="panel-meta">ספי הבעלות (60% / 25%) הם הנחת עבודה שלנו, לא סף של Google.</p>
        </section>
      )}

      {d.collision && (
        <section className="detail-section">
          <h5 className="detail-heading">התנגשות בין דפים: {tr(COLLISION, d.collision.status)}</h5>
          <p className="text-muted" dir="auto">{d.collision.reason}</p>
          {d.proposedPageCollision && <p className="text-muted">דף חדש מול דפים קיימים: {tr(COLLISION, d.proposedPageCollision.status)} — <span dir="auto">{d.proposedPageCollision.reason}</span></p>}
          <p className="panel-meta">הספים הם הנחות עבודה פנימיות, לא ספים של Google. אין נתוני SERP.</p>
        </section>
      )}

      {d.consolidation && (
        <section className="detail-section">
          <h5 className="detail-heading">המלצת איחוד</h5>
          <ul className="info-list">
            <li>דף ראשי מומלץ (המלצה שלנו): <span className="url-text" dir="auto">{d.consolidation.recommendedOwnerUrl}</span></li>
            <li>דפים נוספים: <span dir="auto">{d.consolidation.otherPageKeys.join(" · ")}</span></li>
            {d.consolidation.declaredCanonicals.map((c) => (
              <li key={c.pageKey}>תגית canonical באתר: <span dir="auto">{c.pageKey} → {c.declaredCanonical}</span> (העדפה שהאתר הצהיר עליה)</li>
            ))}
            <li>הכתובת הקנונית ש-Google בוחר: לא ידועה למערכת (אין לנו נתון ישיר מ-Google).</li>
          </ul>
        </section>
      )}

      {(d.newPageJustification.evaluated || d.decision === "CREATE") && (
        <section className="detail-section">
          <h5 className="detail-heading">האם דף חדש מוצדק? {d.newPageJustification.justified ? "כן" : "לא"}</h5>
          <p className="text-muted">{d.newPageJustification.distinctOn.length ? `שונה ב: ${d.newPageJustification.distinctOn.map((x) => tr(DISTINCT, x)).join(", ")}` : "אין הבדל מהותי מדף קיים"}</p>
          {d.newPageJustification.reason && <p className="text-dim" dir="auto">{d.newPageJustification.reason}</p>}
        </section>
      )}

      <section className="detail-section">
        <h5 className="detail-heading">למה ההחלטה הזו</h5>
        <ul className="info-list">
          {d.reasonCodes.map((c) => <li key={c}>{tr(REASONS, c)}</li>)}
        </ul>
        {d.blockingConditions.length > 0 && <p><strong>לפני שפועלים:</strong> {d.blockingConditions.map((b) => tr(BLOCKING, b)).join(" · ")}</p>}
        {d.alternativesConsidered.length > 0 && (
          <>
            <div className="detail-label">חלופות שנבדקו</div>
            <ul className="info-list">
              {d.alternativesConsidered.map((a, i) => (
                <li key={i}>{tr(Object.fromEntries(Object.entries(DECISION_LABELS).map(([k, v]) => [k, v.text])), a.decision)}{a.target ? ` (${a.target})` : ""} — לא נבחר: {a.rejectedBecause.map((r) => tr(REASONS, r)).join("; ")}</li>
              ))}
            </ul>
          </>
        )}
        {d.dependencies.length > 0 && <p className="text-muted">תלוי ב: {d.dependencies.map((x) => `${x.decisionId} (${x.relation === "same_cluster" ? "אותו אשכול" : x.relation === "subsumed_by" ? "נכלל ב" : x.relation})`).join(" · ")}</p>}
        {d.cluster && <p className="text-muted">אשכול: {d.cluster.clusterId}{d.cluster.parentPageUrl ? ` · דף השירות של האשכול: ${d.cluster.parentPageUrl}` : ""}</p>}
      </section>

      {d.businessValue && (
        <section className="detail-section">
          <h5 className="detail-heading">ערך עסקי</h5>
          <ul className="info-list">
            <li>ביקוש בשוק (Semrush): {d.businessValue.marketDemand.status === "available" ? `${d.businessValue.marketDemand.monthlyVolume} חיפושים בחודש` : "לא ידוע"}</li>
            <li>נראות שנמדדה (Search Console): {d.businessValue.observedVisibility.status === "unknown" ? "אין נתונים" : `${d.businessValue.observedVisibility.impressions} חשיפות`} — נראות של האתר, לא ביקוש בשוק</li>
          </ul>
        </section>
      )}

      <section className="detail-section">
        <h5 className="detail-heading">ראיות</h5>
        <ul className="info-list">
          {d.evidence.map((e) => (
            <li key={e.id}>{e.observation || e.id} <span className="text-dim">· {tr(BASIS, e.basis)} · {e.sourceRef.collection}/{e.sourceRef.docId}</span></li>
          ))}
        </ul>
      </section>

      <Disclosure label="פרטים טכניים" tone="technical">
        <ul className="tech-list">
          <li>id: {d.id} · scope: {d.scope} · decision: {d.decision} · engineState: {d.engineState}</li>
          <li>opportunities: {d.opportunityIds.join(", ") || "—"}</li>
          <li>reasonCodes: {d.reasonCodes.join(", ")} · missing: {d.missing.join(", ") || "—"}</li>
          <li>history: {d.decisionHistory.map((h) => `${h.decision}@${when(h.at)}${h.event ? ` (${h.event})` : ""}`).join(" → ")}</li>
          <li>model v{d.modelVersion} · config v{d.configVersion} · run {d.decisionRunId}</li>
        </ul>
      </Disclosure>
    </div>
  );
}

export default function BusinessDecisions() {
  const { business } = useOutletContext<BusinessContext>();
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [intents, setIntents] = useState<SearchIntent[]>([]);
  const [run, setRun] = useState<DecisionRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!business) return;
    const a = listenDecisions(business.id, setDecisions);
    const b = listenSearchIntents(business.id, setIntents);
    const c = listenLatestDecisionRun(business.id, setRun);
    return () => {
      a();
      b();
      c();
    };
  }, [business]);

  if (!business) return <div className="loading-row">טוען…</div>;

  async function doRun() {
    if (!business) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await runDecisionEngine(business.id);
      if (r.cacheHit) setNotice("לא השתנה דבר מאז הריצה הקודמת — ההחלטות נשארו כפי שהן.");
      else if (r.outcome === "WAIT_FOR_DATA") setNotice(r.reason === "approved topics changed since the last opportunity detection - run opportunity detection again" || (r.reason || "").includes("opportunity detection") ? "צריך קודם להריץ שוב ״זיהוי הזדמנויות״ (הנתונים השתנו מאז)." : "צריך קודם להריץ ניתוח במודיעין חיפוש וזיהוי הזדמנויות.");
      else setNotice(`ההחלטות עודכנו: ${r.summary.decisions} החלטות ל-${r.summary.intents} כוונות חיפוש.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "הריצה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  const intentsById = new Map(intents.map((i) => [i.intentId, i]));
  const active = (decisions || []).filter((d) => d.engineState === "active");
  const superseded = (decisions || []).filter((d) => d.engineState === "superseded");

  const row = (d: Decision) => {
    const open = openId === d.id;
    const lbl = DECISION_LABELS[d.decision];
    return (
      <Fragment key={d.id}>
        <tr className={open ? "row-open" : ""}>
          <td><StatusPill tone={lbl.tone}>{lbl.text}</StatusPill></td>
          <td className="text-muted">{tr(SCOPE, d.scope)}</td>
          <td>
            <strong dir="auto">{d.unitTitle}</strong>
            {d.decision === "CREATE" && <div className="text-dim">המערכת לא יוצרת דף, כתובת או תוכן</div>}
            {d.decision === "CONSOLIDATE" && <div className="text-dim">המלצה שלנו — לא החלטה של Google</div>}
          </td>
          <td className="text-muted">{tr(CONF, d.confidence)}</td>
          <td>
            <select className="select-quiet" value={d.ownerStatus} onChange={(e) => updateDecisionReview(d.id, { ownerStatus: e.target.value as DecisionOwnerStatus })} aria-label="הבדיקה שלך">
              {Object.entries(OWNER_STATUS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            {d.ownerStatusResetReason && <div className="text-dim">ההחלטה השתנתה מאז הבדיקה שלך</div>}
          </td>
          <td style={{ textAlign: "end" }}>
            <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpenId(open ? null : d.id)}>
              פירוט <span className="chev" aria-hidden="true">▾</span>
            </button>
          </td>
        </tr>
        {open && (
          <tr className="detail-row">
            <td colSpan={6}><Detail d={d} intent={d.intentId ? intentsById.get(d.intentId) : undefined} /></td>
          </tr>
        )}
      </Fragment>
    );
  };

  const table = (list: Decision[]) => (
    <div className="data-table-wrap table-sticky">
      <table className="data-table">
        <thead><tr><th>החלטה</th><th>רמה</th><th>על מה</th><th>ביטחון</th><th>הבדיקה שלך</th><th><span className="visually-hidden">פירוט</span></th></tr></thead>
        <tbody>{list.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <section className="section-block">
      <header className="page-head">
        <div>
          <h2 className="page-title">החלטות</h2>
          <div className="page-meta">
            {run ? `ריצה אחרונה: ${when(run.completedAtMs)}` : "עדיין לא הורצה קבלת החלטות"} · מבוסס על ההזדמנויות שזוהו, בלי פניות חיצוניות
            {run?.policy ? ` · עד ${run.policy.createBudgetPerRun} דפים חדשים לריצה, ${run.policy.createsPerClusterPerRun} לאשכול (מגבלת בטיחות זמנית)` : ""}
          </div>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={doRun}>{busy ? "מחשב…" : "קבלת החלטות"}</button>
      </header>
      {notice && <div className="notice-ok">{notice}</div>}
      {run?.outcome === "WAIT_FOR_DATA" && <div className="panel-meta" style={{ marginBottom: "var(--space-3)" }}>ממתין לנתונים: צריך להריץ ניתוח במודיעין חיפוש ואז ״זיהוי הזדמנויות״.</div>}

      {active.length > 0 && (
        <div className="panel-meta" style={{ marginBottom: "var(--space-3)" }}>
          {ORDER.map((k) => `${DECISION_LABELS[k].plural}: ${active.filter((d) => d.decision === k).length}`).join(" · ")}
        </div>
      )}

      {decisions === null && <div className="loading-row">טוען…</div>}
      {decisions && active.length === 0 && <EmptyState title="אין החלטות עדיין" subtitle="לוחצים על ״קבלת החלטות״ אחרי זיהוי הזדמנויות." />}

      {ORDER.map((k) => {
        const list = active.filter((d) => d.decision === k);
        if (!list.length) return null;
        return (
          <div key={k} style={{ marginBottom: "var(--space-5)" }}>
            <h3 className="section-title">{DECISION_LABELS[k].plural} ({list.length})</h3>
            {table(list)}
          </div>
        );
      })}

      {superseded.length > 0 && <Disclosure label={`החלטות שהוחלפו (${superseded.length})`}>{table(superseded)}</Disclosure>}
    </section>
  );
}
