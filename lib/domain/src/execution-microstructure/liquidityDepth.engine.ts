import {
  type OrderContext, type LiquidityVerdict, clampNonNegative,
} from "./executionMicrostructure.types";

// ═══════════════════════════════════════════════════════════════════════════
// Liquidity Depth — verify that top-book depth (or a configurable multiple)
// can absorb the intended size without excessive book-walking. Reports
// shortfall lots and blocks when fillable < minAbsorption.
//
// Pure. depthMultiplier defaults to 1.5 (require 1.5× the size in book).
// ═══════════════════════════════════════════════════════════════════════════

export interface LiquidityInput {
  order: OrderContext;
  depthMultiplier?: number;    // default 1.5
}

export function checkLiquidityDepth(input: LiquidityInput): LiquidityVerdict {
  const r: string[] = []; const b: string[] = [];
  const o = input.order;
  const mult = input.depthMultiplier ?? 1.5;
  const required = o.intendedSizeLots * mult;
  const fillableLots = clampNonNegative(o.topBookDepthLots);
  const shortfallLots = clampNonNegative(required - fillableLots);
  r.push(`required ${required.toFixed(2)}lots (${mult}× size) · fillable ${fillableLots.toFixed(2)} · shortfall ${shortfallLots.toFixed(2)}`);

  let sufficient = shortfallLots === 0;
  if (!sufficient && shortfallLots > o.intendedSizeLots * 0.5) {
    b.push(`liquidity shortfall ${shortfallLots.toFixed(2)} > 50% of intended size`);
  }
  if (fillableLots === 0) {
    sufficient = false;
    b.push(`top-book depth is zero — no liquidity`);
  }
  return { sufficient, fillableLots, shortfallLots, reasons: r, blockers: b };
}
