// Modular Strategy Engine for ARX AI — Analyze. Risk. eXecute.

import {
  calibrate,
  strategyCalibrationKey,
  type CalibrationStamp,
} from "./calibration/cache.js";
import { rankByMeasuredTier, type MeasuredRankBasis } from "./ranking/measuredRank.js";

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalOutput {
  symbol: string;
  marketType?: "forex" | "indices" | "stocks" | "synthetic";
  direction: "BUY" | "SELL" | "WAIT";
  /** Hand-written heuristic SCORE, 0-100. NOT a probability and NOT a
   *  confidence: it is uncalibrated rule arithmetic over indicator values,
   *  and `scoreBasis` shows the exact rule and inputs that produced it. The
   *  measured probability, when one exists, is `calibratedProbability`.
   *  (Renamed from `confidence`; stored rows that still carry a `confidence`
   *  column are mapped at their own seam, see the PR notes.) */
  score: number;
  /** The rule, inputs and arithmetic behind `score`, so the number is
   *  explainable and recomputable. Set on every payload the engine builds. */
  scoreBasis?: ScoreBasis;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  reason: string;
  strategy: string;
  riskWarning: string;
  technicalBias?: "Bullish" | "Bearish" | "Neutral";
  macroBias?: "Bullish" | "Bearish" | "Neutral";
  marketCondition?: string;
  session?: string;
  /** R7 step 7 (intel-engine.md §1.1) — honesty label. Every payload this
   *  engine emits is ADVISORY_UNCALIBRATED until an edge passes validation
   *  (lib/discovery + lib/validation over real recorded data): none of the 7
   *  strategies has a validated sample, a cost model, or calibrated
   *  confidence. Additive + optional (out-of-scope fixture literals keep
   *  compiling); the exported strategy wrappers + runStrategyScan set it on
   *  EVERY real payload — WAIT included. */
  advisory?: typeof STRATEGY_ADVISORY_LABEL;
  /** Calibration engine: the MEASURED probability that this strategy's call
   *  works at this raw `score`, fitted on graded outcomes for this
   *  strategy × symbol × timeframe (see lib/calibration). null when fewer than
   *  the minimum graded outcomes exist. `score` above stays the raw,
   *  uncalibrated heuristic. */
  calibratedProbability?: number | null;
  /** Full calibration reading: status, N, scope, fit version. Always set on
   *  payloads leaving the exported seams. */
  calibration?: CalibrationStamp;
  /** How runStrategyScan picked this strategy over the others (lib/ranking):
   *  calibrated_probability | measured_base_rate | unmeasured_raw_order. */
  rankBasis?: MeasuredRankBasis;
  /** Plain label for rankBasis, e.g. "unmeasured, ranked by raw score". */
  rankLabel?: string;
}

/** The single honesty label stamped on every strategy-engine payload. */
export const STRATEGY_ADVISORY_LABEL = "ADVISORY_UNCALIBRATED" as const;

// ─── Score basis (inspectable heuristic arithmetic) ──────────────────────────

/** One additive term of a heuristic score. `expr` is the exact arithmetic over
 *  `ScoreBasis.inputs` that produced `value` (floor/min are Math.floor/min). */
export interface ScoreTerm {
  label: string;
  expr: string;
  value: number;
}

/**
 * How a strategy score was produced. Every score is
 * `min(cap, base + sum(terms.value))` (no cap → plain sum), and every term's
 * `expr` evaluates to its `value` over `inputs`, so a reader (or a test) can
 * recompute the number from the payload alone.
 */
export interface ScoreBasis {
  kind: "heuristic_rule";
  /** Always false: this is hand-tuned arithmetic, not a fitted probability. */
  calibrated: false;
  /** Stable rule id, e.g. "trend_continuation.buy" or "trend_continuation.wait". */
  rule: string;
  /** The whole score as one expression, e.g. "min(95, 70 + floor((rsi - 50) * 1.5))". */
  formula: string;
  /** Unrounded indicator values the formula reads. */
  inputs: Record<string, number>;
  base: number;
  terms: ScoreTerm[];
  cap: number | null;
  note: string;
}

export const SCORE_BASIS_NOTE =
  "Uncalibrated heuristic score (0-100) from a hand-written rule. It is not a probability or a confidence; the measured probability, when one exists, is the calibration reading.";
const CONSTANT_SCORE_NOTE =
  "Fixed score assigned when the rule found no setup. It carries no information about outcome odds.";

function ruleScore(
  rule: string,
  base: number,
  cap: number | null,
  inputs: Record<string, number>,
  terms: ScoreTerm[],
): { score: number; scoreBasis: ScoreBasis } {
  const raw = base + terms.reduce((a, t) => a + t.value, 0);
  const score = cap == null ? raw : Math.min(cap, raw);
  const sum = [String(base), ...terms.map((t) => t.expr)].join(" + ");
  return {
    score,
    scoreBasis: {
      kind: "heuristic_rule", calibrated: false, rule,
      formula: cap == null ? sum : `min(${cap}, ${sum})`,
      inputs, base, terms, cap, note: SCORE_BASIS_NOTE,
    },
  };
}

function constantScore(rule: string, value: number): { score: number; scoreBasis: ScoreBasis } {
  return {
    score: value,
    scoreBasis: {
      kind: "heuristic_rule", calibrated: false, rule, formula: String(value),
      inputs: {}, base: value, terms: [], cap: null, note: CONSTANT_SCORE_NOTE,
    },
  };
}

/** Rule-id prefix for a strategy display name ("Break of Structure" → "break_of_structure"). */
function ruleId(strategy: string, branch: string): string {
  return `${strategy.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}.${branch}`;
}

// Stamp the honesty label at the exported seam so no strategy payload —
// actionable or WAIT, whichever return path built it — can serialize without
// it. Pure and additive; nothing else in the payload is touched.
function labeledAdvisory(s: SignalOutput, timeframe = ""): SignalOutput {
  return { ...s, advisory: STRATEGY_ADVISORY_LABEL, ...calibrationFields(s, timeframe) };
}

