// ── Pattern Sync engine (Task #752, admin-cockpit-only) ─────────────────────
//
// Single-symbol structural pattern analyzer for synthetic indices. PURE +
// DETERMINISTIC: identical candle input always yields identical output. It
// reads candles and (optional) admin-provided / computed support-resistance and
// returns a structural read with 0–100 scores plus honest, risk-only prose.
//
// SAFETY (inviolable):
// - This is an ADVISORY ANALYSIS layer ONLY. Nothing here places, sizes, arms,
//   or gates a trade. It is consumed exclusively by the admin Pattern Sync
//   Command Center inside the Admin Cockpit. It NEVER feeds the 18-gate live
//   pipeline, the kill switch, risk limits, or any execution path.
// - Honest-empty: on insufficient candle history it returns `sufficient:false`
//   with neutral scores and an explicit summary — it never fabricates a read.
// - No profit/guaranteed language. Risk language only.

export interface PatternSyncCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type PatternSyncType =
  | "bullish_reversal_into_continuation"
  | "bearish_reversal_into_continuation"
  | "bullish_pullback"
  | "bearish_pullback"
  | "breakout_continuation"
  | "failed_breakout"
  | "range_chop"
  | "base_building"
  | "exhaustion_top"
  | "exhaustion_bottom"
  | "unclear";

export type PatternSyncBias = "bullish" | "bearish" | "ranging";
export type SupportHoldStatus = "holding" | "broken" | "untested" | "unknown";
export type ResistanceBreakStatus = "broken" | "rejected" | "untested" | "unknown";
export type TradeAlignment = "aligned" | "countertrend" | "unclear";
export type DangerLevel = "low" | "medium" | "high";

export interface PatternSyncLevels {
  nearestSupport: number | null;
  nearestResistance: number | null;
  breakoutLevel: number | null;
  invalidationLevel: number | null;
  continuationTrigger: number | null;
  pullbackDangerZone: number | null;
}

export interface PatternSyncTradeContext {
  tradeDirectionAlignment: TradeAlignment;
  dangerLevel: DangerLevel;
  invalidationLevel: number | null;
  firstTargetZone: number | null;
  saferActionSummary: string;
}

export interface PatternSyncOpenTrade {
  side: "BUY" | "SELL";
  entryPrice: number;
}

export interface PatternSyncEngineInput {
  symbol: string;
  timeframe: string;
  candles: PatternSyncCandle[];
  supportLevels?: number[];
  resistanceLevels?: number[];
  openTrades?: PatternSyncOpenTrade[];
}

export interface PatternSyncEngineResult {
  symbol: string;
  timeframe: string;
  sufficient: boolean;
  detectedPatternType: PatternSyncType;
  trendBias: PatternSyncBias;
  structureScore: number;
  momentumScore: number;
  pullbackScore: number;
  continuationScore: number;
  fakeoutRiskScore: number;
  choppinessScore: number;
  cleanSetupScore: number;
  supportHoldStatus: SupportHoldStatus;
  resistanceBreakStatus: ResistanceBreakStatus;
  confidenceScore: number;
  levels: PatternSyncLevels;
  lastClose: number | null;
  tradeContext: PatternSyncTradeContext | null;
  readableSummary: string;
  // Compact, comparable structural fingerprint used by the comparator.
  signature: {
    bias: PatternSyncBias;
    extension: number; // 0..1 how far price sits from the trend origin toward the extreme
    swingPattern: "HH_HL" | "LH_LL" | "MIXED";
    momentumDir: -1 | 0 | 1;
  };
}

// Minimum bars required for an honest structural read.
export const PATTERN_SYNC_MIN_CANDLES = 20;

function clamp(n: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round0(n: number): number {
  return Math.round(n);
}

function sma(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Average True Range over the candle window.
function atr(candles: PatternSyncCandle[]): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    );
    trs.push(tr);
  }
  return sma(trs);
}

