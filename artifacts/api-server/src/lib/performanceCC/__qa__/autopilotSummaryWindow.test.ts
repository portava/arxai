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
