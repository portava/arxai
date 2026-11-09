// GET /backtest-runs/:id — what a stored run's numbers actually are.
//
// The backtest_runs metric columns default to 0, and the INSUFFICIENT_DATA
// path inserts a row without simulating anything. The detail route returned
// those zeros as plain finite numbers with nothing saying they were never
// measured, so every consumer other than the one patched dashboard card (the
// assistant, exports, other pages) read "win rate 0%, profit factor 0, P&L 0"
// as a result. And resolveRunDataReliability said reliable:true for a run on
// generated prices, as if a generated series were observed market depth.
//
// Only the database handle is stubbed; the real router handlers run. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/backtestRunMeasuredMetrics.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

let runRow: Record<string, unknown> = {};
let tradeRows: Array<Record<string, unknown>> = [];

function chain(rows: () => unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.where = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve().then(rows).then(resolve, reject);
  return q;
}
const fakeDb = {
  select: () => ({
    from: (t: unknown) => chain(() => (t === database.backtestRunsTable ? [runRow] : t === database.backtestTradesTable ? tradeRows : [])),
  }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
  insert: () => ({ values: () => ({ catch: () => undefined }) }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { default: router } = await import("../backtestRuns.js");

async function invoke(method: "get" | "post", path: string, id: number): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `missing route ${method} ${path}`);
  let status = 200;
  let body: any;
  const response = {
    status(n: number) { status = n; return this; },
    json(data: unknown) { body = data; return this; },
  };
  const request = {
    params: { id: String(id) }, query: {}, body: {},
    authUser: { id: 10, role: "user" },
    log: { error: () => {}, warn: () => {} },
  };
  const handlers = layer.route.stack;
  await handlers[handlers.length - 1].handle(request as unknown as Request, response as unknown as Response, () => {});
  return { status, body };
}

function row(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1, userId: 10, strategyId: "trendContinuation", symbol: "EURUSD", timeframe: "M15",
    startTime: new Date("2026-01-01T00:00:00Z"), endTime: new Date("2026-01-06T05:00:00Z"),
    initialBalance: 10_000, totalTrades: 0, winningTrades: 0, losingTrades: 0,
    netProfitLoss: 0, maxDrawdown: 0, winRate: 0, averageRr: 0, expectancy: 0, profitFactor: 0,
    status: "INSUFFICIENT_DATA", isVerified: "UNVERIFIED", dataSource: "broker", aiSummary: null,
    createdAt: new Date("2026-01-07T00:00:00Z"),
    ...patch,
  };
}

test("an INSUFFICIENT_DATA run says its metric zeros were not measured", async () => {
  runRow = row({});
  const { status, body } = await invoke("get", "/backtest-runs/:id", 1);
  assert.equal(status, 200);
  assert.ok(body.metricsMeasurement, "detail carries a metricsMeasurement statement");
  assert.equal(body.metricsMeasurement.measured, false);
  for (const f of ["winRate", "profitFactor", "netProfitLoss", "maxDrawdown", "averageRr", "expectancy"]) {
    assert.ok(body.metricsMeasurement.unmeasuredFields.includes(f), `${f} is listed as not measured`);
  }
  assert.match(body.metricsMeasurement.note, /not measured/);
  assert.match(body.metricsMeasurement.note, /placeholders, not results/);
});

test("a run with zero completed trades is not measured whatever its stored status", async () => {
  runRow = row({ status: "COMPLETED", dataSource: "synthetic" });
  const { body } = await invoke("get", "/backtest-runs/:id", 1);
  assert.equal(body.metricsMeasurement.measured, false);
});

test("a run that is not finished (pending / running / failed) is not measured", async () => {
  for (const s of ["PENDING", "RUNNING", "FAILED"]) {
    runRow = row({ status: s, totalTrades: 12, winRate: 0.5, profitFactor: 1.4 });
    const { body } = await invoke("get", "/backtest-runs/:id", 1);
    assert.equal(body.metricsMeasurement.measured, false, s);
  }
});

test("a completed run with simulated trades is measured and keeps its numbers", async () => {
  runRow = row({ status: "COMPLETED", totalTrades: 12, winningTrades: 7, losingTrades: 5, winRate: 0.58, profitFactor: 1.4, netProfitLoss: 0.012 });
  const { body } = await invoke("get", "/backtest-runs/:id", 1);
  assert.equal(body.metricsMeasurement.measured, true);
  assert.deepEqual(body.metricsMeasurement.unmeasuredFields, []);
  assert.equal(body.metricsMeasurement.note, null);
  assert.equal(body.winRate, 0.58);
  assert.equal(body.profitFactor, 1.4);
});

test("the list route carries the same measurement statement", async () => {
  runRow = row({});
  const layer = (router as any).stack.find((l: any) => l.route?.path === "/backtest-runs" && l.route.methods.get);
  let body: any;
  await layer.route.stack[layer.route.stack.length - 1].handle(
    { query: {}, authUser: { id: 10, role: "user" }, log: { error: () => {} } } as unknown as Request,
    { status() { return this; }, json(d: unknown) { body = d; return this; } } as unknown as Response,
    () => {},
  );
  assert.equal(body.runs[0].metricsMeasurement.measured, false);
});

test("a generated-price run is never reported as reliable data depth", async () => {
  // 500 M15 bars: deep enough that the depth axis alone is sufficient.
  const start = new Date("2024-01-01T00:00:00Z");
  runRow = row({
    status: "COMPLETED", dataSource: "synthetic", totalTrades: 20,
    startTime: start, endTime: new Date(start.getTime() + 499 * 15 * 60_000),
  });
  const { body } = await invoke("get", "/backtest-runs/:id", 1);
  assert.ok(body.dataReliability, "generated runs still report their bar count");
  assert.equal(body.dataReliability.availableClosedCandles, 500);
  assert.equal(body.dataReliability.reliable, false, "generated prices are not reliable market data");
  assert.equal(body.dataReliability.basis, "generated_prices");
  assert.match(body.dataReliability.note, /generated, not observed market history/);

  const series = await invoke("get", "/backtest-runs/:id/chart-series", 1);
  assert.equal(series.body.dataReliability.reliable, false);
});

test("the AI review's recomputed metrics say when nothing was measured", async () => {
  runRow = row({});
  tradeRows = [];
  const { body } = await invoke("post", "/backtest-runs/:id/ai-review", 1);
  assert.equal(body.metricsMeasurement.measured, false);
});
