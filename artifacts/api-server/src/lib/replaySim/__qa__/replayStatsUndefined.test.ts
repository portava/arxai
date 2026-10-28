// Regression: a replay with no closed trade reported win rate 0% and profit
// factor 0, and a replay with no losing trade reported profit factor 999 (a
// sentinel, not a ratio). The coach note then read "Win rate 0% on 0 trades"
// and the run was flagged "Setup underperformed" with nothing measured. The
// P&L figures carried no unit although they are candle price differences x
// position size, not money.
//
// The database is a stub that records inserts. The real engine runs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/replaySim/__qa__/replayStatsUndefined.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const fakeDb = {
  insert: (table: unknown) => ({ values: async (values: Record<string, unknown>) => { inserts.push({ table, values }); } }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { runReplay, generateReplayReport } = await import("../engine.js");
type Scenario = Parameters<typeof runReplay>[0];

function scenario(closes: number[]): Scenario {
  const candles = closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!;
    return { t: Date.UTC(2026, 0, 1) + i * 300_000, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 100 };
  });
  return { scenarioId: "scn_qa", title: "QA", symbol: "V75", timeframe: "M5", source: "SYNTHETIC", marketCondition: "RANGING", candles, notes: "" };
}

const lastRow = (table: unknown) => [...inserts].reverse().find((i) => i.table === table)?.values;

test("no closed trade: win rate and profit factor are null, not 0", async () => {
  const flat = scenario(Array.from({ length: 20 }, () => 1000));
  const run = await runReplay(flat, {});
  assert.equal(run.trades.length, 0);
  assert.equal(run.winRate, null);
  assert.equal(run.profitFactor, null);
  const report = await generateReplayReport(run, flat);
  assert.ok(!report.coach_notes.some((n) => /Win rate 0%/.test(n)), report.coach_notes.join(" | "));
  assert.ok(report.coach_notes.some((n) => /no win rate/i.test(n)), report.coach_notes.join(" | "));
  assert.equal(report.should_mark_for_review, false);
  assert.ok(!report.playbook_recommendations.some((r) => r.type === "REVIEW"));
  // NOT NULL columns keep the encoding stored rows have always had.
  assert.equal(lastRow(database.replayRunsTable)?.winRate, 0);
  assert.equal(lastRow(database.replayRunsTable)?.profitFactor, 0);
});

test("no losing trade: profit factor is null, not the 999 sentinel; P&L notes carry a unit", async () => {
  const rising = scenario(Array.from({ length: 60 }, (_, i) => 1000 + i));
  const run = await runReplay(rising, {});
  assert.ok(run.wins > 0, `expected winning trades, got ${run.wins}`);
  assert.equal(run.losses, 0);
  assert.equal(run.profitFactor, null);
  assert.equal(run.positionSize, 1);
  const report = await generateReplayReport(run, rising);
  assert.ok(!report.coach_notes.join(" ").includes("999"));
  assert.match(report.coach_notes.join(" "), /price points/);
  assert.equal(lastRow(database.replayRunsTable)?.profitFactor, 999);
});
