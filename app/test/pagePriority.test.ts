// Presentation priority for the SEO technical table (issue #23 follow-up):
// "no inbound internal link" alone must not make a page look like it needs
// review; red stays reserved for indexing/canonical blockers.
import assert from "node:assert";
import { pagePriority, needsReview, needsAttention, internalLinks, IMPORTANT, REVIEW, INFO_ONLY, ISSUE_COPY, INFO_COPY } from "../src/lib/plainLanguage.ts";

const page = (codes: string[], inbound = 1) =>
  ({ diagnostics: codes.map((code) => ({ code, detail: null, basis: "observed" })), links: { inboundInternalCount: inbound } }) as never;

assert.strictEqual(pagePriority(page(["no_inbound_from_crawled_pages"], 0)), "ok", "no inbound links alone -> not yellow");
assert.strictEqual(needsReview(page(["no_inbound_from_crawled_pages"], 0)), false);
assert.strictEqual(needsAttention(page(["no_inbound_from_crawled_pages"], 0)), true, "underlying needsAttention() unchanged");
assert.strictEqual(internalLinks(page([], 0)).tone, "neutral", "'אין קישורים' is information, not a warning");
assert.strictEqual(pagePriority(page(["not_in_sitemap", "structured_data_missing", "title_duplicate"])), "ok", "housekeeping stays green");
for (const c of ["title_missing", "h1_missing", "structured_data_invalid"]) assert.strictEqual(pagePriority(page([c, "no_inbound_from_crawled_pages"], 0)), "check", c);
for (const c of ["non_indexable", "blocked_by_robots", "canonical_conflicting", "canonical_points_elsewhere"]) assert.strictEqual(pagePriority(page([c])), "important", c);
assert.strictEqual(pagePriority(page(["non_indexable", "title_missing"])), "important", "red wins over yellow");
// Every finding that drives red/yellow has an owner-facing explanation, and
// every information-only finding has a plain sentence.
for (const c of [...IMPORTANT, ...REVIEW]) assert.ok(ISSUE_COPY[c] && ISSUE_COPY[c].label && ISSUE_COPY[c].found && ISSUE_COPY[c].why, `issue copy for ${c}`);
for (const c of INFO_ONLY) assert.ok(INFO_COPY[c], `info copy for ${c}`);
console.log("All page-priority checks passed (no-inbound-link is information only; every finding has plain copy).");