/** Calibrated reading for a strategy payload. WAIT / no-strategy payloads make
 *  no directional call, so there is nothing to calibrate: null + unmeasured. */
function calibrationFields(s: SignalOutput, timeframe: string): Pick<SignalOutput, "calibratedProbability" | "calibration"> {
  const directional = s.direction === "BUY" || s.direction === "SELL";
  const strategy = directional ? strategyCalibrationKey(s.strategy) : "strategy:none";
  const calibration = calibrate(strategy, s.symbol, timeframe, s.score);
  if (!directional) {
    return {
      calibratedProbability: null,
      calibration: { ...calibration, probability: null, status: "unmeasured", n: 0, label: "unmeasured (N=0)", reason: "No directional call to calibrate." },
    };
  }
  return { calibratedProbability: calibration.probability, calibration };
}

// ─── Indicator helpers ────────────────────────────────────────────────────────

function computeEMA(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];
  let prevEma = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema.push(prevEma);
  for (let i = period; i < prices.length; i++) {
    prevEma = prices[i] * k + prevEma * (1 - k);
    ema.push(prevEma);
  }
  return ema;
}

function computeRSI(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  const gains = changes.map((c) => (c > 0 ? c : 0));
  const losses = changes.map((c) => (c < 0 ? -c : 0));
  const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
}

// ─── Session detection ────────────────────────────────────────────────────────

export type TradingSession = "Asia" | "London" | "London/NY Overlap" | "New York" | "Closed";

/**
 * Session of a moment in time (UTC hours). With no argument it is the session
 * now; pass a bar's time to get the session that bar traded in.
 */
export function detectSession(at?: Date | string | number): TradingSession {
  const d = at === undefined ? new Date() : new Date(at);
  const utcHour = Number.isFinite(d.getTime()) ? d.getUTCHours() : new Date().getUTCHours();
  if (utcHour >= 0 && utcHour < 8) return "Asia";
  if (utcHour >= 8 && utcHour < 13) return "London";
  if (utcHour >= 13 && utcHour < 17) return "London/NY Overlap";
  if (utcHour >= 17 && utcHour < 22) return "New York";
  return "Closed";
}

/** A candle's time as epoch ms, or undefined when it has none parseable. */
function barTimeOf(c: Candle | undefined): number | undefined {
  if (!c?.time) return undefined;
  const ms = Date.parse(c.time);
  return Number.isFinite(ms) ? ms : undefined;
}

// ─── Market condition labeling ────────────────────────────────────────────────

export function computeMarketCondition(candles: Candle[]): string {
  if (candles.length < 20) return "Insufficient Data";
  const recent = candles.slice(-20);
  const closes = recent.map((c) => c.close);
  const price = closes[closes.length - 1];
  const atr = computeATR(recent, 14);
  const avgRange = recent.reduce((a, c) => a + (c.high - c.low), 0) / recent.length;
  const rsi = computeRSI(closes, 14);
  // R7 step 7 honesty fix (intel-engine.md §1.5): this is an EMA-10 — the
  // variable was misnamed `ema20`. Renamed to match the math; the period is
  // deliberately UNCHANGED (widening the window would alter classification
  // behavior, which is a strategy change and belongs behind validation, not
  // an honesty patch). Window math verified: computeEMA seeds with the SMA of
  // the first `period` (10) closes, then iterates once per remaining close —
  // over this 20-close window that is a well-formed EMA-10 with 11 points.
  const ema10 = computeEMA(closes, 10);
  const e10 = ema10[ema10.length - 1];

  const highRange = Math.max(...closes) - Math.min(...closes);
  const isSideways = highRange < atr * 0.8;
  const isExpanding = atr > avgRange * 1.5;

  const last = recent[recent.length - 1];
  const wickUp = last.high - Math.max(last.open, last.close);
  const wickDown = Math.min(last.open, last.close) - last.low;
  const body = Math.abs(last.close - last.open);

  if (isExpanding && rsi > 65 && price > e10) return "Strong Uptrend";
  if (isExpanding && rsi < 35 && price < e10) return "Strong Downtrend";
  if (rsi > 70 && wickUp > body) return "Reversal Risk";
  if (rsi < 30 && wickDown > body) return "Reversal Risk";
  if (isExpanding) return "Breakout Forming";
  if (isSideways && rsi > 60) return "Range";
  if (isSideways && rsi < 40) return "Range";
  if (isSideways) return "Choppy";
  if (price > e10 && rsi >= 45 && rsi <= 60) return "Pullback";
  if (price < e10 && rsi >= 40 && rsi <= 55) return "Pullback";
  if (atr < avgRange * 0.5) return "Low Volatility";
  if (atr > avgRange * 2.5) return "High Volatility";
  return "Neutral";
}

// ─── Technical bias ───────────────────────────────────────────────────────────

export function computeTechnicalBias(candles: Candle[]): "Bullish" | "Bearish" | "Neutral" {
  if (candles.length < 50) return "Neutral";
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const e20 = ema20[ema20.length - 1];
  const e50 = ema50[ema50.length - 1];
  if (price > e20 && e20 > e50) return "Bullish";
  if (price < e20 && e20 < e50) return "Bearish";
  return "Neutral";
}

// ─── Strategy 1: Trend Continuation (EMA 20/50/200 + RSI + ATR) ──────────────

export function trendContinuationStrategy(candles: Candle[], symbol: string): SignalOutput {
  return labeledAdvisory(trendContinuationCore(candles, symbol));
}

