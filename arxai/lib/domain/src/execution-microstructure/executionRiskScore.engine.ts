// ═══════════════════════════════════════════════════════════════════════════
// Execution Risk Score — Phase 4
//
// Composite [0..1] of microstructure risk. Aggregates the existing
// sub-engine outputs (spread, fill, liquidity, slippage, stress, broker)
// PLUS measured decision-time latency, and maps the score onto:
//
//   level             ∈ LOW | MODERATE | ELEVATED | HIGH | CRITICAL
//   recommendedAction ∈ NONE | REDUCE_SIZE | DELAY | WAIT | SOFT_BLOCK | HARD_BLOCK
//   recommendedSizeMultiplier ∈ [0..1]
//   recommendedDelayMs        ∈ [0..n]
//
// Hard-block conditions (any → HARD_BLOCK + size 0):
//   • spread / liquidity / broker emitted hard blockers
//   • execution stress level == CRITICAL
//   • broker reliability < 0.40
//   • latency >= 1500ms
//   • worst-case slippage > 50% of stop
//
// SOFT_BLOCK: stress HIGH + fill < 0.55, OR broker reliability < 0.55.
// WAIT: latency 800..1500 ms, OR fill 0.55..0.65.
// DELAY: stress ELEVATED, news active window with high spread inflation.
// REDUCE_SIZE: liquidity shortfall (partial) OR fill 0.65..0.80.
// NONE: clean.
//
// Pure. Never throws.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import {
  type OrderContext,
  type SlippagePrediction,
  type SpreadVerdict,
  type FillProbability,
  type LiquidityVerdict,
  type ExecutionStress,
  type BrokerReliability,
  type ExecutionRiskScore,
  type ExecutionRiskLevel,
  type ExecutionRecommendedAction,
  clamp01,
} from "./executionMicrostructure.types";

// Canonical Zod enum + inferred type for the lite council verdict that this
// engine consumes. Exported so route handlers can parse req bodies into the
// exact same type — no force-casts at the boundary.
export const CouncilVerdictLiteSchema = z.enum([
  "EXECUTE", "REDUCE_SIZE", "MONITOR_ONLY",
  "EXECUTE_IF", "WAIT", "SOFT_BLOCK", "HARD_BLOCK",
]);
export type CouncilVerdictLite = z.infer<typeof CouncilVerdictLiteSchema>;

export interface ExecutionRiskInput {
  order: OrderContext;
  spread: SpreadVerdict;
  fill: FillProbability;
  liquidity: LiquidityVerdict;
  slippage: SlippagePrediction;
  stress: ExecutionStress;
  broker: BrokerReliability;
  latencyMs: number;          // measured decision-time latency
}

const HARD_LATENCY_MS = 1500;
const WAIT_LATENCY_MS = 800;

