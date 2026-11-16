import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Research AI — generates strategy hypotheses and ranks them by
// plausibility, novelty, and fit. Output feeds the strategy-pipeline at
// the HYPOTHESIS stage. Research AI NEVER touches execution; it only
// proposes ideas that must then survive the 7-stage promotion gauntlet.
// ═══════════════════════════════════════════════════════════════════════════

export const HypothesisKindSchema = z.enum([
  "TREND_FOLLOWING",
  "MEAN_REVERSION",
  "BREAKOUT",
  "LIQUIDITY_SWEEP",
  "VOLATILITY_EXPANSION",
  "CARRY",
  "NEWS_DRIVEN",
  "STRUCTURAL",
  "OTHER",
]);
export type HypothesisKind = z.infer<typeof HypothesisKindSchema>;

export interface Hypothesis {
  hypothesisId: string;
  kind: HypothesisKind;
  thesis: string;                       // human-readable claim
  preconditions: string[];              // observable conditions required
  invalidation: string;                 // what would prove it wrong
  proposedSymbols: string[];
  proposedTimeframe: string;            // "1m", "5m", "1h", etc
  expectedEdgeR: number;                // unsigned guess at edge per trade
  confidenceFromAuthor: number;         // 0..100
  createdAt: string;
}

export interface HypothesisScore {
  hypothesisId: string;
  plausibility01: number;               // does the thesis make sense given regime + history?
  novelty01: number;                    // is this distinct from existing strategies?
  fit01: number;                        // does it match current market regime?
  composite01: number;                  // weighted blend
  reasons: string[];
}

// IO behind a Port — real impl calls LLM or rule-based research engine.
export interface HypothesisGeneratorPort {
  proposeHypotheses(input: {
    marketContext: string;
    existingStrategyIds: string[];
    maxToReturn: number;
  }): Promise<Hypothesis[]>;
}

export const RESEARCH_WEIGHTS = {
  plausibility: 0.50,
  novelty: 0.20,
  fit: 0.30,
} as const;
