import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Decision Q&A — post-hoc introspection. Six questions every trader asks
// after the fact:
//   1. Was blocking this trade correct?
//   2. Would this trade have won?
//   3. Was the entry too early?
//   4. Was the entry too late?
//   5. Did we avoid a loss?
//   6. Did we miss a high-quality winner?
//
// Each question is a pure function returning a structured Answer with
//   • verdict     — categorical
//   • confidence  — 0..100 (how strong is the evidence)
//   • evidence    — typed facts that drove the verdict (caller can render)
//   • reasons[]   — narrative trace
//
// Self-contained: no imports from other subdomains. Caller adapts their
// decision/outcome data into the small input shapes below.
// ═══════════════════════════════════════════════════════════════════════════

export const TradeDirSchema = z.enum(["BUY", "SELL"]);
export type TradeDir = z.infer<typeof TradeDirSchema>;

// Optional bar-by-bar input for higher-fidelity SL-vs-TP ordering.
export interface PriceBar {
  openTime: string;
  high: number;
  low: number;
  close: number;
}

// Price action across an evaluation window. Summary high/low always required;
// `bars` optional for ordered SL/TP detection.
export interface PriceWindow {
  startPrice: number;
  highSinceStart: number;
  lowSinceStart: number;
  endPrice: number;
  windowSeconds: number;
  bars?: PriceBar[];
}

// The hypothetical (or actual) trade we're reasoning about.
export interface HypotheticalSetup {
  direction: TradeDir;
  entryPrice: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  riskPerUnitPrice: number;     // price distance representing 1R
}

// Q1 / Q2 / Q5 / Q6 input — a decision NOT to trade + what happened after.
export interface DeclineQAContext {
  setup: HypotheticalSetup;
  postDeclineWindow: PriceWindow;
  recordedAt: string;
}

// Q3 / Q4 input — a trade that DID execute + what happened around it.
export interface ExecutionQAContext {
  setup: HypotheticalSetup;       // entryPrice = ACTUAL fill price
  intendedEntryPrice: number;     // signal-time intended price (slippage)
  signalAt: string;
  enteredAt: string;
  preEntryWindow: PriceWindow;    // signal → actual entry
  postEntryWindow: PriceWindow;   // entry → close (or now)
  realizedPnlR: number;
  pipSize: number;
}

// ── Shared counterfactual simulation result ──────────────────────────────
export const SimVerdictSchema = z.enum([
  "TP_HIT_FIRST",
  "SL_HIT_FIRST",
  "BOTH_TOUCHED_AMBIGUOUS",      // both touched within window, no bar order
  "NEITHER_TOUCHED",
  "WINDOW_TOO_SHORT",
]);
export type SimVerdict = z.infer<typeof SimVerdictSchema>;

export interface CounterfactualSim {
  simVerdict: SimVerdict;
  simulatedPnlR: number;
  mfeR: number;                   // max favorable in proposed direction
  maeR: number;                   // max adverse
  windowAdequate: boolean;
  reasons: string[];
}

// ── Per-question answer types ────────────────────────────────────────────
export const QBlockVerdictSchema = z.enum([
  "BLOCK_WAS_CORRECT", "BLOCK_WAS_WRONG", "INCONCLUSIVE", "INSUFFICIENT_EVIDENCE",
]);
export type QBlockVerdict = z.infer<typeof QBlockVerdictSchema>;
export interface QBlockAnswer {
  verdict: QBlockVerdict;
  confidence: number;
  evidence: CounterfactualSim;
  reasons: string[];
}

export const QWouldWinVerdictSchema = z.enum([
  "WOULD_HAVE_WON", "WOULD_HAVE_LOST", "WOULD_HAVE_SCRATCHED", "INSUFFICIENT_EVIDENCE",
]);
export type QWouldWinVerdict = z.infer<typeof QWouldWinVerdictSchema>;
export interface QWouldWinAnswer {
  verdict: QWouldWinVerdict;
  confidence: number;
  evidence: CounterfactualSim;
  reasons: string[];
}

export const QTimingVerdictSchema = z.enum([
  "TOO_EARLY", "TOO_LATE", "TIMELY", "INCONCLUSIVE",
]);
export type QTimingVerdict = z.infer<typeof QTimingVerdictSchema>;
export interface QTimingAnswer {
  verdict: QTimingVerdict;
  confidence: number;
  evidence: {
    maeR?: number;
    mfeR?: number;
    realizedPnlR?: number;
    entrySlippagePips?: number;
    preEntryFavorableMovePips?: number;
  };
  reasons: string[];
}

export const QAvoidedLossVerdictSchema = z.enum([
  "AVOIDED_LOSS", "NO_LOSS_TO_AVOID", "INCONCLUSIVE", "INSUFFICIENT_EVIDENCE",
]);
export type QAvoidedLossVerdict = z.infer<typeof QAvoidedLossVerdictSchema>;
export interface QAvoidedLossAnswer {
  verdict: QAvoidedLossVerdict;
  confidence: number;
  evidence: CounterfactualSim;
  reasons: string[];
}

export const QMissedWinnerVerdictSchema = z.enum([
  "MISSED_HIGH_QUALITY_WINNER", "MISSED_SMALL_WINNER",
  "NO_WINNER_MISSED", "INSUFFICIENT_EVIDENCE",
]);
export type QMissedWinnerVerdict = z.infer<typeof QMissedWinnerVerdictSchema>;
export interface QMissedWinnerAnswer {
  verdict: QMissedWinnerVerdict;
  confidence: number;
  evidence: CounterfactualSim;
  reasons: string[];
}

export const DECISION_QA_THRESHOLDS = {
  neutralBandR: 0.20,             // |pnl| ≤ 0.20R = scratch / inconclusive
  highQualityWinnerR: 1.5,        // ≥ 1.5R = high-quality winner
  minWindowSeconds: 300,          // <5min = window too short to judge
  earlyMaeR: 0.5,                 // MAE ≥ 0.5R after entry = too early
  lateSlippagePips: 5,            // adverse slippage / pre-entry move ≥ 5p = too late
} as const;
