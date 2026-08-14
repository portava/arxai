import { z } from "zod/v4";
import {
  GlobalStateSchema, StateProfileSchema,
  getStateProfile, intersectProfiles, type GlobalState, type StateProfile,
} from "./globalState.engine";
import {
  TransitionInputsSchema, TransitionDemandSchema, deriveDemands, requiresForceToExit,
  type TransitionInputs, type TransitionDemand,
} from "./transitionRules.engine";
import { resolveConflicts, ConflictResolutionSchema } from "./stateConflictResolver.engine";

// ═══════════════════════════════════════════════════════════════════════════
// State Machine — orchestrates the per-cycle transition.
//
//   inputs → deriveDemands → resolveConflicts → guard exits → next state
//
// Returns: next primary, substates, composed effective profile, the
// transition record (to be persisted by the caller into the Black Box
// Vault via stateHistory.store), and structured reasons / blockers.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const StateMachineInputSchema = z.object({
  generatedAtIso: z.string(),
  currentState: GlobalStateSchema,
  currentSubstates: z.array(GlobalStateSchema),
  inputs: TransitionInputsSchema,
});
export type StateMachineInput = z.infer<typeof StateMachineInputSchema>;

export const StateTransitionRecordSchema = z.object({
  generatedAtIso: z.string(),
  fromState: GlobalStateSchema,
  toState: GlobalStateSchema,
  fromSubstates: z.array(GlobalStateSchema),
  toSubstates: z.array(GlobalStateSchema),
  changed: z.boolean(),
  acceptedDemands: z.array(TransitionDemandSchema),
  rejectedDemands: z.array(TransitionDemandSchema),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type StateTransitionRecord = z.infer<typeof StateTransitionRecordSchema>;

export const StateMachineVerdictSchema = z.object({
  generatedAtIso: z.string(),
  nextState: GlobalStateSchema,
  nextSubstates: z.array(GlobalStateSchema),
  effectiveProfile: StateProfileSchema,
  transitionRecord: StateTransitionRecordSchema,
  resolution: ConflictResolutionSchema,
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type StateMachineVerdict = z.infer<typeof StateMachineVerdictSchema>;

export function runStateMachine(input: StateMachineInput): StateMachineVerdict {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const demands = deriveDemands(input.inputs);
  const resolution = resolveConflicts(demands);

  let nextState: GlobalState = resolution.primary;
  let nextSubstates: GlobalState[] = [...resolution.substates];

  // Guard: terminal states (LOCKDOWN, SAFE_SHUTDOWN) need force to exit.
  if (requiresForceToExit(input.currentState) && nextState !== input.currentState) {
    const forcedExit = resolution.acceptedDemands.some((d) =>
      d.forced && (d.source === "RISK_GOVERNOR" || d.source === "CONTROL_TOWER" || d.source === "RESILIENCE"));
    if (!forcedExit) {
      blockers.push(`refused to exit ${input.currentState} without forced authority`);
      nextState = input.currentState;
      nextSubstates = [...input.currentSubstates];
    } else {
      reasons.push(`forced exit from ${input.currentState} accepted`);
    }
  }

  // Compose effective profile = primary intersected with each substate (most conservative).
  let effective: StateProfile = getStateProfile(nextState);
  for (const sub of nextSubstates) {
    effective = intersectProfiles(effective, getStateProfile(sub));
  }

  const changed = nextState !== input.currentState
    || nextSubstates.length !== input.currentSubstates.length
    || nextSubstates.some((s, i) => s !== input.currentSubstates[i]);

  if (changed) reasons.push(`transition ${input.currentState} → ${nextState}` + (nextSubstates.length ? ` (substates: ${nextSubstates.join(", ")})` : ""));
  else         reasons.push(`no state change (${input.currentState})`);

  reasons.push(...resolution.reasons);
  blockers.push(...resolution.blockers);

  const transitionRecord: StateTransitionRecord = {
    generatedAtIso: input.generatedAtIso,
    fromState: input.currentState,
    toState: nextState,
    fromSubstates: [...input.currentSubstates],
    toSubstates: [...nextSubstates],
    changed,
    acceptedDemands: resolution.acceptedDemands,
    rejectedDemands: resolution.rejectedDemands,
    reasons: [...reasons],
    blockers: [...blockers],
  };

  return {
    generatedAtIso: input.generatedAtIso,
    nextState, nextSubstates, effectiveProfile: effective,
    transitionRecord, resolution, reasons, blockers,
  };
}
