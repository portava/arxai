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
// The serving provider, and the broker-clock offset measured for it (MT5 bars
// stay broker-stamped on the Codex line; audit H7). Default: no provenance.
let provenance: { providerId: string; subProviderId: string | null; bridgeConnectionId: number | null } | null = null;
let measuredOffsetMs: number | null = null;
mock.module("../../lib/data/dataManager.js", {
  namedExports: {
    getMarketData: async () => bars,
    getMarketDataWithProvenance: async () => ({ candles: bars, provenance }),
  },
});
const mt5Provider = await import("../../lib/data/providers/mt5Provider.js");
mock.module("../../lib/data/providers/mt5Provider.js", {
  namedExports: {
    ...mt5Provider,
    servedSeriesBrokerClockOffsetMs: (p: typeof provenance) =>
      p?.providerId === "mt5_broker" && p.subProviderId == null && p.bridgeConnectionId != null ? measuredOffsetMs : null,
  },
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

// Broker clock: an MT5 series is stamped on the broker-server clock (here
// UTC+2). With the bridge's measured offset its newest bar is aged on the UTC
// clock; with none the stamp cannot be confirmed. signalAsOf stays the bar's
// own stamp.
test("broker-stamped MT5 bars: current with a measured offset, unconfirmed without, stale when stalled", async () => {
  const OFFSET = 2 * 3600_000;
  const lastClosedUtc = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
  provenance = { providerId: "mt5_broker", subProviderId: null, bridgeConnectionId: 11 };
  try {
    measuredOffsetMs = OFFSET;
    bars = series(lastClosedUtc + OFFSET);
    let [row] = await enrichWatchlistItems([ITEM]);
    assert.equal(row!.signalStatus, "OK");
    assert.notEqual(row!.signal, null);
    assert.equal(row!.signalAsOf, new Date(lastClosedUtc + OFFSET).toISOString());

    // Stalled two hours: read as UTC the stamp would look current (one bar
    // behind); aged with the measured offset it is stale and no signal is shown.
    const stalledStamp = lastClosedUtc - 120 * 60_000 + OFFSET;
    bars = series(stalledStamp);
    measuredOffsetMs = 0; // control: a zero offset reads the stamp as UTC
    [row] = await enrichWatchlistItems([ITEM]);
    assert.notEqual(row!.signalStatus, "STALE_DATA", "control: read as UTC the stalled series looks current");
    measuredOffsetMs = OFFSET;
    [row] = await enrichWatchlistItems([ITEM]);
    assert.equal(row!.signalStatus, "STALE_DATA");
    assert.equal(row!.signal, null);

    // No measured offset: a stamp two hours ahead is not confirmed current.
    measuredOffsetMs = null;
    bars = series(lastClosedUtc + OFFSET);
    [row] = await enrichWatchlistItems([ITEM]);
    assert.equal(row!.signalStatus, "STALE_DATA");
    assert.equal(row!.signal, null);
  } finally {
    provenance = null;
    measuredOffsetMs = null;
  }
});
