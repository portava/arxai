// Strategy replay: graded samples for the strategy engine's confidence scores.
//
// Each strategy is run on a rolling window of candles; every actionable signal
// is graded first-touch (target before stop) on the bars AFTER the signal bar
// only. Per strategy, a new signal is not taken until the previous one has
// resolved, so samples do not overlap (overlapping trades are correlated and
// would make the cross-validated edge test over-confident).
//
// Session Breakout is NOT replayed: its rule reads the wall clock
// (detectSession), so a replay would grade it on today's session, not the
// bar's. It stays unmeasured rather than measured wrongly.

import {
  labelFirstTouch,
  type CalibrationSample,
} from "@workspace/domain/calibration";
import {
  breakOfStructureStrategy,
  liquiditySweepStrategy,
  meanReversionStrategy,
  pullbackContinuationStrategy,
  trendContinuationStrategy,
  volatilityExpansionStrategy,
  type Candle,
  type SignalOutput,
} from "../strategyEngine.js";
import { strategyCalibrationKey } from "./cache.js";

export const REPLAY_WINDOW = 250;
export const REPLAY_HORIZON_BARS = 60;

type StrategyFn = (candles: Candle[], symbol: string) => SignalOutput;

export const REPLAYABLE_STRATEGIES: { name: string; fn: StrategyFn }[] = [
  { name: "Trend Continuation", fn: trendContinuationStrategy },
  { name: "Break of Structure", fn: breakOfStructureStrategy },
  { name: "Liquidity Sweep Reversal", fn: liquiditySweepStrategy },
  { name: "Volatility Expansion", fn: volatilityExpansionStrategy },
  { name: "Pullback Continuation", fn: pullbackContinuationStrategy },
  { name: "Mean Reversion", fn: meanReversionStrategy },
];

export interface ReplaySample extends CalibrationSample {
  strategyKey: string;
  barIndex: number;
  direction: "BUY" | "SELL";
  /** Reward-to-risk of the call's own geometry: R won on a WIN (a LOSS is -1R). */
  rr: number;
}

export function replayStrategies(
  candles: Candle[],
  symbol: string,
  opts: { window?: number; horizon?: number } = {},
): ReplaySample[] {
  const window = opts.window ?? REPLAY_WINDOW;
  const horizon = opts.horizon ?? REPLAY_HORIZON_BARS;
  const out: ReplaySample[] = [];
  const nextAllowed = new Map<string, number>();
  for (let i = window - 1; i < candles.length - 1; i++) {
    const slice = candles.slice(i - window + 1, i + 1);
    for (const s of REPLAYABLE_STRATEGIES) {
      if (i < (nextAllowed.get(s.name) ?? 0)) continue;
      const sig = s.fn(slice, symbol);
      if (sig.direction !== "BUY" && sig.direction !== "SELL") continue;
      const outcome = labelFirstTouch(candles, i, sig.direction, sig.stopLoss, sig.takeProfit, horizon);
      if (outcome === null) {
        nextAllowed.set(s.name, i + horizon + 1);
        continue;
      }
      // Find the resolution bar so the next signal starts after it.
      let j = i + 1;
      for (; j <= Math.min(candles.length - 1, i + horizon); j++) {
        if (labelFirstTouch(candles, i, sig.direction, sig.stopLoss, sig.takeProfit, j - i) !== null) break;
      }
      nextAllowed.set(s.name, j + 1);
      out.push({
        strategyKey: strategyCalibrationKey(s.name),
        barIndex: i,
        direction: sig.direction,
        score: sig.score,
        outcome,
        rr: Math.abs(sig.takeProfit - sig.entryPrice) / Math.max(1e-12, Math.abs(sig.entryPrice - sig.stopLoss)),
      });
    }
  }
  return out;
}
