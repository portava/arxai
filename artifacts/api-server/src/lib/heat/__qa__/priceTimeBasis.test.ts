// Heat price stamp basis + freshness (owner screenshot [G], 2026-10-27 16:04Z):
// the V75 heat row said "Price 4m ago" while the price inside the forming M15
// bar was seconds old — priceUpdatedAt was the bar's OPEN time (16:00Z). The
// old ladder also called an M15 price LIVE for 2×15 min.
//
// Now readPriceProvider names the basis ("tick" = the symbol's own last venue
// tick, "bar_open" = newest bar open), takes a tick only when it belongs to the
// newest bar and is not from the future, grades freshness with the SAME
// trailing-interval rule as the chart feed status, and a Deriv-backed symbol
// with no recent tick is never LIVE. Residual (documented): the dashboard's
// scanner budget (1.2× timeframe) is stricter still — an allowed client-side
// downgrade.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readPriceProvider } from "../marketHeatProviderStatus.js";
import { computeHeatVerdict } from "@workspace/domain/market-heat";
import type { routeCandles } from "../../data/marketDataRouter.js";

const NOW = Date.parse("2026-10-27T16:04:00Z");
const M15 = 15 * 60_000;

function m15Bars(newestOpenMs: number, n = 40) {
  return Array.from({ length: n }, (_, i) => {
    const t = newestOpenMs - (n - 1 - i) * M15;
    const close = 33500 + i * 1.2345;
    return { time: new Date(t).toISOString(), open: close - 1, high: close + 2, low: close - 2, close, volume: 0 };
  });
}

function router(provider: string, newestOpenMs: number): typeof routeCandles {
  return (async () => ({
    ok: true, symbol: "V75", assetClass: "synthetic", candles: m15Bars(newestOpenMs),
    primaryProvider: provider, attempts: [], userMessage: "", adminDetail: "",
  })) as unknown as typeof routeCandles;
}

const tickAt = (iso: string | null) => () => ({ lastTickAt: iso });
const noTickReader = () => { throw new Error("tick reader must not be consulted for a non-Deriv feed"); };

test("Deriv forming M15 bar opened 16:00 + tick at 16:03:58 → updatedAt is the tick, basis 'tick', LIVE", async () => {
  const r = await readPriceProvider("V75", "M15", NOW, {
    candleRouter: router("deriv_public", Date.parse("2026-10-27T16:00:00Z")),
    tickReader: tickAt("2026-10-27T16:03:58.000Z"),
  });
  assert.equal(r.updatedAt, "2026-10-27T16:03:58.000Z");
  assert.equal(r.priceTimeBasis, "tick");
  assert.equal(r.freshness, "LIVE");
  // Diagnostics agree with the row.
  assert.equal(r.source.updatedAt, "2026-10-27T16:03:58.000Z");
  assert.equal(r.source.status, "live");
});

test("no tick → bar_open stamp kept, and a Deriv-backed symbol without a recent tick is never LIVE", async () => {
  const r = await readPriceProvider("V75", "M15", NOW, {
    candleRouter: router("deriv_public", Date.parse("2026-10-27T16:00:00Z")),
    tickReader: tickAt(null),
  });
  assert.equal(r.updatedAt, "2026-10-27T16:00:00.000Z");
  assert.equal(r.priceTimeBasis, "bar_open");
  assert.equal(r.freshness, "DELAYED");
  assert.equal(r.source.status, "delayed");
});

test("a cached tick older than the newest bar open (old subscription) is not used", async () => {
  const r = await readPriceProvider("V75", "M15", NOW, {
    candleRouter: router("deriv_public", Date.parse("2026-10-27T16:00:00Z")),
    tickReader: tickAt("2026-10-27T15:40:00.000Z"),
  });
  assert.equal(r.priceTimeBasis, "bar_open");
  assert.equal(r.updatedAt, "2026-10-27T16:00:00.000Z");
  assert.notEqual(r.freshness, "LIVE");
});

test("a tick 5s+ in the future is clock skew, not evidence", async () => {
  const r = await readPriceProvider("V75", "M15", NOW, {
    candleRouter: router("deriv_public", Date.parse("2026-10-27T16:00:00Z")),
    tickReader: tickAt("2026-10-27T16:04:06.000Z"),
  });
  assert.equal(r.priceTimeBasis, "bar_open");
  assert.notEqual(r.freshness, "LIVE");
});

test("a throwing tick reader fails closed to bar_open", async () => {
  const r = await readPriceProvider("V75", "M15", NOW, {
    candleRouter: router("deriv", Date.parse("2026-10-27T16:00:00Z")),
    tickReader: () => { throw new Error("ws down"); },
  });
  assert.equal(r.priceTimeBasis, "bar_open");
  assert.equal(r.freshness, "DELAYED");
});

test("freshness follows the shared trailing-interval rule: gap 1 LIVE, gap 2 DELAYED, gap 3 STALE (no more 2×TF = LIVE)", async () => {
  const currentOpen = Math.floor(NOW / M15) * M15;
  const read = (gap: number) => readPriceProvider("EURUSD", "M15", NOW, {
    candleRouter: router("twelvedata", currentOpen - gap * M15),
    tickReader: noTickReader,
  });
  assert.equal((await read(0)).freshness, "LIVE");
  assert.equal((await read(1)).freshness, "LIVE");
  // Old ladder: a 2-interval-old bar (≤ 2×15m) read LIVE.
  assert.equal((await read(2)).freshness, "DELAYED");
  assert.equal((await read(3)).freshness, "STALE");
  assert.equal((await read(1)).priceTimeBasis, "bar_open");
});

test("an unavailable price has no basis", async () => {
  const r = await readPriceProvider("V75", "M15", NOW, {
    candleRouter: (async () => ({ ok: false, candles: [], primaryProvider: null })) as unknown as typeof routeCandles,
    tickReader: noTickReader,
  });
  assert.equal(r.priceTimeBasis, null);
  assert.equal(r.updatedAt, null);
});

test("computeHeatVerdict passes the basis through; a missing basis reads bar_open, never tick", () => {
  const base = {
    id: "synthetic:V75", scope: "synthetic" as const, key: "V75", displayName: "Volatility 75 Index",
    affectedSymbols: ["V75"],
    news: { configured: false, connected: false, riskScore: 0, itemCount: 0, updatedAt: null, source: "none", freshness: "UNAVAILABLE" as const },
    calendar: { configured: false, connected: false, impactScore: 0, eventCount: 0, highImpactActive: false, updatedAt: null, source: "none" },
  };
  const price = { available: true, momentum: 0.2, volatility: 0.3, freshness: "LIVE" as const, updatedAt: "2026-10-27T16:03:58.000Z", source: "deriv_public", candleCount: 40 };
  assert.equal(computeHeatVerdict({ ...base, price: { ...price, priceTimeBasis: "tick" } }).priceTimeBasis, "tick");
  assert.equal(computeHeatVerdict({ ...base, price }).priceTimeBasis, "bar_open");
  assert.equal(computeHeatVerdict({ ...base, price: { ...price, available: false, updatedAt: null } }).priceTimeBasis, null);
});
