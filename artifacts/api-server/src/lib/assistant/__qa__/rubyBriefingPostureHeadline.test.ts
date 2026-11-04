// Truth regression: the briefing headline must not tell a paper/demo user (or a
// user whose posture could not be read) "You're live-connected through Shared
// Master MT5." just because the SHARED master bridge is healthy. Only the
// user's own canonical balance source reading live_shared earns that sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeRubyBriefing, type RubyContext } from "../rubyContext.js";

type Live = NonNullable<RubyContext["account"]["live"]>;
function live(source: Live["source"]): Live {
  return {
    source, allocatedBalance: 0, realizedPnL: 0, floatingPnL: null, liveEquity: 0, marginUsed: 0,
    freeMargin: 0, availableBalance: 0, openTradeCount: 0,
    freshness: { status: "fresh", lastUpdatedAt: null, ageMs: null },
  };
}
function ctx(liveAcct: Live | null, connected = true): RubyContext {
  return {
    generatedAt: "2026-10-28T09:00:00.000Z",
    page: { key: "/", label: "Cockpit" },
    role: "USER",
    isPrivileged: false,
    timeOfDay: "morning",
    serverUtcHour: 9,
    session: null,
    symbol: null,
    bridge: { availability: connected ? "HEALTHY" : "UNAVAILABLE", connected, message: "" },
    account: { mt5: null, allocation: null, openPositions: 0, openPositionsChecked: true, openPL: null, snapshotFreshness: null, live: liveAcct },
    performance: { hasTrades: false },
    news: { connected: true, items: [], riskLevel: "low" },
    calendar: { connected: true, next: null },
    weather: { available: false },
    location: { available: false },
    warnings: [],
  };
}

test("live_shared user on a healthy bridge: live-connected", () => {
  assert.match(composeRubyBriefing(ctx(live("live_shared"))).headline, /You're live-connected through Shared Master MT5\./);
});

test("paper and demo users are told their real path, not live-connected", () => {
  for (const src of ["paper", "demo"] as const) {
    const h = composeRubyBriefing(ctx(live(src))).headline;
    assert.doesNotMatch(h, /live-connected/, `${src}: ${h}`);
    assert.match(h, new RegExp(`your account is on the ${src} path, not live`));
  }
});

test("unknown or unread posture is not upgraded to live", () => {
  for (const l of [live("unknown"), null]) {
    const h = composeRubyBriefing(ctx(l)).headline;
    assert.doesNotMatch(h, /live-connected/);
    assert.match(h, /couldn't confirm your account is on the live path/);
  }
});

test("bridge offline: unchanged offline headline", () => {
  assert.match(composeRubyBriefing(ctx(live("live_shared"), false)).headline, /offline at the moment/);
});
