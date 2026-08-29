// ── Distribution-OOD service (capability #3) — live assembler ───────────────
//
// Builds certified reference distributions from the EXISTING candle/quote
// history and compares the live tail window against them with the pure domain
// engine (continuous-validation/distributionOod.engine).
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
): LiveOodReport {
  try {
    const env = getCandles(symbol, timeframe, OOD_HISTORY_BARS);
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
    const spreads = getSpreadRelHistory(symbol) ?? [];
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
