// Chart read verification → decision-summary cap (truth upgrade, 2026-10-28).
//
// The decision summary (readiness quality → "ready"/"prepare") is built from
// the candle engines, which only know whether the feed is AI-usable and not
// stale. The chart-truth gate is a separate, stricter verdict: Chart Truth
// below 75, a stale feed, a failed broker mirror, a handshake check that is
// unmeasured or failing (Ruby's handshake, chart rendering included) or a
// feed that is not live means the read has NOT been verified. Ruby already
// refuses a setup in that state; without this cap Chart Pulse said
// "A · Ready" and the best-action sentence said "act with a defined stop" on
// the same board.
//
// The cap only ever LOWERS an actionable summary to "watch" and names why. It
// never raises anything and never touches an execution gate: the chart never
// executes from the decision summary, and the gate output itself is unchanged.

import { CHART_TRUTH_THRESHOLD, type ChartGateOutput } from "./chartGateOutput.js";
import type { ChartFeedStatus } from "./chartDataService.js";
import type { ChartDecisionState } from "./chartIntelligence.js";
import { buildChartHandshake } from "./chartHandshake.js";
import type { ChartTruthScore } from "./chartTruthScore.js";

export interface ChartReadVerification {
  /** True only when every chart-truth check behind a confident read passes. */
  verified: boolean;
  /** Plain-English reasons the read is not verified (empty when verified). */
  reasons: string[];
}

/**
 * The candle-data checks Ruby's handshake requires to PASS (measured and
 * scoring at least 75), in plain words. Same keys `buildChartHandshake` reads.
 */
const HANDSHAKE_CHECKS: ReadonlyArray<{ key: string; words: string }> = [
  { key: "ohlc_integrity", words: "the candle integrity check" },
  { key: "timeframe_accuracy", words: "the timeframe and history check" },
  { key: "feed_freshness", words: "the feed freshness check" },
  { key: "historical_live_merge", words: "the history-to-live join check" },
  { key: "symbol_mirror_accuracy", words: "the broker price comparison" },
];
const HANDSHAKE_PASS = 75;
const RENDER_FAIL_BELOW = 50;
const RENDER_WORDS = "chart rendering";

const FEED_QUALITY_WORDS: Record<string, string> = {
  delayed: "the candle feed is delayed",
  partial: "the candle feed is missing bars",
  invalid: "the candle feed has invalid bars",
  empty: "the candle feed returned no bars",
  unavailable: "the candle feed is unavailable",
};

// tradeConfirmationAllowed is false for a merge-seam failure (the chart's own
// history and live bars) OR a broker comparison that ran and failed. Name the
// cause the gate recorded; the broker wording only when a comparison failed.
const SEAM_FAILED = "Merge-seam integrity failed";
const BROKER_ALIGNMENT_FAILED = "Broker price alignment failed";
function tradeConfirmationReasons(gate: Pick<ChartGateOutput, "blockedReasons">): string[] {
  const recorded = Array.isArray(gate.blockedReasons) ? gate.blockedReasons : [];
  const out: string[] = [];
  if (recorded.some((r) => r.startsWith(SEAM_FAILED))) out.push("the chart's history and live bars do not join cleanly");
  if (recorded.some((r) => r.startsWith(BROKER_ALIGNMENT_FAILED))) out.push("the chart's prices failed the broker-mirror check");
  return out.length ? out : ["the chart's trade-confirmation check failed (the gate did not record why)"];
}

type FeedFacts = Pick<ChartFeedStatus, "isLive"> & Partial<Pick<ChartFeedStatus, "stale" | "aiUsable" | "quality">>;

/**
 * Whether the chart read is verified enough to invite action. It is Ruby's
 * chart-read predicate (truth ≥ 75, real OHLC, feed AI-usable and not stale,
 * mirror not failed, and every handshake check measured and passing —
 * `buildChartHandshake(...).overall === "PASS"`, the same full rollup Ruby's
 * VERIFIED basis and draft read require, chart rendering included), plus a
 * live feed: a closed market or stored bars cannot back "act now". So the
 * board can never say "Ready" while Ruby refuses a setup on the same read.
 * Chart rendering is client telemetry the server does not measure, so while
 * it stays unmeasured no read is verified, and the reason says so. A missing
 * gate, feed status or truth score is treated as not verified.
 */
