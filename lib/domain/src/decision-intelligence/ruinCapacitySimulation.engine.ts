// ═══════════════════════════════════════════════════════════════════════════
// Capability #23 — Risk-of-Ruin & Capacity Simulator with frictions.
//
// Extends the base futureRiskSimulation (which stays untouched) with the ruin
// inputs the audit found missing:
//
//   • correlation      — a common regime shock makes concurrent positions win
//                        or lose TOGETHER with probability correlation01
//   • liquidity        — fill probability, partial fills, slippage cost per
//                        executed trade
//   • broker failure   — a per-trade venue-failure probability that converts
//                        a normal exit into a slipped worst-case loss
//
// Plus:
//   • estimateStrategyCapacity — the largest per-trade risk (R) that keeps
//     simulated ruin probability inside the guardrail (monotone bisection)
//   • compareSimulatedVsRealized — honest comparison of the simulated
//     distribution against realized demo outcomes; returns a typed
//     INSUFFICIENT_DATA verdict when the demo sample cannot support one.
//
// Determinism: mulberry32 seeded from input.seed — same input, same output.
// SAFETY: advisory only. Nothing here approves a trade; verdicts can only be
// consumed as evidence by gates that already exist.
// ═══════════════════════════════════════════════════════════════════════════

export interface FrictionRuinInput {
  candidateRiskR: number;
  winRate01: number;
  avgWinR: number;
  avgLossR: number;                    // must be negative
  pathsToSimulate: number;
  horizonTrades: number;
  ruinThresholdR: number;              // negative
  seed: number;
  /** Number of concurrent correlated positions carried per step (≥1). */
  concurrentPositions?: number;
  /** 0..1 — probability a step is driven by a COMMON shock hitting all
   *  concurrent positions with the same outcome. 0 = independent. */
  correlation01?: number;
  liquidity?: {
    /** 0..1 — probability an intended trade fills at all. */
    fillProbability01: number;
    /** 0..1 — expected filled fraction when a fill is partial (1 = full). */
    partialFillMean01: number;
    /** R cost per executed trade (slippage + spread), ≥ 0. */
    slippageR: number;
  };
  brokerFailure?: {
    /** 0..1 — per-trade probability the venue fails during the trade. */
    perTradeFailureProb01: number;
    /** Multiplier on the loss leg when failure strikes (stop slips), ≥ 1. */
    failureSlipMultiplier: number;
  };
}

export interface FrictionRuinResult {
  paths: number;
  meanFinalR: number;
  medianFinalR: number;
  p05FinalR: number;
  worstFinalR: number;
  ruinProbability01: number;
  /** Fraction of intended trades that never filled (liquidity honesty). */
  unfilledFraction01: number;
  /** Fraction of executed trades hit by a simulated broker failure. */
  brokerFailureFraction01: number;
  withinGuardrail: boolean;            // ruin ≤ 5% and p05 above threshold
  reasons: string[];
  blockers: string[];
}

const RUIN_PROB_GUARDRAIL = 0.05;

function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

