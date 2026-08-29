import type { StrategyInput } from "../strategies/strategy.types";
import type { Candle } from "../market/marketRegime.engine";
import { classifyRegime } from "../market/marketRegime.engine";
import { classifyVolatility } from "../market/volatility.engine";
import { reportSession } from "../market/session.engine";
import { detectLiquidityZones } from "../market/liquidity.engine";
import type { NewsWindow } from "../risk/riskGates.types";

// ═══════════════════════════════════════════════════════════════════════════
// Frozen replay — deterministic frame construction from recorded candles.
//
// A frame is exactly the StrategyInput the live scanner would have built at
// that candle's close: the candle history up to and including that candle,
// with regime / volatility / session / liquidity context recomputed by the
// SAME production classifiers. Nothing is synthesized — context is a pure
// function of the recorded candles and the recorded clock.
// ═══════════════════════════════════════════════════════════════════════════

export interface FrozenReplaySource {
  readonly datasetId: string;
  readonly symbol: string;
  readonly pipSize: number;
  readonly candles: ReadonlyArray<Candle>;   // ordered oldest → newest
  readonly newsWindows?: ReadonlyArray<NewsWindow>;
  // Trading costs of the recorded venue. null = unknown; downstream cost
  // figures then report null with a typed reason — never a made-up spread.
  readonly costModel: { readonly spreadPips: number } | null;
}

export interface FrozenReplayDataset {
  readonly datasetId: string;
  readonly symbol: string;
  readonly pipSize: number;
  readonly frames: ReadonlyArray<StrategyInput>;
  readonly costModel: { readonly spreadPips: number } | null;
}

export interface BuildFramesOptions {
  // First candle index (0-based) that becomes a frame. Earlier candles are
  // history only. Defaults to 0 (every candle is a frame).
  readonly firstFrameIndex?: number;
}

export function buildFrozenFrames(source: FrozenReplaySource, opts: BuildFramesOptions = {}): FrozenReplayDataset {
  const first = Math.max(0, opts.firstFrameIndex ?? 0);
  const frames: StrategyInput[] = [];

  for (let i = first; i < source.candles.length; i++) {
    const candles = source.candles.slice(0, i + 1);
    const now = new Date(candles[candles.length - 1].time);
    frames.push({
      symbol: source.symbol,
      candles,
      pipSize: source.pipSize,
      now,
      regime: classifyRegime(candles),
      volatility: classifyVolatility(candles),
      session: reportSession(now),
      liquidity: detectLiquidityZones(candles),
      newsWindows: [...(source.newsWindows ?? [])],
    });
  }

  return {
    datasetId: source.datasetId,
    symbol: source.symbol,
    pipSize: source.pipSize,
    frames,
    costModel: source.costModel,
  };
}