export function computeExecutionRiskScore(input: ExecutionRiskInput): ExecutionRiskScore {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const o = input.order;

  // ─── Component scalars (higher = riskier) ─────────────────────────────
  const spread01 = clamp01(input.spread.spreadRatio > 1 ? (input.spread.spreadRatio - 1) / 3 : 0);
  const fill01 = clamp01(1 - input.fill.probability01);
  const liquidity01 = input.order.intendedSizeLots > 0
    ? clamp01(input.liquidity.shortfallLots / input.order.intendedSizeLots)
    : 0;
  const slippage01 = clamp01(input.slippage.expectedSlippagePips / Math.max(1, o.stopLossPips));
  const stress01 = clamp01(input.stress.score01);
  const broker01 = clamp01(1 - input.broker.reliability01);
  const latency01 = clamp01(input.latencyMs / HARD_LATENCY_MS);

  // Weighted composite. Spread + fill + slippage carry the most weight
  // because they directly invalidate the trade thesis.
  const score01 = clamp01(
      0.18 * spread01
    + 0.18 * fill01
    + 0.14 * liquidity01
    + 0.18 * slippage01
    + 0.12 * stress01
    + 0.12 * broker01
    + 0.08 * latency01,
  );
  reasons.push(
    `composite ${score01.toFixed(2)} — spread ${spread01.toFixed(2)} · fill ${fill01.toFixed(2)} · liq ${liquidity01.toFixed(2)} · slip ${slippage01.toFixed(2)} · stress ${stress01.toFixed(2)} · broker ${broker01.toFixed(2)} · lat ${latency01.toFixed(2)}`,
  );

  // ─── Hard blockers (any → HARD_BLOCK) ─────────────────────────────────
  blockers.push(...input.spread.blockers, ...input.liquidity.blockers, ...input.broker.blockers);
  if (input.stress.level === "CRITICAL") {
    blockers.push(`execution stress CRITICAL (${input.stress.score01.toFixed(2)})`);
  }
  if (input.broker.reliability01 < 0.40) {
    blockers.push(`broker reliability ${input.broker.reliability01.toFixed(2)} < 0.40`);
  }
  if (input.latencyMs >= HARD_LATENCY_MS) {
    blockers.push(`decision latency ${input.latencyMs.toFixed(0)}ms ≥ hard cap ${HARD_LATENCY_MS}ms`);
  }
  if (input.slippage.worstCaseSlippagePips > 0.5 * o.stopLossPips) {
    blockers.push(`worst-case slippage ${input.slippage.worstCaseSlippagePips.toFixed(1)}p > 50% of stop ${o.stopLossPips}p`);
  }

  // ─── Action mapping ───────────────────────────────────────────────────
  let recommendedAction: ExecutionRecommendedAction = "NONE";
  let recommendedSizeMultiplier = 1;
  let recommendedDelayMs = 0;

  if (blockers.length > 0) {
    recommendedAction = "HARD_BLOCK";
    recommendedSizeMultiplier = 0;
    reasons.push(`HARD_BLOCK — ${blockers.length} hard guardrail(s)`);
  } else if (
    (input.stress.level === "HIGH" && input.fill.probability01 < 0.55) ||
    input.broker.reliability01 < 0.55
  ) {
    recommendedAction = "SOFT_BLOCK";
    recommendedSizeMultiplier = 0;
    reasons.push(
      input.broker.reliability01 < 0.55
        ? `SOFT_BLOCK — broker reliability ${input.broker.reliability01.toFixed(2)} < 0.55`
        : `SOFT_BLOCK — stress HIGH with fill ${input.fill.probability01.toFixed(2)}`,
    );
  } else if (
    (input.latencyMs >= WAIT_LATENCY_MS && input.latencyMs < HARD_LATENCY_MS) ||
    (input.fill.probability01 >= 0.55 && input.fill.probability01 < 0.65)
  ) {
    recommendedAction = "WAIT";
    recommendedSizeMultiplier = 0;
    reasons.push(`WAIT — latency ${input.latencyMs.toFixed(0)}ms / fill ${input.fill.probability01.toFixed(2)}`);
  } else if (input.stress.level === "ELEVATED" || (o.newsActiveWindow && spread01 > 0.4)) {
    recommendedAction = "DELAY";
    recommendedSizeMultiplier = 0.5;
    recommendedDelayMs = 5_000;
    reasons.push(`DELAY 5s — stress ${input.stress.level}${o.newsActiveWindow ? " + news window" : ""}`);
  } else if (
    (!input.liquidity.sufficient && input.liquidity.fillableLots > 0) ||
    (input.fill.probability01 >= 0.65 && input.fill.probability01 < 0.80) ||
    slippage01 > 0.25
  ) {
    recommendedAction = "REDUCE_SIZE";
    recommendedSizeMultiplier = !input.liquidity.sufficient && input.liquidity.fillableLots > 0
      ? clamp01(input.liquidity.fillableLots / Math.max(1e-9, o.intendedSizeLots))
      : 0.5;
    reasons.push(`REDUCE_SIZE × ${recommendedSizeMultiplier.toFixed(2)}`);
  } else {
    reasons.push(`NONE — execution conditions clean`);
  }

  // ─── Warnings (informational) ─────────────────────────────────────────
  if (input.spread.spreadRatio > 2) warnings.push(`spread spike ${input.spread.spreadRatio.toFixed(2)}× avg`);
  if (input.latencyMs >= WAIT_LATENCY_MS) warnings.push(`elevated latency ${input.latencyMs.toFixed(0)}ms`);
  if (input.broker.reliability01 < 0.70) warnings.push(`broker reliability ${input.broker.reliability01.toFixed(2)}`);
  if (input.fill.probability01 < 0.80) warnings.push(`fill probability ${input.fill.probability01.toFixed(2)}`);

  // ─── Level mapping (independent of action — observability) ────────────
  const level: ExecutionRiskLevel =
      score01 >= 0.80 || recommendedAction === "HARD_BLOCK" ? "CRITICAL"
    : score01 >= 0.60 || recommendedAction === "SOFT_BLOCK" ? "HIGH"
    : score01 >= 0.40 || recommendedAction === "WAIT"        ? "ELEVATED"
    : score01 >= 0.20 || recommendedAction !== "NONE"        ? "MODERATE"
    : "LOW";

  return {
    score01, level,
    recommendedAction, recommendedSizeMultiplier, recommendedDelayMs,
    reasons, warnings, blockers,
    components: { spread01, fill01, liquidity01, slippage01, stress01, broker01, latency01 },
  };
}

