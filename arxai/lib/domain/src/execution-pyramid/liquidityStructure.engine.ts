import type { ExecutionPyramidContext, PyramidScoreReport } from "./executionPyramid.types";
import { PYRAMID_CATEGORY_WEIGHT } from "./executionPyramid.types";

// Rewards entries that:
//   • Trade WITH a recent break-of-structure
//   • Trade WITH (not into) a recent liquidity sweep
//   • Have an unmitigated FVG / order block in their favour
//   • Have meaningful structural levels nearby

export function scoreLiquidityStructure(ctx: ExecutionPyramidContext): PyramidScoreReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const s = ctx.structure;
  const dir = ctx.signal.direction;
  const entry = ctx.signal.entry;

  if (entry == null || dir == null) {
    blockers.push("Missing entry price or direction — cannot evaluate structure");
    return finalize(0, warnings, blockers, "No entry/direction available", 0);
  }

  let score = 0;
  const reasons: string[] = [];

  // 1. Break of structure (+3)
  if (s.recentBreakOfStructure) { score += 3; reasons.push("recent BoS"); }
  else warnings.push("No recent break-of-structure to confirm momentum");

  // 2. Liquidity sweep aligned with signal (+3)
  if (s.recentLiquiditySweep) {
    const sweptOpposite = (dir === "BUY"  && s.recentLiquiditySweep.side === "SELL_SIDE")
                       || (dir === "SELL" && s.recentLiquiditySweep.side === "BUY_SIDE");
    if (sweptOpposite && s.recentLiquiditySweep.ageBars <= 5) {
      score += 3; reasons.push(`opposite-side sweep ${s.recentLiquiditySweep.ageBars} bars ago`);
    } else if (sweptOpposite) {
      score += 1; warnings.push(`Sweep aligned but stale (${s.recentLiquiditySweep.ageBars} bars)`);
    } else {
      blockers.push(`Liquidity swept on the SAME side as signal — likely against the move`);
    }
  }

  // 3. FVG in favour (+2)
  if (s.fairValueGap && s.fairValueGap.side === dir) {
    score += 2; reasons.push("favourable FVG present");
  }

  // 4. Order block confluence (+2)
  if (s.orderBlock && s.orderBlock.side === dir && !s.orderBlock.tested) {
    score += 2; reasons.push("untested OB confluence");
  } else if (s.orderBlock && s.orderBlock.side === dir && s.orderBlock.tested) {
    score += 1; warnings.push("OB already tested");
  }

  // 5. Heading straight into opposing structure → blocker
  if (dir === "BUY" && s.nearestResistance != null) {
    const distance = s.nearestResistance - entry;
    if (distance > 0 && distance < (ctx.entry.atr * 0.5)) {
      blockers.push(`Resistance at ${s.nearestResistance.toFixed(5)} is <0.5 ATR above entry`);
    }
  }
  if (dir === "SELL" && s.nearestSupport != null) {
    const distance = entry - s.nearestSupport;
    if (distance > 0 && distance < (ctx.entry.atr * 0.5)) {
      blockers.push(`Support at ${s.nearestSupport.toFixed(5)} is <0.5 ATR below entry`);
    }
  }

  return finalize(
    Math.max(0, Math.min(10, score)),
    warnings, blockers,
    `Structure score ${score}/10 — ${reasons.join(", ") || "no positive structure features"}`,
    0,
  );
}

function finalize(
  score: number, warnings: string[], blockers: string[], explanation: string, _drop: number,
): PyramidScoreReport {
  return {
    category: "liquidityStructure",
    score, warnings, blockers, explanation,
    confidenceContribution: score * (PYRAMID_CATEGORY_WEIGHT / 10),
  };
}
