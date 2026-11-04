// Truth regression: the briefing's per-symbol feed line must describe the
// feed state it was given. UNAVAILABLE means there is nothing to read, so the
// line must not call it "live data" or promise a read; STALE must not promise
// a current read either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeRubyBriefing, type RubyContext } from "../rubyContext.js";

type MarketFeed = NonNullable<NonNullable<RubyContext["symbol"]>["marketFeed"]>;

function ctxWithFeed(marketFeed: MarketFeed): RubyContext {
  return {
    generatedAt: "2026-10-28T09:00:00.000Z",
    page: { key: "/", label: "Cockpit" },
    role: "USER",
    isPrivileged: false,
    timeOfDay: "morning",
    serverUtcHour: 9,
    session: null,
    symbol: {
      symbol: "EURUSD",
      tradable: "unknown",
      badge: "",
      assetClass: "forex",
      marketFeed,
    },
    bridge: { availability: "UNAVAILABLE", connected: false, message: "" },
    account: {
      mt5: null,
      allocation: null,
      openPositions: 0,
      openPL: null,
      snapshotFreshness: null,
      live: null,
    },
    performance: { hasTrades: false },
    news: { connected: true, items: [], riskLevel: "low" },
    calendar: { connected: true, next: null },
    weather: { available: false },
    location: { available: false },
    warnings: [],
  };
}

function feedLine(mf: MarketFeed): string {
  const lines = composeRubyBriefing(ctxWithFeed(mf)).lines;
  const line = lines.find((l) => l.includes("EURUSD") && /data/i.test(l));
  assert.ok(line, `expected a feed line for EURUSD: ${lines.join(" | ")}`);
  return line!;
}

test("UNAVAILABLE feed: no 'live data', no promise to read it", () => {
  const line = feedLine({
    source: null,
    quality: "unavailable",
    freshness: "UNAVAILABLE",
    aiUsable: false,
    isLive: false,
    lastPrice: null,
  });
  assert.doesNotMatch(line, /unavailable right now — I'll read it cautiously/);
  assert.doesNotMatch(line, /live data/i);
  assert.doesNotMatch(line, /I'll read it/i);
  assert.match(line, /unavailable/i);
  assert.match(line, /can't read/i);
});

test("STALE feed: says stale and does not promise a current read", () => {
  const line = feedLine({
    source: "mt5_broker",
    quality: "stale",
    freshness: "STALE",
    aiUsable: false,
    isLive: false,
    lastPrice: 1.08,
  });
  assert.match(line, /stale/i);
  assert.doesNotMatch(line, /live data/i);
  assert.doesNotMatch(line, /I'll read it cautiously/);
});

test("DELAYED feed: says delayed and reads cautiously", () => {
  const line = feedLine({
    source: "assistant_real",
    quality: "delayed",
    freshness: "DELAYED",
    aiUsable: true,
    isLive: false,
    lastPrice: 1.08,
  });
  assert.match(line, /delayed/i);
  assert.doesNotMatch(line, /live data/i);
  assert.match(line, /cautiously/);
});

test("REALTIME clean feed keeps the confident line", () => {
  const line = feedLine({
    source: "mt5_broker",
    quality: "clean",
    freshness: "REALTIME",
    aiUsable: true,
    isLive: true,
    lastPrice: 1.08,
  });
  assert.match(line, /clean right now/);
});

test("REALTIME but not AI-usable is not called clean", () => {
  const line = feedLine({
    source: "mt5_broker",
    quality: "partial",
    freshness: "REALTIME",
    aiUsable: false,
    isLive: true,
    lastPrice: 1.08,
  });
  assert.doesNotMatch(line, /clean right now/);
  assert.match(line, /cautiously/);
});
