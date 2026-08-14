// ── HTF Trend FVG Pullback Engine — Task #675 ────────────────────────────────
//
// Pure analysis module: no I/O, no DB, no state mutation.
// Strategy: higher-timeframe (4H + 1H) trend alignment → 5M pullback through
// 50 MA / 200 EMA → reclaim / rejection → fresh fair-value-gap entry zone.
//
// SAFETY (INVIOLABLE):
//   - Display / decision-support ONLY. Never an execution gate.
//   - When data is missing, stale, or simulator-sourced → canSignal=false, direction=WAIT.
//   - Never fabricates candles, prices, or levels.
//   - Does NOT import any execution module, live-pipeline module, or safety-contract.
//   - Adding / changing this file cannot weaken any existing strategy, scanner route,
//     Ruby tool, chart overlay, or feed-truth gate.

export interface FvgCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type HtfTrendDir =
  | "strong_up"   // price > SMA50 > EMA200 + positive slope
  | "weak_up"     // price > SMA50 but SMA50 / EMA200 mixed / flat
  | "neutral"     // price between MAs or MAs flat/tangled
  | "weak_down"   // price < SMA50 but SMA50 / EMA200 mixed / flat
  | "strong_down"; // price < SMA50 < EMA200 + negative slope

export type FvgSetupStage =
  | "HTF_CONFLICT"        // 4H/1H disagree → no setup
  | "PULLBACK_WATCH"      // HTF aligned, waiting for 5M pullback to MA zone
  | "IN_PULLBACK"         // Price is currently in MA pullback zone
  | "RECLAIM_WATCH"       // Pulled back, watching for MA reclaim
  | "FVG_HUNT"            // Reclaimed, hunting a fresh FVG to enter
  | "FVG_ENTRY_ZONE"      // Price approaching/at the FVG — active setup
  | "INSIDE_FVG"          // Price is inside the FVG zone — highest priority
  | "FVG_MISSED"          // FVG fully mitigated without clean entry → wait for reset
  | "INVALIDATED"         // Price violated the SL level
  | "NO_DATA";            // Insufficient candles / stale / simulator

export interface FvgZone {
  high: number;
  low: number;
  midpoint: number;
  direction: "bullish" | "bearish";
  /** 0-indexed into the M5 candles array (the middle bar of the 3-candle gap). */
  formationBarIndex: number;
  isMitigated: boolean;
}

export interface HtfTrendRead {
  dir: HtfTrendDir;
  sma50: number | null;
  ema200: number | null;
  lastClose: number;
  note: string;
}

export interface PullbackRead {
  active: boolean;
  deepestPullback: number | null; // lowest close reached during pullback (bullish) or highest (bearish)
  note: string;
}

export interface MAReclaimRead {
  confirmed: boolean;
  reclaimBarIndex: number | null;
  note: string;
}

export interface FvgTruthBlock {
  /** True when all required TFs have sufficient candles, are non-stale, and non-simulator. */
  dataReady: boolean;
  /** True when H4, H1, and M5 candle counts each meet the minimum bar requirement. */
  requiredTimeframesPresent: boolean;
  canAnalyze: boolean;
  canSignal: boolean;
  h4DataSufficient: boolean;
  h1DataSufficient: boolean;
  m5DataSufficient: boolean;
  usingSimulator: boolean;
  missingTimeframes: string[];
  staleTimeframes: string[];
  reasonIfNotReady: string | null;
}

export interface FvgChartOverlaySpec {
  id: string;
  kind: "zone" | "line" | "marker";
  label: string;
  color: string;
  /** For "line" kind. */
  price?: number;
  /** For "zone" kind. */
  priceMin?: number;
  priceMax?: number;
  style: "solid" | "dashed";
  lineWidth?: number;
  /** For "marker" kind — directional hint. */
  side?: "BUY" | "SELL";
}

export interface FvgTrendPullbackResult {
  symbol: string;
  /** Always "M5" for the entry timeframe — HTF reads feed into this. */
  timeframe: string;
  strategy: "HTF_TREND_FVG_PULLBACK";
  direction: "BUY" | "SELL" | "WAIT";

  // HTF reads
  h4Trend: HtfTrendDir;
  h1Trend: HtfTrendDir;
  htfAligned: boolean;
  htfNote: string;

  // 5M state
  fiveMinState: string;
  pullbackActive: boolean;
  maReclaimed: boolean;

  // FVG
  activeFvg: FvgZone | null;
  fvgNote: string;

  // Levels (null when canSignal=false)
  entryMin: number | null;
  entryMax: number | null;
  suggestedEntry: number | null;
  suggestedSL: number | null;
  suggestedTP1: number | null;
  suggestedTP2: number | null;
  suggestedTP3: number | null;
  /** Price level that invalidates the setup (SL side, beyond the FVG boundary). */
  invalidationLevel: number | null;