function trendContinuationCore(candles: Candle[], symbol: string): SignalOutput {
  if (candles.length < 210) {
    return { symbol, direction: "WAIT", ...constantScore(ruleId("Trend Continuation", "insufficient_data"), 0), entryPrice: candles[candles.length - 1]?.close ?? 0, stopLoss: 0, takeProfit: 0, reason: "Insufficient candle data", strategy: "Trend Continuation", riskWarning: "Need 210+ candles" };
  }
  const closes = candles.map((c) => c.close);
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const ema200 = computeEMA(closes, 200);
  const rsi = computeRSI(closes.slice(-30), 14);
  const atr = computeATR(candles.slice(-20), 14);
  const price = closes[closes.length - 1];
  const e20 = ema20[ema20.length - 1];
  const e50 = ema50[ema50.length - 1];
  const e200 = ema200[ema200.length - 1];

  if (price > e50 && price > e200 && e20 > e50 && rsi >= 50 && rsi <= 70) {
    // R7 step 7 honesty fix (intel-engine.md §1.1): the former
    // `+ (price > e200 ? 10 : 0)` term sat inside a branch that already
    // requires price > e200 — the `: 0` arm was unreachable, so it was a
    // constant +10 dressed as a factor. Folded into the base (60 → 70);
    // outputs are identical for every reachable input.
    const scored = ruleScore(ruleId("Trend Continuation", "buy"), 70, 95, { rsi }, [{ label: "RSI above 50, x1.5", expr: "floor((rsi - 50) * 1.5)", value: Math.floor((rsi - 50) * 1.5) }]);
    return { symbol, direction: "BUY", ...scored, entryPrice: price, stopLoss: price - atr * 1.5, takeProfit: price + atr * 2.5, reason: `Price above EMA50/200. EMA20 > EMA50. RSI at ${rsi.toFixed(1)}. Trend momentum confirmed.`, strategy: "Trend Continuation", riskWarning: rsi > 65 ? "RSI approaching overbought zone" : "" };
  }
  if (price < e50 && price < e200 && e20 < e50 && rsi >= 30 && rsi <= 50) {
    // Same honesty fix as the BUY branch: `price < e200` is guaranteed here,
    // so the former conditional +10 was a constant. Folded (60 → 70).
    const scored = ruleScore(ruleId("Trend Continuation", "sell"), 70, 95, { rsi }, [{ label: "RSI below 50, x1.5", expr: "floor((50 - rsi) * 1.5)", value: Math.floor((50 - rsi) * 1.5) }]);
    return { symbol, direction: "SELL", ...scored, entryPrice: price, stopLoss: price + atr * 1.5, takeProfit: price - atr * 2.5, reason: `Price below EMA50/200. EMA20 < EMA50. RSI at ${rsi.toFixed(1)}. Downtrend momentum confirmed.`, strategy: "Trend Continuation", riskWarning: rsi < 35 ? "RSI approaching oversold zone" : "" };
  }
  return { symbol, direction: "WAIT", ...constantScore(ruleId("Trend Continuation", "no_setup"), 30), entryPrice: price, stopLoss: 0, takeProfit: 0, reason: "No clear trend alignment across EMAs", strategy: "Trend Continuation", riskWarning: "" };
}

// ─── Strategy 2: Break of Structure ──────────────────────────────────────────

export function breakOfStructureStrategy(candles: Candle[], symbol: string): SignalOutput {
  return labeledAdvisory(breakOfStructureCore(candles, symbol));
}

// CONSTRAINT (intel-engine.md §1.1 — honest note, NOT a redesign): the stop is
// placed at the OPPOSITE 17-bar extreme (`swingLow` for a BUY taken at the top
// of the range, `swingHigh` for a SELL at the bottom). Realized risk is
// therefore up to the FULL range height, so the effective R:R is structurally
// far worse than the `(price − swingLow) * 1.5` take-profit arithmetic makes
// the reason string sound. Changing the stop geometry is a strategy redesign
// and belongs behind the validation pipeline (lib/discovery/lib/validation),
// not in an honesty patch — this note exists so no reader mistakes the
// current geometry for a vetted 1.5R setup.
function breakOfStructureCore(candles: Candle[], symbol: string): SignalOutput {
  if (candles.length < 20) {
    return { symbol, direction: "WAIT", ...constantScore(ruleId("Break of Structure", "insufficient_data"), 0), entryPrice: candles[candles.length - 1]?.close ?? 0, stopLoss: 0, takeProfit: 0, reason: "Insufficient data", strategy: "Break of Structure", riskWarning: "" };
  }
  const recent = candles.slice(-20);
  const price = recent[recent.length - 1].close;
  // (The former `computeATR(recent, 14)` local was removed with the phantom
  // `atr > 0` confidence term below — nothing else in this strategy read it.)
  const closes = recent.map((c) => c.close);
  const rsi = computeRSI(closes, 14);
  const swingHigh = Math.max(...recent.slice(0, -3).map((c) => c.high));
  const swingLow = Math.min(...recent.slice(0, -3).map((c) => c.low));
  const lastCandle = recent[recent.length - 1];
  const prevCandle = recent[recent.length - 2];

  if (prevCandle.high > swingHigh && lastCandle.close < lastCandle.open && rsi < 65) {
    // R7 step 7 honesty fix (intel-engine.md §1.1): `+ (atr > 0 ? 5 : 0)` was
    // a constant wearing a factor's clothes — ATR is > 0 for any window that
    // can print a structure break (a fully flat window can never satisfy
    // prevCandle.high > swingHigh). Folded into the base (65 → 70); outputs
    // are identical for every reachable input.
    const scored = ruleScore(ruleId("Break of Structure", "buy"), 70, 88, { rsi }, [{ label: "RSI above 50 bonus", expr: "(rsi > 50 ? 10 : 0)", value: rsi > 50 ? 10 : 0 }]);
    return { symbol, direction: "BUY", ...scored, entryPrice: price, stopLoss: swingLow, takeProfit: price + (price - swingLow) * 1.5, reason: `Bullish Break of Structure confirmed. Price broke ${swingHigh.toFixed(4)} and pulled back. RSI: ${rsi.toFixed(1)}.`, strategy: "Break of Structure", riskWarning: "False breakout possible in choppy conditions" };
  }
  if (prevCandle.low < swingLow && lastCandle.close > lastCandle.open && rsi > 35) {
    // Same honesty fix as the BUY branch: the phantom ATR term folded (65 → 70).
    const scored = ruleScore(ruleId("Break of Structure", "sell"), 70, 88, { rsi }, [{ label: "RSI below 50 bonus", expr: "(rsi < 50 ? 10 : 0)", value: rsi < 50 ? 10 : 0 }]);
    return { symbol, direction: "SELL", ...scored, entryPrice: price, stopLoss: swingHigh, takeProfit: price - (swingHigh - price) * 1.5, reason: `Bearish Break of Structure confirmed. Price broke ${swingLow.toFixed(4)} and pulled back. RSI: ${rsi.toFixed(1)}.`, strategy: "Break of Structure", riskWarning: "Monitor for continuation before entry" };
  }
  return { symbol, direction: "WAIT", ...constantScore(ruleId("Break of Structure", "no_setup"), 25), entryPrice: price, stopLoss: 0, takeProfit: 0, reason: "No structure break detected", strategy: "Break of Structure", riskWarning: "" };
}

