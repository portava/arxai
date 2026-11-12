// Risk tools measured on P&L, on REAL markets.
//
// QUESTION: none of the seven strategies has a directional edge on real bars
// (docs/SESSION_EDGE_RESULTS.md). Can tools that need NO directional edge make
// the same trades lose less? Three tools, each fixed BEFORE looking:
//   - cost gate: refuse a trade whose round-trip spread costs more than 10% of
//     its risk (lib/risk tradeGates.costGate, DEFAULT_MAX_COST_R);
//   - quiet gate: refuse a trade when the 4-bar volatility forecast (HAR +
//     hour-of-week, lib/risk volForecast) is below the 20th percentile of that
//     series' own forecasts in its TRAINING window;
//   - vol sizing: risk per trade scaled by (training-median sigma / forecast
//     sigma), clamped to [0.5, 2] (volTargetBaseFrac's rule), vs fixed risk.
//
// METHOD
//   - Every strategy, replayed through the calibration path
//     (strategyReplay.replayStrategies) on every series of real-markets-v1.
//   - The vol model and the quiet threshold are fitted on the first 40% of each
//     series. ONLY trades signalled after that are scored (out of sample).
//   - Net R = gross R minus round-trip spread in R (the validation runner's
//     assumed half-spreads).
//   - A gate "helps" when the trades it lets through have a higher mean net R
//     than the ones it refuses: Welch t on kept vs refused.
//
// Prints a summary; --markdown <path> writes the generated part of the doc.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stableStringify } from "@workspace/discovery";
import {
  fitVolModels, forecastAt, volFeatures, roundTripCostR, costGate, quietGate, quantile, sigmaExpectedFromVariance,
  normalSf, DEFAULT_MAX_COST_R, type VolBar,
} from "@workspace/risk";
import { strategyCalibrationKey } from "../../../artifacts/api-server/src/lib/calibration/cache.js";
import { replayStrategies, REPLAYABLE_STRATEGIES, REPLAY_WINDOW } from "../../../artifacts/api-server/src/lib/calibration/strategyReplay.js";
import { loadVerifiedMarketsFixture } from "./marketsHistoryFixture.js";
import { MARKETS_RUNNER_PARAMS } from "./realDataValidation.js";
import { TIMEFRAME_SECONDS } from "./intradayHistoryFixture.js";

export const RISK_TOOLS_VERSION = "arx-risk-tools-research-v1";
const TRAIN_FRACTION = 0.4;
const QUIET_QUANTILE = 0.2;
const HORIZON = 4;
const BARS_PER_DAY: Record<string, number> = { M15: 96, H1: 24 };
const SIZE_CLAMP: [number, number] = [0.5, 2];

export interface ScoredTrade {
  symbol: string; timeframe: string; strategy: string; barIndex: number;
  grossR: number; netR: number; costR: number; won: boolean;
  costOk: boolean; quietOk: boolean; volScale: number;
}

interface Stat { n: number; mean: number; sd: number; t: number; lo95: number; hi95: number }
function stat(xs: readonly number[]): Stat {
  const n = xs.length;
  if (n < 2) return { n, mean: n ? xs[0]! : 0, sd: 0, t: 0, lo95: 0, hi95: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, sd, t: se > 0 ? mean / se : 0, lo95: mean - 1.96 * se, hi95: mean + 1.96 * se };
}
function welch(a: readonly number[], b: readonly number[]): { diff: number; t: number; p: number } {
  const A = stat(a);
  const B = stat(b);
  const se = Math.sqrt((A.sd ** 2) / Math.max(1, A.n) + (B.sd ** 2) / Math.max(1, B.n));
  const diff = A.mean - B.mean;
  const t = se > 0 ? diff / se : 0;
  return { diff, t, p: Math.min(1, 2 * normalSf(Math.abs(t))) };
}
/** Max drawdown of a cumulative P&L path (in R-at-unit-risk). */
function maxDrawdown(pnl: readonly number[]): number {
  let peak = 0;
  let eq = 0;
  let dd = 0;
  for (const x of pnl) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return dd;
}

