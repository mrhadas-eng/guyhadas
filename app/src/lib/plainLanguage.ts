// Plain-language Hebrew for the business owner (issue #23). The primary UI
// speaks in these words; internal codes/enums stay in the data and appear
// only under "פרטים טכניים". Presentation only - no logic here decides
// anything about the data.

import type { StatusTone } from "../components/ui/StatusPill";
import type { GeoSignal, SeoPage, TopicIntelligence } from "../types";

// ---- page technical states -----------------------------------------------

export function indexState(s: string): { tone: StatusTone; text: string } {
  if (s === "indexable") return { tone: "good", text: "כן" };
  if (s === "non_indexable") return { tone: "bad", text: "לא" };
  return { tone: "neutral", text: "לא ידוע" };
}

export function canonicalState(s: string): { tone: StatusTone; text: string } {
  if (s === "valid") return { tone: "good", text: "תקינה" };
  if (s === "missing") return { tone: "warn", text: "לא מוגדרת" };
  if (s === "points_elsewhere") return { tone: "warn", text: "מפנה לדף אחר" };
  if (s === "conflicting") return { tone: "bad", text: "סותרת" };
  return { tone: "neutral", text: "לא ידוע" };
}

export function presenceState(s: string): { tone: StatusTone; text: string } {
  if (s === "present") return { tone: "good", text: "כן" };
  if (s === "absent" || s === "missing") return { tone: "warn", text: "לא" };
  if (s === "invalid") return { tone: "bad", text: "לא תקין" };
  return { tone: "neutral", text: "לא ידוע" };
}

// Structured data is helpful but optional; "missing" is informational.
export function structuredState(s: string): { tone: StatusTone; text: string } {
  if (s === "present") return { tone: "good", text: "כן" };
  if (s === "missing") return { tone: "neutral", text: "לא" };
  if (s === "invalid") return { tone: "bad", text: "פגום" };
  return { tone: "neutral", text: "לא ידוע" };
}

// "דף אחד" / "3 דפים"
export function pagesCount(n: number): string {
  return n === 1 ? "דף אחד" : `${n} דפים`;
}

export const ROLE_LABELS: Record<string, string> = {
  homepage: "דף הבית",
  contact: "יצירת קשר",
  about: "אודות",
  article: "מאמר",
  service: "שירות",
  project: "פרויקט",
  other: "אחר"
};

// One plain sentence per technical finding, for the row details.
export const FINDING_TEXT: Record<string, string> = {
  non_indexable: "יש בדף מניעה טכנית (למשל הוראה בדף שמבקשת ממנועי חיפוש לא לכלול אותו, או הפניה לכתובת ראשית של דף אחר) שבגללה הוא לא יכול להיכלל בגוגל",
  canonical_missing: "לא מוגדרת לדף כתובת ראשית",
  canonical_conflicting: "הוגדרו לדף כמה כתובות ראשיות שונות",
  canonical_points_elsewhere: "הדף מפנה את Google לכתובת ראשית של דף אחר",
  blocked_by_robots: "הגדרות האתר חוסמות את Google מלסרוק את הדף",
  not_in_sitemap: "הדף לא מופיע במפת האתר",
  structured_data_missing: "אין בדף מידע מובנה שעוזר למנועי חיפוש להבין אותו",
  structured_data_invalid: "המידע המובנה בדף פגום",
  title_missing: "לדף אין כותרת",
  title_duplicate: "לדף יש אותה כותרת כמו לדפים אחרים",
  meta_description_missing: "לדף אין תיאור לתוצאות החיפוש",
  meta_description_duplicate: "התיאור של הדף זהה לדפים אחרים",
  h1_missing: "לדף אין כותרת ראשית בתוכן",
  h1_multiple: "לדף יש יותר מכותרת ראשית אחת",
  no_inbound_from_crawled_pages: "אף דף אחר שנבדק לא מקשר לדף הזה",
  underlinked_candidate: "רק דף אחד מקשר לדף הזה"
};

// Findings serious enough to count a page as "needs attention" on the
// summary. Housekeeping items (description, sitemap, duplicates, structured
// data) are shown in details but don't raise the flag.
const ATTENTION = new Set(["non_indexable", "canonical_conflicting", "canonical_points_elsewhere", "blocked_by_robots", "title_missing", "h1_missing", "structured_data_invalid", "no_inbound_from_crawled_pages"]);

