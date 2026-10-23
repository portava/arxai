// Task #199 — Missed-opportunity replay reshape. PURE.
//
// Reconstructs "what Ruby saw around the move" from RECORDED data only. It never
// re-derives a signal, re-runs the scanner, or fetches fresh candles — it shapes
// the already-stored at-signal snapshot + observed-move evidence into a readable
// timeline. If a piece of evidence was never recorded it is surfaced as null,
// never invented.

import type { SignalOutcomeStatus, TimingClass } from "./rubyQuality.types";

export interface MissedOpportunityInput {
  outcomeId: string;
  symbol: string;
  timeframe: string;
  session: string | null;
  direction: string | null;
  decision: string;
  outcomeStatus: SignalOutcomeStatus;
  confidenceScore: number;
  edgeScore: number | null;
  flameStage: string | null;
  newsNearby: boolean;
  spreadAtSignal: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  timingClass: TimingClass | null;
  maxFavorableExcursion: number | null;
  maxAdverseExcursion: number | null;
  signalAtMs: number;
  resolvedAtMs: number | null;
  /** Recorded observed candle points {tMs, price}; empty when none stored. */
  observedPath?: { tMs: number; price: number }[];
}

export interface MissedOpportunityReplay {
  outcomeId: string;
  symbol: string;
  timeframe: string;
  verdict: SignalOutcomeStatus;
  whatRubySaw: {
    direction: string | null;
    decision: string;
    confidence: number;
    edge: number | null;
    flameStage: string | null;
    newsNearby: boolean;
    spreadAtSignal: number | null;
    plannedEntry: number | null;
    plannedStop: number | null;
    plannedTarget: number | null;
  };
  howItMoved: {
    maxFavorableExcursion: number | null;
    maxAdverseExcursion: number | null;
    elapsedMs: number | null;
    points: { tMs: number; price: number }[];
    dataComplete: boolean;
  };
  /** Honest note when the replay is reconstructed from sparse evidence. */
  evidenceNote: string;
}

export function buildMissedOpportunityReplay(i: MissedOpportunityInput): MissedOpportunityReplay {
  const points = (i.observedPath ?? []).slice().sort((a, b) => a.tMs - b.tMs);
  const dataComplete = points.length >= 2;
  return {
    outcomeId: i.outcomeId,
    symbol: i.symbol,
    timeframe: i.timeframe,
    verdict: i.outcomeStatus,
    whatRubySaw: {
      direction: i.direction,
      decision: i.decision,
      confidence: i.confidenceScore,
      edge: i.edgeScore,
      flameStage: i.flameStage,
      newsNearby: i.newsNearby,
      spreadAtSignal: i.spreadAtSignal,
      plannedEntry: i.entryPrice,
      plannedStop: i.stopLoss,
      plannedTarget: i.takeProfit,
    },
    howItMoved: {
      maxFavorableExcursion: i.maxFavorableExcursion,
      maxAdverseExcursion: i.maxAdverseExcursion,
      elapsedMs: i.resolvedAtMs != null ? i.resolvedAtMs - i.signalAtMs : null,
      points,
      dataComplete,
    },
    evidenceNote: dataComplete
      ? "Reconstructed from recorded at-signal snapshot and observed move."
      : "Sparse recorded path — only the at-signal snapshot and excursion extremes are available.",
  };
}
