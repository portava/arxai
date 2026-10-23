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
