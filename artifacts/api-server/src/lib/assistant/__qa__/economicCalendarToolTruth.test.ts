// Truth regression: the getEconomicCalendar tool returned `{ connected:false,
// events: [] }` with nothing telling the model that an empty list from an
// unconnected calendar means "not checked", so "no events" was a natural (and
// false) reading. It now carries calendarChecked + a plain-English note.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

let cal: { connected: boolean; events: unknown[]; provider: string } = { connected: false, events: [], provider: "none" };
const realProvider = await import("../marketProvider.js");
mock.module("../marketProvider.js", {
  namedExports: {
    ...realProvider,
    getMarketProvider: () => ({ ...realProvider.getMarketProvider(), getEconomicCalendar: async () => cal }),
  },
});

const { getEconomicCalendar } = await import("../tools.js");

test("unconnected calendar: not checked, events unknown — not none", async () => {
  cal = { connected: false, events: [], provider: "twelve_data" };
  const r = (await getEconomicCalendar()) as Record<string, unknown>;
  assert.equal(r.calendarChecked, false);
  assert.match(String(r.note), /unknown — not none/);
});

test("connected calendar with no events: checked and says so", async () => {
  cal = { connected: true, events: [], provider: "finnhub" };
  const r = (await getEconomicCalendar()) as Record<string, unknown>;
  assert.equal(r.calendarChecked, true);
  assert.match(String(r.note), /finnhub calendar was checked and lists no upcoming events/);
});

test("connected calendar with events: counts them", async () => {
  cal = { connected: true, events: [{ whenIso: "2026-10-28T12:30:00Z", region: "US", title: "CPI", importance: "high" }], provider: "finnhub" };
  const r = (await getEconomicCalendar()) as Record<string, unknown>;
  assert.equal(r.calendarChecked, true);
  assert.match(String(r.note), /1 event\(s\)/);
});
