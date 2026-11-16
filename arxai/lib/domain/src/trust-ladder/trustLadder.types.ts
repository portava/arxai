import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// AI Trust Ladder — six rungs of authority, climbed gradually only when
// six promotion gates all pass. Composes with kill-switch and the risk
// governor: this layer caps WHAT the AI is allowed to do; governor and
// kill-switch enforce hard risk rules INDEPENDENTLY. Trust ladder cannot
// "promote past" governor — promotion only widens the AI's authority
// envelope, never bypasses risk.
// ═══════════════════════════════════════════════════════════════════════════

export const TrustRungSchema = z.enum([
  "OBSERVE_ONLY",
  "SUGGEST_ONLY",
  "SHADOW_TRADE",
  "MICRO_LOT_ONLY",
  "LIMITED_AUTO",
  "FULL_AUTO_WITH_GOVERNOR",
]);
export type TrustRung = z.infer<typeof TrustRungSchema>;

export const TRUST_RUNG_ORDER: TrustRung[] = [
  "OBSERVE_ONLY", "SUGGEST_ONLY", "SHADOW_TRADE",
  "MICRO_LOT_ONLY", "LIMITED_AUTO", "FULL_AUTO_WITH_GOVERNOR",
];

export function rungIndex(r: TrustRung): number { return TRUST_RUNG_ORDER.indexOf(r); }

// Snapshot the Trust Ladder evaluates. Caller assembles this from
// regret-engine (calibration error), retrospective (drawdown, expectancy),
// order-execution (execution error rate), and risk-governor compliance log.
export interface PromotionMetricsSnapshot {
  sampleCount: number;                  // graded trades since current rung
  expectancyR: number;                  // average pnlR per trade
  maxDrawdownPct: number;               // peak-to-trough since rung entry
  meanCalibrationErrorPct: number;      // MACE from regret-engine, in pp
  executionErrorRate01: number;         // 0..1 — slippage, reject, partial fills
  riskComplianceScore01: number;        // 0..1 — % of trades fully within policy
  observedAt: string;
}

// Thresholds to advance TO a rung. Failing ANY gate blocks promotion.
export interface PromotionCriteria {
  minSampleCount: number;
  minExpectancyR: number;               // must be ≥ this (typically > 0 for upper rungs)
  maxDrawdownPct: number;               // hard ceiling; breach demotes
  maxCalibrationErrorPct: number;       // ≤ this
  maxExecutionErrorRate01: number;      // ≤ this
  minRiskComplianceScore01: number;     // ≥ this
}

export const PromotionDecisionKindSchema = z.enum(["PROMOTE", "HOLD", "DEMOTE"]);
export type PromotionDecisionKind = z.infer<typeof PromotionDecisionKindSchema>;

export interface PromotionDecision {
  kind: PromotionDecisionKind;
  fromRung: TrustRung;
  toRung: TrustRung;                    // same as fromRung when HOLD
  failedGates: string[];                // human-readable gate identifiers
  reasons: string[];
}

// Action shape this layer modifies (self-contained — no coupling to
// agent-system or kill-switch).
export const RungProposedActionSchema = z.enum(["APPROVE", "APPROVE_REDUCED", "REJECT"]);
export type RungProposedAction = z.infer<typeof RungProposedActionSchema>;

export interface ActionUnderRung {
  action: RungProposedAction;
  sizeMultiplier: number;
  paperOnly: boolean;                   // SHADOW_TRADE / OBSERVE / SUGGEST → true
  suggestionOnly: boolean;              // OBSERVE_ONLY / SUGGEST_ONLY → true
  modifiedReasons: string[];
}

export interface TrustLadderStorePort {
  saveCurrentRung(r: TrustRung, atIso: string): Promise<void>;
  loadCurrentRung(): Promise<{ rung: TrustRung; atIso: string } | null>;
  appendDecision(d: PromotionDecision, atIso: string): Promise<void>;
  listDecisions(): Promise<{ decision: PromotionDecision; atIso: string }[]>;
}

// Default per-rung criteria — gradually stricter as the AI climbs.
// Caller can override entirely via custom map.
export const DEFAULT_PROMOTION_CRITERIA: Record<TrustRung, PromotionCriteria> = {
  // Entry rung — no advancement needed; this defines what's required to ENTER.
  OBSERVE_ONLY: {
    minSampleCount: 0, minExpectancyR: -Infinity, maxDrawdownPct: 100,
    maxCalibrationErrorPct: 100, maxExecutionErrorRate01: 1, minRiskComplianceScore01: 0,
  },
  SUGGEST_ONLY: {
    minSampleCount: 50, minExpectancyR: 0.05, maxDrawdownPct: 15,
    maxCalibrationErrorPct: 25, maxExecutionErrorRate01: 0.20, minRiskComplianceScore01: 0.85,
  },
  SHADOW_TRADE: {
    minSampleCount: 100, minExpectancyR: 0.10, maxDrawdownPct: 12,
    maxCalibrationErrorPct: 20, maxExecutionErrorRate01: 0.15, minRiskComplianceScore01: 0.90,
  },
  MICRO_LOT_ONLY: {
    minSampleCount: 150, minExpectancyR: 0.15, maxDrawdownPct: 10,
    maxCalibrationErrorPct: 15, maxExecutionErrorRate01: 0.10, minRiskComplianceScore01: 0.92,
  },
  LIMITED_AUTO: {
    minSampleCount: 250, minExpectancyR: 0.20, maxDrawdownPct: 8,
    maxCalibrationErrorPct: 12, maxExecutionErrorRate01: 0.08, minRiskComplianceScore01: 0.95,
  },
  FULL_AUTO_WITH_GOVERNOR: {
    minSampleCount: 500, minExpectancyR: 0.25, maxDrawdownPct: 6,
    maxCalibrationErrorPct: 10, maxExecutionErrorRate01: 0.05, minRiskComplianceScore01: 0.97,
  },
};

// Demotion triggered if EITHER:
//   • drawdown ≥ current rung's maxDrawdownPct × 1.25 (severe drawdown), OR
//   • expectancyR < demotionExpectancyFloor AND sampleCount ≥ minDemotionSamples
export const DEMOTION_THRESHOLDS = {
  drawdownSevereMultiplier: 1.25,
  demotionExpectancyFloor: -0.10,
  minDemotionSamples: 30,
} as const;

export const RUNG_AUTHORITY = {
  microLotMultiplier: 0.10,
  limitedAutoMultiplier: 0.50,
} as const;
