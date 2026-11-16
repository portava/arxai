// Deterministic honesty lock for the Market Impact Radar. Run via:
//   pnpm --filter @workspace/api-server run test:market-heat-radar-honesty
//
// NON-NEGOTIABLE HONESTY: with no live economic-calendar provider connected the
// radar NEVER fabricates a scheduled event and NEVER reads as a confident
// all-clear. The disconnected note must distinguish missing configuration from
// a failed fetch, the event list must be empty, and the summary must name the disconnected provider rather than
// implying "no events". Synthetic instruments are never driven by macro events.
// Advisory only — the radar carries no execution field of any kind.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildMarketImpactRadar, isSyntheticSymbol } from "../marketImpactRadar.js";
import { SYNTHETIC_EVENT_RISK_LABEL } from "@workspace/domain/truth";
import { __resetEconomicCalendarStateForTests, __setEconomicCalendarFetcherForTests } from "../calendar/economicCalendarService.js";
import { _resetMarketProviderForTests, _setMarketProviderForTests } from "../../assistant/marketProvider.js";

const NOW = Date.parse("2026-06-19T12:00:00.000Z");

const ENV_KEYS = ["ECONOMIC_CALENDAR_PROVIDER", "TRADING_ECONOMICS_KEY", "TRADING_ECONOMICS_SECRET", "FRED_API_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};
let fetchFailed = false;
const EVENT = { CalendarId: "offline-cpi", Date: "2026-06-19T12:10:00Z", Country: "United States",
  Currency: "USD", Category: "Inflation", Event: "CPI fixture", Importance: 3, Actual: null, Forecast: null, Previous: null };
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ECONOMIC_CALENDAR_PROVIDER = "trading_economics";
  process.env.TRADING_ECONOMICS_KEY = "offline-test-only";
  fetchFailed = false;
  __resetEconomicCalendarStateForTests();
  __setEconomicCalendarFetcherForTests(async () => ({ ok: !fetchFailed, status: fetchFailed ? 503 : 200,
    text: async () => fetchFailed ? "fixture upstream unavailable" : JSON.stringify([EVENT]) }));
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected non-news provider call in radar fixture"); };
  _setMarketProviderForTests({ name: "offline-headlines", connected: false,
    features: { quotes: false, news: false, snapshots: false, economicCalendar: false, candles: false },
    getMarketNews: async () => ({ connected: false, items: [], provider: "offline-headlines" }),
    getLiveQuote: unexpected, getCandles: unexpected, getEconomicCalendar: unexpected,
    getSymbolOverview: unexpected, getTradingSessionContext: unexpected });
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __resetEconomicCalendarStateForTests();
  __setEconomicCalendarFetcherForTests(null);
  _resetMarketProviderForTests();
});
const STATES = ["not_configured", "fetch_error", "connected"] as const;
function selectState(state: typeof STATES[number]) {
  if (state === "not_configured") delete process.env.TRADING_ECONOMICS_KEY;
  fetchFailed = state === "fetch_error";
}

for (const state of STATES) test(`radar: ${state} events are real-or-empty — never fabricated while disconnected`, async () => {
  selectState(state);
  const { radar } = await buildMarketImpactRadar("EURUSD", NOW);
  assert.equal(radar.provider.connected, state === "connected");

  if (!radar.provider.connected) {
    assert.deepEqual(radar.events, []);
    if (state === "fetch_error") {
      assert.match(radar.provider.note, /configured but the last fetch failed/i);
      assert.match(radar.provider.note, /events unavailable until the next successful refresh/i);
      assert.doesNotMatch(radar.provider.note, /no .*provider is configured/i);
    } else {
      assert.match(radar.provider.note, /no live economic-calendar provider is configured/i);
      assert.match(radar.provider.note, /none are fabricated/i);
    }
    assert.equal(radar.provider.fetchedAt, null);
    // The summary must name the missing provider, never imply a confident
    // "no events" all-clear.
    assert.match(radar.summary, /no live economic-calendar provider is connected/i);
    assert.doesNotMatch(radar.summary, /low risk/i);
    return;
  }

  // Connected: the radar may show events, but every one must be a real, fully
  // attributed record — no filler rows, no placeholder titles, no invented
  // timestamps — and the copy must not claim a provider is missing.
  assert.match(radar.provider.note, /live economic-calendar feed connected/i);
  assert.equal(radar.events.length, 1, "the attributed offline provider fixture must actually exercise the connected branch");
  assert.equal(radar.events[0]!.title, EVENT.Event);
  assert.doesNotMatch(radar.summary, /no live economic-calendar provider is connected/i);
  assert.doesNotMatch(radar.summary, /low risk/i);
  for (const e of radar.events) {
    assert.ok(e.id.length > 0, "event carries a real id");
    assert.ok(e.title.length > 0, "event carries a real title");
    assert.ok(
      ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(e.severity),
      `event severity is a real level: ${e.severity}`,
    );
    assert.ok(
      Number.isFinite(Date.parse(e.eventTimeIso)),
      `event carries a parseable time: ${e.eventTimeIso}`,
    );
    assert.ok(
      Number.isFinite(e.countdownSeconds),
      "countdown is derived from a real timestamp, never a placeholder",
    );
  }
});

