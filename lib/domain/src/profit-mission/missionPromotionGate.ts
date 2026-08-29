// Profit Mission Phase 9 — Promotion gate (the final automation-promotion checklist).
//
// Pure, deterministic, IO-free, fail-closed. Given a target automation level and a
// snapshot of the mission's evidence, this evaluates the FULL checklist that governs
// whether a mission may be promoted toward auto / live auto:
//   backtest min sample, forward-test min sample, demo performance, max-drawdown,
//   agent reliability, risk-rule compliance, no major drift, explicit user
//   enablement, live gates enabled — plus the user-type guardrail ceiling.
//
// CRITICAL SAFETY: passing this checklist NEVER places a trade and NEVER bypasses
// any live execution gate, kill switch, Trade Health, Scanner Truth, or Risk
// Governor. It only decides whether a higher automation level is PERMITTED; live
// dispatch still runs the existing instant-trade → live-pipeline → 23-gate path.
// Live auto is opt-in, last, and never silent.

import {
  type MissionAutomationLevel,
  DEFAULT_MISSION_AUTOMATION_LEVEL,
  metaForLevel,
} from "./missionAutomation.js";
import { driftBlocksPromotion, type DriftSeverity } from "./missionDriftDetector.js";
import {
  describeEvidenceBasis,
  type PromotionEvidenceBasis,
} from "./missionFillSimulation.js";

export interface PromotionEvidence {
  /** Best historical (backtest) result. */
  backtestSampleSize: number;
  backtestPromotionEligible: boolean;
  /** Best forward result. */
  forwardSampleSize: number;
  forwardPromotionEligible: boolean;
  /** Demo win rate as a fraction 0..1 over the demo sample. */
  demoWinRate: number;
  demoSampleSize: number;
  /**
   * What the demo/forward closed-trade evidence actually IS. A paper/demo
   * mission's closed trades are SIMULATED fills modelled from real quotes, not
   * broker-reconciled money — so the `demo_performance` gate says so in its own
   * detail line and the decision carries the label. Optional so older callers
   * keep compiling; absent reads as "UNSTATED", which is never treated as
   * proven broker truth.
   */
  demoEvidenceBasis?: PromotionEvidenceBasis;
  /** Worst observed max drawdown across results, as a percentage 0..100. */
  maxDrawdownPct: number;
  /** Aggregate agent reliability 0..1 (from the learning loop). */
  agentReliability: number;
  /** True when no mission risk-rule violations are outstanding. */
  riskRuleCompliant: boolean;
  /** Drift severity from the drift detector. */
  driftSeverity: DriftSeverity;
  /** User explicitly enabled live auto for this mission. */
  liveAutoEnabled: boolean;
  /** The platform's live execution gates are enabled (server master switch + armed). */
  liveGatesEnabled: boolean;
  /** Accepted Mission Risk Certificate present (required for live-auto levels). */
  certificateAccepted: boolean;
  /** Hard ceiling from the user-type guardrail. */
  guardrailMaxLevel: MissionAutomationLevel;
}

// Promotion thresholds.
const MIN_BACKTEST_SAMPLE = 30;
const MIN_FORWARD_SAMPLE = 20;
const MIN_DEMO_SAMPLE = 20;
const MIN_DEMO_WIN_RATE = 0.45;
const MAX_ALLOWED_DRAWDOWN_PCT = 25;
const MIN_AGENT_RELIABILITY = 0.5;

export interface PromotionGateResult {
  name: string;
  passed: boolean;
  detail: string;
  /** When false, this gate is only required at/above this level. */
  requiredFromLevel: MissionAutomationLevel;
}

export interface PromotionDecision {
  targetLevel: MissionAutomationLevel;
  /** True only when every gate required for targetLevel passes. */
  approved: boolean;
  /** Highest level currently permitted given all evidence + guardrail ceiling. */
  allowedMaxLevel: MissionAutomationLevel;
  gates: PromotionGateResult[];
  failedGates: string[];
  reasons: string[];
  blockers: string[];
  /**
   * What the demo/forward evidence behind this decision is. Carried on EVERY
   * decision (approved or not) so every surface that displays or journals a
   * promotion can state whether the evidence was simulated.
   */
  demoEvidenceBasis: PromotionEvidenceBasis;
  /** Plain-language notes about the evidence, safe for any surface. */
  evidenceNotes: string[];
}

