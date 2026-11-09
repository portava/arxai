// QA — Provider Health's mt5_broker row explains the CURRENT state.
//
// The disconnected reason read "EA v1.27 heartbeat-only — tick push not yet
// implemented. Slot reserved for EA v1.28+." long after candle/quote push
// shipped (mt5Provider mergeCandleFromMT5 / updateQuoteFromMT5). The row must
// say what was observed: no MT5 candle or quote push within the freshness
// window, and where the router goes instead.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/lib/data/__qa__/providerHealthMt5Reason.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("../marketDataRouter.js", { namedExports: {
  classifySymbol: () => "forex",
  getRouterDiagnostics: () => ({ chainsByAssetClass: { forex: ["mt5_broker", "assistant_real"] } }),
  routeCandles: async () => { throw new Error("offline"); },
  routeQuote: async () => { throw new Error("offline"); },
} });
mock.module("../chart/chartDataService.js", { namedExports: { getChartFeedStatus: async () => null } });
mock.module("../../mt5/currentConnectedBridgeDetector.js", { namedExports: { detectCurrentConnectedBridge: async () => null } });
mock.module("../../news/economicCalendarProvider.js", { namedExports: {
  getCalendarHealthSnapshot: async () => { throw new Error("offline"); },
} });

const { __resetMt5ProviderStore, updateQuoteFromMT5 } = await import("../providers/mt5Provider.js");
const { getProviderHealthSnapshot } = await import("../providerHealth.js");

test("disconnected mt5_broker: reason describes the observed state, not an obsolete EA version", async () => {
  __resetMt5ProviderStore();
  const snap = await getProviderHealthSnapshot();
  const mt5 = snap.providers.find((p) => p.id === "mt5_broker");
  assert.ok(mt5);
  assert.notEqual(mt5.status, "healthy");
  assert.doesNotMatch(mt5.statusReason, /not yet implemented|v1\.27|v1\.28|heartbeat-only/i);
  assert.match(mt5.statusReason, /no MT5 candle or quote push/i);
  assert.doesNotMatch(snap.feeds.mt5.quotePush.note, /heartbeat-only/i);
});

test("connected mt5_broker: reason says what was pushed, not that ticks are flowing", async () => {
  __resetMt5ProviderStore();
  updateQuoteFromMT5("EURUSD", { bid: 1.1, ask: 1.1002 } as never);
  const snap = await getProviderHealthSnapshot();
  const mt5 = snap.providers.find((p) => p.id === "mt5_broker");
  assert.ok(mt5);
  assert.equal(mt5.status, "healthy");
  assert.match(mt5.statusReason, /candles or quotes/i);
});
