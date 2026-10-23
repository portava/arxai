import {
  type DecisionRecord, type DecisionQualityScore, type SimulationResult,
  clamp01,
} from "./decisionIntelligence.types";
import { scoreDecisionQuality } from "./decisionQuality.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Decision Chain Scoring — grade the FULL sequence of decisions for a
// single trade idea (ENTRY → SCALE_IN/SCALE_OUT/HOLD → EXIT) rather than
// only the final outcome.
//
// Why this matters:
//   • A trade can have a great entry but a panicked exit → chain is bad.
//   • A trade can have an undisciplined entry but a competent exit → entry
//     is still UNDISCIPLINED; the chain shouldn't whitewash it.
//   • A SCALE_IN on a losing position immediately after a loss is a
//     classic revenge anti-pattern.
//
//   chainScore = weighted mean of per-step quality, weights bias toward
//                ENTRY (gate decision) and EXIT (close discipline).
//   reinforceChain = chainScore ≥ REINFORCE_AT AND no anti-patterns
//   punishChain    = chainScore <  PUNISH_BELOW OR  any anti-pattern
//
// Anti-patterns detected:
//   • REVENGE_SCALE_IN  — SCALE_IN within 5min of a LOSS in same chain
//   • PANIC_EXIT        — EXIT with disciplined=false right after wins
//   • UNDISCIPLINED_ENTRY_RESCUED_BY_LUCK — bad entry, lucky win
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_CHAIN_TUNING = {
  W_ENTRY:    0.40,
  W_MID:      0.20,   // SCALE_IN / SCALE_OUT / HOLD
  W_EXIT:     0.40,
  REINFORCE_AT: 0.70,
  PUNISH_BELOW: 0.40,
  REVENGE_WINDOW_MS: 5 * 60 * 1000,
} as const;
export type ChainTuning = typeof DEFAULT_CHAIN_TUNING;

export interface DecisionChainScore {
  chainId: string;
  chainQualityScore01: number;
  perStepScores: ReadonlyArray<DecisionQualityScore>;
  antiPatterns: ReadonlyArray<string>;
  reinforceChain: boolean;
  punishChain: boolean;
  reasons: ReadonlyArray<string>;
}

export interface DecisionChainInput {
  chainId: string;
  // Ordered chronologically.
  steps: ReadonlyArray<DecisionRecord>;
  // Optional simulation proofs keyed by decisionId — needed for the
  // ENTRY step's verified-sim gate inside scoreDecisionQuality.
  simulationProofs?: Readonly<Record<string, SimulationResult>>;
  // Optional counterfactuals keyed by decisionId — for NO_TRADE/BLOCKED
  // steps that may appear inside a chain (e.g. a partial exit replaced
  // by HOLD).
  counterfactualsR?: Readonly<Record<string, number>>;
  tuning?: ChainTuning;
}

export function scoreDecisionChain(input: DecisionChainInput): DecisionChainScore {
  const t = input.tuning ?? DEFAULT_CHAIN_TUNING;
  const reasons: string[] = [];
  const antiPatterns: string[] = [];

  if (input.steps.length === 0) {
    return {
      chainId: input.chainId,
      chainQualityScore01: 0,
      perStepScores: [],
      antiPatterns: [],
      reinforceChain: false, punishChain: false,
      reasons: [`empty chain — score=0`],
    };
  }

  const perStep: DecisionQualityScore[] = [];
  for (const step of input.steps) {
    const qScore = scoreDecisionQuality({
      decision: step,
      counterfactualR: input.counterfactualsR?.[step.decisionId],
      simulationProof: input.simulationProofs?.[step.decisionId],
    });
    perStep.push(qScore);
  }

  // Weighted aggregation by step kind.
  let weightSum = 0; let weighted = 0;
  for (let i = 0; i < input.steps.length; i++) {
    const k = input.steps[i]!.kind;
    const w = k === "ENTRY" ? t.W_ENTRY
            : k === "EXIT"  ? t.W_EXIT
            : t.W_MID;
    weightSum += w;
    weighted  += w * perStep[i]!.qualityScore01;
  }
  const chainQualityScore01 = clamp01(weightSum > 0 ? weighted / weightSum : 0);
  reasons.push(`weighted chainScore ${chainQualityScore01.toFixed(3)} across ${input.steps.length} steps`);

  // Anti-pattern: REVENGE_SCALE_IN — a SCALE_IN within REVENGE_WINDOW_MS
  // of a LOSS in the same chain.
  for (let i = 1; i < input.steps.length; i++) {
    const cur = input.steps[i]!;
    if (cur.kind !== "SCALE_IN") continue;
    const prev = input.steps[i - 1]!;
    const prevWasLoss = prev.outcome === "LOSS"
      || (typeof prev.realizedR === "number" && prev.realizedR < 0);
    if (!prevWasLoss) continue;
    const dtMs = isoMs(cur.takenAtIso) - isoMs(prev.takenAtIso);
    if (dtMs >= 0 && dtMs <= t.REVENGE_WINDOW_MS) {
      antiPatterns.push(`REVENGE_SCALE_IN at step ${i} (${dtMs}ms after loss)`);
    }
  }

  // Anti-pattern: PANIC_EXIT — EXIT step that is itself UNDISCIPLINED.
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i]!;
    const cls = perStep[i]!.classification;
    if (step.kind === "EXIT" && (cls === "UNDISCIPLINED_WIN" || cls === "UNDISCIPLINED_LOSS")) {
      antiPatterns.push(`PANIC_EXIT at step ${i} (${cls})`);
    }
  }

  // Anti-pattern: UNDISCIPLINED_ENTRY_RESCUED_BY_LUCK — first ENTRY is
  // UNDISCIPLINED_WIN.
  const firstEntryIdx = input.steps.findIndex((s) => s.kind === "ENTRY");
  if (firstEntryIdx >= 0 && perStep[firstEntryIdx]!.classification === "UNDISCIPLINED_WIN") {
    antiPatterns.push(`UNDISCIPLINED_ENTRY_RESCUED_BY_LUCK at step ${firstEntryIdx}`);
  }

  if (antiPatterns.length > 0) reasons.push(`anti-patterns: ${antiPatterns.join("; ")}`);

  // Reinforce/punish — anti-patterns are HARD overrides.
  let reinforceChain = chainQualityScore01 >= t.REINFORCE_AT && antiPatterns.length === 0;
  let punishChain    = chainQualityScore01 <  t.PUNISH_BELOW || antiPatterns.length > 0;
  if (antiPatterns.length > 0) {
    reasons.push(`anti-patterns force punishChain=true / reinforceChain=false regardless of score`);
    reinforceChain = false;
    punishChain    = true;
  }

  return {
    chainId: input.chainId,
    chainQualityScore01,
    perStepScores: perStep,
    antiPatterns,
    reinforceChain, punishChain, reasons,
  };
}

function isoMs(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}
