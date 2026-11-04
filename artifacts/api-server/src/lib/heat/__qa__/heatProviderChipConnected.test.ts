// QA — the Market Heat provider row (GlobalMarketHeatCard ProviderChip) only
// claims a CONNECTED price provider when a contributing feed is current. The
// aggregate verdict counts any returned bars as connected, so a stale series
// used to render as a green "connected" chip.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/lib/heat/__qa__/heatProviderChipConnected.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.parse("2026-10-27T16:04:00Z");
let priceFreshness: "LIVE" | "STALE" = "STALE";

const connectedSource = (kind: "news" | "calendar") => ({
  kind, name: "Provider", status: "live", configured: true, connected: true, updatedAt: new Date(NOW).toISOString(), recordCount: 1, note: null,
});

mock.module("../marketHeatProviderStatus.js", { namedExports: {
  readNewsProvider: async () => ({
    source: connectedSource("news"), connected: true, configured: true, itemCount: 1, riskScore: 0.2, highImpactCount: 0,
    topHeadlines: [], updatedAt: new Date(NOW).toISOString(), provider: "Provider", freshness: "LIVE", apiKeyPresent: true, lastError: null,
  }),
  readCalendarProvider: async () => ({
    source: connectedSource("calendar"), connected: true, updatedAt: new Date(NOW).toISOString(), configured: true, eventCount: 1,
    highImpactActive: false, provider: "Provider", events: [],
  }),
  readPriceProvider: async () => {
    const stale = priceFreshness === "STALE";
    return {
      source: { kind: "price", name: "MT5 broker", status: stale ? "stale" : "live", configured: true, connected: !stale,
        updatedAt: new Date(NOW - 105 * 60_000).toISOString(), recordCount: 50, note: stale ? "Price feed is stale." : null },
      available: true, momentum: 0.1, volatility: 0.2, freshness: priceFreshness,
      updatedAt: new Date(NOW - 105 * 60_000).toISOString(), priceTimeBasis: "bar_open", provider: "mt5_broker", candleCount: 50,
    };
  },
} });

const { buildMarketHeat } = await import("../marketHeatService.js");

test("stale price data is not shown as a connected price provider", async () => {
  priceFreshness = "STALE";
  const bundle = await buildMarketHeat({ timeframe: "M15", includeNews: true, includeCalendar: true, nowMs: NOW });
  assert.equal(bundle.providerStatus.price.status, "stale");
  assert.equal(bundle.providerStatus.price.connected, false);
  assert.equal(bundle.providerStatus.price.name, "MT5 broker");
});

test("a current price feed stays connected", async () => {
  priceFreshness = "LIVE";
  const bundle = await buildMarketHeat({ timeframe: "M15", includeNews: true, includeCalendar: true, nowMs: NOW });
  assert.equal(bundle.providerStatus.price.connected, true);
});
