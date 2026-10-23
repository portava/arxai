// Shared trend regression helpers for long-horizon engines.
export interface TrendStats {
  slopePerDay: number;
  intercept: number;
  rSquared: number;
  direction: "IMPROVING" | "FLAT" | "DEGRADING" | "INSUFFICIENT";
}

export function linearTrend(
  points: { dayIndex: number; value: number }[],
  improvingIsHigher: boolean,
): TrendStats {
  if (points.length < 4) return { slopePerDay: 0, intercept: 0, rSquared: 0, direction: "INSUFFICIENT" };
  const n = points.length;
  const xs = points.map(p => p.dayIndex);
  const ys = points.map(p => p.value);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  // R²
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yhat = intercept + slope * xs[i];
    ssRes += (ys[i] - yhat) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  const meaningful = Math.abs(slope) >= 0.005 && r2 >= 0.20;
  let direction: TrendStats["direction"];
  if (!meaningful)                            direction = "FLAT";
  else if (improvingIsHigher ? slope > 0 : slope < 0) direction = "IMPROVING";
  else                                        direction = "DEGRADING";
  return { slopePerDay: round4(slope), intercept: round4(intercept), rSquared: round4(r2), direction };
}
function mean(xs: number[]) { return xs.reduce((a,b)=>a+b,0) / Math.max(1, xs.length); }
function round4(n: number) { return Math.round(n * 10000) / 10000; }
