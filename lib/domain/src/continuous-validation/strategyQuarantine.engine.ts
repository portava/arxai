// ═══════════════════════════════════════════════════════════════════════════
// Strategy Quarantine — pure. Suspicious strategies move into restricted
// or shadow operation BEFORE retirement. Transitions are single-step:
//
//   NONE → SHADOW → RESTRICTED → RETIRED  (worsening direction)
//   RETIRED → ∅                            (no recovery)
//   RESTRICTED → SHADOW → NONE             (improving direction)
//
// Inputs include current state, trust score, severe breach count, moderate
// concern count, and a recovery-evidence score. Output is the next state
// plus reasons.
// ═══════════════════════════════════════════════════════════════════════════

export type QuarantineState = "NONE" | "SHADOW" | "RESTRICTED" | "RETIRED";

export interface StrategyQuarantineInput {
  candidateId: string;
  currentState: QuarantineState;
  trustScore01: number;
  severeBreachCount: number;
  moderateConcernCount: number;
  recoveryEvidenceScore01: number;
  // Optional thresholds
  trustRestrictedBelow01?: number;     // default 0.30
  trustShadowBelow01?: number;         // default 0.50
  recoveryThreshold01?: number;        // default 0.80
  recoveryTrustMin01?: number;         // default 0.70
}
export interface StrategyQuarantineResult {
  candidateId: string;
  previousState: QuarantineState;
  nextState: QuarantineState;
  direction: "WORSEN" | "IMPROVE" | "HOLD";
  reasons: string[];
  permissions: { canEnterTrades: boolean; canIncreaseSize: boolean; visibleOnlyToShadow: boolean };
}

const ORDER: QuarantineState[] = ["NONE", "SHADOW", "RESTRICTED", "RETIRED"];
function step(state: QuarantineState, dir: 1 | -1): QuarantineState {
  const idx = ORDER.indexOf(state);
  const nextIdx = Math.max(0, Math.min(ORDER.length - 1, idx + dir));
  return ORDER[nextIdx]!;
}

export function evolveStrategyQuarantine(
  i: StrategyQuarantineInput,
): StrategyQuarantineResult {
  const reasons: string[] = [];
  const restrictedThr = i.trustRestrictedBelow01 ?? 0.30;
  const shadowThr     = i.trustShadowBelow01     ?? 0.50;
  const recoveryThr   = i.recoveryThreshold01    ?? 0.80;
  const recoveryTrust = i.recoveryTrustMin01     ?? 0.70;

  // RETIRED is terminal.
  if (i.currentState === "RETIRED") {
    reasons.push("strategy is RETIRED — terminal state, no recovery");
    return result(i, "RETIRED", "HOLD", reasons);
  }

  // Severe breach → straight to RETIRED (catastrophic).
  if (i.severeBreachCount >= 1) {
    reasons.push(`${i.severeBreachCount} severe breach(es) — retire`);
    return result(i, "RETIRED", "WORSEN", reasons);
  }

  // Worsening triggers
  if (i.trustScore01 < restrictedThr) {
    reasons.push(`trust ${i.trustScore01.toFixed(2)} < ${restrictedThr} — RESTRICTED`);
    return result(i, "RESTRICTED", "WORSEN", reasons);
  }
  if (i.trustScore01 < shadowThr || i.moderateConcernCount >= 2) {
    // Move ONE step worse from current (or land on SHADOW from NONE).
    const next = i.currentState === "NONE" ? "SHADOW" : step(i.currentState, 1);
    reasons.push(`trust ${i.trustScore01.toFixed(2)} < ${shadowThr} or ${i.moderateConcernCount} concerns — ${next}`);
    return result(i, next, "WORSEN", reasons);
  }

  // Improving triggers (single-step recovery)
  if (i.recoveryEvidenceScore01 >= recoveryThr && i.trustScore01 >= recoveryTrust) {
    const next = step(i.currentState, -1);
    if (next !== i.currentState) {
      reasons.push(`recovery ${i.recoveryEvidenceScore01.toFixed(2)} ≥ ${recoveryThr} & trust ${i.trustScore01.toFixed(2)} ≥ ${recoveryTrust} — relax to ${next}`);
      return result(i, next, "IMPROVE", reasons);
    }
  }

  reasons.push("no transition triggers met — hold current state");
  return result(i, i.currentState, "HOLD", reasons);
}

function result(
  i: StrategyQuarantineInput,
  next: QuarantineState,
  dir: "WORSEN" | "IMPROVE" | "HOLD",
  reasons: string[],
): StrategyQuarantineResult {
  return {
    candidateId: i.candidateId,
    previousState: i.currentState,
    nextState: next,
    direction: dir,
    reasons,
    permissions: permissionsFor(next),
  };
}
function permissionsFor(state: QuarantineState) {
  switch (state) {
    case "NONE":       return { canEnterTrades: true,  canIncreaseSize: true,  visibleOnlyToShadow: false };
    case "SHADOW":     return { canEnterTrades: false, canIncreaseSize: false, visibleOnlyToShadow: true  };
    case "RESTRICTED": return { canEnterTrades: true,  canIncreaseSize: false, visibleOnlyToShadow: false };
    case "RETIRED":    return { canEnterTrades: false, canIncreaseSize: false, visibleOnlyToShadow: false };
  }
}
