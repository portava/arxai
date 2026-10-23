import {
  type CandidateState, type StageValidationResult, type LiveReadinessScore,
  type ValidationStage, STAGE_ORDER, stageRank,
} from "./validation.types";

// ═══════════════════════════════════════════════════════════════════════════
// Live Readiness Score — composite [0,1] across stages. Pure.
//
// Each stage carries a weight (later stages weigh more). For each stage
// reached or completed, the candidate's most recent PASS contributes the
// stage's full weight; a FAIL contributes 0; INCONCLUSIVE/FROZEN contribute
// half. Stages never reached contribute 0. The composite is then
// normalised by total possible weight up to and including the candidate's
// current stage (so a partial pipeline isn't unfairly penalised).
//
// `ready` is true only when:
//   • composite ≥ readyThreshold
//   • candidate is NOT frozen
//   • candidate's currentStage is at or above MICRO_LOT_LIVE
// ═══════════════════════════════════════════════════════════════════════════

export const STAGE_WEIGHTS: Record<ValidationStage, number> = {
  RESEARCH: 0,
  BACKTEST: 1,
  OUT_OF_SAMPLE_TEST: 2,
  WALK_FORWARD: 2,
  MONTE_CARLO_STRESS_TEST: 2,
  REGIME_SPECIFIC_TEST: 2,
  EXECUTION_REALITY_TEST: 2,
  SHADOW_MODE: 3,
  PAPER_TRADING: 3,
  MICRO_LOT_LIVE: 4,
  LIMITED_LIVE: 5,
  FULL_GOVERNED_LIVE: 6,
};

// Cross-system signals — Replay Lab, Execution Intelligence, Trader DNA,
// and Cognitive Risk MUST influence validation scoring (Phase 7 spec). All
// fields are optional so legacy callers keep working; when supplied, they
// blend with the per-stage composite (60% stages / 40% cross-system).
//
// Convention: every field is in [0,1] where 1.0 = fully favorable.
//   • behaviorRiskScore01 and cognitiveLoad01 are RISK signals — they get
//     inverted (1 - x) before being averaged in.
export interface CrossSystemSignals {
  replayLab?: {
    survivalScore01?: number;                    // higher = more robust
    sampleConfidence01?: number;                 // higher = more lessons learned
  };
  executionIntel?: { executionQuality01?: number };
  traderDNA?: {
    disciplineScore01?: number;
    behaviorRiskScore01?: number;                // RISK — inverted
  };
  cognitive?: { cognitiveLoad01?: number };      // RISK — inverted
}

export interface LiveReadinessInput {
  state: CandidateState;
  stageResults: ReadonlyArray<StageValidationResult>;
  readyThreshold01?: number;                     // default 0.7
  crossSystem?: CrossSystemSignals;
  /**
   * Blend weight for cross-system signals when present (default 0.4).
   * Stages get (1 - crossWeight). Clamped to [0, 1].
   */
  crossSystemWeight01?: number;
}

export interface CrossSystemBlend {
  available: boolean;
  score01: number;
  contributors: Array<{ name: string; value01: number; inverted: boolean }>;
}

export function computeCrossSystemBlend(c: CrossSystemSignals | undefined): CrossSystemBlend {
  const xs: Array<{ name: string; value01: number; inverted: boolean }> = [];
  const push = (name: string, v: number | undefined, inverted: boolean) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      const clamped = Math.min(1, Math.max(0, v));
      xs.push({ name, value01: inverted ? 1 - clamped : clamped, inverted });
    }
  };
  if (c) {
    push("replayLab.survivalScore01",       c.replayLab?.survivalScore01,       false);
    push("replayLab.sampleConfidence01",    c.replayLab?.sampleConfidence01,    false);
    push("executionIntel.executionQuality01", c.executionIntel?.executionQuality01, false);
    push("traderDNA.disciplineScore01",     c.traderDNA?.disciplineScore01,     false);
    push("traderDNA.behaviorRiskScore01",   c.traderDNA?.behaviorRiskScore01,   true);
    push("cognitive.cognitiveLoad01",       c.cognitive?.cognitiveLoad01,       true);
  }
  if (xs.length === 0) return { available: false, score01: 0, contributors: [] };
  const score01 = xs.reduce((s, x) => s + x.value01, 0) / xs.length;
  return { available: true, score01, contributors: xs };
}

