// Regression: the session report counted a CLOSE link whose result was never
// recorded (link-trade body omitted `result`, stored null) in total_trades and
// in the win-rate denominator, so "4 (2W/1L/0BE)" did not sum and "win rate
// 50%" understated 2 of 3 classified closes (67%). An un-ended session's
// duration ran to "now" with nothing saying it was still in progress.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
const schema = await import("@workspace/db/schema");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

let endedAt: Date | null = new Date("2026-10-28T10:30:00Z");
let status = "ENDED";
let links: Array<{ action: string; result: string | null; pnl: number }> = [];
const inserted: Array<Record<string, unknown>> = [];

function sessionRow() {
  return {
    paperSessionId: "ps_1", userId: 7, status,
    startedAt: new Date("2026-10-28T10:00:00Z"), endedAt,
    symbols: [], timeframes: [], sessionGoals: {}, sessionRules: { maxPaperTrades: 10, maxSessionLoss: 100000, maxSessionMinutes: 600 },
    preflightStatus: {}, readinessGateStatus: {}, riskGovernorStatus: {}, securityStatus: {},
    activeWarnings: [], paperTradesOpened: 4, paperTradesClosed: 4, netPnl: 0, winRate: 0,
    mistakesDetected: [], lessonsGenerated: [], nextBestActions: [],
  };
}
const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => (table === schema.paperSessionsTable ? [sessionRow()] : []),
        orderBy: async () => (table === schema.paperSessionTradeLinksTable ? links : []),
      }),
    }),
  }),
  insert: (table: unknown) => ({
    values: async (v: Record<string, unknown>) => { if (table === schema.paperSessionReportsTable) inserted.push(v); },
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { generateSessionReport } = await import("../manager.js");

test("W/L/BE plus unclassified sums to total and win rate counts only classified closes", async () => {
  links = [
    { action: "CLOSE", result: "WIN", pnl: 100 },
    { action: "CLOSE", result: "WIN", pnl: 100 },
    { action: "CLOSE", result: "LOSS", pnl: -50 },
    { action: "CLOSE", result: null, pnl: 0 },
    { action: "OPEN", result: null, pnl: 0 },
  ];
  const r = await generateSessionReport(7, "ps_1");
  assert.ok(r);
  assert.equal(r.total_trades, 4);
  assert.equal(r.unclassified, 1);
  assert.equal(r.wins + r.losses + r.break_even + r.unclassified, r.total_trades);
  assert.equal(r.win_rate, 67);
  assert.match(r.coach_summary, /1 without a recorded result/);
  assert.match(r.coach_summary, /win rate 67%/);
  assert.equal(inserted.at(-1)!.winRate, 67);
});

test("no classified closes gives no win rate, not 0%", async () => {
  links = [{ action: "CLOSE", result: null, pnl: 0 }];
  const r = await generateSessionReport(7, "ps_1");
  assert.ok(r);
  assert.equal(r.win_rate, null);
  assert.doesNotMatch(r.coach_summary, /win rate 0%/);
  assert.match(r.coach_summary, /win rate not available/);
});

test("an un-ended session marks its duration as still running", async () => {
  endedAt = null; status = "ACTIVE";
  links = [];
  const r = await generateSessionReport(7, "ps_1");
  assert.ok(r);
  assert.equal(r.status, "PARTIAL");
  assert.equal(r.duration_in_progress, true);
  endedAt = new Date("2026-10-28T10:30:00Z"); status = "ENDED";
  const done = await generateSessionReport(7, "ps_1");
  assert.equal(done!.duration_in_progress, false);
  assert.equal(done!.duration_minutes, 30);
});