// ─── Verdict integration ─────────────────────────────────────────────────
// Applies an ExecutionRiskScore to a council CouncilVerdict, never UPGRADING
// (execution can only be protective). Returns the (possibly downgraded)
// verdict plus a size multiplier the Risk Governor can consume.
//
// Strictness ordering (most permissive → most strict):
//   EXECUTE → REDUCE_SIZE → MONITOR_ONLY → EXECUTE_IF → WAIT → SOFT_BLOCK → HARD_BLOCK
//
// WAIT is strictly stricter than EXECUTE_IF: a conditional-go is still a
// "go on condition", whereas WAIT is an unconditional pause. Execution may
// downgrade EXECUTE_IF → WAIT when latency / fill risk demands pause.
const STRICTNESS: Record<CouncilVerdictLite, number> = {
  EXECUTE: 0, REDUCE_SIZE: 1, MONITOR_ONLY: 2,
  EXECUTE_IF: 3, WAIT: 4, SOFT_BLOCK: 5, HARD_BLOCK: 6,
};

const ACTION_TO_VERDICT: Record<ExecutionRecommendedAction, CouncilVerdictLite | null> = {
  NONE: null,
  REDUCE_SIZE: "REDUCE_SIZE",
  DELAY: "WAIT",
  WAIT: "WAIT",
  SOFT_BLOCK: "SOFT_BLOCK",
  HARD_BLOCK: "HARD_BLOCK",
};

export interface VerdictWithExecutionRisk {
  verdict: CouncilVerdictLite;
  sizeMultiplier: number;
  delayMs: number;
  downgraded: boolean;
  reasons: string[];
}

export function applyExecutionRiskToVerdict(
  baseVerdict: CouncilVerdictLite,
  exec: ExecutionRiskScore,
  baseSizeMultiplier = 1,
): VerdictWithExecutionRisk {
  const reasons: string[] = [];
  const proposed = ACTION_TO_VERDICT[exec.recommendedAction];
  let verdict = baseVerdict;
  let downgraded = false;

  if (proposed && STRICTNESS[proposed] > STRICTNESS[baseVerdict]) {
    reasons.push(`execution risk downgraded ${baseVerdict} → ${proposed} (${exec.level}, score ${exec.score01.toFixed(2)})`);
    verdict = proposed;
    downgraded = true;
  } else {
    reasons.push(`execution risk did not downgrade verdict (base ${baseVerdict}, exec ${exec.recommendedAction})`);
  }

  // Size multiplier is the MIN of base and exec recommendation, EXCEPT when
  // we're in a no-trade verdict (or a conditional one), in which case size
  // is irrelevant until the condition is satisfied (0).
  const noTrade =
       verdict === "WAIT"
    || verdict === "EXECUTE_IF"
    || verdict === "SOFT_BLOCK"
    || verdict === "HARD_BLOCK";
  const sizeMultiplier = noTrade
    ? 0
    : Math.max(0, Math.min(1, Math.min(baseSizeMultiplier, exec.recommendedSizeMultiplier)));

  return {
    verdict, sizeMultiplier, delayMs: exec.recommendedDelayMs,
    downgraded, reasons: [...reasons, ...exec.reasons],
  };
}
