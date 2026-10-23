import type { Candle } from "./marketRegime.engine";

export interface LiquidityZone {
  kind: "SUPPLY" | "DEMAND" | "EQUAL_HIGH" | "EQUAL_LOW";
  price: number;
  strength: number;     // 0..100
  touches: number;
  formedAtIndex: number;
}

export interface LiquidityReport {
  nearestSupply: LiquidityZone | null;
  nearestDemand: LiquidityZone | null;
  zones: LiquidityZone[];
}

// Fast swing-point + equal-high/low detector. Not a full SMC engine, but
// gives an honest baseline for "where is liquidity sitting?" answers.
export function detectLiquidityZones(candles: Candle[], opts: { swing?: number; eqTolerancePct?: number } = {}): LiquidityReport {
  const swing = opts.swing ?? 3;
  const eqTolerancePct = opts.eqTolerancePct ?? 0.0003; // 3 bps
  const zones: LiquidityZone[] = [];

  for (let i = swing; i < candles.length - swing; i++) {
    const c = candles[i];
    const isSwingHigh = candles.slice(i - swing, i).every((p) => p.high < c.high)
                     && candles.slice(i + 1, i + 1 + swing).every((p) => p.high < c.high);
    const isSwingLow  = candles.slice(i - swing, i).every((p) => p.low > c.low)
                     && candles.slice(i + 1, i + 1 + swing).every((p) => p.low > c.low);
    if (isSwingHigh) zones.push({ kind: "SUPPLY", price: c.high, strength: 60, touches: 1, formedAtIndex: i });
    if (isSwingLow)  zones.push({ kind: "DEMAND", price: c.low,  strength: 60, touches: 1, formedAtIndex: i });
  }

  // Merge equal highs / equal lows into stronger composite zones.
  const merged: LiquidityZone[] = [];
  for (const z of zones) {
    const existing = merged.find((m) => m.kind === z.kind && Math.abs(m.price - z.price) / z.price < eqTolerancePct);
    if (existing) {
      existing.touches += 1;
      existing.strength = Math.min(100, existing.strength + 15);
      existing.kind = z.kind === "SUPPLY" ? "EQUAL_HIGH" : "EQUAL_LOW";
    } else merged.push({ ...z });
  }

  const last = candles.length ? candles[candles.length - 1].close : 0;
  const supplies = merged.filter((m) => m.price > last && (m.kind === "SUPPLY" || m.kind === "EQUAL_HIGH"));
  const demands  = merged.filter((m) => m.price < last && (m.kind === "DEMAND" || m.kind === "EQUAL_LOW"));
  supplies.sort((a, b) => a.price - b.price);
  demands.sort((a, b) => b.price - a.price);

  return { nearestSupply: supplies[0] ?? null, nearestDemand: demands[0] ?? null, zones: merged };
}
