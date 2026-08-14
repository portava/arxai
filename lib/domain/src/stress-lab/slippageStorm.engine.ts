import {
  type ScenarioOutput, type SyntheticTick, mulberry32,
} from "./stressLab.types";

// ═══════════════════════════════════════════════════════════════════════════
// Slippage Storm — rapid spread oscillations and gappy mid-price moves
// designed to trigger worst-case slippage in fill engines. SIMULATION ONLY.
// ═══════════════════════════════════════════════════════════════════════════

export interface SlippageStormInput {
  initialPrice: number;
  baseSpreadPips: number;
  tickIntervalMs?: number;
  durationMs?: number;
  spreadOscillationPips?: number;   // default 8
  gapEveryNTicks?: number;          // default 25
  gapPipsRange?: [number, number];  // default [10, 30]
  seed?: number;
}

export function generateSlippageStorm(input: SlippageStormInput): ScenarioOutput {
  const reasons: string[] = [];
  const interval = input.tickIntervalMs ?? 100;
  const duration = input.durationMs ?? 90_000;
  const seed = input.seed ?? 3;
  const rng = mulberry32(seed);
  const osc = input.spreadOscillationPips ?? 8;
  const gapEvery = input.gapEveryNTicks ?? 25;
  const [gapMin, gapMax] = input.gapPipsRange ?? [10, 30];

  const ticks: SyntheticTick[] = [];
  const total = Math.floor(duration / interval);
  let mid = input.initialPrice;
  let peakSpreadPips = input.baseSpreadPips;

  for (let i = 0; i < total; i++) {
    const oscPhase = Math.sin(i / 4);     // ~0.6Hz at 100ms ticks
    const spread = Math.max(0.1, input.baseSpreadPips + osc * oscPhase + rng() * 2);
    if (spread > peakSpreadPips) peakSpreadPips = spread;
    if (i % gapEvery === 0 && i > 0) {
      const gap = (gapMin + (gapMax - gapMin) * rng()) / 10000 * input.initialPrice;
      mid += (rng() < 0.5 ? -gap : gap);
    } else {
      mid += (rng() - 0.5) * 0.00015 * input.initialPrice;
    }
    const halfSpread = spread / 10000 * mid;
    ticks.push({
      tsMs: i * interval, bid: mid - halfSpread, ask: mid + halfSpread,
      volume: 50 + rng() * 500, spreadPips: spread,
    });
  }
  const shock = (mid - input.initialPrice) / input.initialPrice;
  reasons.push(`slippage storm: osc ±${osc}p, gaps every ${gapEvery} ticks, peak spread ${peakSpreadPips.toFixed(1)}p`);
  return {
    kind: "SLIPPAGE_STORM", seed, durationMs: duration, ticks,
    expectedShockPctMove: shock, peakSpreadPips, isSimulationOnly: true, reasons,
  };
}