export function runRiskToolsResearch(fixturesRoot = new URL("../../fixtures", import.meta.url).pathname) {
  const { manifest, instruments } = loadVerifiedMarketsFixture(fixturesRoot);
  const fnByKey = new Map(REPLAYABLE_STRATEGIES.map((s) => [s.name, s.fn]));
  const trades: ScoredTrade[] = [];
  for (const inst of instruments) {
    const tf = inst.spec.timeframe;
    const step = TIMEFRAME_SECONDS[tf] * 1000;
    const half = MARKETS_RUNNER_PARAMS.costPerTurnover[inst.spec.assetClass as "fx" | "metal" | "index"]!;
    const vbars: VolBar[] = inst.bars.map((b, i) => ({ t: Date.parse(inst.dates[i]!), high: b.high, low: b.low, close: b.close }));
    const trainEnd = Math.floor(vbars.length * TRAIN_FRACTION);
    const fitted = fitVolModels(vbars, { horizon: HORIZON, barsPerDay: BARS_PER_DAY[tf]! }, trainEnd);
    const f = volFeatures(vbars, fitted);
    // Quiet threshold + sizing reference from TRAINING-window forecasts only.
    const trainFc: number[] = [];
    for (let i = 5 * BARS_PER_DAY[tf]!; i < trainEnd; i++) {
      const v = forecastAt(vbars, fitted, step, i, f).harSeasonal;
      if (v > 0 && Number.isFinite(v)) trainFc.push(v);
    }
    const quietThreshold = quantile(trainFc, QUIET_QUANTILE);
    const sigmaRef = sigmaExpectedFromVariance(quantile(trainFc, 0.5));
    const candles = inst.bars.map((b, k) => ({ time: inst.dates[k]!, open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 }));
    const nameByKey = new Map(REPLAYABLE_STRATEGIES.map((s) => [strategyCalibrationKey(s.name), s.name]));
    for (const s of replayStrategies(candles, inst.spec.symbol)) {
      if (s.barIndex < trainEnd) continue;
      const name = nameByKey.get(s.strategyKey);
      if (!name) throw new Error(`unknown strategy key ${s.strategyKey}`);
      const sig = fnByKey.get(name)!(candles.slice(s.barIndex - REPLAY_WINDOW + 1, s.barIndex + 1), inst.spec.symbol);
      const costR = roundTripCostR(sig.entryPrice, sig.stopLoss, half);
      if (!Number.isFinite(costR)) throw new Error(`${inst.spec.symbol}@${s.barIndex} ${name}: replayed call has no stop distance`);
      const won = s.outcome === 1;
      const grossR = won ? s.rr : -1;
      const fc = forecastAt(vbars, fitted, step, s.barIndex, f).harSeasonal;
      const sigma = sigmaExpectedFromVariance(fc);
      const scale = sigma > 0 ? Math.min(SIZE_CLAMP[1], Math.max(SIZE_CLAMP[0], sigmaRef / sigma)) : SIZE_CLAMP[0];
      trades.push({
        symbol: inst.spec.symbol, timeframe: tf, strategy: name, barIndex: s.barIndex,
        grossR, netR: grossR - costR, costR, won,
        costOk: costGate(costR).allow, quietOk: quietGate(fc, quietThreshold).allow, volScale: scale,
      });
    }
  }

  const net = (xs: ScoredTrade[]) => xs.map((x) => x.netR);
  const variants = [
    { key: "all trades", keep: (_: ScoredTrade) => true },
    { key: `cost gate (spread ≤ ${DEFAULT_MAX_COST_R * 100}% of risk)`, keep: (x: ScoredTrade) => x.costOk },
    { key: `quiet gate (forecast ≥ training p${QUIET_QUANTILE * 100})`, keep: (x: ScoredTrade) => x.quietOk },
    { key: "both gates", keep: (x: ScoredTrade) => x.costOk && x.quietOk },
  ].map((v) => {
    const kept = trades.filter(v.keep);
    const refused = trades.filter((x) => !v.keep(x));
    const gross = (xs: ScoredTrade[]) => xs.map((x) => x.grossR);
    return { key: v.key, keptGross: stat(gross(kept)), refusedGross: stat(gross(refused)), grossKeptVsRefused: refused.length ? welch(gross(kept), gross(refused)) : null,
      kept: stat(net(kept)), refused: stat(net(refused)), keptVsRefused: refused.length ? welch(net(kept), net(refused)) : null, totalNetR: net(kept).reduce((a, b) => a + b, 0) };
  });

  // Vol sizing vs fixed risk, on the both-gates trade set, per series in time order.
  const gated = trades.filter((x) => x.costOk && x.quietOk);
  const fixedPnl: number[] = [];
  const volPnl: number[] = [];
  let ddFixed = 0;
  let ddVol = 0;
  for (const key of [...new Set(gated.map((x) => `${x.symbol}|${x.timeframe}`))]) {
    const xs = gated.filter((x) => `${x.symbol}|${x.timeframe}` === key).sort((a, b) => a.barIndex - b.barIndex);
    const fp = xs.map((x) => x.netR);
    const vp = xs.map((x) => x.netR * x.volScale);
    fixedPnl.push(...fp);
    volPnl.push(...vp);
    ddFixed += maxDrawdown(fp);
    ddVol += maxDrawdown(vp);
  }
  const fx = stat(fixedPnl);
  const vs = stat(volPnl);
  const sizing = {
    n: fx.n,
    fixed: { meanR: fx.mean, sdR: fx.sd, perTradeSharpe: fx.sd > 0 ? fx.mean / fx.sd : 0, sumMaxDrawdownR: ddFixed },
    volScaled: { meanR: vs.mean, sdR: vs.sd, perTradeSharpe: vs.sd > 0 ? vs.mean / vs.sd : 0, sumMaxDrawdownR: ddVol },
  };

  const strategies = REPLAYABLE_STRATEGIES.map((s) => s.name).map((name) => {
    const all = trades.filter((x) => x.strategy === name);
    const kept = all.filter((x) => x.costOk && x.quietOk);
    return {
      strategy: name,
      all: { ...stat(net(all)), winRate: all.filter((x) => x.won).length / Math.max(1, all.length), grossMean: stat(all.map((x) => x.grossR)).mean },
      gated: { ...stat(net(kept)), winRate: kept.filter((x) => x.won).length / Math.max(1, kept.length) },
    };
  });

  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const resultHash = createHash("sha256").update(stableStringify({
    trades: trades.map((x) => [x.symbol, x.timeframe, x.strategy, x.barIndex, r6(x.netR), x.costOk, x.quietOk, r6(x.volScale)]),
  })).digest("hex");
  return { version: RISK_TOOLS_VERSION, datasetHash: manifest.datasetHash, trades: trades.length, variants, sizing, strategies, resultHash };
}

