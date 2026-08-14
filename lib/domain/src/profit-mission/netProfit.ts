// ── Profit Mission Phase 7 — Net-Profit-After-Costs Filter (pure, BLOCK-only) ─
//
// PLANNING / PRE-EXECUTION PRE-CHECK ONLY. Rejects trades whose target profit is
// too small versus estimated cost (spread + slippage + commission + swap). It can
// ONLY block/downgrade — never upgrade a setup or relax a gate.
//
// HONESTY CONTRACT:
//   - The target profit MUST be positively known. If it is unknown, the verdict
//     fails CLOSED (blocked, "cannot confirm net profit") — never a silent pass.
//   - Costs are summed only from the components actually supplied; an unknown
//     component is excluded (never fabricated) but is surfaced as an unverified
//     cost so the result never reads as cheaper than reality can confirm.
//   - Scalps are held to a stricter net-profit-to-cost floor.
//   - No guaranteed-profit vocabulary — this is an estimate, surfaced as such.
//
// PURE + DETERMINISTIC + IO-FREE.

export type NetProfitAssetClass =
  | "forex_major"
  | "forex_minor"
  | "forex_exotic"
  | "metal"
  | "index"
  | "crypto"
  | "synthetic"
  | "unknown";

export interface NetProfitInput {
  isScalp: boolean;
  assetClass: NetProfitAssetClass;
  /** Gross expected profit at the take-profit, account currency (null = unknown). */
  targetProfit?: number | null;
  /** Amount risked, account currency (null = unknown). */
  riskAmount?: number | null;
  /** Estimated cost components, account currency (null/omitted = unverified). */
  spreadCost?: number | null;
  estimatedSlippageCost?: number | null;
  commission?: number | null;
  swap?: number | null;
  /** True when the trade is expected to be held over a rollover (swap applies). */
  holdsOvernight?: boolean;
  /** Override the minimum net-profit-to-cost ratio (default depends on scalp). */
  minNetProfitToCostRatio?: number;
}

export interface NetProfitVerdict {
  allowed: boolean;
  /** Sum of the SUPPLIED cost components, account currency. */
  estimatedTotalCost: number;
  /** targetProfit − estimatedTotalCost (null when target unknown). */
  netProfitEstimate: number | null;
  /** netProfitEstimate / estimatedTotalCost (null when not computable). */
  netProfitToCostRatio: number | null;
  /** True when one or more cost components were not supplied. */
  costPartiallyUnverified: boolean;
  blockers: string[];
  warnings: string[];
  reason: string;
}

// Net-profit must be at least this multiple of estimated cost to be worth taking.
const MIN_RATIO = { scalp: 2, swing: 1 } as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

/**
 * Compute an honest net-profit-after-costs verdict. Pure, block-only.
 */
export function computeNetProfitVerdict(input: NetProfitInput): NetProfitVerdict {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // ── Sum the cost components that were actually supplied. ───────────────────
  let cost = 0;
  let costPartiallyUnverified = false;
  const addCost = (v: number | null | undefined, label: string) => {
    if (isNum(v) && v >= 0) cost += v;
    else {
      costPartiallyUnverified = true;
      warnings.push(`${label} cost is unverified — true net profit may be lower.`);
    }
  };
  addCost(input.spreadCost, "Spread");
  addCost(input.estimatedSlippageCost, "Slippage");
  addCost(input.commission, "Commission");
  // Swap only matters (and is only required) when the trade is held overnight.
  if (input.holdsOvernight) {
    addCost(input.swap, "Overnight swap");
  } else if (isNum(input.swap) && input.swap > 0) {
    cost += input.swap;
  }
  // Gold / indices are slippage-sensitive: an unverified slippage cost is a hard
  // gap there, not just a soft warning.
  if (
    (input.assetClass === "metal" || input.assetClass === "index") &&
    !isNum(input.estimatedSlippageCost)
  ) {
    warnings.push(`${input.assetClass} slippage is unverified — treat the net-profit estimate as optimistic.`);
  }
  cost = round2(cost);

  // ── Target profit must be positively known (fail-closed otherwise). ────────
  if (!isNum(input.targetProfit) || input.targetProfit! <= 0) {
    blockers.push("NET_PROFIT_UNVERIFIED");
    warnings.push("Target profit is unknown — cannot confirm the trade clears its costs.");
    return {
      allowed: false,
      estimatedTotalCost: cost,
      netProfitEstimate: null,
      netProfitToCostRatio: null,
      costPartiallyUnverified,
      blockers,
      warnings,
      reason: "Net-profit blocked: target profit is unverified.",
    };
  }

  const target = input.targetProfit!;
  const netProfitEstimate = round2(target - cost);
  const minRatio = isNum(input.minNetProfitToCostRatio)
    ? input.minNetProfitToCostRatio!
    : input.isScalp
      ? MIN_RATIO.scalp
      : MIN_RATIO.swing;

  if (cost <= 0) {
    // No positive cost was supplied at all — we cannot certify the trade clears
    // costs, so we withhold a pass rather than fabricate a zero-cost trade.
    blockers.push("COST_UNVERIFIED");
    warnings.push("No cost estimate was available — cannot certify net profit; refusing.");
    return {
      allowed: false,
      estimatedTotalCost: cost,
      netProfitEstimate,
      netProfitToCostRatio: null,
      costPartiallyUnverified: true,
      blockers,
      warnings,
      reason: "Net-profit blocked: costs are unverified.",
    };
  }

  const ratio = round2(netProfitEstimate / cost);
  if (netProfitEstimate <= 0) {
    blockers.push("COST_EXCEEDS_TARGET");
    warnings.push("Estimated costs meet or exceed the target profit — net loss expected.");
  } else if (ratio < minRatio) {
    blockers.push("NET_PROFIT_TOO_LOW");
    warnings.push(
      `Net-profit-to-cost ratio ${ratio} is below the ${minRatio}× floor${input.isScalp ? " for a scalp" : ""}.`,
    );
  }

  const allowed = blockers.length === 0;
  return {
    allowed,
    estimatedTotalCost: cost,
    netProfitEstimate,
    netProfitToCostRatio: ratio,
    costPartiallyUnverified,
    blockers,
    warnings,
    reason: allowed
      ? `Net profit ≈ ${netProfitEstimate} after ≈ ${cost} cost (${ratio}× floor ${minRatio}×).`
      : `Net-profit blocked: ${blockers.join(", ")}.`,
  };
}