// ─── Strategy 3: Liquidity Sweep Reversal ────────────────────────────────────

export function liquiditySweepStrategy(candles: Candle[], symbol: string): SignalOutput {
  return labeledAdvisory(liquiditySweepCore(candles, symbol));
}

function liquiditySweepCore(candles: Candle[], symbol: string): SignalOutput {
  if (candles.length < 15) {
    return { symbol, direction: "WAIT", ...constantScore(ruleId("Liquidity Sweep Reversal", "insufficient_data"), 0), entryPrice: candles[candles.length - 1]?.close ?? 0, stopLoss: 0, takeProfit: 0, reason: "Insufficient data", strategy: "Liquidity Sweep Reversal", riskWarning: "" };
  }
  const recent = candles.slice(-15);
  const price = recent[recent.length - 1].close;
  const atr = computeATR(recent, 14);
  const closes = recent.map((c) => c.close);
  const rsi = computeRSI(closes, 14);
  const last = recent[recent.length - 1];
  const prevHigh = Math.max(...recent.slice(0, -1).map((c) => c.high));
  const prevLow = Math.min(...recent.slice(0, -1).map((c) => c.low));
  const wickUp = last.high - Math.max(last.open, last.close);
  const body = Math.abs(last.close - last.open);

  if (last.high > prevHigh && last.close < prevHigh && wickUp > body && rsi > 65) {
    const scored = ruleScore(ruleId("Liquidity Sweep Reversal", "sell"), 70, 90, { rsi }, [{ label: "RSI above 65, x2", expr: "floor((rsi - 65) * 2)", value: Math.floor((rsi - 65) * 2) }]);
    return { symbol, direction: "SELL", ...scored, entryPrice: price, stopLoss: last.high + atr * 0.5, takeProfit: price - atr * 2, reason: `Liquidity sweep above ${prevHigh.toFixed(4)}. Wick rejection ${wickUp.toFixed(4)} > body ${body.toFixed(4)}. RSI exhaustion at ${rsi.toFixed(1)}.`, strategy: "Liquidity Sweep Reversal", riskWarning: "High risk reversal — use tight stop" };
  }
  const wickDown = Math.min(last.open, last.close) - last.low;
  if (last.low < prevLow && last.close > prevLow && wickDown > body && rsi < 35) {
    const scored = ruleScore(ruleId("Liquidity Sweep Reversal", "buy"), 70, 90, { rsi }, [{ label: "RSI below 35, x2", expr: "floor((35 - rsi) * 2)", value: Math.floor((35 - rsi) * 2) }]);
    return { symbol, direction: "BUY", ...scored, entryPrice: price, stopLoss: last.low - atr * 0.5, takeProfit: price + atr * 2, reason: `Liquidity sweep below ${prevLow.toFixed(4)}. Wick rejection ${wickDown.toFixed(4)} > body ${body.toFixed(4)}. RSI exhaustion at ${rsi.toFixed(1)}.`, strategy: "Liquidity Sweep Reversal", riskWarning: "Reversal trade — confirm with higher timeframe" };
  }
  return { symbol, direction: "WAIT", ...constantScore(ruleId("Liquidity Sweep Reversal", "no_setup"), 20), entryPrice: price, stopLoss: 0, takeProfit: 0, reason: "No liquidity sweep detected", strategy: "Liquidity Sweep Reversal", riskWarning: "" };
}

function volatilityScore(branch: "buy" | "sell", bodyRatio: number, atr: number, avgATR: number) {
  return ruleScore(ruleId("Volatility Expansion", branch), 60, 85, { bodyRatio, atr, avgATR }, [
    { label: "candle body ratio, x20", expr: "floor(bodyRatio * 20)", value: Math.floor(bodyRatio * 20) },
    { label: "ATR above 2x its average bonus", expr: "(atr > avgATR * 2 ? 5 : 0)", value: atr > avgATR * 2 ? 5 : 0 },
  ]);
}

// ─── Strategy 4: Volatility Expansion ────────────────────────────────────────

export function volatilityExpansionStrategy(candles: Candle[], symbol: string): SignalOutput {
  return labeledAdvisory(volatilityExpansionCore(candles, symbol));
}

