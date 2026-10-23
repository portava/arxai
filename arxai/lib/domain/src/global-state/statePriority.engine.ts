import { z } from "zod/v4";
import { GlobalStateSchema, type GlobalState } from "./globalState.engine";

// ═══════════════════════════════════════════════════════════════════════════
// State Priority — defines which state wins when multiple sources demand
// different states. Higher number = wins.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const STATE_PRIORITY: Readonly<Record<GlobalState, number>> = {
  NORMAL:             0,
  TREND_EXPANSION:    1,
  HIGH_VOLATILITY:    2,
  CHOP_DANGER:        3,
  LOW_LIQUIDITY:      4,
  COGNITIVE_FATIGUE:  5,
  EXECUTION_RISK:     6,
  NEWS_RISK:          7,
  DEFENSIVE_MODE:     8,
  RECOVERY_MODE:      9,
  PRESERVATION_MODE: 10,
  DEGRADED_MODE:    11,
  LOCKDOWN:         12,
  SAFE_SHUTDOWN:    13,
};

export function getStatePriority(state: GlobalState): number {
  return STATE_PRIORITY[state];
}

export function pickHighestPriority(states: ReadonlyArray<GlobalState>): GlobalState {
  if (states.length === 0) return "NORMAL";
  let best: GlobalState = states[0]!;
  for (const s of states) {
    if (STATE_PRIORITY[s] > STATE_PRIORITY[best]) best = s;
  }
  return best;
}

// Whether a state is "primary-only" (cannot run alongside another primary as a substate).
const PRIMARY_ONLY = new Set<GlobalState>([
  "LOCKDOWN", "SAFE_SHUTDOWN", "DEGRADED_MODE", "PRESERVATION_MODE",
  "RECOVERY_MODE",
]);

export const PriorityVerdictSchema = z.object({
  primary: GlobalStateSchema,
  candidates: z.array(GlobalStateSchema),
  isPrimaryOnly: z.boolean(),
});
export type PriorityVerdict = z.infer<typeof PriorityVerdictSchema>;

export function rankStates(states: ReadonlyArray<GlobalState>): PriorityVerdict {
  const primary = pickHighestPriority(states);
  return {
    primary, candidates: [...states], isPrimaryOnly: PRIMARY_ONLY.has(primary),
  };
}

export function isPrimaryOnly(state: GlobalState): boolean {
  return PRIMARY_ONLY.has(state);
}
