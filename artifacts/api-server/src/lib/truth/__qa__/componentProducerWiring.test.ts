import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { marketFixture, NOW } from "./marketEvidenceFixtures.js";
import { bindScannerSource } from "../../scannerInputIntegrity.js";
import { PgDialect } from "drizzle-orm/pg-core";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

let f = marketFixture({ timeframe: "M5", forming: true });
let wrongRowSource = false, wrongRowBar = false;
let candleCalls = 0, quoteCalls = 0;
let failWrite = false;
let newsCtx: Record<string, unknown> | null = null;
const memories = new Map<string, any>();
const dialect = new PgDialect();
const router = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", { namedExports: { ...router,
  routeCandles: async () => { candleCalls++; return f.result; }, routeQuote: async () => { quoteCalls++; return f.quote; },
} });
const dbModule = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...dbModule, db: {
  select: () => ({ from: (table: unknown) => ({ where: (where: any) => ({ limit: async () => {
    if (table !== dbModule.signalMemoryTable) return [];
    const value = memories.get(JSON.stringify(dialect.sqlToQuery(where).params));
    return value ? [value] : [];
  } }) }) }),
  insert: () => ({ values: (value: any) => ({ onConflictDoUpdate: async () => {
    if (failWrite) throw new Error("offline write failure");
    memories.set(JSON.stringify([value.userId, value.symbol, value.timeframe]), value);
  } }) }),
} } });
const scanner = await import("../../marketScanner.js");
mock.module("../../marketScanner.js", { namedExports: { ...scanner,
  scanSymbolTimeframe: async () => bindScannerSource({ symbol: "EURUSD", timeframe: "M5", dataSource: "LIVE_FEED", recommendedAction: "BUY", bias: "bullish", generatedAt: new Date(NOW).toISOString(),
    sufficiency: { canShowTradeSetup: true }, entry: 1.098, stopLoss: 1.097, takeProfit: 1.1, confidenceScore: 80, entrySniperScore: 80, setupType: "Trend", reasonForTrade: "", reasonToAvoid: "",
    patternImpact: { labelHint: "failed_setup", qualityCeiling: "low", conditional: false, contextOnly: false },
    featureSnapshot: { computedAt: wrongRowBar ? new Date(NOW - 60_000).toISOString() : f.evidence.lastClosedCandleAt } }, wrongRowSource ? "other-source" : f.evidence.sourceIdentity),
  decorateOpportunitiesWithNewsRisk: async (rows: Record<string, unknown>[]) => newsCtx ? rows.map((r) => ({ ...r, newsContext: newsCtx })) : rows,
} });
const loaders = await import("../../scalp/scalpServiceInputs.js");
mock.module("../../scalp/scalpServiceInputs.js", { namedExports: { ...loaders,
  loadExecutionInput: async () => null, loadSpecInput: async () => ({}), loadAccountInput: async () => ({}),
} });
const journal = await import("../../scalp/scalpJournalService.js");
mock.module("../../scalp/scalpJournalService.js", { namedExports: { ...journal, loadSymbolPersonality: async () => null } });
const scalpEngine = await import("../../scalp/scalpEngine.js");
let captured: Record<string, any> | undefined;
mock.module("../../scalp/scalpEngine.js", { namedExports: { ...scalpEngine, evaluateScalp: (input: Record<string, unknown>) => {
  captured = input; return { symbol: "EURUSD", direction: null, flame: { flameStage: "NONE" }, generatedAt: new Date(NOW).toISOString() };
} } });
const { buildRubyMarketEdgeForUser } = await import("../../signalIntelligence/signalIntelligenceService.js");
const { evaluateScalpForSymbol } = await import("../../scalp/scalpService.js");
const { getChartCandles } = await import("../../data/chart/chartDataService.js");
beforeEach(() => { f = marketFixture({ timeframe: "M5", forming: true }); wrongRowSource = wrongRowBar = false; candleCalls = quoteCalls = 0; captured = undefined; memories.clear(); failWrite = false; newsCtx = null; });

