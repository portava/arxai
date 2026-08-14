import {
  type ScenarioOutput, type SyntheticTick, mulberry32,
} from "./stressLab.types";

// ═══════════════════════════════════════════════════════════════════════════
// Flash Crash — sharp -X% drop in <30s, partial recovery, wide spreads
// during the event. Deterministic. SIMULATION ONLY.
// ═══════════════════════════════════════════════════════════════════════════

export interface FlashCrashInput {
  initialPrice: number;
  baseSpreadPips: number;
  tickIntervalMs?: number;     // default 100ms
  crashPct?: number;           // default 0.07 (7%)
  recoveryPct?: number;        // default 0.50 (50% retrace)
  durationMs?: number;         // default 60_000
  seed?: number;
}

export function generateFlashCrash(input: FlashCrashInput): ScenarioOutput {
  const reasons: string[] = [];
  const interval = input.tickIntervalMs ?? 100;
  const duration = input.durationMs ?? 60_000;
  const crash = input.crashPct ?? 0.07;
  const recovery = input.recoveryPct ?? 0.50;
  const seed = input.seed ?? 1;
  const rng = mulberry32(seed);

  const ticks: SyntheticTick[] = [];
  const total = Math.floor(duration / interval);
  const crashEndIdx = Math.floor(total * 0.20);     // crash in first 20%
  const recoveryEndIdx = Math.floor(total * 0.60);
  const crashLow = input.initialPrice * (1 - crash);
  const recoveryTo = crashLow + (input.initialPrice - crashLow) * recovery;
  let peakSpreadPips = input.baseSpreadPips;

  for (let i = 0; i < total; i++) {
    let mid: number;
    let spread = input.baseSpreadPips;
    if (i <= crashEndIdx) {
      const t = i / Math.max(1, crashEndIdx);
      mid = input.initialPrice + (crashLow - input.initialPrice) * easeInQuad(t);
      spread = input.baseSpreadPips * (1 + 8 * t) + rng() * 2;
    } else if (i <= recoveryEndIdx) {
      const t = (i - crashEndIdx) / Math.max(1, recoveryEndIdx - crashEndIdx);
      mid = crashLow + (recoveryTo - crashLow) * easeOutQuad(t);
      spread = input.baseSpreadPips * (1 + 4 * (1 - t)) + rng();
    } else {
      mid = recoveryTo + (rng() - 0.5) * 0.0002 * recoveryTo;
      spread = input.baseSpreadPips * (1 + 0.5 * rng());
    }
    if (spread > peakSpreadPips) peakSpreadPips = spread;
    const halfSpread = spread / 10000 * mid;
    ticks.push({
      tsMs: i * interval, bid: mid - halfSpread, ask: mid + halfSpread,
      volume: 100 + rng() * 1000, spreadPips: spread,
    });
  }

  reasons.push(`flash crash: -${(crash * 100).toFixed(1)}% in ${(crashEndIdx * interval / 1000).toFixed(1)}s, ${(recovery * 100).toFixed(0)}% recovery; peak spread ${peakSpreadPips.toFixed(1)}p`);
  return {
    kind: "FLASH_CRASH", seed, durationMs: duration, ticks,
    expectedShockPctMove: -crash, peakSpreadPips, isSimulationOnly: true, reasons,
  };
}

function easeInQuad(t: number): number  { return t * t; }
function easeOutQuad(t: number): number { return 1 - (1 - t) ** 2; }
