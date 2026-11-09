// Quote attribution through the real router (in-memory MT5 store only).
//
// The MT5 quote producer now records the authenticated bridge/owner that pushed
// a quote and whether its timestamp is the producer's own tick time. These
// tests drive the actual store → routeQuote → matchedMarketQuote path and the
// actual timing producer. No DB, network, broker or EA is touched; nothing is
// synthesized — every attribution below is what a writer supplied.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetMt5ProviderStore,
  readMt5Quote,
  updateCandlesFromMT5,
  updateQuoteFromMT5,
  mt5Provider,
} from "../../data/providers/mt5Provider.js";
import { routeCandles, routeQuote, quotePinForSeries } from "../../data/marketDataRouter.js";
import { scalpMarketInputsFor, SCALP_TIMEFRAME } from "../../scalp/scalpServiceInputs.js";
import { matchedMarketQuote, prepareMarketRead } from "../marketReadEvidence.js";
import { computeTimingRead } from "../../../brain/timing/marketTimingBrainService.js";
import { timeframeMs } from "../../data/chart/timeframes.js";
import type { Candle } from "../../data/types.js";

const SYMBOL = "EURUSD";
const TF = "M15" as const;
const A = { bridgeConnectionId: 4, userId: 40 };
const B = { bridgeConnectionId: 5, userId: 50 };

function closedBars(now: number, count = 80, tf: string = TF): Candle[] {
  const interval = timeframeMs(tf as typeof TF);
  const currentOpen = Math.floor(now / interval) * interval;
  return Array.from({ length: count }, (_, i) => {
    const open = 1.09 + i * 0.0001;
    return { time: new Date(currentOpen - (count - i) * interval).toISOString(), open, high: open + 0.0008, low: open - 0.0004, close: open + 0.0002, volume: 100 };
  });
}
function tick(now: number) {
  return { symbol: SYMBOL, bid: 1.0979, ask: 1.0981, spread: 0.0002, timestamp: new Date(now).toISOString() };
}

test("attributed candles and same-bridge observed tick price the series through the real router", async () => {
  __resetMt5ProviderStore();
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, closedBars(now), TF, A);
  updateQuoteFromMT5(SYMBOL, tick(now), A, { tickTimeObserved: true });
  const [candles, quote] = await Promise.all([routeCandles(SYMBOL, TF, 80), routeQuote(SYMBOL)]);
  assert.equal(candles.provenance?.bridgeConnectionId, 4); assert.equal(candles.provenance?.userId, 40);
  assert.equal(quote.provenance?.bridgeConnectionId, 4); assert.equal(quote.provenance?.userId, 40);
  // Not observed on this path → stays unknown, never guessed.
  assert.equal(quote.provenance?.brokerSymbol, null); assert.equal(quote.provenance?.environment, "unknown");
  assert.equal(quote.tickTimeObserved, true);
  assert.ok(prepareMarketRead(candles, SYMBOL, TF, Date.now()));
  const matched = matchedMarketQuote(candles, quote, SYMBOL, Date.now());
  assert.ok(matched); assert.equal(matched!.mid, 1.098); assert.ok(Math.abs(matched!.spread! - 0.0002) < 1e-12);
});

test("another bridge's quote or an unattributed quote cannot price an attributed series", async () => {
  __resetMt5ProviderStore();
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, closedBars(now), TF, A);
  updateQuoteFromMT5(SYMBOL, tick(now), B, { tickTimeObserved: true });
  let candles = await routeCandles(SYMBOL, TF, 80), quote = await routeQuote(SYMBOL);
  assert.equal(quote.provenance?.bridgeConnectionId, 5);
  assert.equal(matchedMarketQuote(candles, quote, SYMBOL, Date.now()), null);

  __resetMt5ProviderStore();
  updateCandlesFromMT5(SYMBOL, closedBars(now), TF, A);
  updateQuoteFromMT5(SYMBOL, tick(now)); // legacy writer: identity unknown
  candles = await routeCandles(SYMBOL, TF, 80); quote = await routeQuote(SYMBOL);
  assert.equal(quote.provenance?.bridgeConnectionId, null); assert.equal(quote.provenance?.userId, null);
  assert.equal(quote.tickTimeObserved, false);
  assert.equal(matchedMarketQuote(candles, quote, SYMBOL, Date.now()), null);
});

