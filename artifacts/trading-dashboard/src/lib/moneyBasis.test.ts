// Money-basis contract for the cockpit + journal surfaces.
//
// Pins two defects the production-readiness audit confirmed:
//
//   • JOURNAL WIN RATE — win rate was `wins / entries.length`, where entries
//     includes rows with no P/L and rows logged as `WAIT` (a no-trade
//     OBSERVATION). Logging a WAIT dragged the displayed win rate down, and
//     the Win/Loss Report printed "N Trades · W Wins · L Losses" with
//     W + L < N and nothing explaining the gap.
//
//   • TRADING PERMISSION → RISK LEVEL — the row was
//     `envelope?.userRiskCaps ? "Managed" : "Low"` with a hardcoded green
//     class. `userRiskCaps` is a non-optional object, so the row was a
//     constant: "Managed" whenever the account-mode read SUCCEEDED, and the
//     even more reassuring green "Low" only when it FAILED or was loading.
//     It never inspected a single cap value.
//
// Run: pnpm --filter @workspace/trading-dashboard run test:money-basis

import { describe, it, expect } from "vitest";
import {
  isDecidedJournalEntry,
  resolveJournalStats,
  countRiskCaps,
  resolveRiskLevelRow,
} from "./moneyBasis";

describe("journal win-rate denominator", () => {
  it("treats a WAIT observation as undecided, not a loss", () => {
    expect(isDecidedJournalEntry({ pnl: 10, direction: "BUY" })).toBe(true);
    expect(isDecidedJournalEntry({ pnl: -10, direction: "SELL" })).toBe(true);
    expect(isDecidedJournalEntry({ pnl: 0, direction: "BUY" })).toBe(true);
    expect(isDecidedJournalEntry({ pnl: 10, direction: "WAIT" })).toBe(false);
    expect(isDecidedJournalEntry({ pnl: null, direction: "BUY" })).toBe(false);
    expect(isDecidedJournalEntry({ direction: "BUY" })).toBe(false);
    expect(isDecidedJournalEntry(undefined)).toBe(false);
  });

  it("does not drop the win rate when an unpriced entry or a WAIT is logged", () => {
    const twoWins = [
      { pnl: 10, direction: "BUY" },
      { pnl: 20, direction: "BUY" },
    ];
    expect(resolveJournalStats(twoWins).winRate).toBe(100);

    // Logging a WAIT observation and an unpriced trade must NOT move it.
    const plusNoise = [
      ...twoWins,
      { pnl: null, direction: "BUY" },
      { pnl: 5, direction: "WAIT" },
    ];
    const stats = resolveJournalStats(plusNoise);
    expect(stats.winRate).toBe(100);
    expect(stats.total).toBe(4);
    expect(stats.decided).toBe(2);
    expect(stats.undecided).toBe(2);
    // The old formula: 2 / 4 = 50%.
    expect(stats.winRate).not.toBe(50);
  });

  it("wins + losses always accounts for the whole decided denominator", () => {
    const stats = resolveJournalStats([
      { pnl: 10, direction: "BUY" },
      { pnl: -4, direction: "SELL" },
      { pnl: 0, direction: "BUY" },  // breakeven: decided, neither win nor loss
      { pnl: null, direction: "BUY" },
    ]);
    expect(stats.decided).toBe(3);
    expect(stats.wins + stats.losses).toBe(2);
    expect(stats.decided - (stats.wins + stats.losses)).toBe(1); // breakeven
  });

  it("reports null, not 0, when nothing is decided", () => {
    const stats = resolveJournalStats([
      { pnl: null, direction: "BUY" },
      { pnl: 3, direction: "WAIT" },
    ]);
    expect(stats.winRate).toBeNull();
    expect(stats.totalPnl).toBeNull();
    expect(resolveJournalStats([]).winRate).toBeNull();
  });

  it("sums P/L over decided entries only", () => {
    expect(
      resolveJournalStats([
        { pnl: 10, direction: "BUY" },
        { pnl: -4, direction: "SELL" },
        { pnl: 1000, direction: "WAIT" }, // an observation is not P/L
      ]).totalPnl,
    ).toBe(6);
  });
});

describe("Trading Permission → Risk level row", () => {
  it("is Unknown (never green) when the account-mode read failed", () => {
    const failed = resolveRiskLevelRow({ isError: true, hasEnvelope: false, caps: null });
    expect(failed.value).toBe("Unknown");
    expect(failed.tone).toBe("unknown");
    // The defect: a failed read produced the most reassuring value on the card.
    expect(failed.value).not.toBe("Low");
    expect(failed.tone).not.toBe("success");
  });

  it("is Unknown while the envelope is absent", () => {
    expect(resolveRiskLevelRow({ hasEnvelope: false }).tone).toBe("unknown");
  });

  it("warns when the envelope loaded but no cap is actually set", () => {
    const noCaps = resolveRiskLevelRow({
      hasEnvelope: true,
      caps: {
        maxLotSize: null,
        maxOpenTrades: null,
        maxDailyLossAmount: null,
        allowedSymbols: null,
        requireStopLoss: false,
      },
    });
    // Previously this exact user read a green "Managed".
    expect(noCaps.value).toBe("No caps set");
    expect(noCaps.tone).toBe("warning");
    expect(noCaps.capsSet).toBe(0);
  });

  it("only says Managed when a cap value is really present, and counts them", () => {
    const one = resolveRiskLevelRow({
      hasEnvelope: true,
      caps: { maxLotSize: 0.5, maxOpenTrades: null, maxDailyLossAmount: null, allowedSymbols: null, requireStopLoss: false },
    });
    expect(one.tone).toBe("success");
    expect(one.value).toBe("Managed (1 cap)");

    const three = resolveRiskLevelRow({
      hasEnvelope: true,
      caps: { maxLotSize: 0.5, maxOpenTrades: 3, maxDailyLossAmount: null, allowedSymbols: null, requireStopLoss: true },
    });
    expect(three.value).toBe("Managed (3 caps)");
  });

  it("counts every cap kind, including requireStopLoss and an allow-list", () => {
    expect(countRiskCaps(null)).toBe(0);
    expect(countRiskCaps({})).toBe(0);
    expect(countRiskCaps({ requireStopLoss: true })).toBe(1);
    expect(countRiskCaps({ allowedSymbols: [] })).toBe(1);
    expect(
      countRiskCaps({
        maxLotSize: 1,
        maxOpenTrades: 2,
        maxDailyLossAmount: 3,
        allowedSymbols: ["EURUSD"],
        requireStopLoss: true,
      }),
    ).toBe(5);
  });
});
