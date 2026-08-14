// CI guard — investor equity curve honesty (Task #77)
//
// Proves the investor equity series (computeEquitySeries) is built ONLY from
// real, recorded ledger activity and never fabricates, projects, or interpolates
// values:
//
//   1. Empty ledger → empty series (the Performance tab keeps its honest empty
//      state; no zero/seed point is invented).
//   2. Deposits, withdrawals, and adjustments accumulate to the correct running
//      account value — the signed amounts are summed exactly, never smoothed.
//   3. Several entries on the same calendar day collapse to ONE end-of-day point
//      carrying the real end-of-day running value (no per-entry interpolation).
//   4. Output is chronologically ordered (ascending by timestamp).
//   5. An empty ledger reports hasPerformanceData=false via computeMetrics — no
//      ledger history means no performance data, never a fabricated figure.
//
// Pure logic — no DB, no network. Imports the real helpers so this stays in
// lockstep with production.
import type { CheckResult } from "./_lib.js";
import {
  computeEquitySeries,
  computeMetrics,
  round2,
} from "../../../artifacts/api-server/src/lib/investor/investorService.js";
import type { InvestorLedgerEntry } from "@workspace/db";

// Build a ledger entry at a fixed absolute instant so day-bucketing is
// deterministic regardless of when the test runs. `at` is an ISO timestamp.
function entryAt(
  entryType: string,
  signedAmount: number,
  at: string,
): InvestorLedgerEntry {
  return {
    entryType,
    signedAmount: String(signedAmount),
    createdAt: new Date(at),
  } as unknown as InvestorLedgerEntry;
}

export function checkInvestorEquitySeries(): CheckResult {
  const violations: string[] = [];

  // 1. Empty ledger → empty series. Nothing is seeded or projected.
  {
    const series = computeEquitySeries([]);
    if (series.length !== 0) {
      violations.push(
        `empty ledger must produce an empty series, got ${series.length} point(s)`,
      );
    }
  }

  // 2. Deposits / withdrawals / adjustments accumulate to the correct running
  //    value, one point per distinct day, in chronological order.
  {
    const ledger = [
      entryAt("DEPOSIT", 10_000, "2026-01-01T09:00:00.000Z"),
      entryAt("ADJUSTMENT", 250, "2026-01-02T09:00:00.000Z"),
      entryAt("WITHDRAWAL", -2_000, "2026-01-03T09:00:00.000Z"),
    ];
    const series = computeEquitySeries(ledger);
    const expected = [10_000, 10_250, 8_250];
    if (series.length !== expected.length) {
      violations.push(
        `three distinct days must produce ${expected.length} points, got ${series.length}`,
      );
    } else {
      for (let i = 0; i < expected.length; i++) {
        if (series[i].value !== expected[i]) {
          violations.push(
            `running value at point ${i} must be ${expected[i]}, got ${series[i].value}`,
          );
        }
      }
    }
  }

  // 3. Several entries on the SAME day collapse to one end-of-day point that
  //    carries the real end-of-day running value (no interpolation, no extra
  //    intra-day points).
  {
    const ledger = [
      entryAt("DEPOSIT", 5_000, "2026-02-10T08:00:00.000Z"),
      entryAt("DEPOSIT", 3_000, "2026-02-10T12:00:00.000Z"),
      entryAt("WITHDRAWAL", -1_000, "2026-02-10T18:00:00.000Z"),
      entryAt("DEPOSIT", 2_000, "2026-02-11T09:00:00.000Z"),
    ];
    const series = computeEquitySeries(ledger);
    if (series.length !== 2) {
      violations.push(
        `same-day entries must collapse to one point per day (expected 2), got ${series.length}`,
      );
    } else {
      // End-of-day-1 value = 5000 + 3000 - 1000 = 7000.
      if (series[0].value !== 7_000) {
        violations.push(
          `same-day collapse must carry the end-of-day value (7000), got ${series[0].value}`,
        );
      }
      // Day 2 = 7000 + 2000 = 9000.
      if (series[1].value !== 9_000) {
        violations.push(
          `day-2 running value must be 9000, got ${series[1].value}`,
        );
      }
      // The retained day-1 point must be the LAST entry of that day, not an
      // invented timestamp.
      if (series[0].at !== new Date("2026-02-10T18:00:00.000Z").toISOString()) {
        violations.push(
          `collapsed day point must use a real entry timestamp, got ${series[0].at}`,
        );
      }
    }
  }

  // 4. Output is strictly chronologically ordered even when the input ledger is
  //    shuffled (computeEquitySeries must sort, never trust input order).
  {
    const ledger = [
      entryAt("DEPOSIT", 1_000, "2026-03-05T09:00:00.000Z"),
      entryAt("DEPOSIT", 1_000, "2026-03-01T09:00:00.000Z"),
      entryAt("DEPOSIT", 1_000, "2026-03-03T09:00:00.000Z"),
    ];
    const series = computeEquitySeries(ledger);
    let ordered = true;
    for (let i = 1; i < series.length; i++) {
      if (new Date(series[i].at).getTime() < new Date(series[i - 1].at).getTime()) {
        ordered = false;
        break;
      }
    }
    if (!ordered) {
      violations.push("equity series must be chronologically ordered ascending");
    }
    // Running value must reflect chronological accumulation, not input order.
    const finalExpected = round2(3_000);
    if (series.length > 0 && series[series.length - 1].value !== finalExpected) {
      violations.push(
        `final running value must be ${finalExpected}, got ${series[series.length - 1].value}`,
      );
    }
  }

  // 5. Empty ledger → hasPerformanceData=false (no history ⇒ no performance).
  {
    const m = computeMetrics([]);
    if (m.hasPerformanceData) {
      violations.push("empty ledger must report hasPerformanceData=false");
    }
  }

  return {
    name: "investor-equity-series",
    ok: violations.length === 0,
    violations,
    notes:
      violations.length === 0
        ? [
            "empty ledger produces an empty series (no seeded/projected point)",
            "deposits/withdrawals/adjustments accumulate to the exact running value",
            "same-day entries collapse to one real end-of-day point",
            "series is chronologically ordered regardless of input order",
            "empty ledger reports hasPerformanceData=false",
          ]
        : [],
  };
}
