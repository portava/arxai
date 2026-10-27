import { performance } from "node:perf_hooks";
import { cpus, totalmem, platform, release } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { simulateBacktest, type BacktestCandle, type SignalFn } from "@workspace/domain/backtest";
import { runCausalResearch } from "@workspace/domain/backtest/research";
import { workload, workloadConfig } from "./causalResearch.fixture.js";

const output = process.argv[2];
if (!output) throw new Error("Pass an output JSON path; all samples are retained.");
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
  return { count: samples.length, medianMs: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.at(-1)! };
};
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const startedAt = new Date().toISOString(), results = [];
for (const count of [5000, 50000]) {
  const source = workload(count), cfg = workloadConfig(count);
  const legacyBars: BacktestCandle[] = source.bars.map(b => ({ time: new Date(b.openTimeMs).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close }));
  const signal: SignalFn = window => {
    const bar = window.at(-1)!, earlier = window[window.length - 1 - cfg.strategy.lookbackBars];
    const change = earlier ? bar.close - earlier.close : 0;
    const side = Math.abs(change) > cfg.strategy.thresholdPriceUnits ? change > 0 ? "BUY" : "SELL" : "WAIT";
    const sign = side === "BUY" ? 1 : -1;
    return { direction: side, entryPrice: bar.close, stopLoss: bar.close - sign * cfg.strategy.stopDistancePriceUnits,
      takeProfit: bar.close + sign * cfg.strategy.targetDistancePriceUnits, confidence: 1, strategy: cfg.strategy.version };
  };
  // Both are the actual old/current engines. Same raw prices and momentum
  // formula, DIFFERENT fill/cost/partition semantics. Processing reference only.
  const oldRun = () => simulateBacktest(source.symbol, legacyBars, signal, 0);
  const currentRun = () => runCausalResearch(source, cfg);
  const expected = currentRun();
  const warmups = 10, trials = count === 5000 ? 100 : 40;
  for (let i = 0; i < warmups; i++) { oldRun(); currentRun(); }
  const oldMs: number[] = [], currentMs: number[] = [], pairs = [];
  for (let i = 0; i < trials; i++) {
    let oldElapsed = 0, currentElapsed = 0;
    const old = () => { const t = performance.now(); oldRun(); oldElapsed = performance.now() - t; };
    const current = () => { const t = performance.now(); const result = currentRun(); currentElapsed = performance.now() - t;
      assert.equal(result.fingerprints.result, expected.fingerprints.result); };
    if (i % 2) { current(); old(); } else { old(); current(); }
    oldMs.push(oldElapsed); currentMs.push(currentElapsed);
    pairs.push({ index: i, order: i % 2 ? "current_then_legacy" : "legacy_then_current", legacyMs: oldElapsed, currentMs: currentElapsed });
  }
  results.push({ bars: count, warmups, trials, completionDefinition: "Synchronous function returned after validation/copies, simulation, all fingerprints and recursive freeze; no separate acknowledgement",
    legacy: stats(oldMs), current: stats(currentMs), target: count === 5000 ? { p95Ms: 100, passed: stats(currentMs).p95Ms <= 100 } : { p95Ms: null, passed: null, note: "Heavy-load observation, no fabricated predeclared target" },
    resultFingerprint: expected.fingerprints.result, currentCompletedTrades: expected.partitions.map(p => p.metrics.completedTrades),
    legacyCompletedTrades: oldRun().trades.length, samples: pairs });
}
const receipt = { startedAt, finishedAt: new Date().toISOString(), node: process.version,
  machine: { cpu: cpus()[0]?.model, cores: cpus().length, ramBytes: totalmem(), platform: platform(), release: release() },
  gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sources: { legacy: hash("../../lib/domain/src/backtest/index.ts"), current: hash("../../lib/domain/src/backtest/research.ts"), fixture: hash("src/lib/backtest/__qa__/causalResearch.fixture.ts") },
  comparison: "Legacy/current actual function processing reference on equivalent price arrays and close-momentum formula. Fills, cooldown, holding exits, costs, partitions, validation, fingerprints and freeze differ; not a speedup or return-parity claim. Fixtures are generated, not market performance evidence.",
  excludes: ["provider/network latency", "database/persisted experiment", "HTTP acknowledgement", "browser feedback", "real broker execution", "competitor timing"], results };
writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify(results.map(({ bars, legacy, current, target }) => ({ bars, legacy, current, target })), null, 2) + "\n");
if (results.some(r => r.target.passed === false)) process.exitCode = 1;