function volatilityExpansionCore(candles: Candle[], symbol: string): SignalOutput {
  if (candles.length < 20) {
    return { symbol, direction: "WAIT", ...constantScore(ruleId("Volatility Expansion", "insufficient_data"), 0), entryPrice: candles[candles.length - 1]?.close ?? 0, stopLoss: 0, takeProfit: 0, reason: "Insufficient data", strategy: "Volatility Expansion", riskWarning: "" };
  }
  const recent = candles.slice(-20);
  const price = recent[recent.length - 1].close;
  const atr = computeATR(recent, 14);
  const avgATR = computeATR(recent.slice(0, -5), 14);
  const closes = recent.map((c) => c.close);
  // R7 step 7 honesty fix (intel-engine.md §1.5, same defect as
  // computeMarketCondition): this is an EMA-10 that was misnamed `ema20`.
  // Renamed only — the period is unchanged (see the note there).
  const ema10 = computeEMA(closes, 10);
  const last = recent[recent.length - 1];
  const candleBody = Math.abs(last.close - last.open);
  const candleRange = last.high - last.low;
  const bodyRatio = candleRange > 0 ? candleBody / candleRange : 0;
  const isExpanding = atr > avgATR * 1.4 && bodyRatio > 0.6;
  const trend = ema10[ema10.length - 1];

  if (isExpanding && last.close > last.open && price > trend) {
    const scored = volatilityScore("buy", bodyRatio, atr, avgATR);
    return { symbol, direction: "BUY", ...scored, entryPrice: price, stopLoss: price - atr * 1.2, takeProfit: price + atr * 2, reason: `Bullish volatility expansion. ATR ${atr.toFixed(4)} vs avg ${avgATR.toFixed(4)}. Body ratio ${(bodyRatio * 100).toFixed(0)}%.`, strategy: "Volatility Expansion", riskWarning: "High volatility — wider spreads likely" };
  }
  if (isExpanding && last.close < last.open && price < trend) {
    const scored = volatilityScore("sell", bodyRatio, atr, avgATR);
    return { symbol, direction: "SELL", ...scored, entryPrice: price, stopLoss: price + atr * 1.2, takeProfit: price - atr * 2, reason: `Bearish volatility expansion. ATR ${atr.toFixed(4)} vs avg ${avgATR.toFixed(4)}. Body ratio ${(bodyRatio * 100).toFixed(0)}%.`, strategy: "Volatility Expansion", riskWarning: "High volatility — wider spreads likely" };
  }
  return { symbol, direction: "WAIT", ...constantScore(ruleId("Volatility Expansion", "no_setup"), 15), entryPrice: price, stopLoss: 0, takeProfit: 0, reason: "No significant volatility expansion detected", strategy: "Volatility Expansion", riskWarning: "" };
}

// ─── Strategy 5: Pullback Continuation ───────────────────────────────────────

export function pullbackContinuationStrategy(candles: Candle[], symbol: string): SignalOutput {
  return labeledAdvisory(pullbackContinuationCore(candles, symbol));
}

function pullbackContinuationCore(candles: Candle[], symbol: string): SignalOutput {
  if (candles.length < 60) {
    return { symbol, direction: "WAIT", ...constantScore(ruleId("Pullback Continuation", "insufficient_data"), 0), entryPrice: candles[candles.length - 1]?.close ?? 0, stopLoss: 0, takeProfit: 0, reason: "Insufficient data", strategy: "Pullback Continuation", riskWarning: "" };
  }
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const atr = computeATR(candles.slice(-20), 14);
  const rsi = computeRSI(closes.slice(-30), 14);
  const e20 = ema20[ema20.length - 1];
  const e50 = ema50[ema50.length - 1];
  const last = candles[candles.length - 1];
  const pullbackZone = atr * 1.5;
  const wickDown = Math.min(last.open, last.close) - last.low;
  const wickUp = last.high - Math.max(last.open, last.close);
  const body = Math.abs(last.close - last.open);

  // Bullish pullback: uptrend, price pulled back to EMA20 zone, RSI cooling, wick rejection from below
  if (e20 > e50 && Math.abs(price - e20) < pullbackZone && rsi >= 40 && rsi <= 58 && wickDown > body * 0.5) {
    const scored = ruleScore(ruleId("Pullback Continuation", "buy"), 62, 82, { rsi }, [{ label: "RSI below 58, x1.2", expr: "floor((58 - rsi) * 1.2)", value: Math.floor((58 - rsi) * 1.2) }]);
    return { symbol, direction: "BUY", ...scored, entryPrice: price, stopLoss: last.low - atr * 0.5, takeProfit: price + atr * 2.2, reason: `Pullback to EMA20 zone in uptrend. RSI cooling at ${rsi.toFixed(1)}. Wick rejection ${wickDown.toFixed(4)} detected.`, strategy: "Pullback Continuation", riskWarning: "Ensure higher timeframe trend is intact" };
  }
  // Bearish pullback: downtrend, price bounced to EMA20 zone, RSI rising, wick rejection from above
  if (e20 < e50 && Math.abs(price - e20) < pullbackZone && rsi >= 42 && rsi <= 60 && wickUp > body * 0.5) {
    const scored = ruleScore(ruleId("Pullback Continuation", "sell"), 62, 82, { rsi }, [{ label: "RSI above 42, x1.2", expr: "floor((rsi - 42) * 1.2)", value: Math.floor((rsi - 42) * 1.2) }]);
    return { symbol, direction: "SELL", ...scored, entryPrice: price, stopLoss: last.high + atr * 0.5, takeProfit: price - atr * 2.2, reason: `Bounce to EMA20 zone in downtrend. RSI elevated at ${rsi.toFixed(1)}. Wick rejection ${wickUp.toFixed(4)} detected.`, strategy: "Pullback Continuation", riskWarning: "Ensure higher timeframe downtrend is intact" };
  }
  return { symbol, direction: "WAIT", ...constantScore(ruleId("Pullback Continuation", "no_setup"), 20), entryPrice: price, stopLoss: 0, takeProfit: 0, reason: "No valid pullback setup detected", strategy: "Pullback Continuation", riskWarning: "" };
}

// ─── Strategy 6: Mean Reversion ───────────────────────────────────────────────

export function meanReversionStrategy(candles: Candle[], symbol: string): SignalOutput {
  return labeledAdvisory(meanReversionCore(candles, symbol));
}

