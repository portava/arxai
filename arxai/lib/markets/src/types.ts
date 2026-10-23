// Canonical ARX Top 250 market universe — shared types.
//
// This module is the SINGLE SOURCE OF TRUTH for which markets a regular
// user may see, search, scan, chart, or trade. It is NEVER derived from
// broker/provider output. Provider/broker discovery is only ever
// intersected against this approved list (`providerSymbols ∩ approvedTop250`).
//
// This file holds pure types only — no runtime data, no side effects.

/** Asset-class buckets for the approved universe. */
export type ArxAssetClass =
  | "forex_major"
  | "forex_cross"
  | "forex_exotic"
  | "metal"
  | "energy"
  | "index"
  | "stock"
  | "etf"
  | "crypto"
  | "synthetic"
  | "commodity";

/** A single approved market in the Top 250 directory. */
export interface ArxMarket {
  /** Stable internal id (slug of the standard symbol). */
  id: string;
  /** Canonical ARX symbol exactly as in the approved list. Synthetics use
   *  their full Deriv display name (e.g. "Volatility 75 Index"). */
  standardSymbol: string;
  /** User-safe display name. Never a raw broker string. */
  displayName: string;
  assetClass: ArxAssetClass;
  /** Always true — every entry in this directory is approved. */
  approved: true;
  /** The rank number shown to users (1–250). */
  rank: number;
  /** Lowercase free-text nicknames / spoken forms (e.g. "gold", "nasdaq"). */
  aliases: string[];
  /** Known broker-name variants (e.g. "Volatility 75 (1s) Index"). */
  brokerAliases: string[];
  /** Provider-specific strings to intersect discovery against
   *  (e.g. "EUR/USD", "R_75", "BTCUSDT"). */
  providerSymbols: string[];
  /** Approved but intentionally never shown to regular users. */
  hidden: boolean;
}

/** Honest, user-safe data status for an approved market. */
export type MarketDataStatus =
  | "live"
  | "delayed"
  | "stale"
  | "no_data"
  | "simulator_only"
  | "provider_missing"
  | "broker_mapping_missing";

/** Result of composing the existing truth machinery for one market. */
export interface MarketAvailability {
  approved: boolean;
  visible: boolean;
  /** True only when REAL provider data exists (live/delayed/stale). Never
   *  true for no_data / simulator_only / provider_missing /
   *  broker_mapping_missing. */
  selectable: boolean;
  /** True only when ALL existing trade gates pass (resolved upstream). */
  tradeable: boolean;
  /** User-safe reason when not selectable/tradeable, else null. */
  disabledReason: string | null;
  dataStatus: MarketDataStatus;
  sourcesAvailable: boolean;
  brokerMapped: boolean;
  feedFresh: boolean;
  aiUsable: boolean;
}

/** How a user-typed/spoken market input was resolved. */
export type MarketResolveStatus = "resolved" | "ambiguous" | "not_in_universe";

export type MarketMatchSource =
  | "standard"
  | "display"
  | "alias"
  | "broker"
  | "provider"
  | "synthetic"
  | null;

/** Outcome of resolving a free-text market input against the Top 250. */
export interface MarketResolveResult {
  status: MarketResolveStatus;
  /** Set only when status === "resolved". */
  market: ArxMarket | null;
  /** Set when status === "ambiguous" (the Top-250 candidates to clarify). */
  candidates: ArxMarket[];
  matchSource: MarketMatchSource;
}

/** A user-visible market row (approved + availability), used by the choke
 *  point so disabled markets are surfaced (not silently removed). */
export interface VisibleMarket {
  market: ArxMarket;
  availability: MarketAvailability;
}