// Efficiency ratio: |net move| / sum(|bar-to-bar move|). 1 = perfectly trending,
// near 0 = pure chop. Drives choppiness.
function efficiencyRatio(closes: number[]): number {
  if (closes.length < 2) return 0;
  const net = Math.abs(closes[closes.length - 1]! - closes[0]!);
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i]! - closes[i - 1]!);
  if (path === 0) return 0;
  return net / path;
}

// Detect swing-pivot highs/lows with a fixed half-window. Pivots are detected on
// CLOSES (robust against equal-wick ties that adjacent candles can share); the
// returned level is the candle's high (for a pivot high) / low (for a pivot low).
function swings(candles: PatternSyncCandle[], half = 2): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = half; i < candles.length - half; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - half; j <= i + half; j++) {
      if (j === i) continue;
      if (candles[j]!.close >= candles[i]!.close) isHigh = false;
      if (candles[j]!.close <= candles[i]!.close) isLow = false;
    }
    if (isHigh) highs.push(candles[i]!.high);
    if (isLow) lows.push(candles[i]!.low);
  }
  return { highs, lows };
}

function isAscending(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) if (values[i]! <= values[i - 1]!) return false;
  return true;
}
function isDescending(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) if (values[i]! >= values[i - 1]!) return false;
  return true;
}

function honestEmpty(input: PatternSyncEngineInput): PatternSyncEngineResult {
  const lastClose = input.candles.length > 0 ? input.candles[input.candles.length - 1]!.close : null;
  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    sufficient: false,
    detectedPatternType: "unclear",
    trendBias: "ranging",
    structureScore: 0,
    momentumScore: 0,
    pullbackScore: 0,
    continuationScore: 0,
    fakeoutRiskScore: 0,
    choppinessScore: 0,
    cleanSetupScore: 0,
    supportHoldStatus: "unknown",
    resistanceBreakStatus: "unknown",
    confidenceScore: 0,
    levels: {
      nearestSupport: null,
      nearestResistance: null,
      breakoutLevel: null,
      invalidationLevel: null,
      continuationTrigger: null,
      pullbackDangerZone: null,
    },
    lastClose,
    tradeContext: null,
    readableSummary: `Insufficient candle history for ${input.symbol} on ${input.timeframe} — a structural read needs at least ${PATTERN_SYNC_MIN_CANDLES} candles. No pattern is asserted.`,
    signature: { bias: "ranging", extension: 0, swingPattern: "MIXED", momentumDir: 0 },
  };
}