function meanReversionCore(candles: Candle[], symbol: string): SignalOutput {
  if (candles.length < 20) {
    return { symbol, direction: "WAIT", ...constantScore(ruleId("Mean Reversion", "insufficient_data"), 0), entryPrice: candles[candles.length - 1]?.close ?? 0, stopLoss: 0, takeProfit: 0, reason: "Insufficient data", strategy: "Mean Reversion", riskWarning: "" };
  }
  const recent = candles.slice(-20);
  const closes = recent.map((c) => c.close);
  const price = closes[closes.length - 1];
  const rsi = computeRSI(closes, 14);
  const atr = computeATR(recent, 14);
  const avgRange = recent.reduce((a, c) => a + (c.high - c.low), 0) / recent.length;
  const highRange = Math.max(...closes) - Math.min(...closes);
  const last = recent[recent.length - 1];
  const wickDown = Math.min(last.open, last.close) - last.low;
  const wickUp = last.high - Math.max(last.open, last.close);
  const body = Math.abs(last.close - last.open);
  // Range condition: low directional movement
  const isRange = highRange < atr * 1.2 && atr < avgRange * 1.3;

  if (isRange && rsi < 28 && wickDown > body) {
    const scored = ruleScore(ruleId("Mean Reversion", "buy"), 60, 80, { rsi }, [{ label: "RSI below 30, x2", expr: "floor((30 - rsi) * 2)", value: Math.floor((30 - rsi) * 2) }]);
    const mid = (Math.max(...closes) + Math.min(...closes)) / 2;
    return { symbol, direction: "BUY", ...scored, entryPrice: price, stopLoss: last.low - atr * 0.3, takeProfit: mid, reason: `Range market. RSI oversold at ${rsi.toFixed(1)}. Wick rejection from range low. Target: range mid ${mid.toFixed(4)}.`, strategy: "Mean Reversion", riskWarning: "Range trades carry breakout risk" };
  }
  if (isRange && rsi > 72 && wickUp > body) {
    const scored = ruleScore(ruleId("Mean Reversion", "sell"), 60, 80, { rsi }, [{ label: "RSI above 70, x2", expr: "floor((rsi - 70) * 2)", value: Math.floor((rsi - 70) * 2) }]);
    const mid = (Math.max(...closes) + Math.min(...closes)) / 2;
    return { symbol, direction: "SELL", ...scored, entryPrice: price, stopLoss: last.high + atr * 0.3, takeProfit: mid, reason: `Range market. RSI overbought at ${rsi.toFixed(1)}. Wick rejection from range high. Target: range mid ${mid.toFixed(4)}.`, strategy: "Mean Reversion", riskWarning: "Range trades carry breakout risk" };
  }
  return { symbol, direction: "WAIT", ...constantScore(ruleId("Mean Reversion", "no_setup"), 10), entryPrice: price, stopLoss: 0, takeProfit: 0, reason: "No range extreme detected for mean reversion", strategy: "Mean Reversion", riskWarning: "" };
}

function sessionBreakoutScore(branch: "buy" | "sell", atr: number, avgATR: number) {
  return ruleScore(ruleId("Session Breakout", branch), 65, 85, { atr, avgATR }, [
    { label: "ATR expansion over its average, x30", expr: "floor((atr / avgATR - 1) * 30)", value: Math.floor((atr / avgATR - 1) * 30) },
  ]);
}

// ─── Strategy 7: Session Breakout ─────────────────────────────────────────────

export function sessionBreakoutStrategy(candles: Candle[], symbol: string): SignalOutput {
  return labeledAdvisory(sessionBreakoutCore(candles, symbol));
}

function sessionBreakoutCore(candles: Candle[], symbol: string): SignalOutput {
  if (candles.length < 20) {
    return { symbol, direction: "WAIT", ...constantScore(ruleId("Session Breakout", "insufficient_data"), 0), entryPrice: candles[candles.length - 1]?.close ?? 0, stopLoss: 0, takeProfit: 0, reason: "Insufficient data", strategy: "Session Breakout", riskWarning: "" };
  }
  // The session is the signal bar's own (its open time), not the wall clock,
  // so the rule reads the same on a replay as it did live and can be
  // calibrated on history. A bar with no parseable time falls back to now.
  const session = detectSession(barTimeOf(candles[candles.length - 1]));
  // Only active during London and NY opens
  if (session !== "London" && session !== "London/NY Overlap") {
    return { symbol, direction: "WAIT", ...constantScore(ruleId("Session Breakout", "inactive_session"), 0), entryPrice: candles[candles.length - 1].close, stopLoss: 0, takeProfit: 0, reason: `Session Breakout inactive during ${session} session`, strategy: "Session Breakout", riskWarning: "" };
  }
  const recent = candles.slice(-20);
  const asiaRange = candles.slice(-30, -10);
  if (asiaRange.length < 5) return { symbol, direction: "WAIT", ...constantScore(ruleId("Session Breakout", "insufficient_data"), 0), entryPrice: recent[recent.length - 1].close, stopLoss: 0, takeProfit: 0, reason: "Insufficient data for session range", strategy: "Session Breakout", riskWarning: "" };
  const asiaHigh = Math.max(...asiaRange.map((c) => c.high));
  const asiaLow = Math.min(...asiaRange.map((c) => c.low));
  const price = recent[recent.length - 1].close;
  const atr = computeATR(recent, 14);
  const avgATR = computeATR(candles.slice(-30, -10), 14);
  const isExpanding = atr > avgATR * 1.3;

  if (price > asiaHigh && isExpanding) {
    const scored = sessionBreakoutScore("buy", atr, avgATR);
    return { symbol, direction: "BUY", ...scored, entryPrice: price, stopLoss: asiaHigh - atr * 0.5, takeProfit: price + atr * 2.5, reason: `${session} session breakout above Asia range high ${asiaHigh.toFixed(4)}. ATR expanding.`, strategy: "Session Breakout", riskWarning: "News events may cause false breakout" };
  }
  if (price < asiaLow && isExpanding) {
    const scored = sessionBreakoutScore("sell", atr, avgATR);
    return { symbol, direction: "SELL", ...scored, entryPrice: price, stopLoss: asiaLow + atr * 0.5, takeProfit: price - atr * 2.5, reason: `${session} session breakout below Asia range low ${asiaLow.toFixed(4)}. ATR expanding.`, strategy: "Session Breakout", riskWarning: "News events may cause false breakout" };
  }
  return { symbol, direction: "WAIT", ...constantScore(ruleId("Session Breakout", "no_setup"), 15), entryPrice: price, stopLoss: 0, takeProfit: 0, reason: `${session} session — price inside Asia range, awaiting breakout`, strategy: "Session Breakout", riskWarning: "" };
}

