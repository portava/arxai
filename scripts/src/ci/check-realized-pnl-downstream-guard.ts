// Programmatic enforcement of the live-test-cycle realised P/L
// downstream-consumer rule.
//
// Any code that READS `realizedPlUsd` from arx_live_test_cycles (the
// only table where this column lives today) MUST be one of:
//   1. An allowlisted writer / definer / corrector / test fixture, OR
//   2. A consumer whose surrounding lines also reference `pnlStatus`
//      OR call `isRealizedPnlIngestible(...)` — i.e. it cannot ingest
//      the value without checking the data-quality flag.
//
// This guard fail-closes any future allocation ledger, aggregate,
// report, or AI-learning path that adds a new read of `realizedPlUsd`
// without honouring the centralized guard documented on the schema.

import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const ROOTS = [
  join(ROOT, "artifacts"),
  join(ROOT, "lib"),
  join(ROOT, "scripts/src"),
];

// Files explicitly allowed to mention `realizedPlUsd` without an
// adjacent pnlStatus / isRealizedPnlIngestible check. Each entry is
// either the schema declaration, the canonical writer, the centralized
// helper, the one-shot correction script that NULLs the field, or a
// test fixture that ASSERTS the guard's behaviour.
const ALLOWLIST = new Set<string>([
  "lib/db/src/schema/arxLiveTestCycles.ts",
  "artifacts/api-server/src/lib/live/liveTestCycle.ts",
  "artifacts/api-server/src/lib/live/realizedPnl.ts",
  "scripts/src/correctMissingCloseFillPricePnl.ts",
  "scripts/src/realizedPnlGuardTest.ts",
  "scripts/src/liveTestCycleCloseGuardIntegrationTest.ts",
  "scripts/src/ci/check-realized-pnl-downstream-guard.ts",
]);

const READ_TOKEN = /\brealizedPlUsd\b/;
const GUARD_TOKEN = /(pnlStatus|isRealizedPnlIngestible)\b/;
const WINDOW = 6; // lines above + below the read site

export function checkRealizedPnlDownstreamGuard(): CheckResult {
  const violations: string[] = [];
  const seen: string[] = [];
  for (const root of ROOTS) {
    for (const f of walk(root, { exts: [".ts", ".tsx"] })) {
      const r = rel(f);
      if (ALLOWLIST.has(r)) continue;
      const src = read(f);
      if (!READ_TOKEN.test(src)) continue;
      seen.push(r);
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!READ_TOKEN.test(line)) return;
        const lo = Math.max(0, i - WINDOW);
        const hi = Math.min(lines.length, i + WINDOW + 1);
        const window = lines.slice(lo, hi).join("\n");
        if (!GUARD_TOKEN.test(window)) {
          violations.push(`${r}:${i + 1} → reads realizedPlUsd without an adjacent pnlStatus / isRealizedPnlIngestible() check: ${line.trim().slice(0, 120)}`);
        }
      });
    }
  }
  return {
    name: "realized-pnl-downstream-guard",
    ok: violations.length === 0,
    violations,
    notes: [
      `scanned ${seen.length} consumer file(s) for realizedPlUsd reads`,
      "Allowlist: schema, writer (liveTestCycle.ts), helper (realizedPnl.ts), correction script, test fixtures.",
      "All other readers MUST gate on pnlStatus === 'COMPUTED' or call isRealizedPnlIngestible().",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkRealizedPnlDownstreamGuard();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