export function needsAttention(p: SeoPage): boolean {
  return p.diagnostics.some((d) => ATTENTION.has(d.code));
}

// Presentation-only priority for the Technical SEO list (issue #23
// follow-up). It splits the SAME needsAttention() set into two visual
// levels so not every flagged page looks broken; the diagnostics and the
// needsAttention calculation are unchanged.
//   important - can stop the page from being included / points Google elsewhere
//   check     - a review-worthy quality issue (missing title/H1, broken
//               structured data)
//   ok        - nothing that needs the owner's attention. Observations such
//               as "no internal link from the crawled pages" stay visible in
//               the row details but never raise the level on their own: a
//               page without inbound links is not automatically a problem.
export const IMPORTANT = new Set(["non_indexable", "blocked_by_robots", "canonical_conflicting", "canonical_points_elsewhere"]);
export const REVIEW = new Set(["title_missing", "h1_missing", "structured_data_invalid"]);
// Diagnostics shown in details as information only (no priority effect).
export const INFO_ONLY = new Set(["no_inbound_from_crawled_pages", "underlinked_candidate", "not_in_sitemap", "structured_data_missing", "meta_description_missing", "meta_description_duplicate", "title_duplicate", "h1_multiple"]);

export type PagePriority = "important" | "check" | "ok";

export function pagePriority(p: SeoPage): PagePriority {
  if (p.diagnostics.some((d) => IMPORTANT.has(d.code))) return "important";
  if (p.diagnostics.some((d) => REVIEW.has(d.code))) return "check";
  return "ok";
}

// Pages the owner should look at (red or yellow) - what the summary counts.
export function needsReview(p: SeoPage): boolean {
  return pagePriority(p) !== "ok";
}

export const PRIORITY_DISPLAY: Record<PagePriority, { tone: StatusTone; text: string; help: string }> = {
  important: { tone: "bad", text: "בעיה חשובה", help: "משהו בדף עלול למנוע ממנו להיכלל בגוגל או מפנה את Google לכתובת אחרת." },
  check: { tone: "warn", text: "נקודה לבדיקה", help: "לא תקלה דחופה - פרט שכדאי לבדוק, כמו כותרת חסרה או מידע מובנה פגום." },
  ok: { tone: "good", text: "נראה תקין", help: "לא נמצא בדף משהו שדורש טיפול. הערות קטנות, אם יש, מופיעות בפירוט." }
};

export function internalLinks(p: SeoPage): { tone: StatusTone; text: string } {
  // Information only - never a warning colour (no inbound link ≠ a problem).
  return p.links.inboundInternalCount > 0 ? { tone: "good", text: "יש" } : { tone: "neutral", text: "אין קישורים" };
}

export function pageLabel(p: SeoPage): { primary: string; path: string } {
  let path = p.url;
  try {
    path = decodeURI(new URL(p.url).pathname) || "/";
  } catch {
    path = p.url;
  }
  return { primary: p.title || path, path };
}

// ---- GEO readiness ---------------------------------------------------------

export const GEO_STATUS: Record<GeoSignal["status"], { tone: StatusTone; text: string }> = {
  present: { tone: "good", text: "תקין" },
  partial: { tone: "warn", text: "חלקי" },
  missing: { tone: "bad", text: "חסר" },
  unknown: { tone: "neutral", text: "לא ידוע" }
};

