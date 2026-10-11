import type { ImpactPrediction } from "../../../types";
import { Disclosure } from "../../../components/ui/Disclosure";
import { CHANGE_CLASS, CONF, DERIVATION, impactText, stageText, tr } from "./m7Labels";

// M7 prediction display: three separate ranges, ordinal impact, confidence
// with reasons, unknown factors. Display only - no call, no write.
export function PredictionPanel({ p }: { p: ImpactPrediction }) {
  return (
    <section className="detail-section">
      <h5 className="detail-heading">
        תחזית {p.status === "committed" ? "(קבועה — נקבעה ברישום הביצוע)" : p.status === "provisional" ? "(זמנית — אם תבצע את ההמלצה)" : `(${p.status})`}
      </h5>
      <div className="notice-ok">תחזית לא מבטיחה תוצאה. הטווחים הם הנחות עבודה פנימיות שלנו (לא לוח זמנים של Google), נמדדים מיום פרסום השינוי, ויכוילו בעתיד לפי תוצאות.</div>
      {p.predictionState === "blocked_by_eligibility" && <p><strong>אין טווחים:</strong> {p.eligibility?.note || "הדף לא כשיר — קודם צריך לתקן את החסימה."}</p>}
      <div className="detail-grid" style={{ marginTop: "var(--space-3)" }}>
        <div>
          <div className="detail-label">סימן ראשון שאפשר לראות</div>
          <div>{stageText(p.stages.A)}</div>
        </div>
        <div>
          <div className="detail-label">סימן SEO משמעותי</div>
          <div>{stageText(p.stages.B)}</div>
        </div>
        <div>
          <div className="detail-label">השפעה עסקית משמעותית</div>
          <div>{stageText(p.stages.C)}</div>
        </div>
        <div>
          <div className="detail-label">ביטחון</div>
          <div>{tr(CONF, p.confidence)} (מקסימום "בינוני" עד שנכייל לפי תוצאות)</div>
        </div>
      </div>
      <ul className="info-list" style={{ marginTop: "var(--space-3)" }}>
        <li>סוג השינוי: {tr(CHANGE_CLASS, p.changeType)}{p.changeClasses.length > 1 ? ` (${p.changeClasses.map((c) => tr(CHANGE_CLASS, c)).join(", ")})` : ""}</li>
        <li>נראות בחיפוש: {impactText(p.predictedVisibilityImpact)} · מיקום: {impactText(p.predictedRankingImpact)} · תנועה: {impactText(p.predictedTrafficImpact)} <span className="text-dim">(הערכה איכותית, לא מספר)</span></li>
        <li>השפעה עסקית: {p.businessImpact?.measurable ? "ניתן למדוד ברמת האתר בלבד" : "אין כרגע נתונים למדידה"}</li>
        <li>אופן החישוב: {tr(DERIVATION, p.derivation)}{p.retroactive ? " — הביטחון הופחת" : ""}</li>
      </ul>
      <div className="detail-label">למה רמת הביטחון הזו</div>
      <ul className="info-list">{p.confidenceReasons.map((r, i) => <li key={i} dir="auto">{r}</li>)}</ul>
      {p.unknownFactors && p.unknownFactors.length > 0 && (
        <Disclosure label={`גורמים לא ידועים (${p.unknownFactors.length}) — לא נספרים כאפס`}>
          <ul className="info-list">{p.unknownFactors.map((u) => <li key={u.key} dir="auto">{u.label} — {u.reason}</li>)}</ul>
        </Disclosure>
      )}
      {p.predictionFactors && (
        <Disclosure label="גורמי התחזית" tone="technical">
          <ul className="tech-list">{p.predictionFactors.map((f, i) => <li key={i} dir="auto">{f.key}: {String(f.value ?? "unknown")} · {f.basis} · {f.effect}{f.note ? ` · ${f.note}` : ""}</li>)}</ul>
          <p className="panel-meta">id {p.id} · model v{p.predictionModelVersion} · config v{p.predictionConfigVersion}</p>
        </Disclosure>
      )}
    </section>
  );
}