test("real Ruby service keeps closed-bar and user evidence, drops forming-price shocks", async () => {
  const before = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { skipPersist: true, scalp: null });
  assert.deepEqual(before.marketEvidence, { ...f.evidence, userId: 1 }); assert.equal(before.stopLoss, 1.097);
  const tip = f.result.candles.at(-1)!; tip.high = 50; tip.low = 0.01; tip.close = 0.02;
  const after = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { skipPersist: true, scalp: null });
  for (const key of ["direction", "bias", "stopLoss", "takeProfitZones", "scores", "regime", "marketEvidence"] as const) assert.deepEqual(after[key], before[key], key);
  assert.equal(candleCalls, 2); assert.equal(quoteCalls, 2);
});

for (const kind of ["source", "bar", "quote"] as const) test(`real Ruby service refuses scanner geometry with mismatched ${kind}`, async () => {
  if (kind === "source") wrongRowSource = true;
  if (kind === "bar") wrongRowBar = true;
  if (kind === "quote") f.quote.provenance!.bridgeConnectionId = 8;
  const result = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { skipPersist: true, scalp: null });
  assert.equal(result.stopLoss, null); assert.deepEqual(result.takeProfitZones, []);
});

test("real scalp focus uses one bound market window and records actual M5 user context", async () => {
  const result = await evaluateScalpForSymbol(1, { symbol: "EURUSD", mode: "ANY" });
  assert.deepEqual(result.marketEvidence, { ...f.evidence, userId: 1 });
  assert.equal(captured!.candles.length, 80); assert.equal(captured!.currentPrice, 1.098); assert.ok(captured!.scanner);
  assert.equal(captured!.patternImpact.status, "failed");
  assert.equal(candleCalls, 1); assert.equal(quoteCalls, 1);
});

for (const kind of ["source", "bar", "quote"] as const) test(`real scalp focus does not mix ${kind} into its scanner read`, async () => {
  if (kind === "source") wrongRowSource = true;
  if (kind === "bar") wrongRowBar = true;
  if (kind === "quote") f.quote.provenance!.bridgeConnectionId = 8;
  const result = await evaluateScalpForSymbol(1, { symbol: "EURUSD", mode: "ANY" });
  assert.equal(captured!.scanner, null);
  assert.equal(captured!.patternImpact, null, "rejected scanner patterns cannot re-enter through a separate engine input");
  if (kind === "quote") { assert.equal(captured!.currentPrice, null); assert.equal(result.marketEvidence, null); }
});

test("real Ruby producer binds durable continuity to source and never changes its public timeframe", async () => {
  const first = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { scalp: null });
  assert.deepEqual(first.continuity, { basis: "current_observation", saved: true });
  assert.equal(first.timeframe, "M5");
  const stored = [...memories.values()][0];
  assert.match(stored.timeframe, /^source-v1:/);
  stored.firstSeenAt = new Date(NOW - 30 * 60_000);
  const same = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { skipPersist: true, scalp: null });
  assert.equal(same.lifecycleStage, "EXPIRED");
  assert.deepEqual(same.continuity, { basis: "source_bound_memory", saved: false });
  f = marketFixture({ timeframe: "M5", source: "assistant_real:twelve_data" });
  const changed = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { skipPersist: true, scalp: null });
  assert.notEqual(changed.lifecycleStage, "EXPIRED");
  assert.deepEqual(changed.continuity, { basis: "current_observation", saved: false });
  assert.equal(memories.size, 1);
});

test("real Ruby producer ignores unbound legacy memory and failed writes never claim saved continuity", async () => {
  memories.set(JSON.stringify([1, "EURUSD", "M5"]), { userId: 1, symbol: "EURUSD", timeframe: "M5", direction: "BUY", generatedAt: new Date(NOW), firstSeenAt: new Date(NOW - 86_400_000) });
  failWrite = true;
  const result = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { scalp: null });
  assert.notEqual(result.lifecycleStage, "EXPIRED");
  assert.deepEqual(result.continuity, { basis: "current_observation", saved: false });
  assert.equal(memories.size, 1);
});