export function simulateRuinWithFrictions(input: FrictionRuinInput): FrictionRuinResult {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const paths = Math.max(1, Math.floor(input.pathsToSimulate));
  const horizon = Math.max(1, Math.floor(input.horizonTrades));
  const p = clamp01(input.winRate01);
  const win = input.avgWinR;
  const loss = input.avgLossR;
  const ruinAt = input.ruinThresholdR;
  const nConc = Math.max(1, Math.floor(input.concurrentPositions ?? 1));
  const rho = clamp01(input.correlation01 ?? 0);
  const fillP = clamp01(input.liquidity?.fillProbability01 ?? 1);
  const partial = clamp01(input.liquidity?.partialFillMean01 ?? 1);
  const slip = Math.max(0, input.liquidity?.slippageR ?? 0);
  const failP = clamp01(input.brokerFailure?.perTradeFailureProb01 ?? 0);
  const failMult = Math.max(1, input.brokerFailure?.failureSlipMultiplier ?? 1);

  if (input.candidateRiskR <= 0) blockers.push(`candidateRiskR ≤ 0 — nothing to simulate`);
  if (loss >= 0) blockers.push(`avgLossR must be < 0 (received ${loss}) — degenerate distribution`);
  if (blockers.length > 0) {
    return {
      paths, meanFinalR: 0, medianFinalR: 0, p05FinalR: 0, worstFinalR: 0,
      ruinProbability01: 1, unfilledFraction01: 0, brokerFailureFraction01: 0,
      withinGuardrail: false,
      reasons: [`simulation skipped due to blockers`], blockers,
    };
  }

  const rng = mulberry32(input.seed >>> 0);
  const finals: number[] = new Array(paths);
  let ruined = 0;
  let intended = 0, unfilled = 0, executed = 0, brokerFailures = 0;

  for (let i = 0; i < paths; i++) {
    let cum = 0;
    let pathRuined = false;
    for (let t = 0; t < horizon && !pathRuined; t++) {
      // Common-shock correlation: with prob rho, one draw drives ALL
      // concurrent positions; otherwise each draws independently.
      const common = rng() < rho;
      const commonWin = rng() < p;
      for (let k = 0; k < nConc; k++) {
        intended += 1;
        if (rng() >= fillP) { unfilled += 1; continue; }   // no fill, no risk, no cost
        executed += 1;
        const fillFrac = partial < 1 ? partial : 1;
        const isWin = common ? commonWin : rng() < p;
        let r = (isWin ? win : loss) * fillFrac;
        if (rng() < failP) {
          brokerFailures += 1;
          // Venue failure: a win degrades to a slipped loss; a loss slips further.
          r = loss * failMult * fillFrac;
        }
        r -= slip;                                          // friction on every fill
        cum += r * input.candidateRiskR;
        if (cum <= ruinAt) { pathRuined = true; break; }
      }
    }
    finals[i] = cum;
    if (pathRuined) ruined += 1;
  }

  const sorted = [...finals].sort((a, b) => a - b);
  const meanFinalR = finals.reduce((s, x) => s + x, 0) / paths;
  const medianFinalR = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p05FinalR = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const worstFinalR = sorted[0] ?? 0;
  const ruinProbability01 = clamp01(ruined / paths);
  const unfilledFraction01 = intended > 0 ? unfilled / intended : 0;
  const brokerFailureFraction01 = executed > 0 ? brokerFailures / executed : 0;

  reasons.push(`paths ${paths} · horizon ${horizon} · concurrent ${nConc} · ρ ${rho.toFixed(2)} · fillP ${fillP.toFixed(2)} · partial ${partial.toFixed(2)} · slip ${slip}R · brokerFailP ${failP.toFixed(3)}`);
  reasons.push(`mean ${meanFinalR.toFixed(2)} · p05 ${p05FinalR.toFixed(2)} · worst ${worstFinalR.toFixed(2)} · pRuin ${ruinProbability01.toFixed(3)} · unfilled ${(unfilledFraction01 * 100).toFixed(1)}% · venueFail ${(brokerFailureFraction01 * 100).toFixed(2)}%`);

  const withinGuardrail = ruinProbability01 <= RUIN_PROB_GUARDRAIL && p05FinalR >= ruinAt;
  if (!withinGuardrail) {
    if (ruinProbability01 > RUIN_PROB_GUARDRAIL) blockers.push(`ruinProbability ${ruinProbability01.toFixed(3)} > ${RUIN_PROB_GUARDRAIL}`);
    if (p05FinalR < ruinAt) blockers.push(`p05FinalR ${p05FinalR.toFixed(2)} < ruinThreshold ${ruinAt}`);
  }

  return {
    paths, meanFinalR, medianFinalR, p05FinalR, worstFinalR,
    ruinProbability01, unfilledFraction01, brokerFailureFraction01,
    withinGuardrail, reasons, blockers,
  };
}

