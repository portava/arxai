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
import { resolveArxMarket } from "@workspace/domain/market";

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

/**
 * The strategy DISPLAY names the engine can actually emit, derived from the
 * engine itself rather than hand-written. Every strategy core returns its own
 * `strategy` name on its insufficient-data early return, so calling each with
 * an empty candle array yields the exact name that later appears on a decision
 * row. Deriving it here means a tournament / promotion universe can never
 * drift from the set of strategies that can produce a decision.
 */
export const ENGINE_STRATEGY_NAMES: string[] = (
  Object.keys(STRATEGY_REGISTRY) as StrategyId[]
).map((id) => STRATEGY_REGISTRY[id]([], id).strategy);

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

// ── Synthetic price models (Task: synthetic-honesty fix) ────────────────────
//
// WHAT THESE ARE: nominal SCALE ANCHORS for the fabricated candle generator —
// the order of magnitude and typical per-bar movement of each instrument, so a
// fabricated series at least sits in the right numeric range. They are NOT
// market prices, NOT quotes, and NOT history. Every candle built from them is
// invented and must be labelled synthetic wherever it is displayed.
//
// KEYED BY canonicalSymbol. The previous table was keyed by DISPLAY names
// ("Volatility 75 Index") while every caller passes the ARX canonicalSymbol
// ("V75"), so ~22 of the 44 approved markets silently fell through to a
// `?? 1.0` default and produced a series starting at 1.0000 for Gold, V75,
// BTCUSD and friends. There is no default any more: an unmodelled symbol is a
// refusal (NoSyntheticPriceModelError), never a fabricated 1.0000 series.
type SyntheticPriceModel = { basePrice: number; volatility: number };

const SYNTHETIC_PRICE_MODELS: Record<string, SyntheticPriceModel> = {
  // Synthetic indices (Deriv). Scale anchors only.
  V75:       { basePrice: 8000,  volatility: 0.008 },
  V75_1S:    { basePrice: 8000,  volatility: 0.012 },
  V100:      { basePrice: 1200,  volatility: 0.010 },
  V50:       { basePrice: 250,   volatility: 0.006 },
  V50_1S:    { basePrice: 250,   volatility: 0.009 },
  V25_1S:    { basePrice: 500,   volatility: 0.005 },
  V10:       { basePrice: 6000,  volatility: 0.003 },
  BOOM1000:  { basePrice: 9500,  volatility: 0.006 },
  CRASH1000: { basePrice: 8800,  volatility: 0.006 },
  BOOM500:   { basePrice: 9800,  volatility: 0.008 },
  CRASH500:  { basePrice: 9200,  volatility: 0.008 },
  BOOM300:   { basePrice: 9400,  volatility: 0.010 },
  CRASH300:  { basePrice: 9100,  volatility: 0.010 },
  JUMP10:    { basePrice: 9800,  volatility: 0.004 },
  JUMP25:    { basePrice: 3200,  volatility: 0.006 },
  JUMP50:    { basePrice: 21000, volatility: 0.008 },
  JUMP75:    { basePrice: 9500,  volatility: 0.010 },
  JUMP100:   { basePrice: 6500,  volatility: 0.012 },
  // Forex majors.
  EURUSD: { basePrice: 1.0850, volatility: 0.0006 },
  GBPUSD: { basePrice: 1.2720, volatility: 0.0007 },
  USDJPY: { basePrice: 149.50, volatility: 0.0007 },
  USDCHF: { basePrice: 0.8980, volatility: 0.0006 },
  USDCAD: { basePrice: 1.3580, volatility: 0.0006 },
  AUDUSD: { basePrice: 0.6540, volatility: 0.0006 },
  NZDUSD: { basePrice: 0.5980, volatility: 0.0006 },
  // Forex minors.
  EURJPY: { basePrice: 162.30, volatility: 0.0008 },
  EURGBP: { basePrice: 0.8520, volatility: 0.0005 },
  EURAUD: { basePrice: 1.6320, volatility: 0.0007 },
  EURCAD: { basePrice: 1.4730, volatility: 0.0007 },
  GBPJPY: { basePrice: 190.20, volatility: 0.0009 },
  GBPAUD: { basePrice: 1.9150, volatility: 0.0009 },
  GBPCAD: { basePrice: 1.7320, volatility: 0.0008 },
  AUDJPY: { basePrice: 97.80,  volatility: 0.0007 },
  CADJPY: { basePrice: 110.20, volatility: 0.0007 },
  CHFJPY: { basePrice: 166.40, volatility: 0.0008 },
  // Metals.
  XAUUSD: { basePrice: 2380.0, volatility: 0.006 },
  XAGUSD: { basePrice: 28.50,  volatility: 0.012 },
  // Indices.
  DXY:    { basePrice: 104.50, volatility: 0.002 },
  SPX500: { basePrice: 5230,   volatility: 0.003 },
  GER30:  { basePrice: 18400,  volatility: 0.004 },
  US30:   { basePrice: 39200,  volatility: 0.003 },
  // Crypto.
  BTCUSD: { basePrice: 68500,  volatility: 0.020 },
  ETHUSD: { basePrice: 3450,   volatility: 0.024 },
};

