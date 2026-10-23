import {
  type DecisionRecord, type DecisionQualityScore, type DecisionClassification,
  type SimulationResult, clamp01,
} from "./decisionIntelligence.types";

// ═══════════════════════════════════════════════════════════════════════════
// Decision Quality — score the PROCESS of a single decision, not its
// outcome. The reinforce/punish flags are derived from process quality:
//
//   reinforce = (qualityScore ≥ REINFORCE_AT) regardless of W/L
//   punish    = (qualityScore <  PUNISH_BELOW) regardless of W/L
//
// This is the central mechanism for refusing to reinforce undisciplined
// wins or punish high-quality losses.
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_QUALITY_TUNING = {
  REINFORCE_AT: 0.70,
  PUNISH_BELOW: 0.40,
  // Weights of the four process dimensions. Sum = 1.
  W_RULES:       0.30,
  W_RISK:        0.25,
  W_CHECKLIST:   0.20,
  W_SIM_APPROVE: 0.15,
  // Conviction-vs-confidence alignment is a soft modifier.
  W_CONVICTION_ALIGN: 0.10,
} as const;
export type QualityTuning = typeof DEFAULT_QUALITY_TUNING;

export interface QualityInput {
  decision: DecisionRecord;
  // Counterfactual outcome for NO_TRADE / BLOCKED decisions: what
  // realised R would have happened if the trade HAD been taken.
  // Optional — when absent we use neutral defaults.
  counterfactualR?: number;
  // VERIFIED simulation artifact. For TRADE-class decisions this is the
  // ONLY way to satisfy the futureRiskSim gate — the boolean flag on the
  // DecisionRecord is treated as untrusted hearsay and ignored unless
  // backed by a SimulationResult with approved=true. This makes the
  // pre-execution sim gate non-spoofable from upstream callers.
  simulationProof?: SimulationResult;
  tuning?: QualityTuning;
}

export function scoreDecisionQuality(input: QualityInput): DecisionQualityScore {
  const t = input.tuning ?? DEFAULT_QUALITY_TUNING;
  const d = input.decision;
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Verified sim approval — only true if a SimulationResult with
  // approved=true is supplied. Self-reported boolean is NOT trusted.
  const verifiedSimApproved = !!input.simulationProof?.approved;
  if (d.futureRiskSimApproved && !verifiedSimApproved) {
    reasons.push(`self-reported futureRiskSimApproved=true ignored — no SimulationResult proof attached`);
  }

  // 1) Process score — booleans → fractional contribution. Sim term uses
  // the VERIFIED flag, not the self-reported one.
  let process =
      (d.followedRules            ? t.W_RULES       : 0)
    + (d.riskSizingCorrect        ? t.W_RISK        : 0)
    + (d.preTradeChecklistPassed  ? t.W_CHECKLIST   : 0)
    + (verifiedSimApproved        ? t.W_SIM_APPROVE : 0);

  // 2) Conviction-vs-confidence alignment. Penalise large mismatch (e.g.
  // expressing 0.9 confidence on a 0.4 conviction signal).
  const align = 1 - Math.abs(d.expressedConfidence01 - d.convictionGrade01);
  process += t.W_CONVICTION_ALIGN * clamp01(align);
  reasons.push(`process score ${process.toFixed(3)} (rules ${d.followedRules}, risk ${d.riskSizingCorrect}, checklist ${d.preTradeChecklistPassed}, simVerified ${verifiedSimApproved}, align ${align.toFixed(2)})`);

  // The futureRiskSim is a hard pre-execution gate: if a TRADE-class
  // decision was taken without VERIFIED sim approval, it is structurally
  // undisciplined regardless of any other process signals.
  const isTradeKind = d.kind === "ENTRY" || d.kind === "SCALE_IN" || d.kind === "SCALE_OUT" || d.kind === "EXIT";
  if (isTradeKind && !verifiedSimApproved) {
    blockers.push(`TRADE decision taken without verified futureRiskSim approval`);
    process = Math.min(process, t.PUNISH_BELOW - 0.01);
    reasons.push(`process capped below PUNISH_BELOW for missing verified sim approval`);
  }

  const qualityScore01 = clamp01(process);

  // 3) Classification — uses outcome and counterfactual for labelling
  // ONLY. Quality and reinforce/punish flags are decoupled from outcome.
  // "Disciplined" includes verified sim approval so the label is
  // consistent with the process gate (no DISCIPLINED_LOSS without sim).
  const classification = classify(d, input.counterfactualR, verifiedSimApproved);
  reasons.push(`classification: ${classification}`);

  // 4) Reinforce/punish — derived from quality AND classification. The
  // outcome-decoupled invariants are enforced as HARD overrides so a high
  // numerical score on an UNDISCIPLINED_WIN can never reinforce, and a
  // low numerical score on a DISCIPLINED_LOSS can never punish.
  let reinforce = qualityScore01 >= t.REINFORCE_AT && classification !== "PENDING";
  let punish    = qualityScore01 <  t.PUNISH_BELOW && classification !== "PENDING";

  if (classification === "UNDISCIPLINED_WIN") {
    reasons.push(`UNDISCIPLINED_WIN — outcome not credited; reinforce HARD-OFF regardless of score ${qualityScore01.toFixed(3)}`);
    reinforce = false;
  }
  if (classification === "UNDISCIPLINED_LOSS") {
    // Always punish undisciplined losses, even if numerically borderline.
    if (!punish) reasons.push(`UNDISCIPLINED_LOSS — punish HARD-ON regardless of score ${qualityScore01.toFixed(3)}`);
    punish = true;
  }
  if (classification === "DISCIPLINED_LOSS") {
    reasons.push(`DISCIPLINED_LOSS — high-quality loss; punish HARD-OFF regardless of score ${qualityScore01.toFixed(3)}`);
    punish = false;
  }
  if (classification === "DISCIPLINED_WIN") {
    if (!reinforce && qualityScore01 >= t.PUNISH_BELOW) {
      reasons.push(`DISCIPLINED_WIN — reinforce remains based on score ${qualityScore01.toFixed(3)}`);
    }
  }
  if (classification === "NO_TRADE_SUCCESS") {
    reasons.push(`NO_TRADE_SUCCESS — restraint counted as a successful decision`);
  }
  if (classification === "BLOCKED_REGRET") {
    reasons.push(`BLOCKED_REGRET — block was protective process even if outcome would have won; punish HARD-OFF`);
    punish = false;
  }

  return {
    decisionId: d.decisionId,
    classification, qualityScore01,
    reinforce, punish,
    reasons, blockers,
  };
}

