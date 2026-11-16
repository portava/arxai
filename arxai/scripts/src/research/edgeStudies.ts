// Two edge studies on real history, both pure (no IO) so they can be tested
// with planted-edge and no-edge controls:
//
// 1. Scanner expectancy after costs. The calibration grade asks whether the
//    scanner's hit rate beats the base rate. A call can be right less often and
//    still pay (target farther than stop), so this grades each replayed scanner
//    call in R (risk units): +reward/risk on a target, -1 on a stop, minus the
//    round-trip spread in R. Calls are the exact scanner row rebuilt from closed
//    bars (agentReplay.scannerContextAt), resolved first-touch with the stop
//    checked first inside a bar, and never overlapping.
//
// 2. Time-series momentum (trend following), pre-registered: lookbacks 1, 3, 6
//    and 12 months, position = sign(past return) scaled to a fixed volatility
//    target from the PAST volatility only, one bar of delay, costs on every
//    change of position and a financing charge on the position held. No
//    parameter is fitted; every lookback is reported, and the verdict is
//    corrected for the number of tests.
//
// Verdicts never use the in-sample period alone: the second half of each
// series is reported separately and must agree.

import type { Candle } from "../../../artifacts/api-server/src/lib/strategyEngine.js";
import { scannerContextAt, AGENT_REPLAY_WINDOW } from "../../../artifacts/api-server/src/lib/calibration/agentReplay.js";
import { REPLAY_HORIZON_BARS, resolutionBar } from "../../../artifacts/api-server/src/lib/calibration/strategyReplay.js";
import { labelFirstTouch } from "@workspace/domain/calibration";

// ── Statistics ──────────────────────────────────────────────────────────────

export interface MeanStats { n: number; mean: number; sd: number; se: number; t: number; lower95: number; upper95: number }

export function meanStats(xs: readonly number[]): MeanStats {
  const n = xs.length;
  if (n < 2) return { n, mean: n ? xs[0]! : 0, sd: 0, se: Infinity, t: 0, lower95: -Infinity, upper95: Infinity };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, sd, se, t: se > 0 ? mean / se : 0, lower95: mean - 1.96 * se, upper95: mean + 1.96 * se };
}

/** Two-sided normal z needed for `tests` simultaneous tests at 5% (Bonferroni). */
export function bonferroniZ(tests: number): number {
  const alpha = 0.05 / Math.max(1, tests);
  // Inverse normal (Acklam), enough precision for a threshold.
  const p = 1 - alpha / 2;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.sqrt(-2 * Math.log(1 - p));
  if (p > 1 - 0.02425) return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  const r = p - 0.5, s = r * r;
  return (((((a[0]! * s + a[1]!) * s + a[2]!) * s + a[3]!) * s + a[4]!) * s + a[5]!) * r / (((((b[0]! * s + b[1]!) * s + b[2]!) * s + b[3]!) * s + b[4]!) * s + 1);
}

// ── 1. Scanner expectancy after costs ───────────────────────────────────────

export interface ScannerCall { i: number; direction: "BUY" | "SELL"; win: boolean; rewardR: number; costR: number; rGross: number; rNet: number }

/** Every non-overlapping scanner call on the series, graded in R. `halfSpread`
 *  is a fraction of price paid on entry and again on exit. */
export function scannerCalls(candles: readonly Candle[], symbol: string, timeframe: string, halfSpread: number, horizon = REPLAY_HORIZON_BARS): ScannerCall[] {
  const out: ScannerCall[] = [];
  let i = AGENT_REPLAY_WINDOW - 1;
  while (i < candles.length - 1) {
    const { analysis, ctx } = scannerContextAt(candles, i, symbol, timeframe);
    const direction = ctx.direction;
    if (direction !== "BUY" && direction !== "SELL") { i++; continue; }
    const entry = candles[i]!.close;
    const risk = Math.abs(entry - analysis.stopLoss);
    const reward = Math.abs(analysis.takeProfit - entry);
    const outcome = labelFirstTouch(candles, i, direction, analysis.stopLoss, analysis.takeProfit, horizon);
    if (outcome === null || !(risk > 0) || !(reward > 0)) { i += outcome === null ? horizon + 1 : 1; continue; }
    const rewardR = reward / risk;
    const costR = (2 * halfSpread * entry) / risk;
    const rGross = outcome === 1 ? rewardR : -1;
    out.push({ i, direction, win: outcome === 1, rewardR, costR, rGross, rNet: rGross - costR });
    i = resolutionBar(candles, i, direction, analysis.stopLoss, analysis.takeProfit, horizon) + 1;
  }
  return out;
}

