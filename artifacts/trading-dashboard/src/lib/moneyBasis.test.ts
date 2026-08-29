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
  resolvePermissionCardState,
  PERMISSION_UNREAD_HEADLINE,
  PERMISSION_LOADING_HEADLINE,
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

// ── Trading Permission card on an UNREAD account-mode ──────────────────────
//
// REVIEW FINDING (high): the risk row was fixed but the rest of the same card
// was not. `useTradingMode.fetchAccountMode` returns `null` on !res.ok, and a
// query that RESOLVES to null is not an error — so a failed permission read
// left `isError:false, isLoading:false, envelope:null` and every other field
// on the card fell through to its most reassuring default:
//   headline "Your account is approved for trading."  (from `|| ` fallback)
//   Blocked  green "No"                               (Boolean(null) === false)
//   Session  green "Active"                           (!isLoading && !frozen)
// while the status line simultaneously said "Waiting for approval".
describe("trading permission card — unread account mode", () => {
  const unread = {
    isLoading: false,
    isError: false,
    hasEnvelope: false,
    canManualTrade: false,
    cleanBlockedReason: null,
    cleanUserMessage: "",
  };

  it("never prints the approved-for-trading headline when nothing was read", () => {
    const s = resolvePermissionCardState(unread);
    expect(s.unread).toBe(true);
    expect(s.headline).toBe(PERMISSION_UNREAD_HEADLINE);
    expect(s.headline).not.toMatch(/approved for trading/i);
  });

  it("degrades Blocked and Session to Unknown, never a green default", () => {
    const s = resolvePermissionCardState(unread);
    expect(s.blockedRow).toEqual({ value: "Unknown", tone: "unknown" });
    expect(s.sessionRow).toEqual({ value: "Unknown", tone: "unknown" });
    expect(s.status).toEqual({ value: "Unknown", tone: "unknown" });
    // The whole card is muted — no row is green on a read that never landed.
    for (const row of [s.status, s.blockedRow, s.sessionRow]) {
      expect(row.tone).not.toBe("success");
    }
  });

  it("does not contradict itself: no 'waiting for approval' beside 'approved'", () => {
    const s = resolvePermissionCardState(unread);
    expect(s.status.value).not.toMatch(/waiting/i);
  });

  it("treats an explicit query error the same as a null envelope", () => {
    const s = resolvePermissionCardState({ ...unread, isError: true, hasEnvelope: true });
    expect(s.unread).toBe(true);
    expect(s.blockedRow.tone).toBe("unknown");
  });

  it("says it is still checking while the first read is in flight", () => {
    const s = resolvePermissionCardState({ ...unread, isLoading: true });
    expect(s.headline).toBe(PERMISSION_LOADING_HEADLINE);
    expect(s.status.tone).toBe("unknown");
  });
});

describe("trading permission card — read landed", () => {
  const read = {
    isLoading: false,
    isError: false,
    hasEnvelope: true,
    isFrozen: false,
    canManualTrade: true,
    cleanBlockedReason: null,
    cleanUserMessage: "",
  };

  it("reports All clear + Blocked:No only on a real successful read", () => {
    const s = resolvePermissionCardState(read);
    expect(s.unread).toBe(false);
    expect(s.status).toEqual({ value: "All clear", tone: "success" });
    expect(s.headline).toBe("Your account is approved for trading.");
    expect(s.blockedRow).toEqual({ value: "No", tone: "success" });
    expect(s.sessionRow).toEqual({ value: "Active", tone: "success" });
  });

  it("does not claim approval for a read account that cannot manually trade", () => {
    const s = resolvePermissionCardState({ ...read, canManualTrade: false });
    expect(s.status.value).toBe("Waiting for approval");
    expect(s.headline).not.toMatch(/is approved for trading/);
  });

  it("surfaces the block reason as the headline, and marks Blocked:Yes", () => {
    const s = resolvePermissionCardState({
      ...read,
      canManualTrade: false,
      cleanBlockedReason: "Your account is paused by your operator.",
    });
    expect(s.headline).toBe("Your account is paused by your operator.");
    expect(s.blockedRow).toEqual({ value: "Yes", tone: "danger" });
    expect(s.status.value).toBe("Trading blocked");
  });

  it("reports a frozen account as Paused with an inactive session", () => {
    const s = resolvePermissionCardState({ ...read, isFrozen: true });
    expect(s.status).toEqual({ value: "Paused", tone: "warning" });
    expect(s.sessionRow.value).toBe("Inactive");
    expect(s.sessionRow.tone).not.toBe("success");
  });
});
