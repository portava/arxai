// CI guard — investor surfaces must never imply a guaranteed / risk-free /
// fixed-percentage return.
//
// SAFETY (Task #72): the Investor Portal + Admin Investor Management surfaces
// present recorded contributions and intent-only allocation preferences. They
// must NEVER affirmatively promise a return. We scan ONLY the investor surfaces
// (frontend pages + backend routes/service) for AFFIRMATIVE return-promise
// phrasing. Negating disclosures ("no return is guaranteed", "never projected,
// guaranteed, or implied") are required and intentionally NOT matched, because
// the patterns target the promise constructions, not the bare word "guaranteed".

import { readWordingSources, scanCopyPatterns, coverageFailure, type WordingScanOptions } from "./wording-source.js";
import { type CheckResult } from "./_lib.js";

const NAME = "investor-no-guaranteed-return";

// Investor-only surfaces. Keep this list tight so the guard never bleeds into
// unrelated trader copy (which has its own guards).
const SCAN_PATHS = [
  "artifacts/trading-dashboard/src/pages/investor.tsx",
  "artifacts/trading-dashboard/src/pages/admin/investors.tsx",
  "artifacts/api-server/src/routes/meInvestor.ts",
  "artifacts/api-server/src/routes/adminInvestors.ts",
  "artifacts/api-server/src/lib/investor",
];

// Affirmative return-promise constructions — case-insensitive. These match a
// claim, not the negating disclosure. e.g. "guaranteed return" is forbidden;
// "no return is guaranteed" does NOT match (the words are not adjacent in the
// forbidden order).
const PATTERNS: string[] = [
  "guaranteed\\s+(return|returns|profit|profits|income|gains?|yield|payout)",
  "(return|returns|profit|profits|income|yield)\\s+(is|are)\\s+guaranteed",
  "risk[\\s-]?free",
  "fixed\\s+(return|returns|rate of return|monthly return|yield|income)",
  "assured\\s+(return|returns|profit|profits|income)",
  // fixed-percentage-per-period promises, e.g. "5% monthly", "10% per month"
  "\\d+\\s*%\\s*(per\\s+month|monthly|a\\s+month|per\\s+year|per\\s+annum|annually|guaranteed)",
];

export function checkInvestorNoGuaranteedReturn(options: WordingScanOptions = {}): CheckResult {
  const violations: string[] = [];
  let scanned = 0;
  try {
    const sources = readWordingSources(SCAN_PATHS, options); scanned = sources.length;
    for (const source of sources) for (const hit of scanCopyPatterns(source, PATTERNS, true)) {
      violations.push(`[${hit.pattern}] ${hit.location}: ${hit.text}`);
    }
  } catch (error) { violations.push(coverageFailure(error)); }
  if (violations.length === 0) {
    return {
      name: NAME,
      ok: true,
      violations: [],
      notes: [
        `0 return-promise matches across ${scanned} investor product source file(s) / ${PATTERNS.length} pattern(s)`,
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
  const r = checkInvestorNoGuaranteedReturn();
  console.log(r.ok ? `[PASS] ${r.name}` : `[FAIL] ${r.name}`);
  for (const v of r.violations) console.log("  -", v);
  process.exit(r.ok ? 0 : 1);
}