export function runPatternSyncEngine(input: PatternSyncEngineInput): PatternSyncEngineResult {
  const candles = input.candles;
  if (!Array.isArray(candles) || candles.length < PATTERN_SYNC_MIN_CANDLES) {
    return honestEmpty(input);
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const lastClose = closes[closes.length - 1]!;
  const windowAtr = atr(candles) || 1e-9;

  const windowHigh = Math.max(...highs);
  const windowLow = Math.min(...lows);
  const range = Math.max(windowHigh - windowLow, 1e-9);

  // ── Trend bias from first-half vs second-half mean, normalised by ATR. ────
  const halfIdx = Math.floor(closes.length / 2);
  const firstMean = sma(closes.slice(0, halfIdx));
  const secondMean = sma(closes.slice(halfIdx));
  const drift = (secondMean - firstMean) / windowAtr;
  let trendBias: PatternSyncBias;
  if (drift > 0.6) trendBias = "bullish";
  else if (drift < -0.6) trendBias = "bearish";
  else trendBias = "ranging";

  // ── Choppiness (inverse of efficiency ratio). ────────────────────────────
  const eff = efficiencyRatio(closes);
  const choppinessScore = clamp((1 - eff) * 100);

  // ── Swing structure. ─────────────────────────────────────────────────────
  const { highs: swingHighs, lows: swingLows } = swings(candles);
  const recentSwingHighs = swingHighs.slice(-3);
  const recentSwingLows = swingLows.slice(-3);
  let swingPattern: "HH_HL" | "LH_LL" | "MIXED" = "MIXED";
  if (recentSwingHighs.length >= 2 && recentSwingLows.length >= 2 &&
      isAscending(recentSwingHighs) && isAscending(recentSwingLows)) {
    swingPattern = "HH_HL";
  } else if (recentSwingHighs.length >= 2 && recentSwingLows.length >= 2 &&
      isDescending(recentSwingHighs) && isDescending(recentSwingLows)) {
    swingPattern = "LH_LL";
  }

  // Structure score: clean directional swing structure aligned with bias.
  let structureScore = 30;
  if (trendBias === "bullish" && swingPattern === "HH_HL") structureScore = 85;
  else if (trendBias === "bearish" && swingPattern === "LH_LL") structureScore = 85;
  else if (swingPattern === "MIXED") structureScore = 35;
  else structureScore = 55;
  structureScore = clamp(structureScore - choppinessScore * 0.2);

  // ── Momentum: last-third rate of change normalised by ATR. ────────────────
  const third = Math.max(2, Math.floor(closes.length / 3));
  const momRaw = (lastClose - closes[closes.length - third]!) / windowAtr;
  const momentumDir: -1 | 0 | 1 = momRaw > 0.3 ? 1 : momRaw < -0.3 ? -1 : 0;
  const momentumScore = clamp(50 + momRaw * 18);

  // ── Position within range (extension toward the extreme of the bias). ─────
  const posInRange = (lastClose - windowLow) / range; // 0 at bottom, 1 at top
  const extension =
    trendBias === "bullish" ? posInRange
    : trendBias === "bearish" ? 1 - posInRange
    : Math.abs(posInRange - 0.5) * 2;

  // ── Pullback: a healthy retrace off the bias extreme (≈0.2–0.5). ──────────
  let pullbackScore: number;
  if (trendBias === "bullish") {
    const retrace = (windowHigh - lastClose) / range; // 0 at high
    pullbackScore = clamp(100 - Math.abs(retrace - 0.32) * 260);
  } else if (trendBias === "bearish") {
    const retrace = (lastClose - windowLow) / range; // 0 at low
    pullbackScore = clamp(100 - Math.abs(retrace - 0.32) * 260);
  } else {
    pullbackScore = 20;
  }

  // ── Levels (admin override wins, else computed from swings/range). ────────
  const computedSupports = (swingLows.length > 0 ? swingLows : [windowLow])
    .filter((l) => l < lastClose)
    .sort((a, b) => b - a);
  const computedResistances = (swingHighs.length > 0 ? swingHighs : [windowHigh])
    .filter((h) => h > lastClose)
    .sort((a, b) => a - b);
  const supportPool = (input.supportLevels && input.supportLevels.length > 0)
    ? [...input.supportLevels].filter((l) => l < lastClose).sort((a, b) => b - a)
    : computedSupports;
  const resistancePool = (input.resistanceLevels && input.resistanceLevels.length > 0)
    ? [...input.resistanceLevels].filter((h) => h > lastClose).sort((a, b) => a - b)
    : computedResistances;
  const nearestSupport = supportPool[0] ?? round2(windowLow);
  const nearestResistance = resistancePool[0] ?? round2(windowHigh);

  // Breakout base = the consolidation extreme before the latest leg.
  const preWindow = candles.slice(0, Math.max(2, Math.floor(candles.length * 0.6)));
  const breakoutLevel = trendBias === "bullish"
    ? Math.max(...preWindow.map((c) => c.high))
    : trendBias === "bearish"
      ? Math.min(...preWindow.map((c) => c.low))
      : null;

  const invalidationLevel = trendBias === "bullish"
    ? round2(nearestSupport - windowAtr)
    : trendBias === "bearish"
      ? round2(nearestResistance + windowAtr)
      : null;
  const continuationTrigger = trendBias === "bullish" ? round2(nearestResistance)
    : trendBias === "bearish" ? round2(nearestSupport)
    : null;
  const pullbackDangerZone = trendBias === "bullish" ? round2(nearestSupport)
    : trendBias === "bearish" ? round2(nearestResistance)
    : null;

  // ── Support hold / resistance break status from recent candles. ──────────
  const recent = candles.slice(-5);
  let supportHoldStatus: SupportHoldStatus = "untested";
  let resistanceBreakStatus: ResistanceBreakStatus = "untested";
  const touchedSupport = recent.some((c) => c.low <= nearestSupport * 1.001);
  if (touchedSupport) {
    supportHoldStatus = recent[recent.length - 1]!.close > nearestSupport ? "holding" : "broken";
  }
  const touchedResistance = recent.some((c) => c.high >= nearestResistance * 0.999);
  if (touchedResistance) {
    resistanceBreakStatus = recent[recent.length - 1]!.close >= nearestResistance ? "broken" : "rejected";
  }

  // ── Fakeout risk: wicks, break-and-reclaim, proximity to opposing level,
  //    extension into the move. ─────────────────────────────────────────────
  const wickRatios = recent.map((c) => {
    const body = Math.abs(c.close - c.open) || 1e-9;
    const wick = (c.high - Math.max(c.open, c.close)) + (Math.min(c.open, c.close) - c.low);
    return wick / (body + wick + 1e-9);
  });
  const avgWick = sma(wickRatios); // 0..1
  let fakeoutRiskScore = avgWick * 45;
  if (resistanceBreakStatus === "rejected" && trendBias === "bullish") fakeoutRiskScore += 25;
  if (supportHoldStatus === "broken" && trendBias === "bullish") fakeoutRiskScore += 20;
  if (resistanceBreakStatus === "rejected" && trendBias === "bearish") fakeoutRiskScore += 20;
  fakeoutRiskScore += extension * 25; // extended into the move = chasing risk
  fakeoutRiskScore += choppinessScore * 0.15;
  fakeoutRiskScore = clamp(fakeoutRiskScore);

  // ── Continuation: strong aligned structure, holding, not over-extended. ───
  let continuationScore = 0;
  if (trendBias !== "ranging") {
    continuationScore = structureScore * 0.4 + momentumScore * 0.3 + (100 - choppinessScore) * 0.3;
    if (extension > 0.85) continuationScore -= 25; // late / extended
    if (trendBias === "bullish" && supportHoldStatus === "holding") continuationScore += 8;
    if (trendBias === "bullish" && resistanceBreakStatus === "broken") continuationScore += 8;
    continuationScore -= fakeoutRiskScore * 0.2;
  }
  continuationScore = clamp(continuationScore);

  // ── Clean setup score. ───────────────────────────────────────────────────
  let cleanSetupScore = structureScore * 0.45 + (100 - choppinessScore) * 0.35 + momentumScore * 0.2;
  cleanSetupScore -= fakeoutRiskScore * 0.25;
  if (extension > 0.85) cleanSetupScore -= 15;
  cleanSetupScore = clamp(cleanSetupScore);

  // ── Confidence: blend, dampened by chop + fakeout. ───────────────────────
  let confidenceScore = trendBias === "ranging"
    ? 30 + (100 - choppinessScore) * 0.2
    : structureScore * 0.35 + continuationScore * 0.35 + cleanSetupScore * 0.3;
  confidenceScore -= fakeoutRiskScore * 0.2;
  confidenceScore = clamp(confidenceScore);

  // ── Pattern type. ────────────────────────────────────────────────────────
  const detectedPatternType = classifyPattern({
    trendBias, choppinessScore, extension, pullbackScore, continuationScore,
    fakeoutRiskScore, swingPattern, resistanceBreakStatus, supportHoldStatus,
    drift, posInRange,
  });

  // ── Trade context (advisory; risk language only). ────────────────────────
  let tradeContext: PatternSyncTradeContext | null = null;
  const trade = input.openTrades && input.openTrades.length > 0 ? input.openTrades[0]! : null;
  if (trade) {
    const tradeBias: PatternSyncBias = trade.side === "BUY" ? "bullish" : "bearish";
    let alignment: TradeAlignment = "unclear";
    if (trendBias === "ranging") alignment = "unclear";
    else alignment = tradeBias === trendBias ? "aligned" : "countertrend";
    let danger: DangerLevel = "medium";
    if (alignment === "aligned" && fakeoutRiskScore < 40) danger = "low";
    else if (alignment === "countertrend" || fakeoutRiskScore >= 65) danger = "high";
    const invalidation = trade.side === "BUY" ? invalidationLevel : invalidationLevel;
    const firstTarget = trade.side === "BUY" ? nearestResistance : nearestSupport;
    tradeContext = {
      tradeDirectionAlignment: alignment,
      dangerLevel: danger,
      invalidationLevel: invalidation,
      firstTargetZone: round2(firstTarget),
      saferActionSummary: buildTradeWarning(trade.side, alignment, danger, trendBias, nearestSupport, nearestResistance),
    };
  }

  const readableSummary = buildSummary({
    symbol: input.symbol, timeframe: input.timeframe, trendBias, detectedPatternType,
    cleanSetupScore, fakeoutRiskScore, extension, supportHoldStatus, resistanceBreakStatus,
    continuationScore, pullbackScore,
  });

  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    sufficient: true,
    detectedPatternType,
    trendBias,
    structureScore: round0(structureScore),
    momentumScore: round0(momentumScore),
    pullbackScore: round0(pullbackScore),
    continuationScore: round0(continuationScore),
    fakeoutRiskScore: round0(fakeoutRiskScore),
    choppinessScore: round0(choppinessScore),
    cleanSetupScore: round0(cleanSetupScore),
    supportHoldStatus,
    resistanceBreakStatus,
    confidenceScore: round0(confidenceScore),
    levels: {
      nearestSupport: round2(nearestSupport),
      nearestResistance: round2(nearestResistance),
      breakoutLevel: breakoutLevel == null ? null : round2(breakoutLevel),
      invalidationLevel,
      continuationTrigger,
      pullbackDangerZone,
    },
    lastClose: round2(lastClose),
    tradeContext,
    readableSummary,
    signature: {
      bias: trendBias,
      extension: round2(extension),
      swingPattern,
      momentumDir,
    },
  };
}

