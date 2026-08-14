// TRENDLINE TRUTH — backend producer (Task #649).
//
// This is the ONE backend call site that turns raw candles + the caller's
// ALREADY-DECIDED display facts into the shared, display-only
// TrendlineTruthVerdict (and its downgrade-only `scannerTruthImpact`). It runs the
// pure detector (`detectTrendlines`) and the pure domain contract
// (`resolveTrendlineTruth`) — neither of which imports any execution/feed/
// sufficiency module — and folds the result into Scanner Truth / Pattern Truth as
// a CHILD INPUT.
//
// HARD BOUNDARY (mirrors the contract): the verdict this produces can only make a
// read the SAME or MORE conservative (plus a small bounded supportive edge nudge
// when a confirmed trendline sits on a live-confirmed feed). It can NEVER produce
// READY_NOW, override feed/historical/sufficiency status, override a low-
// confidence / trade-health / risk gate, or touch live execution. Fail closed:
// any error or insufficient window returns `null` (no trendline impact at all).
import type { Candle } from "../types.js";
import { normalizeCandles } from "./candleNormalization.js";
import { isChartTimeframe, type ChartTimeframe } from "./timeframes.js";
import { detectTrendlines } from "./engines/trendlineEngine.js";
import {
  resolveTrendlineTruth,
  type TrendlineBias,
  type TrendlineContext,
  type TrendlineDisplayContext,
  type TrendlineTruthVerdict,
} from "@workspace/domain/market";

export interface TrendlineTruthServiceInput {
  symbol: string;
  displaySymbol?: string;
  timeframe: string;
  /** Raw routed candles (bar-open based); normalized + closed-bar filtered here. */
  rawCandles: Candle[];
  /** Source tag for normalization (provider name) — affects price-basis only. */
  source?: string | null;
  // ── Caller's ALREADY-DECIDED display facts (the trendline NEVER recomputes them).
  /** True only when the feed is genuinely live-confirmed (LIVE + FULL read). */
  feedConfirmed: boolean;
  /** True when the feed is delayed/stale (read uses last closed bars only). */
  feedStale: boolean;
  /** True when sufficiency already allows showing a trade setup. */
  sufficiencyAllowsSetup: boolean;
  /** True when the chart-read structural confidence is LOW. */
  chartReadConfidenceLow: boolean;
  // ── Structural context facts (advisory; used only to colour the trendline read).
  /** Higher-timeframe / structural trend bias the read already established. */
  trend: TrendlineBias;
  /** True when momentum agrees with the trendline bias. */
  momentumAligned: boolean;
  /** True when price is at/into a meaningful S/R level. */
  nearSupportResistance: boolean;
  /** Distance to nearest blocking S/R in ATR units (null when unknown). */
  distanceToSrAtr: number | null;
  /** ATR used for geometry normalization (null when unknown). */
  volatilityAtr: number | null;
}

/**
 * Build the shared TrendlineTruthVerdict from raw candles + display facts.
 * Returns `null` (no trendline impact) on any error, an unsupported timeframe, an
 * insufficient candle window, or when no trendline is detected — the caller then
 * leaves its base Scanner Truth / Pattern Truth read completely untouched.
 */
export function buildTrendlineTruthVerdict(
  input: TrendlineTruthServiceInput,
): TrendlineTruthVerdict | null {
  try {
    if (!isChartTimeframe(input.timeframe)) return null;
    const tf = input.timeframe as ChartTimeframe;
    if (!Array.isArray(input.rawCandles) || input.rawCandles.length === 0) {
      return null;
    }
    const { candles } = normalizeCandles(input.rawCandles, {
      symbol: input.symbol,
      displaySymbol: input.displaySymbol ?? input.symbol,
      timeframe: tf,
      source: input.source ?? null,
    });
    const detection = detectTrendlines(candles);
    if (detection.insufficient) return null;
    if (
      detection.trendlines.length === 0 &&
      detection.patternChange.kind === "none"
    ) {
      return null;
    }

    const context: TrendlineContext = {
      trend: input.trend,
      nearSupportResistance: input.nearSupportResistance,
      distanceToSrAtr: input.distanceToSrAtr,
      momentumAligned: input.momentumAligned,
      volatilityAtr: input.volatilityAtr,
    };
    const display: TrendlineDisplayContext = {
      feedConfirmed: input.feedConfirmed,
      feedStale: input.feedStale,
      sufficiencyAllowsSetup: input.sufficiencyAllowsSetup,
      chartReadConfidenceLow: input.chartReadConfidenceLow,
    };
    return resolveTrendlineTruth(
      detection.trendlines,
      context,
      display,
      detection.trendlineChange,
      detection.patternChange,
    );
  } catch {
    return null;
  }
}
