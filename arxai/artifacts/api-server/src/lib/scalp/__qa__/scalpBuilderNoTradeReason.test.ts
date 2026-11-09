// Scalp Builder "no pick" reason. buildScalp always said "No clean scalp
// matches your target right now. Try ... a smaller target." even when no
// market had data to evaluate (every scan came back empty, or every market was
// AWAITING_DATA / closed). Nothing was checked against the target, so the
// reason must say the data was missing, not blame the target.
//
// Stubbed: the market scanner reads, the per-user loaders and the personality
// read. The real buildScalp and engine run. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/scalp/__qa__/scalpBuilderNoTradeReason.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { ScalpResult } from "../scalpTypes.js";

const realScanner = await import("../../marketScanner.js");
mock.module("../../marketScanner.js", {
  namedExports: {
    ...realScanner,
    scanSymbolTimeframe: async () => null,
    decorateOpportunitiesWithNewsRisk: async (o: unknown[]) => o,
  },
});

const realInputs = await import("../scalpServiceInputs.js");
mock.module("../scalpServiceInputs.js", {
  namedExports: {
    ...realInputs,
    loadAccountInput: async () => null,
    loadExecutionInput: async () => null,
    currentPriceFor: async () => null,
  },
});

const realJournal = await import("../scalpJournalService.js");
mock.module("../scalpJournalService.js", {
  namedExports: { ...realJournal, loadSymbolPersonality: async () => null },
});

const { buildScalp, builderNoTradeReason } = await import("../scalpService.js");

function result(status: ScalpResult["status"]): ScalpResult {
  return { status, direction: null, qualityScore: 0 } as unknown as ScalpResult;
}

test("builder: no market returned a read → missing data, not 'no scalp matches your target'", async () => {
  const r = await buildScalp(1, { mode: "ANY", marketGroup: "all", targetProfitAmount: 50 });
  assert.equal(r.primary, null);
  assert.equal(r.scanned, 0);
  assert.ok(r.noTradeReason, "a no-pick reason is given");
  assert.doesNotMatch(r.noTradeReason!, /No clean scalp matches your target/);
  assert.doesNotMatch(r.noTradeReason!, /smaller target/, "advised shrinking a target nothing was checked against");
  assert.match(r.noTradeReason!, /nothing was checked against your target/);
  assert.match(r.noTradeReason!, /missing data/);
});

test("builder reason: every market awaiting data or closed → nothing was evaluated", () => {
  const text = builderNoTradeReason(
    [result("AWAITING_DATA"), result("AWAITING_DATA"), result("MARKET_CLOSED")],
    "target",
  );
  assert.match(text, /None of the 3 markets in this group could be evaluated/);
  assert.match(text, /2 had no live price or broker specs/);
  assert.match(text, /1 is closed or not tradeable/);
  assert.doesNotMatch(text, /smaller target/);
});

test("builder reason: markets evaluated on live data but none clean → the target advice stands, with the count", () => {
  const text = builderNoTradeReason(
    [result("NO_CLEAN_SCALP"), result("SPREAD_TOO_WIDE"), result("AWAITING_DATA")],
    "target",
  );
  assert.match(text, /^2 of 3 markets had live data to evaluate \(1 could not be evaluated\)/);
  assert.match(text, /none gave a clean scalp for your target/);
  assert.match(text, /smaller target/);
});

test("builder reason: no target set → it does not talk about a target", () => {
  const text = builderNoTradeReason([result("NO_CLEAN_SCALP")], "settings");
  assert.match(text, /your settings/);
  assert.doesNotMatch(text, /target/);
});

// Round 3 review: with the economic calendar in fetch_error every non-synthetic
// market fails closed as NO_CLEAN_SCALP with newsRiskUnchecked. The reason
// counted those as evaluated on live data and blamed the target ("or a smaller
// target"); the cause was a news check that could not run.
function newsUnchecked(status: ScalpResult["status"] = "NO_CLEAN_SCALP"): ScalpResult {
  return { status, direction: null, qualityScore: 0, newsRiskUnchecked: true } as unknown as ScalpResult;
}
function awaiting(rejectReason: string): ScalpResult {
  return { status: "AWAITING_DATA", direction: null, qualityScore: 0, rejectReason } as unknown as ScalpResult;
}

test("builder reason: every market rejected because news could not be checked → not evaluated, no target advice", () => {
  const text = builderNoTradeReason([newsUnchecked(), newsUnchecked(), newsUnchecked()], "target");
  assert.doesNotMatch(text, /had live data to evaluate/, "news-unchecked markets were counted as evaluated");
  assert.doesNotMatch(text, /smaller target/, "blamed the target for a news check that could not run");
  assert.match(text, /None of the 3 markets in this group could be evaluated/);
  assert.match(text, /3 could not be checked for scheduled news/);
  assert.match(text, /economic calendar/);
  assert.match(text, /not a verdict on your target/);
});

