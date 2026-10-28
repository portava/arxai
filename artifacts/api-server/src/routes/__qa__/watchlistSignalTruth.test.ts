// Watchlist signal badges are only shown for a scan of current bars.
//
// (a) No candles → runStrategyScan returns WAIT / 0 ("Insufficient candle
//     data"), which the page rendered as "WAIT 0%" as if a scan concluded
//     wait. No data was scanned: the signal must be null with a NO_DATA status.
// (b) Weekend: the router returns Friday's 1m bars and the scan emits BUY n%,
//     shown under "live signals". The bar age was never inspected: the signal
//     must be null with a STALE_DATA status and the newest bar's time.
//
// Real enrichment + real strategy engine; candles and the calendar are
// module-mocked. No database, broker or network.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

let bars: Array<{ time: string; open: number; high: number; low: number; close: number; volume?: number }> = [];
mock.module("../../lib/data/dataManager.js", {
  namedExports: { getMarketData: async () => bars },
});
mock.module("../../lib/news/calendar/newsRiskResolver.js", {
  namedExports: {
    resolveNewsRiskEvents: async () => ({ available: false, reason: "fixture", events: [] }),
    newsRiskFrom: () => ({ riskLevel: "none", calendarAvailable: false }),
  },
});

const { enrichWatchlistItems } = await import("../watchlists.js");
type Item = Parameters<typeof enrichWatchlistItems>[0][number];
const ITEM = { id: 1, watchlistId: 1, symbol: "EURUSD", marketType: "forex", favorite: false } as unknown as Item;

function series(newestOpenMs: number, n = 220): typeof bars {
  const out: typeof bars = [];
  let p = 1.1;
  for (let i = n - 1; i >= 0; i--) {
    p += 0.0003; // steady up-trend so the scan has something to say
    out.push({ time: new Date(newestOpenMs - i * 60_000).toISOString(), open: p - 0.0002, high: p + 0.0003, low: p - 0.0004, close: p, volume: 100 });
  }
  return out;
}

test("no candles: no signal and NO_DATA, never 'WAIT 0%'", async () => {
  bars = [];
  const [row] = await enrichWatchlistItems([ITEM]);
  assert.equal(row!.signal, null);
  assert.equal(row!.confidence, null);
  assert.equal(row!.signalStatus, "NO_DATA");
});

test("bars 48 hours old: no signal and STALE_DATA with the newest bar time", async () => {
  const newest = Math.floor((Date.now() - 48 * 3600_000) / 60_000) * 60_000;
  bars = series(newest);
  const [row] = await enrichWatchlistItems([ITEM]);
  assert.equal(row!.signal, null, `a 48h-old series must not produce a signal (got ${row!.signal} ${row!.confidence})`);
  assert.equal(row!.signalStatus, "STALE_DATA");
  assert.equal(row!.signalAsOf, new Date(newest).toISOString());
});

test("current bars: the scan's signal is shown with its as-of bar time", async () => {
  const newest = Math.floor(Date.now() / 60_000) * 60_000 - 60_000; // last closed bar
  bars = series(newest);
  const [row] = await enrichWatchlistItems([ITEM]);
  assert.notEqual(row!.signal, null);
  assert.equal(row!.signalStatus, "OK");
  assert.equal(row!.signalAsOf, new Date(newest).toISOString());
});