  // Score / grade
  score: number;
  grade: "A+" | "A" | "B" | "C" | "no_trade";
  stage: FvgSetupStage;

  // Human copy
  headline: string;
  explanation: string;
  tags: string[];

  // Data-honesty block (REQUIRED — never omit)
  truth: FvgTruthBlock;

  // Chart overlay descriptors
  overlays: FvgChartOverlaySpec[];
}

// ── Minimum bar requirements ─────────────────────────────────────────────────
// HTF bars must cover EMA(200) with a warm-up margin: ≥ 205 so the EMA is
// settled and we never fall back to a null-EMA "strong" classification.
// M5 bars cover SMA(50) pullback + FVG detection (≥ 60 bars).
export const MIN_H4_BARS = 205;
export const MIN_H1_BARS = 205;
export const MIN_M5_BARS = 60;

// ── Indicator helpers ────────────────────────────────────────────────────────
// sma is imported from the shared chartMath module (identical signature).
// ema: no shared export exists — kept local (standard smoothing EMA).
// atr: chartMath.ts atr takes NormalizedChartCandle[], which carries many fields
//      beyond OHLC; FvgCandle is a minimal {open,high,low,close} type and is not
//      structurally assignable without a lossy cast, so atr stays local to avoid
//      a misleading cast that hides the type mismatch at compile time.

import { sma } from "../data/chart/engines/chartMath.js";

function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    val = closes[i]! * k + val * (1 - k);
  }
  return val;
}

function atr(candles: FvgCandle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i]!;
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  const slice = trs.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function slope(closes: number[], lookback = 10): number {
  const n = closes.length;
  if (n < lookback + 1) return 0;
  return closes[n - 1]! - closes[n - 1 - lookback]!;
}

// ── HTF Trend Detection ───────────────────────────────────────────────────────

export function detectHtfTrend(candles: FvgCandle[]): HtfTrendRead {
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1] ?? 0;
  const s50 = sma(closes, 50);
  const e200 = ema(closes, 200);
  const sl = slope(closes, 10);

  if (s50 == null) {
    return { dir: "neutral", sma50: null, ema200: e200, lastClose: last, note: "Insufficient bars for SMA(50)." };
  }

  const aboveSma = last > s50;
  const belowSma = last < s50;
  const smaAboveEma = e200 != null ? s50 > e200 : null;

  // "strong" requires EMA200 to be available AND correctly stacked — never fall back on e200==null.
  if (aboveSma && smaAboveEma === true && sl > 0) {
    return { dir: "strong_up", sma50: s50, ema200: e200, lastClose: last, note: "Price > SMA50 > EMA200, upslope confirmed." };
  }
  if (aboveSma && sl >= 0) {
    return { dir: "weak_up", sma50: s50, ema200: e200, lastClose: last, note: "Price > SMA50 but slope / EMA200 not fully stacked." };
  }
  if (aboveSma) {
    return { dir: "neutral", sma50: s50, ema200: e200, lastClose: last, note: "Price above SMA50 but losing momentum." };
  }
  if (belowSma && smaAboveEma === false && sl < 0) {
    return { dir: "strong_down", sma50: s50, ema200: e200, lastClose: last, note: "Price < SMA50 < EMA200, downslope confirmed." };
  }
  if (belowSma && sl <= 0) {
    return { dir: "weak_down", sma50: s50, ema200: e200, lastClose: last, note: "Price < SMA50 but not fully bearish-stacked." };
  }
  if (belowSma) {
    return { dir: "neutral", sma50: s50, ema200: e200, lastClose: last, note: "Price below SMA50 but losing bearish momentum." };
  }
  return { dir: "neutral", sma50: s50, ema200: e200, lastClose: last, note: "No clear directional bias from MAs." };
}

function isUpDir(dir: HtfTrendDir): boolean {
  return dir === "strong_up" || dir === "weak_up";
}
function isDownDir(dir: HtfTrendDir): boolean {
  return dir === "strong_down" || dir === "weak_down";
}

// ── 5M Pullback Detection ─────────────────────────────────────────────────────
// Checks the recent M5 candles for a pullback INTO the SMA50 zone.
// For bullish: price was well above SMA50, then dipped to within 0.5×ATR of it.
// For bearish: price was well below SMA50, then bounced to within 0.5×ATR of it.

