// ── Profit Mission Phase 7 — Capital Efficiency Score (pure, DOWNGRADE-only) ──
//
// PLANNING / ADVISORY ONLY. Scores how efficiently a setup uses capital
// (return-per-risk, return-per-margin, return-per-hour) so the mission prefers
// better risk-adjusted setups and avoids tying up capital in slow, low-quality
// trades on short missions. This is DOWNGRADE/RANKING ONLY — it never blocks a
// trade by itself and never upgrades a setup over a safety gate.
//
// HONESTY CONTRACT:
//   - Unknown inputs are excluded from the blend (never fabricated). A score with
//     no usable component returns `efficient: false` + an "unknown" note rather
//     than a fabricated high score.
//   - No guaranteed-profit vocabulary — this is an estimate.
//
// PURE + DETERMINISTIC + IO-FREE.

export interface CapitalEfficiencyInput {
  /** Expected reward-to-risk multiple (e.g. 2.5). */
  expectedR?: number | null;
  /** Account-currency amount risked. */
  riskAmount?: number | null;
  /** Account-currency estimated profit at target. */
  estimatedProfit?: number | null;
  /** Margin tied up by the position, account currency. */
  marginRequired?: number | null;
  /** Expected hold time in hours. */
  expectedHoldHours?: number | null;
  /** Hours left in the mission (short missions punish slow trades harder). */
  missionHoursRemaining?: number | null;
}

export interface CapitalEfficiencyScore {
  /** Advisory 0..100 efficiency score. */
  score: number;
  /** Profit per unit risk (expectedR or estimatedProfit/riskAmount). */
  returnPerRisk: number | null;
  /** Profit per unit margin. */
  returnPerMargin: number | null;
  /** Profit per hour of capital lock-up, account currency. */
  returnPerHour: number | null;
  /** True when the setup clears the advisory efficiency floor. */
  efficient: boolean;
  warnings: string[];
  reason: string;
}

const EFFICIENCY_FLOOR = 45; // below this the setup is flagged inefficient (advisory)

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

/**
 * Compute an advisory capital-efficiency score. Pure, downgrade/ranking-only.
 */
export function computeCapitalEfficiency(input: CapitalEfficiencyInput): CapitalEfficiencyScore {
  const warnings: string[] = [];

  // ── return per risk ────────────────────────────────────────────────────────
  let returnPerRisk: number | null = null;
  if (isNum(input.expectedR) && input.expectedR > 0) {
    returnPerRisk = round2(input.expectedR);
  } else if (isNum(input.estimatedProfit) && isNum(input.riskAmount) && input.riskAmount > 0) {
    returnPerRisk = round2(input.estimatedProfit / input.riskAmount);
  }

  // ── return per margin ───────────────────────────────────────────────────────
  let returnPerMargin: number | null = null;
  if (isNum(input.estimatedProfit) && isNum(input.marginRequired) && input.marginRequired > 0) {
    returnPerMargin = round2(input.estimatedProfit / input.marginRequired);
  }

  // ── return per hour ─────────────────────────────────────────────────────────
  let returnPerHour: number | null = null;
  if (isNum(input.estimatedProfit) && isNum(input.expectedHoldHours) && input.expectedHoldHours > 0) {
    returnPerHour = round2(input.estimatedProfit / input.expectedHoldHours);
  }

  // ── Blend present components onto 0..100 sub-scores. ───────────────────────
  // returnPerRisk: R of 3+ → 100, R of 1 → ~33.
  // returnPerMargin: 0.10 (10% of margin) → 100.
  // returnPerHour is normalized against risk so it's scale-free: profit-per-hour
  // relative to risk; 0.5×risk/hour → 100.
  const parts: { weight: number; value: number }[] = [];
  if (returnPerRisk != null) parts.push({ weight: 0.5, value: clamp((returnPerRisk / 3) * 100, 0, 100) });
  if (returnPerMargin != null) parts.push({ weight: 0.3, value: clamp((returnPerMargin / 0.1) * 100, 0, 100) });
  if (returnPerHour != null && isNum(input.riskAmount) && input.riskAmount > 0) {
    parts.push({ weight: 0.2, value: clamp((returnPerHour / (input.riskAmount * 0.5)) * 100, 0, 100) });
  }

  let score = 0;
  if (parts.length > 0) {
    const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
    score = parts.reduce((s, p) => s + (p.weight / totalWeight) * p.value, 0);
  } else {
    warnings.push("No usable efficiency inputs — efficiency unknown.");
  }

  // ── Short-mission penalty: a slow trade that won't resolve in time ties up
  //    capital for little gain. Downgrade (never block).
  if (
    isNum(input.expectedHoldHours) &&
    isNum(input.missionHoursRemaining) &&
    input.missionHoursRemaining > 0 &&
    input.expectedHoldHours > input.missionHoursRemaining
  ) {
    score = Math.min(score, EFFICIENCY_FLOOR - 1);
    warnings.push(
      `Expected hold (${input.expectedHoldHours}h) exceeds the ${input.missionHoursRemaining}h left — ties up capital past the mission window.`,
    );
  }

  score = round2(clamp(score, 0, 100));
  const efficient = parts.length > 0 && score >= EFFICIENCY_FLOOR;
  return {
    score,
    returnPerRisk,
    returnPerMargin,
    returnPerHour,
    efficient,
    warnings,
    reason:
      parts.length === 0
        ? "Capital efficiency unknown — inputs missing."
        : efficient
          ? `Capital efficiency ${score}/100 (per-risk ${returnPerRisk ?? "?"}).`
          : `Capital efficiency ${score}/100 — below the ${EFFICIENCY_FLOOR} advisory floor.`,
  };
}

/** Rank candidates by capital efficiency, most efficient first. Stable. */
export function rankByCapitalEfficiency<T>(
  items: readonly T[],
  toInput: (item: T) => CapitalEfficiencyInput,
): { item: T; efficiency: CapitalEfficiencyScore }[] {
  return items
    .map((item, index) => ({ item, index, efficiency: computeCapitalEfficiency(toInput(item)) }))
    .sort((a, b) => (b.efficiency.score - a.efficiency.score) || (a.index - b.index))
    .map(({ item, efficiency }) => ({ item, efficiency }));
}
