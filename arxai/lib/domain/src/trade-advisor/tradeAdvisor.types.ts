import { z } from "zod/v4";

// ── Inputs ────────────────────────────────────────────────────────────────
//
// TradeSnapshot is the single read-only input every advisor engine
// consumes. The caller assembles it from open-trade state + live market +
// original entry record. All fields are required; missing measurements
// pass `null` and the engines fail-closed (refuse to give an opinion
// they can't justify).

export const TradeDirectionSchema = z.enum(["BUY", "SELL"]);
export type TradeDirection = z.infer<typeof TradeDirectionSchema>;

export interface OpenTradeFacts {
  tradeId: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  lotSize: number;
  openedAt: string;
  ageSeconds: number;
  pipSize: number;
  // R = (currentPrice - entryPrice) / |entryPrice - stopLoss|, signed by direction.
  // Positive = in profit. The advisor expects this pre-computed by the caller
  // since R requires symbol-specific contract size to be done correctly.
  unrealizedR: number;
}

export interface IntraTradeExtremes {
  highSinceOpen: number;
  lowSinceOpen: number;
  // R-multiples — same convention as unrealizedR.
  maxFavorableExcursionR: number;       // peak gain since open
  maxAdverseExcursionR: number;         // worst drawdown since open (≤ 0)
}

export interface MarketContextNow {
  currentPrice: number;
  currentSpreadPips: number;
  spreadAtEntryPips: number | null;     // null if not recorded
  volatilityAtEntry: number | null;     // null if not recorded
  volatilityNow: number | null;
  sessionStress01: number;              // 0..1 from session sensor
}

export interface OriginalEntryConviction {
  originalConfidence: number;           // 0..100, from consensus at entry
  originalDirection: TradeDirection;    // must match OpenTradeFacts.direction
  originalConsensusVerdict: string;     // free-form tag, e.g. "EXECUTE" / "REDUCE_SIZE"
  expectedHoldSeconds: number;          // strategy's expected duration
}

export interface LiveReEvaluation {
  // Optional — present only when the agent layer was re-run live for this trade.
  currentConfidence: number | null;
  currentDirectionAgreement: number | null;  // 0..1
  // True when the freshly-run consensus says the OPPOSITE direction is now favored.
  agentDirectionReversed: boolean;
}

export interface TradeSnapshot {
  trade: OpenTradeFacts;
  extremes: IntraTradeExtremes;
  market: MarketContextNow;
  entry: OriginalEntryConviction;
  live: LiveReEvaluation;
  now?: Date;
}

// ── Output: tiered statuses shared across reports ─────────────────────────
export const HealthStatusSchema   = z.enum(["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"]);
export const ExitWarningLevelSchema = z.enum(["NONE", "WATCH", "CONSIDER", "STRONG"]);
export const DangerTierSchema     = z.enum(["SAFE", "ELEVATED", "HIGH", "CRITICAL"]);
export const StopActionSchema     = z.enum([
  "NONE", "MOVE_TO_BE", "TRAIL", "TIGHTEN", "WIDEN_REFUSED",
]);

export type HealthStatus     = z.infer<typeof HealthStatusSchema>;
export type ExitWarningLevel = z.infer<typeof ExitWarningLevelSchema>;
export type DangerTier       = z.infer<typeof DangerTierSchema>;
export type StopAction       = z.infer<typeof StopActionSchema>;

// ── 1. Trade health ───────────────────────────────────────────────────────
export interface HealthReport {
  score: number;                 // 0..100, higher = healthier
  status: HealthStatus;
  factors: {
    pnlContribution: number;       // signed
    mfeRetracementPenalty: number; // 0..− (negative = penalty)
    ageStretchPenalty: number;
    spreadPressurePenalty: number;
    conditionDriftPenalty: number;
  };
  reasons: string[];
}

// ── 2. Confidence decay ───────────────────────────────────────────────────
export const DecayDriverSchema = z.enum([
  "TIME", "MAE_PRESSURE", "AGENT_REVERSAL", "CONDITION_DRIFT", "NO_DECAY",
]);
export type DecayDriver = z.infer<typeof DecayDriverSchema>;

export interface ConfidenceDecayReport {
  originalConfidence: number;
  derivedCurrentConfidence: number;     // bounded [0..100]
  decay: number;                         // originalConfidence − derivedCurrentConfidence, ≥ 0
  primaryDriver: DecayDriver;
  contributions: Record<Exclude<DecayDriver, "NO_DECAY">, number>; // each ≥ 0
  reasons: string[];
}

// ── 3. Exit warning ───────────────────────────────────────────────────────
export interface ExitWarning {
  level: ExitWarningLevel;
  urgency: number;                  // 0..100
  triggers: string[];               // structured trigger tags
  reasons: string[];
}

// ── 4. Partial profit suggestion ──────────────────────────────────────────
export interface PartialProfitSuggestion {
  suggested: boolean;
  fraction: 0.25 | 0.5 | 0.75 | null;
  reason: string;
  // What the next R milestone is and what fraction to take when reached.
  nextMilestone: { atUnrealizedR: number; fraction: 0.25 | 0.5 | 0.75 } | null;
}

// ── 5. Stop movement suggestion ───────────────────────────────────────────
export interface StopMovementSuggestion {
  action: StopAction;
  newStopLoss: number | null;       // null when action is NONE or WIDEN_REFUSED
  distancePips: number | null;      // distance from current price; null when NONE
  reasons: string[];
  blockers: string[];               // e.g. "movement would widen — refused"
}

// ── 6. Danger score ───────────────────────────────────────────────────────
export interface DangerScore {
  score: number;                    // 0..100, higher = more dangerous
  tier: DangerTier;
  contributors: {
    maeProximity: number;             // closeness to stop, 0..100
    conditionDrift: number;
    spreadShock: number;
    ageDecay: number;
    agentReversalPenalty: number;
  };
  reasons: string[];
}

// ── Combined output ───────────────────────────────────────────────────────
export interface TradeAdvisoryResult {
  tradeId: string;
  evaluatedAt: string;
  health: HealthReport;
  confidenceDecay: ConfidenceDecayReport;
  exitWarning: ExitWarning;
  partialProfit: PartialProfitSuggestion;
  stopMovement: StopMovementSuggestion;
  danger: DangerScore;
}

// ── Constants — single source of truth for thresholds ────────────────────
export const TRADE_ADVISOR_THRESHOLDS = {
  health: {
    excellent: 80, good: 60, fair: 40, poor: 20, // anything < poor → CRITICAL
  },
  partialProfit: {
    firstAtR: 1.0, secondAtR: 2.0, thirdAtR: 3.0,
  },
  stopMovement: {
    moveToBeAtR: 1.0,
    trailAtR: 2.0,
    tightenAfterMfeRetracementPct: 0.50,  // when MFE has retraced ≥ 50%
  },
  decay: {
    agentReversalDecay: 60,       // hard penalty if v2 says opposite direction
    timeDecayPerOverstayHr: 10,   // per hour past expectedHoldSeconds
    maeDecayPerR: 25,             // per |R| of MAE
    conditionDriftMaxDecay: 25,
  },
  danger: {
    safeMax: 25, elevatedMax: 50, highMax: 75, // > highMax → CRITICAL
  },
  exit: {
    healthCriticalAt: 30,
    dangerStrongAt: 75,
    decayConsiderAt: 50,
  },
} as const;
