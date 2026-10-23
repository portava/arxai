import assert from "node:assert/strict";
import test from "node:test";
import {
  Mt5ReadOnlyAdapter,
  type Mt5OwnedCandle,
  type Mt5OwnedConnection,
  type Mt5OwnedInstrument,
  type Mt5ProjectionReader,
} from "../mt5ReadOnlyAdapter.js";
import {
  BROKER_HUB_READONLY_DEFAULT_ENABLED,
  isBrokerHubReadOnlyEnabled,
} from "../featureFlag.js";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");

test("read-only hub feature remains default-disabled", () => {
  assert.equal(BROKER_HUB_READONLY_DEFAULT_ENABLED, false);
  assert.equal(isBrokerHubReadOnlyEnabled({}), false);
  assert.equal(isBrokerHubReadOnlyEnabled({ ARX_BROKER_HUB_READONLY_ENABLED: "false" }), false);
  assert.equal(isBrokerHubReadOnlyEnabled({ ARX_BROKER_HUB_READONLY_ENABLED: "true" }), true);
});

function connection(overrides: Partial<Mt5OwnedConnection> = {}): Mt5OwnedConnection {
  return {
    id: 44,
    userId: 7,
    status: "connected",
    lastHeartbeat: new Date(NOW - 5_000),
    accountNumber: "1234567890",
    brokerName: "Owned Broker",
    serverName: "Owned Server",
    accountCurrency: "USD",
    accountBalance: 1_000,
    accountEquity: 1_010,
    margin: 100,
    freeMargin: 910,
    accountSyncedAt: new Date(NOW - 4_000),
    leverage: 100,
    mode: "LIVE",
    accountType: "real",
    capabilitiesReportedAt: new Date(NOW - 3_000),
    ...overrides,
  };
}

function instrument(overrides: Partial<Mt5OwnedInstrument> = {}): Mt5OwnedInstrument {
  return {
    symbol: "EURUSD",
    brokerSymbol: "EURUSD.r",
    displaySymbol: "EUR/USD",
    tradeAllowed: true,
    digits: 5,
    point: 0.00001,
    minVolume: 0.01,
    maxVolume: 10,
    volumeStep: 0.01,
    snapshotAt: new Date(NOW - 2_000),
    lastSeenAt: new Date(NOW - 2_000),
    reportedAt: new Date(NOW - 2_000),
    ...overrides,
  };
}

function candle(overrides: Partial<Mt5OwnedCandle> = {}): Mt5OwnedCandle {
  return {
    brokerSymbol: "EURUSD.r",
    timeframe: "M15",
    openTimeUtc: new Date(NOW - 15 * 60_000),
    closeTimeUtc: new Date(NOW),
    open: 1.1,
    high: 1.11,
    low: 1.09,
    close: 1.105,
    tickVolume: 50,
    realVolume: null,
    source: "mt5_ea",
    terminalId: "terminal-owned",
    isClosedBar: true,
    receivedAt: new Date(NOW),
    ...overrides,
  };
}

function fixtureReader(options: {
  connection?: Mt5OwnedConnection | null;
  instruments?: readonly Mt5OwnedInstrument[];
  candles?: readonly Mt5OwnedCandle[];
} = {}): Mt5ProjectionReader & {
  calls: Array<{ method: string; userId: number; connectionId: number }>;
} {
  const calls: Array<{ method: string; userId: number; connectionId: number }> = [];
  const ownedConnection = options.connection === undefined ? connection() : options.connection;
  const instruments = options.instruments ?? [instrument()];
  const candles = options.candles ?? [candle()];
  return {
    calls,
    async readOwnedConnection(userId, connectionId) {
      calls.push({ method: "connection", userId, connectionId });
      return ownedConnection;
    },
    async readOwnedInstruments(userId, connectionId) {
      calls.push({ method: "instruments", userId, connectionId });
      return instruments;
    },
    async readLatestOwnedCandle(userId, connectionId) {
      calls.push({ method: "latest-candle", userId, connectionId });
      return candles.at(-1) ?? null;
    },
    async readOwnedCandles(userId, connectionId) {
      calls.push({ method: "candles", userId, connectionId });
      return candles;
    },
  };
}

test("projects only the bound per-user authority and masks the account reference", async () => {
  const reader = fixtureReader();
  const adapter = new Mt5ReadOnlyAdapter(reader, 7, 44, () => NOW);

  const [health, account, capabilities, instruments] = await Promise.all([
    adapter.readHealth(),
    adapter.readAccount(),
    adapter.readCapabilities(),
    adapter.readInstruments(),
  ]);

  assert.equal(health.status, "CONNECTED");
  assert.equal(health.connected, true);
  assert.equal(account?.accountRefMasked, "12••••••90");
  assert.equal(JSON.stringify(account).includes("1234567890"), false);
  assert.equal(capabilities.capabilities.accountSnapshot, true);
  assert.equal(capabilities.capabilities.instrumentDiscovery, true);
  assert.equal(capabilities.capabilities.marketDataSnapshot, true);
  assert.equal(capabilities.capabilities.positionSnapshot, false);
  assert.equal(capabilities.capabilities.openOrderSnapshot, false);
  assert.deepEqual(instruments.map((item) => item.exactBrokerSymbol), ["EURUSD.r"]);
  assert.equal(instruments[0]?.brokerReportsTradeAllowed, true);
  assert.equal(instruments[0]?.discoveryStatus, "FRESH");
  assert.equal(
    reader.calls.every((call) => call.userId === 7 && call.connectionId === 44),
    true,
  );
});

