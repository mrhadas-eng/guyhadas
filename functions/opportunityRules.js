// GuyHadas Visibility OS - M5 Opportunity Engine: detection + scoring
// (docs/M5_OPPORTUNITY_ENGINE_DESIGN.md §5–9).
//
// Pure and deterministic: no Firestore, no network, no provider. Input is
// what M3.2/M4 already stored; output is opportunity CANDIDATES with
// evidence, explained factors, priority band, confidence and candidate
// actions - never a decision (M6), never a prediction (M7).
//
// Basis vocabulary (MASTER §22): observed | inference | assumption |
// hypothesis. Unknown data is null, never 0, and never invented.

const crypto = require("crypto");
const { THRESHOLDS, EFFORT_BY_TYPE, CANDIDATE_ACTIONS, ENTITY_SIGNALS } = require("./opportunityConfig");

const APPROVED = ["relevant", "priority", "brand_strategic"];
const TOPIC_TYPES = new Set(["ranking_upside", "ctr_upside", "coverage_gap", "page_not_visible", "page_overlap_observed"]);
const PAGE_TYPES = new Set(["technical_blocker", "internal_linking"]);

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 20);
}

// Topic-level opportunities are keyed by topic (the target page may change
// as data changes - it is still the same opportunity); page-level ones by
// page (several topics can share one page problem); site-level by signal.
function dedupeKey(businessId, type, { topicIds = [], pageKeys = [], signalKey = "" }) {
  const part = TOPIC_TYPES.has(type) ? `t:${[...topicIds].sort().join(",")}` : PAGE_TYPES.has(type) ? `p:${[...pageKeys].sort().join(",")}` : `s:${signalKey}`;
  return sha(`${businessId}|${type}|${part}`);
}

function round(n, d = 1) {
  return n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d;
}

function terciles(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  return { low: v[Math.floor((v.length - 1) / 3)], high: v[Math.floor(((v.length - 1) * 2) / 3)] };
}

function tierLevel(value, t) {
  if (value == null) return null;
  if (value <= 0) return 0;
  if (!t) return 1;
  if (value >= t.high) return 3;
  if (value >= t.low) return 2;
  return 1;
}

function isHome(page) {
  if (!page) return false;
  if (page.role && page.role.role === "homepage") return true;
  try {
    return new URL(page.url).pathname === "/";
  } catch (err) {
    return false;
  }
}

function blockerOf(page) {
  if (!page) return null;
  if (page.indexability && page.indexability.state === "non_indexable") return { code: "non_indexable", detail: (page.indexability.reasons || []).join("; ") };
  if (page.robots && page.robots.state === "blocked") return { code: "blocked_by_robots", detail: page.robots.rule || null };
  if (page.canonical && page.canonical.state === "conflicting") return { code: "canonical_conflicting", detail: null };
  if (page.canonical && page.canonical.state === "points_elsewhere") return { code: "canonical_points_elsewhere", detail: page.canonical.target || null };
  return null;
}

const BLOCKER_TEXT = {
  non_indexable: "לפי הסריקה הדף לא יכול להיכלל בגוגל",
  blocked_by_robots: "הגדרות האתר חוסמות סריקה של הדף",
  canonical_conflicting: "בדף מוגדרות כמה כתובות ראשיות שונות",
  canonical_points_elsewhere: "הדף מפנה את Google לכתובת ראשית של דף אחר"
};

// ---------------------------------------------------------------------------

function buildContext({ business, run, topicIntel, searchTopics, seoPages, baseline }) {
  const statusById = new Map(searchTopics.map((t) => [t.id, t.status]));
  const approvedIntel = topicIntel.filter((ti) => !ti.superseded && APPROVED.includes(statusById.get(ti.topicId)));
  const pagesByKey = new Map(seoPages.map((p) => [p.pageKey, p]));
  const gscImpr = approvedIntel.map((ti) => (ti.gscCurrent && ti.gscCurrent.status === "available" ? ti.gscCurrent.impressions || 0 : ti.gscCurrent && ti.gscCurrent.status === "no_observation" ? 0 : null));
  const semVol = approvedIntel.map((ti) => (ti.semrush && ti.semrush.status === "available" ? ti.semrush.totalMonthlyVolume || 0 : null));
  // #64: relative visibility tiers need a minimum number of topics with
  // positive impressions; below it no tiers (and no tercile threshold).
  const visibilitySample = gscImpr.filter((x) => x != null && x > 0).length;
  const visibilityTiered = visibilitySample >= THRESHOLDS.minVisibilityTierSample;
  const imprT = visibilityTiered ? terciles(gscImpr.filter((x) => x != null)) : null;
  // #55: relative demand tiers need a minimum number of topics with positive
  // demand; below it no tiers are derived (values stay, tiers are withheld).
  const demandSample = semVol.filter((x) => x != null && x > 0).length;
  const demandTiered = demandSample >= THRESHOLDS.minDemandTierSample;
  const volT = demandTiered ? terciles(semVol.filter((x) => x != null)) : null;
  const minImpr = Math.max(THRESHOLDS.minImpressionsAbsolute, imprT ? imprT.low : 0);
  const sc = run && run.businessContext && run.businessContext.searchConsole;
  const siteCtr = sc && sc.status === "available" && sc.impressions > 0 ? sc.clicks / sc.impressions : null;
  return {
    business,
    run,
    baseline,
    statusById,
    approvedIntel,
    pagesByKey,
    imprT,
    visibilitySample,
    visibilityTiered,
    volT,
    demandSample,
    demandTiered,
    minImpr,
    siteCtr,
    gscPeriod: run && run.gsc ? run.gsc.period : null
  };
}

