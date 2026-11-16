// Truth audit 2026-10-27 — FRED release dates carry no clock time. The FRED
// provider emits a midnight-UTC date sentinel for every event. The radar must
// not treat that sentinel as a confirmed release time: a high-impact release
// dated today has NOT "already happened" at 00:30 UTC, and its real (unknown)
// release time today must not read as an all-clear.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { RawCalendarEvent } from "@workspace/domain/smart-chart";

let provider = "fred";
let events: RawCalendarEvent[] = [];
const cal = await import("../../news/economicCalendarProvider.js");
mock.module("../../news/economicCalendarProvider.js", { namedExports: { ...cal,
  getEconomicCalendar: async () => ({ connected: true, provider, status: "ok", events, providerState: "connected" }),
} });
const intel = await import("../../news/newsIntelligenceService.js");
mock.module("../../news/newsIntelligenceService.js", { namedExports: { ...intel,
  getNewsIntelligence: async () => ({ dataSources: { headlines: { connected: false } } }),
} });
const { buildMarketImpactRadar } = await import("../../news/marketImpactRadar.js");

const cpi = (date: string): RawCalendarEvent => ({ id: `fred_10_${date}`, title: "Consumer Price Index", currency: "USD", impact: "high",
  eventTimeIso: `${date}T00:00:00.000Z`, affectedMarkets: ["EURUSD"] });

test("FRED high-impact release dated today is not reported as already past, and is not an all-clear", async () => {
  provider = "fred"; events = [cpi("2026-10-27")];
  // 12:35 UTC — US CPI is typically released 12:30 UTC; FRED does not know the time.
  const { radar } = await buildMarketImpactRadar("EURUSD", Date.parse("2026-10-27T12:35:00.000Z"));
  const e = radar.events[0]!;
  assert.equal(e.affectsSymbol, true);
  assert.notEqual(e.state, "RECENT", "a same-day release with an unknown time cannot be reported as already past");
  assert.equal(radar.highImpactWindowActive, true);
  assert.doesNotMatch(radar.summary, /min ago/);
});

test("FRED release dated yesterday is past, and dated in days is upcoming", async () => {
  provider = "fred"; events = [cpi("2026-10-26")];
  let { radar } = await buildMarketImpactRadar("EURUSD", Date.parse("2026-10-27T12:35:00.000Z"));
  assert.equal(radar.events[0]!.state, "RECENT"); assert.equal(radar.highImpactWindowActive, false);
  events = [cpi("2026-10-30")];
  ({ radar } = await buildMarketImpactRadar("EURUSD", Date.parse("2026-10-27T12:35:00.000Z")));
  assert.equal(radar.events[0]!.state, "UPCOMING"); assert.equal(radar.highImpactWindowActive, false);
});

test("a provider with exact times keeps its exact window semantics (midnight is a real time there)", async () => {
  provider = "trading_economics"; events = [cpi("2026-10-27")];
  const { radar } = await buildMarketImpactRadar("EURUSD", Date.parse("2026-10-27T12:35:00.000Z"));
  assert.equal(radar.events[0]!.state, "RECENT"); assert.equal(radar.highImpactWindowActive, false);
});
