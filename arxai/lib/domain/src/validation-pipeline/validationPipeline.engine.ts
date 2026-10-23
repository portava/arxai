import {
  type CandidateState, type StageValidationResult, type StageMetrics,
  type ValidationLogEntry, type ValidationStage, type DemotionCheck,
  type LiveReadinessScore, nextStage, previousStage, stageRank, isLiveStage,
} from "./validation.types";
import { checkDemotion } from "./demotionCriteria.engine";
import { computeLiveReadinessScore } from "./liveReadinessScore.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Validation Pipeline — orchestrator. Runs the state machine across the
// seven stages with hard rules:
//
//   • Nothing jumps directly to live trading. promote() advances by ONE
//     stage at a time; multi-step promotion is structurally impossible.
//   • Risk Governor freeze blocks promotion (returns FROZEN verdict).
//   • Failed strategies move back to RESEARCH or SHADOW_MODE per
//     demotionCriteria.
//   • Edge decay triggers demotion via demotionCriteria.
//   • Control Tower owns rollout — caller injects authorisation port.
//   • Every result is logged via emitVaultLog (to Black Box Vault).
// ═══════════════════════════════════════════════════════════════════════════

export interface PipelinePorts {
  /** Risk Governor freeze check — final veto over promotion. */
  riskGovernor: {
    isFrozen(candidateId: string): Promise<boolean> | boolean;
    freezeReason?(candidateId: string): Promise<string | undefined> | string | undefined;
  };
  /** Control Tower rollout authorisation — must approve a stage transition. */
  controlTower: {
    authorizeTransition(
      candidateId: string,
      fromStage: ValidationStage,
      toStage: ValidationStage,
    ): Promise<{ authorized: boolean; reason: string }> | { authorized: boolean; reason: string };
  };
  /** Black Box Vault sink for every validation event. */
  emitVaultLog(entry: ValidationLogEntry): Promise<void> | void;
  /** Stable id generator. */
  newEntryId(): string;
}

export interface PromotionAttempt {
  candidateId: string;
  fromStage: ValidationStage;
  toStage: ValidationStage | null;               // null = no further stage
  authorized: boolean;
  promoted: boolean;
  newState: CandidateState;
  blockers: string[];
  reasons: string[];
}

// ── Apply a stage validation result and (optionally) attempt promotion ────
export async function applyStageResult(
  state: CandidateState,
  result: StageValidationResult,
  ports: PipelinePorts,
  recordedAtIso: string,
): Promise<{ newState: CandidateState; promotion?: PromotionAttempt }> {
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (result.candidateId !== state.candidate.candidateId) {
    blockers.push(`result.candidateId ${result.candidateId} ≠ state.candidate.candidateId ${state.candidate.candidateId}`);
  }
  if (result.stage !== state.currentStage) {
    blockers.push(`result.stage ${result.stage} ≠ state.currentStage ${state.currentStage} — refusing to apply`);
  }
  // Defense-in-depth: a stage result that itself carries blockers
  // (e.g. shadow-mode invariant violation, micro-lot cap breach) MUST
  // never trigger promotion, regardless of verdict casting upstream.
  if (result.blockers.length > 0) {
    blockers.push(`result carries ${result.blockers.length} blocker(s) — refusing to promote: ${result.blockers.slice(0,2).join("; ")}`);
  }

  // Always log the stage result.
  await safeEmit(ports, {
    entryId: ports.newEntryId(),
    candidateId: state.candidate.candidateId,
    stage: result.stage,
    kind: "STAGE_RESULT",
    payloadJson: JSON.stringify(result),
    recordedAtIso, reasons: result.reasons,
  }, blockers);

  if (blockers.length > 0) {
    reasons.push(`refusing further action due to ${blockers.length} blocker(s)`);
    return { newState: state };
  }

  if (result.verdict === "PASS") {
    const promotion = await promote(state, ports, recordedAtIso);
    return { newState: promotion.newState, promotion };
  }
  // FAIL / INCONCLUSIVE / FROZEN — do NOT promote. Caller may invoke
  // checkDemotionAndApply separately.
  reasons.push(`verdict ${result.verdict} — no automatic promotion`);
  return { newState: state };
}

