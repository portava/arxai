// THEME A1 — News risk must never be scored from fabricated calendar events.
//
// Before this fix, `scoreNewsRisk(symbol)` defaulted its `events` argument to
// `getMockEvents(2)` — a hardcoded FOMC/CPI/NFP schedule at invented times. Two
// live surfaces relied on that default:
//   - GET /news/risk        (routes/news.ts)
//   - the watchlist newsRisk badge (routes/watchlists.ts)
// Both therefore emitted real-looking "HIGH impact FOMC Rate Decision in 23m —
// trading blocked" verdicts on a machine with NO calendar provider configured.
//
// Contract asserted here:
//   1. `scoreNewsRisk` has NO events default — an omitted arg is a type error and
//      the mock generator is not reachable from the scorer at all.
//   2. With no provider configured, the resolver returns an honest UNAVAILABLE
//      read: calendarAvailable:false, blockTrading:false, minutesUntilEvent:null,
//      upcomingEvent:null — never a countdown, never a "blocked" verdict.
//   3. Both consuming surfaces route through the resolver (no bare-symbol calls).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { scoreNewsRisk } from "../calendar/newsRiskScorer.js";
import {
  resolveNewsRiskEvents,
  resolveNewsRiskForSymbol,
} from "../calendar/newsRiskResolver.js";
import { __resetEconomicCalendarStateForTests } from "../calendar/economicCalendarService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}

/** Run `fn` with NO economic-calendar provider selected or keyed. */
async function withNoProvider<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    provider: process.env["ECONOMIC_CALENDAR_PROVIDER"],
    te: process.env["TRADING_ECONOMICS_KEY"],
    fred: process.env["FRED_API_KEY"],
  };
  delete process.env["ECONOMIC_CALENDAR_PROVIDER"];
  delete process.env["TRADING_ECONOMICS_KEY"];
  delete process.env["FRED_API_KEY"];
  __resetEconomicCalendarStateForTests();
  try {
    return await fn();
  } finally {
    if (saved.provider === undefined) delete process.env["ECONOMIC_CALENDAR_PROVIDER"];
    else process.env["ECONOMIC_CALENDAR_PROVIDER"] = saved.provider;
    if (saved.te === undefined) delete process.env["TRADING_ECONOMICS_KEY"];
    else process.env["TRADING_ECONOMICS_KEY"] = saved.te;
    if (saved.fred === undefined) delete process.env["FRED_API_KEY"];
    else process.env["FRED_API_KEY"] = saved.fred;
    __resetEconomicCalendarStateForTests();
  }
}

describe("A1 — the scorer has no fabricated-event default", () => {
  it("does not import the mock generator at all", () => {
    const src = read("lib/news/calendar/newsRiskScorer.ts");
    assert.ok(
      !/getMockEvents/.test(src),
      "newsRiskScorer.ts must not reference getMockEvents — an omitted events arg " +
        "previously fabricated a full FOMC/CPI/NFP calendar",
    );
  });

  it("scores an empty event list as an honest 'none' with no countdown", () => {
    const r = scoreNewsRisk("EURUSD", []);
    assert.equal(r.riskLevel, "none");
    assert.equal(r.blockTrading, false);
    assert.equal(r.minutesUntilEvent, null);
    assert.equal(r.upcomingEvent, null);
    // An empty list from a CONNECTED calendar is a real "no events" read.
    assert.equal(r.calendarAvailable, true);
  });

  it("still scores real events when they are supplied", () => {
    const inTwentyMin = new Date(Date.now() + 20 * 60_000).toISOString();
    const r = scoreNewsRisk("EURUSD", [
      {
        id: "e1",
        title: "US CPI YoY",
        country: "US",
        currency: "USD",
        impact: "high",
        actual: null,
        forecast: "3.2%",
        previous: "3.4%",
        eventTime: inTwentyMin,
        affectedMarkets: ["EURUSD"],
        source: "trading_economics",
      },
    ]);
    assert.equal(r.riskLevel, "high");
    assert.equal(r.blockTrading, true);
    assert.equal(r.calendarAvailable, true);
  });
});

describe("A1 — no provider configured yields an honest unavailable read", () => {
  it("resolveNewsRiskEvents reports unavailable with zero events", async () => {
    const out = await withNoProvider(() => resolveNewsRiskEvents());
    assert.equal(out.available, false);
    assert.deepEqual(out.events, []);
    assert.ok(out.reason.length > 0, "an operator-readable reason is required");
  });

  it("resolveNewsRiskForSymbol emits no countdown and never blocks", async () => {
    const r = await withNoProvider(() => resolveNewsRiskForSymbol("EURUSD"));
    assert.equal(r.calendarAvailable, false);
    assert.equal(r.blockTrading, false, "an unconfigured calendar must never block trading");
    assert.equal(r.minutesUntilEvent, null, "no countdown may be invented");
    assert.equal(r.upcomingEvent, null, "no event may be invented");
    assert.equal(r.riskLevel, "none");
    assert.ok(
      !/\bin \d+m\b/.test(r.reason) && !/blocked/i.test(r.reason),
      `unconfigured reason must not read as a verdict, got: ${r.reason}`,
    );
  });

  it("synthetic indices stay honestly unaffected and available", async () => {
    const r = await withNoProvider(() => resolveNewsRiskForSymbol("Volatility 75 Index"));
    assert.equal(r.blockTrading, false);
    assert.equal(r.calendarAvailable, true);
    assert.equal(r.minutesUntilEvent, null);
  });
});

describe("A1 — consuming surfaces route through the resolver", () => {
  it("GET /news/risk does not call scoreNewsRisk with a bare symbol", () => {
    const src = read("routes/news.ts");
    assert.ok(
      !/scoreNewsRisk\(\s*q\.symbol\s*\)/.test(src),
      "routes/news.ts must resolve real events, not rely on a fabricated default",
    );
    assert.ok(/resolveNewsRiskForSymbol/.test(src), "routes/news.ts must use the resolver");
  });

  it("the watchlist badge does not call scoreNewsRisk with a bare symbol", () => {
    const src = read("routes/watchlists.ts");
    assert.ok(
      !/scoreNewsRisk\(\s*it\.symbol\s*\)/.test(src),
      "routes/watchlists.ts must resolve real events for the newsRisk badge",
    );
    assert.ok(
      /resolveNewsRisk(Events|ForSymbol)/.test(src),
      "routes/watchlists.ts must use the resolver",
    );
  });

  it("GET /news/calendar has no mock fallback", () => {
    const src = read("routes/news.ts");
    assert.ok(
      !/getMockEvents/.test(src),
      "routes/news.ts must not fall back to fabricated calendar events",
    );
  });
});
