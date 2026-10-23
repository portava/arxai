import {
  type SimulationInput, type SimulationResult, clamp01,
} from "./decisionIntelligence.types";

// ═══════════════════════════════════════════════════════════════════════════
// Future Risk Simulation — deterministic Monte-Carlo over hypothetical
// trade paths sampled from the supplied distribution (winRate, avgWin,
// avgLoss). Computes mean / median / p05 / worst final R and ruin
// probability. Returns approval verdict.
//
// Determinism: a Mulberry32 PRNG seeded from input.seed. Same input →
// same output, always.
//
// Approval rules:
//   • approved=true requires:
//       p05FinalR ≥ ruinThresholdR
//       AND ruinProbability ≤ 0.05
//       AND meanFinalR ≥ 0  (positive expectancy on the simulated path)
// ═══════════════════════════════════════════════════════════════════════════

export function simulateFutureRisk(input: SimulationInput): SimulationResult {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const paths = Math.max(1, input.pathsToSimulate);
  const horizon = Math.max(1, input.horizonTrades);
  const p = clamp01(input.winRate01);
  const win = input.avgWinR;
  const loss = input.avgLossR;
  const ruinAt = input.ruinThresholdR;
  const rng = mulberry32(input.seed >>> 0);

  if (input.candidateRiskR <= 0) {
    blockers.push(`candidateRiskR ≤ 0 — nothing to simulate`);
  }
  if (loss >= 0) {
    blockers.push(`avgLossR must be < 0 (received ${loss}) — degenerate distribution`);
  }
  if (blockers.length > 0) {
    return zeroResult(paths, [...reasons, `simulation skipped due to blockers`], blockers);
  }

  const finals: number[] = new Array(paths);
  let ruined = 0;

  for (let i = 0; i < paths; i++) {
    let cum = 0;
    let pathRuined = false;
    for (let t = 0; t < horizon; t++) {
      const r = rng() < p ? win : loss;
      cum += r * input.candidateRiskR;
      if (cum <= ruinAt) { pathRuined = true; break; }
    }
    finals[i] = cum;
    if (pathRuined) ruined += 1;
  }

  const sorted = [...finals].sort((a, b) => a - b);
  const meanFinalR   = finals.reduce((s, x) => s + x, 0) / paths;
  const medianFinalR = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p05FinalR    = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const worstFinalR  = sorted[0] ?? 0;
  const ruinProbability01 = clamp01(ruined / paths);

  reasons.push(
    `paths ${paths} · horizon ${horizon} · p ${p.toFixed(2)} · win ${win}R · loss ${loss}R · candidate ${input.candidateRiskR}R`);
  reasons.push(
    `mean ${meanFinalR.toFixed(2)} · median ${medianFinalR.toFixed(2)} · p05 ${p05FinalR.toFixed(2)} · worst ${worstFinalR.toFixed(2)} · pRuin ${ruinProbability01.toFixed(3)}`);

  const ruinOK = p05FinalR >= ruinAt;
  const probOK = ruinProbability01 <= 0.05;
  const meanOK = meanFinalR >= 0;
  if (!ruinOK)  blockers.push(`p05FinalR ${p05FinalR.toFixed(2)} < ruinThreshold ${ruinAt}`);
  if (!probOK)  blockers.push(`ruinProbability ${ruinProbability01.toFixed(3)} > 0.05`);
  if (!meanOK)  blockers.push(`meanFinalR ${meanFinalR.toFixed(2)} < 0 — negative simulated expectancy`);
  const approved = ruinOK && probOK && meanOK;
  reasons.push(approved ? `APPROVED` : `DECLINED — ${blockers.length} guardrail(s)`);

  return {
    paths, meanFinalR, medianFinalR, p05FinalR, worstFinalR,
    ruinProbability01, approved, reasons, blockers,
  };
}

// ── Mulberry32 PRNG (deterministic, fast, public domain) ─────────────────
function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function zeroResult(paths: number, reasons: string[], blockers: string[]): SimulationResult {
  return {
    paths, meanFinalR: 0, medianFinalR: 0, p05FinalR: 0, worstFinalR: 0,
    ruinProbability01: 1, approved: false, reasons, blockers,
  };
}