function relevanceOf(ti, ctx) {
  const status = ctx.statusById.get(ti.topicId);
  let level = status === "priority" || status === "brand_strategic" ? 3 : status === "relevant" ? 2 : 0;
  const linked = (ti.business && ti.business.linkedServices) || [];
  const confirmedLink = linked.find((s) => s.confirmed);
  if (confirmedLink) level = Math.min(3, level + 1);
  return {
    level,
    basis: "observed",
    explanation: `סטטוס שקבעת: ${status}${confirmedLink ? ` · קשור לשירות מאושר „${confirmedLink.name}“` : ""}`
  };
}

function commercialOf(ti) {
  const intent = ti.business && ti.business.preliminaryIntent;
  const commercialModifier = ti.business && ti.business.commercialSignal && ti.business.commercialSignal.present;
  if (intent === "commercial" || intent === "local" || commercialModifier) return { level: 3, basis: "inference", explanation: "כוונת חיפוש מסחרית/מקומית (הסקה לפי מילות השאילתה)" };
  if (intent === "navigational") return { level: 2, basis: "inference", explanation: "חיפוש מותג (הסקה)" };
  if (intent === "informational") return { level: 1, basis: "inference", explanation: "חיפוש מידע (הסקה)" };
  return { level: null, basis: "unknown", explanation: "כוונת החיפוש לא סווגה" };
}

// MARKET DEMAND: external demand only (Semrush today). Search Console
// impressions are NOT market demand - a topic can have zero impressions for
// this site and large demand in the market. Unknown when unavailable.
function marketDemandOf(ti, ctx) {
  const sem = ti.semrush && ti.semrush.status === "available" ? ti.semrush.totalMonthlyVolume : null;
  if (sem == null) return { level: null, basis: "unknown", source: null, tierStatus: "unknown", explanation: "ביקוש בשוק לא ידוע — אין נתוני Semrush (נתוני Search Console משקפים נראות של האתר, לא ביקוש בשוק)" };
  // #55: a positive value with too few comparable topics is kept but not
  // tiered - "insufficient evidence to tier" is neither low nor high demand.
  // (A reported 0 stays level 0 as before: it is not a relative judgement.)
  if (sem > 0 && !ctx.demandTiered) {
    return {
      level: null,
      basis: "insufficient_sample",
      source: "semrush",
      tierStatus: "insufficient_sample",
      explanation: `${sem} חיפושים בחודש לפי Semrush (סכום השאילתות) — לא דורג: יש נתוני ביקוש רק ל-${ctx.demandSample} נושאים מאושרים, ונדרשים לפחות ${THRESHOLDS.minDemandTierSample} כדי להשוות ביניהם`
    };
  }
  return { level: tierLevel(sem, ctx.volT), basis: "observed", source: "semrush", tierStatus: "tiered", explanation: `${sem} חיפושים בחודש לפי Semrush (סכום השאילתות; ביחס לשאר הנושאים שלך)` };
}

// OBSERVED VISIBILITY: what Search Console measured for this business in the
// analysis period - actual current visibility, not the market.
function visibilityOf(ti, ctx) {
  const g = ti.gscCurrent || {};
  const period = g.period ? ` (${g.period.startDate} – ${g.period.endDate})` : "";
  // #64: positive impressions with too few comparable topics are kept as an
  // observation but not tiered. Zero impressions stay an observed level 0.
  if (g.status === "available" && (g.impressions || 0) > 0 && !ctx.visibilityTiered) {
    return {
      level: null,
      basis: "insufficient_sample",
      source: "search_console",
      tierStatus: "insufficient_sample",
      explanation: `${g.impressions} חשיפות ב-Search Console${period} — לא דורג: רק ל-${ctx.visibilitySample} נושאים מאושרים יש חשיפות, ונדרשים לפחות ${THRESHOLDS.minVisibilityTierSample} כדי להשוות ביניהם`
    };
  }
  if (g.status === "available") return { level: tierLevel(g.impressions || 0, ctx.imprT), basis: "observed", source: "search_console", tierStatus: "tiered", explanation: `${g.impressions || 0} חשיפות ב-Search Console${period}, ביחס לשאר הנושאים שלך` };
  if (g.status === "no_observation") return { level: 0, basis: "observed", source: "search_console", explanation: `לא נרשמו חשיפות ב-Search Console לשאילתות הנושא${period}` };
  return { level: null, basis: "unknown", source: null, explanation: "אין נתוני Search Console עדכניים" };
}

const FACTOR_NAMES = { businessRelevance: "חשיבות לעסק", commercialValue: "ערך מסחרי", marketDemand: "ביקוש בשוק", observedVisibility: "נראות שנמדדה", upside: "פוטנציאל", effortInverse: "קלות ביצוע" };
// Opportunity kinds whose case rests on demand rather than on visibility we
// already observed: with unknown market demand they are at most medium.
const DEMAND_DEPENDENT = new Set(["coverage_gap", "page_not_visible"]);

function factor(key, f, weight) {
  return { key, level: f.level, weight, contribution: f.level == null ? null : f.level * weight, basis: f.basis, explanation: f.explanation };
}

function score(factors) {
  const known = factors.filter((f) => f.level != null);
  const max = known.reduce((s, f) => s + 3 * f.weight, 0);
  if (!max) return 0;
  return Math.round((known.reduce((s, f) => s + f.contribution, 0) / max) * 100);
}

