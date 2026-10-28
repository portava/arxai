// QA — Provider Health's MT5 heartbeat row says whose heartbeat it is.
//
// The row was labelled "MT5 heartbeat" but read detectCurrentConnectedBridge(),
// which walks LIVE-mode bridges only whenever any exist. With a stale LIVE row
// and a DEMO bridge heartbeating every second it read "offline, age 3600s"
// while the MT5 candle feed card above said connected. The row must name its
// subject (the master-live candidate) and the freshest bridge heartbeat must be
// reported on its own; a failed read is "could not be loaded", not "none".
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/lib/data/__qa__/providerHealthHeartbeatSubject.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.now();
function row(over: Record<string, unknown>) {
  return {
    id: 1, userId: 7, mode: "LIVE", accountType: "live", eaVersion: "1.50",
    brokerName: "Broker", serverName: "Broker-Live", accountNumber: "123456",
    lastHeartbeat: new Date(NOW - 3_600_000), capabilities: {}, tokenRevokedAt: null,
    hasBridgeToken: true, status: "active",
    ...over,
  };
}
const staleLive = row({ id: 1, mode: "LIVE", accountType: "live", lastHeartbeat: new Date(NOW - 3_600_000) });
const freshDemo = row({ id: 2, mode: "DEMO", accountType: "demo", lastHeartbeat: new Date(NOW - 2_000) });

let connectionsFail = false;
mock.module("../../brokerHub/connections.js", { namedExports: {
  listConnections: async (q: { modes?: string[] } = {}) => {
    if (connectionsFail) throw new Error("db offline");
    const all = [freshDemo, staleLive]; // ordered by heartbeat, freshest first
    return q.modes ? all.filter((r) => q.modes!.includes(r.mode as string)) : all;
  },
} });
mock.module("../marketDataRouter.js", { namedExports: {
  classifySymbol: () => "forex",
  getRouterDiagnostics: () => ({ chainsByAssetClass: { forex: ["mt5_broker", "assistant_real"] } }),
  routeCandles: async () => { throw new Error("offline"); },
  routeQuote: async () => { throw new Error("offline"); },
} });
mock.module("../../assistant/marketProvider.js", { namedExports: {
  getMarketProvider: () => ({ name: "none" }),
  getMarketStatus: () => ({
    provider: "none", connected: false, configured: false, freshnessState: "UNAVAILABLE",
    dataFreshness: null, dataSource: null, lastSuccessfulFetchAt: null, lastErrorAt: null, unavailableReason: null,
  }),
} });
mock.module("../providers/derivProvider.js", { namedExports: {
  getDerivFeedStatus: () => ({
    mode: "public", configured: false, connected: false, healthSummary: "unconfigured",
    feedReadinessState: "UNCONFIGURED", lastTickAt: null, lastCandleAt: null,
    hasRecentTick: false, activeSymbolsLoaded: false, message: "Deriv not configured.",
  }),
} });
mock.module("../chart/chartDataService.js", { namedExports: { getChartFeedStatus: async () => null } });
mock.module("../../news/economicCalendarProvider.js", { namedExports: {
  getCalendarHealthSnapshot: async () => { throw new Error("offline"); },
} });

const { getProviderHealthSnapshot } = await import("../providerHealth.js");

beforeEach(() => { connectionsFail = false; });

test("stale LIVE row + fresh DEMO bridge: the row names the master-live candidate and the fresh bridge is reported", async () => {
  const snap = await getProviderHealthSnapshot();
  const hb = snap.feeds.mt5.heartbeat;
  // The candidate row is the stale LIVE bridge — and says so.
  assert.equal(hb.subject, "master_live_candidate");
  assert.equal(hb.readOk, true);
  assert.equal(hb.status, "offline");
  assert.equal(hb.masterLiveCapable, false);
  // The freshest bridge heartbeat is the DEMO bridge, live.
  const fb = snap.feeds.mt5.freshestBridge;
  assert.equal(fb.readOk, true);
  assert.equal(fb.present, true);
  assert.equal(fb.status, "live");
  assert.equal(fb.mode, "DEMO");
  assert.ok(fb.ageSec != null && fb.ageSec <= 5);
});

test("connection read failed: both heartbeat rows say they could not be read, never 'none'", async () => {
  connectionsFail = true;
  const snap = await getProviderHealthSnapshot();
  assert.equal(snap.feeds.mt5.heartbeat.readOk, false);
  assert.equal(snap.feeds.mt5.freshestBridge.readOk, false);
  assert.equal(snap.feeds.mt5.freshestBridge.present, false);
});
