// Real disposable database and actual route handlers; no HTTP server or broker.
import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { and, desc, eq, getTableColumns, getTableName, SQL } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import type { Request, Response } from "express";
import { PgDialect } from "drizzle-orm/pg-core";
const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
assert.equal(process.env.ARX_BACKTEST_EVIDENCE_PG, "1");
assert.equal(destination.pathname, "/arx_backtest_evidence_test");
assert.match(destination.searchParams.get("host") ?? "", /\/arx-backtest-evidence-[^/]+\/socket$/);
assert.equal(destination.username, "arx_qa");
mock.method(globalThis, "fetch", async () => { throw new Error("External request forbidden"); });
const { db, pool, backtestRunsTable: runs, backtestTradesTable: trades, vaultEventsTable: vault, brokerCandlesTable: bars, mt5ConnectionTable: bridges } = await import("@workspace/db");
const { loadDiagnosticBrokerHistory } = await import("../backtestHistory.js");
const { default: router, getLatestVerifiedRunForStrategy } = await import("../../../routes/backtestRuns.js");
const dialect = new PgDialect();
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
function value(v: unknown): string {
  if (v instanceof SQL) { const q = dialect.sqlToQuery(v); assert.equal(q.params.length, 0); return q.sql; }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${(typeof v === "string" ? v : JSON.stringify(v)).replaceAll("'", "''")}'`;
}
before(async () => {
  for (const table of [runs, trades, vault, bars, bridges]) {
    const columns = Object.values(getTableColumns(table)).map((c) => `${quote(c.name)} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${value(c.default)}` : ""}${c.primary ? " PRIMARY KEY" : ""}`);
    await pool.query(`CREATE TABLE ${quote(getTableName(table))} (${columns.join(",")})`);
  }
  await pool.query("CREATE UNIQUE INDEX broker_candles_bridge_sym_tf_time_uq ON broker_candles (bridge_connection_id,broker_symbol,timeframe,open_time_utc)");
  await pool.query("CREATE INDEX broker_candles_user_read_idx ON broker_candles (user_id,symbol,timeframe,open_time_utc)");
});
after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query("TRUNCATE backtest_runs, backtest_trades, vault_events, broker_candles, mt5_connection RESTART IDENTITY");
  await db.insert(bridges).values([{ id: 1, userId: 10 }, { id: 2, userId: 11 }, { id: 3, userId: 10 }]);
});
async function candle(patch: Partial<typeof bars.$inferInsert> = {}) {
  await db.insert(bars).values({ userId: 10, bridgeConnectionId: 1, accountNumber: "test-era", brokerSymbol: "EURUSD", symbol: "EURUSD", timeframe: "M15", openTimeUtc: new Date("2026-01-01"), isClosedBar: true, open: 1.1, high: 1.2, low: 1, close: 1.15, ...patch });
}
const historyArgs = { userId: 10, symbol: "EURUSD", timeframe: "M15", rangeStart: null, rangeEnd: null, maxBars: 500 };
async function invoke(method: string, path: string, args: { id?: number; userId?: number; body?: unknown } = {}) {
  const route = router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, `missing ${method} ${path}`);
  let status = 200; let body: any;
  const response = { status(n: number) { status = n; return this; }, json(data: unknown) { body = data; return this; } };
  const request = { authUser: { id: args.userId ?? 10, role: "TRADER" }, query: {}, params: { id: String(args.id ?? 1) }, body: args.body, log: { error: (...e: unknown[]) => { throw new Error(JSON.stringify(e)); } } };
  await route.stack[0].handle(request as unknown as Request, response as unknown as Response, () => {});
  return { status, body };
}
async function saved(userId = 10) {
  const [run] = await db.insert(runs).values({ userId, strategyId: "trendContinuation", symbol: "EURUSD", timeframe: "M15", startTime: new Date("2026-01-01"), endTime: new Date("2026-02-01"), initialBalance: 10000, totalTrades: 1000, winRate: .9, profitFactor: 20, netProfitLoss: 10000, status: "COMPLETED", dataSource: "broker", isVerified: "VERIFIED", aiSummary: "Verified and ready for live" }).returning();
  return run!;
}
test("history excludes another owner and a transferred bridge, preserving one exact source", async () => {
  await candle(); await candle({ userId: 11, bridgeConnectionId: 2, close: 1.18 });
  await candle({ userId: 10, bridgeConnectionId: 2, openTimeUtc: new Date("2026-01-02") });
  const out = await loadDiagnosticBrokerHistory(historyArgs);
  assert.equal(out.reason, "available_unattested"); assert.equal(out.candles.length, 1); assert.equal(out.candles[0]!.close, 1.15);
});
for (const patch of [{ bridgeConnectionId: 3 }, { brokerSymbol: "EURUSD.r" }, { accountNumber: "different-era", openTimeUtc: new Date("2026-01-01T00:15:00Z") }]) test(`ambiguous tuple ${JSON.stringify(patch)} is not timestamp-deduped`, async () => {
  await candle(); await candle(patch);
  assert.deepEqual(await loadDiagnosticBrokerHistory(historyArgs), { candles: [], reason: "ambiguous_source" });
});
test("forming, wrong symbol/timeframe and out-of-range rows do not qualify", async () => {
  await candle({ isClosedBar: false }); await candle({ symbol: "GBPUSD", brokerSymbol: "GBPUSD" }); await candle({ timeframe: "H1" });
  await candle({ openTimeUtc: new Date("2025-01-01") });
  const out = await loadDiagnosticBrokerHistory({ ...historyArgs, rangeStart: new Date("2026-01-01") });
  assert.deepEqual(out, { candles: [], reason: "unavailable" });
});
test("malformed OHLC is unavailable instead of a profitable input", async () => {
  await candle({ low: 3 }); assert.equal((await loadDiagnosticBrokerHistory(historyArgs)).reason, "invalid_bars");
});
test("future bars marked closed cannot become historical input", async () => {
  await candle({ openTimeUtc: new Date(Date.now() + 60000) });
  assert.equal((await loadDiagnosticBrokerHistory(historyArgs)).reason, "invalid_bars");
});
test("not-yet-closed interval cannot become historical input from a final flag alone", async () => {
  await candle({ openTimeUtc: new Date(Date.now() - 60000) });
  assert.equal((await loadDiagnosticBrokerHistory(historyArgs)).reason, "invalid_bars");
});
test("invalid infinite timestamp is unavailable without a formatter crash", async () => {
  await candle(); await pool.query("UPDATE broker_candles SET open_time_utc='infinity'::timestamptz");
  assert.equal((await loadDiagnosticBrokerHistory(historyArgs)).reason, "invalid_bars");
});
test("actual list/detail/AI routes ignore old VERIFIED flags and preserve stored history", async () => {
  const own = await saved(); await saved(11);
  const list = await invoke("get", "/backtest-runs"); assert.equal(list.body.runs.length, 1);
  assert.equal(list.body.runs[0].isVerified, "UNVERIFIED");
  const detail = await invoke("get", "/backtest-runs/:id", { id: own.id });
  assert.equal(detail.body.evidence.comparisonEligible, false); assert.equal(detail.body.dataReliability, undefined);
  assert.doesNotMatch(detail.body.aiSummary, /ready for live/);
  const stored = await pool.query("SELECT is_verified,ai_summary FROM backtest_runs WHERE id=$1", [own.id]);
  assert.equal(stored.rows[0].is_verified, "VERIFIED"); assert.equal(stored.rows[0].ai_summary, "Verified and ready for live");
  const review = await invoke("post", "/backtest-runs/:id/ai-review", { id: own.id });
  assert.equal(review.body.isVerified, "UNVERIFIED"); assert.match(review.body.aiSummary, /Diagnostic only/);
});
test("detail and AI review stay owner-scoped", async () => {
  const other = await saved(11);
  assert.equal((await invoke("get", "/backtest-runs/:id", { id: other.id })).status, 404);
  assert.equal((await invoke("post", "/backtest-runs/:id/ai-review", { id: other.id })).status, 404);
});
test("legacy shared verified lookup never supplies strategy authority", async () => {
  await saved(11); assert.equal(await getLatestVerifiedRunForStrategy("trendContinuation"), null);
});
test("new generated run is explicitly diagnostic and persisted unverified", async () => {
  const out = await invoke("post", "/backtest-runs", { body: { strategyId: "trendContinuation", symbol: "EURUSD", timeframe: "M15", candleCount: 100, seed: "offline-evidence-test" } });
  assert.equal(out.status, 200); assert.equal(out.body.dataSource, "synthetic");
  assert.equal(out.body.isVerified, "UNVERIFIED"); assert.equal(out.body.evidence.source, "generated_prices");
  assert.equal((await pool.query("SELECT is_verified FROM backtest_runs")).rows[0].is_verified, "UNVERIFIED");
});
test("ambiguous history never silently falls back to generated prices", async () => {
  await candle(); await candle({ bridgeConnectionId: 3 });
  const out = await invoke("post", "/backtest-runs", { body: { strategyId: "trendContinuation", symbol: "EURUSD", timeframe: "M15" } });
  assert.equal(out.body.status, "INSUFFICIENT_DATA"); assert.equal(out.body.historyStatus, "ambiguous_source");
  assert.equal(out.body.dataSource, "broker"); assert.equal((await pool.query("SELECT count(*)::int AS n FROM backtest_trades")).rows[0].n, 0);
});

test("paired local history-processing benchmark with real indexes", { skip: !process.env.ARX_BACKTEST_BENCHMARK_PATH }, async () => {
  for (let offset = 0; offset < 5000; offset += 500) {
    await db.insert(bars).values(Array.from({ length: 500 }, (_, n) => ({
      userId: 10, bridgeConnectionId: 1, accountNumber: "test-era", brokerSymbol: "EURUSD", symbol: "EURUSD", timeframe: "M15",
      openTimeUtc: new Date(Date.UTC(2026, 0, 1) + (offset + n) * 900000), isClosedBar: true,
      open: 1.1, high: 1.2, low: 1, close: 1.15, tickVolume: 10,
    })));
  }
  // Exact old loader algorithm from7cf745ff, on a single-owner source where
  // output is comparable. Its cross-owner failure is tested separately.
  const before = async () => {
    const rows = await db.select({ openTimeUtc: bars.openTimeUtc, open: bars.open, high: bars.high, low: bars.low, close: bars.close, tickVolume: bars.tickVolume })
      .from(bars).where(and(eq(bars.symbol, "EURUSD"), eq(bars.timeframe, "M15"), eq(bars.isClosedBar, true)))
      .orderBy(desc(bars.openTimeUtc)).limit(15000);
    const byOpen = new Map<number, typeof rows[number]>();
    for (const row of rows) if (!byOpen.has(row.openTimeUtc.getTime())) byOpen.set(row.openTimeUtc.getTime(), row);
    return [...byOpen.entries()].sort((a, b) => a[0] - b[0]).slice(-5000).map(([, r]) => ({ time: r.openTimeUtc.toISOString(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.tickVolume ?? 0 }));
  };
  const current = async () => (await loadDiagnosticBrokerHistory({ ...historyArgs, maxBars: 5000 })).candles;
  assert.deepEqual(await current(), await before());
  const samples = { before: [] as number[], current: [] as number[] };
  for (let i = 0; i < 110; i++) {
    for (const name of i % 2 ? ["before", "current"] as const : ["current", "before"] as const) {
      const at = performance.now(); const rows = await (name === "before" ? before() : current());
      const elapsed = performance.now() - at; assert.equal(rows.length, 5000);
      if (i >= 10) samples[name].push(elapsed);
    }
  }
  const summary = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { median: sorted[Math.ceil(sorted.length * .5) - 1]!, p95: sorted[Math.ceil(sorted.length * .95) - 1]!, p99: sorted[Math.ceil(sorted.length * .99) - 1]!, max: sorted[sorted.length - 1]! }; };
  const result = { workload: "5000 closed bars; one source; actual local PostgreSQL and existing indexes;100 paired trials after10warmups", before: summary(samples.before), current: summary(samples.current), samples, budgetP95Ms: 50, units: "milliseconds", scope: "completed database+mapping read; no browser/network/broker time" };
  writeFileSync(process.env.ARX_BACKTEST_BENCHMARK_PATH!, JSON.stringify(result, null, 2));
  assert.ok(result.current.p95 < 50, `current p95 ${result.current.p95}ms exceeds50ms`);
});
