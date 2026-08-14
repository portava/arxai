import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Reputation — separate ledger for STRATEGIES (vs agents).
// Composite of validation / replay / micro-live / survival / execution /
// decision quality. Each contributor is 0..1; weights enforce
// "survival > raw profit". Updated via EMA so a single hot streak cannot
// rocket a strategy past gating thresholds.
// ═══════════════════════════════════════════════════════════════════════════

export const StrategyReputationEventSchema = z.object({
  strategyId: z.string().min(1),
  validationScore01: z.number().min(0).max(1),
  replayScore01: z.number().min(0).max(1),
  liveMicroExpectancyR: z.number(),
  survivalScore01: z.number().min(0).max(1),
  executionQuality01: z.number().min(0).max(1),
  decisionQuality01: z.number().min(0).max(1),
  observedAtIso: z.string(),
});
export type StrategyReputationEvent = z.infer<typeof StrategyReputationEventSchema>;

export const StrategyReputationStateSchema = z.object({
  strategyId: z.string().min(1),
  reputation01: z.number().min(0).max(1),
  sampleCount: z.int().nonnegative(),
  lastUpdatedIso: z.string(),
});
export type StrategyReputationState = z.infer<typeof StrategyReputationStateSchema>;

export const STRATEGY_REPUTATION_TUNING = {
  emaAlpha: 0.04,                              // slower than agent EMA
  weights: {
    validation: 0.18,
    replay:     0.15,
    liveMicro:  0.17,
    survival:   0.25,                          // highest single weight
    execution:  0.13,
    decision:   0.12,
  },
  liveMicroSaturationR: 0.5,
} as const;

export interface StrategyReputationUpdateResult {
  next: StrategyReputationState;
  eventScore01: number;
  reasons: string[];
}

export function updateStrategyReputation(
  prev: StrategyReputationState,
  event: StrategyReputationEvent,
): StrategyReputationUpdateResult {
  if (prev.strategyId !== event.strategyId) {
    throw new Error(`strategy reputation update strategyId mismatch: ${prev.strategyId} vs ${event.strategyId}`);
  }
  const T = STRATEGY_REPUTATION_TUNING;
  const W = T.weights;

  const live01 = clamp01(
    (event.liveMicroExpectancyR + T.liveMicroSaturationR) / (2 * T.liveMicroSaturationR),
  );
  const eventScore01 = clamp01(
    event.validationScore01 * W.validation
    + event.replayScore01    * W.replay
    + live01                 * W.liveMicro
    + event.survivalScore01  * W.survival
    + event.executionQuality01 * W.execution
    + event.decisionQuality01  * W.decision,
  );

  const next01 = clamp01(prev.reputation01 * (1 - T.emaAlpha) + eventScore01 * T.emaAlpha);

  return {
    next: {
      strategyId: prev.strategyId,
      reputation01: next01,
      sampleCount: prev.sampleCount + 1,
      lastUpdatedIso: event.observedAtIso,
    },
    eventScore01,
    reasons: [
      `validation ${event.validationScore01.toFixed(3)} × ${W.validation}`,
      `replay ${event.replayScore01.toFixed(3)} × ${W.replay}`,
      `liveMicro ${live01.toFixed(3)} (R=${event.liveMicroExpectancyR.toFixed(2)}) × ${W.liveMicro}`,
      `survival ${event.survivalScore01.toFixed(3)} × ${W.survival}`,
      `execution ${event.executionQuality01.toFixed(3)} × ${W.execution}`,
      `decision ${event.decisionQuality01.toFixed(3)} × ${W.decision}`,
      `eventScore ${eventScore01.toFixed(3)} → EMA(α=${T.emaAlpha}) → ${next01.toFixed(3)}`,
    ],
  };
}

export function seedStrategyReputation(
  strategyId: string, observedAtIso: string,
): StrategyReputationState {
  return { strategyId, reputation01: 0.5, sampleCount: 0, lastUpdatedIso: observedAtIso };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