test("real Ruby service: a fallback 'none' news level is a default, not observed news safety", async () => {
  // The news decorator's catch path: provider unavailable → riskLevel "none", headlinesConnected false.
  newsCtx = { riskLevel: "none", headlinesConnected: false, warning: "News intelligence temporarily unavailable." };
  const fallback = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { skipPersist: true, scalp: null });
  assert.ok(fallback.scores.unmeasured?.includes("newsSafety"), JSON.stringify(fallback.scores.unmeasured));
  assert.ok(fallback.scores.unmeasured?.includes("execution"), "no bridge telemetry → execution is a default");
  assert.equal(fallback.confidenceBandBasis, "PARTIAL");
  // The provider answered → the same level is an observation; the score itself is unchanged.
  newsCtx = { riskLevel: "none", headlinesConnected: true, warning: "" };
  const answered = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { skipPersist: true, scalp: null });
  assert.ok(!answered.scores.unmeasured?.includes("newsSafety"));
  assert.equal(answered.scores.newsSafety, fallback.scores.newsSafety);
  assert.equal(answered.scores.overall, fallback.scores.overall);
});

test("actual chart producer emits same opaque source and preceding closed bar despite a future scheduled tip close", async () => {
  // EURUSD session profile reads are mocked via the local empty DB adapter above.
  const chart = await getChartCandles("EURUSD", "M5", 80, false);
  assert.deepEqual(chart.marketEvidence, f.evidence); assert.ok(Date.parse(chart.feedStatus.lastCandleTime!) > NOW);
  assert.equal(chart.candles.at(-1)!.isFinal, false);
});

if (process.env.ARX_TRUTH_REVIEW_PROBE) test("same actual producer inputs reproduce and close the review provenance gaps", async () => {
  const output = process.env.ARX_TRUTH_REVIEW_PROBE;
  assert.ok(output);
  assert.ok(process.env.ARX_TRUTH_BASELINE_SERVICE); assert.ok(process.env.ARX_TRUTH_BASELINE_SCALP);
  const oldRuby = (await import(pathToFileURL(process.env.ARX_TRUTH_BASELINE_SERVICE).href)).buildRubyMarketEdgeForUser;
  const oldScalp = (await import(pathToFileURL(process.env.ARX_TRUTH_BASELINE_SCALP).href)).evaluateScalpForSymbol;
  wrongRowSource = true;
  await oldScalp(1, { symbol: "EURUSD", mode: "ANY" });
  const beforePattern = captured!.patternImpact;
  await evaluateScalpForSymbol(1, { symbol: "EURUSD", mode: "ANY" });
  const afterPattern = captured!.patternImpact;
  assert.equal(beforePattern.status, "failed"); assert.equal(afterPattern, null);
  wrongRowSource = false;
  memories.set(JSON.stringify([1, "EURUSD", "M5"]), { userId: 1, symbol: "EURUSD", timeframe: "M5", direction: "BUY", bias: "bullish", regime: "TRENDING", lifecycleStage: "ACTIVE", confidenceBand: "HIGH", edgeScore: 80, overallScore: 80, generatedAt: new Date(NOW), firstSeenAt: new Date(NOW - 86_400_000) });
  const beforeRuby = await oldRuby(1, { symbol: "EURUSD", timeframe: "M5" }, { skipPersist: true, scalp: null });
  const afterRuby = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { skipPersist: true, scalp: null });
  assert.equal(beforeRuby.lifecycleStage, "EXPIRED"); assert.notEqual(afterRuby.lifecycleStage, "EXPIRED");
  writeFileSync(output, JSON.stringify({ sourceRejectedPattern: { before: beforePattern, after: afterPattern }, legacyUnboundMemory: { before: { firstSeenAt: beforeRuby.firstSeenAt, lifecycle: beforeRuby.lifecycleStage }, after: { firstSeenAt: afterRuby.firstSeenAt, lifecycle: afterRuby.lifecycleStage, continuity: afterRuby.continuity } }, limits: "Actual Ruby/scalp producer methods with offline I/O and a captured scalp-engine input; no provider/broker/network. Separate PostgreSQL tests validate real persistence." }, null, 2));
});
