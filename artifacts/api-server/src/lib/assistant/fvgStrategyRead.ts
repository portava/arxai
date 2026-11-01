// ── FVG Trend Pullback — Ruby Display Block (Task #675) ───────────────────────
//
// Composes the pure FVG Trend Pullback engine into a DISPLAY-ONLY block for the
// Ruby structural read. Additive: it can only DESCRIBE and WARN — never grants
// READY_NOW, never touches execution, never weakens existing reads.
//
// Pattern mirrors goldStrategyRead.ts. The block is included in the chartRead
// payload ONLY as an additional advisory field; it has no bearing on readLayer,
// canShowLiveTradeSetup, or any execution gate.

import {
  analyzeFvgTrendPullback,
  type FvgTrendPullbackResult,
  type FvgZone,
  type HtfTrendDir,
  type FvgSetupStage,
} from "../fvg/fvgTrendPullback.js";
import type { Candle } from "../data/types.js";

export interface FvgStrategyReadBlock {
  active: true;
  strategy: "HTF_TREND_FVG_PULLBACK";
  direction: "BUY" | "SELL" | "WAIT";
  stage: FvgSetupStage | "WITHHELD";
  h4Trend: HtfTrendDir;
  h1Trend: HtfTrendDir;
  htfAligned: boolean;
  htfNote: string;
  fiveMinState: string;
  pullbackActive: boolean;
  maReclaimed: boolean;
  activeFvg: FvgZone | null;
  fvgNote: string;
  entryMin: number | null;
  entryMax: number | null;
  suggestedEntry: number | null;
  suggestedSL: number | null;
  suggestedTP1: number | null;
  suggestedTP2: number | null;
  suggestedTP3: number | null;
  invalidationLevel: number | null;
  score: number | null;
  grade: string;
  headline: string;
  explanation: string;
  tags: string[];
  truth: FvgTrendPullbackResult["truth"];
  note: string;
  /** Set true when a feed-unconfirmed (structural-only) read has stripped the
   *  numeric levels. Display-only marker so the assistant never prints withheld
   *  numbers. Absent/false on a verified FULL read. */
  levelsWithheld?: boolean;
}

/**
 * Build the FVG strategy display block, or null when data is insufficient.
 * Pure composition over the FVG engine using candles the caller already owns.
 * Honest: never fabricates levels or direction when data is missing or stale.
 * Never an execution input — display / decision-support only.
 */
export function buildFvgStrategyRead(args: {
  symbol: string;
  /** 5M candles (primary entry TF). If the primary TF is not M5, pass what is available. */
  m5Candles: Candle[];
  /** H1 candles — may be empty when the caller could not fetch them. */
  h1Candles: Candle[];
  /** H4 candles — may be empty when the caller could not fetch them. */
  h4Candles: Candle[];
  isSimulator?: boolean;
  staleTimeframes?: string[];
  unconfirmedTimeframes?: string[];
}): FvgStrategyReadBlock | null {
  // Adapt the Candle shape (has string `time`) to the FvgCandle shape (OHLC only)
  const adapt = (cs: Candle[]) =>
    cs.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close }));

  const result = analyzeFvgTrendPullback({
    symbol: args.symbol,
    h4Candles: adapt(args.h4Candles),
    h1Candles: adapt(args.h1Candles),
    m5Candles: adapt(args.m5Candles),
    isSimulator: args.isSimulator,
    staleTimeframes: args.staleTimeframes,
    unconfirmedTimeframes: args.unconfirmedTimeframes,
  });

  // Return null when no useful read is possible (e.g. completely no data)
  if (!result.truth.canAnalyze && result.stage === "NO_DATA" &&
      result.truth.missingTimeframes.length === 3) {
    return null;
  }

  return {
    active: true,
    strategy: "HTF_TREND_FVG_PULLBACK",
    direction: result.direction,
    stage: result.stage,
    h4Trend: result.h4Trend,
    h1Trend: result.h1Trend,
    htfAligned: result.htfAligned,
    htfNote: result.htfNote,
    fiveMinState: result.fiveMinState,
    pullbackActive: result.pullbackActive,
    maReclaimed: result.maReclaimed,
    activeFvg: result.activeFvg,
    fvgNote: result.fvgNote,
    entryMin: result.entryMin,
    entryMax: result.entryMax,
    suggestedEntry: result.suggestedEntry,
    suggestedSL: result.suggestedSL,
    suggestedTP1: result.suggestedTP1,
    suggestedTP2: result.suggestedTP2,
    suggestedTP3: result.suggestedTP3,
    invalidationLevel: result.invalidationLevel,
    score: result.score,
    grade: result.grade,
    headline: result.headline,
    explanation: result.explanation,
    tags: result.tags,
    truth: result.truth,
    note: "HTF Trend FVG Pullback is display / decision-support only — it explains and highlights, never authorises a trade.",
  };
}

/** Withhold all price-bearing fields and entry language, including nested zone
 * prices and generated prose. Retain observed trends as structural context,
 * but never a positive signal. Pure and idempotent; not an execution gate. */
export function withholdFvgLevels(block: FvgStrategyReadBlock): FvgStrategyReadBlock {
  const limitation = "Exact FVG entry, stop, target and zone levels are withheld until the chart read qualifies; structure only.";
  return {
    ...block,
    direction: "WAIT",
    stage: "WITHHELD",
    score: null,
    grade: "no_trade",
    fiveMinState: "FVG setup withheld — structural context only",
    tags: [...block.tags.filter(tag => !["SIGNAL_ACTIVE", "ENTRY_ZONE", "INSIDE_FVG", "LEVELS_WITHHELD"].includes(tag)), "LEVELS_WITHHELD"],
    truth: { ...block.truth, canSignal: false },
    activeFvg: null,
    fvgNote: "FVG price zone withheld; review the chart-read limitation.",
    headline: "FVG structure only — exact setup withheld.",
    explanation: limitation,
    entryMin: null,
    entryMax: null,
    suggestedEntry: null,
    suggestedSL: null,
    suggestedTP1: null,
    suggestedTP2: null,
    suggestedTP3: null,
    invalidationLevel: null,
    levelsWithheld: true,
    note: limitation,
  };
}
