// Truth regression: the chart feed status calls a session market closed only
// when no tick for the series' source has moved in the last two minutes, but
// the candle truth engine ran before that tick evidence was read and decided
// "closed" from the static weekend schedule alone. The static windows run past
// the real reopen (forex reopens Sunday ~21:00-22:00 UTC; FOREX_SESSION ends
// Monday 00:00), so on Sunday night with ticks moving and the bar push broken
// the same response said "No new EURUSD bar … The market may be closed or the
// feed delayed" (feed status) AND "Assessment STALE — Market in its scheduled
// weekend close … no new bars are expected until it reopens" (Chart Truth
// Score detail). buildChartFeed now reads the tick evidence once and hands it
// to the truth engine, so both say the same thing.
//
// Drives the real buildChartFeed (via getChartCandles) with only the router and
// the session-profile DB read mocked; ticks go through the real forming-bar
// store. No database, broker or network calls.
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/data/chart/__qa__/chartFeedClosureEvidence.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const M5 = 300_000;
const FRI_2155 = Date.UTC(2026, 9, 30, 21, 55);
const SUN_2230 = Date.UTC(2026, 10, 1, 22, 30);

function candles(): { time: string; open: number; high: number; low: number; close: number; volume: number }[] {
  return Array.from({ length: 200 }, (_, i) => ({
    time: new Date(FRI_2155 - (199 - i) * M5).toISOString(), open: 1.1, high: 1.101, low: 1.099, close: 1.1, volume: 10,
  }));
}

const realRouter = await import("../../marketDataRouter.js");
mock.module("../../marketDataRouter.js", {
  namedExports: {
    ...realRouter,
    classifySymbol: () => "forex",
    routeCandles: async () => ({
      ok: true,
      candles: candles(),
      primaryProvider: "mt5_broker",
      provenance: { providerId: "mt5_broker" },
      provenanceNotes: [],
      attempts: [{ provider: "mt5_broker", ok: true, ms: 5 }],
      userMessage: null,
    }),
  },
});
const realSession = await import("../sessionProfile.js");
mock.module("../sessionProfile.js", {
  namedExports: { ...realSession, getSessionProfile: async () => null },
});

mock.timers.enable({ apis: ["Date"], now: SUN_2230 });
const { getChartCandles } = await import("../chartDataService.js");
const { foldFormingTick, __resetFormingBarStore } = await import("../formingBarComposer.js");

function truthDetails(r: Awaited<ReturnType<typeof getChartCandles>>): string {
  return [
    ...(r.truthResult?.assessmentReasons ?? []),
    ...(r.chartTruthScore?.subMetrics ?? []).map((m) => m.detail ?? ""),
  ].join(" | ");
}

test("ticks moving on Sunday night: the truth engine does not call the missing bars a weekend close", async () => {
  __resetFormingBarStore();
  foldFormingTick("EURUSD", 1.1, SUN_2230 - 30_000, SUN_2230 - 30_000, "mt5_broker");
  foldFormingTick("EURUSD", 1.1002, SUN_2230 - 10_000, SUN_2230 - 10_000, "mt5_broker");
  const r = await getChartCandles("EURUSD", "M5", 200);
  assert.equal(r.truthResult?.assessment, "STALE", "the assessment is unchanged");
  const details = truthDetails(r);
  assert.doesNotMatch(details, /scheduled weekend close|no new bars are expected/, details);
  assert.match(r.truthResult?.assessmentReasons[0] ?? "", /may be closed or the feed delayed/);
  assert.doesNotMatch(r.feedStatus.warning ?? "", /Market closed/, "the feed status agrees: not closed");
});

test("control: no tick has moved, so both the feed status and the truth engine say the market is closed", async () => {
  __resetFormingBarStore();
  const r = await getChartCandles("EURUSD", "M5", 200);
  assert.match(r.feedStatus.warning ?? "", /Market closed for .* scheduled weekend close/);
  assert.match(r.truthResult?.assessmentReasons[0] ?? "", /scheduled weekend close/);
});
