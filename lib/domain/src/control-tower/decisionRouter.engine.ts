import { type RouteDestination, type SystemMode } from "./systemMode.types";
import { describeMode } from "./systemMode.engine";

export interface RoutingInput {
  decisionId: string;
  proposedDestination: RouteDestination;  // what the upstream chain wants
  isLiveOrder: boolean;
  intendedSizeLots: number;
}

export interface RoutingDecision {
  effectiveDestination: RouteDestination;
  effectiveSizeLots: number;
  blockers: string[];
  reasons: string[];
}

// routeDecision — given the current mode and a proposed routing,
// returns the EFFECTIVE destination (possibly downgraded). Defensive:
// NEVER UPGRADES (a paper request stays paper or gets dropped; it never
// gets promoted to LIVE). Size cap uses Math.min vs mode cap.
//
// LOCKDOWN drops everything. RECOVERY downgrades aggressively (real
// orders capped to recovery mode's 0.05 lot ceiling).
export function routeDecision(input: RoutingInput, mode: SystemMode): RoutingDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];

  if (mode === "LOCKDOWN") {
    return { effectiveDestination: "DROP", effectiveSizeLots: 0,
      blockers: [`mode=LOCKDOWN drops all decisions`],
      reasons: [`LOCKDOWN — all decisions dropped`] };
  }

  const cap = describeMode(mode);

  // Determine the highest-tier destination this mode supports
  const modeMax: RouteDestination =
      cap.canExecuteReal ? "LIVE_EXECUTOR"
    : cap.canPaperTrade  ? "PAPER_QUEUE"
    : cap.canShadowTrade ? "SHADOW_LOG"
    : cap.canSuggest     ? "SUGGEST_QUEUE"
    : "DROP";

  // Map destinations to a tier ordering for downgrade-only logic
  const tier: Record<RouteDestination, number> = {
    DROP: 0, SUGGEST_QUEUE: 1, SHADOW_LOG: 2, PAPER_QUEUE: 3, LIVE_EXECUTOR: 4,
  };
  const proposedTier = tier[input.proposedDestination];
  const modeTier     = tier[modeMax];
  const effectiveDestination: RouteDestination = proposedTier <= modeTier
    ? input.proposedDestination
    : modeMax;
  if (proposedTier > modeTier) {
    reasons.push(`proposed ${input.proposedDestination} exceeds mode ${mode} max ${modeMax} — downgraded`);
  } else {
    reasons.push(`proposed ${input.proposedDestination} permitted by mode ${mode}`);
  }

  // Size cap (only meaningful for LIVE_EXECUTOR)
  let effectiveSize = Math.max(0, input.intendedSizeLots);
  if (effectiveDestination === "LIVE_EXECUTOR") {
    const before = effectiveSize;
    effectiveSize = Math.min(effectiveSize, cap.maxSizeLots);
    if (effectiveSize !== before) {
      reasons.push(`size ${before.toFixed(2)} → ${effectiveSize.toFixed(2)} lots (mode cap ${cap.maxSizeLots})`);
    }
    if (effectiveSize <= 0) {
      blockers.push(`effective size 0 after mode cap — dropping`);
      return { effectiveDestination: "DROP", effectiveSizeLots: 0, blockers, reasons };
    }
  } else {
    effectiveSize = 0;                  // non-live destinations don't carry size
  }

  return { effectiveDestination, effectiveSizeLots: effectiveSize, blockers, reasons };
}