// Guards keep "high" meaningful: a blocker on a topic page is never low;
// an overlap observation is monitor-only; site-level clarity items and
// anything we are not confident about are at most medium.
function band(type, s, confidence = "high") {
  let p = s >= THRESHOLDS.highBand ? "high" : s >= THRESHOLDS.mediumBand ? "medium" : "low";
  if (type === "technical_blocker" && p === "low") p = "medium";
  if ((type === "entity_clarity" || confidence === "low") && p === "high") p = "medium";
  if (type === "page_overlap_observed") p = "low";
  return p;
}

function confidenceOf({ gscAvailable, unknownFactors, untieredFactors = [], inferredTarget, uncrawledTarget, hasBaseline, assumptionBenefit }) {
  let level = 3;
  const reasons = [];
  if (gscAvailable === false) {
    level--;
    reasons.push("אין נתוני Search Console עדכניים לנושא");
  }
  // An untiered factor is withheld from the score exactly like an unknown one
  // (one confidence step for both together), but is explained differently.
  if (unknownFactors.length || untieredFactors.length) level--;
  if (unknownFactors.length) reasons.push(`לא ידוע: ${unknownFactors.map((k) => FACTOR_NAMES[k] || k).join(", ")}`);
  if (untieredFactors.length) reasons.push(`יש נתון אך אין מספיק נושאים להשוואה: ${untieredFactors.map((k) => FACTOR_NAMES[k] || k).join(", ")}`);
  if (inferredTarget) {
    level--;
    reasons.push("הדף המשויך נמצא לפי תוכן (הסקה), לא לפי נתוני Search Console");
  }
  if (uncrawledTarget) {
    level--;
    reasons.push("הדף לא נבדק בסריקה האחרונה");
  }
  if (!hasBaseline) {
    level--;
    reasons.push("אין בייסליין להשוואה עתידית");
  }
  if (assumptionBenefit && level > 2) {
    level = 2;
    reasons.push("התועלת מבוססת על הנחה, לא על מדידה");
  }
  return { confidence: level >= 3 ? "high" : level === 2 ? "medium" : "low", confidenceReasons: reasons };
}

function evidence(id, sourceType, sourceRef, observation, basis, capturedAtMs) {
  return { id, sourceType, sourceRef, observation, basis, capturedAtMs: capturedAtMs || null };
}

function topicEvidence(ti, ctx) {
  const out = [
    evidence(`searchTopics/${ti.topicId}#status`, "owner_decision", { collection: "searchTopics", docId: ti.topicId, field: "status" }, `סטטוס הנושא: ${ctx.statusById.get(ti.topicId)}`, "observed", null)
  ];
  const g = ti.gscCurrent || {};
  if (g.status === "available") {
    out.push(evidence(`topicIntelligence/${ti.id}#gscCurrent`, "search_console", { collection: "topicIntelligence", docId: ti.id, field: "gscCurrent" }, `${g.impressions} חשיפות, ${g.clicks} קליקים, מיקום ממוצע ${round(g.avgPosition)}, CTR ${round((g.ctr || 0) * 100)}% (${g.period ? `${g.period.startDate} – ${g.period.endDate}` : ""})`, "observed", ti.computedAtMs));
  } else {
    out.push(evidence(`topicIntelligence/${ti.id}#gscCurrent`, "search_console", { collection: "topicIntelligence", docId: ti.id, field: "gscCurrent" }, g.status === "no_observation" ? `לא נרשמו חשיפות ב-Search Console לשאילתות הנושא${g.period ? ` בתקופה ${g.period.startDate} – ${g.period.endDate}` : " בתקופה שנבדקה"}` : `אין נתוני Search Console: ${g.reason || "לא זמין"}`, "observed", ti.computedAtMs));
  }
  const linked = ((ti.business && ti.business.linkedServices) || []).filter((s) => s.confirmed);
  if (linked.length) out.push(evidence(`topicIntelligence/${ti.id}#business.linkedServices`, "service_map", { collection: "topicIntelligence", docId: ti.id, field: "business.linkedServices" }, `קשור לשירות: ${linked.map((s) => s.name).join(", ")}`, linked.some((s) => s.basis === "observed") ? "observed" : "inference", ti.computedAtMs));
  if (ti.semrush && ti.semrush.status === "available") out.push(evidence(`topicIntelligence/${ti.id}#semrush`, "semrush", { collection: "topicIntelligence", docId: ti.id, field: "semrush" }, `${ti.semrush.totalMonthlyVolume} חיפושים בחודש (סכום השאילתות)`, "observed", ti.computedAtMs));
  return out;
}

function pageEvidence(page, field = "indexability") {
  return evidence(`seoPages/${page.id}#${field}`, "crawl", { collection: "seoPages", docId: page.id, field }, null, "observed", page.lastCrawledAtMs);
}

function baselineEvidence(ctx) {
  if (!ctx.baseline) return [];
  return [evidence(`baselines/${ctx.baseline.id}`, "baseline", { collection: "baselines", docId: ctx.baseline.id, field: null }, `בייסליין גרסה ${ctx.baseline.version}`, "observed", ctx.baseline.capturedAtMs)];
}

// Search Console observation for the topic in the period. "no_observation"
// is a real observation (zero impressions for this site) - not unknown, and
// not market demand.
function metricsOf(ti) {
  const g = ti.gscCurrent || {};
  if (g.status === "available") return { impressions: g.impressions, clicks: g.clicks, ctr: g.ctr, position: g.avgPosition };
  if (g.status === "no_observation") return { impressions: 0, clicks: 0, ctr: null, position: null };
  return null;
}

// ---------------------------------------------------------------------------

