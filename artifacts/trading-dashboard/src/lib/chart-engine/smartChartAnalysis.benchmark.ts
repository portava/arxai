/** Offline processing-cost benchmark; never a browser interaction or trading benchmark.
 * Run from API package (its existing tsx loader):
 * node --import tsx ../trading-dashboard/src/lib/chart-engine/smartChartAnalysis.benchmark.ts */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { detectChartPatterns } from "@workspace/domain/chart-patterns";
import { analyzeSmartChart, bindSmartChartBars, type SmartChartAnalysisBar } from "./smartChartAnalysis";

const context = { symbol: "EURUSD", timeframe: "M5", source: "mt5_broker", sourceIdentity: "a".repeat(64) };
const start = 1_700_000_000;
const candles: SmartChartAnalysisBar[] = Array.from({ length: 5000 }, (_, i) => {
  const close = 1.1 + 0.004 * Math.sin(i / 8) + 0.001 * Math.sin(i / 3) + i * 0.000001;
  const open = close + (i % 2 === 0 ? -1 : 1) * 0.0003;
  return { time: start + i * 300, closeTime: start + (i + 1) * 300,
    open, close, high: Math.max(open, close) + 0.0006, low: Math.min(open, close) - 0.0006,
    isComplete: true, isFinal: true, isForming: false };
});
const args = { ...context, bars: candles, asOfMs: candles.at(-1)!.closeTime * 1000, dataState: "current" as const };
const recent = candles.slice(-600);
const batches = [{ evidence: context, bars: candles.slice(0, 4550) }, { evidence: context, bars: candles.slice(4500) }];
const result = analyzeSmartChart(args);
assert.equal(result.coverage.analyzed, 600);
assert.equal(result.coverage.available, 5000);
assert.deepEqual(analyzeSmartChart(args), result);
assert.equal(bindSmartChartBars(context, batches).bars.length, 5000);
const samples: Record<string, number[]> = { unchanged_raw_catalog_600: [], complete_analysis_5000: [], binding_and_analysis_5000: [] };
const operations: Record<string, () => unknown> = {
  unchanged_raw_catalog_600: () => detectChartPatterns(recent),
  complete_analysis_5000: () => analyzeSmartChart(args),
  binding_and_analysis_5000: () => analyzeSmartChart({ ...args, bars: bindSmartChartBars(context, batches).bars }),
};
let witness = 0;
for (let i = 0; i < 80; i++) for (const fn of Object.values(operations)) { fn(); witness++; }
// Interleave to reduce order bias. Each sample is one complete synchronous call.
for (let i = 0; i < 500; i++) {
  const names = Object.keys(operations);
  if (i % 2) names.reverse();
  for (const name of names) {
    const begin = performance.now(); const value = operations[name]!();
    samples[name]!.push(performance.now() - begin);
    if (value != null) witness++;
  }
}
const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]!;
const metrics = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, {
  count: values.length, medianMs: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99), maxMs: Math.max(...values),
}]));
const acceptance = Object.fromEntries(["complete_analysis_5000", "binding_and_analysis_5000"].map(name => [name, {
  p95Under10ms: metrics[name]!.p95Ms <= 10, p99Under20ms: metrics[name]!.p99Ms <= 20,
}]));
console.log(JSON.stringify({ scenario: "5,000 observed M5 candles; latest 600 analyzed; 50 exact overlapping history rows",
  baselineLimitation: "Raw catalogue is unchanged extraction with fewer responsibilities; processing cost reference, not equivalent feature speed comparison.",
  timingScope: "Synchronous pure computation only; no browser, network, render acknowledgement, paint or order latency.",
  node: process.version, samples: metrics, acceptance, witness }, null, 2));
for (const result of Object.values(acceptance)) assert.ok(result.p95Under10ms && result.p99Under20ms, "Local pure processing budget missed");
