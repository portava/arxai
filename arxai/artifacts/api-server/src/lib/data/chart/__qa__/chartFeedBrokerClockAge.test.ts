// Review (truth port, S02): EA bars stay broker-stamped (audit H7). With the
// serving bridge's broker-clock offset MEASURED, the newest bar's future-stamp
// lead is compared on the UTC clock (bar time minus the offset), so a
// correctly stamped GMT+2 series is not "future". The trailing gap and the
// weekend-closure test used to keep the RAW broker-time open: a series
// stalled for an hour then had a negative raw gap and read clean / live /
// AI-usable, and a GMT+2 broker's last Friday bar (23:00 broker = 21:00 UTC)
// was never "before the 22:00 UTC close". Both now age the bar by the earlier
// of its raw and offset-corrected opens, so a measured offset can only make a
// bar older, never younger (a negative "offset" read from a stale first-sight
// tick must not make a stalled series current). Bar times are never rewritten.
//
// Drives the real buildChartFeed (via getChartCandles) and the legacy
// newest-page history verdict (getCandleHistory) with only the router, the
// session-profile DB read and the candle cache mocked. The bridge offset is
// measured through the real MT5 store (recordMt5Tick). No database, broker or
// network calls.
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/data/chart/__qa__/chartFeedBrokerClockAge.test.ts

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const MIN = 60_000;
const HOUR = 60 * MIN;
const GMT2 = 2 * HOUR;
const BRIDGE = { bridgeConnectionId: 61, userId: 6 };

type Bar = { time: string; open: number; high: number; low: number; close: number; volume: number; timeBasisEvidence?: import("../../candleTimeBasisEvidence.js").CandleTimeBasisEvidence };
/** `n` bars of `intervalMs` whose newest REAL (UTC) open is `newestUtcOpen`, stamped on a GMT+2 broker clock. */
function brokerBars(newestUtcOpen: number, intervalMs: number, n = 200): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const open = newestUtcOpen - (n - 1 - i) * intervalMs + GMT2;
    return { time: new Date(open).toISOString(), open: 1.1, high: 1.101, low: 1.099, close: 1.1, volume: 10 };
  });
}

let routedBars: Bar[] = [];
const realRouter = await import("../../marketDataRouter.js");
mock.module("../../marketDataRouter.js", {
  namedExports: {
    ...realRouter,
    classifySymbol: () => "forex",
    routeCandles: async (symbol: string, timeframe: string) => ({
      ok: true,
      symbol,
      timeframe,
      assetClass: "forex",
      candles: routedBars,
      primaryProvider: "mt5_broker",
      provenance: { providerId: "mt5_broker", subProviderId: null, bridgeConnectionId: BRIDGE.bridgeConnectionId,
        userId: BRIDGE.userId, brokerSymbol: null, environment: "unknown", source: "BROKER", delayed: false },
      provenanceNotes: [],
      attempts: [{ provider: "mt5_broker", ok: true, ms: 5 }],
      userMessage: null,
    }),
  },
});
const realSession = await import("../sessionProfile.js");
mock.module("../sessionProfile.js", {
  namedExports: { ...realSession, getSessionProfile: async () => null },
});
mock.module("../../candleCache.js", {
  namedExports: {
    readCachedCandles: async () => ({ candles: routedBars, count: routedBars.length,
      oldest: routedBars[0]?.time ?? null, newest: routedBars.at(-1)?.time ?? null, hasOlderInCache: false }),
    getCacheCoverage: async () => ({ oldest: routedBars[0]?.time ?? null, newest: routedBars.at(-1)?.time ?? null }),
    listCachedSources: async () => [],
    upsertCandles: async () => {},
    isValidCacheOhlc: () => true,
  },
});

const { getChartCandles } = await import("../chartDataService.js");
const { getCandleHistory } = await import("../../candleHistoryService.js");
const { recordMt5Tick, __resetMt5ProviderStore, getMt5BridgeClockOffset } = await import("../../providers/mt5Provider.js");

/** The bridge's first tick: measures its broker-clock offset (+2h by default). */
function measureOffset(nowMs: number, offsetMs = GMT2): void {
  recordMt5Tick("EURUSD", { bid: 1.1, ask: 1.1001, brokerTimeMs: nowMs + offsetMs, eaUtcMs: nowMs }, BRIDGE);
  assert.equal(getMt5BridgeClockOffset(BRIDGE)?.offsetMs, offsetMs, "fixture: offset measured");
}