test("a receive-time stamp is not an observed tick time and cannot price Truth", async () => {
  __resetMt5ProviderStore();
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, closedBars(now), TF, A);
  updateQuoteFromMT5(SYMBOL, tick(now), A, { tickTimeObserved: false });
  const candles = await routeCandles(SYMBOL, TF, 80), quote = await routeQuote(SYMBOL);
  assert.equal(quote.ok, true); assert.equal(quote.tickTimeObserved, false);
  assert.equal(matchedMarketQuote(candles, quote, SYMBOL, Date.now()), null);
  // A result built without the flag (older caller) is likewise not observed.
  const { tickTimeObserved: _omit, ...legacy } = quote;
  updateQuoteFromMT5(SYMBOL, tick(Date.now()), A, { tickTimeObserved: true });
  assert.equal(matchedMarketQuote(candles, legacy, SYMBOL, Date.now()), null);
});

test("quote store keeps writers apart: pinned reads never fall back, unscoped reads serve the latest writer", async () => {
  __resetMt5ProviderStore();
  const now = Date.now();
  updateQuoteFromMT5(SYMBOL, { ...tick(now), bid: 1.1, ask: 1.1002 }, A, { tickTimeObserved: true });
  updateQuoteFromMT5("eurusd", { ...tick(now), bid: 1.2, ask: 1.2002 }, B, { tickTimeObserved: true });
  assert.equal(readMt5Quote(SYMBOL, { bridgeConnectionId: 4 })?.quote.bid, 1.1);
  assert.equal(readMt5Quote(SYMBOL, { bridgeConnectionId: 5 })?.quote.bid, 1.2);
  assert.equal(readMt5Quote(SYMBOL, { bridgeConnectionId: 6 }), null);
  // Unscoped: most recent writer, as the previous single-latest store did.
  assert.equal(readMt5Quote(SYMBOL)?.bridgeConnectionId, 5);
  assert.equal((await mt5Provider.getQuote(SYMBOL)).bid, 1.2);
  assert.equal((await routeQuote(SYMBOL)).provenance?.userId, 50);
  // TTL still applies per writer.
  assert.equal(readMt5Quote(SYMBOL, { bridgeConnectionId: 4, now: now + 10 * 60_000 }), null);
});

test("actual timing producer uses an attributed same-bridge quote and refuses a cross-bridge one", async () => {
  const quiet = {
    computeNewsHeatFn: async () => ({ phase: "NONE", eventName: null, minutesUntil: null, minutesSince: null, eventType: "none", surpriseScore: null, heatAdjustment: 0, blocksTrade: false }) as never,
    computeBroadFlowFn: async () => ({ verdict: "UNAVAILABLE", institutionalFlowScore: 50, competingCatalyst: false, description: "", correlatedAssets: [], dataQuality: "unavailable" }) as never,
  };
  for (const [writer, expected] of [[A, true], [B, false]] as const) {
    __resetMt5ProviderStore();
    const now = Date.now();
    updateCandlesFromMT5(SYMBOL, closedBars(now), TF, A);
    updateQuoteFromMT5(SYMBOL, tick(now), writer, { tickTimeObserved: true });
    const timing = await computeTimingRead({ symbol: SYMBOL, timeframe: TF, persistSnapshot: false },
      { ...quiet, routeCandlesFn: routeCandles, routeQuoteFn: routeQuote });
    assert.equal(timing.dataQuality.hasQuoteData, expected, `writer ${writer.bridgeConnectionId}`);
    assert.ok(timing.marketEvidence, "closed-bar evidence is independent of the quote");
  }
  __resetMt5ProviderStore();
});

// Review 2026-10-27 finding 2: with several v1 EAs on one symbol the candle
// read and the unscoped quote read chose writers independently (candles from
// the latest candle writer, quote from the latest quote writer), so the quote
// match was null most of the time. Truth consumers now pin the quote to the
// served series' writer.
function multiBridge(now: number, tf: string = TF) {
  __resetMt5ProviderStore();
  updateCandlesFromMT5(SYMBOL, closedBars(now, 80, tf), tf, A);
  updateCandlesFromMT5(SYMBOL, closedBars(now, 80, tf), tf, B); // B serves candles
  updateQuoteFromMT5(SYMBOL, tick(now), B, { tickTimeObserved: true });
  updateQuoteFromMT5(SYMBOL, tick(now), A, { tickTimeObserved: true }); // A is the latest quote writer
}

