// Constructed deterministic CORRECTNESS fixtures, not recorded market data.
// This suite proves point-in-time containment and stable replay, never trading
// performance. Router and advisory seams are isolated; no DB/provider is read.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MIN_SUFFICIENT_CLOSED_BARS } from "@workspace/domain/market";
import { categorizeOpportunities } from "@workspace/domain/signal-intelligence";
import type { MarketCandlesResult, MarketQuoteResult } from "../data/marketDataRouter.js";
import type { Candle } from "../data/types.js";
import { prepareScannerCandles } from "../scannerInputIntegrity.js";
import { timeframeMs, type ChartTimeframe } from "../data/chart/timeframes.js";

const BASE = Date.parse("2026-10-26T15:00:00Z");
let candlesByKey = new Map<string, Candle[]>();
let provider = "mt5_broker";
let bridge = 1;
let quoteTime = BASE;
const realRouter = await import("../data/marketDataRouter.js");
const realAdvisory = await import("../agentEcosystem/advisoryInfluence.js");
mock.module("../agentEcosystem/advisoryInfluence.js", { namedExports: { ...realAdvisory,
  computeScannerAdvisory: async () => null,
} });
const provenance = (symbol: string, timeframe?: string) => ({ providerId: provider.startsWith("assistant_real:") ? "assistant_real" as const : "mt5_broker" as const,
  subProviderId: null, brokerCode: provider.startsWith("assistant_real:") ? "third_party" as const : "mt5" as const, bridgeConnectionId: bridge, userId: 1, brokerSymbol: symbol,
  environment: "demo" as const, receivedAt: new Date(Date.now()).toISOString(), delayed: false,
  source: timeframe ? "DERIVED" as const : "LIVE_TICK" as const,
  sourceId: `${provider}:${symbol}${timeframe ? `:${timeframe}` : ""}`,
});
function result(symbol: string, timeframe: string): MarketCandlesResult {
  return { ok: true, symbol, assetClass: symbol === "BTCUSD" ? "crypto" : "forex", primaryProvider: provider,
    candles: structuredClone(candlesByKey.get(`${symbol}:${timeframe}`) ?? []), provenance: provenance(symbol, timeframe),
    attempts: [], userMessage: "Constructed correctness fixture", adminDetail: "" };
}
mock.module("../data/marketDataRouter.js", { namedExports: { ...realRouter,
  routeCandles: async (symbol: string, timeframe: string): Promise<MarketCandlesResult> => result(symbol, timeframe),
  routeQuote: async (symbol: string): Promise<MarketQuoteResult> => ({ ok: true, symbol,
    assetClass: symbol === "BTCUSD" ? "crypto" : "forex", primaryProvider: provider,
    quote: { symbol, bid: 1.106, ask: 1.1061, spread: 0.0001, timestamp: new Date(quoteTime).toISOString() },
    provenance: provenance(symbol), attempts: [], userMessage: "Constructed correctness fixture", adminDetail: "" }),
} });
const { scanSymbolTimeframe, scanOnceSnapshot, effectiveOpportunityScore } = await import("../marketScanner.js");
const { toInput } = await import("../signalIntelligence/opportunityMapService.js");
const { __resetRegimeStateForTests } = await import("../regime/marketRegimeAuthority.js");

/** Every price here is deliberately constructed, not a historical observation. */
function bars(tf: ChartTimeframe = "M5", lastClose = BASE, count = 60): Candle[] {
  const interval = timeframeMs(tf);
  return Array.from({ length: count }, (_, i) => {
    const price = 1.1 + i * 0.0001 + (i % 3) * 0.00001;
    return { time: new Date(lastClose - (count - i) * interval + (provider.startsWith("assistant_real:") ? interval : 0)).toISOString(),
      open: price, high: price + 0.0002, low: price - 0.0001, close: price + 0.0001, volume: 100 + i % 4 };
  });
}
function install(candles: Candle[], symbol = "EURUSD", tf = "M5") { candlesByKey.set(`${symbol}:${tf}`, candles); }
function tail(time: number, sample: Candle): Candle { return { ...sample, time: new Date(time).toISOString(), high: 2, low: 0.5, close: 1.8 }; }
function resetState() { __resetRegimeStateForTests(); }
beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: BASE });
  provider = "mt5_broker"; bridge = 1; quoteTime = BASE; candlesByKey = new Map(); resetState();
});
afterEach(() => { mock.timers.reset(); resetState(); });

for (const source of ["mt5_broker", "assistant_real:twelve_data"]) {
  for (const suffix of ["forming", "future"] as const) {
    test(`${source}: ${suffix} suffix cannot promote stale closed history`, async () => {
      provider = source;
      const interval = timeframeMs("M5");
      const closed = bars("M5", BASE - 3 * interval);
      install(closed);
      const before = await scanSymbolTimeframe("EURUSD", "M5");
      const stamp = BASE + (suffix === "future" ? 10 * interval : 0) + (source.startsWith("assistant_real:") ? interval : 0);
      install([...closed, tail(stamp, closed.at(-1)!)]);
      const after = await scanSymbolTimeframe("EURUSD", "M5");
      assert.ok(before && after);
      assert.equal(before.dataStatus, "stale");
      assert.equal(after.dataStatus, "stale"); assert.equal(after.tradeable, false);
      assert.deepEqual(after, before, "future/forming data must not alter the earlier signal or features");
      assert.equal(prepareScannerCandles(result("EURUSD", "M5"), "EURUSD", "M5", BASE)?.trailingIntervals, 4);
    });
  }
}

