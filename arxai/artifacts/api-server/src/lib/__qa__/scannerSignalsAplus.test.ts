// Scanner + strategy-signal A+ hold-backs, proven:
//
//   1. Every chart timeframe M1..D1 is scanned (marketScanner, assistant live
//      scanner, Eleanor's scanner tool, radar, market overview), work per
//      cycle is bounded, and a timeframe with no reading shows the nearest
//      HIGHER timeframe's reading labelled as a fallback — never silently,
//      never a lower timeframe. An M5 draw-setup gets a scanner reading.
//   2. Ranking is three-tier: calibrated probability (with N) > measured base
//      rate > raw score labelled "unmeasured, ranked by raw score".
//   3. Strategy payloads carry `score` (not `confidence`), and
//   4. every score is recomputable from its `scoreBasis`.
//
// Run: pnpm --filter @workspace/api-server run test:scanner-signals-aplus

import "../calibration/__qa__/_offlineEnv.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fitCalibration, fitKey, seededRandom, type CalibrationFit } from "@workspace/domain/calibration";
import { clearCalibrationCache, replaceCalibrationCache, strategyCalibrationKey } from "../calibration/cache.js";
import {
  rankByMeasuredTier,
  classifyMeasuredRank,
  UNMEASURED_RANK_LABEL,
} from "../ranking/measuredRank.js";
import {
  SCANNER_TIMEFRAMES,
  SCANNER_MAX_PAIRS_PER_CYCLE,
  buildTimeframeCoverage,
  higherTimeframes,
  planScanPairs,
  resolveTimeframeReading,
} from "../scannerCoverage/timeframeCoverage.js";
import {
  breakOfStructureStrategy,
  liquiditySweepStrategy,
  meanReversionStrategy,
  pullbackContinuationStrategy,
  runStrategyScan,
  trendContinuationStrategy,
  volatilityExpansionStrategy,
  type Candle,
  type SignalOutput,
} from "../strategyEngine.js";
import { DEFAULT_TIMEFRAMES, rankScannerOpportunities, type ScannerOpportunity } from "../marketScanner.js";
import { RADAR_TIMEFRAMES } from "../opportunityRadar/radar.js";
import { LIVE_TIMEFRAMES, LIVE_SCANNER_MAX_PAIRS } from "../assistant/liveScanner.js";
import { assembleSetupSignals, resolveScannerReading } from "../assistant/setupSignals.js";
import type { LiveCandidate, LiveScannerResult } from "../assistant/liveScanner.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", p), "utf8");
const ALL = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

afterEach(() => clearCalibrationCache());

// ── 1. Timeframes ──────────────────────────────────────────────────────────