/**
 * Evaluate whether the mission may be promoted to `targetLevel`. Demo-auto (3)
 * needs the testing/quality gates; live-auto (4–6) additionally needs explicit
 * enablement, certificate, and the platform live gates enabled. Everything is
 * fail-closed and capped by the guardrail ceiling.
 */
export function evaluateMissionPromotion(
  targetLevel: MissionAutomationLevel,
  e: PromotionEvidence,
): PromotionDecision {
  const gates: PromotionGateResult[] = [];
  const reasons: string[] = [];
  const blockers: string[] = [];

  const meta = metaForLevel(targetLevel);
  // The demo evidence is labelled at its source. A paper/demo mission earns this
  // gate with SIMULATED fills priced from real quotes — legitimate evidence for
  // the ladder, but never broker truth, so the label is stated in the gate's own
  // detail line, echoed on the decision, and journalled wherever it is applied.
  const demoEvidenceBasis: PromotionEvidenceBasis = e.demoEvidenceBasis ?? "UNSTATED";
  const evidenceNotes: string[] = [
    `demo performance evidence: ${describeEvidenceBasis(demoEvidenceBasis)}`,
  ];

  // Gate definitions. requiredFromLevel says at which target level the gate becomes
  // mandatory. Levels at/below APPROVAL (2) never require these — approval mode is
  // always available (it still routes every trade through manual approval + gates).
  gate("backtest_sample", e.backtestSampleSize >= MIN_BACKTEST_SAMPLE && e.backtestPromotionEligible,
    `backtest sample ${e.backtestSampleSize} ≥ ${MIN_BACKTEST_SAMPLE} with positive edge`, 3);
  gate("forward_sample", e.forwardSampleSize >= MIN_FORWARD_SAMPLE && e.forwardPromotionEligible,
    `forward sample ${e.forwardSampleSize} ≥ ${MIN_FORWARD_SAMPLE} with positive edge`, 3);
  gate("demo_performance", e.demoSampleSize >= MIN_DEMO_SAMPLE && e.demoWinRate >= MIN_DEMO_WIN_RATE,
    `demo win rate ${(e.demoWinRate * 100).toFixed(1)}% over ${e.demoSampleSize} trades (≥ ${(MIN_DEMO_WIN_RATE * 100).toFixed(0)}% / ${MIN_DEMO_SAMPLE}) — ${describeEvidenceBasis(demoEvidenceBasis)}`, 3);
  gate("max_drawdown", e.maxDrawdownPct <= MAX_ALLOWED_DRAWDOWN_PCT,
    `max drawdown ${e.maxDrawdownPct.toFixed(1)}% ≤ ${MAX_ALLOWED_DRAWDOWN_PCT}%`, 3);
  gate("agent_reliability", e.agentReliability >= MIN_AGENT_RELIABILITY,
    `agent reliability ${(e.agentReliability * 100).toFixed(0)}% ≥ ${(MIN_AGENT_RELIABILITY * 100).toFixed(0)}%`, 3);
  gate("risk_rule_compliance", e.riskRuleCompliant,
    `mission risk rules satisfied`, 3);
  gate("no_major_drift", !driftBlocksPromotion(e.driftSeverity),
    `drift severity ${e.driftSeverity} below blocking threshold`, 3);
  // Live-auto-only gates.
  gate("explicit_user_enablement", e.liveAutoEnabled,
    `user explicitly enabled live auto`, 4);
  gate("risk_certificate", e.certificateAccepted,
    `Mission Risk Certificate accepted`, 4);
  gate("live_gates_enabled", e.liveGatesEnabled,
    `platform live execution gates enabled`, 4);

  // Compute the highest level currently permitted by the evidence (independent of
  // the requested target), then clamp by the guardrail ceiling.
  let evidenceMax: MissionAutomationLevel = DEFAULT_MISSION_AUTOMATION_LEVEL;
  for (const lvl of [3, 4, 5, 6] as MissionAutomationLevel[]) {
    const required = gates.filter((g) => g.requiredFromLevel <= lvl);
    if (required.every((g) => g.passed)) evidenceMax = lvl;
    else break;
  }
  const allowedMaxLevel: MissionAutomationLevel =
    Math.min(evidenceMax, e.guardrailMaxLevel) as MissionAutomationLevel;

  // Levels 0–2 are always available (no auto execution / manual approval).
  const requiredForTarget = targetLevel <= DEFAULT_MISSION_AUTOMATION_LEVEL
    ? []
    : gates.filter((g) => g.requiredFromLevel <= targetLevel);
  const failed = requiredForTarget.filter((g) => !g.passed);

  const withinGuardrail = targetLevel <= e.guardrailMaxLevel;
  if (!withinGuardrail) {
    blockers.push(`target level ${targetLevel} exceeds your account ceiling (${e.guardrailMaxLevel})`);
  }

  const approved = withinGuardrail && failed.length === 0;
  if (approved) {
    reasons.push(targetLevel <= DEFAULT_MISSION_AUTOMATION_LEVEL
      ? `level ${targetLevel} (${meta.key}) is always available`
      : `all gates for level ${targetLevel} (${meta.key}) passed`);
  } else {
    for (const g of failed) blockers.push(`gate failed: ${g.name} — ${g.detail}`);
    reasons.push(`${failed.length + (withinGuardrail ? 0 : 1)} blocker(s) — promotion to ${meta.key} held`);
  }

  return {
    targetLevel,
    approved,
    allowedMaxLevel,
    gates,
    failedGates: failed.map((g) => g.name),
    reasons,
    blockers,
    demoEvidenceBasis,
    evidenceNotes,
  };

  function gate(name: string, passed: boolean, detail: string, requiredFromLevel: MissionAutomationLevel): void {
    gates.push({ name, passed, detail, requiredFromLevel });
  }
}

