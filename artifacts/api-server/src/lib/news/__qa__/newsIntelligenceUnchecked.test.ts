// A configured calendar that did not answer, or a calendar read that threw, is
// a failed check — not "no major scheduled news". The pack must flag it and its
// warning must not read as an all-clear.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/news/__qa__/newsIntelligenceUnchecked.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

type CalMode = "fetch_error" | "throw" | "not_configured" | "connected";
let calMode: CalMode = "fetch_error";

mock.module("../../assistant/marketProvider.js", {
  namedExports: {
    getMarketProvider: () => ({
      getMarketNews: async () => ({ connected: false, items: [], provider: "none" }),
    }),
  },
});
mock.module("../economicCalendarProvider.js", {
  namedExports: {
    getEconomicCalendar: async () => {
      if (calMode === "throw") throw new Error("calendar offline fixture");
      if (calMode === "fetch_error") {
        return { connected: false, provider: "trading_economics", status: "error", events: [], providerState: "fetch_error" };
      }
      if (calMode === "not_configured") {
        return { connected: false, provider: "none", status: "missing", events: [], providerState: "not_configured" };
      }
      return { connected: true, provider: "trading_economics", status: "empty", events: [], providerState: "connected" };
    },
  },
});

const { getNewsIntelligence, calendarCheckFailed } = await import("../newsIntelligenceService.js");

test("configured calendar whose fetch failed is a failed check, not an all-clear", async () => {
  calMode = "fetch_error";
  const pack = await getNewsIntelligence("EURUSD");
  assert.equal(calendarCheckFailed(pack.dataSources.calendar), true);
  assert.doesNotMatch(pack.warningSummary, /No major scheduled news/i);
  assert.match(pack.warningSummary, /could not be checked/i);
});

test("calendar read that threw is reported as a failed check, never 'not configured'", async () => {
  calMode = "throw";
  const pack = await getNewsIntelligence("GBPUSD");
  assert.equal(pack.dataSources.calendar.providerState, "fetch_error");
  assert.equal(calendarCheckFailed(pack.dataSources.calendar), true);
  assert.doesNotMatch(pack.dataSources.calendar.note, /is configured/i);
  assert.match(pack.warningSummary, /could not be checked/i);
});

test("control: calendar not configured is not a failed check", async () => {
  calMode = "not_configured";
  const pack = await getNewsIntelligence("USDJPY");
  assert.equal(calendarCheckFailed(pack.dataSources.calendar), false);
});

test("control: connected quiet calendar keeps the all-clear copy", async () => {
  calMode = "connected";
  const pack = await getNewsIntelligence("AUDUSD");
  assert.equal(calendarCheckFailed(pack.dataSources.calendar), false);
  assert.match(pack.warningSummary, /No major scheduled news/i);
});

test("synthetic instrument keeps its copy when the calendar fails", async () => {
  calMode = "fetch_error";
  const pack = await getNewsIntelligence("Volatility 75 Index");
  assert.doesNotMatch(pack.warningSummary, /could not be checked/i);
});

// No calendar configured: nothing scheduled was looked at. Every consumer of
// the pack (scanner news warning, trade-ticket News Risk Check) shows its
// warningSummary, so it must say scheduled news was not checked — never the
// "No major scheduled news" all-clear — and the pack must name that state.
test("calendar not configured: summary says scheduled news was not checked, never an all-clear", async () => {
  calMode = "not_configured";
  const pack = await getNewsIntelligence("NZDUSD");
  assert.equal(pack.scheduledEventRisk, "not_checked");
  assert.doesNotMatch(pack.warningSummary, /No major scheduled news/i);
  assert.match(pack.warningSummary, /not checked/i);
  assert.match(pack.warningSummary, /no economic-calendar provider is connected/i);
});

test("scheduledEventRisk names what was checked: failed read, connected calendar, synthetic", async () => {
  calMode = "fetch_error";
  assert.equal((await getNewsIntelligence("EURCHF")).scheduledEventRisk, "not_checked");
  calMode = "connected";
  assert.equal((await getNewsIntelligence("EURGBP")).scheduledEventRisk, "checked");
  calMode = "not_configured";
  const synth = await getNewsIntelligence("Volatility 10 Index");
  assert.equal(synth.scheduledEventRisk, "not_applicable");
  assert.doesNotMatch(synth.warningSummary, /not checked/i);
});
