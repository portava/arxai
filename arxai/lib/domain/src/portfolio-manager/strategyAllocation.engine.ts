import {
  type StrategyMetrics, type StrategyAllocation, type RiskBudget,
  type MarketRegime, type TradingSession,
  STAGE_RISK_CAP_FRACTION, clamp01, clampNonNegative,
} from "./portfolio.types";
import { performanceWeightedAllocation } from "./performanceWeightedAllocation.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Allocation — turn a list of StrategyMetrics into a list of
// StrategyAllocation objects, each with a risk-R envelope. Composite
// score:
//
//   composite = w_v · validation
//             + w_p · performanceTanh
//             + w_r · regimeFit (× regime gate)
//             + w_e · executionQuality
//             + w_d · drawdownBehavior
//
// Then:
//   • Edge-decay penalty multiplies the composite (decaying strategies
//     fall fast).
//   • Stage cap: max risk = min(perStrategyCapR, deployableR · stageFrac).
//   • Composite scores are then run through softmax → weights → riskR.
//   • Strategies not designed for the active regime/session are gated to 0.
//
// Pure. Never exceeds budget caps.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_STRATEGY_WEIGHTS = {
  validation: 0.30,
  performance: 0.25,
  regimeFit: 0.20,
  executionQuality: 0.15,
  drawdownBehavior: 0.10,
} as const;
export type StrategyAllocWeights = typeof DEFAULT_STRATEGY_WEIGHTS;

export interface StrategyAllocationInput {
  strategies: ReadonlyArray<StrategyMetrics>;
  riskBudget: RiskBudget;
  activeRegime: MarketRegime;
  activeSession: TradingSession;
  weights?: StrategyAllocWeights;
  softmaxTemperature?: number;
  edgeDecayPenaltyAt?: number;       // slope at which penalty becomes 1.0; default -0.10
}

export interface StrategyAllocationOutput {
  allocations: ReadonlyArray<StrategyAllocation>;
  totalAllocatedR: number;
  reasons: string[];
}

