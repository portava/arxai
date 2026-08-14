import {
  type OrderContext, type SpreadVerdict, clampNonNegative,
} from "./executionMicrostructure.types";

// ═══════════════════════════════════════════════════════════════════════════
// Spread Behavior — checks current spread vs the symbol's recent average.
// Blocks when spread is excessively widened (regime change, illiquidity,
// news), which historically destroys micro-structure trades. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface SpreadInput {
  order: OrderContext;
  maxAcceptableRatio?: number;   // default 2.5x avg
  hardBlockRatio?: number;       // default 4.0x avg
}

export function checkSpread(input: SpreadInput): SpreadVerdict {
  const r: string[] = []; const b: string[] = [];
  const o = input.order;
  const max = input.maxAcceptableRatio ?? 2.5;
  const hard = input.hardBlockRatio ?? 4.0;
  const avg = clampNonNegative(o.avgSpreadPips);
  const ratio = avg > 0 ? o.spreadPips / avg : (o.spreadPips > 0 ? Infinity : 1);
  r.push(`current ${o.spreadPips.toFixed(2)}p / avg ${avg.toFixed(2)}p → ratio ${Number.isFinite(ratio) ? ratio.toFixed(2) : "∞"}`);

  let acceptable = true;
  if (ratio > hard) {
    acceptable = false;
    b.push(`spread ratio ${ratio.toFixed(2)} > hard block ${hard}`);
  } else if (ratio > max) {
    acceptable = false;
    b.push(`spread ratio ${ratio.toFixed(2)} > max acceptable ${max}`);
  } else {
    r.push(`within tolerance ≤ ${max}x`);
  }
  return { acceptable, spreadRatio: Number.isFinite(ratio) ? ratio : 999, reasons: r, blockers: b };
}
