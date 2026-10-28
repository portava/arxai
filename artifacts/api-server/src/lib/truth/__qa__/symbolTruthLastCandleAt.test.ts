// Symbol Truth snapshot: lastCandleAt is an observation time, never a
// scheduled future close.
//
// data.lastCandleAt was feedStatus.lastCandleTime — the newest PROVIDER bar's
// closeTime. When the provider serves a forming bar, that is the bar's
// scheduled close, minutes (or hours) in the future, and the snapshot's
// evidence then labelled the price and last candle "verified live-feed
// observation" as of a time that has not happened yet. It is now the newest
// CLOSED bar's close time (never later than now), the same rule the
// selected-market dataAsOf uses.
//
// Run: node --import tsx --test --test-force-exit src/lib/truth/__qa__/symbolTruthLastCandleAt.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSymbolTruthSnapshot } from "../symbolTruthSnapshot.js";
import { NOW, marketFixture } from "./marketEvidenceFixtures.js";

const absent = async (): Promise<never> => { throw new Error("offline unavailable"); };

test("a provider forming bar's scheduled close is not the snapshot's last-candle time", async () => {
  const f = marketFixture({ forming: true });
  const forming = f.chart.candles.at(-1)!;
  assert.equal(forming.isComplete, false, "precondition: the newest provider bar is still forming");
  assert.ok(Date.parse(f.chart.feedStatus.lastCandleTime!) > Date.now(), "precondition: the feed's newest close is in the future");
  const s = await buildSymbolTruthSnapshot("EURUSD", "M15", 1, {
    getChartCandlesFn: async () => f.chart as never, buildNewsFn: absent, evaluateScalpFn: absent,
    computeTimingFn: absent, buildScannerFn: absent,
  });
  assert.ok(s.data.lastCandleAt, "a closed bar exists, so the time is known");
  assert.ok(Date.parse(s.data.lastCandleAt!) <= Date.now(), "never a future instant");
  assert.equal(s.data.lastCandleAt, f.evidence.lastClosedCandleAt, "the newest closed bar's close");
  assert.ok(Date.parse(s.evidence.lastCandle.observedAt ?? "0") <= Date.now());
  assert.ok(Date.parse(s.evidence.price.observedAt ?? "0") <= Date.now());
});

test("with no closed bar the last-candle time is unknown, not a future close", async () => {
  const f = marketFixture({ forming: true, count: 0 });
  const s = await buildSymbolTruthSnapshot("EURUSD", "M15", 1, {
    getChartCandlesFn: async () => f.chart as never, buildNewsFn: absent, evaluateScalpFn: absent,
    computeTimingFn: absent, buildScannerFn: absent,
  });
  assert.equal(s.data.lastCandleAt, null);
});

test("a fully closed series keeps its newest close time", async () => {
  const f = marketFixture();
  const s = await buildSymbolTruthSnapshot("EURUSD", "M15", 1, {
    getChartCandlesFn: async () => f.chart as never, buildNewsFn: absent, evaluateScalpFn: absent,
    computeTimingFn: absent, buildScannerFn: absent,
  });
  assert.equal(s.data.lastCandleAt, f.chart.feedStatus.lastCandleTime);
  assert.ok(Date.parse(s.data.lastCandleAt!) <= NOW);
});