/** Thrown instead of fabricating a 1.0000 series for an unmodelled symbol. */
export class NoSyntheticPriceModelError extends Error {
  readonly code = "NO_SYNTHETIC_PRICE_MODEL";
  readonly requestedSymbol: string;
  constructor(requestedSymbol: string) {
    super(
      `No synthetic price model for "${requestedSymbol}" — refusing to fabricate ` +
      `a candle series for an instrument whose scale is unknown.`,
    );
    this.name = "NoSyntheticPriceModelError";
    this.requestedSymbol = requestedSymbol;
  }
}

/**
 * Resolve a free-text / canonical / broker symbol to its synthetic scale model,
 * or null when there is none. Resolution goes through the ARX Focus registry so
 * "Volatility 75 Index", "gold" and "V75" all land on the canonical key.
 */
export function resolveSyntheticPriceModel(
  symbol: string,
): (SyntheticPriceModel & { canonicalSymbol: string }) | null {
  const canonical = resolveArxMarket(symbol)?.canonicalSymbol ?? symbol.toUpperCase();
  const model = SYNTHETIC_PRICE_MODELS[canonical];
  return model ? { ...model, canonicalSymbol: canonical } : null;
}

/** Canonical symbols that have a synthetic scale model (test/coverage helper). */
export function modelledSyntheticSymbols(): string[] {
  return Object.keys(SYNTHETIC_PRICE_MODELS);
}

// Deterministic candle stream. Identical (symbol, count, timeframe, seed,
// baseTimeMs) inputs always produce the identical output. No clock reads.
//
// THROWS NoSyntheticPriceModelError for a symbol with no scale model — a
// fabricated series is already weak evidence; a fabricated series at a
// fabricated scale is a lie about the instrument.
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
  const model = resolveSyntheticPriceModel(symbol);
  if (!model) throw new NoSyntheticPriceModelError(symbol);
  let price = model.basePrice;
  const vol = model.volatility;
  // Larger timeframes ⇒ more intra-bar movement. Scale linearly with sqrt(steps),
  // capped to avoid runaway prices on D1.
  const tfScale = Math.min(4, Math.sqrt(stepMs / TF_MS["M1"]!));
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const open = price;
    // ZERO-MEAN step. The old `(rng() - 0.48)` subtracted 0.48 from a U[0,1)
    // draw, baking a persistent +0.02·price·vol drift into every bar — long-
    // biased strategies trended profitable on fabricated data by construction.
    // A driftless random walk is still not evidence, but it no longer rigs the
    // result in the direction the surface then reports as an edge.
    const change = (rng() - 0.5) * price * vol * tfScale;
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
