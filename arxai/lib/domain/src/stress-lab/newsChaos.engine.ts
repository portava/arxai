import {
  type ScenarioOutput, type SyntheticTick, mulberry32,
} from "./stressLab.types";

// ═══════════════════════════════════════════════════════════════════════════
// News Chaos — a major news release: instant gap, two-way violent
// whipsaw for ~30s, then settle to a new level. SIMULATION ONLY.
// ═══════════════════════════════════════════════════════════════════════════

export interface NewsChaosInput {
  initialPrice: number;
  baseSpreadPips: number;
  tickIntervalMs?: number;
  durationMs?: number;
  initialGapPct?: number;       // default 0.015 (1.5%)
  whipsawAmplitudePct?: number; // default 0.012
  whipsawDurationMs?: number;   // default 30_000
  finalDriftPct?: number;       // default 0.008
  seed?: number;
}

export function generateNewsChaos(input: NewsChaosInput): ScenarioOutput {
  const reasons: string[] = [];
  const interval = input.tickIntervalMs ?? 100;
  const duration = input.durationMs ?? 90_000;
  const seed = input.seed ?? 4;
  const rng = mulberry32(seed);
  const gap = input.initialGapPct ?? 0.015;
  const amp = input.whipsawAmplitudePct ?? 0.012;
  const whipDur = input.whipsawDurationMs ?? 30_000;
  const drift = input.finalDriftPct ?? 0.008;
  const direction = rng() < 0.5 ? -1 : 1;

  const ticks: SyntheticTick[] = [];
  const total = Math.floor(duration / interval);
  const whipEndIdx = Math.floor(whipDur / interval);
  let peakSpreadPips = input.baseSpreadPips;
  const gapPrice = input.initialPrice * (1 + direction * gap);
  const finalPrice = input.initialPrice * (1 + direction * drift);

  for (let i = 0; i < total; i++) {
    let mid: number;
    let spread = input.baseSpreadPips;
    if (i === 0) {
      mid = gapPrice; spread = input.baseSpreadPips * 6;
    } else if (i <= whipEndIdx) {
      const t = i / whipEndIdx;
      const oscillation = Math.sin(i / 1.5) * amp * input.initialPrice * (1 - 0.6 * t);
      mid = gapPrice + oscillation;
      spread = input.baseSpreadPips * (1 + 5 * (1 - t)) + rng() * 2;
    } else {
      const t = (i - whipEndIdx) / Math.max(1, total - whipEndIdx);
      mid = gapPrice + (finalPrice - gapPrice) * t + (rng() - 0.5) * 0.0003 * input.initialPrice;
      spread = input.baseSpreadPips * (1 + 0.5 * (1 - t));
    }
    if (spread > peakSpreadPips) peakSpreadPips = spread;
    const halfSpread = spread / 10000 * mid;
    ticks.push({
      tsMs: i * interval, bid: mid - halfSpread, ask: mid + halfSpread,
      volume: 200 + rng() * 2000, spreadPips: spread,
    });
  }
  reasons.push(`news chaos: ${direction > 0 ? "+" : "-"}${(gap * 100).toFixed(2)}% gap, whipsaw ${(whipDur / 1000).toFixed(0)}s, settle ${direction > 0 ? "+" : "-"}${(drift * 100).toFixed(2)}%`);
  return {
    kind: "NEWS_CHAOS", seed, durationMs: duration, ticks,
    expectedShockPctMove: direction * gap, peakSpreadPips, isSimulationOnly: true, reasons,
  };
}
