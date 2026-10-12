// M7 Firestore security rules - static structure checks (docs/M7_DESIGN.md
// §12). The repo has no rules emulator in its test path (see backlog), so this
// asserts the exact rule shapes that keep engine fields server-only.
// Run: node functions/test/m7Security.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rules = fs.readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8");
const block = (name) => {
  const i = rules.indexOf(`match /${name}/`);
  assert.ok(i >= 0, `rules for ${name} exist`);
  const open = rules.indexOf("} {", i) + 2; // skip the {wildcard} in the path
  let depth = 0;
  for (let j = open; j < rules.length; j++) {
    if (rules[j] === "{") depth++;
    else if (rules[j] === "}" && --depth === 0) return rules.slice(i, j + 1);
  }
  throw new Error(`unterminated block ${name}`);
};
const results = [];
const test = (n, fn) => {
  try {
    fn();
    results.push(`PASS ${n}`);
  } catch (err) {
    results.push(`FAIL ${n}: ${err.message}`);
  }
};

test("impactPredictions: admin read, no client write (confidence / ranges / versions server-only)", () => {
  const b = block("impactPredictions");
  assert.ok(/allow read: if isAdmin\(\);/.test(b));
  assert.ok(/allow write: if false;/.test(b));
});
test("seoChangeEvents: no client create/delete; update limited to implementationNotes (+updatedAt)", () => {
  const b = block("seoChangeEvents");
  assert.ok(/allow create, delete: if false;/.test(b));
  assert.ok(/hasOnly\(\["implementationNotes", "updatedAt"\]\)/.test(b));
  assert.ok(/implementationNotes\.size\(\) <= 2000/.test(b));
});
test("seoExperiments: only ownerHoldRelease (released == true, note) on open experiments", () => {
  const b = block("seoExperiments");
  assert.ok(/allow create, delete: if false;/.test(b));
  assert.ok(/hasOnly\(\["ownerHoldRelease", "updatedAt"\]\)/.test(b));
  assert.ok(/ownerHoldRelease\.released == true/.test(b));
  assert.ok(/resource\.data\.status == "open"/.test(b));
  assert.ok(/keys\(\)\.hasOnly\(\["released", "note", "atMs"\]\)/.test(b));
});
test("trackingRuns server-only; trackingRunLocks fully closed", () => {
  assert.ok(/allow write: if false;/.test(block("trackingRuns")));
  assert.ok(/allow read, write: if false;/.test(block("trackingRunLocks")));
});
test("M8-reserved collections never client-written", () => {
  for (const c of ["impactObservations", "experimentOutcomes"]) assert.ok(/allow write: if false;/.test(block(c)), c);
});
test("decisions rule unchanged (owner review fields only)", () => {
  const b = block("decisions");
  assert.ok(/hasOnly\(\["ownerStatus", "ownerNote", "updatedAt"\]\)/.test(b));
});

const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(`\n${results.length - failed.length}/${results.length} M7 security-rule checks passed`);
if (failed.length) process.exit(1);
