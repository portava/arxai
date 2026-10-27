import { after, before, beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { marketFixture, NOW } from "./marketEvidenceFixtures.js";
import { bindScannerSource } from "../../scannerInputIntegrity.js";

const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
assert.equal(process.env.ARX_TRUTH_MEMORY_PG, "1");
assert.equal(destination.pathname, "/arx_truth_memory_test");
assert.match(destination.searchParams.get("host") ?? "", /\/arx-truth-memory-[^/]+\/socket$/);
assert.equal(destination.username, "arx_qa");
const { db, pool, signalMemoryTable } = await import("@workspace/db");
mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected external request"); });
let f = marketFixture({ timeframe: "M5" });
const router = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", { namedExports: { ...router, routeCandles: async () => f.result, routeQuote: async () => f.quote } });
const scanner = await import("../../marketScanner.js");
mock.module("../../marketScanner.js", { namedExports: { ...scanner,
  scanSymbolTimeframe: async () => bindScannerSource({ symbol: f.evidence.symbol, timeframe: f.evidence.timeframe, dataSource: "LIVE_FEED", recommendedAction: "BUY", bias: "bullish", generatedAt: new Date().toISOString(),
    sufficiency: { canShowTradeSetup: true }, entry: 1.098, stopLoss: 1.097, takeProfit: 1.1, confidenceScore: 80, entrySniperScore: 80, setupType: "Trend", reasonForTrade: "", reasonToAvoid: "",
    featureSnapshot: { computedAt: f.evidence.lastClosedCandleAt } }, f.evidence.sourceIdentity),
  decorateOpportunitiesWithNewsRisk: async (rows: unknown[]) => rows,
} });
const loaders = await import("../../scalp/scalpServiceInputs.js");
mock.module("../../scalp/scalpServiceInputs.js", { namedExports: { ...loaders, loadExecutionInput: async () => null } });
const { buildRubyMarketEdgeForUser: build } = await import("../../signalIntelligence/signalIntelligenceService.js");
const read = (userId = 1, skipPersist = false) => build(userId, { symbol: f.evidence.symbol, timeframe: f.evidence.timeframe }, { scalp: null, skipPersist });
before(async () => {
  await pool.query(`CREATE TABLE signal_memory (
    id serial PRIMARY KEY, user_id integer NOT NULL, symbol text NOT NULL, timeframe text NOT NULL,
    bias text NOT NULL, direction text NOT NULL, regime text NOT NULL, lifecycle_stage text NOT NULL,
    confidence_band text NOT NULL, edge_score double precision NOT NULL DEFAULT 0, overall_score double precision NOT NULL DEFAULT 0,
    generated_at timestamptz NOT NULL DEFAULT now(), first_seen_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, symbol, timeframe))`);
});
beforeEach(async () => { await pool.query("TRUNCATE signal_memory RESTART IDENTITY"); f = marketFixture({ timeframe: "M5" }); });
after(async () => { await pool.end(); });

async function ageMemory() {
  await db.update(signalMemoryTable).set({ firstSeenAt: new Date(NOW - 1_800_000) });
}
test("actual composite key preserves same-source expiry across reads without exposing its private timeframe", async () => {
  const first = await read();
  assert.equal(first.timeframe, "M5");
  assert.deepEqual(first.continuity, { basis: "current_observation", saved: true });
  const [row] = await db.select().from(signalMemoryTable);
  assert.match(row!.timeframe, /^source-v1:/);
  await ageMemory();
  const next = await read(1, true);
  assert.equal(next.lifecycleStage, "EXPIRED");
  assert.deepEqual(next.continuity, { basis: "source_bound_memory", saved: false });
  assert.equal((await db.select().from(signalMemoryTable)).length, 1);
});

for (const context of ["provider", "bridge", "user", "timeframe", "symbol"] as const) test(`actual persisted Ruby lifecycle cannot cross ${context}`, async () => {
  await read(); await ageMemory();
  if (context === "provider") f = marketFixture({ timeframe: "M5", source: "assistant_real:twelve_data" });
  if (context === "bridge") f = marketFixture({ timeframe: "M5", bridge: 8 });
  if (context === "timeframe") f = marketFixture({ timeframe: "M15" });
  if (context === "symbol") f = marketFixture({ timeframe: "M5", symbol: "GBPUSD" });
  const changed = await read(context === "user" ? 2 : 1);
  assert.notEqual(changed.lifecycleStage, "EXPIRED");
  assert.deepEqual(changed.continuity, { basis: "current_observation", saved: true });
  assert.equal((await db.select().from(signalMemoryTable)).length, 2);
  f = marketFixture({ timeframe: "M5" });
  assert.equal((await read(1, true)).lifecycleStage, "EXPIRED", "returning to source cannot reset its persisted age");
});

test("legacy bare rows remain unchanged history and never seed new source continuity", async () => {
  await read();
  const [original] = await db.select().from(signalMemoryTable);
  await db.update(signalMemoryTable).set({ timeframe: "M5", firstSeenAt: new Date(NOW - 86_400_000) }).where(eq(signalMemoryTable.id, original!.id));
  const fresh = await read();
  assert.notEqual(fresh.lifecycleStage, "EXPIRED");
  const legacy = await db.select().from(signalMemoryTable).where(eq(signalMemoryTable.timeframe, "M5"));
  assert.equal(legacy.length, 1); assert.equal(legacy[0]!.firstSeenAt!.getTime(), NOW - 86_400_000);
});

test("read-only polls and failed writes do not manufacture durable continuity", async () => {
  assert.deepEqual((await read(1, true)).continuity, { basis: "current_observation", saved: false });
  assert.equal((await db.select().from(signalMemoryTable)).length, 0);
  await pool.query("CREATE FUNCTION qa_refuse_memory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'offline write failure'; END $$");
  await pool.query("CREATE TRIGGER qa_memory_failure BEFORE INSERT ON signal_memory FOR EACH ROW EXECUTE FUNCTION qa_refuse_memory()");
  try { assert.deepEqual((await read()).continuity, { basis: "current_observation", saved: false }); }
  finally { await pool.query("DROP TRIGGER qa_memory_failure ON signal_memory"); await pool.query("DROP FUNCTION qa_refuse_memory()"); }
  assert.equal((await db.select().from(signalMemoryTable)).length, 0);
});

test("future stored lifecycle timestamps cannot provide continuity", async () => {
  await read(); await db.update(signalMemoryTable).set({ generatedAt: new Date(NOW + 86_400_000), firstSeenAt: new Date(NOW + 86_400_000) });
  assert.equal((await read(1, true)).continuity!.basis, "current_observation");
});

test("local actual PostgreSQL service completion benchmark", { skip: !process.env.ARX_TRUTH_MEMORY_BENCHMARK }, async () => {
  const baseline = process.env.ARX_TRUTH_BASELINE_SERVICE;
  assert.ok(baseline, "provide the reviewed baseline service copy with unchanged relative imports");
  const previous = (await import(pathToFileURL(baseline).href)).buildRubyMarketEdgeForUser as typeof build;
  await read();
  const [row] = await db.select().from(signalMemoryTable);
  const { id: _id, ...data } = row!;
  await db.insert(signalMemoryTable).values({ ...data, timeframe: "M5" });
  const results: Record<string, unknown> = {};
  const stats = (values: number[]) => { values.sort((a, b) => a - b); return { median: values[Math.ceil(values.length * .5) - 1], p95: values[Math.ceil(values.length * .95) - 1], p99: values[Math.ceil(values.length * .99) - 1] }; };
  for (const [label, fn] of [["previous", previous], ["current", build]] as const) {
    const run = () => fn(1, { symbol: "EURUSD", timeframe: "M5" }, { scalp: null, skipPersist: true });
    for (let i = 0; i < 50; i++) await run();
    const invocation = [], completion = [];
    for (let i = 0; i < 500; i++) { const start = performance.now(); const promise = run(); invocation.push(performance.now() - start); await promise; completion.push(performance.now() - start); }
    results[label] = { invocationReturn: stats(invocation), completedService: stats(completion) };
  }
  writeFileSync(process.env.ARX_TRUTH_MEMORY_BENCHMARK!, JSON.stringify({ runtime: process.version, samples: 500, warmup: 50, fixture: "Actual Ruby service + disposable PostgreSQL memory lookup; 80 actual routed bars; provider/scanner/execution I/O stand-ins; same-source prior snapshot; read-only poll", milliseconds: results, limits: "Local processing and DB only. Invocation return is not UI acknowledgement. No provider or competitor latency measured; sequential DB dependency cannot overlap provider routing." }, null, 2));
});