export const GEO_COPY: Record<string, { title: string; why: string; status: Record<GeoSignal["status"], string> }> = {
  business_identity: {
    title: "שם העסק וזהותו ברורים",
    why: "כך מנועי חיפוש ומערכות AI משייכים את האתר לעסק הנכון.",
    status: {
      present: "שם העסק מופיע באתר ומוגדר גם בצורה שמנועי חיפוש קוראים.",
      partial: "שם העסק מופיע, אבל לא בכל הצורות שמנועי חיפוש מחפשים.",
      missing: "לא נמצא באתר זיהוי ברור של העסק.",
      unknown: "לא ניתן היה לבדוק."
    }
  },
  services_explicit: {
    title: "השירותים מוצגים בבירור",
    why: "שירות שלא כתוב במפורש קשה למצוא ולהבין.",
    status: {
      present: "כל השירותים שאישרת מופיעים בכותרות של דפים באתר.",
      partial: "חלק מהשירותים שאישרת לא מופיעים בכותרת של אף דף.",
      missing: "השירותים שאישרת לא נמצאו בדפים שנבדקו.",
      unknown: "אין עדיין שירותים מאושרים לבדיקה."
    }
  },
  locations_explicit: {
    title: "אזורי השירות מוצגים בבירור",
    why: "חיפושים רבים כוללים מקום, ולכן חשוב שהאזורים יופיעו באתר.",
    status: {
      present: "כל אזורי השירות שהגדרת מופיעים באתר.",
      partial: "חלק מאזורי השירות שהגדרת לא מופיעים באתר.",
      missing: "אזורי השירות שהגדרת לא נמצאו באתר.",
      unknown: "לא הוגדרו אזורי שירות בפרופיל העסק."
    }
  },
  contact_details: {
    title: "טלפון ואימייל מופיעים בצורה ברורה",
    why: "פרטי קשר גלויים מחזקים אמינות ומאפשרים ללקוחות לפנות.",
    status: {
      present: "גם טלפון וגם אימייל מופיעים באתר.",
      partial: "נמצא רק אחד מהשניים - טלפון או אימייל.",
      missing: "לא נמצאו טלפון או אימייל בדפים שנבדקו.",
      unknown: "לא ניתן היה לבדוק."
    }
  },
  structured_data_coverage: {
    title: "מידע שעוזר למנועי חיפוש להבין את העסק",
    why: "מידע מובנה מתאר את העסק בשפה שמנועי חיפוש ומערכות AI קוראים ישירות.",
    status: {
      present: "לכל הדפים שנבדקו יש מידע מובנה.",
      partial: "רק לחלק מהדפים יש מידע מובנה.",
      missing: "לאף דף שנבדק אין מידע מובנה.",
      unknown: "לא ניתן היה לבדוק."
    }
  },
  fact_consistency: {
    title: "פרטי העסק אחידים בכל האתר",
    why: "פרטים סותרים (למשל כמה מספרי טלפון) מבלבלים לקוחות ומנועי חיפוש.",
    status: {
      present: "אותם פרטי קשר מופיעים בכל הדפים.",
      partial: "באתר מופיעים פרטי קשר שונים בדפים שונים.",
      missing: "לא נמצאו פרטים להשוואה.",
      unknown: "לא נמצאו פרטים להשוואה."
    }
  },
  audience_positioning: {
    title: "למי העסק פונה ובמה הוא מתמחה",
    why: "התמחות וקהל מוגדרים עוזרים להופיע בחיפושים הנכונים.",
    status: {
      present: "האתר מציין בבירור קהל יעד או התמחות.",
      partial: "יש התייחסות חלקית לקהל או להתמחות.",
      missing: "לא נמצא באתר תיאור ברור של הקהל או ההתמחות.",
      unknown: "לא ניתן היה לבדוק."
    }
  }
};

// ---- topics ----------------------------------------------------------------

export function topicVisibility(t: TopicIntelligence): { tone: StatusTone; text: string } {
  const g = t.gscCurrent;
  if (g.status === "available" && (g.impressions || 0) > 0) return { tone: "good", text: "מופיע בגוגל" };
  if (g.status === "available" || g.status === "no_observation") return { tone: "warn", text: "לא מופיע בגוגל" };
  return { tone: "neutral", text: "אין נתונים" };
}

export function topicPage(t: TopicIntelligence): { tone: StatusTone; text: string } {
  if (t.pages.observed.length) return { tone: "good", text: t.pages.observed.length > 1 ? `${t.pages.observed.length} דפים מופיעים` : "דף מופיע" };
  if (t.pages.contentMatched.length) return { tone: "warn", text: "דף קשור (לפי התוכן)" };
  return { tone: "bad", text: "אין דף" };
}

export const MISSING_TEXT: Record<string, string> = {
  gsc_current_not_available: "אין נתוני גוגל עדכניים",
  no_gsc_observation_for_topic: "השאילתות של הנושא לא הופיעו בגוגל בתקופה",
  semrush_demand_not_available: "אין נתוני ביקוש מהשוק",
  no_associated_page: "לא נמצא דף שמתאים לנושא",
  associated_page_not_in_crawl: "דף שמופיע בגוגל לא נבדק בסריקה",
  serp_context_not_available: "אין מידע על המתחרים בתוצאות החיפוש"
};

