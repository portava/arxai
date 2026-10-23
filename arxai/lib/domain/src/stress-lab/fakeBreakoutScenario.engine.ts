import {
  type ScenarioOutput, type SyntheticTick, mulberry32,
} from "./stressLab.types";

// ═══════════════════════════════════════════════════════════════════════════
// Fake Breakout — price punches through a level, traps breakout traders,
// then sharply reverses. SIMULATION ONLY.
// ═══════════════════════════════════════════════════════════════════════════

export interface FakeBreakoutInput {
  initialPrice: number;
  baseSpreadPips: number;
  tickIntervalMs?: number;
  durationMs?: number;
  breakoutPct?: number;        // default 0.005 (0.5%)
  reversalPct?: number;        // default 0.012 (reverses through original)
  seed?: number;
}

export function generateFakeBreakout(input: FakeBreakoutInput): ScenarioOutput {
  const reasons: string[] = [];
  const interval = input.tickIntervalMs ?? 100;
  const duration = input.durationMs ?? 60_000;
  const seed = input.seed ?? 5;
  const rng = mulberry32(seed);
  const breakout = input.breakoutPct ?? 0.005;
  const reversal = input.reversalPct ?? 0.012;
  const dir = rng() < 0.5 ? -1 : 1;

  const ticks: SyntheticTick[] = [];
  const total = Math.floor(duration / interval);
  const breakIdx = Math.floor(total * 0.30);
  const peakIdx = Math.floor(total * 0.40);
  const peakPrice = input.initialPrice * (1 + dir * breakout);
  const reversalEnd = input.initialPrice * (1 - dir * reversal);
  let peakSpreadPips = input.baseSpreadPips;

  for (let i = 0; i < total; i++) {
    let mid: number; let spread = input.baseSpreadPips * (1 + 0.3 * rng());
    if (i <= breakIdx) {
      const t = i / breakIdx;
      mid = input.initialPrice + (peakPrice - input.initialPrice) * t * 0.7
            + (rng() - 0.5) * 0.0003 * input.initialPrice;
    } else if (i <= peakIdx) {
      const t = (i - breakIdx) / Math.max(1, peakIdx - breakIdx);
      mid = peakPrice + (rng() - 0.5) * 0.0005 * input.initialPrice * (1 - t);
      spread = input.baseSpreadPips * (1 + 1.5 * (1 - t));
    } else {
      const t = (i - peakIdx) / Math.max(1, total - peakIdx);
      mid = peakPrice + (reversalEnd - peakPrice) * easeInOut(t)
            + (rng() - 0.5) * 0.0004 * input.initialPrice;
      spread = input.baseSpreadPips * (1 + 0.8 * (1 - t));
    }
    if (spread > peakSpreadPips) peakSpreadPips = spread;
    const halfSpread = spread / 10000 * mid;
    ticks.push({
      tsMs: i * interval, bid: mid - halfSpread, ask: mid + halfSpread,
      volume: 80 + rng() * 700, spreadPips: spread,
    });
  }
  reasons.push(`fake breakout: ${dir > 0 ? "+" : "-"}${(breakout * 100).toFixed(2)}% punch, then reverse ${(reversal * 100).toFixed(2)}%`);
  return {
    kind: "FAKE_BREAKOUT", seed, durationMs: duration, ticks,
    expectedShockPctMove: -dir * reversal, peakSpreadPips, isSimulationOnly: true, reasons,
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}
