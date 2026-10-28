// Selected-market envelope: a cached "live" read and an unsynced calendar.
//
// 1. The selected-market envelope is cached for 30 s. A feed read
//    LIVE_CONFIRMED with its newest bar one interval behind stops being live
//    at the next interval boundary (the trailing gap becomes 2), but the
//    cached envelope kept saying LIVE_CONFIRMED — with a bias, confidence and
//    levels — for up to 30 s after that.
// 2. The upcoming-event list reads the stored economic_events table, which
//    only a manual sync fills. Any stored row inside the next 24 h marked the
//    calendar "checked", even when the table ends hours before the window
//    does, so later events were silently missing from a "checked" list. It
//    now uses the shared stored-calendar coverage rule (readStoredCalendarCoverage).
//
// Only the database handle is stubbed for the calendar reads; the chart
// source is injected. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/scannerSelected/__qa__/selectedMarketLiveTruth.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
process.env["ECONOMIC_CALENDAR_PROVIDER"] = "trading_economics";
process.env["TRADING_ECONOMICS_KEY"] = "te-key-selected-market-test";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

let windowRows: Array<Record<string, unknown>> = [];
let storedCount = 0;
let storedLatest: Date | null = null;
function chain(rows: () => unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.where = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve().then(rows).then(resolve, reject);
  return q;
}
const fakeDb = {
  select: (fields?: unknown) => ({
    from: (t: unknown) => chain(() => {
      if (t !== database.economicEventsTable) return [];
      return fields !== undefined ? [{ n: storedCount, latest: storedLatest }] : windowRows;
    }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { getSelectedMarketSnapshot, clearSelectedMarketCache } = await import("../selectedMarket.js");
type Deps = Parameters<typeof getSelectedMarketSnapshot>[1];

const M15 = 15 * 60_000;

function chart(trailingIntervals: number | null, nowMs: number) {
  const lastClosedClose = Math.floor(nowMs / M15) * M15;
  const n = 200;
  const candles = Array.from({ length: n }, (_, i) => {
    const closeMs = lastClosedClose - (n - 1 - i) * M15;
    const close = 1.10 + (0.05 * i) / (n - 1);
    return {
      open: close, high: close + 0.00025, low: close - 0.00025, close,
      openTime: new Date(closeMs - M15).toISOString(), closeTime: new Date(closeMs).toISOString(),
      volume: 0, tickVolume: null, isComplete: true, isFinal: true, isForming: false,
    };
  });
  return {
    candles,
    feedStatus: {
      symbol: "EURUSD", displaySymbol: "EUR/USD", assetClass: "forex", source: "mt5_broker",
      // Mirrors chartDataService: a gap of 2 is "delayed" and not live.
      isLive: trailingIntervals == null || trailingIntervals <= 1,
      lastTickTime: null, lastCandleTime: candles[n - 1]!.closeTime, latencyMs: 10,
      missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0,
      trailingIntervals, stale: false,
      quality: trailingIntervals != null && trailingIntervals >= 2 ? "delayed" : "clean",
      warning: null, aiUsable: trailingIntervals == null || trailingIntervals <= 1,
      feedReadinessState: null, message: "", completenessReason: null,
    },
  };
}

const noEvents: NonNullable<Deps>["loadEventsFn"] = async () => ({ events: [], scorerInput: [], calendar: { checked: true, note: null } });

beforeEach(() => {
  clearSelectedMarketCache();
  windowRows = [];
  storedCount = 0;
  storedLatest = null;
});

test("a cached LIVE_CONFIRMED read is not served past the interval boundary that ends it", async (t) => {
  const boundary = Date.UTC(2026, 9, 27, 14, 15, 0);
  let now = boundary - 10_000; // 14:14:50 — the M15 bar closing 14:00 is one interval behind
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const deps: Deps = {
    getChartCandlesFn: (async () => { calls++; return chart(calls === 1 ? 1 : 2, now) as never; }) as never,
    loadEventsFn: noEvents,
  };
  const args = { symbolRaw: "EURUSD", viewerUserId: 7 };
  const first = await getSelectedMarketSnapshot(args, deps);
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.dataState, "LIVE_CONFIRMED");
  assert.equal(first.liveClaimExpiresAt, new Date(boundary).toISOString(),
    "one interval behind: live only until the next bar is due");

  now = boundary - 2_000; // still before the boundary: a normal cache hit
  const warm = await getSelectedMarketSnapshot(args, deps);
  assert.ok(warm.ok && warm.cacheHit && warm.dataState === "LIVE_CONFIRMED");
  assert.equal(calls, 1);

  now = boundary + 5_000; // 15 s after the build: inside the 30 s TTL, past the boundary
  const after = await getSelectedMarketSnapshot(args, deps);
  assert.ok(after.ok);
  if (!after.ok) return;
  assert.equal(calls, 2, "the lapsed live claim forces a new read");
  assert.equal(after.cacheHit, false);
  assert.notEqual(after.dataState, "LIVE_CONFIRMED", "the new read reflects the feed now trailing by two bars");
});

test("a feed with no current bar gap reads live for two boundaries; an unknown gap is never cached as live", async (t) => {
  const boundary = Date.UTC(2026, 9, 27, 14, 15, 0);
  let now = boundary - 10_000;
  t.mock.method(Date, "now", () => now);
  let gap: number | null = 0;
  let calls = 0;
  const deps: Deps = {
    getChartCandlesFn: (async () => { calls++; return chart(gap, now) as never; }) as never,
    loadEventsFn: noEvents,
  };
  const a = await getSelectedMarketSnapshot({ symbolRaw: "EURUSD", viewerUserId: 7 }, deps);
  assert.ok(a.ok && a.liveClaimExpiresAt === new Date(boundary + M15).toISOString());

  clearSelectedMarketCache();
  gap = null;
  calls = 0;
  const b = await getSelectedMarketSnapshot({ symbolRaw: "EURUSD", viewerUserId: 7 }, deps);
  assert.ok(b.ok);
  if (!b.ok) return;
  if (b.dataState === "LIVE_CONFIRMED") {
    assert.equal(b.liveClaimExpiresAt, b.generatedAt, "an unknown gap has no live window to cache");
    now += 1_000;
    const again = await getSelectedMarketSnapshot({ symbolRaw: "EURUSD", viewerUserId: 7 }, deps);
    assert.ok(again.ok && !again.cacheHit);
    assert.equal(calls, 2);
  }
});

const nfpRow = (eventTime: Date) => ({
  id: 1, externalId: "te-nfp", eventName: "Non-Farm Payrolls", country: "United States", currency: "USD",
  impactLevel: "HIGH", forecast: null, previous: null, actual: null, eventTime, source: "trading_economics",
  affectedSymbols: null, volatilityFlag: 0, createdAt: new Date(),
});

async function selected(): Promise<any> {
  const env = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", refresh: true },
    { getChartCandlesFn: (async () => chart(1, Date.now()) as never) as never },
  );
  assert.ok(env.ok);
  return env;
}

test("a stored calendar that ends before the 24 h window is not a checked calendar", async () => {
  const inThreeHours = new Date(Date.now() + 3 * 3600_000);
  windowRows = [nfpRow(inThreeHours)];
  storedCount = 12;
  storedLatest = new Date(Date.now() + 5 * 3600_000);
  const env = await selected();
  assert.equal(env.upcomingEvents.length, 1, "stored events in the window are still listed");
  assert.equal(env.newsRisk.calendarChecked, false, "events after the stored calendar's end cannot be ruled out");
  assert.match(env.newsRisk.calendarNote, /only runs to/);
});

test("a never-synced stored calendar says so", async () => {
  const env = await selected();
  assert.equal(env.newsRisk.calendarChecked, false);
  assert.match(env.newsRisk.calendarNote, /never been synced/);
});

test("a stored calendar that covers the window with no events for the symbol is checked", async () => {
  storedCount = 40;
  storedLatest = new Date(Date.now() + 5 * 86400_000);
  const env = await selected();
  assert.equal(env.newsRisk.calendarChecked, true);
  assert.equal(env.newsRisk.calendarNote, null);
  assert.deepEqual(env.upcomingEvents, []);
});