// ---- provider decisions (technical details only) ---------------------------

export const DECISION_TEXT: Record<string, string> = {
  cache_hit: "נעשה שימוש בתוצאה שמורה (ללא פנייה חדשה)",
  cache_miss: "בוצעה פנייה חדשה",
  forced_refresh: "בוצעה פנייה חדשה באישורך",
  blocked_cache_unavailable: "נחסם: בדיקת המטמון נכשלה - לא בוצעה פנייה",
  blocked_safety_check_unavailable: "נחסם: בדיקת בטיחות נכשלה - לא בוצעה פנייה",
  blocked_by_quota: "נחסם: הגעת למכסת הפניות",
  blocked_by_budget: "נחסם: מעבר לתקציב",
  blocked_by_safety_limit: "נחסם: מפסק הגנה פתוח"
};

export const fmt = (n: number | null | undefined, d = 0) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("he-IL", { maximumFractionDigits: d }));
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);
export const when = (ms?: number | null) => (ms ? new Date(ms).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "—");

// ---- row-detail explanations (presentation only) ---------------------------
// What the owner reads when opening a red/yellow row: a short label, what we
// found, and why it matters. Keys are the existing diagnostic codes; which
// codes drive red/yellow is decided by IMPORTANT / REVIEW above (unchanged).
export const ISSUE_COPY: Record<string, { label: string; found: string; why: string }> = {
  non_indexable: {
    label: "הכללה בגוגל",
    found: "משהו בדף מבקש ממנועי חיפוש לא לכלול אותו, או שהדף לא נטען כרגיל.",
    why: "כל עוד זה כך, הדף כנראה לא יופיע בתוצאות החיפוש."
  },
  blocked_by_robots: {
    label: "חסימה לסריקה",
    found: "הגדרות האתר חוסמות ממנועי חיפוש לסרוק את הדף.",
    why: "דף שמנועי חיפוש לא יכולים לסרוק כמעט לא יופיע בתוצאות."
  },
  canonical_conflicting: {
    label: "כתובת ראשית",
    found: "הדף מצהיר על כמה כתובות ראשיות שונות.",
    why: "Google עלול להתבלבל איזו כתובת להציג, ולפצל ביניהן את החשיפה."
  },
  canonical_points_elsewhere: {
    label: "כתובת ראשית",
    found: "הדף מפנה את Google לכתובת של דף אחר כ״כתובת הראשית״ שלו.",
    why: "Google יציג כנראה את הדף האחר במקום הדף הזה."
  },
  title_missing: {
    label: "כותרת הדף",
    found: "לדף אין כותרת (הטקסט שמופיע בלשונית הדפדפן ובתוצאות החיפוש).",
    why: "בלי כותרת, Google ממציא כותרת בעצמו, ופחות אנשים לוחצים על התוצאה."
  },
  h1_missing: {
    label: "כותרת ראשית",
    found: "חסרה בדף כותרת ראשית ברורה בראש התוכן.",
    why: "כותרת ראשית עוזרת לגולשים ולמנועי חיפוש להבין במה הדף עוסק."
  },
  structured_data_invalid: {
    label: "מידע למנועי חיפוש",
    found: "המידע המובנה בדף פגום ולא ניתן לקריאה.",
    why: "מנועי חיפוש מתעלמים ממידע פגום, ולכן הוא לא עוזר להבין את העסק."
  }
};

export const INFO_COPY: Record<string, string> = {
  no_inbound_from_crawled_pages: "אין דפים אחרים באתר (מבין שנבדקו) שמקשרים לדף הזה.",
  underlinked_candidate: "רק דף אחד באתר מקשר לדף הזה.",
  not_in_sitemap: "הדף לא מופיע ברשימת הדפים שהאתר מגיש למנועי חיפוש (מפת האתר).",
  structured_data_missing: "אין בדף מידע מובנה שעוזר למנועי חיפוש להבין אותו.",
  meta_description_missing: "אין לדף תיאור קצר לתוצאות החיפוש.",
  meta_description_duplicate: "התיאור לתוצאות החיפוש זהה לזה של דפים אחרים.",
  title_duplicate: "לדף יש אותה כותרת כמו לדפים אחרים באתר.",
  h1_multiple: "בדף יש יותר מכותרת ראשית אחת."
};
