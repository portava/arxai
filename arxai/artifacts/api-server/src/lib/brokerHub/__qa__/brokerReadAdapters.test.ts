// Broker Hub — one read contract, two venues (Tier 1 Broker & Account Hub).
//
// Proves the Deriv adapter answers the same ReadOnlyBrokerAdapter contract as
// MT5 from an injected feed (no socket), never reports a Deriv account or a
// tradable Deriv instrument, refuses stale or unhealthy market data, and that
// the factory hands out both venues behind the interface.

import assert from "node:assert/strict";
import test from "node:test";
import { READ_ONLY_BROKER_ADAPTER_METHODS } from "@workspace/domain/broker-hub";
import {
  DERIV_PLATFORM_FEED_REF,
  DerivReadOnlyAdapter,
  type DerivFeedReader,
} from "../derivReadOnlyAdapter.js";
process.env.DATABASE_URL ??= "postgresql://offline@localhost/offline?host=%2Fprivate%2Ftmp%2Farx-no-db";
const { BROKER_READ_VENUES, brokerReadAdapter } = await import("../readAdapters.js");

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const nowSec = Math.floor(NOW / 1000);

type Status = ReturnType<DerivFeedReader["feedStatus"]>;

function reader(status: Partial<Status> = {}, candles: Array<{ epoch: number; close: number }> = []): DerivFeedReader {
  return {
    feedStatus: () => ({
      feedReadinessState: "LIVE_FEED",
      connected: true,
      lastTickAt: new Date(NOW - 2_000).toISOString(),
      lastTickAgeMs: 2_000,
      activeSymbolsLoaded: true,
      activeSymbolsLoadedAt: new Date(NOW - 60_000).toISOString(),
      ...status,
    }),
    isDiscovered: (id) => id === "R_75",
    catalog: () => [{ symbol: "V75", derivId: "R_75", displayName: "Volatility 75 Index" }],
    candles: async () => ({
      ok: candles.length > 0,
      reason: candles.length > 0 ? null : "NO_CANDLES_RETURNED",
      candles: candles.map((c) => ({ epoch: c.epoch, open: c.close, high: c.close, low: c.close, close: c.close })),
    }),
  };
}

const adapter = (r: DerivFeedReader) => new DerivReadOnlyAdapter(r, 7, () => NOW);

test("a live Deriv feed reads as a connected venue with the platform feed as its connection", async () => {
  const health = await adapter(reader()).readHealth();
  assert.equal(health.identity.venue, "DERIV");
  assert.equal(health.identity.userId, 7);
  assert.equal(health.identity.nativeConnectionRef, DERIV_PLATFORM_FEED_REF);
  assert.equal(health.status, "CONNECTED");
  assert.equal(health.connected, true);
  assert.equal(health.staleSeconds, 2);
});

test("feed states map honestly: unconfigured is disabled, connecting is disconnected, failed auth only degrades", async () => {
  const unconfigured = await adapter(reader({ feedReadinessState: "UNCONFIGURED", connected: false })).readHealth();
  assert.equal(unconfigured.status, "DISABLED");
  assert.equal(unconfigured.connected, false);
  const connecting = await adapter(reader({ feedReadinessState: "CONNECTING", connected: false })).readHealth();
  assert.equal(connecting.status, "DISCONNECTED");
  const auth = await adapter(reader({ feedReadinessState: "AUTH_FAILED" })).readHealth();
  assert.equal(auth.status, "DEGRADED");
  assert.equal(auth.connected, true);
  // A state that says connected never outvotes a socket that is down.
  const down = await adapter(reader({ feedReadinessState: "HISTORY_READY_AWAITING_LIVE_TICK", connected: false })).readHealth();
  assert.equal(down.connected, false);
});

test("Deriv reports no account and no account, position or order capabilities", async () => {
  const a = adapter(reader());
  assert.equal(await a.readAccount(), null);
  const caps = (await a.readCapabilities()).capabilities;
  assert.equal(caps.accountSnapshot, false);
  assert.equal(caps.positionSnapshot, false);
  assert.equal(caps.openOrderSnapshot, false);
  assert.equal(caps.instrumentDiscovery, true);
  assert.equal(caps.marketDataSnapshot, true);
  const warming = (await adapter(reader({ feedReadinessState: "HISTORY_READY_AWAITING_LIVE_TICK" })).readCapabilities()).capabilities;
  assert.equal(warming.marketDataSnapshot, false, "no live tick means no market-data capability");
});