export function detectPullbackThroughMAs(
  candles: FvgCandle[],
  direction: "bullish" | "bearish",
): PullbackRead {
  if (candles.length < MIN_M5_BARS) {
    return { active: false, deepestPullback: null, note: "Insufficient 5M candles to detect pullback." };
  }
  const closes = candles.map((c) => c.close);
  const s50 = sma(closes, 50);
  const atrVal = atr(candles);

  if (s50 == null || atrVal === 0) {
    return { active: false, deepestPullback: null, note: "Cannot compute SMA50 or ATR." };
  }

  // Look at the last 30 candles for the pullback pattern
  const window = candles.slice(-30);
  const wCloses = window.map((c) => c.close);

  if (direction === "bullish") {
    // Was price above SMA50 recently?
    const wasAbove = wCloses.slice(0, 15).some((c) => c > s50 + atrVal * 0.3);
    // Did price then pull into the MA zone (within 0.5 ATR)?
    const pulledBack = wCloses.slice(10).some((c) => c <= s50 + atrVal * 0.5 && c >= s50 - atrVal * 0.5);
    const deepest = pulledBack ? Math.min(...wCloses.slice(10)) : null;
    if (wasAbove && pulledBack) {
      return { active: true, deepestPullback: deepest, note: "Price pulled back into SMA50 zone on 5M." };
    }
    // Also count as active if price is currently touching/piercing the MA
    const lastClose = closes[closes.length - 1]!;
    if (lastClose <= s50 + atrVal * 0.5 && lastClose >= s50 - atrVal * 1.0) {
      return { active: true, deepestPullback: lastClose, note: "Price currently at SMA50 pullback zone on 5M." };
    }
    return { active: false, deepestPullback: null, note: "No clear bullish pullback into SMA50 zone detected." };
  } else {
    const wasBelow = wCloses.slice(0, 15).some((c) => c < s50 - atrVal * 0.3);
    const pulledBack = wCloses.slice(10).some((c) => c >= s50 - atrVal * 0.5 && c <= s50 + atrVal * 0.5);
    const deepest = pulledBack ? Math.max(...wCloses.slice(10)) : null;
    if (wasBelow && pulledBack) {
      return { active: true, deepestPullback: deepest, note: "Price pulled up into SMA50 zone on 5M (bearish)." };
    }
    const lastClose = closes[closes.length - 1]!;
    if (lastClose >= s50 - atrVal * 0.5 && lastClose <= s50 + atrVal * 1.0) {
      return { active: true, deepestPullback: lastClose, note: "Price currently at SMA50 pullback zone on 5M (bearish)." };
    }
    return { active: false, deepestPullback: null, note: "No clear bearish pullback into SMA50 zone detected." };
  }
}

// ── MA Reclaim Detection ──────────────────────────────────────────────────────
// After the pullback, did price close back on the trend side of SMA50?

export function detectMAReclaim(
  candles: FvgCandle[],
  direction: "bullish" | "bearish",
): MAReclaimRead {
  if (candles.length < MIN_M5_BARS) {
    return { confirmed: false, reclaimBarIndex: null, note: "Insufficient 5M candles to detect MA reclaim." };
  }
  const closes = candles.map((c) => c.close);
  const s50 = sma(closes, 50);
  if (s50 == null) {
    return { confirmed: false, reclaimBarIndex: null, note: "Cannot compute SMA50." };
  }

  // Scan the last 20 candles for a reclaim candle
  const start = Math.max(0, candles.length - 20);
  for (let i = candles.length - 1; i >= start; i--) {
    const c = candles[i]!;
    const prev = candles[i - 1];
    if (!prev) continue;

    if (direction === "bullish") {
      // A bullish reclaim: prev close was at/below SMA50 and current close is above
      if (prev.close <= s50 && c.close > s50) {
        return {
          confirmed: true,
          reclaimBarIndex: i,
          note: `Bullish MA reclaim at bar ${i} — closed above SMA50 after pullback.`,
        };
      }
    } else {
      // A bearish reclaim (rejection): prev close was at/above SMA50 and current close is below
      if (prev.close >= s50 && c.close < s50) {
        return {
          confirmed: true,
          reclaimBarIndex: i,
          note: `Bearish MA rejection at bar ${i} — closed below SMA50 after bounce.`,
        };
      }
    }
  }
  return { confirmed: false, reclaimBarIndex: null, note: "No MA reclaim/rejection found in recent 5M candles." };
}

// ── Fair Value Gap Detection ──────────────────────────────────────────────────
// A 3-candle FVG pattern. Scan the most recent candles for the FRESHEST
// unmitigated gap, then report whether price has returned to fill it.
//
// Bullish FVG: candle[i].high < candle[i+2].low  (gap above candle[i])
// Bearish FVG: candle[i].low > candle[i+2].high  (gap below candle[i])
// The FVG zone is: [candle[i].high, candle[i+2].low] for bullish
//                  [candle[i+2].high, candle[i].low] for bearish

