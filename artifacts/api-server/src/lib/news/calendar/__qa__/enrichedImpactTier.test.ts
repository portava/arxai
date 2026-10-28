// The live Economic Calendar endpoint (/economic-calendar/events) is built from
// getEnrichedCalendarEvents. Its three-level `impact` folds "critical" into
// "high" for back-compat, so the page could never show a CRITICAL event on the
// live path while the DB path showed the same FOMC decision as Critical.
// The enriched event must also carry the provider's own tier, unfolded.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  __setEconomicCalendarFetcherForTests,
  __resetEconomicCalendarStateForTests,
} from "../economicCalendarService.js";
import type { RawTradingEconomicsEvent } from "../tradingEconomicsProvider.js";
import { getEnrichedCalendarEvents } from "../../economicCalendarProvider.js";

const ENV_KEYS = ["ECONOMIC_CALENDAR_PROVIDER", "TRADING_ECONOMICS_KEY", "TRADING_ECONOMICS_SECRET"] as const;
let envSnapshot: Record<string, string | undefined> = {};

// TE date shape (UTC, no zone), two hours from now so it sits inside any window.
const SOON = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 19);

function rawEvent(over: Partial<RawTradingEconomicsEvent>): RawTradingEconomicsEvent {
  return {
    CalendarId: "1", Date: SOON, Country: "United States", Currency: "USD",
    Category: "Labour", Event: "Non Farm Payrolls", Importance: 3,
    Forecast: "180K", Previous: "175K", Actual: null,
    ...over,
  };
}

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  process.env["ECONOMIC_CALENDAR_PROVIDER"] = "trading_economics";
  process.env["TRADING_ECONOMICS_KEY"] = "te-key-abc";
  delete process.env["TRADING_ECONOMICS_SECRET"];
  __resetEconomicCalendarStateForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  __resetEconomicCalendarStateForTests();
  __setEconomicCalendarFetcherForTests(null);
});

test("enriched live events keep the provider's critical tier (FOMC is not folded to high)", async () => {
  const rows = [
    rawEvent({ CalendarId: "fomc", Event: "Fed Interest Rate Decision", Category: "Interest Rate" }),
    rawEvent({ CalendarId: "nfp" }),
  ];
  __setEconomicCalendarFetcherForTests(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(rows) }));
  const r = await getEnrichedCalendarEvents("", Date.now(), 7 * 86_400_000, {});
  assert.equal(r.connected, true);
  const fomc = r.events.find((e) => e.id.includes("fomc"));
  const nfp = r.events.find((e) => e.id.includes("nfp"));
  assert.ok(fomc && nfp, "both events returned");
  // Back-compat three-level field is unchanged …
  assert.equal(fomc.impact, "high");
  // … and the unfolded tier is carried alongside it.
  assert.equal(fomc.impactTier, "critical");
  assert.equal(nfp.impactTier, "high");
});
