import type { ConsensusResult as V2Result } from "../agents/consensusVerdict.types";
import { computePerformance } from "./validationMetrics";
import type { PaperTrade, SimVsRealReport, SystemPerformance } from "./intelligenceV2.types";

// buildPaperTrade
//
// Creates a paper trade from a v2 verdict. Returns `null` when the
// verdict is not actionable (WAIT / BLOCK / MONITOR_ONLY) or when the
// caller didn't provide entry/SL/TP.
export interface BuildPaperTradeInput {
  v2Result: V2Result;
  signalId: string;
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  id?: string;
  now?: Date;
}

export function buildPaperTrade(input: BuildPaperTradeInput): PaperTrade | null {
  const verdict = input.v2Result.verdict;
  if (verdict !== "EXECUTE" && verdict !== "REDUCE_SIZE") return null;
  const direction = input.v2Result.direction;
  if (!direction) return null;

  const now = input.now ?? new Date();
  return {
    id: input.id ?? `paper-${input.signalId}-${now.getTime()}`,
    signalId: input.signalId,
    symbol: input.symbol,
    direction,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    sizeMultiplier: input.v2Result.recommendedSizeMultiplier,
    v2Confidence: input.v2Result.executionConfidence,
    openedAt: now.toISOString(),
    closedAt: null,
    closedPrice: null,
    realisedR: null,
    status: "OPEN",
  };
}

// closePaperTrade
//
// Resolves an open paper trade with an exit price (or explicit cancel).
// Computes R as (exit − entry) / |entry − stop| signed by direction,
// scaled by the size multiplier so reduced-size verdicts contribute less
// to the P&L tally.
export function closePaperTrade(input: {
  paperTrade: PaperTrade;
  exitPrice: number | null;
  cancelled?: boolean;
  now?: Date;
}): PaperTrade {
  const now = input.now ?? new Date();
  if (input.cancelled || input.exitPrice === null) {
    return { ...input.paperTrade, status: "CANCELLED",
             closedAt: now.toISOString(), closedPrice: null, realisedR: 0 };
  }
  const pt = input.paperTrade;
  const stopDist = Math.abs(pt.entryPrice - pt.stopLoss);
  if (stopDist === 0) {
    return { ...pt, status: "CANCELLED", closedAt: now.toISOString(),
             closedPrice: input.exitPrice, realisedR: 0 };
  }
  const directional = pt.direction === "BUY"
    ? input.exitPrice - pt.entryPrice
    : pt.entryPrice - input.exitPrice;
  const rUnscaled = directional / stopDist;
  const realisedR = rUnscaled * pt.sizeMultiplier;
  return {
    ...pt,
    closedAt: now.toISOString(),
    closedPrice: input.exitPrice,
    realisedR,
    status: realisedR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
  };
}

// compareSimToReal
//
// Reduces a window of paper + real trades into a single side-by-side
// performance report. Used by the validation dashboard to surface "would
// v2 have done better".
export function compareSimToReal(input: {
  paperTrades: PaperTrade[];
  realRList: number[];
  windowStart?: string;
  windowEnd?: string;
}): SimVsRealReport {
  const closedPaper = input.paperTrades.filter(
    (p) => p.status === "CLOSED_WIN" || p.status === "CLOSED_LOSS",
  );
  const paperRList = closedPaper.map((p) => p.realisedR ?? 0);
  const paper: SystemPerformance = computePerformance(paperRList);
  const real: SystemPerformance  = computePerformance(input.realRList);

  const notes: string[] = [];
  if (paper.tradesActed < 30) notes.push(`small paper sample (${paper.tradesActed})`);
  if (real.tradesActed  < 30) notes.push(`small real sample (${real.tradesActed})`);

  return {
    windowStart: input.windowStart ?? new Date(0).toISOString(),
    windowEnd:   input.windowEnd   ?? new Date().toISOString(),
    paperTradeCount: paper.tradesActed,
    realTradeCount:  real.tradesActed,
    paper, real,
    rDelta: paper.totalR - real.totalR,
    notes,
  };
}
