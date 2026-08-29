// check-owner-decision-linkage.ts
//
// Owner Decision Registry drift guard (Blueprint Part II #54).
//
// docs/OWNER_DECISIONS.md is the append-only registry of owner rulings, and
// until this guard the linkage between a ruling and the code implementing it
// was manual convention: nothing failed when the implementing predicate was
// renamed, the guard file deleted, or a new ruling appended without anyone
// deciding what code carries it. This guard closes that:
//
//   1. every ruling heading in the doc must have a linkage entry below, and
//      every linkage entry must have a ruling in the doc (drift in EITHER
//      direction fails — same removal-ratchet shape as
//      check-capital-constitution's pinned headings);
//   2. each linkage entry names the code ANCHORS implementing the ruling
//      (file must exist; when `mustContain` is pinned, the file must still
//      contain it) — or carries an explicit `noAnchorReason` for a ruling
//      that is process/absence-shaped and genuinely has no code point;
//   3. each entry carries a REVIEW DATE (#54's review-date field, coded).
//      A past-due date fails the build: re-affirmation is a deliberate act —
//      append a review ruling to docs/OWNER_DECISIONS.md (or supersede), then
//      move the date here in the same reviewed change. The DB column
//      `owner_decisions.review_by_date` carries the same field for rulings
//      appended through the API.
//
// The append-only discipline is untouched: this file never edits a ruling —
// it is the CODED INDEX of what each ruling is anchored to and when it must
// be looked at again. Pure file reads; no network, DB, or writes.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "./_lib.js";
import { ROOT } from "./_lib.js";

export const REGISTRY_PATH = "docs/OWNER_DECISIONS.md";
const GUARD_FILE = "scripts/src/ci/check-owner-decision-linkage.ts";

export interface RulingAnchor {
  /** Repo-relative path of the implementing file. Must exist. */
  file: string;
  /** When pinned, the file must still contain this exact substring. */
  mustContain?: string;
}

export interface RulingLinkage {
  /** Exact heading text after "## Ruling N — ", pinned verbatim. */
  title: string;
  /** ISO date (YYYY-MM-DD) by which the ruling must be re-affirmed here. */
  reviewBy: string;
  /** Code/flag anchors implementing the ruling. */
  anchors: readonly RulingAnchor[];
  /** REQUIRED when anchors is empty: why no single code point exists. */
  noAnchorReason?: string;
}

/**
 * The coded ruling → implementation index. AMENDING an entry (a rename, a new
 * anchor, a moved review date) is a reviewed change; a review date may only be
 * moved together with a re-affirming or superseding append in the registry.
 */
