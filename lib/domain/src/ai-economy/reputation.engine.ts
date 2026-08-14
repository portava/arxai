import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Reputation — what the agent has DEMONSTRATED, not what it claims.
// Earned only through real, graded performance events. Updated as an
// exponentially-weighted moving average so recent behaviour matters more
// than ancient wins.
// ═══════════════════════════════════════════════════════════════════════════

export const ReputationEventSchema = z.object({
  agentId: z.string().min(1),
  pnlR: z.number(),                          // realized R-multiple of the trade
  withinRiskPolicy: z.boolean(),             // false = governor had to veto
  calibrationErrorPct: z.number().min(0),    // 0 = perfect; 100 = wildly wrong
  drawdownContributionPct: z.number().min(0),// agent-attributable dd of this trade
  observedAtIso: z.string(),
});
export type ReputationEvent = z.infer<typeof ReputationEventSchema>;

export const ReputationStateSchema = z.object({
  agentId: z.string().min(1),
  reputation01: z.number().min(0).max(1),
  sampleCount: z.int().nonnegative(),
  lastUpdatedIso: z.string(),
});
export type ReputationState = z.infer<typeof ReputationStateSchema>;

// EMA blend factor — small alpha so reputation moves slowly and is hard to
// fake with one lucky trade.
export const REPUTATION_TUNING = {
  emaAlpha: 0.05,
  // Per-event sub-scores weighted into a single 0..1 outcome.
  weights: { pnl: 0.35, policy: 0.25, calibration: 0.20, drawdown: 0.20 },
  // Calibration normalisation: 25pp error → 0 reputation contribution.
  calibrationFloorPct: 25,
  drawdownFloorPct: 5,                       // 5% trade-attributable dd → 0 contribution
  // pnlR is squashed to 0..1 around 0R (loss) → 1R (clear win).
  pnlSaturationR: 1.0,
} as const;

export interface ReputationUpdateResult {
  next: ReputationState;
  eventScore01: number;
  reasons: string[];
}

export function updateReputation(
  prev: ReputationState,
  event: ReputationEvent,
): ReputationUpdateResult {
  if (prev.agentId !== event.agentId) {
    throw new Error(`reputation update agentId mismatch: ${prev.agentId} vs ${event.agentId}`);
  }
  const T = REPUTATION_TUNING;
  const W = T.weights;

  // Per-component sub-scores in 0..1.
  const pnl01 = clamp01((event.pnlR + T.pnlSaturationR) / (2 * T.pnlSaturationR));
  const policy01 = event.withinRiskPolicy ? 1 : 0;
  const calibration01 = clamp01(1 - event.calibrationErrorPct / T.calibrationFloorPct);
  const dd01 = clamp01(1 - event.drawdownContributionPct / T.drawdownFloorPct);

  const eventScore01 = pnl01 * W.pnl
                     + policy01 * W.policy
                     + calibration01 * W.calibration
                     + dd01 * W.drawdown;

  const next01 = clamp01(prev.reputation01 * (1 - T.emaAlpha) + eventScore01 * T.emaAlpha);

  return {
    next: {
      agentId: prev.agentId,
      reputation01: next01,
      sampleCount: prev.sampleCount + 1,
      lastUpdatedIso: event.observedAtIso,
    },
    eventScore01,
    reasons: [
      `pnl01 ${pnl01.toFixed(3)} (pnlR ${event.pnlR.toFixed(2)})`,
      `policy01 ${policy01.toFixed(3)} (${event.withinRiskPolicy ? "within" : "BREACHED"})`,
      `calibration01 ${calibration01.toFixed(3)} (errPp ${event.calibrationErrorPct.toFixed(1)})`,
      `dd01 ${dd01.toFixed(3)} (contribPct ${event.drawdownContributionPct.toFixed(2)})`,
      `eventScore ${eventScore01.toFixed(3)} → EMA(α=${T.emaAlpha}) → ${next01.toFixed(3)}`,
    ],
  };
}

export function seedReputation(agentId: string, observedAtIso: string): ReputationState {
  return { agentId, reputation01: 0.5, sampleCount: 0, lastUpdatedIso: observedAtIso };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
