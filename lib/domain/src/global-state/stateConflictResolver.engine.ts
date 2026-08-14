import { z } from "zod/v4";
import { GlobalStateSchema, type GlobalState } from "./globalState.engine";
import { TransitionDemandSchema, type TransitionDemand } from "./transitionRules.engine";
import { pickHighestPriority, isPrimaryOnly } from "./statePriority.engine";

// ═══════════════════════════════════════════════════════════════════════════
// State Conflict Resolver
// Given a set of demands, pick exactly one PRIMARY state and zero or more
// SECONDARY substates. Forced demands always beat non-forced. Among forced
// demands, the highest-priority state wins. Substates that are
// "primary-only" are dropped. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const ConflictResolutionSchema = z.object({
  primary: GlobalStateSchema,
  substates: z.array(GlobalStateSchema),
  acceptedDemands: z.array(TransitionDemandSchema),
  rejectedDemands: z.array(TransitionDemandSchema),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ConflictResolution = z.infer<typeof ConflictResolutionSchema>;

export function resolveConflicts(demands: ReadonlyArray<TransitionDemand>): ConflictResolution {
  const reasons: string[] = [];
  const blockers: string[] = [];

  if (demands.length === 0) {
    return {
      primary: "NORMAL", substates: [],
      acceptedDemands: [], rejectedDemands: [],
      reasons: ["no demands — defaulting to NORMAL"], blockers: [],
    };
  }

  const forced = demands.filter((d) => d.forced);
  const candidatesForPrimary = forced.length > 0 ? forced : [...demands];
  const primary = pickHighestPriority(candidatesForPrimary.map((d) => d.demandedState));
  if (forced.length > 0) reasons.push(`primary chosen from ${forced.length} forced demand(s)`);
  else                   reasons.push(`primary chosen from ${demands.length} soft demand(s)`);

  // Substates = remaining demanded states != primary, deduped, and not primary-only.
  const seen = new Set<GlobalState>([primary]);
  const substates: GlobalState[] = [];
  const accepted: TransitionDemand[] = [];
  const rejected: TransitionDemand[] = [];

  for (const d of demands) {
    if (d.demandedState === primary) {
      accepted.push(d); continue;
    }
    if (isPrimaryOnly(d.demandedState)) {
      rejected.push(d);
      reasons.push(`dropped substate ${d.demandedState} from ${d.source} — primary-only state`);
      continue;
    }
    if (seen.has(d.demandedState)) { accepted.push(d); continue; }
    seen.add(d.demandedState);
    substates.push(d.demandedState);
    accepted.push(d);
  }

  // If primary is primary-only (LOCKDOWN/SAFE_SHUTDOWN/DEGRADED_MODE/
  // PRESERVATION_MODE/RECOVERY_MODE), it MUST run alone — drop any substates.
  let finalSubstates = substates;
  if (isPrimaryOnly(primary) && substates.length > 0) {
    reasons.push(`primary ${primary} is primary-only — cleared ${substates.length} substate(s): ${substates.join(", ")}`);
    finalSubstates = [];
  }

  return {
    primary, substates: finalSubstates,
    acceptedDemands: accepted, rejectedDemands: rejected,
    reasons, blockers,
  };
}
