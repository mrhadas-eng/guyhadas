// GuyHadas Visibility OS - M6 Decision Engine configuration
// (docs/M6_DECISION_ENGINE_DESIGN.md §D–§G, §K). Plain values, no logic
// beyond policy resolution.
//
// EVERY threshold below is an INTERNAL HEURISTIC of this engine - an
// ASSUMPTION, versioned so M9 can calibrate it against measured outcomes.
// None of them is a value defined or published by Google: Google publishes
// no ownership, cannibalization or duplicate thresholds, and these numbers
// carry no claim about how Google evaluates pages.
//
// Bump DECISION_CONFIG_VERSION whenever a value here changes: it is part of
// the analysis cache identity and is stored on every decision.

const DECISION_ENGINE_VERSION = 1;
const DECISION_CONFIG_VERSION = 1;

const HEURISTICS = Object.freeze({
  // §D.4 intent grouping (G4): equivalent topics merge when, among other
  // conditions, their titles are similar or their observed queries overlap.
  grouping: Object.freeze({ titleJaccard: 0.5, sharedQueryShare: 0.5 }),
  // §E.3 ownership from observed Search Console impression shares.
  ownership: Object.freeze({ establishedShare: 0.6, contestedShare: 0.25 }),
  // §F.1 / §F.2 cannibalization states.
  collision: Object.freeze({
    duplicateTitle: 0.8,
    duplicateQueryOverlap: 0.6,
    highShare: 0.25,
    highQueryOverlap: 0.5,
    highTitle: 0.5,
    potentialShare: 0.1,
    potentialQueryOverlap: 0.3,
    proposedTitle: 0.5,
    maxPagesCompared: 6
  })
});

// G5 / G11 - TEMPORARY SAFETY ASSUMPTIONS, not architecture. The system
// values are both the default and the ceiling in M6: project or business
// policy may only LOWER them (0 allowed = CREATE disabled), never raise
// them. M9 calibrates them.
const SAFETY_CEILINGS = Object.freeze({ createBudgetPerRun: 3, createsPerClusterPerRun: 1 });

// Project-level policy (applies to every business). null = use the system
// value. Kept in code (versioned, reviewed) rather than in Firestore.
const PROJECT_POLICY = Object.freeze({ createBudgetPerRun: null, createsPerClusterPerRun: null });

const HISTORY_CAP = 20;

// §D.2 intent-type modifiers (matched as whole phrases on normalized text).
// Rows of the approved table, in the approved order.
const INTENT_MODIFIERS = Object.freeze({
  pricing: ["מחיר", "מחירים", "עלות", "עלויות", "כמה עולה", "כמה עולים", "price", "prices", "cost", "costs"],
  comparison: ["השוואה", "לעומת", "vs", "או", "versus", "compare"],
  review: ["המלצות", "ביקורות", "חוות דעת", "reviews", "review"],
  how_to: ["איך", "how to", "מדריך", "שלבים", "guide"],
  definition: ["מה זה", "מהו", "מהי", "what is", "what are"]
});

// Additional types requested for M6 (MASTER §17 taxonomy). They never
// override a row of the approved table: they become the primary type only
// for topics the approved rows leave `unclassified`, and are otherwise
// recorded as secondary types (docs/M6_IMPLEMENTATION_NOTES.md).
const EXTENDED_MODIFIERS = Object.freeze({
  transactional: ["להזמין", "הזמנה", "לקנות", "רכישה", "book", "buy", "order"],
  availability: ["זמין", "זמינות", "פנוי", "available", "availability", "open now"],
  problem_discovery: ["בעיה", "בעיות", "תקלה", "problem", "problems", "issue"],
  solution_discovery: ["פתרון", "פתרונות", "solution", "solutions"],
  media: ["וידאו", "סרטון", "סרטונים", "תמונות", "video", "videos", "photos", "images"],
  research: ["מחקר", "נתונים", "סטטיסטיקה", "research", "statistics", "data"]
});

// Task families (§D.5, §E.4): what the user wants to do.
const TASK_BY_TYPE = Object.freeze({
  navigational: "find_business",
  pricing: "check_price",
  comparison: "compare",
  review: "evaluate",
  how_to: "learn",
  definition: "learn",
  informational: "learn",
  problem_discovery: "learn",
  solution_discovery: "learn",
  media: "learn",
  research: "learn",
  local: "hire",
  commercial_investigation: "hire",
  transactional: "hire",
  availability: "hire",
  location: "find_place",
  unclassified: null
});

// "Learn-type" intents for G7 and the information-requirement dimension.
const LEARN_TYPES = Object.freeze(["how_to", "definition", "informational", "problem_discovery", "solution_discovery", "media", "research"]);

// §E.4: task pairs one page can serve together (not materially different).
const SAME_PAGE_TASKS = Object.freeze([["hire", "check_price"], ["hire", "find_business"], ["hire", "evaluate"]]);

function clampPolicyValue(v, ceiling) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(Math.floor(v), ceiling));
}

// Effective policy = min(system ceiling, project policy, business policy).
// Values above the ceiling are ignored (clamped to it); negatives become 0.
function resolvePolicy(businessPolicy) {
  const out = {};
  const sources = {};
  for (const key of Object.keys(SAFETY_CEILINGS)) {
    const ceiling = SAFETY_CEILINGS[key];
    const project = clampPolicyValue(PROJECT_POLICY[key], ceiling);
    const business = businessPolicy && typeof businessPolicy === "object" ? clampPolicyValue(businessPolicy[key], ceiling) : null;
    let value = ceiling;
    let source = "system_default";
    if (project != null && project < value) {
      value = project;
      source = "project_policy";
    }
    if (business != null && business < value) {
      value = business;
      source = "business_policy";
    }
    out[key] = value;
    sources[key] = source;
  }
  return { ...out, sources, ceilings: { ...SAFETY_CEILINGS }, basis: "assumption", note: "temporary safety assumption; calibrated in M9" };
}

module.exports = {
  DECISION_ENGINE_VERSION,
  DECISION_CONFIG_VERSION,
  HEURISTICS,
  SAFETY_CEILINGS,
  PROJECT_POLICY,
  HISTORY_CAP,
  INTENT_MODIFIERS,
  EXTENDED_MODIFIERS,
  TASK_BY_TYPE,
  LEARN_TYPES,
  SAME_PAGE_TASKS,
  resolvePolicy
};
