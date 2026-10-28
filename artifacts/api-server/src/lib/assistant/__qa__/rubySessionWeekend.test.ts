// Truth regression: Ruby's briefing must not say FX is open at the weekend.
// analyzeSession() reads only the UTC hour, so on Saturday 10:00 UTC it names
// "London". The briefing's session must use the FX week (Sun 17:00 - Fri 17:00
// New York) and say forex is closed, whatever the hour says.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { composeRubyBriefing, rubySessionContext, type RubyContext } from "../rubyContext.js";

function briefingLines(session: RubyContext["session"]): string[] {
  const ctx: RubyContext = {
    generatedAt: "2026-10-31T10:00:00.000Z",
    page: { key: "/", label: "Cockpit" },
    role: "USER",
    isPrivileged: false,
    timeOfDay: "morning",
    serverUtcHour: 10,
    session,
    symbol: null,
    bridge: { availability: "UNAVAILABLE", connected: false, message: "" },
    account: { mt5: null, allocation: null, openPositions: 0, openPositionsChecked: true, unverifiedPositions: 0, openPL: null, snapshotFreshness: null, live: null },
    performance: { hasTrades: false },
    news: { connected: true, items: [], riskLevel: "low" },
    calendar: { connected: true, next: null },
    weather: { available: false },
    location: { available: false },
    warnings: [],
  } as RubyContext;
  return composeRubyBriefing(ctx).lines;
}

function at(iso: string, fn: (now: Date) => void) {
  const ms = Date.parse(iso);
  mock.timers.enable({ apis: ["Date"], now: ms });
  try { fn(new Date(ms)); } finally { mock.timers.reset(); }
}

test("Saturday 10:00 UTC: forex is closed, not 'London session is active'", () => {
  at("2026-10-31T10:00:00.000Z", (now) => {
    const s = rubySessionContext("forex", "EURUSD", now)!;
    assert.equal(s.forexOpen, false);
    assert.notEqual(s.name, "London");
    assert.match(s.name, /Weekend/);
    const lines = briefingLines(s);
    assert.ok(!lines.some((l) => /session is active/.test(l)), lines.join(" | "));
    assert.ok(lines.some((l) => /Forex is closed right now/.test(l)), lines.join(" | "));
  });
});

test("Sunday 12:00 UTC (before the 17:00 New York open): forex is closed", () => {
  at("2026-11-01T12:00:00.000Z", (now) => {
    assert.equal(rubySessionContext("forex", "EURUSD", now)!.forexOpen, false);
  });
});

test("Friday 22:30 UTC (after the 17:00 New York close): forex is closed", () => {
  at("2026-10-30T22:30:00.000Z", (now) => {
    assert.equal(rubySessionContext("forex", "EURUSD", now)!.forexOpen, false);
  });
});

test("a synthetic symbol at the weekend does not claim an FX session is active", () => {
  at("2026-10-31T10:00:00.000Z", (now) => {
    const s = rubySessionContext("synthetic", "Volatility 75 Index", now)!;
    assert.equal(s.forexOpen, false);
    const lines = briefingLines(s);
    assert.ok(!lines.some((l) => /London session is active/.test(l)), lines.join(" | "));
    assert.ok(lines.some((l) => /synthetic indices may still trade/.test(l)), lines.join(" | "));
  });
});

test("Wednesday 10:00 UTC: the London session reads as active, as before", () => {
  at("2026-10-28T10:00:00.000Z", (now) => {
    const s = rubySessionContext("forex", "EURUSD", now)!;
    assert.equal(s.forexOpen, true);
    assert.equal(s.name, "London");
    const lines = briefingLines(s);
    assert.ok(lines.includes("London session is active (high liquidity)."), lines.join(" | "));
  });
});