// ─── Filter 1: No Trade Filter ────────────────────────────────────────────────

export function noTradeFilter(signal: SignalOutput, candles: Candle[], minScore: number): SignalOutput {
  if (candles.length < 10) return { ...signal, direction: "WAIT", reason: "Insufficient data for filter" };
  const recent = candles.slice(-10);
  const atr = computeATR(recent, 10);
  const avgRange = recent.reduce((a, c) => a + (c.high - c.low), 0) / recent.length;
  const closes = recent.map((c) => c.close);
  const rsi = computeRSI(closes, 7);
  const highRange = Math.max(...closes) - Math.min(...closes);
  const isSideways = highRange < atr * 0.8;
  if (isSideways) return { ...signal, direction: "WAIT", reason: "Market in sideways chop — no trade" };
  if (signal.score < minScore) return { ...signal, direction: "WAIT", reason: `Score ${signal.score} below minimum ${minScore} (uncalibrated heuristic score)` };
  if (atr > avgRange * 3) return { ...signal, direction: "WAIT", reason: "ATR too extreme — abnormal volatility" };
  if ((signal.direction === "BUY" && rsi > 80) || (signal.direction === "SELL" && rsi < 20)) {
    return { ...signal, direction: "WAIT", reason: "RSI in extreme zone — trade blocked by filter" };
  }
  return signal;
}

// ─── Filter 2: News Avoidance (forex/indices only) ────────────────────────────

export function newsAvoidanceFilter(signal: SignalOutput, marketType: string): SignalOutput {
  if (marketType === "synthetic") return signal; // No news filter for synthetics
  const utcHour = new Date().getUTCHours();
  const utcMin = new Date().getUTCMinutes();
  const timeDecimal = utcHour + utcMin / 60;
  // High-risk news windows (UTC): US CPI/PPI/NFP/FOMC typical times
  const newsWindows = [
    { start: 8.25, end: 8.75 },   // 08:15-08:45 ECB, Swiss data
    { start: 12.3, end: 13.0 },   // 12:30-13:00 US data (NFP, CPI)
    { start: 18.75, end: 19.25 }, // 18:45-19:15 FOMC decisions
  ];
  for (const w of newsWindows) {
    if (timeDecimal >= w.start && timeDecimal <= w.end) {
      return { ...signal, direction: "WAIT", reason: `News avoidance active (${utcHour}:${String(utcMin).padStart(2, "0")} UTC — high-impact window)`, riskWarning: "Major news event window — no new trades" };
    }
  }
  return signal;
}

// ─── Master scan function ─────────────────────────────────────────────────────

/** Fewer candles than this → runStrategyScan does not scan ("Insufficient candle data"). */
export const MIN_STRATEGY_SCAN_CANDLES = 5;

export function runStrategyScan(
  symbol: string,
  candles: Candle[],
  minScore = 65,
  marketType: "forex" | "indices" | "stocks" | "synthetic" = "synthetic",
  opts: { timeframe?: string } = {},
): SignalOutput {
  return labeledAdvisory(runStrategyScanCore(symbol, candles, minScore, marketType, opts.timeframe ?? ""), opts.timeframe ?? "");
}

function runStrategyScanCore(
  symbol: string,
  candles: Candle[],
  minScore: number,
  marketType: "forex" | "indices" | "stocks" | "synthetic",
  timeframe: string,
): SignalOutput {
  if (candles.length < MIN_STRATEGY_SCAN_CANDLES) {
    const price = candles[candles.length - 1]?.close ?? 0;
    return { symbol, marketType, direction: "WAIT", ...constantScore(ruleId("None", "insufficient_data"), 0), entryPrice: price, stopLoss: 0, takeProfit: 0, reason: "Insufficient candle data", strategy: "None", riskWarning: "", advisory: STRATEGY_ADVISORY_LABEL };
  }

  const session = detectSession();
  const marketCondition = computeMarketCondition(candles);
  const technicalBias = computeTechnicalBias(candles);

  const strategies = [
    trendContinuationStrategy(candles, symbol),
    breakOfStructureStrategy(candles, symbol),
    liquiditySweepStrategy(candles, symbol),
    volatilityExpansionStrategy(candles, symbol),
    pullbackContinuationStrategy(candles, symbol),
    meanReversionStrategy(candles, symbol),
    sessionBreakoutStrategy(candles, symbol),
  ];

  // Pick the best call by the three-tier measured ranking (lib/ranking):
  // calibrated probability (with N) first, then a measured base rate, and
  // only then the raw heuristic score, labelled "unmeasured, ranked by raw
  // score". Each strategy is calibrated on the scan's own timeframe.
  const actionable = rankByMeasuredTier(
    strategies
      .filter((s) => s.direction !== "WAIT")
      .map((s) => {
        const calibration = calibrate(strategyCalibrationKey(s.strategy), symbol, timeframe, s.score);
        return { ...s, calibration, calibratedProbability: calibration.probability, rawScore: s.score };
      }),
  ).map(({ rawScore: _r, rank: _k, rankValue: _v, rankN: _n, ...s }) => s as SignalOutput);
  const price = candles[candles.length - 1].close;

  if (actionable.length === 0) {
    return { symbol, marketType, direction: "WAIT", ...constantScore(ruleId("No Trade Filter", "no_setup"), 0), entryPrice: price, stopLoss: 0, takeProfit: 0, reason: "No actionable signal from any strategy", strategy: "No Trade Filter", riskWarning: "", session, marketCondition, technicalBias, advisory: STRATEGY_ADVISORY_LABEL };
  }

  let best = actionable[0];
  best = noTradeFilter(best, candles, minScore);
  best = newsAvoidanceFilter(best, marketType);

  // R7 step 7 — the advisory honesty label is re-stamped here so the scan
  // seam guarantees it even if a future strategy/filter path forgets to.
  return { ...best, marketType, session, marketCondition, technicalBias, advisory: STRATEGY_ADVISORY_LABEL };
}