describe("every chart timeframe is scanned", () => {
  it("scanner, live scanner, radar share M1..D1", () => {
    assert.deepEqual([...SCANNER_TIMEFRAMES], ALL);
    assert.deepEqual([...DEFAULT_TIMEFRAMES], ALL);
    assert.deepEqual([...LIVE_TIMEFRAMES], ALL);
    assert.deepEqual([...RADAR_TIMEFRAMES], ALL);
  });

  it("no scanner surface is left on a hard-coded M15/H1 list", () => {
    for (const f of ["assistant/liveScanner.ts", "assistant/tools.ts", "data/marketOverview.ts"]) {
      assert.doesNotMatch(src(f), /=\s*\["M15",\s*"H1"\]/, `${f} still scans only M15/H1`);
    }
    assert.match(src("assistant/tools.ts"), /SCANNER_TOOL_TIMEFRAMES = SCANNER_TIMEFRAMES/);
    assert.match(src("data/marketOverview.ts"), /SETUP_TIMEFRAMES = SCANNER_TIMEFRAMES/);
  });

  it("work per cycle is bounded; over budget the slowest timeframes go first and are reported", () => {
    const syms = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(2, "0")}`);
    const { pairs, skipped } = planScanPairs(syms, ALL);
    assert.equal(pairs.length, SCANNER_MAX_PAIRS_PER_CYCLE);
    assert.equal(pairs.length + skipped.length, 30 * 7);
    // M5/M15/H1 for every symbol are always kept; skipped ones are slow tfs.
    for (const tf of ["M5", "M15", "H1"]) assert.equal(pairs.filter((p) => p.tf === tf).length, 30);
    assert.ok(skipped.every((p) => p.tf === "H4" || p.tf === "D1"), JSON.stringify([...new Set(skipped.map((p) => p.tf))]));
    const small = planScanPairs(["EURUSD", "XAUUSD"], ALL);
    assert.equal(small.pairs.length, 14);
    assert.equal(small.skipped.length, 0);
    // The live scanner's own per-call cap covers one draw-setup symbol on every tf.
    assert.ok(LIVE_SCANNER_MAX_PAIRS >= ALL.length);
  });

  it("marketScanner scans through planScanPairs and publishes coverage", () => {
    const s = src("marketScanner.ts");
    assert.match(s, /const \{ pairs, skipped \} = planScanPairs\(syms, tfs\);/);
    assert.match(s, /timeframeCoverage: buildTimeframeCoverage\(syms, tfs, out, skipped\)/);
    const routes = readFileSync(resolve(here, "../../routes/scanner.ts"), "utf8");
    assert.equal((routes.match(/timeframeCoverage:/g) ?? []).length, 2, "both scanner reads return coverage");
  });
});

describe("cross-timeframe fallback is explicit", () => {
  const row = (tf: string, action: string, dataStatus = "live") => ({ symbol: "EURUSD", timeframe: tf, recommendedAction: action, dataStatus });

  it("only higher timeframes, nearest first", () => {
    assert.deepEqual(higherTimeframes("M5"), ["M15", "M30", "H1", "H4", "D1"]);
    assert.deepEqual(higherTimeframes("D1"), []);
    assert.deepEqual(higherTimeframes("W1"), []);
  });

  it("own signal → own reading, no fallback", () => {
    const r = resolveTimeframeReading("EURUSD", "M5", [row("M5", "BUY"), row("H1", "SELL")]);
    assert.equal(r.status, "signal");
    assert.equal(r.readingTimeframe, "M5");
    assert.equal(r.fallback, false);
  });

  it("no signal → nearest higher with a signal, labelled", () => {
    const r = resolveTimeframeReading("EURUSD", "M5", [row("M1", "BUY"), row("M5", "WAIT"), row("M15", "WAIT"), row("H1", "SELL"), row("D1", "BUY")]);
    assert.equal(r.status, "no_signal");
    assert.equal(r.readingTimeframe, "H1");
    assert.equal(r.fallback, true);
    assert.match(r.label, /^M5: no signal — showing the H1 reading \(higher-timeframe fallback\)$/);
  });

  it("insufficient data (no row, or a non-live row) → fallback, never a lower timeframe", () => {
    const missing = resolveTimeframeReading("EURUSD", "M15", [row("M1", "BUY"), row("H4", "SELL")]);
    assert.equal(missing.status, "insufficient_data");
    assert.equal(missing.readingTimeframe, "H4");
    assert.match(missing.label, /insufficient data/);
    const stale = resolveTimeframeReading("EURUSD", "M15", [row("M15", "BUY", "stale"), row("H1", "BUY", "simulator_only")]);
    assert.equal(stale.status, "insufficient_data");
    assert.equal(stale.fallback, false, "a non-live higher row is not a reading either");
    assert.equal(stale.readingTimeframe, null);
    assert.match(stale.label, /no higher timeframe has a signal either/);
  });

  it("coverage lists every requested slot, sorted by timeframe, with budget skips said plainly", () => {
    const cov = buildTimeframeCoverage(["EURUSD"], ["H1", "M5", "D1"], [row("H1", "BUY")], [{ sym: "EURUSD", tf: "D1" }]);
    assert.deepEqual(cov.map((c) => c.timeframe), ["M5", "H1", "D1"]);
    assert.deepEqual(cov.map((c) => [c.status, c.readingTimeframe, c.fallback]), [
      ["insufficient_data", "H1", true],
      ["signal", "H1", false],
      ["skipped_budget", null, false],
    ]);
    assert.match(cov[2]!.label, /not scanned this cycle \(scan budget\)/);
  });
});

describe("an M5 draw-setup gets a scanner reading", () => {
  const cand = (tf: string, action: LiveCandidate["recommendedAction"], score: number): LiveCandidate =>
    ({ symbol: "EURUSD", timeframe: tf, recommendedAction: action, score, riskScore: 30 } as unknown as LiveCandidate);
  const res = (cands: LiveCandidate[]): LiveScannerResult =>
    ({ connected: true, source: "mt5_broker", candidates: cands, symbolsAttempted: 7, symbolsWithData: cands.length, warnings: [], reason: "SCANNER_OK", reasonDetail: "" });

  it("M5 scored on M5 when the live scanner has an M5 candidate", () => {
    const r = resolveScannerReading(res([cand("M5", "BUY", 66), cand("H1", "SELL", 80)]), "EURUSD", "M5");
    assert.deepEqual(r, { scannerScore: 66, riskScore: 30, scannerTimeframe: "M5", scannerTimeframeBasis: "exact", scannerFallbackLabel: null });
  });

  it("M5 with too few candles shows the nearest higher timeframe, labelled", () => {
    const r = resolveScannerReading(res([cand("M15", "WAIT", 50), cand("H1", "SELL", 80), cand("D1", "BUY", 90)]), "EURUSD", "M5");
    assert.equal(r.scannerScore, 80);
    assert.equal(r.scannerTimeframe, "H1");
    assert.equal(r.scannerTimeframeBasis, "higher_timeframe_fallback");
    assert.match(String(r.scannerFallbackLabel), /M5: no signal \(insufficient data\) — showing the H1 reading/);
  });

  it("a fallback score is shown but never fed to governance as the chart's own", async () => {
    let seen: number | null = null;
    const out = await assembleSetupSignals(
      { symbol: "EURUSD", timeframe: "M5", requestedSide: "BUY", bias: "Bullish", confidence: "Low" },
      {
        scoreLiveCandidates: async () => res([cand("H1", "SELL", 80)]),
        evaluateScalpForSymbol: async () => null as never,
        runGovernance: async ({ confNum }) => { seen = confNum; return null; },
      },
    );
    assert.equal(out.scannerScore, 80);
    assert.equal(out.scannerTimeframeBasis, "higher_timeframe_fallback");
    assert.equal(seen, 40, "governance got the structure estimate, not the H1 score");
  });

  it("the live scanner scans every timeframe and reads one quote per symbol", () => {
    const s = src("assistant/liveScanner.ts");
    assert.match(s, /export const LIVE_TIMEFRAMES = SCANNER_TIMEFRAMES;/);
    assert.match(s, /quoteRead \?\?= routeQuote\(sym\)/);
  });
});

// ── 2. Three-tier ranking ──────────────────────────────────────────────────

describe("three-tier measured ranking", () => {
  const stamp = (model: "isotonic" | "base_rate", p: number, n: number) =>
    ({ status: "measured" as const, model, probability: p, baseRate: model === "base_rate" ? p : 0.4, n });
  const unmeasured = (n = 0) => ({ status: "unmeasured" as const, model: "none" as const, probability: null, baseRate: null, n });

  it("tier 1: calibrated probability orders by probability, then N, carrying N in the label", () => {
    const k = classifyMeasuredRank({ rawScore: 10, calibration: stamp("isotonic", 0.62, 143) });
    assert.equal(k.rankBasis, "calibrated_probability");
    assert.equal(k.rankLabel, "ranked by calibrated probability 62% (N=143)");
    const r = rankByMeasuredTier([
      { id: "a", rawScore: 99, calibration: stamp("isotonic", 0.55, 500) },
      { id: "b", rawScore: 10, calibration: stamp("isotonic", 0.6, 40) },
      { id: "c", rawScore: 50, calibration: stamp("isotonic", 0.6, 90) },
    ]);
    assert.deepEqual(r.map((x) => x.id), ["c", "b", "a"]);
  });

  it("tier 2: a measured base rate ranks below any calibrated probability, above anything unmeasured", () => {
    const r = rankByMeasuredTier([
      { id: "raw", rawScore: 100, calibration: unmeasured(12) },
      { id: "br-hi", rawScore: 5, calibration: stamp("base_rate", 0.9, 300) },
      { id: "cal-lo", rawScore: 5, calibration: stamp("isotonic", 0.3, 60) },
      { id: "br-lo", rawScore: 90, calibration: stamp("base_rate", 0.45, 300) },
    ]);
    assert.deepEqual(r.map((x) => x.id), ["cal-lo", "br-hi", "br-lo", "raw"]);
    assert.deepEqual(r.map((x) => x.rankBasis), ["calibrated_probability", "measured_base_rate", "measured_base_rate", "unmeasured_raw_order"]);
    assert.match(r[1]!.rankLabel, /^ranked by measured base rate 90% \(N=300\); the score did not beat the base rate$/);
  });

  it("tier 3: unmeasured rows are ordered by raw score and labelled so", () => {
    const r = rankByMeasuredTier([
      { id: "x", rawScore: 40, calibration: unmeasured(3) },
      { id: "y", rawScore: 70, calibration: null },
      { id: "z", rawScore: Number.NaN, calibration: unmeasured() },
    ]);
    assert.deepEqual(r.map((x) => x.id), ["y", "x", "z"]);
    assert.ok(r.every((x) => x.rankBasis === "unmeasured_raw_order" && x.rankLabel === UNMEASURED_RANK_LABEL));
    assert.equal(UNMEASURED_RANK_LABEL, "unmeasured, ranked by raw score");
  });

  it("scanner rows rank by tier, not by the raw (effective) score", () => {
    const o = (tf: string, score: number, calibration: unknown) =>
      ({ symbol: "EURUSD", timeframe: tf, opportunity: { score }, calibration, calibratedProbability: (calibration as { probability?: number } | null)?.probability ?? null } as unknown as ScannerOpportunity);
    const r = rankScannerOpportunities([o("M1", 99, unmeasured()), o("H4", 20, stamp("base_rate", 0.5, 200)), o("D1", 30, stamp("isotonic", 0.41, 80))]);
    assert.deepEqual(r.map((x) => x.timeframe), ["D1", "H4", "M1"]);
    assert.deepEqual(r.map((x) => x.rankLabel), [
      "ranked by calibrated probability 41% (N=80)",
      "ranked by measured base rate 50% (N=200); the score did not beat the base rate",
      "unmeasured, ranked by raw score",
    ]);
  });

  it("no scanner read re-sorts by the raw score after decoration", () => {
    const routes = readFileSync(resolve(here, "../../routes/scanner.ts"), "utf8");
    assert.doesNotMatch(routes, /effectiveOpportunityScore\(b\) - effectiveOpportunityScore\(a\)/);
    assert.equal((routes.match(/decorateOpportunitiesWithFinalRead\(rankScannerOpportunities\(withFvg\)\)/g) ?? []).length, 2);
    assert.doesNotMatch(src("data/marketOverview.ts"), /effectiveOpportunityScore\(b\) - effectiveOpportunityScore\(a\)/);
    assert.match(src("opportunityRadar/radar.ts"), /rankByMeasuredTier\(/);
  });
});

// ── 3 + 4. score + scoreBasis ──────────────────────────────────────────────

/** Evaluate a scoreBasis expression over its inputs (floor/min only). Test-only. */
function evalExpr(expr: string, inputs: Record<string, number>): number {
  assert.match(expr, /^[\w\s.+\-*/()<>?:,]+$/, `unexpected token in ${expr}`);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("floor", "min", ...Object.keys(inputs), `return (${expr});`);
  return fn(Math.floor, Math.min, ...Object.values(inputs)) as number;
}

function assertRecomputable(s: SignalOutput) {
  const b = s.scoreBasis;
  assert.ok(b, `${s.strategy} ${s.direction} has no scoreBasis`);
  assert.equal(b.kind, "heuristic_rule");
  assert.equal(b.calibrated, false);
  for (const t of b.terms) assert.equal(evalExpr(t.expr, b.inputs), t.value, `${b.rule}: ${t.expr}`);
  const sum = b.base + b.terms.reduce((a, t) => a + t.value, 0);
  assert.equal(s.score, b.cap == null ? sum : Math.min(b.cap, sum), `${b.rule}: score vs basis`);
  assert.equal(evalExpr(b.formula, b.inputs), s.score, `${b.rule}: formula ${b.formula}`);
  assert.equal("confidence" in s, false, "strategy payloads no longer carry `confidence`");
}

function bars(closes: number[], shape: (i: number, c: number, prev: number) => Partial<Candle> = () => ({})): Candle[] {
  return closes.map((c, i) => {
    const prev = closes[i - 1] ?? c;
    return { time: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), open: prev, high: Math.max(prev, c) + 0.0002, low: Math.min(prev, c) - 0.0002, close: c, volume: 1, ...shape(i, c, prev) };
  });
}

describe("strategy score is a named, inspectable heuristic", () => {
  it("every strategy on random walks: score recomputes from scoreBasis, WAIT included", () => {
    const strategies = [trendContinuationStrategy, breakOfStructureStrategy, liquiditySweepStrategy, volatilityExpansionStrategy, pullbackContinuationStrategy, meanReversionStrategy];
    const seen = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const r = seededRandom(seed);
      const drift = (r() - 0.5) * 0.0006;
      let p = 1.1;
      const closes = Array.from({ length: 230 }, () => (p += drift + (r() - 0.5) * 0.002));
      const candles = bars(closes, (_i, c, prev) => ({ high: Math.max(prev, c) + r() * 0.002, low: Math.min(prev, c) - r() * 0.002 }));
      for (const fn of strategies) {
        const s = fn(candles, "EURUSD");
        assertRecomputable(s);
        seen.add(s.scoreBasis!.rule);
      }
    }
    // Directional branches were exercised, not only the WAIT constants.
    const directional = [...seen].filter((r) => r.endsWith(".buy") || r.endsWith(".sell"));
    assert.ok(directional.length >= 6, `directional rules seen: ${directional.join(", ")}`);
  });

  it("trend continuation BUY: the documented formula, inputs and terms", () => {
    let p = 1;
    const closes = Array.from({ length: 230 }, (_, i) => (p += i % 5 === 4 ? -0.0008 : 0.0006));
    const s = trendContinuationStrategy(bars(closes), "EURUSD");
    if (s.direction === "BUY") {
      assert.equal(s.scoreBasis!.rule, "trend_continuation.buy");
      assert.equal(s.scoreBasis!.formula, "min(95, 70 + floor((rsi - 50) * 1.5))");
      assert.deepEqual(Object.keys(s.scoreBasis!.inputs), ["rsi"]);
    }
    assertRecomputable(s);
  });

  it("insufficient data is a labelled constant, not a hidden number", () => {
    const s = trendContinuationStrategy(bars([1, 1.1, 1.2]), "EURUSD");
    assert.equal(s.direction, "WAIT");
    assert.equal(s.score, 0);
    assert.equal(s.scoreBasis!.rule, "trend_continuation.insufficient_data");
    assert.equal(s.scoreBasis!.formula, "0");
    assert.match(s.scoreBasis!.note, /no information about outcome odds/);
  });

  it("runStrategyScan: score + basis + rank label, and the no-trade filter talks about a score", () => {
    let p = 1;
    const closes = Array.from({ length: 230 }, (_, i) => (p += i % 5 === 4 ? -0.0008 : 0.0006));
    const out = runStrategyScan("EURUSD", bars(closes), 99, "synthetic", { timeframe: "M5" });
    assertRecomputable(out);
    if (out.rankBasis) assert.equal(out.rankLabel, UNMEASURED_RANK_LABEL);
    if (/below minimum/.test(out.reason)) assert.match(out.reason, /^Score \d+ below minimum 99 \(uncalibrated heuristic score\)$/);
    assert.doesNotMatch(out.reason, /Confidence/);
  });

  it("runStrategyScan picks by calibrated probability on the scan's own timeframe", () => {
    // Fit every directional strategy's key on M5 so the measured one wins.
    const r = seededRandom(5);
    const fit: CalibrationFit = fitCalibration(Array.from({ length: 400 }, () => {
      const score = r() * 100;
      return { score, outcome: (r() < 0.1 + 0.8 * (score / 100) ? 1 : 0) as 0 | 1 };
    }));
    const names = ["Trend Continuation", "Break of Structure", "Liquidity Sweep Reversal", "Volatility Expansion", "Pullback Continuation", "Mean Reversion", "Session Breakout"];
    replaceCalibrationCache(names.map((n) => [fitKey(strategyCalibrationKey(n), "EURUSD", "M5"), { fit, version: 1, source: "test", fittedAt: "2026-11-10T00:00:00Z" }] as [string, never]));
    let p = 1;
    const closes = Array.from({ length: 230 }, (_, i) => (p += i % 5 === 4 ? -0.0008 : 0.0006));
    const out = runStrategyScan("EURUSD", bars(closes), 0, "synthetic", { timeframe: "M5" });
    if (out.rankBasis) {
      assert.notEqual(out.rankBasis, "unmeasured_raw_order");
      assert.equal(out.calibration?.status, "measured");
      assert.match(String(out.rankLabel), /\(N=400\)/);
    }
  });

  it("consumers read `score`; no strategy consumer reads `.confidence` off a SignalOutput", () => {
    const root = resolve(here, "../..");
    const files = ["lib/shadowMode.ts", "lib/paperIntelligence.ts", "routes/backtestRuns.ts", "routes/watchlists.ts", "routes/tradeDecision.ts", "lib/missionTestingLabService.ts", "lib/calibration/strategyReplay.ts"];
    for (const f of files) {
      const s = readFileSync(resolve(root, f), "utf8");
      assert.doesNotMatch(s, /\b(sig|scan|signal|chosenStrategySignal)\.confidence\b/, `${f} reads .confidence`);
    }
  });
});