test("multiple v1 EAs: the quote is pinned to the served series' bridge and pairs", async () => {
  const now = Date.now();
  multiBridge(now);
  const candles = await routeCandles(SYMBOL, TF, 80);
  assert.equal(candles.provenance?.bridgeConnectionId, 5);
  const unscoped = await routeQuote(SYMBOL);
  assert.equal(unscoped.provenance?.bridgeConnectionId, 4, "unscoped read serves the latest quote writer");
  assert.equal(matchedMarketQuote(candles, unscoped, SYMBOL, Date.now()), null);

  assert.deepEqual(quotePinForSeries(candles), { mt5Writer: { bridgeConnectionId: 5 } });
  const pinned = await routeQuote(SYMBOL, quotePinForSeries(candles));
  assert.equal(pinned.provenance?.bridgeConnectionId, 5); assert.equal(pinned.provenance?.userId, 50);
  assert.ok(matchedMarketQuote(candles, pinned, SYMBOL, Date.now()));
});

test("a pinned quote read never borrows another bridge's quote or another provider", async () => {
  __resetMt5ProviderStore();
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, closedBars(now), TF, B);
  updateQuoteFromMT5(SYMBOL, tick(now), A, { tickTimeObserved: true }); // only A has a quote
  const candles = await routeCandles(SYMBOL, TF, 80);
  const pinned = await routeQuote(SYMBOL, quotePinForSeries(candles));
  assert.equal(pinned.ok, false); assert.equal(pinned.quote, null);
  assert.deepEqual(pinned.attempts.map((a) => [a.provider, a.reason]), [["mt5_broker", "MT5_WRITER_QUOTE_MISSING"]]);
  assert.equal(matchedMarketQuote(candles, pinned, SYMBOL, Date.now()), null);
});

test("an unattributed live series pins to the unattributed quote partition only", async () => {
  __resetMt5ProviderStore();
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, closedBars(now), TF); // legacy writer, identity unknown
  updateQuoteFromMT5(SYMBOL, tick(now), null, { tickTimeObserved: true });
  updateQuoteFromMT5(SYMBOL, tick(now), B, { tickTimeObserved: true }); // latest, attributed
  const candles = await routeCandles(SYMBOL, TF, 80);
  assert.deepEqual(quotePinForSeries(candles), { mt5Writer: { bridgeConnectionId: null } });
  const pinned = await routeQuote(SYMBOL, quotePinForSeries(candles));
  assert.equal(pinned.provenance?.bridgeConnectionId, null);
  assert.ok(matchedMarketQuote(candles, pinned, SYMBOL, Date.now()));
});

test("non-MT5 or failed candle results leave quote routing unpinned", () => {
  assert.equal(quotePinForSeries(null), undefined);
  assert.equal(quotePinForSeries({ ok: false } as never), undefined);
  assert.equal(quotePinForSeries({ ok: true, provenance: { providerId: "deriv", subProviderId: null, bridgeConnectionId: null } } as never), undefined);
  assert.equal(quotePinForSeries({ ok: true, provenance: { providerId: "mt5_broker", subProviderId: "durable_mirror", bridgeConnectionId: null } } as never), undefined);
});

test("actual timing and scalp producers pair the served bridge's quote under multi-bridge contention", async () => {
  const quiet = {
    computeNewsHeatFn: async () => ({ phase: "NONE", eventName: null, minutesUntil: null, minutesSince: null, eventType: "none", surpriseScore: null, heatAdjustment: 0, blocksTrade: false }) as never,
    computeBroadFlowFn: async () => ({ verdict: "UNAVAILABLE", institutionalFlowScore: 50, competingCatalyst: false, description: "", correlatedAssets: [], dataQuality: "unavailable" }) as never,
  };
  multiBridge(Date.now());
  const timing = await computeTimingRead({ symbol: SYMBOL, timeframe: TF, persistSnapshot: false },
    { ...quiet, routeCandlesFn: routeCandles, routeQuoteFn: routeQuote });
  assert.equal(timing.dataQuality.hasQuoteData, true);

  multiBridge(Date.now(), SCALP_TIMEFRAME);
  const scalp = await scalpMarketInputsFor(SYMBOL);
  assert.ok(scalp.price != null && Math.abs(scalp.price - 1.098) < 1e-9, `scalp price ${scalp.price}`);
  __resetMt5ProviderStore();
});
