// Regression suite for the capital-constitution drift guard.
//
// Exercises `analyzeCapitalConstitution` against synthetic document states
// (headings removed, renamed, added unpinned; central rule removed/reworded)
// and runs `checkCapitalConstitution` against the real repo document, which
// must pass. Pure source analysis — no network, DB, or filesystem writes.

import {
  analyzeCapitalConstitution,
  checkCapitalConstitution,
  CENTRAL_RULE_SENTENCE,
  PINNED_ARTICLE_HEADINGS,
} from "./check-capital-constitution.js";

export {};

// A minimal compliant document built FROM the pinned constants, so the suite
// never drifts from the guard's own source of truth.
function compliantDoc(): string {
  return [
    "# ARX Capital Constitution",
    "",
    ...PINNED_ARTICLE_HEADINGS.flatMap((h) => [h, "", "Body text.", ""]),
    CENTRAL_RULE_SENTENCE,
    "",
  ].join("\n");
}

type Case = { name: string; content: string; expectViolations: number };

const cases: Case[] = [
  {
    name: "compliant synthetic doc is clean",
    content: compliantDoc(),
    expectViolations: 0,
  },
  {
    name: "removing one pinned heading is flagged",
    content: compliantDoc().replace(`${PINNED_ARTICLE_HEADINGS[2]}\n`, ""),
    expectViolations: 1,
  },
  {
    name: "renaming a heading is flagged twice (missing pin + unpinned newcomer)",
    content: compliantDoc().replace(
      PINNED_ARTICLE_HEADINGS[1],
      "## Article II — Authority Is Negotiable",
    ),
    expectViolations: 2,
  },
  {
    name: "adding an unpinned article is flagged",
    content: compliantDoc() + "\n## Article IX — Sneaky Addendum\n",
    expectViolations: 1,
  },
  {
    name: "removing the central rule is flagged",
    content: compliantDoc().replace(CENTRAL_RULE_SENTENCE, ""),
    expectViolations: 1,
  },
  {
    name: "rewording the central rule is flagged",
    content: compliantDoc().replace(
      "does not automatically earn",
      "automatically earns",
    ),
    expectViolations: 1,
  },
  {
    name: "empty file flags every pin plus the central rule",
    content: "",
    expectViolations: PINNED_ARTICLE_HEADINGS.length + 1,
  },
  {
    name: "leading/trailing whitespace on heading lines is tolerated",
    content: compliantDoc().replace(
      PINNED_ARTICLE_HEADINGS[0],
      `  ${PINNED_ARTICLE_HEADINGS[0]}  `,
    ),
    expectViolations: 0,
  },
];

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// eslint-disable-next-line no-console
console.log("\ncapital-constitution guard — regression suite");
for (const c of cases) {
  const violations = analyzeCapitalConstitution(c.content);
  const ok = violations.length === c.expectViolations;
  record(
    c.name,
    ok,
    ok
      ? `${violations.length} violation(s) as expected`
      : `expected ${c.expectViolations} violation(s), got ${violations.length}: ${violations.join(" | ")}`,
  );
}

// The real committed document must satisfy the guard end-to-end (also covers
// the missing-file branch staying un-triggered on a healthy checkout).
const real = checkCapitalConstitution();
record(
  "real docs/CAPITAL_CONSTITUTION.md passes checkCapitalConstitution",
  real.ok,
  real.ok ? undefined : real.violations.join(" | "),
);

const failed = results.filter((r) => !r.ok).length;
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed}/${results.length} capital-constitution cases passed`);
process.exit(failed === 0 ? 0 : 1);
