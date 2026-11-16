/** Offline same-process comparison of StudyCalculator.calculate against the commit
 * before the CCI/Bollinger deviation loops moved to a Float64Array price window.
 * Pure Node computation only; never a browser interaction or paint benchmark.
 * Run from api-server (its existing tsx loader):
 * node --import tsx ../trading-dashboard/src/lib/chart-engine/chartStudies.benchmark.ts [baselineCommit]
 * The baseline module is written to a fresh os.tmpdir() directory (never into the
 * shared checkout) and removed even when an assertion fails. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StudyCalculator, type ChartStudy, type StudyPoint } from "./chartStudies";
import type { ChartEngineCandle } from "./types";

const baselineCommit = process.argv[2] ?? "f2c14d6";
assert.match(baselineCommit, /^[a-f0-9]{7,40}$/);
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const gitSource = execFileSync("git", ["show", `${baselineCommit}:artifacts/trading-dashboard/src/lib/chart-engine/chartStudies.ts`], { cwd: root, encoding: "utf8" });
assert.ok(gitSource.includes("this.states[j]!.price - mean"), "Baseline already uses the typed window; do not benchmark current code as old");
// Its only relative import is the type-only "./types"; point it at this checkout's file by absolute path.
const typesPath = fileURLToPath(new URL("./types.ts", import.meta.url));
const baselineSource = gitSource.replace(/from "\.\/types"/g, `from ${JSON.stringify(typesPath)}`);
assert.ok(!/from "\.\.?\//.test(baselineSource), "Baseline still has a relative import");
const baselineDir = mkdtempSync(join(tmpdir(), "arx-studies-baseline-"));
const baselineFile = join(baselineDir, "chartStudies.baseline.ts");
try {
  writeFileSync(baselineFile, baselineSource, { flag: "wx" });
  const baseline = await import(pathToFileURL(baselineFile).href) as typeof import("./chartStudies");
  // Same 5,000-bar M15 shape as the chart-qa latency fixture; seeded walk (mulberry32).
  let seed = 20261028;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let close = 1.1;
  const bars: ChartEngineCandle[] = Array.from({ length: 5000 }, (_, i) => {
    const open = close;
    close = Math.max(0.2, open + (random() - 0.5) * 0.004);
    return { time: 1_700_000_000 + i * 900, open, close, high: Math.max(open, close) + random() * 0.002, low: Math.min(open, close) - random() * 0.002 };
  });
  // The two 1000-period studies preloaded by scripts/chart-qa/interaction-latency.js.
  const studies: Record<string, ChartStudy> = {
    bollinger_1000_close: { kind: "bollinger", period: 1000, multiplier: 2, color: "#a78bfa" },
    cci_1000_hlc3: { kind: "cci", period: 1000, source: "hlc3", color: "#38bdf8" },
  };
  const same = (a: StudyPoint[], b: StudyPoint[]) => a.length === b.length && a.every((point, i) =>
    Object.is(point.time, b[i]!.time) && point.values.length === b[i]!.values.length && point.values.every((value, k) => Object.is(value, b[i]!.values[k])));
  const operations: Record<string, () => unknown> = {};
  for (const [name, config] of Object.entries(studies)) {
    const before = new baseline.StudyCalculator(config), after = new StudyCalculator(config);
    // Correctness witness on the same inputs, separately from measurements.
    before.calculate(bars, 0, false); after.calculate(bars, 0, false);
    assert.ok(same(after.points, before.points), `${name} differs from baseline by Object.is`);
    // Renderer refresh path: calculate(candles, dirtyFrom, false) on a long-lived calculator.
    operations[`baseline_full_${name}`] = () => before.calculate(bars, 0, false);
    operations[`typed_full_${name}`] = () => after.calculate(bars, 0, false);
    // Live forming-bar tick: must stay O(p), not O(n).
    operations[`baseline_tick_${name}`] = () => before.calculate(bars, bars.length - 1, false);
    operations[`typed_tick_${name}`] = () => after.calculate(bars, bars.length - 1, false);
    operations[`verify_${name}`] = () => assert.ok(same(after.points, before.points));
  }
  const timed = Object.keys(operations).filter(name => !name.startsWith("verify_"));
  const samples: Record<string, number[]> = Object.fromEntries(timed.map(name => [name, []]));
  let witness = 0;
  for (let i = 0; i < 30; i++) for (const name of timed) { operations[name]!(); witness++; }
  // Interleave to reduce order bias. Each sample is one complete synchronous call.
  for (let i = 0; i < 300; i++) {
    const names = [...timed]; if (i % 2) names.reverse();
    for (const name of names) {
      const begin = performance.now(); const value = operations[name]!();
      samples[name]!.push(performance.now() - begin);
      if (value != null) witness++;
    }
  }
  for (const name of Object.keys(operations).filter(name => name.startsWith("verify_"))) operations[name]!();
  const q = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
  const metrics = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, {
    samples: values.length, medianMs: q(values, .5), p95Ms: q(values, .95), p99Ms: q(values, .99), maxMs: Math.max(...values),
  }]));
  const speedup = Object.fromEntries(Object.keys(studies).map(name => [name, {
    medianRatio: metrics[`baseline_full_${name}`]!.medianMs / metrics[`typed_full_${name}`]!.medianMs,
    p95Ratio: metrics[`baseline_full_${name}`]!.p95Ms / metrics[`typed_full_${name}`]!.p95Ms,
  }]));
  console.log(JSON.stringify({ baselineCommit, node: process.version,
    scope: "Pure synchronous StudyCalculator.calculate only, 5,000 bars, period 1000. No browser, layout, series write or paint.",
    comparison: "Same Node process, baseline chartStudies.ts extracted from Git; interleaved order after 30 warmups; outputs asserted identical by Object.is.",
    metrics, speedup, witness }, null, 2));
} finally { rmSync(baselineDir, { recursive: true, force: true }); }
