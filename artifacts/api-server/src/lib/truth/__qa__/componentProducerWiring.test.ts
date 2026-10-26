import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { marketFixture, NOW } from "./marketEvidenceFixtures.js";
import { bindScannerSource } from "../../scannerInputIntegrity.js";

let f = marketFixture({ timeframe: "M5", forming: true });
let wrongRowSource = false, wrongRowBar = false;
let candleCalls = 0, quoteCalls = 0;
const router = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", { namedExports: { ...router,
  routeCandles: async () => { candleCalls++; return f.result; }, routeQuote: async () => { quoteCalls++; return f.quote; },
} });
const dbModule = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...dbModule, db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } } });
const scanner = await import("../../marketScanner.js");
mock.module("../../marketScanner.js", { namedExports: { ...scanner,
  scanSymbolTimeframe: async () => bindScannerSource({ symbol: "EURUSD", timeframe: "M5", dataSource: "LIVE_FEED", recommendedAction: "BUY", bias: "bullish", generatedAt: new Date(NOW).toISOString(),
    sufficiency: { canShowTradeSetup: true }, entry: 1.098, stopLoss: 1.097, takeProfit: 1.1, confidenceScore: 80, entrySniperScore: 80, setupType: "Trend", reasonForTrade: "", reasonToAvoid: "",
    featureSnapshot: { computedAt: wrongRowBar ? new Date(NOW - 60_000).toISOString() : f.evidence.lastClosedCandleAt } }, wrongRowSource ? "other-source" : f.evidence.sourceIdentity),
  decorateOpportunitiesWithNewsRisk: async (rows: unknown[]) => rows,
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
beforeEach(() => { f = marketFixture({ timeframe: "M5", forming: true }); wrongRowSource = wrongRowBar = false; candleCalls = quoteCalls = 0; captured = undefined; });

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
  assert.equal(candleCalls, 1); assert.equal(quoteCalls, 1);
});

for (const kind of ["source", "bar", "quote"] as const) test(`real scalp focus does not mix ${kind} into its scanner read`, async () => {
  if (kind === "source") wrongRowSource = true;
  if (kind === "bar") wrongRowBar = true;
  if (kind === "quote") f.quote.provenance!.bridgeConnectionId = 8;
  const result = await evaluateScalpForSymbol(1, { symbol: "EURUSD", mode: "ANY" });
  assert.equal(captured!.scanner, null);
  if (kind === "quote") { assert.equal(captured!.currentPrice, null); assert.equal(result.marketEvidence, null); }
});

test("actual chart producer emits same opaque source and preceding closed bar despite a future scheduled tip close", async () => {
  // EURUSD session profile reads are mocked via the local empty DB adapter above.
  const chart = await getChartCandles("EURUSD", "M5", 80, false);
  assert.deepEqual(chart.marketEvidence, f.evidence); assert.ok(Date.parse(chart.feedStatus.lastCandleTime!) > NOW);
  assert.equal(chart.candles.at(-1)!.isFinal, false);
});