function classifyPattern(a: {
  trendBias: PatternSyncBias;
  choppinessScore: number;
  extension: number;
  pullbackScore: number;
  continuationScore: number;
  fakeoutRiskScore: number;
  swingPattern: "HH_HL" | "LH_LL" | "MIXED";
  resistanceBreakStatus: ResistanceBreakStatus;
  supportHoldStatus: SupportHoldStatus;
  drift: number;
  posInRange: number;
}): PatternSyncType {
  if (a.choppinessScore >= 65 && a.trendBias === "ranging") return "range_chop";
  if (a.trendBias === "ranging") {
    if (a.choppinessScore >= 50) return "range_chop";
    return "base_building";
  }
  if (a.trendBias === "bullish") {
    if (a.resistanceBreakStatus === "rejected" && a.fakeoutRiskScore >= 55) return "failed_breakout";
    if (a.extension >= 0.9 && a.fakeoutRiskScore >= 55) return "exhaustion_top";
    if (a.pullbackScore >= 60 && a.extension < 0.85) return "bullish_pullback";
    if (a.resistanceBreakStatus === "broken" && a.continuationScore >= 55) return "breakout_continuation";
    if (a.swingPattern === "HH_HL" && a.continuationScore >= 50) return "bullish_reversal_into_continuation";
    return "bullish_pullback";
  }
  // bearish
  if (a.supportHoldStatus === "broken" && a.fakeoutRiskScore >= 55) return "failed_breakout";
  if (a.extension >= 0.9 && a.fakeoutRiskScore >= 55) return "exhaustion_bottom";
  if (a.pullbackScore >= 60 && a.extension < 0.85) return "bearish_pullback";
  if (a.supportHoldStatus === "broken" && a.continuationScore >= 55) return "breakout_continuation";
  if (a.swingPattern === "LH_LL" && a.continuationScore >= 50) return "bearish_reversal_into_continuation";
  return "bearish_pullback";
}

