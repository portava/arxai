import {
  type OrderContext, type FillProbability, clamp01,
} from "./executionMicrostructure.types";

// ═══════════════════════════════════════════════════════════════════════════
// Fill Probability — likelihood the order fills near intended price.
//   MARKET orders: high baseline (0.95) reduced by depth shortfall, news,
//                  extreme volatility.
//   LIMIT/STOP orders: based on distance from current price (proxied by
//                  spread) and time-decay assumption baked into volume.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export function predictFillProbability(o: OrderContext): FillProbability {
  const reasons: string[] = [];
  let p = o.type === "MARKET" ? 0.95 : 0.65;
  reasons.push(`baseline ${p.toFixed(2)} for ${o.type}`);

  // Depth shortfall reduces fill probability.
  if (o.topBookDepthLots > 0) {
    const ratio = o.intendedSizeLots / o.topBookDepthLots;
    if (ratio > 1) {
      const drop = Math.min(0.5, 0.15 * (ratio - 1));
      p -= drop;
      reasons.push(`size ${o.intendedSizeLots} > depth ${o.topBookDepthLots} (${ratio.toFixed(2)}x) → −${drop.toFixed(2)}`);
    }
  } else {
    p -= 0.20;
    reasons.push(`unknown depth → −0.20`);
  }

  // Volume below norm hurts limit fills.
  if (o.recentVolumeZ < -1 && o.type !== "MARKET") {
    p -= 0.15;
    reasons.push(`volume z ${o.recentVolumeZ.toFixed(2)} < -1 → −0.15`);
  }

  // News window reduces fill quality.
  if (o.newsActiveWindow) { p -= 0.10; reasons.push(`news active → −0.10`); }

  // Extreme volatility reduces fill quality even for market orders.
  if (o.recentVolatilityZ > 2) { p -= 0.15; reasons.push(`vol z ${o.recentVolatilityZ.toFixed(2)} > 2 → −0.15`); }

  const probability01 = clamp01(p);
  reasons.push(`final probability ${probability01.toFixed(2)}`);
  return { probability01, reasons };
}
