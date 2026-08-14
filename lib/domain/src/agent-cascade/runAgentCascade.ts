import { runLevel1 } from "./level1.hardBlock";
import { runLevel2 } from "./level2.direction";
import { runLevel3 } from "./level3.quality";
import { runLevel4 } from "./level4.review";
import {
  type AgentCascadeInput, type CascadeResult, type CascadeStatus,
  AGENT_CASCADE_THRESHOLDS,
} from "./agentCascade.types";

// runAgentCascade
//
// Top-level orchestrator. Runs the four levels in precedence order with
// short-circuit semantics:
//
//   • Level 1 (Hard Block) runs first. If ANY agent vetoes:
//        status = BLOCKED, levels 2 & 3 are NOT run.
//        Level 4 STILL runs — its signals are about the system,
//        not the trade, and the operator needs them regardless.
//   • Level 2 (Direction) runs next. If no consensus direction:
//        status = REJECTED_NO_DIRECTION, Level 3 is NOT run.
//        Level 4 still runs.
//   • Level 3 (Quality) runs next. Average quality determines status:
//        < rejectBelowAverageQuality → REJECTED_LOW_QUALITY
//        < reduceBelowAverageQuality → EXECUTE_REDUCED
//        otherwise                   → EXECUTE
//   • Level 4 (Review) ALWAYS runs.
//
// Direction-of-trade sanity: if Level 2 consensus disagrees with the setup's
// proposed direction, the cascade refuses (REJECTED_NO_DIRECTION) — the
// operator proposed BUY but agents agree SELL is correct, so the proposed
// trade is invalidated rather than being silently flipped.
export function runAgentCascade(input: AgentCascadeInput): CascadeResult {
  const T = AGENT_CASCADE_THRESHOLDS.level3;
  const reasons: string[] = [];
  const blockers: string[] = [];

  // ── Level 4 always runs — capture early so it's present in every return path ─
  const level4 = runLevel4(input);

  // ── Level 1 ────────────────────────────────────────────────────────────
  const level1 = runLevel1(input);
  if (level1.anyVeto) {
    for (const v of level1.verdicts) {
      if (v.vetoed && v.vetoReason) blockers.push(`[${v.agentName}] ${v.vetoReason}`);
    }
    reasons.push(`BLOCKED by ${level1.vetoers.length} hard-block agent(s): ${level1.vetoers.join(", ")}`);
    return {
      status: "BLOCKED",
      finalDirection: null,
      finalConfidence: 0,
      level1, level2: null, level3: null, level4,
      reasons, blockers,
    };
  }
  reasons.push("Level 1 clean — no hard-block vetoes");

  // ── Level 2 ────────────────────────────────────────────────────────────
  const level2 = runLevel2(input);
  if (level2.consensusDirection === "NONE") {
    reasons.push("Level 2 produced no consensus direction — agents are split or below conviction floor");
    blockers.push("no directional consensus among Level 2 agents");
    return {
      status: "REJECTED_NO_DIRECTION",
      finalDirection: null,
      finalConfidence: 0,
      level1, level2, level3: null, level4,
      reasons, blockers,
    };
  }
  // Proposed direction sanity check
  if (level2.consensusDirection !== input.setup.direction) {
    reasons.push(
      `Level 2 consensus is ${level2.consensusDirection} but proposed setup is ${input.setup.direction} — refusing`,
    );
    blockers.push(`agent consensus ${level2.consensusDirection} contradicts proposed ${input.setup.direction}`);
    return {
      status: "REJECTED_NO_DIRECTION",
      finalDirection: null,
      finalConfidence: 0,
      level1, level2, level3: null, level4,
      reasons, blockers,
    };
  }
  reasons.push(`Level 2 consensus: ${level2.consensusDirection} @ agreement ${(level2.agreement01 * 100).toFixed(0)}%, avg conviction ${level2.averageConviction.toFixed(0)}`);

  // ── Level 3 ────────────────────────────────────────────────────────────
  const level3 = runLevel3(input);
  let status: CascadeStatus;
  if (level3.averageQuality < T.rejectBelowAverageQuality) {
    status = "REJECTED_LOW_QUALITY";
    reasons.push(`Level 3 average quality ${level3.averageQuality.toFixed(0)} < reject floor ${T.rejectBelowAverageQuality}`);
    blockers.push(`average quality too low to risk capital (${level3.averageQuality.toFixed(0)}/100)`);
  } else if (level3.averageQuality <= T.reduceBelowAverageQuality) {
    // Inclusive at the upper bound — quality of EXACTLY reduceBelowAverageQuality
    // (e.g. 60) still reduces. Only > threshold gets full EXECUTE.
    status = "EXECUTE_REDUCED";
    reasons.push(`Level 3 average quality ${level3.averageQuality.toFixed(0)} ≤ ${T.reduceBelowAverageQuality} — execute with reduced size (multiplier ${level3.confidenceMultiplier.toFixed(2)})`);
  } else {
    status = "EXECUTE";
    reasons.push(`Level 3 average quality ${level3.averageQuality.toFixed(0)} — execute (multiplier ${level3.confidenceMultiplier.toFixed(2)})`);
  }

  // ── Final blended confidence ───────────────────────────────────────────
  // Combines L2 conviction × agreement with L3 quality. Each contributes 50%.
  // Bounded [0, 100]. Status REJECTED_LOW_QUALITY → 0.
  let finalConfidence = 0;
  if (status !== "REJECTED_LOW_QUALITY") {
    const directionalScore = level2.averageConviction * level2.agreement01;  // 0..100
    finalConfidence = Math.max(0, Math.min(100, 0.5 * directionalScore + 0.5 * level3.averageQuality));
  }

  // Surface Level 4 warnings into reasons for visibility, even on EXECUTE paths.
  for (const sig of level4.signals) {
    if (sig.severity === "WARNING") {
      reasons.push(`L4 WARNING [${sig.agentName}] ${sig.signalKind}`);
    }
  }

  return {
    status,
    finalDirection: status === "REJECTED_LOW_QUALITY" ? null : level2.consensusDirection,
    finalConfidence,
    level1, level2, level3, level4,
    reasons, blockers,
  };
}
