// check-capital-constitution.ts
//
// Constitution drift guard (Blueprint Part II #53, Phase 0).
//
// docs/CAPITAL_CONSTITUTION.md encodes the rules ordinary configuration and AI
// may never weaken. Its authority model requires that changing it is a
// deliberate governance act, never a drive-by edit — so this guard pins the
// exact article heading lines and the central-rule sentence, and fails when:
//
//   1. the file is missing entirely;
//   2. any pinned article heading line changed or disappeared (a removal
//      ratchet, same shape as check-test-scripts-wired's ALLOWLIST: the pinned
//      list below is the source of truth, and doc-vs-pin drift in EITHER
//      direction is a violation — a heading removed/renamed in the doc, or a
//      new/renamed heading present in the doc but not pinned here);
//   3. the central-rule sentence is missing or reworded.
//
// The only valid amendment path (Article VIII): an Owner Decision Registry
// ruling PLUS updating PINNED_ARTICLE_HEADINGS here in the same reviewed
// change. Pure file read — no network, DB, or writes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "./_lib.js";
import { ROOT } from "./_lib.js";

export const CONSTITUTION_PATH = "docs/CAPITAL_CONSTITUTION.md";

// The blueprint's central rule, verbatim (Part II preamble). The constitution
// must carry this sentence unmodified.
export const CENTRAL_RULE_SENTENCE =
  "More intelligence does not automatically earn more authority. " +
  "Every added component must improve measured decisions, remain reproducible, " +
  "preserve deterministic risk, and be removable without endangering positions or economic truth.";

// Pinned article heading lines, exact text. Removal ratchet: entries are only
// ever amended via the Article VIII procedure (owner ruling + same-change pin
// update), never casually.
export const PINNED_ARTICLE_HEADINGS: readonly string[] = [
  "## Article I — The Central Rule",
  "## Article II — Authority Hierarchy",
  "## Article III — Refusal Is a Valid Result",
  "## Article IV — Authority Is Earned by Evidence",
  "## Article V — Truth Is Append-Only",
  "## Article VI — Owner Authority",
  "## Article VII — Immediate Decisions and Holds",
  "## Article VIII — Amendment Procedure",
];

const GUARD_FILE = "scripts/src/ci/check-capital-constitution.ts";

// Pure analysis over file content so the regression test can exercise drift
// shapes without touching the real document.
export function analyzeCapitalConstitution(content: string): string[] {
  const violations: string[] = [];

  const headingLines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("## Article"));
  const present = new Set(headingLines);
  const pinned = new Set(PINNED_ARTICLE_HEADINGS);

  for (const h of PINNED_ARTICLE_HEADINGS) {
    if (!present.has(h)) {
      violations.push(
        `pinned article heading missing or changed: "${h}" — restore it, or amend it via an ` +
          `Owner Decision Registry ruling + PINNED_ARTICLE_HEADINGS in ${GUARD_FILE} (Article VIII)`,
      );
    }
  }

  for (const h of headingLines) {
    if (!pinned.has(h)) {
      violations.push(
        `unpinned article heading in ${CONSTITUTION_PATH}: "${h}" — a new or renamed article must be ` +
          `pinned in PINNED_ARTICLE_HEADINGS in ${GUARD_FILE} in the same reviewed change, backed by an ` +
          `Owner Decision Registry ruling (Article VIII)`,
      );
    }
  }

  if (!content.includes(CENTRAL_RULE_SENTENCE)) {
    violations.push(
      `central-rule sentence missing or reworded in ${CONSTITUTION_PATH} — Article I must carry the ` +
        `blueprint sentence verbatim ("More intelligence does not automatically earn more authority. ...")`,
    );
  }

  return violations;
}

export function checkCapitalConstitution(): CheckResult {
  let content: string;
  try {
    content = readFileSync(join(ROOT, CONSTITUTION_PATH), "utf8");
  } catch {
    return {
      name: "capital-constitution",
      ok: false,
      violations: [
        `${CONSTITUTION_PATH} is missing — the Capital Constitution is a Phase 0 governance artifact; ` +
          `deleting it requires the Article VIII amendment procedure, which cannot authorize deletion of the document itself`,
      ],
    };
  }

  const violations = analyzeCapitalConstitution(content);
  return {
    name: "capital-constitution",
    ok: violations.length === 0,
    violations,
    notes: [
      `${PINNED_ARTICLE_HEADINGS.length} pinned article heading(s) + central-rule sentence verified in ${CONSTITUTION_PATH}`,
    ],
  };
}