export function allocateStrategies(input: StrategyAllocationInput): StrategyAllocationOutput {
  const w = input.weights ?? DEFAULT_STRATEGY_WEIGHTS;
  const decayAt = input.edgeDecayPenaltyAt ?? -0.10;
  const reasons: string[] = [];

  // 1) compute composite scores AND eligibility (regime/session gates,
  //    stage cap > 0, decay penalty < 1). Ineligible strategies are
  //    HARD-excluded from softmax — they never receive risk regardless of
  //    softmax shape (a zero score still gets positive softmax mass).
  const eligibleScores = new Map<string, number>();
  const meta = new Map<string, {
    stageCapR: number; decay01: number; eligible: boolean;
    reasons: string[]; blockers: string[];
  }>();
  for (const s of input.strategies) {
    const stageFrac = STAGE_RISK_CAP_FRACTION[s.tradeStage];
    const stageCapR = clampNonNegative(Math.min(
      input.riskBudget.perStrategyCapR,
      input.riskBudget.deployableR * stageFrac,
    ));
    const r: string[] = []; const b: string[] = [];

    const regimeOK = s.designedRegimes.includes("ANY") || s.designedRegimes.includes(input.activeRegime);
    const sessionOK = s.designedSessions.includes(input.activeSession);
    if (!regimeOK)  r.push(`regime gate ${input.activeRegime} ∉ designedRegimes — INELIGIBLE`);
    if (!sessionOK) r.push(`session gate ${input.activeSession} ∉ designedSessions — INELIGIBLE`);
    if (stageCapR === 0) r.push(`stage ${s.tradeStage} cap = 0 — INELIGIBLE`);

    // Edge decay penalty: 0 when slope ≥ 0; ramps to 1.0 at decayAt.
    const decay01 = s.edgeDecaySlope >= 0
      ? 0
      : clamp01(s.edgeDecaySlope / decayAt);
    if (decay01 > 0) r.push(`edgeDecay slope ${s.edgeDecaySlope.toFixed(3)} → penalty ${decay01.toFixed(2)}`);
    if (decay01 >= 1) r.push(`edgeDecay penalty = 1.0 — INELIGIBLE`);

    const eligible = regimeOK && sessionOK && stageCapR > 0 && decay01 < 1;
    let composite = 0;
    if (eligible) {
      const perfTanh = (Math.tanh(s.recentExpectancyR) + 1) / 2; // [0,1]
      composite =
          w.validation       * clamp01(s.validationScore01)
        + w.performance      * perfTanh
        + w.regimeFit        * clamp01(s.regimeFit01)
        + w.executionQuality * clamp01(s.executionQuality01)
        + w.drawdownBehavior * clamp01(s.drawdownBehavior01);
      composite = composite * (1 - decay01);
      r.push(`composite ${composite.toFixed(3)} (perfTanh ${perfTanh.toFixed(2)}, decay ${decay01.toFixed(2)})`);
      eligibleScores.set(s.strategyId, composite);
    } else {
      r.push(`excluded from softmax — riskR forced to 0`);
    }
    meta.set(s.strategyId, { stageCapR, decay01, eligible, reasons: r, blockers: b });
  }

  // 2) softmax over eligible cohort only — ineligible strategies do not
  // dilute the denominator and never receive any weight.
  const { weightsByStrategyId, reasons: pwReasons } =
    performanceWeightedAllocation({ scoresByStrategyId: eligibleScores, temperature: input.softmaxTemperature });
  reasons.push(`eligible cohort: ${eligibleScores.size}/${input.strategies.length}`);
  reasons.push(...pwReasons);

  // 3) translate weights into riskR honoring caps. Ineligible strategies
  // get an explicit zero allocation entry so callers see them in the plan.
  const allocations: StrategyAllocation[] = [];
  let totalAllocatedR = 0;
  for (const s of input.strategies) {
    const m = meta.get(s.strategyId)!;
    if (!m.eligible) {
      allocations.push({
        strategyId: s.strategyId,
        weight01: 0, riskR: 0,
        stageCapR: m.stageCapR,
        edgeDecayPenalty01: m.decay01,
        reasons: m.reasons,
        blockers: m.blockers,
      });
      continue;
    }
    const w01 = weightsByStrategyId.get(s.strategyId) ?? 0;
    const desired = input.riskBudget.deployableR * w01;
    const riskR = clampNonNegative(Math.min(desired, m.stageCapR));
    if (riskR < desired) m.reasons.push(`riskR clamped from ${desired.toFixed(2)} to stageCap ${m.stageCapR.toFixed(2)}`);
    allocations.push({
      strategyId: s.strategyId,
      weight01: clamp01(w01),
      riskR,
      stageCapR: m.stageCapR,
      edgeDecayPenalty01: m.decay01,
      reasons: m.reasons,
      blockers: m.blockers,
    });
    totalAllocatedR += riskR;
  }

  // 4) global clamp — if rounding/cap interactions pushed the sum over
  // deployableR, scale every allocation proportionally down.
  if (totalAllocatedR > input.riskBudget.deployableR && totalAllocatedR > 0) {
    const scale = input.riskBudget.deployableR / totalAllocatedR;
    reasons.push(`global sum ${totalAllocatedR.toFixed(2)} > deployable ${input.riskBudget.deployableR.toFixed(2)} — scaling by ${scale.toFixed(3)}`);
    for (const a of allocations) {
      const old = a.riskR;
      (a as { riskR: number }).riskR = clampNonNegative(old * scale);
      a.reasons.push(`global rebalance: ${old.toFixed(2)} → ${a.riskR.toFixed(2)}`);
    }
    totalAllocatedR = allocations.reduce((s, a) => s + a.riskR, 0);
  }

  return { allocations, totalAllocatedR, reasons };
}