test("no Deriv instrument is ever reported as tradable", async () => {
  const instruments = await adapter(reader()).readInstruments();
  assert.equal(instruments.length, 1);
  assert.equal(instruments[0].exactBrokerSymbol, "R_75");
  assert.equal(instruments[0].brokerReportsTradeAllowed, false);
  assert.equal(instruments[0].discoveryStatus, "FRESH");
  const stale = await adapter(reader({ activeSymbolsLoaded: false })).readInstruments();
  assert.equal(stale[0].discoveryStatus, "STALE");
});

test("market data is served only when healthy, discovered, and current", async () => {
  const fresh = [{ epoch: nowSec - 120, close: 1 }, { epoch: nowSec - 60, close: 2 }];
  const ok = await adapter(reader({}, fresh)).readMarketData({ exactBrokerSymbol: "R_75", timeframe: "m1" });
  assert.equal(ok.available, true);
  if (ok.available) {
    assert.equal(ok.timeframe, "M1");
    assert.equal(ok.provenance.venue, "DERIV");
    assert.equal(ok.candles.length, 2);
    assert.equal(ok.candles[1].closed, true);
  }

  const unhealthy = await adapter(reader({ feedReadinessState: "CONNECTING", connected: false }, fresh))
    .readMarketData({ exactBrokerSymbol: "R_75", timeframe: "M1" });
  assert.deepEqual([unhealthy.available, !unhealthy.available && unhealthy.reason], [false, "HEALTH_UNAVAILABLE"]);

  const unknown = await adapter(reader({}, fresh)).readMarketData({ exactBrokerSymbol: "NOPE", timeframe: "M1" });
  assert.equal(!unknown.available && unknown.reason, "DISCOVERY_REQUIRED");

  const undiscovered = await adapter(reader({ activeSymbolsLoaded: false }, fresh)).readMarketData({ exactBrokerSymbol: "R_75", timeframe: "M1" });
  assert.equal(!undiscovered.available && undiscovered.reason, "DISCOVERY_STALE");

  const stale = await adapter(reader({}, [{ epoch: nowSec - 600, close: 1 }])).readMarketData({ exactBrokerSymbol: "R_75", timeframe: "M1" });
  assert.equal(!stale.available && stale.reason, "MARKET_DATA_STALE");

  const empty = await adapter(reader({}, [])).readMarketData({ exactBrokerSymbol: "R_75", timeframe: "M1" });
  assert.equal(!empty.available && empty.reason, "MARKET_DATA_UNAVAILABLE");
});

test("the factory serves every Hub venue behind the one read contract", () => {
  assert.deepEqual([...BROKER_READ_VENUES], ["MT5", "DERIV"]);
  const mt5 = brokerReadAdapter({ venue: "MT5", userId: 7, connectionId: 44 });
  const deriv = brokerReadAdapter({ venue: "DERIV", userId: 7 });
  for (const a of [mt5, deriv]) {
    for (const m of READ_ONLY_BROKER_ADAPTER_METHODS) assert.equal(typeof a[m], "function", `${a.identity.venue}.${m}`);
  }
  assert.deepEqual(mt5.identity, { venue: "MT5", userId: 7, nativeConnectionRef: "44" });
  assert.deepEqual(deriv.identity, { venue: "DERIV", userId: 7, nativeConnectionRef: DERIV_PLATFORM_FEED_REF });
});


test("discovery for another instrument never marks this catalog entry fresh", async () => {
  const r = reader(); r.isDiscovered = () => false;
  assert.equal((await adapter(r).readInstruments())[0].discoveryStatus, "STALE");
  const missing = reader(); delete missing.isDiscovered;
  assert.equal((await adapter(missing).readInstruments())[0].discoveryStatus, "STALE");
});

test("public market data retains public provenance and never creates trading capability", async () => {
  const r = reader({}, [{ epoch: nowSec - 60, close: 1 }]); r.source = () => "deriv_public";
  const a = adapter(r); const data = await a.readMarketData({ exactBrokerSymbol: "R_75", timeframe: "M1" });
  assert.ok(data.available); assert.equal(data.provenance.source, "deriv_public");
  assert.equal(await a.readAccount(), null);
  assert.equal((await a.readCapabilities()).capabilities.openOrderSnapshot, false);
  assert.equal((await a.readInstruments())[0].brokerReportsTradeAllowed, false);
});
