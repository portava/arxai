// CI guard — backtest-no-live-execution.
//
// The Backtesting Lab (Testing Lab) is a HISTORICAL SIMULATION surface.
// It must NEVER reach any live-order, live-command, or live-queue endpoint.
//
// This guard verifies the backtest route files and their direct library
// dependencies contain NO imports of:
//
//   - executeInstant / instantTrade (the live instant-trade router)
//   - liveCommandPipeline (Phase B live dispatch)
//   - arx_live_commands / mt5_commands table (live/demo mailboxes)
//   - placeLiveOrderGuarded (Build TT chokepoint)
//   - dispatchToBroker (adminTrading broker placement primitive)
//   - mt5_demo_commands (demo EA mailbox)
//
// Comment-stripped static scan — block comments are blanked, line comments
// stripped, so commented-out import references don't produce false positives.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type CheckResult } from "./_lib.js";

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  return noBlock
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

const BACKTEST_FILES = [
  "artifacts/api-server/src/routes/backtestRuns.ts",
  "artifacts/api-server/src/routes/backtests.ts",
  "artifacts/api-server/src/lib/backtest/backtestChartSeries.ts",
  "artifacts/api-server/src/lib/backtestStrategyRegistry.ts",
  "artifacts/api-server/src/lib/backtest/backtestDataReliability.ts",
];

const FORBIDDEN: Array<{ rx: RegExp; why: string }> = [
  {
    rx: /\bexecuteInstant\b/,
    why: "executeInstant (instant-trade router) must never be called from the backtest surface",
  },
  {
    rx: /\bliveCommandPipeline\b/,
    why: "liveCommandPipeline (Phase B live dispatch) must never be imported from the backtest surface",
  },
  {
    rx: /\barx_live_commands\b/,
    why: "arx_live_commands (live command mailbox) must never be touched by the backtest surface",
  },
  {
    rx: /\bmt5_commands\b/,
    why: "mt5_commands (EA mailbox) must never be touched by the backtest surface",
  },
  {
    rx: /\bmt5_demo_commands\b/,
    why: "mt5_demo_commands (demo EA mailbox) must never be touched by the backtest surface",
  },
  {
    rx: /\bplaceLiveOrderGuarded\b/,
    why: "placeLiveOrderGuarded (Build TT chokepoint) must never be imported from the backtest surface",
  },
  {
    rx: /\bdispatchToBroker\b/,
    why: "dispatchToBroker (broker placement primitive) must never be imported from the backtest surface",
  },
  {
    rx: /\/live\/instantTrade/,
    why: "instantTrade module path must never be imported from the backtest surface",
  },
  {
    rx: /\/live\/liveCommandPipeline/,
    why: "liveCommandPipeline module path must never be imported from the backtest surface",
  },
  {
    rx: /\/adminTrading\//,
    why: "adminTrading module path must never be imported from the backtest surface",
  },
];

export function checkBacktestNoLiveExecution(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  for (const rel of BACKTEST_FILES) {
    let src: string;
    try {
      src = readFileSync(join(ROOT, rel), "utf-8");
    } catch {
      notes.push(`could not read ${rel} — skipping (file may not exist)`);
      continue;
    }

    const stripped = stripComments(src);

    for (const { rx, why } of FORBIDDEN) {
      if (rx.test(stripped)) {
        violations.push(`${rel}: ${why}`);
      }
    }
  }

  return {
    name: "backtest-no-live-execution",
    ok: violations.length === 0,
    violations,
    notes,
  };
}

// Allow running standalone: `tsx scripts/src/ci/check-backtest-no-live-execution.ts`
if (process.argv[1]?.endsWith("check-backtest-no-live-execution.ts") ||
    process.argv[1]?.endsWith("check-backtest-no-live-execution.js")) {
  const r = checkBacktestNoLiveExecution();
  if (r.ok) {
    console.log(`[${r.name}] PASS — no live-execution imports in backtest surface`);
  } else {
    for (const v of r.violations) console.error(`[${r.name}] FAIL: ${v}`);
    process.exit(1);
  }
}
