// (P) Build P fix — strategy registry + deterministic candle generator.
//
// Architect findings addressed:
//   1. strategyId is now mapped to a SINGLE strategy function (no
//      multi-strategy compositing). Unknown IDs are rejected.
//   2. Deterministic backtests via seeded mulberry32 RNG + base timestamp.
//      No Math.random / Date.now leak into the candle stream.
//   3. timeframe controls bar spacing (M1=1m, M5=5m, M15=15m, H1=1h, H4=4h,
//      D1=1d).
//
// SAFETY: pure helpers. No db/network/wall-clock dependencies. The route
// composes these with the pure domain simulator.

import {
  trendContinuationStrategy, breakOfStructureStrategy, liquiditySweepStrategy,
  volatilityExpansionStrategy, pullbackContinuationStrategy, meanReversionStrategy,
  sessionBreakoutStrategy, noTradeFilter,
  type Candle, type SignalOutput,
} from "./strategyEngine.js";

export type StrategyId =
  | "trendContinuation" | "breakOfStructure" | "liquiditySweep"
  | "volatilityExpansion" | "pullbackContinuation" | "meanReversion"
  | "sessionBreakout";

export const STRATEGY_REGISTRY: Record<StrategyId, (c: Candle[], s: string) => SignalOutput> = {
  trendContinuation: trendContinuationStrategy,
  breakOfStructure: breakOfStructureStrategy,
  liquiditySweep: liquiditySweepStrategy,
  volatilityExpansion: volatilityExpansionStrategy,
  pullbackContinuation: pullbackContinuationStrategy,
  meanReversion: meanReversionStrategy,
  sessionBreakout: sessionBreakoutStrategy,
};

export function isKnownStrategyId(id: string): id is StrategyId {
  return id in STRATEGY_REGISTRY;
}

export function runSingleStrategy(
  strategyId: StrategyId,
  symbol: string,
  candles: Candle[],
  minConfidence: number,
): SignalOutput {
  const fn = STRATEGY_REGISTRY[strategyId];
  const raw = fn(candles, symbol);
  // Apply only the candle-based no-trade filter. We deliberately skip
  // newsAvoidanceFilter here because that filter reads wall-clock UTC time,
  // which would make backtests non-deterministic and unrelated to the
  // simulated candle period. News-window backtesting is a separate build.
  return noTradeFilter(raw, candles, minConfidence);
}

// Bar spacing in milliseconds keyed by timeframe.
const TF_MS: Record<string, number> = {
  M1: 60_000, M5: 5 * 60_000, M15: 15 * 60_000,
  H1: 60 * 60_000, H4: 4 * 60 * 60_000, D1: 24 * 60 * 60_000,
};
export function timeframeMs(tf: string): number {
  return TF_MS[tf] ?? TF_MS["M1"]!;
}

// ── Seeded RNG (mulberry32) — deterministic, fast, well-distributed ────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const BASE_PRICES: Record<string, number> = {
  "Volatility 75 Index": 8000, "Volatility 75 1s Index": 8000, "Volatility 25 1s Index": 500,
  "EURUSD": 1.0850, "GBPUSD": 1.2720, "USDJPY": 149.50, "USDCHF": 0.8980,
  "USDCAD": 1.3580, "AUDUSD": 0.6540, "NZDUSD": 0.5980,
  "EURJPY": 162.30, "GBPJPY": 190.20, "EURGBP": 0.8520,
  "AUDJPY": 97.80, "CADJPY": 110.20, "CHFJPY": 166.40,
  "EURCAD": 1.4730, "GBPCAD": 1.7320, "EURCHF": 0.9720,
  "US30": 39200, "NAS100": 18150, "SPX500": 5230,
  "GER40": 18400, "UK100": 8280, "JP225": 38900,
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

// Deterministic candle stream. Identical (symbol, count, timeframe, seed,
// baseTimeMs) inputs always produce the identical output. No clock reads.
export function generateDeterministicCandles(opts: {
  symbol: string;
  count: number;
  timeframe: string;
  seed: string;             // free-form string seeded into mulberry32
  baseTimeMs?: number;      // anchor; default = fixed 2024-01-01 UTC
}): Candle[] {
  const { symbol, count, timeframe } = opts;
  // Default anchor is a stable past instant — explicitly NOT Date.now().
  const baseTimeMs = opts.baseTimeMs ?? Date.UTC(2024, 0, 1, 0, 0, 0);
  const stepMs = timeframeMs(timeframe);
  const rng = mulberry32(hashSeed(`${opts.seed}|${symbol}|${count}|${timeframe}`));
  let price = BASE_PRICES[symbol] ?? 1.0;
  const vol = VOLATILITIES[symbol] ?? 0.008;
  // Larger timeframes ⇒ more intra-bar movement. Scale linearly with sqrt(steps),
  // capped to avoid runaway prices on D1.
  const tfScale = Math.min(4, Math.sqrt(stepMs / TF_MS["M1"]!));
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const open = price;
    const change = (rng() - 0.48) * price * vol * tfScale;
    const close = Math.max(open + change, price * 0.9);
    const high = Math.max(open, close) + rng() * price * vol * tfScale * 0.5;
    const low  = Math.min(open, close) - rng() * price * vol * tfScale * 0.5;
    const volume = Math.floor(rng() * 500 + 100);
    candles.push({
      time: new Date(baseTimeMs + i * stepMs).toISOString(),
      open, high, low, close, volume,
    });
    price = close;
  }
  return candles;
}
