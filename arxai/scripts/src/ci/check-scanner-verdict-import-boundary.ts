// check-scanner-verdict-import-boundary.ts
//
// Static-analysis CI guard (ci:guards lane) — enforces the SCANNER VERDICT
// publisher boundary.
//
// WHAT IT GUARDS:
//   `resolveScannerActionability` and `resolveDataActionabilityCap` are
//   raw-engine functions that compute the INITIAL per-symbol actionability from
//   signal-level inputs. They belong only inside the designated publishers:
//
//   Allowed publishers:
//     • lib/scannerActionability.ts    (defines the functions)
//     • lib/scannerTruth.ts            (the verdict engine that calls them)
//     • ScalpSignalCard.tsx            (signals-publisher: per-symbol scalp verdict)
//     • BroadScanOpportunityMap.tsx    (broad-scan publisher: per-row verdict)
//     • *.test.ts / *.test.tsx         (regression contract tests)
//
//   All other UI surfaces (components, pages, hooks) must consume the RESOLVED
//   verdict via `useSelectedActionStore` + `resolveSelectedSymbolActionabilityDisplay`
//   or one of the DISPLAY helpers (`actionabilityDisplayUi`, `resolveVisibleActionLabel`,
//   `resolveVisibleActionButtonLabel`), never re-derive from raw signals.
//
// WHY:
//   Allowing arbitrary components to call `resolveScannerActionability` directly
//   creates independent verdict paths that can diverge from the shared
//   consolidated truth the header, chart, Eleanor panel, and opportunity cards
//   all read from. Task #818 pins the ONE-verdict contract: every surface for the
//   same symbol/timeframe/read cycle must converge on the same verdict.
//
// All checks are fast static scans — no runtime, no DB, no network.

import { join } from "node:path";
import type { CheckResult } from "./_lib.js";
import { ROOT, walk, read, rel } from "./_lib.js";

// Raw engine functions that must NOT be imported by arbitrary UI components.
const FORBIDDEN_DIRECT_CALLERS = [
  "resolveScannerActionability",
  "resolveDataActionabilityCap",
] as const;

// Files that ARE allowed to import / use the forbidden functions.
// Paths are matched as suffix strings against the file's path relative to ROOT.
const ALLOWED_SUFFIXES: string[] = [
  // The module that defines them.
  "lib/scannerActionability.ts",
  // The verdict engine that aggregates them into consolidated truth.
  "lib/scannerTruth.ts",
  // Designated publishers — components that compute a per-symbol verdict and
  // lift it into the selectedActionStore via publishScannerAction.
  "components/scanner/ScalpSignalCard.tsx",
  "components/scanner/BroadScanOpportunityMap.tsx",
];

// Test files are always allowed (pure-contract regression tests).
function isTestFile(relPath: string): boolean {
  return relPath.endsWith(".test.ts") || relPath.endsWith(".test.tsx");
}

function isAllowed(relPath: string): boolean {
  if (isTestFile(relPath)) return true;
  return ALLOWED_SUFFIXES.some((suffix) => relPath.endsWith(suffix));
}

// Scan roots: UI component tree and pages where the violation is most likely.
const SCAN_ROOTS = [
  join(ROOT, "artifacts/trading-dashboard/src/components"),
  join(ROOT, "artifacts/trading-dashboard/src/pages"),
  join(ROOT, "artifacts/trading-dashboard/src/hooks"),
  join(ROOT, "artifacts/trading-dashboard/src/lib"),
];

// Match a raw identifier usage: not inside a string or comment (best-effort;
// the guard catches accidental additions, not adversarial code).
// We look for the identifier as a standalone word token.
function makeIdentifierRe(name: string): RegExp {
  return new RegExp(`\\b${name}\\b`);
}

const FORBIDDEN_RES = FORBIDDEN_DIRECT_CALLERS.map((name) => ({
  name,
  re: makeIdentifierRe(name),
}));

export function checkScannerVerdictImportBoundary(): CheckResult {
  const violations: string[] = [];

  for (const root of SCAN_ROOTS) {
    let files: string[];
    try {
      files = walk(root).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    } catch {
      // Root may not exist in all environments — skip gracefully.
      continue;
    }

    for (const file of files) {
      const relPath = rel(file);

      if (isAllowed(relPath)) continue;

      const src = read(file);

      for (const { name, re } of FORBIDDEN_RES) {
        if (re.test(src)) {
          violations.push(`${relPath}: direct use of \`${name}\` outside of designated publishers`);
        }
      }
    }
  }

  if (violations.length === 0) {
    return {
      ok: true,
      name: "scanner-verdict-import-boundary",
      violations: [],
      notes: ["All scanner verdict engine functions are used only by designated publishers."],
    };
  }

  return {
    ok: false,
    name: "scanner-verdict-import-boundary",
    violations,
    notes: [
      `${violations.length} violation(s) — raw scanner verdict engine functions must only`,
      "be called from lib/scannerTruth.ts or the designated publisher components",
      "(ScalpSignalCard, BroadScanOpportunityMap). UI surfaces must consume the resolved",
      "verdict via useSelectedActionStore + resolveSelectedSymbolActionabilityDisplay.",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkScannerVerdictImportBoundary();
  const summary = r.ok
    ? `✓ ${r.notes?.[0] ?? "ok"}`
    : [`✗ ${r.notes?.join(" ") ?? "failed"}`, ...r.violations].join("\n  ");
  // eslint-disable-next-line no-console
  console.log(summary);
  process.exit(r.ok ? 0 : 1);
}
