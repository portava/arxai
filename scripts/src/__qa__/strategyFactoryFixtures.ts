// Shared deterministic fixtures for the strategy-factory test lanes
// (test:strategy-contract-compiler, test:strategy-behavioral-diff).
// Hand-built candles — no PRNG, no clock reads: every value is pinned so the
// suites assert exact frame indices and prices.

import type { Candle } from "@workspace/domain/market";
import {
  buildFrozenFrames,
  type FrozenReplayDataset,
} from "@workspace/domain/strategy-factory";

const HOUR = 3_600_000;
export const DAY1 = Date.UTC(2026, 0, 5); // Mon 2026-01-05 00:00 UTC
export const DAY2 = Date.UTC(2026, 0, 6); // Tue 2026-01-06 00:00 UTC

// ── London-breakout scenario ────────────────────────────────────────────────
// Day 1: 24 quiet hourly bars (history only).
// Day 2 Asia (00–06 UTC): range exactly [1.1000, 1.1010].
// 07:00 stays inside the range; 08:00 closes at 1.1015 (BUY breakout);
// 12:00's high (1.1032) is the first touch of the 1.1030 take-profit.
export function londonBreakoutCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let h = 0; h < 24; h++) {
    const open = 1.1002 + 0.0002 * ((h % 3) - 1);
    candles.push({ time: DAY1 + h * HOUR, open, close: open + 0.0002, high: open + 0.0006, low: open - 0.0004 });
  }
  const day2Bars: Array<[number, number, number, number]> = [
    // [open, high, low, close] for hours 0..15
    [1.1003, 1.1008, 1.1002, 1.1005],
    [1.1005, 1.1007, 1.1002, 1.1004],
    [1.1004, 1.1006, 1.1000, 1.1003], // Asia low 1.1000
    [1.1003, 1.1010, 1.1002, 1.1006], // Asia high 1.1010
    [1.1006, 1.1008, 1.1003, 1.1005],
    [1.1005, 1.1009, 1.1004, 1.1007],
    [1.1007, 1.1008, 1.1004, 1.1006],
    [1.1005, 1.1009, 1.1004, 1.1008], // 07:00 — inside range, no breakout yet
    [1.1008, 1.1016, 1.1007, 1.1015], // 08:00 — BUY breakout close
    [1.1015, 1.1020, 1.1013, 1.1018],
    [1.1018, 1.1023, 1.1016, 1.1021],
    [1.1021, 1.1026, 1.1019, 1.1024],
    [1.1024, 1.1032, 1.1022, 1.1030], // 12:00 — TP 1.1030 first touched
    [1.1030, 1.1033, 1.1028, 1.1031],
    [1.1031, 1.1035, 1.1029, 1.1033],
    [1.1033, 1.1036, 1.1031, 1.1034],
  ];
  day2Bars.forEach(([open, high, low, close], h) => {
    candles.push({ time: DAY2 + h * HOUR, open, high, low, close });
  });
  return candles;
}

export function londonBreakoutDataset(costModel: { spreadPips: number } | null = null): FrozenReplayDataset {
  return buildFrozenFrames(
    {
      datasetId: "fixture-london-breakout",
      symbol: "EURUSD",
      pipSize: 0.0001,
      candles: londonBreakoutCandles(),
      costModel,
    },
    { firstFrameIndex: 24 }, // frames = day-2 hours 00..15 (16 frames)
  );
}

// Frame indices (into the 16 day-2 frames) where the engine must emit BUY.
export const LONDON_EMIT_FRAMES = [8, 9, 10, 11, 12, 13, 14, 15];

// ── Trend-continuation scenario ─────────────────────────────────────────────
// 100 hourly bars in a clean uptrend (+0.0004/bar, monotonic closes ⇒
// directional efficiency 1, TRENDING_UP once ≥30 bars). Bars 70 and 85 carry
// a deep low wick down to open−0.005 — the SMA20 pullback trigger — so the
// engine emits exactly at frames 71 and 86 (ATR needs ≥64 bars, satisfied).
export const TREND_WICK_BARS = [70, 85];
export const TREND_EMIT_FRAMES = [71, 86];

export function trendContinuationCandles(): Candle[] {
  const s = 0.0004;
  const candles: Candle[] = [];
  for (let i = 0; i < 100; i++) {
    const open = 1.1 + s * i;
    const close = open + s;
    const wick = TREND_WICK_BARS.includes(i);
    candles.push({
      time: DAY1 + i * HOUR,
      open,
      close,
      high: close + 0.001,
      low: open - (wick ? 0.005 : 0.001),
    });
  }
  return candles;
}

export function trendContinuationDataset(): FrozenReplayDataset {
  return buildFrozenFrames(
    {
      datasetId: "fixture-trend-continuation",
      symbol: "EURUSD",
      pipSize: 0.0001,
      candles: trendContinuationCandles(),
      costModel: null,
    },
    { firstFrameIndex: 0 },
  );
}
