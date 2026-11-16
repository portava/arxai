// The paper autopilot summary reads only the latest AUTOPILOT_SUMMARY_READ_LIMIT
// cycles. When all of them started today, "Cycles today" etc. are lower
// bounds; the summary must say so instead of presenting the window size as
// today's total.
process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { summarizeAutopilotCycles, AUTOPILOT_SUMMARY_READ_LIMIT } = await import("../aggregator.js");

type Row = Parameters<typeof summarizeAutopilotCycles>[0][number];

function cycle(i: number, startedAt: Date): Row {
  return {
    id: 1000 - i, userId: 7, autopilotCycleId: `apc_${i}`, status: "COMPLETED",
    startedAt, finishedAt: startedAt,
    paperTradesOpened: 1, paperTradesRejected: 0, paperTradesClosed: 0,
    debriefsTriggered: 0, learningEventsTriggered: 0,
  } as unknown as Row;
}

const NOW = new Date("2026-10-28T12:00:00.000Z");

describe("paper autopilot summary read window", () => {
  it("a full window of today's cycles is flagged as capped", () => {
    const rows = Array.from({ length: AUTOPILOT_SUMMARY_READ_LIMIT }, (_, i) => cycle(i, new Date(NOW.getTime() - i * 60_000)));
    const s = summarizeAutopilotCycles(rows, NOW);
    assert.equal(s.cycles_today, AUTOPILOT_SUMMARY_READ_LIMIT);
    assert.equal(s.today_counts_capped, true);
    assert.equal(s.cycles_read_limit, AUTOPILOT_SUMMARY_READ_LIMIT);
  });

  it("a window that reaches back before today is complete for today", () => {
    const rows = Array.from({ length: AUTOPILOT_SUMMARY_READ_LIMIT }, (_, i) =>
      cycle(i, i < 10 ? new Date(NOW.getTime() - i * 60_000) : new Date("2026-10-27T10:00:00.000Z")));
    const s = summarizeAutopilotCycles(rows, NOW);
    assert.equal(s.cycles_today, 10);
    assert.equal(s.today_counts_capped, false);
  });

  it("fewer cycles than the window are complete", () => {
    const s = summarizeAutopilotCycles([cycle(0, NOW)], NOW);
    assert.equal(s.cycles_today, 1);
    assert.equal(s.today_counts_capped, false);
    assert.equal(s.today_basis, "UTC");
  });
});

// autopilot_cycles.paper_trades_rejected (safety_blocks_today) is incremented
// for an AI hold, the daily loss limit, a sniper skip or an execution refusal.
// A symbol/timeframe check that throws (orchestrate, persistDecision, the
// market-data read…) lands in the cycle's errors and increments neither it nor
// paper_trades_opened, so a day of failing checks read "not opened: 0". The
// basis says what the count covers and the failed checks are counted
// separately (symbols_checked − opened − held/skipped/refused).
describe("paper autopilot: checks that failed are not hidden in the not-opened count", () => {
  function failing(i: number, over: Record<string, unknown>): Row {
    return { ...cycle(i, new Date(NOW.getTime() - i * 60_000)), ...over } as unknown as Row;
  }

  it("the held/skipped/refused basis says per symbol/timeframe check, and that failed checks are not in it", () => {
    const s = summarizeAutopilotCycles([cycle(0, NOW)], NOW);
    const basis = String(s.safety_blocks_today_basis);
    assert.match(basis, /symbol\/timeframe check/);
    assert.match(basis, /failed with an error is not counted here/i);
    assert.doesNotMatch(basis, /Counts each symbol a paper autopilot cycle did not open/);
  });

  it("a day of checks that threw is counted as failed checks, not as zero", () => {
    const rows = [
      failing(0, { status: "FAILED", symbolsChecked: 4, paperTradesOpened: 0, paperTradesRejected: 0, errors: ["EURUSD/M15: boom", "GBPUSD/M15: boom", "XAUUSD/M15: boom", "V75/M15: boom"] }),
      failing(1, { status: "FAILED", symbolsChecked: 4, paperTradesOpened: 1, paperTradesRejected: 1, errors: ["EURUSD/M15: boom", "GBPUSD/M15: boom"] }),
      failing(2, { status: "COMPLETED", symbolsChecked: 4, paperTradesOpened: 0, paperTradesRejected: 4, errors: [] }),
    ];
    const s = summarizeAutopilotCycles(rows, NOW, { wholeDay: true, last: rows[0] });
    assert.equal(s.safety_blocks_today, 5);
    assert.equal(s.symbol_checks_failed_today, 6);
    assert.equal(s.cycles_failed_today, 2);
    assert.equal(s.last_cycle?.symbol_checks_failed, 4);
  });

  it("a cycle row with no symbols_checked reports no failed checks rather than a negative count", () => {
    const s = summarizeAutopilotCycles([cycle(0, NOW)], NOW, { wholeDay: true });
    assert.equal(s.symbol_checks_failed_today, 0);
    assert.equal(s.cycles_failed_today, 0);
  });
});
