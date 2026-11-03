// Unit tests for the News-Adjusted Heat overlay engine. Run via:
//   node --import tsx --test src/brain/timing/__qa__/newsHeatEngine.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:timing-news`)
//
// The classifier, schedule-based news-risk engine, and market-impact radar are
// all injected so the overlay never depends on the wall clock or a live feed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNewsHeat, type NewsHeatDeps } from "../newsHeatEngine.js";

type NewsRisk = ReturnType<NonNullable<NewsHeatDeps["analyzeNewsRiskFn"]>>;

function newsRisk(over: Partial<NewsRisk> = {}): NewsRisk {
  return {
    majorNewsSoon: false,
    affectedCurrencies: [],
    affectedIndices: [],
    riskLevel: "Low",
    blockTrading: false,
    reason: "",
    ...over,
  };
}

// A disconnected radar (forces the schedule-based fallback path).
const disconnectedRadar: NewsHeatDeps["buildRadarFn"] = async () => ({
  radar: {
    symbol: "EURUSD",
    provider: { connected: false, name: "none", note: "no provider" },
    events: [],
    topSeverity: null,
    highImpactWindowActive: false,
    summary: "",
  },
  behavior: { mode: "NO_PROVIDER", note: "" },
});

test("synthetic instruments are immune to news → phase NONE, no block", async () => {
  const out = await computeNewsHeat("Volatility 75 Index", { classify: () => "synthetic" });
  assert.equal(out.phase, "NONE");
  assert.equal(out.blocksTrade, false);
  assert.equal(out.heatAdjustment, 0);
  assert.equal(out.eventType, "none");
});

test("critical scheduled event → blocksTrade true, PRE_EVENT, high-impact classification", async () => {
  const out = await computeNewsHeat("EURUSD", {
    classify: () => "forex",
    analyzeNewsRiskFn: () => newsRisk({
      majorNewsSoon: true,
      riskLevel: "Critical",
      blockTrading: true,
      nextEvent: "FOMC Rate Decision",
    }),
    buildRadarFn: disconnectedRadar,
  });
  assert.equal(out.blocksTrade, true);
  assert.equal(out.phase, "PRE_EVENT");
  assert.equal(out.heatAdjustment, 20);
  assert.equal(out.eventType, "high_impact");
});

test("no scheduled events → phase NONE, blocksTrade false", async () => {
  const out = await computeNewsHeat("EURUSD", {
    classify: () => "forex",
    analyzeNewsRiskFn: () => newsRisk(),
    buildRadarFn: disconnectedRadar,
  });
  assert.equal(out.phase, "NONE");
  assert.equal(out.blocksTrade, false);
  assert.equal(out.heatAdjustment, 0);
});

test("connected calendar with a live critical event → AT_EVENT, heat +30", async () => {
  const out = await computeNewsHeat("EURUSD", {
    classify: () => "forex",
    analyzeNewsRiskFn: () => newsRisk(), // does not block on its own
    buildRadarFn: async () => ({
      radar: {
        symbol: "EURUSD",
        provider: { connected: true, name: "calendar", note: "live" },
        events: [{
          id: "e1",
          title: "US CPI",
          currency: "USD",
          severity: "CRITICAL",
          eventTimeIso: "2026-01-05T13:00:00Z",
          countdownSeconds: 0, // happening now → AT_EVENT
          state: "LIVE",
          affectsSymbol: true,
          affectedSymbols: ["EURUSD"],
        }],
        topSeverity: "CRITICAL",
        highImpactWindowActive: true,
        summary: "",
      },
      behavior: { mode: "NEWS_LIVE", note: "" },
    }),
  });
  assert.equal(out.phase, "AT_EVENT");
  assert.equal(out.heatAdjustment, 30);
  assert.equal(out.minutesSince, 0);
  assert.equal(out.blocksTrade, false); // schedule engine did not block
});

test("radar failure fails open — falls back to schedule engine without throwing", async () => {
  const out = await computeNewsHeat("EURUSD", {
    classify: () => "forex",
    analyzeNewsRiskFn: () => newsRisk({ majorNewsSoon: false }),
    buildRadarFn: async () => { throw new Error("calendar down"); },
  });
  assert.equal(out.phase, "NONE");
  assert.equal(out.heatAdjustment, 0);
});