const f3 = (x: number) => x.toFixed(3);
const fP = (p: number) => (p < 1e-4 ? p.toExponential(1) : p.toFixed(4));

export function renderRiskToolsMarkdown(r: ReturnType<typeof runRiskToolsResearch>): string {
  const L: string[] = [];
  L.push("# Risk tools results (real markets)", "");
  L.push(`Generated by \`scripts/src/research/riskToolsResearch.ts\` (${r.version}) on \`real-markets-v1\` (dataset ${r.datasetHash.slice(0, 12)}…). Result hash ${r.resultHash.slice(0, 12)}…`, "");
  L.push(`${r.trades} out-of-sample trades: every strategy, every series, signalled after the 40% training window. R is net of the assumed round-trip spread.`, "");
  L.push("## Gates", "", "| Variant | Trades kept | Mean net R kept (95% CI) | Trades refused | Mean net R refused | Kept − refused | p | Total net R kept | Gross R kept / refused (p) |", "|---|---|---|---|---|---|---|---|---|");
  for (const v of r.variants) {
    L.push(`| ${v.key} | ${v.kept.n} | ${f3(v.kept.mean)} (${f3(v.kept.lo95)} to ${f3(v.kept.hi95)}) | ${v.refused.n} | ${v.refused.n ? f3(v.refused.mean) : "—"} | ${v.keptVsRefused ? f3(v.keptVsRefused.diff) : "—"} | ${v.keptVsRefused ? fP(v.keptVsRefused.p) : "—"} | ${v.totalNetR.toFixed(1)} | ${v.grossKeptVsRefused ? `${f3(v.keptGross.mean)} / ${f3(v.refusedGross.mean)} (${fP(v.grossKeptVsRefused.p)})` : f3(v.keptGross.mean)} |`);
  }
  L.push("", "## Vol-scaled risk vs fixed risk (trades passing both gates)", "", "| Sizing | Mean R per trade | SD | Per-trade Sharpe | Sum of per-series max drawdowns (R) |", "|---|---|---|---|---|");
  L.push(`| fixed risk | ${f3(r.sizing.fixed.meanR)} | ${f3(r.sizing.fixed.sdR)} | ${f3(r.sizing.fixed.perTradeSharpe)} | ${r.sizing.fixed.sumMaxDrawdownR.toFixed(1)} |`);
  L.push(`| vol-scaled (clamp ${SIZE_CLAMP[0]}–${SIZE_CLAMP[1]}×) | ${f3(r.sizing.volScaled.meanR)} | ${f3(r.sizing.volScaled.sdR)} | ${f3(r.sizing.volScaled.perTradeSharpe)} | ${r.sizing.volScaled.sumMaxDrawdownR.toFixed(1)} |`);
  L.push("", "## Measured expectancy per strategy (out of sample, net of spread)", "", "| Strategy | Trades | Win rate | Gross R | Net R (95% CI) | With both gates: trades | Net R (95% CI) |", "|---|---|---|---|---|---|---|");
  for (const s of r.strategies) {
    L.push(`| ${s.strategy} | ${s.all.n} | ${(s.all.winRate * 100).toFixed(1)}% | ${f3(s.all.grossMean)} | ${f3(s.all.mean)} (${f3(s.all.lo95)} to ${f3(s.all.hi95)}) | ${s.gated.n} | ${f3(s.gated.mean)} (${f3(s.gated.lo95)} to ${f3(s.gated.hi95)}) |`);
  }
  L.push("");
  return `${L.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = runRiskToolsResearch();
  const i = process.argv.indexOf("--markdown");
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, renderRiskToolsMarkdown(r));
  console.log(renderRiskToolsMarkdown(r));
}
