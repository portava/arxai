// Market-edge scanner binding — levels-withheld-vs-shown (owner's [H]).
//
// The Eleanor Market Read card for V75 1m (Deriv public data) said "Live feed
// confirmed." while its levels were "withheld until the live feed confirms".
// The real cause: Deriv ticks carry a last price only, so no bid/ask spread can
// bind a quote to the candles, matchedMarketQuote returns null, and the scanner
// geometry gate in buildRubyMarketEdgeForUser silently drops the scanner read.
// This drives the REAL producer (offline router/db/scanner) and locks that the
// signal records WHICH gate dropped the scanner geometry and that the
// explanation states that cause — never "delayed" — while levels stay withheld.
//
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { marketFixture, NOW } from "./marketEvidenceFixtures.js";
import { bindScannerSource } from "../../scannerInputIntegrity.js";

let f = marketFixture({ timeframe: "M5", forming: true });
type Opp = Record<string, unknown>;
let oppOverride: ((base: Opp) => Opp | null) | null = null;

const router = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", { namedExports: { ...router,
  routeCandles: async () => f.result, routeQuote: async () => f.quote,
} });
const dbModule = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...dbModule, db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
} } });
const scanner = await import("../../marketScanner.js");
mock.module("../../marketScanner.js", { namedExports: { ...scanner,
  scanSymbolTimeframe: async () => {
    const base: Opp = {
      symbol: "EURUSD", timeframe: "M5", dataSource: "LIVE_FEED", recommendedAction: "BUY", bias: "bullish",
      generatedAt: new Date(NOW).toISOString(), sufficiency: { canShowTradeSetup: true },
      entry: 1.098, stopLoss: 1.097, takeProfit: 1.1, confidenceScore: 80, entrySniperScore: 80,
      setupType: "Trend", reasonForTrade: "", reasonToAvoid: "",
      featureSnapshot: { computedAt: f.evidence.lastClosedCandleAt },
    };
    const row = oppOverride ? oppOverride(base) : base;
    return row ? bindScannerSource(row, f.evidence.sourceIdentity) : null;
  },
  decorateOpportunitiesWithNewsRisk: async (rows: unknown[]) => rows,
} });
const loaders = await import("../../scalp/scalpServiceInputs.js");
mock.module("../../scalp/scalpServiceInputs.js", { namedExports: { ...loaders, loadExecutionInput: async () => null } });

const { buildRubyMarketEdgeForUser } = await import("../../signalIntelligence/signalIntelligenceService.js");
const { explainMarketRead } = await import("@workspace/domain/signal-intelligence");

beforeEach(() => { f = marketFixture({ timeframe: "M5", forming: true }); oppOverride = null; });

async function read() {
  const signal = await buildRubyMarketEdgeForUser(1, { symbol: "EURUSD", timeframe: "M5" }, { skipPersist: true, scalp: null });
  return { signal, explanation: explainMarketRead(signal) };
}

test("owner's case: a last-price-only quote (Deriv tick shape) records quote_last_only; levels stay withheld and the reason is the quote binding, not a delayed feed", async () => {
  f.quote.quote = { symbol: "EURUSD", last: 1.098, timestamp: new Date(NOW).toISOString() };
  // The scanner row in this state is not tradeable either (its own quote is unbound).
  oppOverride = (b) => ({ ...b, dataSource: "STALE_FEED", sufficiency: { canShowTradeSetup: false, reasonCode: "quote_unbound", humanReason: "x" } });
  const { signal, explanation } = await read();
  assert.equal(signal.dataSource, "LIVE_FEED", "the candles + ticks are live");
  assert.equal(signal.stopLoss, null);
  assert.equal(signal.entryZone, null);
  assert.equal(signal.invalidationPrice, null);
  assert.deepEqual(signal.scannerBinding, {
    bound: false,
    reasonCode: "quote_last_only",
    reason: "the live quote is last-price only — no bid/ask spread is bound to these candles",
  });
  const why = explanation.levelsWithheldReason ?? "";
  assert.match(why, /bid\/ask spread/);
  assert.doesNotMatch(why, /delayed|until the live feed/i);
  assert.match(explanation.simple.entryZone + explanation.simple.risk, /bid\/ask spread/);
  assert.equal(explanation.actionable, false);
});

