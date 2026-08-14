// CI guard — investor Performance tab honesty (Task #76)
//
// Proves the real performance-figure metrics derived from the append-only
// investor ledger behave honestly:
//
//   1. A deposits-only ledger (no PERFORMANCE rows) reports
//      hasPerformanceData=false and null returns → the Performance tab keeps
//      its honest empty state. Contributions alone NEVER fabricate a return.
//   2. A real PERFORMANCE row populates realized P/L, all-time return %, and a
//      non-empty equity series. allTimeReturnPct = performance / netContributed.
//   3. PERFORMANCE is excluded from contributions (netContributed) but included
//      in currentValue — a recorded return is not new capital.
//   4. A recorded loss (negative PERFORMANCE) produces a negative return; the
//      sign of the figure is preserved, never coerced.
//
// Pure logic — no DB, no network. Imports the real metric helpers so this stays
// in lockstep with production.
import type { CheckResult } from "./_lib.js";
import {
  computeMetrics,
  computeEquitySeries,
} from "../../../artifacts/api-server/src/lib/investor/investorService.js";
import type { InvestorLedgerEntry } from "@workspace/db";

function entry(
  entryType: string,
  signedAmount: number,
  daysAgo: number,
): InvestorLedgerEntry {
  return {
    entryType,
    signedAmount: String(signedAmount),
    createdAt: new Date(Date.now() - daysAgo * 86_400_000),
  } as unknown as InvestorLedgerEntry;
}

export function checkInvestorPerformanceMetrics(): CheckResult {
  const violations: string[] = [];

  // 1. Deposits-only ledger → honest empty performance state.
  {
    const ledger = [entry("DEPOSIT", 10_000, 10), entry("DEPOSIT", 5_000, 5)];
    const m = computeMetrics(ledger);
    if (m.hasPerformanceData) {
      violations.push("deposits-only ledger must report hasPerformanceData=false");
    }
    if (m.allTimeReturnPct !== null || m.monthlyReturnPct !== null) {
      violations.push(
        `deposits-only ledger must have null returns, got all=${m.allTimeReturnPct} monthly=${m.monthlyReturnPct}`,
      );
    }
    if (m.realizedPnl !== 0) {
      violations.push(`deposits-only ledger must have realizedPnl=0, got ${m.realizedPnl}`);
    }
  }

  // 2 + 3. A real PERFORMANCE row populates returns and moves the curve, but is
  // excluded from contributions.
  {
    const ledger = [entry("DEPOSIT", 10_000, 30), entry("PERFORMANCE", 800, 1)];
    const m = computeMetrics(ledger);
    if (!m.hasPerformanceData) {
      violations.push("ledger with a PERFORMANCE row must report hasPerformanceData=true");
    }
    if (m.netContributed !== 10_000) {
      violations.push(
        `PERFORMANCE must be excluded from netContributed (expected 10000), got ${m.netContributed}`,
      );
    }
    if (m.realizedPnl !== 800) {
      violations.push(`realizedPnl must equal the PERFORMANCE figure (800), got ${m.realizedPnl}`);
    }
    if (m.currentValue !== 10_800) {
      violations.push(`currentValue must include PERFORMANCE (expected 10800), got ${m.currentValue}`);
    }
    if (m.allTimeReturnPct !== 8) {
      violations.push(`allTimeReturnPct must be 8 (800/10000), got ${m.allTimeReturnPct}`);
    }
    const series = computeEquitySeries(ledger);
    if (series.length === 0) {
      violations.push("a recorded PERFORMANCE figure must produce a non-empty equity series");
    }
    if (series.length > 0 && series[series.length - 1].value !== 10_800) {
      violations.push(
        `equity curve must end at 10800 after the performance figure, got ${series[series.length - 1].value}`,
      );
    }
  }

  // 4. A recorded loss preserves its sign → negative return, never coerced.
  {
    const ledger = [entry("DEPOSIT", 10_000, 30), entry("PERFORMANCE", -1_000, 1)];
    const m = computeMetrics(ledger);
    if (m.realizedPnl !== -1_000) {
      violations.push(`recorded loss must keep its sign (realizedPnl=-1000), got ${m.realizedPnl}`);
    }
    if (m.allTimeReturnPct !== -10) {
      violations.push(`recorded loss must yield a negative return (-10), got ${m.allTimeReturnPct}`);
    }
  }

  return {
    name: "investor-performance-metrics",
    ok: violations.length === 0,
    violations,
    notes:
      violations.length === 0
        ? [
            "deposits-only ledger keeps the honest empty performance state",
            "a real PERFORMANCE figure populates returns and moves the equity curve",
            "PERFORMANCE is excluded from contributions but included in current value",
            "recorded losses preserve their sign (negative return)",
          ]
        : [],
  };
}