test("calendarConnected reflects the radar provider, not whether an event is near", async () => {
  const connectedEmpty: NewsHeatDeps["buildRadarFn"] = async () => ({
    radar: {
      symbol: "EURUSD",
      provider: { connected: true, name: "fred", note: "live" },
      events: [],
      topSeverity: null,
      highImpactWindowActive: false,
      summary: "",
    },
    behavior: { mode: "NORMAL", note: "" },
  });
  const on = await computeNewsHeat("EURUSD", { classify: () => "forex", analyzeNewsRiskFn: () => newsRisk(), buildRadarFn: connectedEmpty });
  assert.equal(on.phase, "NONE");
  assert.equal(on.calendarConnected, true);
  const off = await computeNewsHeat("EURUSD", { classify: () => "forex", analyzeNewsRiskFn: () => newsRisk(), buildRadarFn: disconnectedRadar });
  assert.equal(off.calendarConnected, false);
});

test("FRED date-only release held IMMINENT by the radar is not 'Settled' or 'N min ago'", async () => {
  const today = "2026-10-27";
  const out = await computeNewsHeat("EURUSD", {
    classify: () => "forex",
    analyzeNewsRiskFn: () => newsRisk(),
    buildRadarFn: async () => ({
      radar: {
        symbol: "EURUSD",
        provider: { connected: true, name: "fred", note: "live" },
        events: [{
          id: "cpi",
          title: "Consumer Price Index",
          currency: "USD",
          severity: "CRITICAL",
          eventTimeIso: `${today}T00:00:00.000Z`, // date-only sentinel
          countdownSeconds: -32_400, // 09:00 UTC, relative to midnight
          state: "IMMINENT", // radar: release time not confirmed, held imminent all day
          affectsSymbol: true,
          affectedSymbols: ["EURUSD"],
        }],
        topSeverity: "CRITICAL",
        highImpactWindowActive: true,
        summary: "",
      },
      behavior: { mode: "PRE_NEWS_CAUTION", note: "" },
    }),
  });
  assert.notEqual(out.phase, "SETTLED");
  assert.notEqual(out.phase, "POST_EVENT");
  assert.equal(out.phase, "PRE_EVENT");
  assert.equal(out.minutesSince, null);
  assert.equal(out.minutesUntil, null);
  assert.equal(out.heatAdjustment, 15);
});

// The radar lists every calendar event (affecting ones sorted first), so when
// nothing affects the symbol events[0] is an UNRELATED release. Its phase and
// heat must not be applied to this symbol.
function radarWith(events: Array<{ id: string; title: string; currency: string; affectsSymbol: boolean; countdownSeconds: number; state: string }>): NewsHeatDeps["buildRadarFn"] {
  return async () => ({
    radar: {
      symbol: "EURUSD",
      provider: { connected: true, name: "calendar", note: "live" },
      events: events.map((e) => ({
        ...e,
        severity: "CRITICAL",
        eventTimeIso: "2026-10-28T13:00:00Z",
        affectedSymbols: e.affectsSymbol ? ["EURUSD"] : ["USDJPY"],
      })),
      topSeverity: "CRITICAL",
      highImpactWindowActive: false,
      summary: "",
    },
    behavior: { mode: "NORMAL", note: "" },
  }) as never;
}

test("an unrelated event (affectsSymbol false) never sets this symbol's news phase or heat", async () => {
  const out = await computeNewsHeat("EURUSD", {
    classify: () => "forex",
    analyzeNewsRiskFn: () => newsRisk(),
    buildRadarFn: radarWith([
      { id: "jp", title: "BoJ Rate Decision", currency: "JPY", affectsSymbol: false, countdownSeconds: 0, state: "LIVE" },
    ]),
  });
  assert.equal(out.calendarConnected, true);
  assert.equal(out.phase, "NONE");
  assert.equal(out.eventName, null);
  assert.equal(out.heatAdjustment, 0);
  assert.equal(out.minutesSince, null);
  assert.equal(out.eventType, "none");
});

