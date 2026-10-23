// Visibility choke point: intersect provider/broker discovery against the
// approved Top 250 — never expose raw provider output. Disabled approved
// markets are surfaced (not silently removed) with honest, user-safe copy.

import type {
  ArxMarket,
  MarketAvailability,
  MarketDataStatus,
  VisibleMarket,
} from "./types.js";
import { ARX_TOP_250 } from "./universe.js";
import { compactMarketKey } from "./resolve.js";
import { ARX_MARKET_COPY } from "./copy.js";

/**
 * Intersect raw provider/broker-discovered symbols against the approved
 * directory. Returns ONLY approved markets whose standardSymbol,
 * providerSymbols, or brokerAliases match a discovered symbol. Raw provider
 * output is never returned — anything not in the Top 250 is dropped.
 */
export function intersectProviderSymbols(discovered: Iterable<string>): ArxMarket[] {
  const want = new Set<string>();
  for (const d of discovered) {
    if (d) want.add(compactMarketKey(d));
  }
  if (want.size === 0) return [];
  const out: ArxMarket[] = [];
  for (const m of ARX_TOP_250) {
    const keys = [m.standardSymbol, ...m.providerSymbols, ...m.brokerAliases].map(compactMarketKey);
    if (keys.some((k) => want.has(k))) out.push(m);
  }
  return out;
}

/** Map a raw data status into the user-safe availability + disabled copy. */
export function availabilityFromDataStatus(
  market: ArxMarket,
  dataStatus: MarketDataStatus,
  opts: { brokerMapped?: boolean; feedFresh?: boolean; aiUsable?: boolean; tradeable?: boolean } = {},
): MarketAvailability {
  const brokerMapped = opts.brokerMapped ?? false;
  const feedFresh = opts.feedFresh ?? dataStatus === "live";
  const aiUsable = opts.aiUsable ?? dataStatus === "live";

  // Selectable ONLY when real provider data exists. Simulator/synthetic-only,
  // no-data, missing-provider, and missing-broker-mapping are NOT selectable.
  const hasRealData = dataStatus === "live" || dataStatus === "delayed" || dataStatus === "stale";
  const selectable = hasRealData;

  // Trade requires a confirmed broker mapping in addition to real data; the
  // final yes/no is still resolved by the existing 16-gate pipeline upstream.
  const tradeable = (opts.tradeable ?? false) && selectable && brokerMapped;

  let disabledReason: string | null = null;
  if (!selectable) {
    switch (dataStatus) {
      case "no_data":
        disabledReason = ARX_MARKET_COPY.approvedNoData;
        break;
      case "simulator_only":
      case "provider_missing":
        disabledReason = ARX_MARKET_COPY.noDataYet;
        break;
      case "broker_mapping_missing":
        disabledReason = ARX_MARKET_COPY.brokerNotConfirmed;
        break;
      default:
        disabledReason = ARX_MARKET_COPY.waitingForFeed;
    }
  } else if (!tradeable && !brokerMapped) {
    disabledReason = ARX_MARKET_COPY.brokerNotConfirmed;
  }

  return {
    approved: true,
    visible: true,
    selectable,
    tradeable,
    disabledReason,
    dataStatus,
    sourcesAvailable: hasRealData,
    brokerMapped,
    feedFresh,
    aiUsable,
  };
}

/** Default availability for an approved market with no resolved truth yet. */
export function defaultUnavailable(market: ArxMarket): MarketAvailability {
  return availabilityFromDataStatus(market, "no_data");
}

export interface VisibleMarketsOptions {
  /** Resolver that returns the live truth for one market (composed in the
   *  api-server from marketDataRouter/chart/Deriv/broker mapping). When
   *  omitted, every approved market is shown as approved-but-no-data. */
  resolveAvailability?: (market: ArxMarket) => MarketAvailability;
  /** Optional asset-class filter. */
  assetClass?: ArxMarket["assetClass"];
  /** When true, include markets flagged hidden (admin/diagnostic only). */
  includeHidden?: boolean;
}

/**
 * The single user-facing market list. Always the approved Top 250 (optionally
 * filtered by asset class), each annotated with honest availability. Disabled
 * markets stay in the list with a user-safe reason — they are never dropped,
 * and raw provider output is never surfaced.
 */
export function getUserVisibleMarkets(opts: VisibleMarketsOptions = {}): VisibleMarket[] {
  const out: VisibleMarket[] = [];
  for (const market of ARX_TOP_250) {
    if (market.hidden && !opts.includeHidden) continue;
    if (opts.assetClass && market.assetClass !== opts.assetClass) continue;
    const availability = opts.resolveAvailability
      ? opts.resolveAvailability(market)
      : defaultUnavailable(market);
    out.push({ market, availability });
  }
  return out;
}
