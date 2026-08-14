// ── Profit Mission Phase 8 — Partial Profit Plan (pure, PLANNING-only) ──────────
//
// PLANNING / ADVISORY ONLY. Turns a trade's entry/stop/target into an ordered
// list of protective execution STEPS (TP1 partial + break-even, TP2 remainder
// or trail, runner trigger). The backend executes each step via the EXISTING
// instant-trade actions; this engine never places an order.
//
// HONESTY CONTRACT:
//   - Honest degradation: when the broker does NOT support partial closes the
//     plan degrades to a single full close at the target (it never pretends a
//     partial happened). The `degraded` flag + a warning say so explicitly.
//   - No exit level is invented from missing data — an absent target yields an
//     empty plan with an honest note.
//   - No guaranteed-profit vocabulary.
//
// PURE + DETERMINISTIC + IO-FREE.

export type PartialStepKind = "PARTIAL_CLOSE" | "MOVE_BREAKEVEN" | "TRAIL" | "CLOSE";

export interface PartialPlanInput {
  side: "BUY" | "SELL";
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Does the broker/symbol support reducing a position by a fraction? */
  brokerSupportsPartialClose: boolean;
  isScalp?: boolean;
  /** TP1 fraction of the move entry→target (default scalp 0.4 / swing 0.5). */
  tp1ProgressFraction?: number | null;
  /** TP1 close fraction of the position (clamped 0.25..0.5 per spec). */
  tp1CloseFraction?: number | null;
}

export interface PartialPlanStep {
  order: number;
  kind: PartialStepKind;
  /** Trigger price (where the step becomes due). */
  triggerPrice: number | null;
  /** For PARTIAL_CLOSE: fraction (0..1) of the remaining position to close. */
  closeFraction: number | null;
  /** For MOVE_BREAKEVEN / TRAIL: the new stop level. */
  newStop: number | null;
  label: string;
}

export interface PartialPlan {
  steps: PartialPlanStep[];
  /** True when partials were requested but the broker can't support them. */
  degraded: boolean;
  warnings: string[];
  reason: string;
}

function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}
function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Build an ordered partial-profit plan. When the broker can't do partials the
 * plan honestly degrades to a single full close at the target.
 */
export function buildPartialPlan(input: PartialPlanInput): PartialPlan {
  const warnings: string[] = [];

  if (!isNum(input.entryPrice) || !isNum(input.takeProfit) || !isNum(input.stopLoss)) {
    return {
      steps: [],
      degraded: false,
      warnings: ["Entry/stop/target not all known — no partial plan inferred."],
      reason: "Partial plan unavailable — price levels missing.",
    };
  }
  const entry = input.entryPrice;
  const target = input.takeProfit;
  const totalMove = Math.abs(target - entry);
  if (totalMove <= 0) {
    return {
      steps: [],
      degraded: false,
      warnings: ["Target equals entry — no partial plan inferred."],
      reason: "Partial plan unavailable — target equals entry.",
    };
  }

  const scalp = input.isScalp === true;

  // ── Degraded path: broker can't partial-close → single full close at target. ─
  if (!input.brokerSupportsPartialClose) {
    warnings.push(
      "Broker does not support partial closes — degrading to a single full close at the target.",
    );
    return {
      steps: [
        {
          order: 1,
          kind: "CLOSE",
          triggerPrice: round5(target),
          closeFraction: 1,
          newStop: null,
          label: "Full close at target (partials unsupported).",
        },
      ],
      degraded: true,
      warnings,
      reason: "Partials unsupported — supported plan only: full close at target.",
    };
  }

  const tp1Frac = clamp(
    isNum(input.tp1ProgressFraction) ? input.tp1ProgressFraction : scalp ? 0.4 : 0.5,
    0.1,
    0.95,
  );
  const tp1CloseFrac = clamp(
    isNum(input.tp1CloseFraction) ? input.tp1CloseFraction : scalp ? 0.5 : 0.33,
    0.25,
    0.5,
  );
  const dir = input.side === "BUY" ? 1 : -1;
  const tp1Price = entry + dir * totalMove * tp1Frac;

  const steps: PartialPlanStep[] = [
    {
      order: 1,
      kind: "PARTIAL_CLOSE",
      triggerPrice: round5(tp1Price),
      closeFraction: round5(tp1CloseFrac),
      newStop: null,
      label: `TP1: take ${Math.round(tp1CloseFrac * 100)}% at ${Math.round(
        tp1Frac * 100,
      )}% of the move.`,
    },
    {
      order: 2,
      kind: "MOVE_BREAKEVEN",
      triggerPrice: round5(tp1Price),
      closeFraction: null,
      newStop: round5(entry),
      label: "Move stop to break-even once TP1 is banked (protected runner).",
    },
    {
      order: 3,
      kind: scalp ? "CLOSE" : "TRAIL",
      triggerPrice: round5(target),
      closeFraction: scalp ? 1 : null,
      newStop: null,
      label: scalp
        ? "TP2: close the remainder at the target (scalp captures fast)."
        : "TP2: trail the remainder past the target to let the trend breathe.",
    },
  ];

  return {
    steps,
    degraded: false,
    warnings,
    reason: `Partial plan: TP1 ${Math.round(tp1CloseFrac * 100)}% + break-even, then ${
      scalp ? "close" : "trail"
    } the runner.`,
  };
}
