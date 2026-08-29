// ── #5 Pre-trade counterfactual hook — ADVISORY bounds at draft creation ─────
//
// WHY THIS EXISTS: the replay lab's counterfactual machinery (whatIfEngine,
// alternatePath AS_IS/HALF_SIZE/BLOCKED fan, do-nothing scorecard) is
// retrospective — it replays recorded candles AFTER the fact. Nothing compared
// a PROPOSED trade against wait / half-size / no-trade at decision time. This
// module is that missing pre-trade slice, deliberately bounded to what is
// HONESTLY knowable before the trade: the draft's own risk plan.
//
// HONESTY CONTRACT (inviolable):
//   * ZERO AUTHORITY. The output is display/journal evidence only. It contains
//     no action, approval, verdict-that-gates, or size directive; no caller
//     may branch an execution decision on it (pinned by the qa test).
//   * NO PREDICTION. Pre-trade, future prices are unknowable, so the AS_IS /
//     HALF_SIZE / NO_TRADE scenarios report only the DETERMINISTIC bounds the
//     draft's own stop/target imply (max loss at stop, max gain at target).
//     The WAIT scenario is an honest UNKNOWN with the evidence that would
//     settle it (the replay lab's post-hoc counterfactual on recorded bars —
//     the same scenario vocabulary as lib/domain/src/replay-lab).
//   * Missing inputs degrade to an honest null-with-reason record, never a
//     synthesized bound.
//
// Pure — no IO, no clock, no randomness.

/** Scenario vocabulary mirrors the replay lab's bounded fan (alternatePath:
 *  AS_IS / HALF_SIZE / BLOCKED) plus the do-nothing lab's wait question. */
export type DraftCounterfactualScenario =
  | {
      kind: "AS_IS" | "HALF_SIZE";
      maxLossUsd: number;        // bounded loss if the stop is hit (≥ 0)
      maxGainUsd: number | null; // bounded gain if the target is hit; null when no TP
      reasons: string[];
    }
  | { kind: "NO_TRADE"; maxLossUsd: 0; maxGainUsd: 0; reasons: string[] }
  | { kind: "WAIT"; verdict: "UNKNOWN"; reasons: string[] };

export interface DraftCounterfactual {
  kind: "PRE_TRADE_BOUNDED_COUNTERFACTUAL";
  advisory: true;
  authority: "NONE";
  computable: boolean;
  scenarios: DraftCounterfactualScenario[];
  reasons: string[];
}

export interface DraftCounterfactualInput {
  direction: string;             // BUY | SELL | other (other → not computable)
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskAmount: number | null;     // USD risked at the stop, from the sizing engine
  expectedR: number | null;
}

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the counterfactual hook enabled? Absent env = ENABLED. */
export function draftCounterfactualEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

function finitePositive(n: number | null): n is number {
  return n !== null && Number.isFinite(n) && n > 0;
}

/**
 * PURE — build the bounded advisory comparison. Never throws; never invents a
 * bound it cannot derive from the draft's own plan.
 */
export function buildDraftCounterfactual(input: DraftCounterfactualInput): DraftCounterfactual {
  const reasons: string[] = [];

  const directional = input.direction === "BUY" || input.direction === "SELL";
  const hasRisk = finitePositive(input.riskAmount);
  const hasStop =
    finitePositive(input.entryPrice) &&
    input.stopLoss !== null && Number.isFinite(input.stopLoss) &&
    input.stopLoss !== input.entryPrice;

  if (!directional || !hasRisk || !hasStop) {
    if (!directional) reasons.push("no directional setup — nothing to compare");
    if (!hasRisk) reasons.push("no sized risk amount — bounds cannot be derived");
    if (!hasStop) reasons.push("no usable entry/stop pair — the 1R bound is undefined");
    return {
      kind: "PRE_TRADE_BOUNDED_COUNTERFACTUAL",
      advisory: true,
      authority: "NONE",
      computable: false,
      scenarios: [],
      reasons,
    };
  }

  const riskUsd = input.riskAmount as number;

  // Gain bound only when a take-profit exists on the correct side; the R
  // multiple to target is derived from the SAME price distances the plan
  // carries — never a fabricated reward.
  let gainUsd: number | null = null;
  let rToTarget: number | null = null;
  if (
    finitePositive(input.entryPrice) &&
    input.takeProfit !== null && Number.isFinite(input.takeProfit)
  ) {
    const entry = input.entryPrice as number;
    const stopDist = Math.abs(entry - (input.stopLoss as number));
    const tpDist =
      input.direction === "BUY" ? (input.takeProfit as number) - entry : entry - (input.takeProfit as number);
    if (stopDist > 0 && tpDist > 0) {
      rToTarget = tpDist / stopDist;
      gainUsd = riskUsd * rToTarget;
    } else {
      reasons.push("take-profit is not on the profitable side of entry — no gain bound");
    }
  } else {
    reasons.push("no take-profit on the plan — gain bound unknown (loss bound still holds)");
  }

  const rText = rToTarget !== null ? ` / +$${gainUsd!.toFixed(2)} at target (${rToTarget.toFixed(2)}R)` : "";
  const scenarios: DraftCounterfactualScenario[] = [
    {
      kind: "AS_IS",
      maxLossUsd: riskUsd,
      maxGainUsd: gainUsd,
      reasons: [`bounded by the plan's own stop/target: −$${riskUsd.toFixed(2)} at stop${rText}`],
    },
    {
      kind: "HALF_SIZE",
      maxLossUsd: riskUsd / 2,
      maxGainUsd: gainUsd !== null ? gainUsd / 2 : null,
      reasons: [`half the size halves both bounds: −$${(riskUsd / 2).toFixed(2)} at stop — the replay lab's HALF_SIZE fan, pre-trade`],
    },
    {
      kind: "NO_TRADE",
      maxLossUsd: 0,
      maxGainUsd: 0,
      reasons: ["doing nothing risks and captures nothing; the do-nothing lab grades this retrospectively"],
    },
    {
      kind: "WAIT",
      verdict: "UNKNOWN",
      reasons: [
        "whether waiting improves entry is unknowable pre-trade — no future price is invented",
        "settled after the fact by the replay lab (ENTER_LATER counterfactual on recorded bars)",
      ],
    },
  ];
  reasons.push("advisory bounds only — this record carries zero authority and gates nothing");

  return {
    kind: "PRE_TRADE_BOUNDED_COUNTERFACTUAL",
    advisory: true,
    authority: "NONE",
    computable: true,
    scenarios,
    reasons,
  };
}
