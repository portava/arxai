// Regression: GET /paper-sessions/:id/report (getLatestReport) recomputed the
// header win rate from the stored counts, but returned the stored coach
// summary as written. A report stored before the classified-close fix said
// "4 closed trades (2W/1L/0BE), ..., win rate 50%" while the header on the
// same page said "67% of 3 with a recorded result" (and "win rate 0%" when no
// close had a result, next to "not available"). A report generated while the
// session was ACTIVE said "12m so far (session not ended)" forever after, and
// generatedAt was set to the time of the read, so nothing dated the report.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

const createdAt = new Date("2026-10-28T10:12:00Z");
let row: Record<string, unknown> = {};
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({ limit: async () => [row] }),
      }),
    }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { getLatestReport } = await import("../manager.js");

function stored(over: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionReportId: "psrpt_1", paperSessionId: "ps_1", status: "COMPLETE",
    startedAt: new Date("2026-10-28T10:00:00Z"), endedAt: new Date("2026-10-28T10:12:00Z"),
    durationMinutes: 12, totalTrades: 4, wins: 2, losses: 1, breakEven: 0, netPnl: 100, winRate: 50,
    ruleViolations: [], mistakesDetected: [], lessonsGenerated: [], nextBestActions: [], warnings: [],
    coachSummary: "", createdAt, ...over,
  };
}

test("an old stored summary does not state a different win rate from the recomputed header", async () => {
  row = stored({ coachSummary: "Paper-only session ps_1: 4 closed trades (2W/1L/0BE), net $1.00, win rate 50%. Live trading remains DISABLED." });
  const r = await getLatestReport("ps_1");
  assert.ok(r);
  assert.equal(r.win_rate, 67);
  assert.doesNotMatch(r.coach_summary, /win rate 50%/);
  assert.match(r.coach_summary, /win rate 67% of 3 closes with a recorded result/);
  assert.match(r.coach_summary, /1 without a recorded result/);
  assert.doesNotMatch(r.coach_summary, /Live trading remains DISABLED/);
});

test("an old stored summary with no recorded results does not say win rate 0%", async () => {
  row = stored({ totalTrades: 2, wins: 0, losses: 0, breakEven: 0, netPnl: 0, winRate: 0,
    coachSummary: "Paper-only session ps_1: 2 closed trades (0W/0L/0BE), net $0.00, win rate 0%. Live trading remains DISABLED." });
  const r = await getLatestReport("ps_1");
  assert.ok(r);
  assert.equal(r.win_rate, null);
  assert.doesNotMatch(r.coach_summary, /win rate 0%/);
  assert.match(r.coach_summary, /win rate not available/);
});

test("a report generated while the session was running is dated and says its duration is as of the report", async () => {
  row = stored({ status: "PARTIAL", endedAt: null,
    coachSummary: "Paper-only session ps_1: 0 closed trades (0W/0L/0BE), net $0.00, win rate not available (no close has a recorded result), 12m so far (session not ended). This paper session places no live orders.",
    totalTrades: 0, wins: 0, losses: 0, netPnl: 0 });
  const r = await getLatestReport("ps_1");
  assert.ok(r);
  assert.equal(r.duration_in_progress, true);
  assert.equal(r.report_generated_at, createdAt.toISOString());
  assert.equal(r.generatedAt, createdAt.toISOString(), "generatedAt is when the report was generated, not when it was read");
  assert.doesNotMatch(r.coach_summary, /so far \(session not ended\)/);
  assert.match(r.coach_summary, /12m so far as of this report \(the session had not ended when it was generated\)/);
});

test("a current-format stored summary is returned unchanged", async () => {
  const text = "Paper-only session ps_1: 4 closed trades (2W/1L/0BE, 1 without a recorded result), net $1.00, win rate 67% of 3 closes with a recorded result. This paper session places no live orders.";
  row = stored({ coachSummary: text });
  const r = await getLatestReport("ps_1");
  assert.equal(r!.coach_summary, text);
});