test("re-reading the same old candles does not reset their original age", async () => {
  install(bars());
  const first = await scanSymbolTimeframe("EURUSD", "M5");
  assert.equal(first?.dataStatus, "live");
  mock.timers.setTime(BASE + 3 * timeframeMs("M5")); quoteTime = Date.now();
  const later = await scanSymbolTimeframe("EURUSD", "M5");
  assert.equal(later?.dataStatus, "stale"); assert.equal(later?.tradeable, false);
  assert.equal(later?.featureSnapshot?.computedAt, first?.featureSnapshot?.computedAt);
});

test("future-only reads and invalid/conflicting suffixes refuse rather than improving readiness", async () => {
  const clean = bars();
  const future = tail(BASE + 3 * timeframeMs("M5"), clean.at(-1)!);
  for (const input of [[future], [...clean, { ...future, high: NaN }],
    [...clean, { ...clean[0]!, close: clean[0]!.close + 0.00001 }], [...clean, { ...future, time: "invalid" }]]) {
    resetState(); install(input);
    const row = await scanSymbolTimeframe("EURUSD", "M5");
    assert.equal(row?.dataStatus, "no_data"); assert.equal(row?.tradeable, false); assert.equal(row?.confidenceScore, 0);
  }
});

test("actual H1 :30 session boundary stays current until the next closed bar is due", async () => {
  const lastClose = Date.parse("2026-10-26T14:30:00Z");
  install(bars("H1", lastClose), "EURUSD", "H1");
  mock.timers.setTime(Date.parse("2026-10-26T15:29:59.999Z")); quoteTime = Date.now();
  assert.equal(prepareScannerCandles(result("EURUSD", "H1"), "EURUSD", "H1", Date.now())?.trailingIntervals, 1);
  assert.equal((await scanSymbolTimeframe("EURUSD", "H1"))?.dataStatus, "live");
  mock.timers.setTime(Date.parse("2026-10-26T15:30:00Z")); quoteTime = Date.now();
  assert.equal((await scanSymbolTimeframe("EURUSD", "H1"))?.dataStatus, "stale");
  install(bars("H1", Date.now()), "EURUSD", "H1");
  assert.equal((await scanSymbolTimeframe("EURUSD", "H1"))?.dataStatus, "live");
});

test("session gaps are preserved without padding; continuous-market gaps cannot borrow old depth", async () => {
  const input = bars();
  // A missing middle period is retained as absent. This is not a declaration
  // that a particular exchange was open or closed at that moment.
  input.splice(20, 1);
  install(input);
  const accepted = prepareScannerCandles(result("EURUSD", "M5"), "EURUSD", "M5", BASE)!;
  assert.deepEqual(accepted.rawClosed, input); assert.equal(accepted.rawClosed.length, 59);
  assert.equal(accepted.trailingIntervals, 1);
  install(input, "BTCUSD");
  assert.equal(prepareScannerCandles(result("BTCUSD", "M5"), "BTCUSD", "M5", BASE)?.rawClosed.length, 39);
  const broken = bars(); broken.splice(60 - MIN_SUFFICIENT_CLOSED_BARS, 1); install(broken, "BTCUSD");
  const row = await scanSymbolTimeframe("BTCUSD", "M5");
  assert.equal(row?.dataStatus, "no_data"); assert.equal(row?.tradeable, false);
});

test("a source switch resets regime confirmation and old-source replay is reproducible", async () => {
  install(bars());
  const first = await scanSymbolTimeframe("EURUSD", "M5");
  bridge = 2;
  const other = await scanSymbolTimeframe("EURUSD", "M5");
  assert.deepEqual(other?.regime, first?.regime);
  bridge = 1;
  assert.deepEqual(await scanSymbolTimeframe("EURUSD", "M5"), first);
});

test("deterministic point-in-time replay: future suffix mutations never change prior signals or ranking", async () => {
  const interval = timeframeMs("M5");
  // Three independently named input streams share constructed prices to test
  // tie handling. This intentionally makes no instrument-return assertion.
  const symbols = ["EURUSD", "GBPUSD", "USDJPY"];
  const full = bars("M5", BASE + 8 * interval, 68);
  async function replay(includeSuffix: boolean, requestSymbols: string[]) {
    resetState(); const reports = [];
    for (let step = 0; step < 5; step++) {
      const asOf = BASE + step * interval; mock.timers.setTime(asOf); quoteTime = asOf;
      const prefix = full.slice(step, 60 + step);
      const suffix = full.slice(60 + step).map((bar) => ({ ...bar, high: 3, low: 0.4, close: 2.5 }));
      for (const symbol of symbols) install(includeSuffix ? [...prefix, ...suffix] : prefix, symbol);
      const inputBefore = JSON.stringify([...candlesByKey]);
      const snapshot = await scanOnceSnapshot({ symbols: requestSymbols, timeframes: ["M5"] });
      assert.equal(JSON.stringify([...candlesByKey]), inputBefore, "the scanner may not mutate provider inputs");
      assert.ok(snapshot.opportunities.every((row) => row.featureSnapshot?.computedAt === new Date(asOf).toISOString()));
      // No lateness data is invented: toInput's real timing-unknown cap applies.
      const map = categorizeOpportunities(snapshot.opportunities.map((row) => toInput(row, null)));
      reports.push({ asOf, rows: snapshot.opportunities, effective: snapshot.opportunities.map(effectiveOpportunityScore), map });
    }
    return JSON.stringify(reports);
  }
  const prefix = await replay(false, symbols);
  assert.equal(await replay(false, [...symbols].reverse()), prefix, "request order must not change rank or bytes");
  assert.equal(await replay(true, [symbols[1]!, symbols[2]!, symbols[0]!]), prefix, "unclosed future suffix cannot change past outputs");
});