// ── Per-strategy capacity estimate ─────────────────────────────────────────

export interface CapacityEstimateResult {
  status: "ESTIMATED" | "NO_SAFE_CAPACITY" | "DEGENERATE_INPUT";
  /** Largest per-trade risk (R) whose simulated ruin stays inside the
   *  guardrail. 0 when NO_SAFE_CAPACITY. */
  capacityRiskR: number;
  /** (riskR, ruinProbability) points probed during the search. */
  probes: Array<{ riskR: number; ruinProbability01: number }>;
  reasons: string[];
}

export function estimateStrategyCapacity(
  base: Omit<FrictionRuinInput, "candidateRiskR">,
  opts?: { maxRiskR?: number; iterations?: number },
): CapacityEstimateResult {
  const maxRiskR = Math.max(opts?.maxRiskR ?? 8, 0.01);
  const iterations = Math.max(4, Math.min(opts?.iterations ?? 12, 24));
  const probes: Array<{ riskR: number; ruinProbability01: number }> = [];
  const runAt = (riskR: number) =>
    simulateRuinWithFrictions({ ...base, candidateRiskR: riskR });

  const sanity = runAt(0.01);
  if (sanity.blockers.some((b) => b.includes("degenerate"))) {
    return {
      status: "DEGENERATE_INPUT", capacityRiskR: 0, probes,
      reasons: [`distribution degenerate — capacity cannot be estimated`, ...sanity.blockers],
    };
  }
  probes.push({ riskR: 0.01, ruinProbability01: sanity.ruinProbability01 });
  if (!sanity.withinGuardrail) {
    return {
      status: "NO_SAFE_CAPACITY", capacityRiskR: 0, probes,
      reasons: [`even 0.01R per trade breaches the ruin guardrail — this strategy has no safe capacity under the supplied frictions`],
    };
  }

  // Bisection on the (empirically monotone) ruin-vs-risk curve.
  let lo = 0.01;                       // known safe
  let hi = maxRiskR;                   // possibly unsafe
  const atMax = runAt(hi);
  probes.push({ riskR: hi, ruinProbability01: atMax.ruinProbability01 });
  if (atMax.withinGuardrail) {
    return {
      status: "ESTIMATED", capacityRiskR: hi, probes,
      reasons: [`guardrail holds even at the probe ceiling ${hi}R — capacity reported AT the ceiling (not beyond it)`],
    };
  }
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const r = runAt(mid);
    probes.push({ riskR: mid, ruinProbability01: r.ruinProbability01 });
    if (r.withinGuardrail) lo = mid; else hi = mid;
  }
  return {
    status: "ESTIMATED", capacityRiskR: lo, probes,
    reasons: [`capacity ≈ ${lo.toFixed(3)}R per trade (largest probed risk keeping ruin ≤ ${RUIN_PROB_GUARDRAIL} over ${base.horizonTrades} trades)`],
  };
}

// ── Simulated vs realized comparison ───────────────────────────────────────

export const MIN_REALIZED_SAMPLE = 30;

export type SimVsRealizedStatus = "COMPARED" | "INSUFFICIENT_DATA";

export interface SimVsRealizedResult {
  status: SimVsRealizedStatus;
  /** Typed reason when INSUFFICIENT_DATA. */
  insufficientReason?:
    | "TOO_FEW_REALIZED_TRADES"
    | "NO_REALIZED_LOSSES"
    | "NO_REALIZED_WINS"
    | "NO_REALIZED_DATA";
  realizedSampleSize: number;
  simulatedWinRate01?: number;
  realizedWinRate01?: number;
  winRateDelta?: number;
  /** avgWin/|avgLoss| — unitless, comparable without fabricating an R basis. */
  simulatedPayoffRatio?: number;
  realizedPayoffRatio?: number;
  payoffRatioDelta?: number;
  verdict?: "CONSISTENT" | "DIVERGENT";
  reasons: string[];
}

