import {
  type DecisionRecord, type PatienceMetrics, type MarketPersonality,
  type ExpectancyMetrics, type FatigueState, type SimulationResult,
  clamp01, clampNonNegative,
} from "./decisionIntelligence.types";

// ── Patience mode recommendation ──────────────────────────────────────────
export type PatienceMode =
  | "PROCEED"
  | "WAIT"
  | "MONITOR_ONLY"
  | "SOFT_BLOCK"
  | "HARD_BLOCK";

export interface PatienceRecommendation {
  mode: PatienceMode;
  modeScore01: number;       // 1 = strongly proceed, 0 = strongly block
  reasons: string[];
  blockers: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Strategic Patience — measures how selective the system is and how often
// its restraint was rewarded. Inputs include:
//
//   • Total qualified setups (whether or not entered)
//   • Decision records (used to compute entries, no-trades, wait time)
//
// Selectivity: 1 − (entries / qualifiedSetups). High = picky.
// PatienceScore: weighted blend of selectivity, no-trade success rate, and
// a "wait reward" term (long avg wait paired with positive outcomes).
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface PatienceInput {
  records: ReadonlyArray<DecisionRecord>;
  qualifiedSetupsCount: number;
  // Optional: per-decision wait time in minutes since the prior trigger.
  waitMinutesByDecisionId?: ReadonlyMap<string, number>;
}

export function computePatienceMetrics(input: PatienceInput): PatienceMetrics {
  const reasons: string[] = [];
  const entries = input.records.filter((r) => r.kind === "ENTRY");
  const noTrades = input.records.filter((r) => r.kind === "NO_TRADE");
  const blocks = input.records.filter((r) => r.kind === "BLOCKED");

  const qualified = Math.max(0, input.qualifiedSetupsCount);
  const setupAcceptanceRatio01 = qualified > 0
    ? clamp01(entries.length / qualified)
    : 0;
  const selectivityScore01 = qualified > 0
    ? clamp01(1 - setupAcceptanceRatio01)
    : 0.5; // unknown universe → neutral
  reasons.push(`entries ${entries.length} / qualified ${qualified} → acceptance ${setupAcceptanceRatio01.toFixed(2)} · selectivity ${selectivityScore01.toFixed(2)}`);

  const restraint = [...noTrades, ...blocks];
  const restraintSuccess = restraint.filter((r) => r.outcome === "AVOIDED_LOSS").length;
  const restraintMiss    = restraint.filter((r) => r.outcome === "MISSED_WIN").length;
  const restraintResolved = restraintSuccess + restraintMiss;
  const noTradeSuccessRate01 = restraintResolved > 0
    ? clamp01(restraintSuccess / restraintResolved)
    : 0.5;
  reasons.push(`restraint resolved ${restraintResolved} (success ${restraintSuccess}, miss ${restraintMiss}) → rate ${noTradeSuccessRate01.toFixed(2)}`);

  // Average wait time across entries. Defaults to 0 if no map provided.
  let waitSum = 0; let waitN = 0;
  if (input.waitMinutesByDecisionId) {
    for (const e of entries) {
      const w = input.waitMinutesByDecisionId.get(e.decisionId);
      if (typeof w === "number" && w >= 0) { waitSum += w; waitN += 1; }
    }
  }
  const avgWaitMinutes = waitN > 0 ? clampNonNegative(waitSum / waitN) : 0;

  // Patience score blend: selectivity (0.45) · no-trade success (0.40) · wait-reward (0.15).
  // Wait-reward saturates at ~60 minutes via tanh.
  const waitReward = clamp01(Math.tanh(avgWaitMinutes / 60));
  const patienceScore01 = clamp01(
      0.45 * selectivityScore01
    + 0.40 * noTradeSuccessRate01
    + 0.15 * waitReward,
  );
  reasons.push(`patienceScore ${patienceScore01.toFixed(3)} (sel ${selectivityScore01.toFixed(2)} · ntSuccess ${noTradeSuccessRate01.toFixed(2)} · wait ${waitReward.toFixed(2)})`);

  return {
    setupAcceptanceRatio01, noTradeSuccessRate01,
    avgWaitMinutes, selectivityScore01, patienceScore01, reasons,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// recommendPatienceMode — translate (patience, market, expectancy, fatigue,
// optional sim proof) into one of:
//   PROCEED      — green light
//   WAIT         — defer briefly, conditions are noisy
//   MONITOR_ONLY — observe but do not enter
//   SOFT_BLOCK   — expectancy is poor, do not enter
//   HARD_BLOCK   — safety override (cooldown / sim declined)
//
// Hard rules (non-overridable):
//   1. fatigue.forceCooldown=true → HARD_BLOCK
//   2. simulationProof.approved=false → HARD_BLOCK
//
// Soft rules (priority order):
//   3. expectancy.expectancyR < 0 → SOFT_BLOCK
//   4. market.frenzy01 ≥ 0.70 AND market.noisy01 ≥ 0.50 → MONITOR_ONLY
//   5. market.noisy01 ≥ 0.50  OR market.dominantTrait="NOISY" → WAIT
//   6. else → PROCEED
// ═══════════════════════════════════════════════════════════════════════════

export interface PatienceRecommendationInput {
  patience: PatienceMetrics;
  market: MarketPersonality;
  expectancy: ExpectancyMetrics;
  fatigue: FatigueState;
  simulationProof?: SimulationResult;
}

export function recommendPatienceMode(
  input: PatienceRecommendationInput,
): PatienceRecommendation {
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Hard rule 1 — fatigue cooldown.
  if (input.fatigue.forceCooldown) {
    blockers.push(`fatigue cooldown active (${input.fatigue.cooldownMinutes.toFixed(0)}m)`);
    return {
      mode: "HARD_BLOCK", modeScore01: 0,
      reasons: [`HARD_BLOCK — fatigue cooldown`], blockers,
    };
  }
  // Hard rule 2 — sim proof says no.
  if (input.simulationProof && !input.simulationProof.approved) {
    blockers.push(`futureRiskSim declined (${input.simulationProof.blockers.join("; ") || "no reason"})`);
    return {
      mode: "HARD_BLOCK", modeScore01: 0,
      reasons: [`HARD_BLOCK — verified futureRiskSim declined`], blockers,
    };
  }

  // Soft rule 3 — negative expectancy.
  if (input.expectancy.expectancyR < 0) {
    reasons.push(`SOFT_BLOCK — expectancyR ${input.expectancy.expectancyR.toFixed(3)} < 0`);
    return { mode: "SOFT_BLOCK", modeScore01: 0.20, reasons, blockers };
  }

  // Soft rule 4 — high frenzy + noisy.
  const frenzy = clamp01(input.market.frenzy01);
  const noisy  = clamp01(input.market.noisy01);
  if (frenzy >= 0.70 && noisy >= 0.50) {
    reasons.push(`MONITOR_ONLY — frenzy ${frenzy.toFixed(2)} & noisy ${noisy.toFixed(2)}`);
    return { mode: "MONITOR_ONLY", modeScore01: 0.35, reasons, blockers };
  }

  // Soft rule 5 — noisy market or dominant noisy trait.
  if (noisy >= 0.50 || input.market.dominantTrait === "NOISY") {
    reasons.push(`WAIT — noisy market (noisy ${noisy.toFixed(2)}, dominant ${input.market.dominantTrait})`);
    return { mode: "WAIT", modeScore01: 0.55, reasons, blockers };
  }

  // Default — proceed. modeScore reflects patience health (the more
  // patient the system has been, the more confident the proceed).
  reasons.push(`PROCEED — no blockers (patienceScore ${input.patience.patienceScore01.toFixed(2)})`);
  return {
    mode: "PROCEED",
    modeScore01: clamp01(0.7 + 0.3 * input.patience.patienceScore01),
    reasons, blockers,
  };
}
