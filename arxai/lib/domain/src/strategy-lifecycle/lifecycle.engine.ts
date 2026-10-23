import {
  type LifecycleStage,
  type LifecycleEvent,
  type StrategyLifecycleState,
  isTerminalStage,
} from "./lifecycle.types";

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Lifecycle FSM. Transitions are TABLE-DRIVEN — anything not in
// the map is BLOCKED. Forward (PROMOTE) is one stage at a time; skipping
// is impossible by construction. Quarantine / retirement / archive are
// reachable from many stages because risk events do not wait their turn.
//
// PROJECT RULES:
//   • A mutated strategy must enter at RESEARCH (handled by callers).
//   • No event bypasses Risk Governor / Control Tower; this FSM is pure
//     bookkeeping. Authoritative freeze still wins downstream.
// ═══════════════════════════════════════════════════════════════════════════

const TRANSITIONS: Record<LifecycleStage, Partial<Record<LifecycleEvent, LifecycleStage>>> = {
  RESEARCH:     { PROMOTE: "TESTING",      QUARANTINE: "QUARANTINED", RETIRE: "RETIRED" },
  TESTING:      { PROMOTE: "SHADOW",       QUARANTINE: "QUARANTINED", RETIRE: "RETIRED" },
  SHADOW:       { PROMOTE: "PAPER",        REVIEW: "UNDER_REVIEW",    QUARANTINE: "QUARANTINED", RETIRE: "RETIRED" },
  PAPER:        { PROMOTE: "MICRO",        REVIEW: "UNDER_REVIEW",    QUARANTINE: "QUARANTINED", RETIRE: "RETIRED" },
  MICRO:        { PROMOTE: "LIMITED_LIVE", DEMOTE: "DEGRADED",        REVIEW: "UNDER_REVIEW", QUARANTINE: "QUARANTINED", RETIRE: "RETIRED" },
  LIMITED_LIVE: { PROMOTE: "ACTIVE",       DEMOTE: "DEGRADED",        REVIEW: "UNDER_REVIEW", QUARANTINE: "QUARANTINED", RETIRE: "RETIRED" },
  ACTIVE:       { DEMOTE: "DEGRADED",      REVIEW: "UNDER_REVIEW",    QUARANTINE: "QUARANTINED", RETIRE: "RETIRED" },
  // UNDER_REVIEW PROMOTE target is RESOLVED FROM HISTORY in
  // transitionLifecycle (returns to the strategy's last live-progression
  // stage). The "ACTIVE" placeholder here is overridden — it is never used
  // directly because the special-case path below replaces it.
  UNDER_REVIEW: { PROMOTE: "ACTIVE",       DEMOTE: "DEGRADED",        QUARANTINE: "QUARANTINED", RETIRE: "RETIRED" },
  DEGRADED:     { PROMOTE: "UNDER_REVIEW", REVIEW: "UNDER_REVIEW",    QUARANTINE: "QUARANTINED", RETIRE: "RETIRED" },
  QUARANTINED:  { REINSTATE: "UNDER_REVIEW", RETIRE: "RETIRED" },
  RETIRED:      { REINSTATE: "RESEARCH",   ARCHIVE: "ARCHIVED" },
  ARCHIVED:     {},
};

export interface LifecycleTransitionResult {
  next: StrategyLifecycleState;
  changed: boolean;
  reasons: string[];
  blockers: string[];
}

export function transitionLifecycle(
  current: StrategyLifecycleState,
  event: LifecycleEvent,
  atIso: string,
  externalReasons: readonly string[] = [],
): LifecycleTransitionResult {
  const reasons: string[] = [...externalReasons];
  const blockers: string[] = [];

  if (isTerminalStage(current.stage)) {
    blockers.push(`stage ${current.stage} is terminal — no transitions allowed`);
    return { next: current, changed: false, reasons, blockers };
  }

  let target = TRANSITIONS[current.stage][event];
  if (!target) {
    blockers.push(`event ${event} not allowed from stage ${current.stage}`);
    reasons.push(`no transition — keeping ${current.stage}`);
    return { next: current, changed: false, reasons, blockers };
  }

  // ── Anti-skip rule for UNDER_REVIEW ─────────────────────────────────────
  // PROMOTE from UNDER_REVIEW must return the strategy to the stage it was
  // pulled out of — NOT vault it straight to ACTIVE. Otherwise the side-door
  // SHADOW→REVIEW→UNDER_REVIEW→PROMOTE→ACTIVE would skip PAPER/MICRO/
  // LIMITED_LIVE. We resolve the target by walking history backward and
  // finding the last live-progression stage we occupied. If we have never
  // been in one (e.g. arrived here via QUARANTINED→REINSTATE from RESEARCH),
  // we fall back to RESEARCH (safest re-entry point).
  if (current.stage === "UNDER_REVIEW" && event === "PROMOTE") {
    const LIVE_PROGRESSION: ReadonlySet<LifecycleStage> = new Set<LifecycleStage>([
      "RESEARCH", "TESTING", "SHADOW", "PAPER", "MICRO", "LIMITED_LIVE", "ACTIVE",
    ]);
    let resolved: LifecycleStage | null = null;
    for (let k = current.history.length - 1; k >= 0; k--) {
      const h = current.history[k]!;
      if (LIVE_PROGRESSION.has(h.fromStage) && h.fromStage !== "UNDER_REVIEW") {
        resolved = h.fromStage;
        break;
      }
    }
    target = resolved ?? "RESEARCH";
    reasons.push(`UNDER_REVIEW PROMOTE resolved to prior live stage ${target} (anti-skip)`);
  }

  reasons.push(`${current.stage} --${event}--> ${target}`);
  return {
    next: {
      strategyId: current.strategyId,
      stage: target,
      enteredStageAtIso: atIso,
      history: [
        ...current.history,
        { fromStage: current.stage, toStage: target, event, atIso, reasons: [...reasons] },
      ],
    },
    changed: true,
    reasons,
    blockers,
  };
}

export function seedLifecycle(
  strategyId: string,
  atIso: string,
  startAt: LifecycleStage = "RESEARCH",
): StrategyLifecycleState {
  return { strategyId, stage: startAt, enteredStageAtIso: atIso, history: [] };
}

export function isTerminal(stage: LifecycleStage): boolean {
  return isTerminalStage(stage);
}

export function allowedEventsFrom(stage: LifecycleStage): LifecycleEvent[] {
  return Object.keys(TRANSITIONS[stage]) as LifecycleEvent[];
}