export const RULING_LINKAGE: Readonly<Record<number, RulingLinkage>> = {
  1: {
    title: "Stale-export overwrites are the top Phase 0 threat",
    reviewBy: "2027-02-27",
    anchors: [],
    noAnchorReason:
      "process ruling: retired the Replit Agent bulk-merge integration path; enforced by workflow, not a code point",
  },
  2: {
    title: "TypeScript, not Python, for the multi-broker spec",
    reviewBy: "2027-02-27",
    anchors: [{ file: "tsconfig.base.json" }, { file: "pnpm-workspace.yaml" }],
  },
  3: {
    title: "Integer-FK + publicId identity",
    reviewBy: "2027-02-27",
    anchors: [],
    noAnchorReason:
      "schema-wide convention across lib/db/src/schema; no single code point carries it (new-table reviews do)",
  },
  4: {
    title: "Compose, don't duplicate",
    reviewBy: "2027-02-27",
    anchors: [],
    noAnchorReason:
      "architectural prohibition (no 5th kill switch / 6th limit store); enforced in review, not by one file",
  },
  5: {
    title: "Netting is demo/shadow-only",
    reviewBy: "2027-02-27",
    anchors: [],
    noAnchorReason:
      "Part V hold: live netting is prohibited by the ABSENCE of any live netting path behind the gate wall; an absence has no anchor file",
  },
  6: {
    title: "Emergency-close kill-switch exemption is pinned",
    reviewBy: "2027-02-27",
    anchors: [
      {
        file: "artifacts/api-server/src/lib/live/killSwitchBypass.ts",
        mustContain: "killSwitchCloseBypassApplies",
      },
    ],
  },
  7: {
    title: "Fail closed on missing settings",
    reviewBy: "2027-02-27",
    anchors: [
      { file: "scripts/src/ci/check-live-broker-execution-defaults.ts" },
      {
        file: "lib/domain/src/safety-contracts/executionTier.ts",
        mustContain: "DEFAULT_EXECUTION_TIER",
      },
    ],
  },
  8: {
    title: "Part V holds adopted as standing rulings",
    reviewBy: "2027-02-27",
    anchors: [{ file: "docs/CAPITAL_CONSTITUTION.md" }],
  },
  9: {
    title: "Registration pepper burned and rotated",
    reviewBy: "2027-02-27",
    anchors: [{ file: "scripts/src/ci/check-no-committed-pepper.ts" }],
  },
  10: {
    title: "Reconciliation-freshness gate staging (2026-08-20)",
    reviewBy: "2027-02-27",
    anchors: [
      {
        file: "artifacts/api-server/src/lib/live/liveCommandPipeline.ts",
        mustContain: "Ruling 10",
      },
    ],
  },
  11: {
    title: "Master exposure cap 0-means-unlimited trap (2026-08-20)",
    reviewBy: "2027-02-27",
    anchors: [],
    noAnchorReason:
      "records a pinned-not-fixed trap; the ruling documents a hazard, and the fix (when made) supersedes it",
  },
  12: {
    title: "execution_events append-only is enforced in CI, not by REVOKE (2026-08-23)",
    reviewBy: "2027-02-27",
    anchors: [
      { file: "scripts/src/ci/check-vault-mutations.ts", mustContain: "execution_events" },
    ],
  },
  13: {
    title: "bigint/string canonicalization collision: pinned, not fixed (2026-08-23)",
    reviewBy: "2027-02-27",
    anchors: [{ file: "scripts/src/stableStringifyParityTest.ts" }],
  },
  14: {
    title: "replay determinism is NOT implemented (2026-08-23)",
    reviewBy: "2027-02-27",
    anchors: [],
    noAnchorReason:
      "records an ABSENCE as of 2026-08-23; an incident-replay harness has since landed (test:incident-replay) — the review date is when this ruling must be re-affirmed or superseded",
  },
  15: {
    title: 'Deriv "new mode" PAT authorize is unproven and does not work (2026-08-23)',
    reviewBy: "2027-02-27",
    anchors: [],
    noAnchorReason:
      "records a negative live-venue finding; Rulings 16-18 carry the later positive certifications",
  },
  16: {
    title: "the Deriv new-API transport is CERTIFIED read-only; order placement is NOT (2026-08-25)",
    reviewBy: "2027-02-27",
    anchors: [
      { file: "artifacts/api-server/src/scripts/derivNewApiCertify.ts" },
      {
        file: "artifacts/api-server/src/lib/deriv/newApi/otp.ts",
        mustContain: "demo|virtual",
      },
    ],
  },
  17: {
    title: "one demo trade executed and reconciled; the P/L check was exercised only at ZERO (2026-08-25)",
    reviewBy: "2027-02-27",
    anchors: [{ file: "artifacts/api-server/src/scripts/derivDemoTradeCertify.ts" }],
  },
  18: {
    title: "reconciliation proven on a NON-ZERO P/L; keepalive and recovery added (2026-08-25)",
    reviewBy: "2027-02-27",
    anchors: [{ file: "artifacts/api-server/src/scripts/derivCaptureEvidence.ts" }],
  },
  19: {
    title: "Phase 6 authorized, including the Deriv execution seam (2026-08-27)",
    reviewBy: "2027-02-27",
    anchors: [
      {
        file: "lib/domain/src/safety-contracts/executionTier.ts",
        mustContain: "Ruling 19",
      },
    ],
  },
};

const HEADING_RE = /^## Ruling (\d+) — (.+)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure analysis so the regression test can exercise every drift shape without
 * touching the real registry or filesystem.
 */
