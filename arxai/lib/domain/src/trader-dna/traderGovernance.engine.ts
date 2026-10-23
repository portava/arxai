// ═══════════════════════════════════════════════════════════════════════════
// Trader DNA Governance — Phase 5 closeout
//
// Pure derivations that turn the trader/cognitive named outputs into the
// scalars the safety stack already consumes:
//
//   PRODUCER                                    →  CONSUMER (safetyCore slot)
//   traderRiskScore.score01 / .permission       →  tradeGate({ traderRisk01 })
//                                                  blended into cognitiveRisk
//   recommendedPermissionLevel                  →  driveGlobalState
//                                                  ({ recommendedPermissionLevel })
//                                                  → controlTowerForcedState
//
// SAFETY: pure functions; no side-effects; cannot place trades.
// Caller-orchestrated: trader-dna does NOT import safetyCore. The
// orchestrator (route handler / brain) forwards the named scalars.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import {
  PermissionLevelSchema, type PermissionLevel,
} from "./traderDNA.types";

export const ControlTowerStateSchema = z.enum([
  "NORMAL", "HIGH_VOLATILITY", "TREND_EXPANSION", "CHOP_DANGER",
  "NEWS_RISK", "LOW_LIQUIDITY", "EXECUTION_RISK", "COGNITIVE_FATIGUE",
  "DEFENSIVE_MODE", "PRESERVATION_MODE", "RECOVERY_MODE",
  "DEGRADED_MODE", "SAFE_SHUTDOWN",
]);
export type ControlTowerState = z.infer<typeof ControlTowerStateSchema>;

export const PermissionToStateMappingSchema = z.object({
  permission: PermissionLevelSchema,
  forcedState: ControlTowerStateSchema.nullable(),
  reason: z.string(),
});
export type PermissionToStateMapping = z.infer<typeof PermissionToStateMappingSchema>;

/**
 * Map a recommended permission level into a GlobalState that Control Tower
 * can force via `controlTowerForcedState`. Soft levels return null
 * (no force — only logged as a soft signal).
 *
 *   FULL     → null               (no force; nominal trading)
 *   REDUCED  → null               (sizing is throttled by other engines)
 *   MICRO    → null               (sizing throttle handles this)
 *   COOLDOWN → RECOVERY_MODE      (forces non-trading until permission restored)
 *   LOCKDOWN → RECOVERY_MODE      (forces non-trading; stronger reasoning)
 */
export function permissionLevelToControlTowerForcedState(
  permission: PermissionLevel,
): PermissionToStateMapping {
  switch (permission) {
    case "FULL":
      return { permission, forcedState: null, reason: "permission FULL — no tower force" };
    case "REDUCED":
      return { permission, forcedState: null, reason: "permission REDUCED — sizing throttle handles" };
    case "MICRO":
      return { permission, forcedState: null, reason: "permission MICRO — sizing throttle handles" };
    case "COOLDOWN":
      return { permission, forcedState: "RECOVERY_MODE",
        reason: "permission COOLDOWN — Control Tower forces RECOVERY_MODE" };
    case "LOCKDOWN":
      return { permission, forcedState: "RECOVERY_MODE",
        reason: "permission LOCKDOWN — Control Tower forces RECOVERY_MODE" };
  }
}

/**
 * Pick the strongest permission level across the trader-DNA recommendation
 * and the cognitive throttle recommendation, so a single source raising the
 * level always wins. Order: FULL < REDUCED < MICRO < COOLDOWN < LOCKDOWN.
 */
const PERMISSION_RANK: Record<PermissionLevel, number> = {
  FULL: 0, REDUCED: 1, MICRO: 2, COOLDOWN: 3, LOCKDOWN: 4,
};
export function strongestPermissionLevel(...levels: PermissionLevel[]): PermissionLevel {
  let winner: PermissionLevel = "FULL";
  for (const l of levels) {
    if (PERMISSION_RANK[l] > PERMISSION_RANK[winner]) winner = l;
  }
  return winner;
}