for (const state of STATES) test(`radar: ${state} severity and high-impact window are earned, never asserted`, async () => {
  selectState(state);
  const { radar } = await buildMarketImpactRadar("XAUUSD", NOW);
  assert.equal(radar.provider.connected, state === "connected");

  if (!radar.provider.connected) {
    // The original assertions, unchanged, on the disconnected path.
    assert.equal(radar.highImpactWindowActive, false);
    assert.equal(radar.topSeverity, null);
    return;
  }

  // Connected: severity must be BACKED by an event that affects this symbol —
  // it can never be conjured from an empty or non-affecting event list.
  const affecting = radar.events.filter((e) => e.affectsSymbol);
  if (affecting.length === 0) {
    assert.equal(radar.topSeverity, null, "no affecting event ⇒ no severity");
    assert.equal(radar.highImpactWindowActive, false, "no affecting event ⇒ no window");
    return;
  }
  assert.ok(
    radar.topSeverity != null && affecting.some((e) => e.severity === radar.topSeverity),
    `topSeverity ${radar.topSeverity} must be carried by an affecting event`,
  );
  if (radar.highImpactWindowActive) {
    // A high-impact window requires a live-or-imminent CRITICAL/HIGH event.
    assert.ok(
      affecting.some(
        (e) =>
          (e.severity === "CRITICAL" || e.severity === "HIGH") &&
          (e.state === "LIVE" || e.state === "IMMINENT"),
      ),
      "high-impact window must be backed by a live/imminent CRITICAL or HIGH event",
    );
  }
});

test("radar: synthetic instrument is never driven by macro events", async () => {
  const { radar } = await buildMarketImpactRadar("Volatility 75 Index", NOW);
  assert.equal(radar.events.some((e) => e.affectsSymbol), false);
  if (!radar.provider.connected) assert.deepEqual(radar.events, []);
  assert.equal(radar.summary, SYNTHETIC_EVENT_RISK_LABEL);
  assert.match(radar.summary, /not driven by scheduled economic events/i);
});

// Owner screenshot 2026-10-27: the scanner's OWN canonical keys ("V75",
// "V75_1S") were missed by the radar's private name regex, so the V75 truth
// read carried calendar wording while the heat list called it immune.
for (const key of ["V75", "V75_1S", "1HZ75V", "R_75", "CRASH500", "BOOM1000"]) {
  test(`radar: canonical synthetic key ${key} is recognised as synthetic`, async () => {
    assert.equal(isSyntheticSymbol(key), true);
    const { radar } = await buildMarketImpactRadar(key, NOW);
    assert.equal(radar.summary, SYNTHETIC_EVENT_RISK_LABEL);
    assert.equal(radar.events.some((e) => e.affectsSymbol), false);
    assert.equal(radar.highImpactWindowActive, false);
    assert.equal(radar.topSeverity, null);
  });
}
for (const key of ["EURUSD", "XAUUSD", "US30", "BTCUSD", "NAS100"]) {
  test(`radar: control — ${key} is not synthetic`, () => {
    assert.equal(isSyntheticSymbol(key), false);
  });
}

test("radar: result is advisory-only — carries no execution field", async () => {
  const result = await buildMarketImpactRadar("EURUSD", NOW);
  const blob = JSON.stringify(result).toLowerCase();
  assert.equal(blob.includes("allowexecution"), false);
  assert.equal(blob.includes("alloworderexecution"), false);
  assert.equal(blob.includes("cantrade"), false);
  assert.equal(blob.includes("liveunlock"), false);
});