export function detectFairValueGap(
  candles: FvgCandle[],
  direction: "bullish" | "bearish",
): FvgZone | null {
  if (candles.length < 5) return null;

  // Only look at the last 50 candles for relevant FVGs
  const start = Math.max(0, candles.length - 50);
  const lastClose = candles[candles.length - 1]!.close;

  // Collect all detected FVGs and pick the freshest unmitigated one
  const fvgs: FvgZone[] = [];

  for (let i = start; i < candles.length - 2; i++) {
    const a = candles[i]!;
    const b = candles[i + 1]!; // the impulse bar (largest body)
    const c = candles[i + 2]!;

    if (direction === "bullish") {
      // Bullish FVG: gap above candle[i] → zone is [a.high, c.low]
      if (a.high < c.low) {
        const gapHigh = c.low;
        const gapLow = a.high;
        if (gapHigh <= gapLow) continue; // degenerate

        // Is this FVG mitigated? (price returned into the zone on a later bar)
        let isMitigated = false;
        for (let j = i + 3; j < candles.length; j++) {
          const check = candles[j]!;
          if (check.low <= gapHigh && check.high >= gapLow) {
            isMitigated = true;
            break;
          }
        }
        // Only include if relevant to current price (within 2% of last close)
        const midpoint = (gapHigh + gapLow) / 2;
        const proximity = Math.abs(lastClose - midpoint) / lastClose;
        if (proximity <= 0.05 || !isMitigated) {
          fvgs.push({
            high: gapHigh, low: gapLow, midpoint,
            direction: "bullish",
            formationBarIndex: i + 1, // middle bar index
            isMitigated,
          });
        }
        void b; // b is the middle impulse bar
      }
    } else {
      // Bearish FVG: gap below candle[i] → zone is [c.high, a.low]
      if (a.low > c.high) {
        const gapHigh = a.low;
        const gapLow = c.high;
        if (gapHigh <= gapLow) continue;

        let isMitigated = false;
        for (let j = i + 3; j < candles.length; j++) {
          const check = candles[j]!;
          if (check.low <= gapHigh && check.high >= gapLow) {
            isMitigated = true;
            break;
          }
        }
        const midpoint = (gapHigh + gapLow) / 2;
        const proximity = Math.abs(lastClose - midpoint) / lastClose;
        if (proximity <= 0.05 || !isMitigated) {
          fvgs.push({
            high: gapHigh, low: gapLow, midpoint,
            direction: "bearish",
            formationBarIndex: i + 1,
            isMitigated,
          });
        }
        void b;
      }
    }
  }

  if (fvgs.length === 0) return null;

  // Prefer the MOST RECENT unmitigated FVG
  const fresh = fvgs.filter((z) => !z.isMitigated);
  if (fresh.length > 0) return fresh[fresh.length - 1]!;

  // Fall back to the most recent (even if mitigated) for context
  return fvgs[fvgs.length - 1]!;
}

// ── Setup Stage Resolution ────────────────────────────────────────────────────

function resolveStage(args: {
  htfAligned: boolean;
  direction: "bullish" | "bearish";
  pullback: PullbackRead;
  reclaim: MAReclaimRead;
  activeFvg: FvgZone | null;
  lastClose: number;
  m5Atr: number;
  noData: boolean;
}): FvgSetupStage {
  if (args.noData) return "NO_DATA";
  if (!args.htfAligned) return "HTF_CONFLICT";

  const { pullback, reclaim, activeFvg, lastClose, m5Atr } = args;

  if (!pullback.active) return "PULLBACK_WATCH";

  if (!reclaim.confirmed) {
    // Still in pullback zone — check if we're clearly in it
    return "IN_PULLBACK";
  }

  // Reclaim confirmed — look for a fresh FVG
  if (!activeFvg) return "FVG_HUNT";

  if (activeFvg.isMitigated) return "FVG_MISSED";

  // INVALIDATED: price closed through the setup boundary in the wrong direction
  // (beyond the FVG boundary by 1×ATR) — the setup is void regardless of HTF.
  const invalidated =
    args.direction === "bullish"
      ? lastClose < activeFvg.low - m5Atr        // BUY: close below FVG low − 1 ATR
      : lastClose > activeFvg.high + m5Atr;      // SELL: close above FVG high + 1 ATR
  if (invalidated) return "INVALIDATED";

  // Is price currently inside the FVG zone?
  const insideFvg = lastClose >= activeFvg.low - m5Atr * 0.2 &&
                    lastClose <= activeFvg.high + m5Atr * 0.2;
  if (insideFvg) return "INSIDE_FVG";

  // Is price approaching the FVG (within 1 ATR)?
  const { direction } = args;
  if (direction === "bullish") {
    const distanceToFvg = lastClose - activeFvg.low;
    if (distanceToFvg >= 0 && distanceToFvg <= m5Atr * 2) return "FVG_ENTRY_ZONE";
  } else {
    const distanceToFvg = activeFvg.high - lastClose;
    if (distanceToFvg >= 0 && distanceToFvg <= m5Atr * 2) return "FVG_ENTRY_ZONE";
  }

  return "FVG_HUNT";
}

