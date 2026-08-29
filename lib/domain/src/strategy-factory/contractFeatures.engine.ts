import type { StrategyInput, StrategyProposedSignal } from "../strategies/strategy.types";
import type { Candle } from "../market/marketRegime.engine";
import type { FeatureId, FeatureScalar, FeatureValue, InputFeatureId, SignalFeatureId } from "./strategyContract.types";
import { INPUT_FEATURE_IDS, SIGNAL_FEATURE_IDS } from "./strategyContract.types";

// ═══════════════════════════════════════════════════════════════════════════
// Contract feature library — the closed vocabulary contract rules speak.
//
// Every feature is recomputed HERE, independently of the hand-written
// strategy engines. That independence is deliberate: the replay-equivalence
// check compares two implementations of the same trading idea (this library
// driven by contract data vs. the strategy's own code). A drift in either
// shows up as a loud mismatch.
//
// A feature that cannot be computed returns { ok: false, reason } — never a
// fabricated value. null is reserved for "computed, and the answer is
// absent" (e.g. no breakout has happened yet).
// ═══════════════════════════════════════════════════════════════════════════

function ok(value: FeatureScalar): FeatureValue {
  return { ok: true, value };
}
function unknown(reason: string): FeatureValue {
  return { ok: false, reason };
}

// UTC 00:00–07:00 of the day containing `now` — the london-breakout
// strategy's own definition of the Asia range (NOT the session engine's
// 23:00–08:00 window; the contract pins the strategy's actual behavior).
function asiaBounds(now: Date): { start: number; end: number } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7);
  return { start, end };
}

function asiaCandles(input: StrategyInput): Candle[] {
  const { start, end } = asiaBounds(input.now);
  return input.candles.filter((c) => c.time >= start && c.time < end);
}

function postAsiaCandles(input: StrategyInput): Candle[] {
  const { end } = asiaBounds(input.now);
  return input.candles.filter((c) => c.time >= end);
}

function asiaRange(input: StrategyInput): { high: number; low: number } | null {
  const a = asiaCandles(input);
  if (a.length === 0) return null;
  return { high: Math.max(...a.map((c) => c.high)), low: Math.min(...a.map((c) => c.low)) };
}