beforeEach(() => {
  mock.timers.reset();
  __resetMt5ProviderStore();
});

const WED_1000_30 = Date.UTC(2026, 9, 28, 10, 0, 30);

test("a broker-time M1 series stalled 1h with a measured +2h offset reads stale, not clean or live", async () => {
  mock.timers.enable({ apis: ["Date"], now: WED_1000_30 });
  measureOffset(WED_1000_30);
  // Newest REAL bar opened 09:00 UTC (stamped 11:00 broker): raw gap −60, real gap 60.
  routedBars = brokerBars(Date.UTC(2026, 9, 28, 9, 0), MIN);
  const r = await getChartCandles("EURUSD", "M1", 200);
  assert.equal(r.feedStatus.trailingIntervals, 60, "aged on the UTC clock");
  assert.equal(r.feedStatus.quality, "stale");
  assert.equal(r.feedStatus.isLive, false);
  assert.equal(r.feedStatus.aiUsable, false);
  assert.equal(r.candles.at(-1)?.openTime, new Date(Date.UTC(2026, 9, 28, 11, 0)).toISOString(), "bar time not rewritten");

  const h = await getCandleHistory({ symbol: "EURUSD", timeframe: "1m", limit: 200 });
  assert.equal(h.status, "stale", "the history verdict ages the same bar on the same clock");
});

test("an H1 series stalled one bar past the real gap reads delayed, never clean", async () => {
  mock.timers.enable({ apis: ["Date"], now: WED_1000_30 });
  measureOffset(WED_1000_30);
  // Newest REAL bar 08:00 UTC (stamped 10:00): raw gap 0 (clean), real gap 2 (delayed).
  routedBars = brokerBars(Date.UTC(2026, 9, 28, 8, 0), HOUR);
  const r = await getChartCandles("EURUSD", "H1", 200);
  assert.equal(r.feedStatus.trailingIntervals, 2);
  assert.notEqual(r.feedStatus.quality, "clean");
  assert.equal(r.feedStatus.isLive, false);
  assert.equal(r.feedStatus.aiUsable, false);
});

test("control: a current broker-time series with a measured offset stays live (audit H7)", async () => {
  mock.timers.enable({ apis: ["Date"], now: WED_1000_30 });
  measureOffset(WED_1000_30);
  routedBars = brokerBars(Date.UTC(2026, 9, 28, 10, 0), MIN);
  const r = await getChartCandles("EURUSD", "M1", 200);
  assert.equal(r.feedStatus.trailingIntervals, 0);
  assert.equal(r.feedStatus.quality, "clean");
  assert.equal(r.feedStatus.isLive, true);
  const h = await getCandleHistory({ symbol: "EURUSD", timeframe: "1m", limit: 200 });
  assert.equal(h.status, "live");
});

test("control: with no measured offset the raw broker stamp still fails closed", async () => {
  mock.timers.enable({ apis: ["Date"], now: WED_1000_30 });
  routedBars = brokerBars(Date.UTC(2026, 9, 28, 9, 0), MIN);
  const r = await getChartCandles("EURUSD", "M1", 200);
  assert.equal(r.feedStatus.quality, "invalid");
  assert.equal(r.feedStatus.isLive, false);
  assert.equal(r.feedStatus.aiUsable, false);
  const h = await getCandleHistory({ symbol: "EURUSD", timeframe: "1m", limit: 200 });
  assert.notEqual(h.status, "live");
});

test("a GMT+2 broker's last Friday H1 bar (23:00 broker = 21:00 UTC) is before the 22:00 UTC close", async () => {
  const FRI_2230 = Date.UTC(2026, 9, 30, 22, 30);
  mock.timers.enable({ apis: ["Date"], now: FRI_2230 });
  measureOffset(FRI_2230);
  routedBars = brokerBars(Date.UTC(2026, 9, 30, 21, 0), HOUR);
  const r = await getChartCandles("EURUSD", "H1", 200);
  assert.equal(r.feedStatus.isLive, false);
  assert.equal(r.feedStatus.notLiveReason, "market_closed");
  assert.match(r.feedStatus.warning ?? r.feedStatus.message ?? "", /Market closed for .* scheduled weekend close/);
});