// ── Score ─────────────────────────────────────────────────────────────────────

export function scoreFvgTrendPullback(result: FvgTrendPullbackResult): number {
  if (!result.truth.canAnalyze) return 0;
  let score = 0;

  // HTF alignment quality
  const h4Strong = result.h4Trend === "strong_up" || result.h4Trend === "strong_down";
  const h1Strong = result.h1Trend === "strong_up" || result.h1Trend === "strong_down";
  if (result.htfAligned) {
    score += h4Strong && h1Strong ? 30 : h4Strong || h1Strong ? 22 : 15;
  }

  if (result.pullbackActive) score += 18;
  if (result.maReclaimed) score += 20;

  if (result.activeFvg) {
    score += result.activeFvg.isMitigated ? 5 : 20;
  }

  // Stage bonus
  const stageBonuses: Partial<Record<FvgSetupStage, number>> = {
    INSIDE_FVG: 12,
    FVG_ENTRY_ZONE: 8,
    FVG_HUNT: 2,
  };
  score += stageBonuses[result.stage] ?? 0;

  return Math.min(100, Math.max(0, score));
}

// ── Explanation ───────────────────────────────────────────────────────────────

export function explainFvgTrendPullback(result: FvgTrendPullbackResult): string {
  if (!result.truth.canAnalyze) {
    return result.truth.reasonIfNotReady ?? "Insufficient data to analyze this setup.";
  }
  if (!result.htfAligned) {
    return `Higher-timeframe trends conflict — 4H reads ${humanDir(result.h4Trend)} while 1H reads ${humanDir(result.h1Trend)}. No FVG setup until they agree.`;
  }

  const dir = result.direction === "BUY" ? "bullish" : result.direction === "SELL" ? "bearish" : "neutral";
  const parts: string[] = [];

  parts.push(`HTF alignment is ${dir}: 4H is ${humanDir(result.h4Trend)}, 1H is ${humanDir(result.h1Trend)}.`);

  if (!result.pullbackActive) {
    parts.push("Waiting for a pullback into the 50 MA zone on the 5-minute chart.");
  } else if (!result.maReclaimed) {
    parts.push("Price is pulling back into the MA zone. Watching for a close that reclaims the 50 MA.");
  } else if (!result.activeFvg) {
    parts.push("MA reclaimed. Now hunting for a fresh fair-value gap (FVG) formed during the impulse.");
  } else if (result.activeFvg.isMitigated) {
    parts.push("The most recent FVG was fully mitigated without a clean entry. Waiting for a new setup to reset.");
  } else {
    const fvg = result.activeFvg;
    const label = fvg.direction === "bullish" ? "demand" : "supply";
    parts.push(
      `Fresh ${fvg.direction} FVG found at ${fvg.low.toFixed(5)}–${fvg.high.toFixed(5)} (${label} zone midpoint ${fvg.midpoint.toFixed(5)}).`,
    );
    if (result.stage === "INSIDE_FVG") {
      parts.push("Price is currently inside the FVG zone — optimal entry window.");
    } else if (result.stage === "FVG_ENTRY_ZONE") {
      parts.push("Price is approaching the FVG. Watch for a rejection candle or a limit order at the midpoint.");
    } else {
      parts.push("Waiting for price to return to the FVG entry zone.");
    }
  }

  if (result.suggestedSL != null) {
    const tp3Part = result.suggestedTP3 != null ? `, TP3 (extended): ${result.suggestedTP3.toFixed(5)}` : "";
    const invalidPart = result.invalidationLevel != null
      ? ` Setup void if price closes through ${result.invalidationLevel.toFixed(5)}.`
      : "";
    parts.push(
      `Suggested entry: ${result.suggestedEntry?.toFixed(5) ?? "FVG zone"}, SL: ${result.suggestedSL.toFixed(5)}, TP1: ${result.suggestedTP1?.toFixed(5) ?? "—"}, TP2: ${result.suggestedTP2?.toFixed(5) ?? "—"}${tp3Part}.${invalidPart}`,
    );
  }

  return parts.join(" ");
}

function humanDir(dir: HtfTrendDir): string {
  switch (dir) {
    case "strong_up": return "strongly bullish";
    case "weak_up": return "weakly bullish";
    case "neutral": return "neutral";
    case "weak_down": return "weakly bearish";
    case "strong_down": return "strongly bearish";
  }
}

// ── Chart Overlays ────────────────────────────────────────────────────────────