function buildTradeWarning(
  side: "BUY" | "SELL",
  alignment: TradeAlignment,
  danger: DangerLevel,
  trendBias: PatternSyncBias,
  nearestSupport: number,
  nearestResistance: number,
): string {
  const dir = side === "BUY" ? "long" : "short";
  if (alignment === "countertrend") {
    const opposing = side === "SELL" ? "bullish" : "bearish";
    const trigger = side === "SELL" ? nearestSupport : nearestResistance;
    return `This ${dir} is countertrend against a ${trendBias} structure. It only has room if price breaks ${round2(trigger)}; if the opposing ${opposing} structure reasserts, reduce risk. Manage tightly — this is a counter-structure position.`;
  }
  if (alignment === "aligned") {
    return `This ${dir} is aligned with the ${trendBias} structure (danger: ${danger}). Respect the invalidation level and do not chase if price is extended.`;
  }
  return `Structure is unclear/ranging, so this ${dir} has no structural edge. Treat it as range-bound and manage risk conservatively.`;
}

function buildSummary(a: {
  symbol: string;
  timeframe: string;
  trendBias: PatternSyncBias;
  detectedPatternType: PatternSyncType;
  cleanSetupScore: number;
  fakeoutRiskScore: number;
  extension: number;
  supportHoldStatus: SupportHoldStatus;
  resistanceBreakStatus: ResistanceBreakStatus;
  continuationScore: number;
  pullbackScore: number;
}): string {
  const parts: string[] = [];
  const pat = a.detectedPatternType.replace(/_/g, " ");
  parts.push(`${a.symbol} on ${a.timeframe} reads as ${a.trendBias} (${pat}).`);
  if (a.cleanSetupScore >= 70) parts.push("Structure is clean.");
  else if (a.cleanSetupScore >= 45) parts.push("Structure is workable but not pristine.");
  else parts.push("Structure is choppy/unconfirmed.");
  if (a.continuationScore >= 60 && a.trendBias !== "ranging") {
    parts.push(`Continuation potential is present${a.supportHoldStatus === "holding" ? " while support holds" : ""}.`);
  }
  if (a.pullbackScore >= 60 && a.extension < 0.85) parts.push("Price is in a pullback rather than extended.");
  if (a.extension >= 0.9) parts.push("Price is extended into the move — entries here are late.");
  if (a.fakeoutRiskScore >= 60) parts.push("Fakeout risk is elevated; wait for confirmation.");
  parts.push("Advisory only — not a trade instruction.");
  return parts.join(" ");
}

// Pairwise structural-similarity score (0–100) between two engine results.
// 80–100 strong match, 60–79 similar/weaker, 40–59 partial, <40 not same.
export function patternMatchScore(a: PatternSyncEngineResult, b: PatternSyncEngineResult): number {
  if (!a.sufficient || !b.sufficient) return 0;
  let score = 0;
  if (a.signature.bias === b.signature.bias && a.signature.bias !== "ranging") score += 42;
  else if (a.signature.bias === b.signature.bias) score += 18;
  if (a.signature.swingPattern === b.signature.swingPattern && a.signature.swingPattern !== "MIXED") score += 20;
  if (a.signature.momentumDir === b.signature.momentumDir) score += 14;
  // Closeness of structural cleanliness + continuation profile.
  score += 12 * (1 - Math.min(1, Math.abs(a.cleanSetupScore - b.cleanSetupScore) / 100));
  score += 12 * (1 - Math.min(1, Math.abs(a.continuationScore - b.continuationScore) / 100));
  return clamp(Math.round(score));
}
