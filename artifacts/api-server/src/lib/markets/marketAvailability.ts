// Task #412 — Backend market availability resolver (composition only).
//
// Given an approved Top 250 market, compose the EXISTING truth machinery
// (chart feed status / candle quality / aiUsable, Deriv synthetic feed,
// broker mapping from arx_symbol_specs) into the user-safe MarketAvailability
// shape. It NEVER re-implements or weakens any of those sources, and NEVER
// lets simulator/synthetic-only data make a market selectable for a regular
// user.
//
// Selectable rule (spec): selectable === true ONLY when real provider data
// exists (live/delayed/stale). no_data / simulator_only / provider_missing /
// broker_mapping_missing are NOT selectable. tradeable additionally requires a
// confirmed broker mapping; the FINAL trade yes/no is still resolved by the
// existing 16-gate pipeline upstream — this resolver only reports eligibility.

import {
  availabilityFromDataStatus,
  type ArxMarket,
  type MarketAvailability,
  type MarketDataStatus,
} from "@workspace/markets";
import { getChartFeedStatus } from "../data/chart/chartDataService.js";
import { resolveBrokerSymbol } from "../mt5/symbolDirectory.js";
import type { ChartTimeframe } from "../data/chart/timeframes.js";

export interface MarketAvailabilityContext {
  /** When provided, broker mapping is checked for this user's directory. */
  userId?: number | null;
  /** Timeframe used for the feed-status probe (defaults to M5). */
  timeframe?: ChartTimeframe;
  /** Backend-resolvable symbol form (synthetics use their short code). When
   *  omitted, the market's standardSymbol is used. */
  dataSymbol?: string;
}

function mapQualityToDataStatus(
  quality: string,
  aiUsable: boolean,
): MarketDataStatus {
  switch (quality) {
    case "clean":
      return "live";
    case "delayed":
      return "delayed";
    case "stale":
    case "partial":
      return "stale";
    case "invalid":
    case "unavailable":
    default:
      return aiUsable ? "stale" : "no_data";
  }
}

/**
 * Resolve honest availability for one approved market by composing existing
 * truth sources. Fail-closed: any error degrades to no_data (not selectable).
 */
export async function resolveMarketAvailability(
  market: ArxMarket,
  ctx: MarketAvailabilityContext = {},
): Promise<MarketAvailability> {
  const tf: ChartTimeframe = ctx.timeframe ?? "M5";
  const dataSymbol = ctx.dataSymbol ?? market.standardSymbol;

  let dataStatus: MarketDataStatus = "no_data";
  let feedFresh = false;
  let aiUsable = false;

  try {
    const feed = await getChartFeedStatus(dataSymbol, tf);
    feedFresh = feed.quality === "clean" || feed.quality === "delayed";
    aiUsable = feed.aiUsable === true;
    if (feed.quality === "unavailable" || feed.quality === "invalid") {
      dataStatus = "no_data";
    } else {
      dataStatus = mapQualityToDataStatus(feed.quality, aiUsable);
    }
  } catch {
    dataStatus = "no_data";
  }

  // Broker mapping: only meaningful when we know the user (per-user directory).
  let brokerMapped = false;
  if (ctx.userId && ctx.userId > 0) {
    try {
      const resolved = await resolveBrokerSymbol(ctx.userId, dataSymbol);
      brokerMapped = resolved.ok === true;
    } catch {
      brokerMapped = false;
    }
  }

  // If there IS real data but no broker mapping, surface analysis-only.
  // If there is NO data at all, that dominates (no_data not selectable).
  const hasRealData = dataStatus === "live" || dataStatus === "delayed" || dataStatus === "stale";

  return availabilityFromDataStatus(market, dataStatus, {
    brokerMapped,
    feedFresh,
    aiUsable,
    // tradeable eligibility (pre-16-gate): real data + broker mapping.
    tradeable: hasRealData && brokerMapped,
  });
}