export function buildFvgChartOverlays(result: FvgTrendPullbackResult): FvgChartOverlaySpec[] {
  const overlays: FvgChartOverlaySpec[] = [];
  if (!result.truth.canAnalyze) return overlays;

  // FVG zone
  if (result.activeFvg && !result.activeFvg.isMitigated) {
    const fvg = result.activeFvg;
    overlays.push({
      id: `fvg-${result.symbol}-zone`,
      kind: "zone",
      label: `FVG ${fvg.direction === "bullish" ? "Demand" : "Supply"} Zone`,
      color: fvg.direction === "bullish" ? "#22c55e" : "#ef4444",
      priceMin: fvg.low,
      priceMax: fvg.high,
      style: "dashed",
    });
    overlays.push({
      id: `fvg-${result.symbol}-mid`,
      kind: "line",
      label: "FVG Midpoint",
      color: fvg.direction === "bullish" ? "#86efac" : "#fca5a5",
      price: fvg.midpoint,
      style: "dashed",
      lineWidth: 1,
    });
  }

  // Entry zone
  if (result.entryMin != null && result.entryMax != null) {
    overlays.push({
      id: `fvg-${result.symbol}-entry`,
      kind: "zone",
      label: "FVG Entry Zone",
      color: result.direction === "BUY" ? "#3b82f6" : "#f97316",
      priceMin: result.entryMin,
      priceMax: result.entryMax,
      style: "solid",
    });
  }

  // SL line
  if (result.suggestedSL != null) {
    overlays.push({
      id: `fvg-${result.symbol}-sl`,
      kind: "line",
      label: "FVG SL",
      color: "#ef4444",
      price: result.suggestedSL,
      style: "dashed",
      lineWidth: 1,
    });
  }

  // TP1 line
  if (result.suggestedTP1 != null) {
    overlays.push({
      id: `fvg-${result.symbol}-tp1`,
      kind: "line",
      label: "FVG TP1",
      color: "#10b981",
      price: result.suggestedTP1,
      style: "dashed",
      lineWidth: 1,
    });
  }

  // TP2 line
  if (result.suggestedTP2 != null) {
    overlays.push({
      id: `fvg-${result.symbol}-tp2`,
      kind: "line",
      label: "FVG TP2",
      color: "#34d399",
      price: result.suggestedTP2,
      style: "dashed",
      lineWidth: 1,
    });
  }

  // TP3 line (extended target)
  if (result.suggestedTP3 != null) {
    overlays.push({
      id: `fvg-${result.symbol}-tp3`,
      kind: "line",
      label: "FVG TP3",
      color: "#6ee7b7",
      price: result.suggestedTP3,
      style: "dashed",
      lineWidth: 1,
    });
  }

  // Invalidation level — closes through this voids the setup
  if (result.invalidationLevel != null) {
    overlays.push({
      id: `fvg-${result.symbol}-invalidation`,
      kind: "line",
      label: "FVG Invalidation",
      color: "#b91c1c",
      price: result.invalidationLevel,
      style: "dashed",
      lineWidth: 1,
    });
  }

  // Direction marker at entry
  if (result.suggestedEntry != null && (result.direction === "BUY" || result.direction === "SELL")) {
    overlays.push({
      id: `fvg-${result.symbol}-marker`,
      kind: "marker",
      label: `FVG ${result.direction}`,
      color: result.direction === "BUY" ? "#22c55e" : "#ef4444",
      price: result.suggestedEntry,
      style: "solid",
      side: result.direction,
    });
  }

  return overlays;
}

// ── Main Analyzer ─────────────────────────────────────────────────────────────

export interface FvgAnalysisInput {
  symbol: string;
  h4Candles: FvgCandle[];
  h1Candles: FvgCandle[];
  m5Candles: FvgCandle[];
  /** Mark the input data as simulator-sourced — gates canSignal=false. */
  isSimulator?: boolean;
  /** Stale timeframe labels reported by the caller. */
  staleTimeframes?: string[];
}