// ── Promote by one stage, gated by Risk Governor + Control Tower ──────────
export async function promote(
  state: CandidateState,
  ports: PipelinePorts,
  recordedAtIso: string,
): Promise<PromotionAttempt> {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const target = nextStage(state.currentStage);
  if (target === null) {
    reasons.push(`already at terminal stage ${state.currentStage}`);
    return {
      candidateId: state.candidate.candidateId,
      fromStage: state.currentStage, toStage: null,
      authorized: false, promoted: false, newState: state, blockers, reasons,
    };
  }

  // Hard rule: never jump to live in one shot — promote() always advances
  // by exactly one stage. The structural guard is `nextStage`.
  if (stageRank(target) - stageRank(state.currentStage) !== 1) {
    blockers.push(`structural invariant violated: promote attempted ${state.currentStage} → ${target}`);
  }

  // Local-state freeze guard — must hold even if the port reports false
  // due to staleness/race. A candidate marked frozen in state cannot
  // promote until something explicitly unfreezes it.
  if (state.frozen) {
    reasons.push(`local state.frozen=true (${state.frozenReason ?? "no reason"}) — promotion refused`);
    await safeEmit(ports, {
      entryId: ports.newEntryId(),
      candidateId: state.candidate.candidateId,
      stage: state.currentStage,
      kind: "TRANSITION",
      payloadJson: JSON.stringify({ verdict: "FROZEN", reason: state.frozenReason ?? "(unspecified)" }),
      recordedAtIso, reasons,
    }, blockers);
    return {
      candidateId: state.candidate.candidateId,
      fromStage: state.currentStage, toStage: target,
      authorized: false, promoted: false, newState: state, blockers, reasons,
    };
  }

  // Risk Governor freeze veto (pre-authorize).
  if (await ports.riskGovernor.isFrozen(state.candidate.candidateId)) {
    return await applyFreeze(state, target, ports, recordedAtIso, reasons, blockers);
  }

  // Control Tower authorisation.
  const auth = await ports.controlTower.authorizeTransition(
    state.candidate.candidateId, state.currentStage, target);
  reasons.push(`Control Tower: ${auth.authorized ? "AUTHORIZED" : "DENIED"} — ${auth.reason}`);
  if (!auth.authorized) {
    return {
      candidateId: state.candidate.candidateId,
      fromStage: state.currentStage, toStage: target,
      authorized: false, promoted: false, newState: state, blockers, reasons,
    };
  }

  // TOCTOU re-check: freeze may have flipped between the first check and
  // Control Tower returning. Re-verify before applying the transition.
  if (await ports.riskGovernor.isFrozen(state.candidate.candidateId)) {
    reasons.push(`Risk Governor froze candidate after Control Tower authorisation — aborting`);
    return await applyFreeze(state, target, ports, recordedAtIso, reasons, blockers);
  }

  // Apply transition.
  const newState = appendHistory(state, state.currentStage, target, "PROMOTE",
    "CONTROL_TOWER", recordedAtIso, auth.reason);
  newState.currentStage = target;
  reasons.push(`promoted ${state.currentStage} → ${target}${isLiveStage(target) ? " (LIVE)" : ""}`);
  await safeEmit(ports, {
    entryId: ports.newEntryId(),
    candidateId: state.candidate.candidateId,
    stage: target, kind: "TRANSITION",
    payloadJson: JSON.stringify({ from: state.currentStage, to: target, kind: "PROMOTE" }),
    recordedAtIso, reasons,
  }, blockers);
  return {
    candidateId: state.candidate.candidateId,
    fromStage: state.currentStage, toStage: target,
    authorized: true, promoted: true, newState, blockers, reasons,
  };
}

