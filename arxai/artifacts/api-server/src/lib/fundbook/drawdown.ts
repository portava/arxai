// ARX Fund Book — high-water / drawdown math (Task #131), pure / no DB.
//
// SAFETY / HONESTY (inviolable):
// - A high-water mark advances ONLY on a genuine new net-value high. It never
//   ratchets down; a dip leaves the mark where it was so the drawdown reflects
//   the true peak-to-current decline.
// - Drawdown = (highWater − current) / highWater, floored at 0 (no negative
//   drawdown when above the prior peak). Percent is 0 when there is no positive
//   high-water reference yet.
// - These are read-only helpers — no mutation, no execution-path contact.

import { round2 } from "./navMath.js";

/** Advance a high-water mark on a new high; otherwise keep the prior peak. */
export function advanceHighWater(prevHighWater: number, currentValue: number): number {
  const prev = Number.isFinite(prevHighWater) ? prevHighWater : 0;
  const cur = Number.isFinite(currentValue) ? currentValue : prev;
  return cur > prev ? cur : prev;
}

export interface Drawdown {
  drawdownUsd: number;
  drawdownPercent: number;
}

/**
 * Drawdown in dollars and percent from a peak (high-water) to a current value.
 * Floored at 0 — being at or above the peak is a 0 drawdown, never negative.
 */
export function computeDrawdown(currentValue: number, highWaterValue: number): Drawdown {
  const cur = Number.isFinite(currentValue) ? currentValue : 0;
  const hwm = Number.isFinite(highWaterValue) ? highWaterValue : 0;
  const usd = Math.max(0, hwm - cur);
  const percent = hwm > 0 ? (usd / hwm) * 100 : 0;
  return { drawdownUsd: round2(usd), drawdownPercent: round2(percent) };
}