function detect(input, weights) {
  const ctx = buildContext(input);
  const businessId = input.business.id;
  const out = [];
  const evaluations = [];
  const pageOpps = new Map(); // dedupe page-level across topics

  const hasBaseline = !!ctx.baseline;
  const baseFields = (type) => ({ type, candidateActions: CANDIDATE_ACTIONS[type], estimatedEffort: { level: EFFORT_BY_TYPE[type], basis: "assumption" } });

  function finish(o) {
    const s = score(o.factors);
    const untiered = o.factors.filter((f) => f.level == null && f.basis === "insufficient_sample").map((f) => f.key);
    const unknown = o.factors.filter((f) => f.level == null && !f.notApplicable && f.basis !== "insufficient_sample").map((f) => f.key);
    const conf = confidenceOf({ ...o.conf, unknownFactors: unknown, untieredFactors: untiered, hasBaseline });
    let priority = band(o.type, s, conf.confidence);
    // Unknown OR untiered (#55) market demand must not inflate an opportunity
    // whose case rests on demand (it is excluded from the score, so cap the
    // band instead).
    const md = o.factors.find((f) => f.key === "marketDemand");
    if (DEMAND_DEPENDENT.has(o.type) && md && md.level == null && priority === "high") priority = "medium";
    const valueFactors = o.factors.filter((f) => ["businessRelevance", "marketDemand", "observedVisibility", "upside"].includes(f.key) && f.level != null);
    const valueLevel = valueFactors.length ? Math.round(valueFactors.reduce((a, f) => a + f.level, 0) / valueFactors.length) : null;
    const missing = [...new Set([...(o.missing || []), ...unknown.map((k) => `factor_unknown:${k}`), ...untiered.map((k) => `factor_untiered_insufficient_sample:${k}`), ...(hasBaseline ? [] : ["no_baseline"])])];
    delete o.conf;
    return {
      ...o,
      dedupeKey: dedupeKey(businessId, o.type, o.keyParts),
      score: s,
      priority,
      ...conf,
      estimatedValue: { level: valueLevel, basis: "inference", note: "סדר גודל יחסי מתוך הגורמים, לא תחזית" },
      missing
    };
  }

  const effortFactor = (type) => factor("effortInverse", { level: EFFORT_BY_TYPE[type], basis: "assumption", explanation: "הערכת מאמץ לפי סוג ההזדמנות (הנחה)" }, weights.effortInverse);

  for (const ti of [...ctx.approvedIntel].sort((a, b) => String(a.topicId).localeCompare(String(b.topicId)))) {
    const g = ti.gscCurrent || {};
    const gscKnown = g.status === "available" || g.status === "no_observation";
    const observed = (ti.pages && ti.pages.observed) || [];
    const matched = (ti.pages && ti.pages.contentMatched) || [];
    const rel = relevanceOf(ti, ctx);
    const com = commercialOf(ti);
    const dem = marketDemandOf(ti, ctx);
    const vis = visibilityOf(ti, ctx);
    const common = [factor("businessRelevance", rel, weights.businessRelevance), factor("commercialValue", com, weights.commercialValue), factor("marketDemand", dem, weights.marketDemand)];
    const visFactor = factor("observedVisibility", vis, weights.observedVisibility);
    // For gap kinds the absence of visibility is the reason the opportunity
    // exists - it is not scored as low value, and never as low demand.
    const visNotApplicable = { ...factor("observedVisibility", { level: null, basis: "observed", explanation: `${vis.explanation} — זו הסיבה להזדמנות, לא ראיה לביקוש נמוך` }, weights.observedVisibility), notApplicable: true };
    const tEvidence = topicEvidence(ti, ctx);
    const found = [];
    const topicBase = (type, extra) => ({
      ...baseFields(type),
      targetTopicIds: [ti.topicId],
      targetQueryFamilyIds: [ti.topicId],
      targetEntityIds: [],
      topic: ti.title,
      keyParts: { topicIds: [ti.topicId] },
      ...extra
    });
    const mainPage = observed[0] || null;
    const impressions = g.status === "available" ? g.impressions || 0 : 0;
    const enoughImpr = impressions >= ctx.minImpr;
    const pos = g.status === "available" ? g.avgPosition : null;

    // ranking_upside
    if (mainPage && enoughImpr && pos != null && pos >= THRESHOLDS.upsidePositionMin && pos <= THRESHOLDS.upsidePositionMax) {
      const strong = pos <= THRESHOLDS.upsideStrongMax;
      const crawled = ctx.pagesByKey.get(mainPage.pageKey);
      found.push(
        topicBase("ranking_upside", {
          title: `שיפור מיקום: „${ti.title}“`,
          description: `לפי Search Console, הנושא קיבל ${impressions} חשיפות במיקום ממוצע ${round(pos)} בתקופה שנבדקה. דף קיים קרוב לראש התוצאות, ולכן שיפור שלו עשוי להביא יותר קליקים.`,
          targetPageKeys: [mainPage.pageKey],
          relatedPage: mainPage.url,
          factors: [...common, visFactor, factor("upside", { level: strong ? 3 : 2, basis: "assumption", explanation: `מיקום ממוצע ${round(pos)} — ${strong ? "בעמוד הראשון אבל לא בראשו" : "קרוב לעמוד הראשון"} (הנחה: דפים בטווח הזה מגיבים לשיפור)` }, weights.upside), effortFactor("ranking_upside")],
          evidence: [...tEvidence, evidence(`topicIntelligence/${ti.id}#gscCurrent.pages`, "search_console", { collection: "topicIntelligence", docId: ti.id, field: "gscCurrent.pages" }, `דף מוביל לנושא: ${mainPage.url} · ${mainPage.impressions} חשיפות · מיקום ${round(mainPage.position)}`, "observed", ti.computedAtMs), ...baselineEvidence(ctx)],
          conf: { gscAvailable: true, inferredTarget: false, uncrawledTarget: !crawled || crawled.crawlStatus !== "fetched" },
          impactInputs: { targetType: "topic", targetId: ti.topicId, pageKey: mainPage.pageKey, baselineId: ctx.baseline ? ctx.baseline.id : null, current: metricsOf(ti), period: g.period || null }
        })
      );
    }

    // ctr_upside
    if (mainPage && enoughImpr && pos != null && pos <= THRESHOLDS.ctrPositionMax && ctx.siteCtr != null && (g.ctr || 0) < ctx.siteCtr * THRESHOLDS.ctrShareOfSite) {
      const crawled = ctx.pagesByKey.get(mainPage.pageKey);
      found.push(
        topicBase("ctr_upside", {
          title: `יותר קליקים מאותן הופעות: „${ti.title}“`,
          description: `לפי Search Console הנושא מופיע בעמוד הראשון (מיקום ממוצע ${round(pos)}), אבל רק ${round((g.ctr || 0) * 100)}% מהרואים לוחצים — לעומת ${round(ctx.siteCtr * 100)}% באתר כולו. כדאי לבדוק את הכותרת והתיאור שמופיעים בתוצאות.`,
          targetPageKeys: [mainPage.pageKey],
          relatedPage: mainPage.url,
          factors: [...common, visFactor, factor("upside", { level: 3, basis: "observed", explanation: `CTR ${round((g.ctr || 0) * 100)}% מול ${round(ctx.siteCtr * 100)}% באתר (נמדד)` }, weights.upside), effortFactor("ctr_upside")],
          evidence: [...tEvidence, evidence(`intelligenceRuns/${ctx.run.id}#businessContext.searchConsole`, "search_console", { collection: "intelligenceRuns", docId: ctx.run.id, field: "businessContext.searchConsole" }, `CTR של האתר כולו: ${round(ctx.siteCtr * 100)}%`, "observed", ctx.run.completedAtMs), ...baselineEvidence(ctx)],
          conf: { gscAvailable: true, inferredTarget: false, uncrawledTarget: !crawled || crawled.crawlStatus !== "fetched" },
          impactInputs: { targetType: "topic", targetId: ti.topicId, pageKey: mainPage.pageKey, baselineId: ctx.baseline ? ctx.baseline.id : null, current: metricsOf(ti), period: g.period || null }
        })
      );
    }

    // page_overlap_observed
    if (observed.length > 1) {
      const total = observed.reduce((a, p) => a + (p.impressions || 0), 0);
      const second = observed[1];
      if ((second.impressions || 0) >= Math.max(5, total * 0.1)) {
        found.push(
          topicBase("page_overlap_observed", {
            title: `כמה דפים קיבלו חשיפות לאותו נושא: „${ti.title}“`,
            description: `לפי Search Console, ${observed.length} דפים שונים קיבלו חשיפות לשאילתות של הנושא בתקופה שנבדקה. זו תצפית למעקב — ההחלטה אם לאחד או להשאיר תתקבל בשלב ההחלטות.`,
            targetPageKeys: observed.map((p) => p.pageKey),
            relatedPage: observed[0].url,
            factors: [...common, visFactor, factor("upside", { level: 1, basis: "hypothesis", explanation: "ייתכן שהדפים מתחרים זה בזה — השערה שתיבדק בשלב ההחלטות" }, weights.upside), effortFactor("page_overlap_observed")],
            evidence: [...tEvidence, evidence(`topicIntelligence/${ti.id}#gscCurrent.pages`, "search_console", { collection: "topicIntelligence", docId: ti.id, field: "gscCurrent.pages" }, observed.map((p) => `${p.url} (${p.impressions})`).join(" · "), "observed", ti.computedAtMs)],
            conf: { gscAvailable: true, inferredTarget: false, uncrawledTarget: false },
            impactInputs: { targetType: "topic", targetId: ti.topicId, baselineId: ctx.baseline ? ctx.baseline.id : null, current: metricsOf(ti), period: g.period || null }
          })
        );
      }
    }

    // coverage_gap / page_not_visible (need GSC known to claim "no page appears")
    if (gscKnown && observed.length === 0) {
      if (matched.length === 0) {
        found.push(
          topicBase("coverage_gap", {
            title: `לא נמצא דף לנושא: „${ti.title}“`,
            description: `אישרת את הנושא, אבל לא זוהתה כרגע נראות ב-Search Console לנושא בתקופה שנבדקה, וגם לא נמצא בסריקה דף שעוסק בו. זה לא אומר שאין ביקוש לנושא. בשלב ההחלטות ייקבע אם להרחיב דף קיים או ליצור דף חדש.`,
            targetPageKeys: [],
            relatedPage: null,
            factors: [...common, visNotApplicable, factor("upside", { level: 2, basis: "inference", explanation: "נושא מאושר בלי דף שנמצא בסריקה ובלי נראות שנמדדה (הסקה)" }, weights.upside), effortFactor("coverage_gap")],
            evidence: [...tEvidence, evidence(`topicIntelligence/${ti.id}#pages`, "crawl", { collection: "topicIntelligence", docId: ti.id, field: "pages" }, "לא נמדדה ב-Search Console נראות לשאילתות הנושא בתקופה, ולא נמצא בסריקה דף שכותרת הנושא מופיעה בו", "inference", ti.computedAtMs)],
            conf: { gscAvailable: true, inferredTarget: false, uncrawledTarget: false },
            impactInputs: { targetType: "topic", targetId: ti.topicId, baselineId: ctx.baseline ? ctx.baseline.id : null, current: metricsOf(ti), period: g.period || null }
          })
        );
      } else {
        const p0 = matched[0];
        const crawled = ctx.pagesByKey.get(p0.pageKey);
        found.push(
          topicBase("page_not_visible", {
            title: `יש דף לנושא, אבל כרגע אין לו נראות ב-Search Console: „${ti.title}“`,
            description: `נמצא באתר דף שעוסק בנושא (${p0.url}), אבל בתקופה שנבדקה${g.period ? ` (${g.period.startDate} – ${g.period.endDate})` : ""} לא נרשמו ב-Search Console חשיפות לשאילתות של הנושא. זה לא אומר שהדף לא מופיע בגוגל בכלל — רק שלא נמדדה לו נראות לשאילתות האלה בתקופה הזו. ייתכן שהדף לא עונה על מה שמחפשים, או שעדיין מוקדם.`,
            targetPageKeys: matched.map((p) => p.pageKey),
            relatedPage: p0.url,
            factors: [...common, visNotApplicable, factor("upside", { level: 2, basis: "inference", explanation: "דף קיים בלי נראות שנמדדה ב-Search Console לנושא" }, weights.upside), effortFactor("page_not_visible")],
            evidence: [...tEvidence, evidence(`topicIntelligence/${ti.id}#pages.contentMatched`, "crawl", { collection: "topicIntelligence", docId: ti.id, field: "pages.contentMatched" }, `דף קשור לפי התוכן: ${matched.map((p) => p.url).join(" · ")}`, "inference", ti.computedAtMs)],
            conf: { gscAvailable: true, inferredTarget: true, uncrawledTarget: !crawled || crawled.crawlStatus !== "fetched" },
            impactInputs: { targetType: "topic", targetId: ti.topicId, pageKey: p0.pageKey, baselineId: ctx.baseline ? ctx.baseline.id : null, current: metricsOf(ti), period: g.period || null }
          })
        );
      }
    }

    // page-level: technical blockers and internal linking on pages serving this topic
    const associated = [...observed.map((p) => ({ ...p, basis: "observed" })), ...matched.filter((m) => !observed.some((o) => o.pageKey === m.pageKey)).map((p) => ({ ...p, basis: "inference" }))];
    for (const ap of associated) {
      const page = ctx.pagesByKey.get(ap.pageKey);
      if (!page || page.crawlStatus !== "fetched") continue;
      const blk = blockerOf(page);
      if (blk) addPageOpp("technical_blocker", page, ti, ap, { blk, rel, com, dem, vis });
      if (!isHome(page) && page.links && page.links.inboundInternalCount === 0) addPageOpp("internal_linking", page, ti, ap, { rel, com, dem, vis });
    }

    if (found.length) {
      out.push(...found.map(finish));
      evaluations.push({ topicId: ti.topicId, title: ti.title, outcome: "opportunities", types: found.map((f) => f.type) });
    } else if (!gscKnown && observed.length === 0 && matched.length === 0) {
      evaluations.push({ topicId: ti.topicId, title: ti.title, outcome: "WAIT_FOR_DATA", reasons: [`אין נתוני Search Console לנושא (${g.reason || "לא זמין"}) ולא נמצא דף קשור`] });
    } else {
      const reasons = [];
      if (pos != null) reasons.push(`מיקום ממוצע ${round(pos)}${pos < THRESHOLDS.upsidePositionMin ? " — כבר בראש התוצאות" : pos > THRESHOLDS.upsidePositionMax ? " — רחוק מהעמוד הראשון" : ""}`);
      if (g.status === "available" && !enoughImpr) reasons.push(`${impressions} חשיפות — מתחת לסף (${ctx.minImpr}) שממנו המערכת מסיקה מסקנות`);
      if (!gscKnown) reasons.push("אין נתוני Search Console עדכניים");
      if (observed.length) reasons.push("יש דף עם נראות שנמדדה ב-Search Console לנושא, ולא נמצאה בו בעיה טכנית");
      evaluations.push({ topicId: ti.topicId, title: ti.title, outcome: "NO_ACTION", reasons });
    }
  }

  function addPageOpp(type, page, ti, ap, { blk, rel, com, dem, vis }) {
    const key = `${type}|${page.pageKey}`;
    const existing = pageOpps.get(key);
    if (existing) {
      if (!existing.targetTopicIds.includes(ti.topicId)) {
        existing.targetTopicIds.push(ti.topicId);
        existing.targetQueryFamilyIds.push(ti.topicId);
        existing._topics.push({ ti, ap, rel, com, dem, vis });
      }
      return;
    }
    pageOpps.set(key, {
      ...baseFields(type),
      targetTopicIds: [ti.topicId],
      targetQueryFamilyIds: [ti.topicId],
      targetPageKeys: [page.pageKey],
      targetEntityIds: [],
      relatedPage: page.url,
      keyParts: { pageKeys: [page.pageKey] },
      _page: page,
      _blk: blk || null,
      _topics: [{ ti, ap, rel, com, dem, vis }]
    });
  }

  // Finalize page-level opportunities: best (highest) topic factors win.
  for (const o of [...pageOpps.values()].sort((a, b) => a.relatedPage.localeCompare(b.relatedPage))) {
    const page = o._page;
    const best = (k) => o._topics.map((t) => t[k]).reduce((a, b) => ((b.level ?? -1) > (a.level ?? -1) ? b : a));
    const anyObserved = o._topics.some((t) => t.ap.basis === "observed");
    const topicsTitle = o._topics.map((t) => `„${t.ti.title}“`).join(", ");
    // Visibility counts as value only where this page was actually observed
    // for a topic; for a content-matched page it is not applicable.
    const pageVis = anyObserved
      ? factor("observedVisibility", o._topics.filter((t) => t.ap.basis === "observed").map((t) => t.vis).reduce((a, b) => ((b.level ?? -1) > (a.level ?? -1) ? b : a)), weights.observedVisibility)
      : { ...factor("observedVisibility", { level: null, basis: "observed", explanation: "לדף לא נמדדה נראות ב-Search Console לנושאים האלה — לא נספר כערך נמוך" }, weights.observedVisibility), notApplicable: true };
    const tEvidence = o._topics.flatMap((t) => topicEvidence(t.ti, ctx)).filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i);
    let rec;
    if (o.type === "technical_blocker") {
      rec = {
        title: `בעיה טכנית בדף שמשרת נושא מאושר: ${page.title || page.url}`,
        description: `${BLOCKER_TEXT[o._blk.code]}. הדף משרת את ${topicsTitle}. כדאי לוודא שזה לא מכוון.`,
        factors: [factor("businessRelevance", best("rel"), weights.businessRelevance), factor("commercialValue", best("com"), weights.commercialValue), factor("marketDemand", best("dem"), weights.marketDemand), pageVis, factor("upside", { level: anyObserved ? 3 : 2, basis: "observed", explanation: `${BLOCKER_TEXT[o._blk.code]}${anyObserved ? " — והדף כבר קיבל חשיפות ב-Search Console לנושא" : ""}` }, weights.upside), effortFactor("technical_blocker")],
        evidence: [...tEvidence, { ...pageEvidence(page, o._blk.code.startsWith("canonical") ? "canonical" : o._blk.code === "blocked_by_robots" ? "robots" : "indexability"), observation: `${BLOCKER_TEXT[o._blk.code]}${o._blk.detail ? ` (${o._blk.detail})` : ""}` }, ...baselineEvidence(ctx)],
        conf: { gscAvailable: o._topics.some((t) => (t.ti.gscCurrent || {}).status === "available"), inferredTarget: !anyObserved, uncrawledTarget: false },
        signalExtra: { technical: { level: 3, code: o._blk.code } }
      };
    } else {
      rec = {
        title: `אין קישורים פנימיים לדף שמשרת נושא מאושר: ${page.title || page.url}`,
        description: `אף דף אחר מבין הדפים שנבדקו לא מקשר לדף הזה, והוא משרת את ${topicsTitle}. קישורים מדפים קשורים עוזרים לגולשים ולמנועי חיפוש להגיע אליו.`,
        factors: [factor("businessRelevance", best("rel"), weights.businessRelevance), factor("commercialValue", best("com"), weights.commercialValue), factor("marketDemand", best("dem"), weights.marketDemand), pageVis, factor("upside", { level: 2, basis: "assumption", explanation: "קישורים פנימיים מדפים קשורים עוזרים לגילוי ולהבנה של הדף (הנחה)" }, weights.upside), effortFactor("internal_linking")],
        evidence: [...tEvidence, { ...pageEvidence(page, "links"), observation: `0 קישורים נכנסים מבין ${page.links && page.links.scope ? page.links.scope.replace(/^counted among /, "").replace(/ crawled pages$/, "") : ""} הדפים שנבדקו` }, ...baselineEvidence(ctx)],
        conf: { gscAvailable: o._topics.some((t) => (t.ti.gscCurrent || {}).status === "available"), inferredTarget: !anyObserved, uncrawledTarget: false },
        signalExtra: { technical: { level: 1, code: "no_inbound_internal_links" } }
      };
    }
    const tmain = o._topics[0].ti;
    const opp = {
      type: o.type,
      candidateActions: o.candidateActions,
      estimatedEffort: o.estimatedEffort,
      targetTopicIds: o.targetTopicIds,
      targetQueryFamilyIds: o.targetQueryFamilyIds,
      targetPageKeys: o.targetPageKeys,
      targetEntityIds: [],
      relatedPage: o.relatedPage,
      topic: o._topics.map((t) => t.ti.title).join(", "),
      keyParts: o.keyParts,
      title: rec.title,
      description: rec.description,
      factors: rec.factors,
      evidence: rec.evidence,
      conf: rec.conf,
      signalExtra: rec.signalExtra,
      impactInputs: { targetType: "page", targetId: page.pageKey, baselineId: ctx.baseline ? ctx.baseline.id : null, current: metricsOf(tmain), period: (tmain.gscCurrent || {}).period || null }
    };
    out.push(finish(opp));
    for (const t of o._topics) {
      const ev = evaluations.find((e) => e.topicId === t.ti.topicId);
      if (ev && ev.outcome !== "opportunities") {
        ev.outcome = "opportunities";
        ev.types = [o.type];
        delete ev.reasons;
      } else if (ev && !ev.types.includes(o.type)) ev.types.push(o.type);
    }
  }

  // Site-level entity clarity from GEO readiness (website signals only).
  const signals = (ctx.run && ctx.run.geoReadiness && ctx.run.geoReadiness.signals) || [];
  for (const s of signals.filter((x) => ENTITY_SIGNALS.includes(x.key) && (x.status === "missing" || x.status === "partial")).sort((a, b) => a.key.localeCompare(b.key))) {
    const conflict = s.key === "fact_consistency" && s.status === "partial";
    const upLevel = conflict ? 3 : s.status === "missing" ? 2 : 1;
    const ENTITY_TITLES = {
      business_identity: "זהות העסק לא ברורה מספיק באתר",
      services_explicit: "חלק מהשירותים לא מוצגים בבירור באתר",
      locations_explicit: "אזורי השירות לא מוצגים בבירור באתר",
      contact_details: "פרטי הקשר לא מלאים באתר",
      fact_consistency: "פרטי העסק לא אחידים בין דפי האתר"
    };
    out.push(
      finish({
        ...baseFields("entity_clarity"),
        targetTopicIds: [],
        targetQueryFamilyIds: [],
        targetPageKeys: [],
        targetEntityIds: [],
        relatedPage: s.evidencePages && s.evidencePages[0] ? s.evidencePages[0] : null,
        topic: null,
        keyParts: { signalKey: s.key },
        title: ENTITY_TITLES[s.key],
        description: `${s.observation}. פרטים מפורשים ועקביים עוזרים ללקוחות ולמנועי חיפוש (כולל מערכות AI) להבין את העסק. Google מציין שאין דרישות מיוחדות להופעה בתשובות AI מעבר לבסיס הרגיל — זו לא „אופטימיזציה ל-AI“.`,
        factors: [
          factor("businessRelevance", { level: 2, basis: "assumption", explanation: "נוגע לכל האתר" }, weights.businessRelevance),
          { ...factor("commercialValue", { level: null, basis: "not_applicable", explanation: "לא רלוונטי ברמת האתר" }, weights.commercialValue), notApplicable: true },
          { ...factor("marketDemand", { level: null, basis: "not_applicable", explanation: "לא רלוונטי ברמת האתר" }, weights.marketDemand), notApplicable: true },
          { ...factor("observedVisibility", { level: null, basis: "not_applicable", explanation: "לא רלוונטי ברמת האתר" }, weights.observedVisibility), notApplicable: true },
          factor("upside", { level: upLevel, basis: conflict ? "observed" : "assumption", explanation: conflict ? "נמצאו פרטים סותרים באתר (נמדד)" : "בהירות פרטי העסק עוזרת להבנה (הנחה)" }, weights.upside),
          effortFactor("entity_clarity")
        ],
        evidence: [evidence(`intelligenceRuns/${ctx.run.id}#geoReadiness.${s.key}`, "geo_readiness", { collection: "intelligenceRuns", docId: ctx.run.id, field: `geoReadiness.signals.${s.key}` }, `${s.observation}${s.evidencePages && s.evidencePages.length ? ` · ${s.evidencePages.slice(0, 3).join(" · ")}` : ""}`, "observed", ctx.run.completedAtMs), ...baselineEvidence(ctx)],
        conf: { gscAvailable: null, inferredTarget: false, uncrawledTarget: false, assumptionBenefit: !conflict },
        signalExtra: { geo: { level: upLevel, signal: s.key, status: s.status } },
        impactInputs: { targetType: "business", targetId: businessId, baselineId: ctx.baseline ? ctx.baseline.id : null, current: null, period: null }
      })
    );
  }

  // Signals summary on each opportunity (for M6 consumption).
  for (const o of out) {
    const f = Object.fromEntries(o.factors.map((x) => [x.key, x]));
    const sig = (k) => (f[k] ? { level: f[k].level, basis: f[k].basis } : null);
    o.signals = {
      businessRelevance: sig("businessRelevance"),
      commercialValue: sig("commercialValue"),
      // External market demand (unknown without a demand provider) and
      // Search Console visibility are separate signals - never merged.
      marketDemand: f.marketDemand
        ? {
            level: f.marketDemand.level,
            basis: f.marketDemand.basis,
            source: f.marketDemand.level != null || f.marketDemand.basis === "insufficient_sample" ? "semrush" : null,
            tierStatus: f.marketDemand.basis === "insufficient_sample" ? "insufficient_sample" : f.marketDemand.basis === "not_applicable" ? "not_applicable" : f.marketDemand.level == null ? "unknown" : "tiered"
          }
        : null,
      visibility:
        o.impactInputs && o.impactInputs.current
          ? {
              ...o.impactInputs.current,
              level: f.observedVisibility ? f.observedVisibility.level : null,
              basis: "observed",
              source: "search_console",
              tierStatus: !f.observedVisibility ? null : f.observedVisibility.basis === "insufficient_sample" ? "insufficient_sample" : f.observedVisibility.notApplicable ? "not_applicable" : f.observedVisibility.level == null ? "unknown" : "tiered"
            }
          : null,
      technical: (o.signalExtra && o.signalExtra.technical) || null,
      content: o.type === "coverage_gap" || o.type === "page_not_visible" ? { level: 2, basis: "inference" } : null,
      entity: null,
      geo: (o.signalExtra && o.signalExtra.geo) || null
    };
    delete o.signalExtra;
    delete o.keyParts;
  }

  out.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]) || b.score - a.score || a.dedupeKey.localeCompare(b.dedupeKey));
  return { opportunities: out, topicEvaluations: evaluations, context: { minImpressions: ctx.minImpr, siteCtr: ctx.siteCtr, approvedTopicsAnalyzed: ctx.approvedIntel.length } };
}

// buildContext / visibilityOf exported for tests only.
module.exports = { detect, dedupeKey, score, band, confidenceOf, APPROVED, buildContext, visibilityOf };
