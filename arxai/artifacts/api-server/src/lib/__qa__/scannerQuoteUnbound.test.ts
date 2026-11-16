// QA — a live feed whose quote carries no bid/ask spread is NOT a delayed feed
// (levels-withheld-vs-shown cluster, owner's V75 1m Deriv screenshots).
//
// Deriv public ticks carry a last price only. scannerQuoteFor requires an
// observed positive spread, so the scanner row was demoted to STALE_FEED with
// "Waiting for a fresh quote…" and the shared sufficiency verdict said "Live
// feed is delayed — read uses the last confirmed bars", although the candles
// and ticks were current. Gating is unchanged here (no spread is invented, the
// row stays non-selectable, no trade setup is shown); only the stated reason
// changes to the quote-binding limit, on the row, its sufficiency and its
// final-read reasons.
//
// Real path: scanSymbolTimeframe → analyzeViaRouter → routeCandles/routeQuote
// → mt5Provider in-memory seam (provider-agnostic classifier; no mocks).
export {};

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  updateCandlesFromMT5,
  updateQuoteFromMT5,
  __resetMt5ProviderStore,
} from "../data/providers/mt5Provider.js";
import { scanSymbolTimeframe, computeFinalRead } from "../marketScanner.js";
import type { Candle } from "../data/types.js";

const M5_MS = 5 * 60_000;

function freshM5Bars(n: number, now = Date.now()): Candle[] {
  const latestOpen = Math.floor(now / M5_MS) * M5_MS;
  return Array.from({ length: n }, (_, i) => {
    const openMs = latestOpen - (n - 1 - i) * M5_MS;
    return {
      time: new Date(openMs).toISOString(),
      open: 1.07 + i * 0.0001, high: 1.0702 + i * 0.0001, low: 1.0699 + i * 0.0001, close: 1.0701 + i * 0.0001,
      volume: 100 + i,
    };
  });
}

const DELAYED = /Live feed is delayed/;

for (const [name, quote] of [
  ["last price only (Deriv tick shape)", { last: 1.082 }],
  ["bid == ask (zero observed spread)", { bid: 1.082, ask: 1.082, last: 1.082 }],
] as const) {
  test(`fresh candles + ${name}: row withheld for the quote-binding reason, never 'Live feed is delayed'`, async () => {
    __resetMt5ProviderStore();
    updateCandlesFromMT5("EURUSD", freshM5Bars(160), "M5");
    updateQuoteFromMT5("EURUSD", { symbol: "EURUSD", ...quote, timestamp: new Date().toISOString() }, null, { tickTimeObserved: true });

    const op = await scanSymbolTimeframe("EURUSD", "M5");
    assert.ok(op != null);
    // Gating unchanged: not selectable/tradeable, no setup shown.
    assert.equal(op.selectable, false);
    assert.equal(op.tradeable, false);
    assert.equal(op.sufficiency?.canShowTradeSetup, false);
    assert.equal(op.entryZone, null, "no entry zone ships on a row whose setup is withheld");
    // Reason: the quote-binding limit, everywhere this row states one.
    assert.equal(op.sufficiency?.reasonCode, "quote_unbound");
    assert.match(op.sufficiency?.humanReason ?? "", /no bid\/ask spread is bound/);
    assert.doesNotMatch(op.sufficiency?.humanReason ?? "", DELAYED);
    assert.match(op.disabledReason ?? "", /no bid\/ask spread is bound/);
    const finalRead = computeFinalRead(op);
    assert.ok(finalRead.reasons.some((r) => /no bid\/ask spread is bound/.test(r)), "final read states the quote-binding reason");
    for (const r of finalRead.reasons) assert.doesNotMatch(r, DELAYED, `final-read reason: ${r}`);
  });
}

test("fresh candles + a bound bid/ask quote stays live (contrast)", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", freshM5Bars(160), "M5");
  updateQuoteFromMT5("EURUSD", { symbol: "EURUSD", bid: 1.082, ask: 1.0822, spread: 0.0002, timestamp: new Date().toISOString() }, null, { tickTimeObserved: true });
  const op = await scanSymbolTimeframe("EURUSD", "M5");
  assert.ok(op != null);
  assert.equal(op.dataSource, "LIVE_FEED");
  assert.notEqual(op.sufficiency?.reasonCode, "quote_unbound");
  if (op.sufficiency?.canShowTradeSetup) {
    assert.ok(op.entryZone && op.entryZone.low > 0 && op.entryZone.low <= op.entryZone.high, "setup-allowed row carries its real entry zone");
    assert.ok(Math.abs((op.entryZone.low + op.entryZone.high) / 2 - op.entry) < 1e-9, "entry is the zone midpoint");
  }
});

test("fresh candles + NO quote at all keeps the existing 'waiting for a fresh quote' reason (not quote_unbound)", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", freshM5Bars(160), "M5");
  const op = await scanSymbolTimeframe("EURUSD", "M5");
  assert.ok(op != null);
  assert.notEqual(op.sufficiency?.reasonCode, "quote_unbound");
  assert.equal(op.selectable, false);
});