test("does not use shared-token state and stays unchanged when the legacy env varies", async () => {
  const before = process.env.MT5_BRIDGE_TOKEN;
  try {
    delete process.env.MT5_BRIDGE_TOKEN;
    const withoutLegacyEnv = await new Mt5ReadOnlyAdapter(
      fixtureReader(),
      7,
      44,
      () => NOW,
    ).readHealth();
    process.env.MT5_BRIDGE_TOKEN = "legacy-value-that-must-not-be-read";
    const withLegacyEnv = await new Mt5ReadOnlyAdapter(
      fixtureReader(),
      7,
      44,
      () => NOW,
    ).readHealth();
    assert.deepEqual(withLegacyEnv, withoutLegacyEnv);
  } finally {
    if (before === undefined) delete process.env.MT5_BRIDGE_TOKEN;
    else process.env.MT5_BRIDGE_TOKEN = before;
  }
});

test("requires exact owned discovery before reading broker-native candles", async () => {
  const reader = fixtureReader();
  const adapter = new Mt5ReadOnlyAdapter(reader, 7, 44, () => NOW);

  const missing = await adapter.readMarketData({
    exactBrokerSymbol: "EURUSD",
    timeframe: "m15",
  });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "DISCOVERY_REQUIRED");
  assert.equal(reader.calls.some((call) => call.method === "candles"), false);

  const found = await adapter.readMarketData({
    exactBrokerSymbol: "EURUSD.r",
    timeframe: "m15",
  });
  assert.equal(found.available, true);
  if (!found.available) return;
  assert.equal(found.provenance.userId, 7);
  assert.equal(found.provenance.nativeConnectionRef, "44");
  assert.equal(found.provenance.exactBrokerSymbol, "EURUSD.r");
  assert.equal(found.provenance.source, "mt5_ea");
  assert.equal(found.timeframe, "M15");
  assert.equal(found.candles.length, 1);
});

test("fails closed when the owned connection is absent or heartbeat is stale", async () => {
  const missing = new Mt5ReadOnlyAdapter(
    fixtureReader({ connection: null, instruments: [], candles: [] }),
    7,
    44,
    () => NOW,
  );
  assert.equal((await missing.readHealth()).connected, false);
  assert.equal(await missing.readAccount(), null);
  assert.deepEqual(await missing.readInstruments(), []);

  const stale = new Mt5ReadOnlyAdapter(
    fixtureReader({
      connection: connection({ lastHeartbeat: new Date(NOW - 61_000) }),
    }),
    7,
    44,
    () => NOW,
  );
  assert.equal((await stale.readHealth()).status, "STALE");
  assert.equal(
    (await stale.readCapabilities()).capabilities.instrumentDiscovery,
    false,
  );
  assert.equal(
    (await stale.readCapabilities()).capabilities.marketDataSnapshot,
    false,
  );
  assert.equal((await stale.readInstruments())[0]?.brokerReportsTradeAllowed, false);
  const staleHealthData = await stale.readMarketData({
    exactBrokerSymbol: "EURUSD.r",
    timeframe: "M15",
  });
  assert.equal(staleHealthData.available, false);
  if (staleHealthData.available) assert.fail("stale health must not return data");
  assert.equal(staleHealthData.reason, "HEALTH_UNAVAILABLE");
});

test("stale discovery and market snapshots remain explicitly unavailable", async () => {
  const staleDiscovery = new Mt5ReadOnlyAdapter(
    fixtureReader({
      instruments: [instrument({
        snapshotAt: new Date(NOW - 6 * 60_000),
        lastSeenAt: new Date(NOW - 6 * 60_000),
        reportedAt: new Date(NOW - 6 * 60_000),
      })],
    }),
    7,
    44,
    () => NOW,
  );
  assert.equal((await staleDiscovery.readInstruments())[0]?.discoveryStatus, "STALE");
  const staleDiscoveryData = await staleDiscovery.readMarketData({
    exactBrokerSymbol: "EURUSD.r",
    timeframe: "M15",
  });
  assert.equal(staleDiscoveryData.available, false);
  if (staleDiscoveryData.available) assert.fail("stale discovery must not return data");
  assert.equal(staleDiscoveryData.reason, "DISCOVERY_STALE");

  const staleMarketData = new Mt5ReadOnlyAdapter(
    fixtureReader({
      candles: [candle({ receivedAt: new Date(NOW - 61_000) })],
    }),
    7,
    44,
    () => NOW,
  );
  const staleCandles = await staleMarketData.readMarketData({
    exactBrokerSymbol: "EURUSD.r",
    timeframe: "M15",
  });
  assert.equal(staleCandles.available, false);
  if (staleCandles.available) assert.fail("stale candles must not return data");
  assert.equal(staleCandles.reason, "MARKET_DATA_STALE");
});