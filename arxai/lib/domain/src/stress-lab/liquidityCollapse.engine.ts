import {
  type ScenarioOutput, type SyntheticTick, mulberry32,
} from "./stressLab.types";

// ═══════════════════════════════════════════════════════════════════════════
// Liquidity Collapse — volume drops to near-zero while spread balloons.
// Price drifts unpredictably with sparse ticks. SIMULATION ONLY.
// ═══════════════════════════════════════════════════════════════════════════

export interface LiquidityCollapseInput {
  initialPrice: number;
  baseSpreadPips: number;
  tickIntervalMs?: number;
  durationMs?: number;
  spreadMultiplier?: number;       // default 12x
  volumeFloor?: number;            // default 5
  seed?: number;
}

export function generateLiquidityCollapse(input: LiquidityCollapseInput): ScenarioOutput {
  const reasons: string[] = [];
  const interval = input.tickIntervalMs ?? 250;
  const duration = input.durationMs ?? 120_000;
  const seed = input.seed ?? 2;
  const rng = mulberry32(seed);
  const peakMul = input.spreadMultiplier ?? 12;
  const volFloor = input.volumeFloor ?? 5;

  const ticks: SyntheticTick[] = [];
  const total = Math.floor(duration / interval);
  let mid = input.initialPrice;
  let peakSpreadPips = input.baseSpreadPips;
  let minPrice = input.initialPrice; let maxPrice = input.initialPrice;

  for (let i = 0; i < total; i++) {
    const t = i / total;
    const collapseCurve = Math.sin(Math.PI * t);    // peaks mid-window
    const spread = input.baseSpreadPips * (1 + (peakMul - 1) * collapseCurve) + rng();
    if (spread > peakSpreadPips) peakSpreadPips = spread;
    // Sparse-tick drift: random walk weighted by current illiquidity.
    mid += (rng() - 0.5) * 0.0008 * input.initialPrice * (1 + 4 * collapseCurve);
    if (mid < minPrice) minPrice = mid;
    if (mid > maxPrice) maxPrice = mid;
    const halfSpread = spread / 10000 * mid;
    ticks.push({
      tsMs: i * interval, bid: mid - halfSpread, ask: mid + halfSpread,
      volume: volFloor + rng() * 20 * (1 - collapseCurve), spreadPips: spread,
    });
  }
  const shock = (mid - input.initialPrice) / input.initialPrice;
  reasons.push(`liquidity collapse: peak spread ${peakSpreadPips.toFixed(1)}p (${peakMul}x), price drift ${(shock * 100).toFixed(2)}%`);
  return {
    kind: "LIQUIDITY_COLLAPSE", seed, durationMs: duration, ticks,
    expectedShockPctMove: shock, peakSpreadPips, isSimulationOnly: true, reasons,
  };
}