function sma(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeInputFeature(id: InputFeatureId, input: StrategyInput): FeatureValue {
  const n = input.candles.length;
  const last = n >= 1 ? input.candles[n - 1] : null;
  const prev = n >= 2 ? input.candles[n - 2] : null;

  switch (id) {
    case "candleCount": return ok(n);
    case "session": return ok(input.session.session);
    case "regime": return ok(input.regime.regime);
    case "regimeConfidence": return ok(input.regime.confidence);
    case "volatilityState": return ok(input.volatility.state);
    case "atr": return ok(input.volatility.atr);
    case "lastClose": return last ? ok(last.close) : unknown("NO_CANDLES");
    case "lastOpen": return last ? ok(last.open) : unknown("NO_CANDLES");
    case "prevLow": return prev ? ok(prev.low) : unknown("FEWER_THAN_2_CANDLES");
    case "prevHigh": return prev ? ok(prev.high) : unknown("FEWER_THAN_2_CANDLES");
    case "sma20":
      if (n < 20) return unknown("FEWER_THAN_20_CANDLES");
      return ok(sma(input.candles.slice(-20).map((c) => c.close)));

    case "asiaCandleCount": return ok(asiaCandles(input).length);
    case "asiaRangeHigh": {
      const r = asiaRange(input);
      return r ? ok(r.high) : unknown("NO_ASIA_CANDLES");
    }
    case "asiaRangeLow": {
      const r = asiaRange(input);
      return r ? ok(r.low) : unknown("NO_ASIA_CANDLES");
    }
    case "asiaRangeSize": {
      const r = asiaRange(input);
      return r ? ok(r.high - r.low) : unknown("NO_ASIA_CANDLES");
    }
    case "postAsiaCandleCount": return ok(postAsiaCandles(input).length);
    case "postAsiaBreakDirection": {
      const r = asiaRange(input);
      if (!r) return unknown("NO_ASIA_CANDLES");
      if (r.high - r.low <= 0) return unknown("DEGENERATE_ASIA_RANGE");
      for (const c of postAsiaCandles(input)) {
        if (c.close > r.high) return ok("BUY");
        if (c.close < r.low) return ok("SELL");
      }
      return ok(null); // computed: no breakout yet
    }

    case "trendDirection": {
      if (input.regime.regime === "TRENDING_UP") return ok("BUY");
      if (input.regime.regime === "TRENDING_DOWN") return ok("SELL");
      return ok(null); // computed: not trending
    }
    case "pullbackThroughSma20": {
      if (n < 20) return unknown("FEWER_THAN_20_CANDLES");
      if (!prev || !last) return unknown("FEWER_THAN_2_CANDLES");
      const dir = input.regime.regime === "TRENDING_UP" ? "BUY"
                : input.regime.regime === "TRENDING_DOWN" ? "SELL" : null;
      if (dir === null) return unknown("NOT_TRENDING");
      const m = sma(input.candles.slice(-20).map((c) => c.close));
      const pulled = dir === "BUY"
        ? prev.low <= m && last.close > m
        : prev.high >= m && last.close < m;
      return ok(pulled);
    }
    case "confirmationCandleTrendSide": {
      if (!last) return unknown("NO_CANDLES");
      const dir = input.regime.regime === "TRENDING_UP" ? "BUY"
                : input.regime.regime === "TRENDING_DOWN" ? "SELL" : null;
      if (dir === null) return unknown("NOT_TRENDING");
      return ok(dir === "BUY" ? last.close > last.open : last.close < last.open);
    }
  }
}

export function computeSignalFeature(
  id: SignalFeatureId,
  input: StrategyInput,
  signal: StrategyProposedSignal,
): FeatureValue {
  const dir = signal.direction;
  const entry = signal.entry;
  const stop = signal.stopLoss;
  const tp = signal.takeProfit;

  switch (id) {
    case "signalAction": return ok(signal.action);
    case "signalDirection": return ok(dir);
    case "signalConfidence": return ok(signal.confidence);
    case "signalEntry": return entry === null ? unknown("NO_ENTRY_ON_SIGNAL") : ok(entry);
    case "signalStop": return stop === null ? unknown("NO_STOP_ON_SIGNAL") : ok(stop);
    case "signalTakeProfit": return tp === null ? unknown("NO_TP_ON_SIGNAL") : ok(tp);
    case "stopDistance":
      if (entry === null || stop === null) return unknown("ENTRY_OR_STOP_MISSING");
      return ok(Math.abs(entry - stop));
    case "tpDistance":
      if (entry === null || tp === null) return unknown("ENTRY_OR_TP_MISSING");
      return ok(Math.abs(tp - entry));
    case "rewardRiskRatio": {
      if (entry === null || stop === null || tp === null) return unknown("ENTRY_STOP_OR_TP_MISSING");
      const risk = Math.abs(entry - stop);
      if (risk <= 0) return unknown("ZERO_STOP_DISTANCE");
      return ok(Math.abs(tp - entry) / risk);
    }
    case "stopOnLossSide":
      if (entry === null || stop === null || dir === null) return unknown("ENTRY_STOP_OR_DIRECTION_MISSING");
      return ok(dir === "BUY" ? stop < entry : stop > entry);
    case "tpOnProfitSide":
      if (entry === null || tp === null || dir === null) return unknown("ENTRY_TP_OR_DIRECTION_MISSING");
      return ok(dir === "BUY" ? tp > entry : tp < entry);
    case "stopBeyondAsiaRange": {
      if (stop === null || dir === null) return unknown("STOP_OR_DIRECTION_MISSING");
      const r = asiaRange(input);
      if (!r) return unknown("NO_ASIA_CANDLES");
      return ok(dir === "BUY" ? stop < r.low : stop > r.high);
    }
    case "tpDistanceVsAsiaRange": {
      if (entry === null || tp === null) return unknown("ENTRY_OR_TP_MISSING");
      const r = asiaRange(input);
      if (!r) return unknown("NO_ASIA_CANDLES");
      const size = r.high - r.low;
      if (size <= 0) return unknown("DEGENERATE_ASIA_RANGE");
      return ok(Math.abs(tp - entry) / size);
    }
    case "stopDistanceVsAtr": {
      if (entry === null || stop === null) return unknown("ENTRY_OR_STOP_MISSING");
      if (input.volatility.atr <= 0) return unknown("ATR_UNAVAILABLE");
      return ok(Math.abs(entry - stop) / input.volatility.atr);
    }
  }
}

const INPUT_FEATURE_SET: ReadonlySet<string> = new Set(INPUT_FEATURE_IDS);
const SIGNAL_FEATURE_SET: ReadonlySet<string> = new Set(SIGNAL_FEATURE_IDS);

export function isInputFeature(id: FeatureId): id is InputFeatureId {
  return INPUT_FEATURE_SET.has(id);
}
export function isSignalFeature(id: FeatureId): id is SignalFeatureId {
  return SIGNAL_FEATURE_SET.has(id);
}

// Unified read used by the rule evaluator. Signal features without an
// emitted signal are UNKNOWN (fail closed), never fabricated.
export function readFeature(
  id: FeatureId,
  input: StrategyInput,
  signal: StrategyProposedSignal | null,
): FeatureValue {
  if (isInputFeature(id)) return computeInputFeature(id, input);
  if (signal === null) return { ok: false, reason: "SIGNAL_FEATURE_WITHOUT_SIGNAL" };
  return computeSignalFeature(id, input, signal);
}