/**
 * Compares the simulator's assumed distribution against realized demo
 * outcomes. Uses ONLY unitless quantities (win rate; payoff ratio
 * avgWin/|avgLoss|) so no synthetic R basis is ever invented for realized
 * trades whose currency risk basis is not recorded.
 */
export function compareSimulatedVsRealized(args: {
  simulated: { winRate01: number; avgWinR: number; avgLossR: number };
  realizedPnls: ReadonlyArray<number>;   // closed-trade P&L, currency units
  minSample?: number;
}): SimVsRealizedResult {
  const minSample = Math.max(1, args.minSample ?? MIN_REALIZED_SAMPLE);
  const pnls = args.realizedPnls.filter((x) => Number.isFinite(x));
  const n = pnls.length;
  if (n === 0) {
    return {
      status: "INSUFFICIENT_DATA", insufficientReason: "NO_REALIZED_DATA",
      realizedSampleSize: 0,
      reasons: [`no realized demo trades with computed P&L — comparison honestly unavailable`],
    };
  }
  if (n < minSample) {
    return {
      status: "INSUFFICIENT_DATA", insufficientReason: "TOO_FEW_REALIZED_TRADES",
      realizedSampleSize: n,
      reasons: [`only ${n} realized demo trade(s); need ≥ ${minSample} for a meaningful distribution comparison`],
    };
  }
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x < 0);
  if (losses.length === 0) {
    return {
      status: "INSUFFICIENT_DATA", insufficientReason: "NO_REALIZED_LOSSES",
      realizedSampleSize: n,
      reasons: [`realized sample has no losing trades — payoff ratio undefined; refusing to fabricate one`],
    };
  }
  if (wins.length === 0) {
    return {
      status: "INSUFFICIENT_DATA", insufficientReason: "NO_REALIZED_WINS",
      realizedSampleSize: n,
      reasons: [`realized sample has no winning trades — payoff ratio undefined; refusing to fabricate one`],
    };
  }
  const realizedWinRate01 = wins.length / n;
  const avgWin = wins.reduce((s, x) => s + x, 0) / wins.length;
  const avgLoss = losses.reduce((s, x) => s + x, 0) / losses.length; // negative
  const realizedPayoffRatio = avgWin / Math.abs(avgLoss);
  const simulatedWinRate01 = clamp01(args.simulated.winRate01);
  const simulatedPayoffRatio = Math.abs(args.simulated.avgLossR) > 0
    ? args.simulated.avgWinR / Math.abs(args.simulated.avgLossR)
    : Number.POSITIVE_INFINITY;

  const winRateDelta = realizedWinRate01 - simulatedWinRate01;
  const payoffRatioDelta = realizedPayoffRatio - simulatedPayoffRatio;
  // Consistency: win-rate within ±10 points AND payoff ratio within ±35%.
  const winRateOk = Math.abs(winRateDelta) <= 0.10;
  const payoffOk = Number.isFinite(simulatedPayoffRatio) && simulatedPayoffRatio > 0
    ? Math.abs(payoffRatioDelta) / simulatedPayoffRatio <= 0.35
    : false;
  const verdict = winRateOk && payoffOk ? "CONSISTENT" : "DIVERGENT";
  return {
    status: "COMPARED", realizedSampleSize: n,
    simulatedWinRate01, realizedWinRate01, winRateDelta,
    simulatedPayoffRatio, realizedPayoffRatio, payoffRatioDelta,
    verdict,
    reasons: [
      `win rate: simulated ${(simulatedWinRate01 * 100).toFixed(1)}% vs realized ${(realizedWinRate01 * 100).toFixed(1)}% (Δ ${(winRateDelta * 100).toFixed(1)} pts)`,
      `payoff ratio: simulated ${simulatedPayoffRatio.toFixed(2)} vs realized ${realizedPayoffRatio.toFixed(2)}`,
      `verdict: ${verdict} (n=${n} realized demo trades)`,
    ],
  };
}
