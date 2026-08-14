import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Discipline Score — does this agent FOLLOW the rules?
//
// Discipline penalises:
//   • risk policy breaches (Risk Governor had to override)
//   • attempts to override the kill-switch / risk-governor
//   • missed or moved stops
//   • size violations (asked for more lots than allowed)
//
// The score moves DOWN fast (single breach is meaningful) and UP slowly
// (you must demonstrate sustained good behaviour). EMA-style with an
// asymmetric alpha.
// ═══════════════════════════════════════════════════════════════════════════

export const DisciplineEventSchema = z.object({
  agentId: z.string().min(1),
  riskPolicyBreaches: z.int().nonnegative(),
  governorOverrideAttempts: z.int().nonnegative(),
  movedOrMissedStops: z.int().nonnegative(),
  sizeViolations: z.int().nonnegative(),
  cleanActionsInWindow: z.int().nonnegative(),
  observedAtIso: z.string(),
});
export type DisciplineEvent = z.infer<typeof DisciplineEventSchema>;

export const DisciplineStateSchema = z.object({
  agentId: z.string().min(1),
  discipline01: z.number().min(0).max(1),
  sampleCount: z.int().nonnegative(),
  lastUpdatedIso: z.string(),
});
export type DisciplineState = z.infer<typeof DisciplineStateSchema>;

// Per-violation penalties (subtracted from per-event score before EMA).
export const DISCIPLINE_TUNING = {
  perRiskBreach: 0.20,
  perGovernorOverride: 0.40,                 // attempts to bypass the governor are severe
  perMovedStop: 0.10,
  perSizeViolation: 0.15,
  // Asymmetric EMA — fast down, slow up.
  alphaUp: 0.02,
  alphaDown: 0.25,
  // Need at least this many clean actions for an event to count toward UP.
  minCleanActionsForCredit: 5,
} as const;

export interface DisciplineUpdateResult {
  next: DisciplineState;
  eventScore01: number;
  totalViolations: number;
  reasons: string[];
}

export function updateDisciplineScore(
  prev: DisciplineState,
  event: DisciplineEvent,
): DisciplineUpdateResult {
  if (prev.agentId !== event.agentId) {
    throw new Error(`discipline update agentId mismatch: ${prev.agentId} vs ${event.agentId}`);
  }
  const T = DISCIPLINE_TUNING;
  const violations = event.riskPolicyBreaches
                   + event.governorOverrideAttempts
                   + event.movedOrMissedStops
                   + event.sizeViolations;

  const penalty = event.riskPolicyBreaches      * T.perRiskBreach
                + event.governorOverrideAttempts * T.perGovernorOverride
                + event.movedOrMissedStops       * T.perMovedStop
                + event.sizeViolations           * T.perSizeViolation;

  const eventScore01 = clamp01(1 - penalty);

  // Asymmetric EMA: if event is below current state, use alphaDown; above, alphaUp.
  // UP is gated on having enough clean actions in the window.
  const alpha = eventScore01 < prev.discipline01
    ? T.alphaDown
    : (event.cleanActionsInWindow >= T.minCleanActionsForCredit ? T.alphaUp : 0);

  const next01 = clamp01(prev.discipline01 * (1 - alpha) + eventScore01 * alpha);

  return {
    next: {
      agentId: prev.agentId,
      discipline01: next01,
      sampleCount: prev.sampleCount + 1,
      lastUpdatedIso: event.observedAtIso,
    },
    eventScore01,
    totalViolations: violations,
    reasons: [
      `violations=${violations} (riskBreach ${event.riskPolicyBreaches}, governorOverride ${event.governorOverrideAttempts}, movedStop ${event.movedOrMissedStops}, sizeViolation ${event.sizeViolations})`,
      `cleanActions=${event.cleanActionsInWindow}`,
      `eventScore ${eventScore01.toFixed(3)} (penalty ${penalty.toFixed(3)})`,
      `EMA α=${alpha.toFixed(2)} (${alpha === T.alphaDown ? "DOWN" : alpha === T.alphaUp ? "UP" : "HOLD"}) → ${next01.toFixed(3)}`,
    ],
  };
}

export function seedDiscipline(agentId: string, observedAtIso: string): DisciplineState {
  return { agentId, discipline01: 1.0, sampleCount: 0, lastUpdatedIso: observedAtIso };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
