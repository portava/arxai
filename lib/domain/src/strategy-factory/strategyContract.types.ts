import { z } from "zod/v4";
import type { StrategyInput, StrategyProposedSignal, StrategyResult } from "../strategies/strategy.types";
import type { TradeDirection } from "../trade/trade.types";

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Contract — capability #13 (constitution compiler).
//
// A declarative, data-only description of WHEN a strategy is allowed to act
// (eligibility), WHAT direction it must take (entry), WHEN it must stay
// silent (invalidation / breakers), and WHAT SHAPE its exits must have
// (exit invariants). The compiler (contractCompiler.engine.ts) turns this
// data into executable invariant tests and a replay-equivalence check
// against the hand-written engine. A disagreement between contract and
// engine is a LOUD failure — never a silent preference for either side.
//
// Rules reference a closed feature vocabulary (contractFeatures.engine.ts)
// that is recomputed independently of the strategy code — that independence
// is what makes equivalence checking meaningful.
//
// Relationship to StrategyConstitution (strategy-constitution/): the
// constitution caps account-level risk per proposed action at runtime; the
// contract pins the strategy's DECISION LOGIC offline. They compose; neither
// replaces the other.
// ═══════════════════════════════════════════════════════════════════════════

// ── Feature vocabulary ──────────────────────────────────────────────────────
// Input features are computable from StrategyInput alone; signal features
// additionally require an emitted StrategyProposedSignal (exit invariants).
export const INPUT_FEATURE_IDS = [
  "candleCount",
  "session",
  "regime",
  "regimeConfidence",
  "volatilityState",
  "atr",
  "lastClose",
  "lastOpen",
  "prevLow",
  "prevHigh",
  "sma20",
  // London-breakout derived features (UTC 00:00–07:00 range of input.now's day)
  "asiaCandleCount",
  "asiaRangeHigh",
  "asiaRangeLow",
  "asiaRangeSize",
  "postAsiaCandleCount",
  "postAsiaBreakDirection",     // "BUY" | "SELL" | null (no break yet)
  // Trend-continuation derived features
  "trendDirection",             // "BUY" | "SELL" | null (not trending)
  "pullbackThroughSma20",       // boolean — prev touched SMA20, last closed trend-side
  "confirmationCandleTrendSide",// boolean — last candle body in trend direction
] as const;
export type InputFeatureId = (typeof INPUT_FEATURE_IDS)[number];

export const SIGNAL_FEATURE_IDS = [
  "signalAction",
  "signalDirection",
  "signalConfidence",
  "signalEntry",
  "signalStop",
  "signalTakeProfit",
  "stopDistance",               // |entry − stop|
  "tpDistance",                 // |tp − entry|
  "rewardRiskRatio",            // tpDistance / stopDistance
  "stopOnLossSide",             // boolean — BUY: stop < entry; SELL: stop > entry
  "tpOnProfitSide",             // boolean — BUY: tp > entry;   SELL: tp < entry
  "stopBeyondAsiaRange",        // boolean — BUY: stop < asiaLow; SELL: stop > asiaHigh
  "tpDistanceVsAsiaRange",      // tpDistance / asiaRangeSize
  "stopDistanceVsAtr",          // stopDistance / atr
] as const;
export type SignalFeatureId = (typeof SIGNAL_FEATURE_IDS)[number];

export type FeatureId = InputFeatureId | SignalFeatureId;

export type FeatureScalar = number | string | boolean | null;

// A feature read either yields a value (null is a legitimate computed value,
// e.g. "no breakout yet") or is UNKNOWN with a typed reason (e.g. not enough
// candles to compute SMA20). UNKNOWN is never coerced to a value — rules over
// UNKNOWN features fail closed toward "must not emit".
export type FeatureValue =
  | { readonly ok: true; readonly value: FeatureScalar }
  | { readonly ok: false; readonly reason: string };

