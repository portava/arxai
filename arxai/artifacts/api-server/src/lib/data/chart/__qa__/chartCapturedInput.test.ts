import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecisionSnapshot, recordDecisionSnapshot, getLastSnapshot, getRecentSnapshots } from "../chartDecisionSnapshot.js";

import { noBrokerAlignment } from "../brokerPriceAlignment.js";
import type { ChartTruthSubMetric } from "../chartTruthScore.js";

type Input = Parameters<typeof buildDecisionSnapshot>[0];
function input(): Input {
  const metric = (key: string, weight: number, rawScore: number | null): ChartTruthSubMetric => ({
    key, label: key, weight, rawScore, weightedScore: rawScore === null ? null : rawScore * weight,
    evidenceStatus: rawScore === null ? "unavailable" : "measured", detail: rawScore === null ? "Not measured" : "Measured fixture observation",
  });
  const subMetrics = [metric("render_accuracy", .07, null), metric("ohlc_integrity", .20, 100),
    metric("source_authenticity", .15, null), metric("timeframe_accuracy", .13, 100),
    metric("symbol_mirror_accuracy", .12, null), metric("historical_live_merge", .10, null),
    metric("feed_freshness", .09, 0), metric("price_precision", .08, 100),
    metric("scale_quality", .04, null), metric("interaction_stability", .02, null)];
  return { symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M5", source: "chart_read",
    chartTruthScore: { score: 41, label: "Read-blocked", subMetrics, evidenceCoverage: .50,
      unmeasuredKeys: subMetrics.filter(m => m.evidenceStatus === "unavailable").map(m => m.key),
      primaryConcern: "Feed not current", note: "41 points; half of weighted checks measured." },
    chartReadScore: { score: 90, label: "Highly Readable", subMetrics: [{ key: "history_window", label: "History Window", rawScore: 90, detail: "Stored candle window" }],
      primaryConcern: null, note: "Readable structure does not certify data truth." },
    gateOutput: { chartTruthScore: 41, chartReadScore: 90, truthLabel: "Read-blocked", readLabel: "Highly Readable",
      confidentReadAllowed: false, scannerConfirmAllowed: false, selfTradeChartAllowed: false, candlestickModeAllowed: true,
      autonomousChartActionAllowed: false, tradeConfirmationAllowed: false, blockedReasons: ["Broker comparison unavailable"],
      primaryBlockReason: "Broker comparison unavailable", note: "Read withheld pending evidence." },
    brokerAlignment: noBrokerAlignment(1.1, "UNKNOWN"),
    verifiedCandleRef: { openTime: "2026-11-13T10:00:00Z", closeTime: "2026-11-13T10:05:00Z", close: 1.1, isComplete: true },
    plan: { side: "BUY", entry: 1.1, sl: 1.09, tp: 1.12 },
  };
}

test("captured read preserves unmeasured truth and advisory plan without granting execution authority", () => {
  const before = Date.now(), snapshot = buildDecisionSnapshot(input());
  assert.ok(Date.parse(snapshot.capturedAt) >= before && Date.parse(snapshot.capturedAt) <= Date.now());
  assert.equal(snapshot.chartTruthScore.score, 41); assert.equal(snapshot.gateOutput.confidentReadAllowed, false);
  assert.equal(snapshot.chartTruthScore.subMetrics[0]?.evidenceStatus, "unavailable");
  assert.deepEqual(snapshot.plan, input().plan); assert.equal(Object.hasOwn(snapshot, "executed"), false);
  assert.match(snapshot.replayNote, /only judge with data known at capturedAt/);
});
test("later producer mutations cannot rewrite an already captured decision", () => {
  const original = input(); const snapshot = buildDecisionSnapshot(original);
  original.chartTruthScore.score = 100;
  original.gateOutput.blockedReasons.length = 0;
  original.verifiedCandleRef!.close = 5;
  original.plan!.entry = 5;
  assert.equal(snapshot.chartTruthScore.score, 41);
  assert.deepEqual(snapshot.gateOutput.blockedReasons, ["Broker comparison unavailable"]);
  assert.equal(snapshot.verifiedCandleRef?.close, 1.1); assert.equal(snapshot.plan?.entry, 1.1);
});
test("saved snapshots are isolated from both the writer and returned-reader mutations", () => {
  const snapshot = buildDecisionSnapshot(input());
  recordDecisionSnapshot(91001, snapshot);
  snapshot.chartTruthScore.score = 100;
  const first = getLastSnapshot(91001, "EURUSD", "M5")!;
  assert.equal(first.chartTruthScore.score, 41);
  first.plan!.entry = 5;
  const page = getRecentSnapshots(91001); page[0]!.gateOutput.blockedReasons.length = 0;
  assert.equal(getLastSnapshot(91001, "EURUSD", "M5")?.plan?.entry, 1.1);
  assert.deepEqual(getLastSnapshot(91001, "EURUSD", "M5")?.gateOutput.blockedReasons, ["Broker comparison unavailable"]);
});
test("snapshot lookup cannot cross users, instruments or timeframes and keeps only its bounded recent window", () => {
  for (let i = 0; i < 24; i++) recordDecisionSnapshot(91002, { ...buildDecisionSnapshot(input()), id: `fixture-${i}` });
  assert.equal(getRecentSnapshots(91002).length, 20); assert.equal(getRecentSnapshots(91002)[0]?.id, "fixture-23");
  assert.equal(getRecentSnapshots(91002).at(-1)?.id, "fixture-4");
  assert.equal(getLastSnapshot(91003, "EURUSD", "M5"), null); assert.equal(getLastSnapshot(91002, "GBPUSD", "M5"), null);
  assert.equal(getLastSnapshot(91002, "EURUSD", "M1"), null); assert.equal(getLastSnapshot(91002, "eurusd", "m5")?.id, "fixture-23");
  assert.deepEqual(getRecentSnapshots(91002, { symbol: "GBPUSD" }), []);
});


test("capture cloning preserves optional undefined fields and null measurements", () => {
  const original = input();
  original.plan = undefined; original.verifiedCandleRef = null;
  original.brokerAlignment.quoteBinding = undefined;
  const snapshot = buildDecisionSnapshot(original);
  assert.equal(snapshot.plan, null); assert.equal(snapshot.verifiedCandleRef, null);
  assert.equal(Object.hasOwn(snapshot.brokerAlignment, "quoteBinding"), true);
  assert.equal(snapshot.brokerAlignment.quoteBinding, undefined);
  assert.equal(snapshot.chartTruthScore.subMetrics[0]?.rawScore, null);
});