test("builder reason: some evaluated, some news-unchecked → the count excludes them and says why", () => {
  const text = builderNoTradeReason([result("NO_CLEAN_SCALP"), newsUnchecked(), newsUnchecked()], "target");
  assert.match(text, /^1 of 3 markets had live data to evaluate \(2 could not be evaluated\)/);
  assert.match(text, /2 markets could not be checked for scheduled news/);
  assert.match(text, /smaller target/, "a market was evaluated, so the target advice stands");
});

test("builder reason: AWAITING_DATA is worded from its reject reason", () => {
  const text = builderNoTradeReason(
    [awaiting("INSUFFICIENT_DATA"), awaiting("NO_SPECS"), awaiting("NOT_LIVE"), awaiting("NO_SCANNER_READ")],
    "target",
  );
  assert.match(text, /1 did not have enough verified candles/);
  assert.match(text, /1 had no broker symbol details/);
  assert.match(text, /2 had no live price/);
  assert.doesNotMatch(text, /no live price or broker specs/, "a market with a live price was described as having none");
});

// Round 3 pass 3: rejectResult copies the scanner's newsRiskUnchecked onto
// EVERY reject, but the news gate runs only after the direction, stop-noise
// and spread checks. A market turned down for no clear direction or a too-wide
// spread would be turned down even if the calendar had answered, so it is
// evaluated — never counted as "could not be checked for scheduled news".
// Real engine results, not hand-built fixtures.
const { evaluateScalp } = await import("../scalpEngine.js");
const { evaluateMarketDataSufficiency } = await import("@workspace/domain/market");
type EngineInput = Parameters<typeof evaluateScalp>[0];
function engineInput(scanner: Record<string, unknown> = {}, spec: Record<string, unknown> = {}): EngineInput {
  return {
    symbol: "USDJPY",
    currentPrice: 150.0,
    spec: {
      hasBrokerTruth: true, tradeMode: "FULL", tradeAllowed: true, visible: true, marketOpen: true,
      digits: 3, point: 0.001, minLot: 0.01, maxLot: 100, lotStep: 0.01, contractSize: 100000,
      tickSize: 0.001, tickValue: 0.667, stopsLevelPoints: 0, spreadPoints: 10,
      category: "forex", displayName: "USDJPY", profitCurrency: "JPY", ...spec,
    },
    scanner: {
      bias: "bullish", recommendedAction: "BUY", confidenceScore: 82, entrySniperScore: 80,
      setupType: "Continuation", entry: 150.0, stopLoss: 149.8, takeProfit: 150.4,
      entryZone: { low: 149.98, high: 150.02 }, dataSource: "LIVE_FEED",
      sufficiency: evaluateMarketDataSufficiency({ symbol: "USDJPY", timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 300 }),
      newsRiskUnchecked: true,
      ...scanner,
    },
    account: { balance: 10000, equity: 10000, freeMargin: 10000, leverage: 100, currency: "USD" },
    mode: "ANY",
    riskAmount: 100,
    now: 1_780_000_000_000,
  } as unknown as EngineInput;
}

test("builder reason: no-direction and spread-too-wide rejects are evaluated, not blamed on the news check", () => {
  const noDirection = evaluateScalp(engineInput({ bias: "neutral", recommendedAction: "REJECT" }));
  const spreadWide = evaluateScalp(engineInput({}, { spreadPoints: 150 }));
  const newsGate = evaluateScalp(engineInput());
  // Fixture sanity: each reject came from the gate the test names, and all
  // three carry the copied newsRiskUnchecked flag.
  assert.equal(noDirection.status, "NO_CLEAN_SCALP");
  assert.match(noDirection.noTradeReason ?? "", /Best action: wait/);
  assert.equal(spreadWide.status, "SPREAD_TOO_WIDE");
  assert.equal(newsGate.status, "NO_CLEAN_SCALP");
  assert.match(newsGate.noTradeReason ?? "", /news risk could not be checked/i);
  for (const r of [noDirection, spreadWide, newsGate]) assert.equal(r.newsRiskUnchecked, true);

  const text = builderNoTradeReason([noDirection, spreadWide, newsGate], "target");
  assert.match(text, /^2 of 3 markets had live data to evaluate \(1 could not be evaluated\)/, text);
  assert.match(text, /1 market could not be checked for scheduled news/, text);
  assert.doesNotMatch(text, /[23] markets? could not be checked for scheduled news/, text);

  const onlyEarlier = builderNoTradeReason([noDirection, spreadWide], "target");
  assert.doesNotMatch(onlyEarlier, /scheduled news/, onlyEarlier);
  assert.match(onlyEarlier, /^2 of 2 markets had live data to evaluate; none gave a clean scalp/, onlyEarlier);
});