// ─── Synthetic candle generator ───────────────────────────────────────────────

const BASE_PRICES: Record<string, number> = {
  // Synthetics
  "Volatility 75 Index": 8000, "Volatility 75 1s Index": 8000, "Volatility 25 1s Index": 500,
  // Forex majors
  "EURUSD": 1.0850, "GBPUSD": 1.2720, "USDJPY": 149.50, "USDCHF": 0.8980,
  "USDCAD": 1.3580, "AUDUSD": 0.6540, "NZDUSD": 0.5980,
  // Forex minors
  "EURJPY": 162.30, "GBPJPY": 190.20, "EURGBP": 0.8520,
  "AUDJPY": 97.80, "CADJPY": 110.20, "CHFJPY": 166.40,
  "EURCAD": 1.4730, "GBPCAD": 1.7320, "EURCHF": 0.9720,
  // Indices
  "US30": 39200, "NAS100": 18150, "SPX500": 5230,
  "GER40": 18400, "UK100": 8280, "JP225": 38900,
  // Stocks
  "AAPL": 189.50, "TSLA": 178.30, "MSFT": 415.20,
  "NVDA": 875.40, "AMZN": 192.30, "GOOGL": 170.50,
  "META": 510.20, "JPM": 198.40, "NFLX": 640.20, "BABA": 79.40,
};

const VOLATILITIES: Record<string, number> = {
  "Volatility 75 Index": 0.008, "Volatility 75 1s Index": 0.012, "Volatility 25 1s Index": 0.005,
  "EURUSD": 0.0006, "GBPUSD": 0.0007, "USDJPY": 0.0007,
  "USDCHF": 0.0006, "USDCAD": 0.0006, "AUDUSD": 0.0006, "NZDUSD": 0.0006,
  "EURJPY": 0.0008, "GBPJPY": 0.0009, "EURGBP": 0.0005,
  "AUDJPY": 0.0007, "CADJPY": 0.0007, "CHFJPY": 0.0008,
  "EURCAD": 0.0007, "GBPCAD": 0.0008, "EURCHF": 0.0005,
  "US30": 0.003, "NAS100": 0.004, "SPX500": 0.003,
  "GER40": 0.004, "UK100": 0.003, "JP225": 0.004,
  "AAPL": 0.008, "TSLA": 0.018, "MSFT": 0.007,
  "NVDA": 0.020, "AMZN": 0.009, "GOOGL": 0.008,
  "META": 0.012, "JPM": 0.007, "NFLX": 0.015, "BABA": 0.016,
};

/** Explicit opt-in for the production synthetic fence below. */
export interface SyntheticCandleOptions {
  /** Pass true ONLY from legitimately-synthetic contexts (backtest fixtures,
   *  replay scenarios, shadow simulation, an explicitly SYNTHETIC-labeled
   *  provider). Never from a decision/display path claiming real data. */
  allowSynthetic?: boolean;
}

export const SYNTHETIC_CANDLES_FENCE_MESSAGE =
  "SYNTHETIC_CANDLES_BLOCKED: generateSyntheticCandles is fenced in production. " +
  "Fabricated OHLC must never feed a production analysis/decision path; pass " +
  "{ allowSynthetic: true } only from an explicitly synthetic context " +
  "(backtest/replay/shadow or a SYNTHETIC-labeled provider).";

export function generateSyntheticCandles(
  symbol: string,
  count = 250,
  opts?: SyntheticCandleOptions,
): Candle[] {
  // R7 step 1e — production fence. Refuse unless the caller explicitly opted
  // into synthetic data. Read at call time (not module init) so tests and
  // long-lived processes observe NODE_ENV changes deterministically.
  if (process.env.NODE_ENV === "production" && opts?.allowSynthetic !== true) {
    throw new Error(SYNTHETIC_CANDLES_FENCE_MESSAGE);
  }
  let price = BASE_PRICES[symbol] ?? 1.0;
  const vol = VOLATILITIES[symbol] ?? 0.008;
  const candles: Candle[] = [];
  const now = Date.now();

  for (let i = count; i >= 0; i--) {
    const open = price;
    const change = (Math.random() - 0.48) * price * vol;
    const close = Math.max(price + change, price * 0.9);
    const high = Math.max(open, close) + Math.random() * price * vol * 0.5;
    const low = Math.min(open, close) - Math.random() * price * vol * 0.5;
    const volume = Math.floor(Math.random() * 500 + 100);
    candles.push({ time: new Date(now - i * 60000).toISOString(), open, high, low, close, volume });
    price = close;
  }
  return candles;
}

export function getMarketTypeForSymbol(symbol: string): "forex" | "indices" | "stocks" | "synthetic" {
  const forexPairs = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD", "EURJPY", "GBPJPY", "EURGBP", "AUDJPY", "CADJPY", "CHFJPY", "EURCAD", "GBPCAD", "EURCHF"];
  const indices = ["US30", "NAS100", "SPX500", "GER40", "UK100", "JP225"];
  const synthetics = ["Volatility 75 Index", "Volatility 75 1s Index", "Volatility 25 1s Index"];
  if (synthetics.includes(symbol)) return "synthetic";
  if (indices.includes(symbol)) return "indices";
  if (forexPairs.includes(symbol)) return "forex";
  return "stocks";
}
