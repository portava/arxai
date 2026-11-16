// Self-Trade AI — Volatility Relationship Matrix service (Task #212, T003).
//
// SAFETY / SCOPE:
//   - READ-ONLY + decision-only. Computes per-symbol direction/momentum and
//     pairwise correlation/lead-lag/decoupling over the Deriv synthetic
//     volatility family (V10..V100) using REAL candles via the existing market
//     data router. Never fabricates relationships — insufficient data collapses
//     to an honest blind node/pair.
//   - On a fresh decouple ("opposite run") it raises a deduped alert into My
//     Alerts via the existing notify() path. It never trades or gates execution.

import {
  buildVolatilityMatrix,
  type VolatilityMatrix,
  type VolatilitySeriesInput,
} from "@workspace/domain/self-trade";
import type { SignalCandle } from "@workspace/domain/signal-intelligence";
import { routeCandles } from "../data/marketDataRouter.js";
import { DERIV_SYNTHETIC_SYMBOLS } from "../data/providers/derivProvider.js";
import { notify } from "../notifications/service.js";
import { logger } from "../logger.js";

// The core synthetic volatility family (excludes Boom/Crash/Step jump indices,
// whose discontinuities make correlation noise rather than signal).
const MATRIX_SYMBOLS = ["V10", "V25", "V50", "V75", "V100"] as const;
const MATRIX_TF = "M5";
const CANDLE_LIMIT = 120;
const CACHE_TTL_MS = 8_000;

let cache: { at: number; matrix: VolatilityMatrix } | null = null;

function displayNameOf(symbol: string): string {
  return DERIV_SYNTHETIC_SYMBOLS.find((s) => s.symbol === symbol)?.displayName ?? symbol;
}

function toSignalCandles(candles: { open: number; high: number; low: number; close: number; time: string }[]): SignalCandle[] {
  return candles.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, time: c.time }));
}

async function fetchSeries(symbol: string): Promise<VolatilitySeriesInput> {
  try {
    const res = await routeCandles(symbol, MATRIX_TF, CANDLE_LIMIT);
    return {
      symbol,
      displayName: displayNameOf(symbol),
      candles: res.ok && res.candles.length > 0 ? toSignalCandles(res.candles) : null,
    };
  } catch (err) {
    logger.warn({ err, symbol }, "self-trade volatility: candle fetch failed (blind node)");
    return { symbol, displayName: displayNameOf(symbol), candles: null };
  }
}

// Fire a deduped opposite-run alert for each freshly-decoupled pair. Fail-open:
// an alert error must never break the matrix read.
async function alertDecoupled(matrix: VolatilityMatrix): Promise<void> {
  for (const pair of matrix.decoupledPairs) {
    try {
      await notify(
        {
          type: "DATA",
          severity: "WARNING",
          title: "Volatility decoupling detected",
          message: `${displayNameOf(pair.symbolA)} and ${displayNameOf(pair.symbolB)} normally move together but are now running opposite.`,
          sourceBuild: "HH",
          symbol: pair.symbolA,
          metadata: {
            symbolA: pair.symbolA,
            symbolB: pair.symbolB,
            correlation: pair.correlation,
            recentCorrelation: pair.recentCorrelation,
          },
          // Stable per-pair key so repeated reads collapse to one live alert.
          dedupeKey: `self-trade:volatility-decouple:${pair.symbolA}:${pair.symbolB}`,
        },
        { idempotent: true },
      );
    } catch (err) {
      logger.warn({ err, pair: `${pair.symbolA}/${pair.symbolB}` }, "self-trade volatility: decouple alert failed (fail-open)");
    }
  }
}

export async function getVolatilityMatrix(opts: { force?: boolean } = {}): Promise<VolatilityMatrix> {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < CACHE_TTL_MS) return cache.matrix;

  const series = await Promise.all(MATRIX_SYMBOLS.map((s) => fetchSeries(s)));
  const matrix = buildVolatilityMatrix(series, now);
  cache = { at: now, matrix };
  if (matrix.decoupledPairs.length > 0) await alertDecoupled(matrix);
  return matrix;
}