// ── Rules as data ───────────────────────────────────────────────────────────
export type ContractRule =
  | { readonly op: "EQ";       readonly feature: FeatureId; readonly value: number | string | boolean }
  | { readonly op: "NEQ";      readonly feature: FeatureId; readonly value: number | string | boolean }
  | { readonly op: "GT";       readonly feature: FeatureId; readonly value: number }
  | { readonly op: "GTE";      readonly feature: FeatureId; readonly value: number }
  | { readonly op: "LT";       readonly feature: FeatureId; readonly value: number }
  | { readonly op: "LTE";      readonly feature: FeatureId; readonly value: number }
  | { readonly op: "IN";       readonly feature: FeatureId; readonly values: ReadonlyArray<number | string> }
  | { readonly op: "NOT_IN";   readonly feature: FeatureId; readonly values: ReadonlyArray<number | string> }
  | { readonly op: "IS_NULL";  readonly feature: FeatureId }
  | { readonly op: "NOT_NULL"; readonly feature: FeatureId }
  | { readonly op: "APPROX";   readonly feature: FeatureId; readonly value: number; readonly tolerance: number };

export interface NamedRule {
  readonly id: string;          // stable id, used in generated test names
  readonly describe: string;    // human-readable statement of the rule
  readonly rule: ContractRule;
}

export interface ExitInvariants {
  readonly stopRequired: boolean;         // emitted trade signal MUST carry a stop
  readonly takeProfitRequired: boolean;
  readonly rules: ReadonlyArray<NamedRule>; // extra shape rules over signal features
}

export interface ConfidenceBounds {
  readonly min: number;                   // inclusive, 0..100
  readonly max: number;                   // inclusive, 0..100
}

export interface StrategyContract {
  readonly contractId: string;            // e.g. "london-breakout@1.0.0"
  readonly strategyName: string;          // must equal Strategy.name
  readonly strategyVersion: string;       // must equal Strategy.version it describes
  // ALL eligibility rules must hold for the strategy to be allowed to emit.
  readonly eligibility: ReadonlyArray<NamedRule>;
  // ANY invalidation rule holding ⇒ the strategy MUST NOT emit (breakers).
  readonly invalidation: ReadonlyArray<NamedRule>;
  // Feature whose value ("BUY" | "SELL") the emitted direction must equal.
  readonly directionFeature: InputFeatureId;
  readonly exit: ExitInvariants;
  readonly confidence: ConfidenceBounds;
}

// ── Compiler outputs ────────────────────────────────────────────────────────
export const ContractDecisionKindSchema = z.enum(["EMIT", "NO_EMIT"]);
export type ContractDecisionKind = z.infer<typeof ContractDecisionKindSchema>;

export interface ContractDecision {
  readonly decision: ContractDecisionKind;
  readonly direction: TradeDirection | null;   // set when decision === "EMIT"
  readonly reasons: string[];
  // Features that could not be computed. Any unknown ⇒ fail-closed NO_EMIT.
  readonly unknownFeatures: string[];
}

export interface ContractViolation {
  readonly testId: string;
  readonly detail: string;
}

// One invariant test generated by the compiler from contract data.
export interface GeneratedInvariantTest {
  readonly testId: string;
  readonly describe: string;
  // Returns null when the invariant holds; a violation otherwise.
  readonly check: (input: StrategyInput, result: StrategyResult) => ContractViolation | null;
}

export const MismatchKindSchema = z.enum([
  "ENGINE_EMITS_CONTRACT_FORBIDS",
  "ENGINE_SILENT_WHERE_CONTRACT_EMITS",
  "DIRECTION_MISMATCH",
  "INVARIANT_VIOLATION",
]);
export type MismatchKind = z.infer<typeof MismatchKindSchema>;

export interface ReplayMismatch {
  readonly frameIndex: number;
  readonly atIso: string;
  readonly kind: MismatchKind;
  readonly details: string[];
}

export const EquivalenceVerdictSchema = z.enum(["EQUIVALENT", "MISMATCH"]);
export type EquivalenceVerdict = z.infer<typeof EquivalenceVerdictSchema>;

export interface ReplayEquivalenceReport {
  readonly contractId: string;
  readonly strategyName: string;
  readonly strategyVersion: string;
  readonly framesEvaluated: number;
  readonly agreements: number;
  readonly engineEmissions: number;
  readonly contractEmissions: number;
  readonly mismatches: ReplayMismatch[];
  readonly verdict: EquivalenceVerdict;
  readonly reasons: string[];
}

export function isTradeSignal(s: StrategyProposedSignal | null): s is StrategyProposedSignal {
  return s !== null && (s.action === "BUY" || s.action === "SELL");
}
