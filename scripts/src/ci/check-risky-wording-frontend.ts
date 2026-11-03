// CI guard — no risky / regulated wording in user-facing frontend.
//
// SAFETY: prevents UI drift that would imply ARX AI is a broker, a custodian,
// or that users deposit / withdraw real money. Tokens are matched
// case-insensitively as whole words where applicable.

import { readWordingSources, scanCopyPatterns, coverageFailure, type WordingScanOptions, type WordingSource } from "./wording-source.js";
import { type CheckResult } from "./_lib.js";

const NAME = "risky-wording-frontend";

// Money-handling tokens — case-insensitive. These imply ARX takes custody of
// or moves real money. They are forbidden on general trader surfaces, but the
// view-only Investor Portal + Admin Investor Management legitimately track
// recorded contributions as ledger entries (DEPOSIT / WITHDRAWAL / ADJUSTMENT),
// so those specific surfaces are allowlisted for THIS group only (see
// MONEY_HANDLING_ALLOWLIST). The performance-promise / regulator-claim group
// below is NEVER allowlisted — it applies to every surface including investors.
const MONEY_HANDLING_PATTERNS: string[] = [
  "\\bdeposit(ed|ing|s)?\\b",
  "\\bwithdraw(als?|n|ing|s)?\\b",
  "\\bcustody\\b",
  "\\binvestor funds?\\b",
  "\\bclient funds?\\b",
  "\\bpooled customer funds?\\b",
];

// Always-forbidden tokens — apply to EVERY user-facing surface, no allowlist.
const ALWAYS_FORBIDDEN_PATTERNS: string[] = [
  // performance promises
  "\\bguaranteed profit",
  "\\bmanaged money\\b",
  // regulator claims
  "\\blicensed broker\\b",
  "\\bregulated broker\\b",
  // misleading account-ownership claims
  "\\byour master account balance\\b",
];

// Paths scanned — user-visible surfaces only.
const SCAN_PATHS = [
  "artifacts/trading-dashboard/src",
];

// Files that are allowed to mention ANY forbidden word (test stubs, audit
// constants, or disclosure text that explicitly negates them).
const ALLOWLIST_FILE_PATTERNS = [
  "/__tests__/",
  "/operatorFundedPilotConfig", // disclosure text negates ("I am NOT depositing")
];

// Files allowed to use the MONEY_HANDLING group only — the view-only Investor
// Portal + Admin Investor Management surfaces. They still cannot use the
// always-forbidden performance/regulator tokens (a separate dedicated guard,
// check-investor-no-guaranteed-return, blocks return-promise wording here too).
const MONEY_HANDLING_ALLOWLIST = [
  "/pages/investor.tsx",
  "/pages/admin/investors.tsx",
  // Admin-only Fund Control / cockpit capital views (operator role gated):
  // the same investor-money bookkeeping surface as admin/investors.tsx.
  "/components/admin/cockpit/CapitalSection.tsx",
  "/components/admin/cockpit/InvestorsSection.tsx",
  "/components/admin/fundControl/",
];

function scanGroup(sources: WordingSource[], patterns: string[], moneyHandling: boolean): string[] {
  const found: string[] = [];
  for (const source of sources) {
    if (ALLOWLIST_FILE_PATTERNS.some(p => source.path.includes(p))) continue;
    if (moneyHandling && MONEY_HANDLING_ALLOWLIST.some(p => source.path.includes(p))) continue;
    for (const hit of scanCopyPatterns(source, patterns, true)) found.push(`[${hit.pattern}] ${hit.location}: ${hit.text}`);
  }
  return found;
}

export function checkRiskyWordingFrontend(options: WordingScanOptions = {}): CheckResult {
  let sources: WordingSource[];
  try { sources = readWordingSources(SCAN_PATHS, options); }
  catch (error) { return { name: NAME, ok: false, violations: [coverageFailure(error)] }; }
  const violations = [
    ...scanGroup(sources, MONEY_HANDLING_PATTERNS, true),
    ...scanGroup(sources, ALWAYS_FORBIDDEN_PATTERNS, false),
  ];
  const totalPatterns = MONEY_HANDLING_PATTERNS.length + ALWAYS_FORBIDDEN_PATTERNS.length;
  if (violations.length === 0) {
    return {
      name: NAME,
      ok: true,
      violations: [],
      notes: [
        `0 forbidden wording matches across ${sources.length} product source files / ${totalPatterns} pattern(s)`,
      ],
    };
  }
  return {
    name: NAME,
    ok: false,
    violations,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkRiskyWordingFrontend();
  console.log(r.ok ? `[PASS] ${r.name}` : `[FAIL] ${r.name}`);
  for (const v of r.violations) console.log("  -", v);
  process.exit(r.ok ? 0 : 1);
}