/**
 * The level at which the EVIDENCE gates (backtest / forward / demo performance /
 * drawdown / agent reliability / risk rules / drift) first become mandatory.
 * Pointing a mission at real money must clear at least this bar.
 */
export const PROMOTION_EVIDENCE_LEVEL: MissionAutomationLevel = 3;

export interface EvidenceBarVerdict {
  /** True only when every evidence gate required at PROMOTION_EVIDENCE_LEVEL passes. */
  passed: boolean;
  failedGates: string[];
  blockers: string[];
  demoEvidenceBasis: PromotionEvidenceBasis;
}

/**
 * PURE — does this mission clear the ladder's EVIDENCE bar?
 *
 * This closes the demo→live inversion. Before it, stepping a mission from demo
 * to LIVE required a certificate and the platform live switch but NO evidence at
 * all, while earning any auto level required the full promotion checklist — so
 * the easiest road to real money skipped the ladder entirely, and the only road
 * to autonomy was trading real money at level 2. Pointing a mission at real
 * money now requires exactly the evidence gates the ladder requires, evaluated
 * from the SAME evidence (which a paper/demo mission can now actually produce,
 * honestly labelled as simulated).
 *
 * Deliberately EXCLUDES the live-only gates (explicit enablement, certificate,
 * live master switch) and the guardrail ceiling: those are separate, still
 * enforced where they belong, and this must not silently duplicate or relax them.
 */
export function evaluateLadderEvidenceBar(e: PromotionEvidence): EvidenceBarVerdict {
  const decision = evaluateMissionPromotion(PROMOTION_EVIDENCE_LEVEL, e);
  const required = decision.gates.filter((g) => g.requiredFromLevel <= PROMOTION_EVIDENCE_LEVEL);
  const failed = required.filter((g) => !g.passed);
  return {
    passed: failed.length === 0,
    failedGates: failed.map((g) => g.name),
    blockers: failed.map((g) => `gate failed: ${g.name} — ${g.detail}`),
    demoEvidenceBasis: decision.demoEvidenceBasis,
  };
}