test("the event that affects the symbol drives the overlay even when an unrelated one is listed first", async () => {
  const out = await computeNewsHeat("EURUSD", {
    classify: () => "forex",
    analyzeNewsRiskFn: () => newsRisk(),
    buildRadarFn: radarWith([
      { id: "jp", title: "BoJ Rate Decision", currency: "JPY", affectsSymbol: false, countdownSeconds: 0, state: "LIVE" },
      { id: "eu", title: "ECB Rate Decision", currency: "EUR", affectsSymbol: true, countdownSeconds: 600, state: "IMMINENT" },
    ]),
  });
  assert.equal(out.eventName, "ECB Rate Decision");
  assert.equal(out.phase, "PRE_EVENT");
  assert.equal(out.minutesUntil, 10);
  assert.equal(out.heatAdjustment, 15);
});

// The date-only guard above must not catch a TIMED release: a connected
// calendar with a confirmed release time 20 s away is at the event (heat +30,
// the at-event stand-by), not "pre-event, release time not confirmed".
function timedRadar(countdownSeconds: number, state: string, providerName = "fred"): NewsHeatDeps["buildRadarFn"] {
  return async () => ({
    radar: {
      symbol: "EURUSD",
      provider: { connected: true, name: providerName, note: "live" },
      events: [{
        id: "cpi-timed",
        title: "US CPI",
        currency: "USD",
        severity: "HIGH",
        eventTimeIso: "2026-10-28T12:30:00.000Z", // a real release time, not a date sentinel
        countdownSeconds,
        state,
        affectsSymbol: true,
        affectedSymbols: ["EURUSD"],
      }],
      topSeverity: "HIGH",
      highImpactWindowActive: true,
      summary: "",
    },
    behavior: { mode: "PRE_NEWS_CAUTION", note: "" },
  }) as never;
}

test("a timed release 20 s away (radar IMMINENT) is AT_EVENT, not an unconfirmed pre-event", async () => {
  for (const providerName of ["fred", "trading_economics"]) {
    const out = await computeNewsHeat("EURUSD", {
      classify: () => "forex",
      analyzeNewsRiskFn: () => newsRisk(),
      buildRadarFn: timedRadar(20, "IMMINENT", providerName),
    });
    assert.equal(out.phase, "AT_EVENT", providerName);
    assert.equal(out.heatAdjustment, 30, providerName);
    assert.equal(out.minutesSince, 0, providerName);
    assert.equal(out.minutesUntil, null, providerName);
  }
});

test("a timed release exactly 30 s away is never '1 min ago'", async () => {
  const out = await computeNewsHeat("EURUSD", {
    classify: () => "forex",
    analyzeNewsRiskFn: () => newsRisk(),
    buildRadarFn: timedRadar(30, "IMMINENT"),
  });
  assert.equal(out.phase, "AT_EVENT");
  assert.equal(out.minutesSince, 0);
});

test("a timed release 10 min away keeps its known minute count", async () => {
  const out = await computeNewsHeat("EURUSD", {
    classify: () => "forex",
    analyzeNewsRiskFn: () => newsRisk(),
    buildRadarFn: timedRadar(600, "IMMINENT"),
  });
  assert.equal(out.phase, "PRE_EVENT");
  assert.equal(out.minutesUntil, 10);
  assert.equal(out.heatAdjustment, 15);
});

test("a date-only FRED release in its first seconds after midnight is still release-time-unconfirmed", async () => {
  const out = await computeNewsHeat("EURUSD", {
    classify: () => "forex",
    analyzeNewsRiskFn: () => newsRisk(),
    buildRadarFn: async () => ({
      radar: {
        symbol: "EURUSD",
        provider: { connected: true, name: "fred", note: "live" },
        events: [{
          id: "cpi",
          title: "Consumer Price Index",
          currency: "USD",
          severity: "CRITICAL",
          eventTimeIso: "2026-10-28T00:00:00.000Z", // date-only sentinel
          countdownSeconds: 0, // exactly midnight UTC
          state: "IMMINENT",
          affectsSymbol: true,
          affectedSymbols: ["EURUSD"],
        }],
        topSeverity: "CRITICAL",
        highImpactWindowActive: true,
        summary: "",
      },
      behavior: { mode: "PRE_NEWS_CAUTION", note: "" },
    }),
  });
  assert.equal(out.phase, "PRE_EVENT");
  assert.equal(out.minutesUntil, null);
  assert.equal(out.minutesSince, null);
  assert.equal(out.heatAdjustment, 15);
});
