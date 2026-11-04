// QA — Market Heat price provider: "connected" means a current feed, and the
// provider name shown on the heat card is user-safe.
//
// readPriceProvider used to set connected:true for ANY router result with >=2
// bars — a series 7 intervals old (durable mirror, stalled bridge, cached
// fallback) rendered as a green "connected" chip — and copied the raw router
// id ("mt5_broker", "assistant_real:twelvedata") into the chip name.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/heat/__qa__/priceProviderConnected.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { readPriceProvider } from "../marketHeatProviderStatus.js";
import type { routeCandles } from "../../data/marketDataRouter.js";

const NOW = Date.parse("2026-10-27T16:04:00Z");
const M15 = 15 * 60_000;

function bars(newestOpenMs: number, n = 50) {
  return Array.from({ length: n }, (_, i) => {
    const t = newestOpenMs - (n - 1 - i) * M15;
    const close = 1.1 + i * 1e-4;
    return { time: new Date(t).toISOString(), open: close, high: close + 2e-4, low: close - 2e-4, close, volume: 0 };
  });
}

function router(provider: string, newestOpenMs: number, subProviderId: string | null = null): typeof routeCandles {
  return (async () => ({
    ok: true, symbol: "EURUSD", assetClass: "forex", candles: bars(newestOpenMs),
    primaryProvider: provider, attempts: [], userMessage: "", adminDetail: "",
    provenance: { providerId: provider.split(":")[0], subProviderId },
  })) as unknown as typeof routeCandles;
}

const currentOpen = Math.floor(NOW / M15) * M15;

test("a STALE price series is not a connected provider", async () => {
  const r = await readPriceProvider("EURUSD", "M15", NOW, { candleRouter: router("mt5_broker", currentOpen - 7 * M15) });
  assert.equal(r.freshness, "STALE");
  assert.equal(r.source.status, "stale");
  assert.equal(r.source.connected, false);
});

test("the stored MT5 mirror is not a connected provider even when recent", async () => {
  const r = await readPriceProvider("EURUSD", "M15", NOW, { candleRouter: router("mt5_broker", currentOpen - M15, "durable_mirror") });
  assert.equal(r.source.connected, false);
  assert.match(r.source.name, /stored/i);
});

test("a current live series stays connected", async () => {
  const r = await readPriceProvider("EURUSD", "M15", NOW, { candleRouter: router("mt5_broker", currentOpen) });
  assert.equal(r.freshness, "LIVE");
  assert.equal(r.source.connected, true);
});

test("the chip name never leaks a raw provider id", async () => {
  for (const id of ["mt5_broker", "assistant_real:twelvedata", "assistant_real:polygon", "deriv_public"]) {
    const r = await readPriceProvider("EURUSD", "M15", NOW, {
      candleRouter: router(id, currentOpen),
      tickReader: () => ({ lastTickAt: new Date(NOW - 1_000).toISOString() }),
    });
    assert.doesNotMatch(r.source.name, /_|:|twelve|polygon/i, `${id} → ${r.source.name}`);
    // The raw id stays available for admin diagnostics.
    assert.equal(r.provider, id);
  }
});
