// ── Distribution-OOD service (capability #3) — live assembler ───────────────
//
// Builds certified reference distributions from the EXISTING candle/quote
// history and compares the live tail window against them with the pure domain
// engine (continuous-validation/distributionOod.engine).
//
// CONSUMER: GET /admin/market-data/distribution-ood/:symbol
// (routes/adminMarketDataDiagnostics.ts, ADMIN/OWNER). Both the assembly and
// the UNREADABLE degrade path are proven in the test:epistemic-live-assemblers
// lane (real-shaped injected history + a throwing reader).
//
// HONESTY:
//   * The reference is built from the older part of the same real history —
//     never synthesized. Too little history → the domain engine's typed
//     INSUFFICIENT_REFERENCE / INSUFFICIENT_EVIDENCE, never a verdict.
//   * ADVISORY ONLY (`advisoryOnly: true` is stamped by the engine): this
//     service is journal/display evidence. It is not a gate key and no
//     execution path consults it as authority.
//   * A failed read degrades to a typed UNREADABLE result — never a verdict.

import {
  buildReferenceDistribution,
  evaluateDistributionOod,
  volatilityFeature,
  type DistributionOodInput,
  type DistributionOodVerdict,
} from "@workspace/domain/continuous-validation";
import { logger } from "../logger.js";
import { getCandles } from "../marketDataLayer.js";
import { getSpreadRelHistory } from "../aaci/spreadHistoryRecorder.js";

/** Live tail = the newest LIVE_WINDOW bars; reference = everything older. */
export const OOD_LIVE_WINDOW_BARS = 40;
export const OOD_HISTORY_BARS = 500;

export type LiveOodReport =
  | { status: "OK"; symbol: string; timeframe: string; verdict: DistributionOodVerdict }
  | { status: "UNREADABLE"; symbol: string; timeframe: string; reason: string };

/** History readers, injectable ONLY so tests can prove both the assembly and
 *  the UNREADABLE degrade path deterministically. Production callers use the
 *  defaults (the real candle layer + spread recorder). */
export interface DistributionOodDeps {
  candles: (symbol: string, timeframe: string, limit: number) => { candles: { close: number }[] };
  spreadRelHistory: (symbol: string) => number[] | null | undefined;
}

const DEFAULT_DEPS: DistributionOodDeps = {
  candles: (symbol, timeframe, limit) => getCandles(symbol, timeframe, limit),
  spreadRelHistory: (symbol) => getSpreadRelHistory(symbol),
};

/**
 * Evaluate the live environment for one symbol against references certified
 * from its own history. Features measurable today: volatility (candle
 * history) and cost (recorded relative spreads). Tick cadence needs a raw
 * quote-timestamp feed and is added when that history source exists — it is
 * NOT approximated from candle times.
 */
export function evaluateLiveDistributionOod(
  symbol: string,
  timeframe = "M15",
  deps: DistributionOodDeps = DEFAULT_DEPS,
): LiveOodReport {
  try {
    const env = deps.candles(symbol, timeframe, OOD_HISTORY_BARS);
    const closes = env.candles.map((c) => ({ close: c.close }));
    const vol = volatilityFeature(closes);
    const volRef = vol.slice(0, Math.max(0, vol.length - OOD_LIVE_WINDOW_BARS));
    const volLive = vol.slice(-OOD_LIVE_WINDOW_BARS);

    const inputs: DistributionOodInput[] = [
      {
        feature: "volatility",
        liveValues: volLive,
        reference: buildReferenceDistribution("volatility", volRef),
      },
    ];

    // Cost: recorded relative spreads. The recorder keeps a bounded recent
    // window; older half is the reference, newest half the live window. Thin
    // history yields the engine's typed insufficiency — never a guess.
    const spreads = deps.spreadRelHistory(symbol) ?? [];
    const cut = Math.floor(spreads.length / 2);
    inputs.push({
      feature: "cost",
      liveValues: spreads.slice(cut),
      reference: buildReferenceDistribution("cost", spreads.slice(0, cut)),
    });

    return {
      status: "OK",
      symbol,
      timeframe,
      verdict: evaluateDistributionOod(inputs),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ symbol, timeframe, err: reason }, "distribution_ood_unreadable");
    return { status: "UNREADABLE", symbol, timeframe, reason };
  }
}