export function computeLiveReadinessScore(input: LiveReadinessInput): LiveReadinessScore {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const threshold = input.readyThreshold01 ?? 0.7;
  const currentRank = stageRank(input.state.currentStage);

  // Latest result per stage (chronologically last wins).
  const latestByStage = new Map<ValidationStage, StageValidationResult>();
  const sorted = [...input.stageResults].sort((a, b) => a.recordedAtIso < b.recordedAtIso ? -1 : 1);
  for (const r of sorted) latestByStage.set(r.stage, r);

  let earned = 0; let possible = 0;
  const perStage: Partial<Record<ValidationStage, number>> = {};
  for (const stage of STAGE_ORDER) {
    if (stage === "RESEARCH") continue;
    if (stageRank(stage) > currentRank) continue;
    const w = STAGE_WEIGHTS[stage];
    possible += w;
    const r = latestByStage.get(stage);
    let stageScore = 0;
    if (r) {
      // INCONCLUSIVE / FROZEN now grant only quarter-credit so a candidate
      // cannot wash-trade their way to a high readiness score by stacking
      // inconclusive results across stages.
      switch (r.verdict) {
        case "PASS":         stageScore = 1; break;
        case "INCONCLUSIVE": stageScore = 0.25; break;
        case "FROZEN":       stageScore = 0.25; break;
        case "FAIL":         stageScore = 0; break;
      }
    } else {
      reasons.push(`stage ${stage}: no result on file (within current pipeline reach)`);
    }
    earned += stageScore * w;
    perStage[stage] = stageScore;
  }
  const stageScore01 = possible > 0 ? earned / possible : 0;
  reasons.push(`stage composite: earned ${earned.toFixed(2)} / possible ${possible.toFixed(2)} → ${stageScore01.toFixed(3)}`);

  // Blend cross-system signals (Replay Lab, Execution Intel, Trader DNA,
  // Cognitive Risk) when supplied. Only blend if at least one is present;
  // otherwise score is purely stage-based.
  const cross = computeCrossSystemBlend(input.crossSystem);
  const crossWRaw = input.crossSystemWeight01 ?? 0.4;
  const crossW = cross.available ? Math.min(1, Math.max(0, crossWRaw)) : 0;
  const score01 = stageScore01 * (1 - crossW) + (cross.available ? cross.score01 : 0) * crossW;
  if (cross.available) {
    reasons.push(
      `cross-system blend: score ${cross.score01.toFixed(3)} from ${cross.contributors.length} signal(s) ` +
      `[${cross.contributors.map(x => x.name).join(", ")}]`);
    reasons.push(`composite (stages ${(1-crossW).toFixed(2)} + cross ${crossW.toFixed(2)}) = ${score01.toFixed(3)}`);
  } else {
    reasons.push(`no cross-system signals supplied — composite = stage score ${score01.toFixed(3)}`);
  }

  if (input.state.frozen) {
    blockers.push(`candidate is FROZEN by Risk Governor: ${input.state.frozenReason ?? "(no reason given)"}`);
  }

  // Catastrophic-signal hard blocks. A simple average dilutes a single
  // critical risk signal across N inputs (~16% pull on 6 signals). For
  // safety-critical risk dimensions we treat extremely adverse readings
  // as a hard veto on `ready`, regardless of composite score.
  const cs = input.crossSystem;
  if (cs?.cognitive?.cognitiveLoad01 !== undefined && cs.cognitive.cognitiveLoad01 >= 0.9) {
    blockers.push(`CATASTROPHIC_SIGNAL: cognitiveLoad01 ${cs.cognitive.cognitiveLoad01.toFixed(2)} ≥ 0.9 — hard block`);
  }
  if (cs?.traderDNA?.behaviorRiskScore01 !== undefined && cs.traderDNA.behaviorRiskScore01 >= 0.9) {
    blockers.push(`CATASTROPHIC_SIGNAL: behaviorRiskScore01 ${cs.traderDNA.behaviorRiskScore01.toFixed(2)} ≥ 0.9 — hard block`);
  }
  if (cs?.replayLab?.survivalScore01 !== undefined && cs.replayLab.survivalScore01 <= 0.1) {
    blockers.push(`CATASTROPHIC_SIGNAL: replayLab.survivalScore01 ${cs.replayLab.survivalScore01.toFixed(2)} ≤ 0.1 — hard block`);
  }

  const ready = score01 >= threshold
    && blockers.length === 0
    && !input.state.frozen
    && stageRank(input.state.currentStage) >= stageRank("MICRO_LOT_LIVE");
  if (!ready) {
    if (score01 < threshold) reasons.push(`score ${score01.toFixed(2)} < threshold ${threshold}`);
    if (stageRank(input.state.currentStage) < stageRank("MICRO_LOT_LIVE")) {
      reasons.push(`currentStage ${input.state.currentStage} is below MICRO_LOT_LIVE — not ready`);
    }
  }

  return {
    candidateId: input.state.candidate.candidateId,
    score01, perStage01: perStage as Record<ValidationStage, number>,
    ready, reasons, blockers,
  };
}
