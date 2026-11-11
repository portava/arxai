// Whether the chart-truth gate has verified a Chart Intelligence read — the
// same conditions the server uses to cap the decision summary and Eleanor uses
// for a directional read: Chart Truth >= 75, real OHLC candles, feed clean and
// not stale, broker mirror not failed, every candle-data check Eleanor's
// handshake reads measured and passing, and a live feed. Client surfaces may
// only DOWNGRADE with this (cap a "ready", withhold a consensus stance), never
// upgrade a server claim.

import type { ChartIntelligenceResponse } from "@workspace/api-client-react";

type ChartState = ChartIntelligenceResponse["state"];

export interface ChartReadVerification {
  verified: boolean;
  /** Plain-English reasons the read is not verified (empty when verified). */
  reasons: string[];
}

// The candle-data checks Eleanor's handshake (server buildChartHandshake →
// sourceOverall) requires to be measured and score at least 75.
const HANDSHAKE_CHECKS: ReadonlyArray<{ key: string; words: string }> = [
  { key: "ohlc_integrity", words: "the candle integrity check" },
  { key: "timeframe_accuracy", words: "the timeframe and history check" },
  { key: "feed_freshness", words: "the feed freshness check" },
  { key: "historical_live_merge", words: "the history-to-live join check" },
  { key: "symbol_mirror_accuracy", words: "the complete chart and broker comparison" },
];
const HANDSHAKE_PASS = 75;
const RENDER_FAIL_BELOW = 50;

const FEED_QUALITY_WORDS: Record<string, string> = {
  delayed: "the candle feed is delayed",
  partial: "the candle feed is missing bars",
  invalid: "the candle feed has invalid bars",
  empty: "the candle feed returned no bars",
  unavailable: "the candle feed is unavailable",
};

// tradeConfirmationAllowed is false for a merge-seam failure (the chart's own
// history and live bars) OR a broker comparison that ran and failed. Name the
// cause the server gate recorded; the broker wording only when one failed.
function tradeConfirmationReasons(blockedReasons: unknown): string[] {
  const recorded = Array.isArray(blockedReasons) ? blockedReasons.filter((r): r is string => typeof r === "string") : [];
  const out: string[] = [];
  if (recorded.some((r) => r.startsWith("Merge-seam integrity failed"))) out.push("the chart's history and live bars do not join cleanly");
  if (recorded.some((r) => r.startsWith("Broker price alignment failed"))) out.push("the broker-mirror check failed");
  return out.length ? out : ["the chart's trade-confirmation check failed (the gate did not record why)"];
}

type SubMetric = { key?: string; rawScore?: number | null; evidenceStatus?: string };

export function chartReadVerification(state: ChartState): ChartReadVerification {
  const gate = (state as { gateOutput?: ChartState["gateOutput"] | null }).gateOutput ?? null;
  const reasons: string[] = [];
  if (!gate) {
    reasons.push("the chart truth check could not be loaded");
  } else {
    if (!gate.confidentReadAllowed) reasons.push(`Chart Truth ${gate.chartTruthScore}/100 (needs 75)`);
    if (gate.candlestickModeAllowed !== true) reasons.push("the provider does not deliver real OHLC candles");
    if (!gate.autonomousChartActionAllowed) reasons.push("the feed is stale");
    if (!gate.tradeConfirmationAllowed) reasons.push(...tradeConfirmationReasons(gate.blockedReasons));
    const score = (state as { chartTruthScore?: { subMetrics?: unknown } | null }).chartTruthScore;
    const subMetrics = Array.isArray(score?.subMetrics) ? (score!.subMetrics as SubMetric[]) : null;
    if (!subMetrics) {
      reasons.push("the chart truth checks could not be loaded");
    } else {
      for (const check of HANDSHAKE_CHECKS) {
        // A stale feed already fails freshness; do not say it twice.
        if (check.key === "feed_freshness" && !gate.autonomousChartActionAllowed) continue;
        const m = subMetrics.find((x) => x?.key === check.key);
        const raw = m?.rawScore;
        if (!m || m.evidenceStatus !== "measured" || raw == null || !Number.isFinite(raw)) {
          reasons.push(`${check.words} was not measured`);
        } else if (raw < HANDSHAKE_PASS) {
          reasons.push(`${check.words} scored ${Math.round(raw)}/100 (needs ${HANDSHAKE_PASS})`);
        }
      }
      const render = subMetrics.find((x) => x?.key === "render_accuracy");
      if (render?.evidenceStatus === "measured" && render.rawScore != null && render.rawScore < RENDER_FAIL_BELOW) {
        reasons.push("the chart renderer reported a failure");
      }
    }
  }
  const feed = state.truthState as { isLive?: boolean; stale?: boolean; aiUsable?: boolean; quality?: string } | null | undefined;
  if (feed?.isLive !== true) reasons.push("the feed is not live right now");
  if (feed && feed.stale === true && !reasons.includes("the feed is stale")) reasons.push("the feed is stale");
  if (feed && feed.aiUsable !== true && feed.stale !== true && feed.quality !== "stale") {
    reasons.push(FEED_QUALITY_WORDS[feed.quality ?? ""] ?? "the candle feed is not confirmed clean");
  }
  return { verified: reasons.length === 0, reasons };
}
