import { z } from "zod/v4";

// Do Nothing Intelligence — track every decline ("we did NOT trade")
// and grade the counterfactual: would we have won or lost?
// Treats correct no-trades as wins; wrong no-trades surface as missed
// opportunities for the edge-map and trade-court.

export const DeclineKindSchema = z.enum([
  "REVENGE_BLOCKED",        // tilt/streak/cooldown saved the operator
  "FAKE_BREAKOUT_SKIPPED",  // structure looked weak, we passed
  "OVERTRADE_PREVENTED",    // already at concurrency / daily-trade ceiling
  "NEWS_BLACKOUT",          // high-impact news within window
  "LOW_QUALITY_SETUP",      // judge / governor rejected on quality
  "SPREAD_TOO_WIDE",        // execution-quality gate
  "NORMAL_NO_SETUP",        // no signal — baseline
]);
export type DeclineKind = z.infer<typeof DeclineKindSchema>;

export interface NoTradeRecord {
  noTradeId: string;
  recordedAt: string;
  symbol: string;
  proposedDirection: "BUY" | "SELL" | null;   // null = no signal
  declineKind: DeclineKind;
  declineReasons: string[];
}

// What price did over the next N seconds after the decline.
export interface PostDeclinePriceWindow {
  noTradeId: string;
  windowSeconds: number;
  priceAtDecline: number;
  highSinceDecline: number;
  lowSinceDecline: number;
  priceNow: number;
}

export const CounterfactualVerdictSchema = z.enum([
  "DECLINE_WAS_RIGHT",      // price went against the proposed direction (we'd have lost)
  "DECLINE_WAS_WRONG",      // price went with proposed direction (we missed a winner)
  "DECLINE_NEUTRAL",        // small movement either way
  "INSUFFICIENT_WINDOW",    // not enough time passed to judge yet
]);
export type CounterfactualVerdict = z.infer<typeof CounterfactualVerdictSchema>;

export interface CounterfactualOutcome {
  noTradeId: string;
  verdict: CounterfactualVerdict;
  estimatedPreventedR: number;     // positive = saved us this many R
  estimatedMissedR: number;        // positive = we missed this many R of upside
  reasons: string[];
}

export interface DoNothingScorecard {
  totalDeclines: number;
  byKind: Partial<Record<DeclineKind, number>>;
  byVerdict: Partial<Record<CounterfactualVerdict, number>>;
  preventedRSum: number;
  missedRSum: number;
  netDoNothingEdgeR: number;       // prevented − missed
  reasons: string[];
}

export interface NoTradeStorePort {
  putRecord(r: NoTradeRecord): Promise<void>;
  putOutcome(o: CounterfactualOutcome): Promise<void>;
  listOutcomes(filter?: { since?: Date; until?: Date }): Promise<CounterfactualOutcome[]>;
  listRecords(filter?: { since?: Date; until?: Date }): Promise<NoTradeRecord[]>;
}

export const DO_NOTHING_THRESHOLDS = {
  // Anything within this many R of zero = NEUTRAL
  neutralBandR: 0.20,
  // Window in which counterfactual is meaningful; before this = INSUFFICIENT
  minWindowSeconds: 300,
  // Default 1R distance assumed (caller can override per record)
  defaultRiskPerUnitPipDistance: 1.0,
} as const;