test("bid == ask (zero observed spread) is also last-price only, never a zero-cost bound quote", async () => {
  f.quote.quote = { symbol: "EURUSD", bid: 1.098, ask: 1.098, last: 1.098, timestamp: new Date(NOW).toISOString() };
  const { signal } = await read();
  assert.equal(signal.scannerBinding?.reasonCode, "quote_last_only");
  assert.equal(signal.stopLoss, null);
});

test("a quote from a different bridge is 'no bound quote', not last-price only", async () => {
  f.quote.provenance!.bridgeConnectionId = 8;
  const { signal, explanation } = await read();
  assert.equal(signal.scannerBinding?.reasonCode, "no_bound_quote");
  assert.match(explanation.levelsWithheldReason ?? "", /no live quote from the same feed/);
});

test("no scanner row → no_scanner_read", async () => {
  oppOverride = () => null;
  const { signal, explanation } = await read();
  assert.equal(signal.scannerBinding?.reasonCode, "no_scanner_read");
  assert.match(explanation.levelsWithheldReason ?? "", /scanner has no current read/);
});

test("scanner withheld its own setup → setup_withheld cites the scanner's shared reason", async () => {
  oppOverride = (b) => ({ ...b, sufficiency: { canShowTradeSetup: false, humanReason: "Not enough closed candles yet (40/150) — waiting for more bars before showing a read." } });
  const { signal } = await read();
  assert.equal(signal.scannerBinding?.reasonCode, "setup_withheld");
  assert.match(signal.scannerBinding?.reason ?? "", /Not enough closed candles yet \(40\/150\)/);
  assert.equal(signal.stopLoss, null);
});

test("scanner row from another candle set → different_candles", async () => {
  oppOverride = (b) => ({ ...b, featureSnapshot: { computedAt: new Date(NOW - 3_600_000).toISOString() } });
  const { signal } = await read();
  assert.equal(signal.scannerBinding?.reasonCode, "different_candles");
});

test("bound quote + live scanner setup → bound, geometry published, no withheld reason", async () => {
  const { signal, explanation } = await read();
  assert.deepEqual(signal.scannerBinding, { bound: true, reasonCode: null, reason: null });
  assert.equal(signal.stopLoss, 1.097);
  assert.equal(explanation.levelsWithheldReason, null);
});

// RC5 — the scanner's real entry zone reaches the lifecycle engine. Before,
// oppToScannerInput never mapped it, so ENTRY_WINDOW_OPEN was unreachable and
// the read said "No precise entry level published yet" even with geometry.
test("bound BUY scanner row with an entry zone → the read can open its entry window and publishes that zone", async () => {
  oppOverride = (b) => ({ ...b, entryZone: { low: 1.0975, high: 1.0985 } });
  const { signal, explanation } = await read();
  assert.equal(signal.scannerBinding?.bound, true);
  assert.equal(signal.late.isLate, false);
  assert.equal(signal.lifecycleStage, "ENTRY_WINDOW_OPEN");
  assert.deepEqual(signal.entryZone, { from: 1.0975, to: 1.0985 });
  assert.deepEqual(explanation.levels.entryZone, { from: 1.0975, to: 1.0985 });
  assert.match(explanation.simple.entryZone, /^Entry zone 1\.0975–1\.0985\.$/);
});

test("a WAIT scanner row's entry zone is never setup evidence → no entry stage, no entry zone", async () => {
  oppOverride = (b) => ({ ...b, recommendedAction: "WAIT", entryZone: { low: 1.0975, high: 1.0985 } });
  const { signal } = await read();
  assert.notEqual(signal.lifecycleStage, "ENTRY_WINDOW_OPEN");
  assert.equal(signal.entryZone, null);
});