test("a negative 'offset' read from a stale first-sight tick never makes a stalled series current", async () => {
  mock.timers.enable({ apis: ["Date"], now: WED_1000_30 });
  // The bridge's newest partition holds a 6h-old tick first seen now: broker
  // time (UTC+2) minus the EA's current clock reads −4h, not the real +2h.
  measureOffset(WED_1000_30, GMT2 - 6 * HOUR);
  // The series stalled with that tick: newest REAL bar 04:00 UTC, stamped 06:00.
  routedBars = brokerBars(Date.UTC(2026, 9, 28, 4, 0), MIN);
  const r = await getChartCandles("EURUSD", "M1", 200);
  assert.ok((r.feedStatus.trailingIntervals ?? 0) >= 240, `aged no younger than its raw stamp: ${r.feedStatus.trailingIntervals}`);
  assert.equal(r.feedStatus.quality, "stale");
  assert.equal(r.feedStatus.isLive, false);
  assert.equal(r.feedStatus.aiUsable, false);
  const h = await getCandleHistory({ symbol: "EURUSD", timeframe: "1m", limit: 200 });
  assert.equal(h.status, "stale");
});

for (const offset of [1, 350, GMT2]) test(`monthly freshness uses broker calendar coordinates with positive offset ${offset}ms`, async () => {
  const now = Date.UTC(2026, 10, 5, 18);
  mock.timers.enable({ apis: ["Date"], now });
  measureOffset(now, offset);
  routedBars = Array.from({ length: 160 }, (_, i) => ({time: new Date(Date.UTC(2026, 9 - 159 + i, 1)).toISOString(), open: 1.1, high: 1.101, low: 1.099, close: 1.1, volume: 10}));
  const r = await getChartCandles("EURUSD", "MN1", 200);
  assert.equal(r.feedStatus.trailingIntervals, 1);
  assert.equal(r.feedStatus.quality, "clean");
  assert.equal(r.feedStatus.isLive, true);
  assert.equal(r.candles.at(-1)?.openTime, "2026-10-01T00:00:00.000Z");
  assert.equal(r.candles.at(-1)?.closeTime, "2026-11-01T00:00:00.000Z");
  routedBars = routedBars.slice(0, -1);
  const stalled = await getChartCandles("EURUSD", "MN1", 200);
  assert.equal(stalled.feedStatus.trailingIntervals, 2);
  assert.equal(stalled.aiUsable, false);
  assert.equal(stalled.feedStatus.isLive, false);
});

test("negative inferred monthly offset cannot rejuvenate missing October history", async () => {
  const now = Date.UTC(2026, 10, 5, 18);
  mock.timers.enable({ apis: ["Date"], now });
  measureOffset(now, -31 * 24 * HOUR);
  routedBars = [{time:"2026-09-01T00:00:00.000Z",open:1.1,high:1.101,low:1.099,close:1.1,volume:10}];
  const r = await getChartCandles("EURUSD", "MN1", 200);
  assert.equal(r.feedStatus.trailingIntervals, 2);
  assert.equal(r.aiUsable, false);
});

for (const offset of [350, GMT2, -GMT2]) test(`converted monthly bars retain broker calendar and UTC close (${offset}ms)`, async () => {
  const now = Date.UTC(2026, 10, 5, 18);
  mock.timers.enable({ apis: ["Date"], now });
  measureOffset(now, offset);
  const { convertedBrokerCandleTimeBasis } = await import("../../candleTimeBasisEvidence.js");
  routedBars = Array.from({ length: 160 }, (_, i) => ({time: new Date(Date.UTC(2026, 9 - 159 + i, 1) - offset).toISOString(), open: 1.1, high: 1.101, low: 1.099, close: 1.1, volume: 10, timeBasisEvidence: convertedBrokerCandleTimeBasis({offsetMs:offset,measuredAtMs:now})}));
  const r = await getChartCandles("EURUSD", "MN1", 200);
  assert.equal(r.feedStatus.trailingIntervals, 1);
  assert.equal(r.candles.at(-1)?.closeTime, new Date(Date.UTC(2026,10,1)-offset).toISOString());
  assert.equal(r.candles.at(-1)?.timeBasisEvidence.kind, "unavailable");
});