export interface ExpectancyRow {
  cell: string; n: number; hitRate: number; avgRewardR: number; avgCostR: number;
  gross: MeanStats; net: MeanStats; netSecondHalf: MeanStats; edge: boolean;
}

/** Edge only when net expectancy is above zero at the corrected threshold on
 *  all calls AND positive on the later half alone. */
export function expectancyRow(cell: string, calls: readonly ScannerCall[], z: number): ExpectancyRow {
  const net = meanStats(calls.map((c) => c.rNet));
  const half = calls.slice(Math.floor(calls.length / 2));
  const netSecondHalf = meanStats(half.map((c) => c.rNet));
  const n = calls.length;
  return {
    cell, n,
    hitRate: n ? calls.filter((c) => c.win).length / n : 0,
    avgRewardR: n ? calls.reduce((a, c) => a + c.rewardR, 0) / n : 0,
    avgCostR: n ? calls.reduce((a, c) => a + c.costR, 0) / n : 0,
    gross: meanStats(calls.map((c) => c.rGross)), net, netSecondHalf,
    edge: n >= 100 && net.mean - z * net.se > 0 && netSecondHalf.mean > 0,
  };
}

// ── 2. Time-series momentum ─────────────────────────────────────────────────

export interface TsmomParams {
  lookback: number; volLookback: number; barsPerYear: number;
  targetVolAnnual: number; maxLeverage: number;
  /** Fraction of price per unit of position change (half-spread). */
  costPerTurnover: number;
  /** Annual financing charged on |position| (CFD swap), as a fraction. */
  financingAnnual: number;
}

/** Per-bar net returns of the strategy, aligned to candles (null before it can trade). */
export function tsmomReturns(candles: readonly Candle[], p: TsmomParams): { time: string; ret: number; position: number }[] {
  const out: { time: string; ret: number; position: number }[] = [];
  const r: number[] = [0];
  for (let k = 1; k < candles.length; k++) r.push(Math.log(candles[k]!.close / candles[k - 1]!.close));
  let prev = 0;
  const start = Math.max(p.lookback, p.volLookback) + 1;
  for (let k = start; k < candles.length; k++) {
    // Decide at the close of k-1 from bars <= k-1, earn bar k's return.
    const past = Math.log(candles[k - 1]!.close / candles[k - 1 - p.lookback]!.close);
    let ss = 0;
    for (let j = k - p.volLookback; j <= k - 1; j++) ss += r[j]! ** 2;
    const vol = Math.sqrt((ss / p.volLookback) * p.barsPerYear);
    const raw = vol > 0 ? Math.sign(past) * (p.targetVolAnnual / vol) : 0;
    const position = Math.max(-p.maxLeverage, Math.min(p.maxLeverage, raw));
    const ret = position * r[k]! - p.costPerTurnover * Math.abs(position - prev) - (p.financingAnnual / p.barsPerYear) * Math.abs(position);
    out.push({ time: candles[k]!.time, ret, position });
    prev = position;
  }
  return out;
}

export interface SeriesPerformance { n: number; annualReturn: number; annualVol: number; sharpe: number; t: number }

export function performance(returns: readonly number[], barsPerYear: number): SeriesPerformance {
  const s = meanStats(returns);
  const annualVol = s.sd * Math.sqrt(barsPerYear);
  return { n: s.n, annualReturn: s.mean * barsPerYear, annualVol, sharpe: annualVol > 0 ? (s.mean * barsPerYear) / annualVol : 0, t: s.t };
}

/** Equal-weight portfolio of per-symbol return series, aligned on bar time;
 *  each date averages the symbols trading that date. */
export function equalWeight(series: readonly { time: string; ret: number }[][]): { time: string; ret: number }[] {
  const by = new Map<string, { sum: number; n: number }>();
  for (const s of series) for (const x of s) {
    const e = by.get(x.time) ?? { sum: 0, n: 0 };
    e.sum += x.ret; e.n += 1; by.set(x.time, e);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([time, e]) => ({ time, ret: e.sum / e.n }));
}