export function chartReadVerification(
  gate: ChartGateOutput | null | undefined,
  feed: FeedFacts | null | undefined,
  truthScore: ChartTruthScore | null | undefined,
): ChartReadVerification {
  const reasons: string[] = [];
  if (!gate) {
    reasons.push("the chart truth check was not available");
  } else {
    if (!gate.confidentReadAllowed) {
      reasons.push(
        `Chart Truth is ${gate.chartTruthScore}/100, below the ${CHART_TRUTH_THRESHOLD} needed for a verified read`,
      );
    }
    if (gate.candlestickModeAllowed !== true) reasons.push("the provider does not deliver real OHLC candles");
    if (!gate.autonomousChartActionAllowed) reasons.push("the feed is stale");
    if (!gate.tradeConfirmationAllowed) reasons.push(...tradeConfirmationReasons(gate));
    const subMetrics = Array.isArray(truthScore?.subMetrics) ? truthScore!.subMetrics : null;
    if (!subMetrics) {
      reasons.push("the chart truth checks could not be loaded");
    } else {
      for (const check of HANDSHAKE_CHECKS) {
        // A stale feed already fails freshness; do not say it twice.
        if (check.key === "feed_freshness" && !gate.autonomousChartActionAllowed) continue;
        const m = subMetrics.find((x) => x.key === check.key);
        if (!m || m.evidenceStatus !== "measured" || m.rawScore == null || !Number.isFinite(m.rawScore)) {
          reasons.push(`${check.words} was not measured`);
        } else if (m.rawScore < HANDSHAKE_PASS) {
          reasons.push(`${check.words} scored ${Math.round(m.rawScore)}/100 (needs ${HANDSHAKE_PASS})`);
        }
      }
      // Ruby's basis keeps the full handshake rollup, RenderHealth included,
      // so an unmeasured or weak render check blocks here too.
      const render = subMetrics.find((x) => x.key === "render_accuracy");
      if (!render || render.evidenceStatus !== "measured" || render.rawScore == null || !Number.isFinite(render.rawScore)) {
        reasons.push(`${RENDER_WORDS} is not measured`);
      } else if (render.rawScore < RENDER_FAIL_BELOW) {
        reasons.push("the chart renderer reported a failure");
      } else if (render.rawScore < HANDSHAKE_PASS) {
        reasons.push(`${RENDER_WORDS} scored ${Math.round(render.rawScore)}/100 (needs ${HANDSHAKE_PASS})`);
      }
      // The handshake itself is the authority: if it does not PASS for a
      // reason not named above, the read is still not verified.
      if (reasons.length === 0 && buildChartHandshake(gate, truthScore!).overall !== "PASS") {
        reasons.push("a chart truth check Ruby's read requires did not pass");
      }
    }
  }
  if (!feed || feed.isLive !== true) reasons.push("the feed is not live right now");
  if (feed && feed.stale === true && !reasons.includes("the feed is stale")) reasons.push("the feed is stale");
  if (feed && feed.aiUsable !== true && feed.stale !== true && feed.quality !== "stale") {
    reasons.push(FEED_QUALITY_WORDS[feed.quality ?? ""] ?? "the candle feed is not confirmed clean");
  }
  return { verified: reasons.length === 0, reasons };
}

/**
 * Lower a "ready"/"prepare" decision summary to "watch" when the chart read is
 * not verified. Anything else (already watch / stand aside / unpopulated) is
 * returned unchanged.
 */
export function capDecisionStateByChartTruth(
  decision: ChartDecisionState,
  verification: ChartReadVerification,
): ChartDecisionState {
  if (verification.verified || !decision.populated) return decision;
  if (decision.actionability !== "ready" && decision.actionability !== "prepare") {
    return decision;
  }
  const tail = decision.decision?.split(" — ").slice(1).join(" — ") ?? "";
  const why = verification.reasons.join("; ");
  return {
    ...decision,
    actionability: "watch",
    decision: tail ? `watch — ${tail} (not verified)` : "watch (not verified)",
    note: `Read-only summary of the engine outputs. Capped at watch because the chart read is not verified: ${why}. The chart never executes from this state.`,
  };
}
