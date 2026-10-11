// M7 plain-Hebrew labels + pure display helpers (no network, no writes).
import type { ImpactPrediction, PredictionStage, SeoExperiment } from "../../../types";

export const ELEMENTS: Record<string, string> = {
  title: "כותרת הדף (title)",
  meta_description: "תיאור לתוצאות החיפוש",
  h1: "כותרת ראשית (H1)",
  headings: "כותרות משנה",
  body_content: "תוכן הדף",
  internal_links_added: "קישורים פנימיים לדף",
  redirect: "הפניה (redirect)",
  canonical_tag: "תגית כתובת ראשית (canonical)",
  noindex_removed: "הסרת noindex",
  robots_rule: "כלל robots",
  structured_data: "מידע מובנה",
  business_facts: "פרטי העסק",
  new_page_published: "פרסום דף חדש",
  content_merged: "איחוד תוכן",
  other: "אחר"
};
export const CHANGE_CLASS: Record<string, string> = {
  technical_eligibility: "תיקון טכני",
  snippet: "כותרת ותיאור",
  internal_linking: "קישורים פנימיים",
  content: "תוכן",
  intent_correction: "התאמה לכוונת החיפוש",
  consolidation: "איחוד דפים",
  new_page: "דף חדש",
  entity_facts: "פרטי העסק"
};
export const IMPL_STATUS: Record<string, string> = {
  recorded: "נרשם (דיווח שלך)",
  verified: "השינוי נראה בסריקה",
  not_observed: "השינוי עוד לא נראה בסריקה",
  not_verifiable: "לא ניתן לאמת בסריקה",
  contradicted: "הסריקה מראה אחרת",
  reverted: "בוטל"
};
export const CHECK_RESULT: Record<string, string> = { confirmed: "נראה", not_observed: "לא נראה עדיין", not_verifiable: "לא נבדק בסריקה", contradicted: "סותר" };
export const STATES: Record<string, string> = {
  PENDING_PUBLICATION: "ממתין לפרסום",
  TOO_EARLY: "מוקדם מדי למדידה",
  PENDING_MEASUREMENT: "ממתין למדידה (שלב M8)",
  CHANGE_IN_OBSERVATION_WINDOW: "שינוי נוסף בתוך חלון המעקב",
  INCONCLUSIVE: "לא ניתן להסיק (נסגר)"
};
export const WARNINGS: Record<string, string> = {
  approaching_window_end: "חלון המעקב מתקרב לסיומו",
  window_ended_awaiting_measurement: "חלון המעקב הסתיים — ממתין למדידה",
  unverified_implementation: "השינוי לא נראה בשתי סריקות אחרי הפרסום",
  missing_baseline: "אין תמונת מצב נקייה מלפני השינוי",
  prediction_blocked_by_eligibility: "הדף לא כשיר — אין טווחים בתחזית"
};
export const BEFORE: Record<string, string> = { linked: "קיימת (מלפני השינוי)", missing: "חסרה", contaminated: "יש רק נתונים מאחרי השינוי" };
export const DERIVATION: Record<string, string> = { provisional: "זמנית (לפני ביצוע)", ex_ante: "נקבעה לפני הביצוע", re_derived: "חושבה מחדש מנתונים שלפני השינוי", retroactive: "בדיעבד — רק מנתונים שלפני השינוי", experiment: "מאוחדת לניסוי" };
export const BAND: Record<string, string> = { none: "ללא שינוי צפוי", small: "קטן", moderate: "בינוני", large: "גדול", unknown: "לא ידוע" };
export const DIRECTION: Record<string, string> = { increase: "עלייה", none: "ללא", hold: "שמירה", unknown: "לא ידוע", temporary_volatility_then_increase: "תנודה זמנית ואז עלייה" };
export const CONF: Record<string, string> = { high: "גבוה", medium: "בינוני", low: "נמוך" };
export const OVERLAP: Record<string, string> = {
  implemented_decision: "זו ההחלטה שבוצעה",
  same_page_same_intent: "אותו דף ואותה כוונת חיפוש",
  same_page_different_intent: "אותו דף, כוונה אחרת",
  different_page_same_intent: "דף אחר, אותה כוונת חיפוש",
  site_same_signal: "שינוי באתר כולו באותו נושא",
  site_wide_change: "שינוי באתר כולו"
};
export const tr = (map: Record<string, string>, k: string | null | undefined) => (k ? map[k] || k : "—");

export function stageText(s: PredictionStage | undefined): string {
  if (!s) return "—";
  if (s.status === "range") return `${s.minWeeks}–${s.maxWeeks} שבועות (${s.minDays}–${s.maxDays} ימים)`;
  if (s.status === "not_applicable") return "לא רלוונטי לשינוי הזה";
  if (s.status === "blocked_by_eligibility") return "אין טווח — קודם צריך לתקן את החסימה בדף";
  return "לא ידוע";
}

export function impactText(i: ImpactPrediction["predictedVisibilityImpact"]): string {
  if (!i) return "—";
  if (i.band === "unknown" && i.direction === "unknown") return "לא ידוע";
  return `${tr(DIRECTION, i.direction)} · ${tr(BAND, i.band)}`;
}

export const day = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString("he-IL") : "—");

// Current time phase for display only (the stored state changes on runs).
export function phaseNow(x: SeoExperiment, nowMs: number): string {
  if (x.status === "closed") return "INCONCLUSIVE";
  if (x.lateChangeEventIds.length) return "CHANGE_IN_OBSERVATION_WINDOW";
  if (x.startMs > nowMs) return "PENDING_PUBLICATION";
  if (x.stageWindows.A && nowMs < x.stageWindows.A.fromMs) return "TOO_EARLY";
  return "PENDING_MEASUREMENT";
}

export function holdActiveNow(x: SeoExperiment, nowMs: number): boolean {
  return x.status === "open" && x.liveChangeEventIds.length > 0 && !(x.ownerHoldRelease && x.ownerHoldRelease.released) && x.hold.holdUntilMs != null && nowMs < x.hold.holdUntilMs;
}