// ── Classification helper ─────────────────────────────────────────────────
function classify(
  d: DecisionRecord, cfR: number | undefined, verifiedSimApproved: boolean,
): DecisionClassification {
  if (d.outcome === "PENDING") return "PENDING";

  // "Disciplined" requires ALL process gates including a verified
  // futureRiskSim approval for trade-class decisions. NO_TRADE/BLOCKED do
  // not require sim approval since no execution risk was taken.
  const isTradeKind = d.kind === "ENTRY" || d.kind === "SCALE_IN" || d.kind === "SCALE_OUT" || d.kind === "EXIT";
  const disciplined =
       d.followedRules
    && d.riskSizingCorrect
    && d.preTradeChecklistPassed
    && (!isTradeKind || verifiedSimApproved);

  if (d.kind === "NO_TRADE") {
    if (d.outcome === "AVOIDED_LOSS") return "NO_TRADE_SUCCESS";
    if (d.outcome === "MISSED_WIN")   return "NO_TRADE_MISS";
    // If a counterfactual is provided, infer; otherwise treat as success
    // (default-safe: restraint is the rewarded behaviour).
    if (typeof cfR === "number") return cfR <= 0 ? "NO_TRADE_SUCCESS" : "NO_TRADE_MISS";
    return "NO_TRADE_SUCCESS";
  }
  if (d.kind === "BLOCKED") {
    if (typeof cfR === "number") return cfR <= 0 ? "BLOCKED_GOOD" : "BLOCKED_REGRET";
    if (d.outcome === "AVOIDED_LOSS") return "BLOCKED_GOOD";
    if (d.outcome === "MISSED_WIN")   return "BLOCKED_REGRET";
    return "BLOCKED_GOOD";
  }

  // Trade-class decision.
  if (d.outcome === "WIN" || (typeof d.realizedR === "number" && d.realizedR > 0)) {
    return disciplined ? "DISCIPLINED_WIN" : "UNDISCIPLINED_WIN";
  }
  if (d.outcome === "LOSS" || d.outcome === "BREAKEVEN" || (typeof d.realizedR === "number" && d.realizedR <= 0)) {
    return disciplined ? "DISCIPLINED_LOSS" : "UNDISCIPLINED_LOSS";
  }
  return "PENDING";
}
