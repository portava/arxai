// Phase 3 — Guard against legacy "paper-only" user-facing copy.
//
// The platform now exposes three modes (Trading Off / Demo Trading Active /
// Live Trading Active). Internal admin/dev/debug strings and CI guard
// names may still mention "paper-only" — only USER-FACING surfaces must
// not regress.
import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

// User-facing surfaces. Internal admin/dev/diagnostic surfaces are exempt.
const ROOTS = [
  join(ROOT, "artifacts/trading-dashboard/src/pages"),
  join(ROOT, "artifacts/trading-dashboard/src/components"),
];

const EXEMPT_PATH = /(admin\/|TradingModeBanner|liveTrading|safetyCore|diagnostic|debug|audit|tester|qa-|paper-trading|paperTrading)/i;

// Match human-readable wording, not field names like `safetyMode:"paper_only"`.
const VIOLATION = /(paper[\s-]?only|live\s*locked|read[\s-]?only\s+mode)/i;

export function checkNoUserFacingPaperOnly(): CheckResult {
  const violations: string[] = [];
  for (const root of ROOTS) {
    for (const f of walk(root, { exts: [".tsx", ".ts"] })) {
      if (EXEMPT_PATH.test(f)) continue;
      const src = read(f);
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        // Only flag inside JSX text or string literals that look like
        // user-visible copy. Skip imports, types, and field-name lines.
        if (/^\s*(import|export\s+type|interface|type\s+\w)/.test(line)) return;
        if (/safetyMode\s*:|liveLocked\s*:|allowOrderExecution\s*:/.test(line)) return;
        if (VIOLATION.test(line)) violations.push(`${rel(f)}:${i + 1} → ${line.trim().slice(0, 120)}`);
      });
    }
  }
  return {
    name: "no-user-facing-paper-only",
    ok: violations.length === 0,
    violations,
    notes: [
      "User-facing copy must use 'Trading Off' / 'Demo Trading Active' / 'Live Trading Active'.",
      "Internal flags (safetyMode, liveLocked) are still allowed as field names.",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reportResult(checkNoUserFacingPaperOnly());
}