export function analyzeFvgTrendPullback(input: FvgAnalysisInput): FvgTrendPullbackResult {
  const { symbol, h4Candles, h1Candles, m5Candles } = input;
  const isSimulator = input.isSimulator === true;
  const staleTimeframes = input.staleTimeframes ?? [];

  // ── Truth / data-readiness ───────────────────────────────────────────────
  const h4Ok = h4Candles.length >= MIN_H4_BARS;
  const h1Ok = h1Candles.length >= MIN_H1_BARS;
  const m5Ok = m5Candles.length >= MIN_M5_BARS;
  const missing: string[] = [];
  if (!h4Ok) missing.push("H4");
  if (!h1Ok) missing.push("H1");
  if (!m5Ok) missing.push("M5");

  // Stale timeframes prevent analysis: stale data can produce false trend reads.
  const canAnalyze = h4Ok && h1Ok && m5Ok && !isSimulator && staleTimeframes.length === 0;
  const noData = !canAnalyze;

  const reasonIfNotReady =
    isSimulator ? "Data is simulator-sourced — FVG analysis requires a live feed." :
    missing.length > 0 ? `Missing or insufficient candle data for: ${missing.join(", ")}.` :
    staleTimeframes.length > 0 ? `Stale feed on: ${staleTimeframes.join(", ")} — canSignal blocked until data is live.` :
    null;

  const baseTruth: FvgTruthBlock = {
    dataReady: canAnalyze,
    requiredTimeframesPresent: h4Ok && h1Ok && m5Ok,
    canAnalyze,
    canSignal: false, // resolved below
    h4DataSufficient: h4Ok,
    h1DataSufficient: h1Ok,
    m5DataSufficient: m5Ok,
    usingSimulator: isSimulator,
    missingTimeframes: missing,
    staleTimeframes,
    reasonIfNotReady,
  };

  if (noData) {
    return {
      symbol, timeframe: "M5", strategy: "HTF_TREND_FVG_PULLBACK",
      direction: "WAIT",
      h4Trend: "neutral", h1Trend: "neutral",
      htfAligned: false, htfNote: reasonIfNotReady ?? "Data not available.",
      fiveMinState: "No data", pullbackActive: false, maReclaimed: false,
      activeFvg: null, fvgNote: "No FVG analysis — data not ready.",
      entryMin: null, entryMax: null,
      suggestedEntry: null, suggestedSL: null, suggestedTP1: null, suggestedTP2: null,
      suggestedTP3: null, invalidationLevel: null,
      score: 0, grade: "no_trade", stage: "NO_DATA",
      headline: "Insufficient data for FVG analysis.",
      explanation: reasonIfNotReady ?? "Data not available.",
      tags: ["NO_DATA"],
      truth: baseTruth,
      overlays: [],
    };
  }

  // ── HTF reads ─────────────────────────────────────────────────────────────
  const h4Read = detectHtfTrend(h4Candles);
  const h1Read = detectHtfTrend(h1Candles);

  const bothUp = isUpDir(h4Read.dir) && isUpDir(h1Read.dir);
  const bothDown = isDownDir(h4Read.dir) && isDownDir(h1Read.dir);
  const htfAligned = bothUp || bothDown;
  const htfDirection: "bullish" | "bearish" = bothDown ? "bearish" : "bullish";

  const htfNote = htfAligned
    ? `${htfDirection === "bullish" ? "Bullish" : "Bearish"} alignment: 4H ${humanDir(h4Read.dir)}, 1H ${humanDir(h1Read.dir)}.`
    : `Conflict: 4H is ${humanDir(h4Read.dir)}, 1H is ${humanDir(h1Read.dir)} — waiting for alignment.`;

  // ── 5M analysis ───────────────────────────────────────────────────────────
  const m5Atr = atr(m5Candles);
  const m5Closes = m5Candles.map((c) => c.close);
  const m5Last = m5Closes[m5Closes.length - 1] ?? 0;

  let pullback: PullbackRead = { active: false, deepestPullback: null, note: "" };
  let reclaim: MAReclaimRead = { confirmed: false, reclaimBarIndex: null, note: "" };
  let activeFvg: FvgZone | null = null;
  let fvgNote = "";

  if (htfAligned) {
    pullback = detectPullbackThroughMAs(m5Candles, htfDirection);
    if (pullback.active) {
      reclaim = detectMAReclaim(m5Candles, htfDirection);
      if (reclaim.confirmed) {
        activeFvg = detectFairValueGap(m5Candles, htfDirection);
        fvgNote = activeFvg
          ? activeFvg.isMitigated
            ? `FVG at ${activeFvg.low.toFixed(5)}–${activeFvg.high.toFixed(5)} detected but already mitigated.`
            : `Fresh FVG at ${activeFvg.low.toFixed(5)}–${activeFvg.high.toFixed(5)} — unmitigated entry zone.`
          : "No fresh FVG found yet on 5M. Watching for one to form on the next impulse.";
      } else {
        fvgNote = "Pullback active. Waiting for a close back on the trend side of SMA50.";
      }
    } else {
      fvgNote = "No active pullback. Waiting for price to return to the MA zone.";
    }
  } else {
    fvgNote = "HTF conflict — FVG analysis paused until 4H and 1H align.";
  }

  // ── Stage ─────────────────────────────────────────────────────────────────
  const stage = resolveStage({
    htfAligned,
    direction: htfDirection,
    pullback,
    reclaim,
    activeFvg,
    lastClose: m5Last,
    m5Atr,
    noData,
  });

  // ── Direction & signal ────────────────────────────────────────────────────
  const canSignal =
    htfAligned &&
    pullback.active &&
    reclaim.confirmed &&
    activeFvg != null &&
    !activeFvg.isMitigated &&
    (stage === "FVG_ENTRY_ZONE" || stage === "INSIDE_FVG");

  const direction: "BUY" | "SELL" | "WAIT" =
    canSignal ? (htfDirection === "bullish" ? "BUY" : "SELL") : "WAIT";

  // ── Levels (only when canSignal) ──────────────────────────────────────────
  let entryMin: number | null = null;
  let entryMax: number | null = null;
  let suggestedEntry: number | null = null;
  let suggestedSL: number | null = null;
  let suggestedTP1: number | null = null;
  let suggestedTP2: number | null = null;
  let suggestedTP3: number | null = null;
  /** Invalidation = price closes through this level, negating the FVG setup. */
  let invalidationLevel: number | null = null;

  if (canSignal && activeFvg) {
    entryMin = activeFvg.low;
    entryMax = activeFvg.high;
    suggestedEntry = activeFvg.midpoint;

    if (direction === "BUY") {
      suggestedSL = activeFvg.low - m5Atr * 0.5;
      invalidationLevel = activeFvg.low - m5Atr; // close below FVG low + 1×ATR = setup void
      const risk = suggestedEntry - suggestedSL;
      suggestedTP1 = suggestedEntry + risk * 1.5;
      suggestedTP2 = suggestedEntry + risk * 2.5;
      suggestedTP3 = suggestedEntry + risk * 4.0; // extended target (swing high area)
    } else {
      suggestedSL = activeFvg.high + m5Atr * 0.5;
      invalidationLevel = activeFvg.high + m5Atr; // close above FVG high + 1×ATR = setup void
      const risk = suggestedSL - suggestedEntry;
      suggestedTP1 = suggestedEntry - risk * 1.5;
      suggestedTP2 = suggestedEntry - risk * 2.5;
      suggestedTP3 = suggestedEntry - risk * 4.0;
    }
  }

  // ── 5M human state label ──────────────────────────────────────────────────
  const fiveMinState =
    !htfAligned ? "HTF conflict" :
    !pullback.active ? "Waiting for pullback" :
    !reclaim.confirmed ? "In pullback — watching for MA reclaim" :
    !activeFvg ? "MA reclaimed — hunting FVG" :
    activeFvg.isMitigated ? "FVG mitigated — awaiting reset" :
    stage === "INSIDE_FVG" ? "Inside FVG entry zone" :
    stage === "FVG_ENTRY_ZONE" ? "Approaching FVG — setup active" :
    "FVG found — waiting for price return";

  // ── Tags ──────────────────────────────────────────────────────────────────
  const tags: string[] = ["HTF_TREND_FVG_PULLBACK"];
  if (htfAligned) tags.push(htfDirection === "bullish" ? "BULLISH_HTF" : "BEARISH_HTF");
  if (pullback.active) tags.push("PULLBACK");
  if (reclaim.confirmed) tags.push("MA_RECLAIM");
  if (activeFvg && !activeFvg.isMitigated) tags.push("FRESH_FVG");
  if (stage === "INSIDE_FVG") tags.push("INSIDE_FVG");
  if (stage === "FVG_ENTRY_ZONE") tags.push("ENTRY_ZONE");
  if (canSignal) tags.push("SIGNAL_ACTIVE");

  // ── Grade ─────────────────────────────────────────────────────────────────
  // Compute raw score first (without the final grade/score fields populated)
  const partial: FvgTrendPullbackResult = {
    symbol, timeframe: "M5", strategy: "HTF_TREND_FVG_PULLBACK",
    direction, h4Trend: h4Read.dir, h1Trend: h1Read.dir,
    htfAligned, htfNote,
    fiveMinState, pullbackActive: pullback.active, maReclaimed: reclaim.confirmed,
    activeFvg, fvgNote,
    entryMin, entryMax, suggestedEntry, suggestedSL, suggestedTP1, suggestedTP2,
    suggestedTP3, invalidationLevel,
    score: 0, grade: "no_trade", stage,
    headline: "", explanation: "", tags,
    truth: { ...baseTruth, canSignal },
    overlays: [],
  };
  const score = scoreFvgTrendPullback(partial);
  const grade: FvgTrendPullbackResult["grade"] =
    score >= 80 ? "A+" :
    score >= 65 ? "A" :
    score >= 45 ? "B" :
    score >= 30 ? "C" : "no_trade";

  const headline =
    !htfAligned ? "HTF conflict — no FVG setup." :
    !canSignal ? `${htfDirection === "bullish" ? "Bullish" : "Bearish"} HTF aligned — ${fiveMinState.toLowerCase()}.` :
    `${direction} setup: fresh FVG entry zone (grade ${grade}).`;

  const result: FvgTrendPullbackResult = {
    ...partial,
    score,
    grade,
    headline,
    explanation: "", // filled below
    overlays: [], // filled below
  };
  result.explanation = explainFvgTrendPullback(result);
  result.overlays = buildFvgChartOverlays(result);

  return result;
}