export function analyzeOwnerDecisionLinkage(opts: {
  docContent: string;
  linkage: Readonly<Record<number, RulingLinkage>>;
  fileExists: (relPath: string) => boolean;
  fileRead: (relPath: string) => string | null;
  /** YYYY-MM-DD — the day the check runs. */
  todayIso: string;
}): string[] {
  const violations: string[] = [];
  const { docContent, linkage, fileExists, fileRead, todayIso } = opts;

  // Parse ruling headings out of the registry document.
  const docRulings = new Map<number, string>();
  for (const line of docContent.split(/\r?\n/)) {
    const m = HEADING_RE.exec(line.trim());
    if (!m) continue;
    const num = Number(m[1]);
    if (docRulings.has(num)) {
      violations.push(
        `${REGISTRY_PATH}: duplicate ruling number ${num} — the registry is append-only with unique numbers`,
      );
      continue;
    }
    docRulings.set(num, m[2]!.trim());
  }

  // Direction 1: every doc ruling must be linked.
  for (const [num, title] of docRulings) {
    const entry = linkage[num];
    if (!entry) {
      violations.push(
        `Ruling ${num} ("${title}") has no entry in RULING_LINKAGE (${GUARD_FILE}) — every appended ruling ` +
          `must name the code implementing it (or an explicit noAnchorReason) in the same reviewed change`,
      );
      continue;
    }
    if (entry.title !== title) {
      violations.push(
        `Ruling ${num} title drift: registry says "${title}" but RULING_LINKAGE pins "${entry.title}" — ` +
          `rulings are never edited (append-only), so realign the pin only if the doc heading was never this pin`,
      );
    }
  }

  // Direction 2: every linkage entry must still have its ruling.
  for (const numStr of Object.keys(linkage)) {
    const num = Number(numStr);
    if (!docRulings.has(num)) {
      violations.push(
        `RULING_LINKAGE entry ${num} ("${linkage[num]!.title}") has no matching "## Ruling ${num} — ..." heading ` +
          `in ${REGISTRY_PATH} — a ruling was removed or renumbered, which the append-only discipline forbids`,
      );
    }
  }

  // Anchors + review dates for every linked ruling that exists in the doc.
  for (const [num, entry] of Object.entries(linkage)) {
    if (!docRulings.has(Number(num))) continue; // reported above

    if (entry.anchors.length === 0) {
      if (!entry.noAnchorReason || entry.noAnchorReason.trim().length === 0) {
        violations.push(
          `Ruling ${num}: no anchors and no noAnchorReason — an unlinked ruling is exactly the drift this guard exists to catch`,
        );
      }
    }
    for (const anchor of entry.anchors) {
      if (!fileExists(anchor.file)) {
        violations.push(
          `Ruling ${num}: anchor file ${anchor.file} is missing — the code implementing this ruling moved or was ` +
            `deleted; re-anchor it in ${GUARD_FILE} (and re-examine whether the ruling still holds)`,
        );
        continue;
      }
      if (anchor.mustContain) {
        const content = fileRead(anchor.file);
        if (content === null || !content.includes(anchor.mustContain)) {
          violations.push(
            `Ruling ${num}: anchor ${anchor.file} no longer contains ${JSON.stringify(anchor.mustContain)} — ` +
              `the implementing linkage broke; restore it or re-anchor under review`,
          );
        }
      }
    }

    if (!ISO_DATE_RE.test(entry.reviewBy)) {
      violations.push(
        `Ruling ${num}: reviewBy ${JSON.stringify(entry.reviewBy)} is not a YYYY-MM-DD date — a ruling without a ` +
          `readable review date is a ruling that will never be reviewed`,
      );
    } else if (entry.reviewBy < todayIso) {
      violations.push(
        `Ruling ${num}: review OVERDUE (reviewBy ${entry.reviewBy} < today ${todayIso}) — re-affirm or supersede it: ` +
          `append a review ruling to ${REGISTRY_PATH}, then move the date in ${GUARD_FILE} in the same change`,
      );
    }
  }

  return violations;
}

export function checkOwnerDecisionLinkage(): CheckResult {
  let content: string;
  try {
    content = readFileSync(join(ROOT, REGISTRY_PATH), "utf8");
  } catch {
    return {
      name: "owner-decision-linkage",
      ok: false,
      violations: [
        `${REGISTRY_PATH} is missing — the Owner Decision Registry mirror must exist (append-only, Ruling 1 discipline)`,
      ],
    };
  }
  const violations = analyzeOwnerDecisionLinkage({
    docContent: content,
    linkage: RULING_LINKAGE,
    fileExists: (p) => existsSync(join(ROOT, p)),
    fileRead: (p) => {
      try {
        return readFileSync(join(ROOT, p), "utf8");
      } catch {
        return null;
      }
    },
    todayIso: new Date().toISOString().slice(0, 10),
  });
  return {
    name: "owner-decision-linkage",
    ok: violations.length === 0,
    violations,
    notes:
      violations.length === 0
        ? [`${Object.keys(RULING_LINKAGE).length} rulings linked; anchors verified; no review overdue`]
        : undefined,
  };
}