// ── Apply a demotion check, transitioning the candidate downstream ────────
export async function checkDemotionAndApply(
  state: CandidateState,
  metrics: StageMetrics,
  ports: PipelinePorts,
  recordedAtIso: string,
): Promise<{ newState: CandidateState; demotion: DemotionCheck }> {
  const demotion = checkDemotion(state, metrics);
  await safeEmit(ports, {
    entryId: ports.newEntryId(),
    candidateId: state.candidate.candidateId,
    stage: state.currentStage,
    kind: "DEMOTION_CHECK",
    payloadJson: JSON.stringify(demotion),
    recordedAtIso, reasons: demotion.reasons,
  }, []);

  if (!demotion.shouldDemote || demotion.proposedStage === state.currentStage) {
    return { newState: state, demotion };
  }
  const newState = appendHistory(state, state.currentStage, demotion.proposedStage,
    "DEMOTE", demotion.triggers.includes("EDGE_DECAY") ? "EDGE_DECAY" : "VALIDATOR",
    recordedAtIso, demotion.triggers.join(","));
  newState.currentStage = demotion.proposedStage;
  await safeEmit(ports, {
    entryId: ports.newEntryId(),
    candidateId: state.candidate.candidateId,
    stage: demotion.proposedStage, kind: "TRANSITION",
    payloadJson: JSON.stringify({
      from: state.currentStage, to: demotion.proposedStage,
      kind: "DEMOTE", triggers: demotion.triggers,
    }),
    recordedAtIso, reasons: demotion.reasons,
  }, []);
  return { newState, demotion };
}

// ── Compute & log live readiness score ────────────────────────────────────
export async function computeAndLogReadiness(
  state: CandidateState,
  stageResults: ReadonlyArray<StageValidationResult>,
  ports: PipelinePorts,
  recordedAtIso: string,
  readyThreshold01?: number,
): Promise<LiveReadinessScore> {
  const score = computeLiveReadinessScore({ state, stageResults, readyThreshold01 });
  await safeEmit(ports, {
    entryId: ports.newEntryId(),
    candidateId: state.candidate.candidateId,
    stage: state.currentStage,
    kind: "READINESS_SCORE",
    payloadJson: JSON.stringify(score),
    recordedAtIso, reasons: score.reasons,
  }, []);
  return score;
}

// ── Initial-state factory ─────────────────────────────────────────────────
export function initCandidateState(
  candidate: CandidateState["candidate"],
  recordedAtIso: string,
): CandidateState {
  return {
    candidate,
    currentStage: "RESEARCH",
    history: [{
      fromStage: "RESEARCH", toStage: "RESEARCH",
      transitionKind: "INIT", triggeredBy: "CONTROL_TOWER",
      atIso: recordedAtIso, reason: "candidate registered",
    }],
    frozen: false,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function appendHistory(
  state: CandidateState,
  fromStage: ValidationStage,
  toStage: ValidationStage,
  transitionKind: CandidateState["history"][number]["transitionKind"],
  triggeredBy: CandidateState["history"][number]["triggeredBy"],
  atIso: string,
  reason: string,
): CandidateState {
  return {
    ...state,
    history: [...state.history, { fromStage, toStage, transitionKind, triggeredBy, atIso, reason }],
  };
}

async function applyFreeze(
  state: CandidateState,
  target: ValidationStage,
  ports: PipelinePorts,
  recordedAtIso: string,
  reasons: string[],
  blockers: string[],
): Promise<PromotionAttempt> {
  const reason = (await ports.riskGovernor.freezeReason?.(state.candidate.candidateId)) ?? "(unspecified)";
  reasons.push(`Risk Governor froze candidate: ${reason}`);
  const transitioned = appendHistory(state, state.currentStage, state.currentStage,
    "FREEZE", "RISK_GOVERNOR", recordedAtIso, `freeze: ${reason}`);
  transitioned.frozen = true;
  transitioned.frozenReason = reason;
  await safeEmit(ports, {
    entryId: ports.newEntryId(),
    candidateId: state.candidate.candidateId,
    stage: state.currentStage,
    kind: "TRANSITION",
    payloadJson: JSON.stringify({ verdict: "FROZEN", reason }),
    recordedAtIso, reasons,
  }, blockers);
  return {
    candidateId: state.candidate.candidateId,
    fromStage: state.currentStage, toStage: target,
    authorized: false, promoted: false, newState: transitioned, blockers, reasons,
  };
}

async function safeEmit(
  ports: PipelinePorts,
  entry: ValidationLogEntry,
  blockers: string[],
): Promise<void> {
  try { await ports.emitVaultLog(entry); }
  catch (e) { blockers.push(`emitVaultLog failed for ${entry.kind}: ${(e as Error).message}`); }
}

// Re-export for convenience.
export { previousStage } from "./validation.types";
