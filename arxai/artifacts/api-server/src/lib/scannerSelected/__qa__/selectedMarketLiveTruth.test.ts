// Selected-market envelope: a cached "live" read and an unsynced calendar.
//
// 1. The selected-market envelope is cached for 30 s. A feed read
//    LIVE_CONFIRMED with its newest bar one interval behind stops being live
//    at the next interval boundary (the trailing gap becomes 2), but the
//    cached envelope kept saying LIVE_CONFIRMED — with a bias, confidence and
//    levels — for up to 30 s after that.
// 2. The upcoming-event list must never call an unread calendar "checked".
//    On the Truth line the list read the stored economic_events table and used
//    the stored-calendar coverage rule. On this (Codex) line the list reads the
//    connected-calendar authority (resolveNewsRiskEvents) instead, and the
//    scanner-selected-market guard forbids direct economic_events reads, so the
//    stored-coverage cases are ported to the resolver: an unread calendar is
//    not checked, a connected calendar with no events for the symbol is.
//
// The database handle is stubbed to throw (the builder must not touch it); the
// chart source and the calendar resolver are injected. No network.
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

const fakeDb = {
  select: () => { throw new Error("Unexpected database access"); },
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { getSelectedMarketSnapshot, clearSelectedMarketCache, loadEventRows } = await import("../selectedMarket.js");
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

const noEvents: NonNullable<Deps>["loadEventsFn"] = async () => ({ events: [], scorerInput: [], calendarAvailable: true, calendar: { checked: true, note: null } });

beforeEach(() => {
  clearSelectedMarketCache();
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

type Resolved = Awaited<ReturnType<NonNullable<Parameters<typeof loadEventRows>[2]>>>;
const nfp = (eventTime: Date) => ({
  id: "te-nfp", title: "Non-Farm Payrolls", country: "United States", currency: "USD", impact: "high" as const,
  actual: null, forecast: null, previous: null, eventTime: eventTime.toISOString(),
  affectedMarkets: ["EURUSD"], source: "trading_economics",
});

async function selected(resolved: Resolved): Promise<any> {
  const env = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", refresh: true },
    {
      getChartCandlesFn: (async () => chart(1, Date.now()) as never) as never,
      loadEventsFn: (symbol, hints) => loadEventRows(symbol, hints, async () => resolved),
    },
  );
  assert.ok(env.ok);
  return env;
}

test("a calendar that could not be read is not a checked calendar", async () => {
  const env = await selected({ available: false, events: [], reason: "Economic calendar provider error — test could not be reached.", provider: "test" });
  assert.equal(env.newsRisk.calendarAvailable, false);
  assert.equal(env.newsRisk.calendarChecked, false, "an unread calendar is never a checked one");
  assert.ok((env.newsRisk.calendarNote ?? "").length > 0);
  assert.doesNotMatch(env.newsRisk.summary, /No relevant/);
  assert.equal(env.newsRisk.levelBasis, null);
  assert.deepEqual(env.upcomingEvents, []);
});

test("a connected calendar lists the symbol's events in the window", async () => {
  const env = await selected({ available: true, events: [nfp(new Date(Date.now() + 3 * 3600_000))], reason: "Economic calendar connected.", provider: "test" });
  assert.equal(env.upcomingEvents.length, 1, "events in the window are listed");
  assert.equal(env.upcomingEvents[0].timePublished, true);
  assert.equal(env.newsRisk.calendarChecked, true);
});

test("a connected calendar with no events for the symbol is checked", async () => {
  const env = await selected({ available: true, events: [], reason: "No relevant economic events.", provider: "test" });
  assert.equal(env.newsRisk.calendarChecked, true);
  assert.equal(env.newsRisk.calendarNote, null);
  assert.deepEqual(env.upcomingEvents, []);
});

test("a FRED release dated today stays listed from the connected calendar and is never scored to midnight", async () => {
  const now = Date.now();
  const d = new Date(now);
  const todayMarker = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Only meaningful once the marker is more than the scorer's 15 min post-event
  // window behind (the scorer still sees every calendar event).
  if (now - todayMarker.getTime() <= 15 * 60_000) return;
  const fred = { ...nfp(todayMarker), id: "fred-gdp", title: "GDP", source: "FRED" };
  const env = await selected({ available: true, events: [fred], reason: "Economic calendar connected.", provider: "FRED" });
  assert.equal(env.upcomingEvents.length, 1, "a date-only release dated today is not known to be over");
  assert.equal(env.upcomingEvents[0].timePublished, false);
  assert.equal(env.newsRisk.levelBasis, "unscored");
  assert.match(env.newsRisk.summary, /no published release time/);
  assert.doesNotMatch(env.newsRisk.summary, /No relevant high-impact news/);
});
