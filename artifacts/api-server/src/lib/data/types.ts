// Type-only import: erased at compile time, so the runtime dependency graph of
// this wire-type module is unchanged and lib/provenance stays import-free.
import type { ProvenanceSource } from "../provenance/index.js";

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Venue family that produced a served series/quote. */
export type SeriesProvenanceBrokerCode = "mt5" | "deriv" | "third_party";

/** Account environment the data was produced under, when knowable. */
export type SeriesProvenanceEnvironment = "live" | "demo" | "unknown";

/**
 * Series-level provenance envelope (audit-marketdata S1; spec §10.1 at the
 * granularity the router actually serves — one envelope per served result,
 * per-bar receipt provenance stays on `broker_candles` rows).
 *
 * Constraints that must hold:
 *   - ADDITIVE ONLY: the bare `Candle` wire shape is unchanged; consumers that
 *     ignore this envelope are unaffected.
 *   - `source` reuses lib/provenance's `ProvenanceSource` taxonomy so that
 *     lib/provenance `isTradeable` applies to this envelope unchanged — no
 *     parallel origin taxonomy may be invented.
 *   - Unknown facts MUST be `null` / `"unknown"` — never guessed (honesty
 *     doctrine: refuse/empty-with-reason, never fabricate).
 */
export interface SeriesProvenance {
  /** Router provider id that served the result: "mt5_broker" | "deriv" | "assistant_real". */
  providerId: string;
  /**
   * Winning sub-source within a composite provider (e.g. "twelve_data"), or
   * the serving channel when one provider has several (mt5_broker's
   * "durable_mirror" restart-surviving store vs its live in-memory push).
   * `null` = the provider id alone is the full identity.
   */
  subProviderId: string | null;
  /** Venue family, for gates that must bind decision data to the executing venue. */
  brokerCode: SeriesProvenanceBrokerCode;
  /**
   * Bridge/connection that produced the bars. `null` = the serving layer
   * cannot attribute one: the in-memory mt5 store and the market_candles
   * mirror are keyed symbol|timeframe only today (bridge-scoped serving is a
   * later slice; the durable `broker_candles` system of record already carries
   * the dimension).
   */
  bridgeConnectionId: number | null;
  /** Owner of the producing connection when known; `null` otherwise. */
  userId: number | null;
  /** Exact case-sensitive broker-native symbol when known; `null` otherwise. */
  brokerSymbol: string | null;
  environment: SeriesProvenanceEnvironment;
  /** ISO-8601 instant the router assembled this served result (serve time). */
  receivedAt: string;
  /**
   * Entitlement delay flag: true = known delayed, false = known realtime,
   * `null` = entitlement unknown (no per-connection entitlement record exists
   * yet — spec §10.3).
   */
  delayed: boolean | null;
  /**
   * lib/provenance origin taxonomy. Candle series are "DERIVED" (bars are
   * aggregated from ticks — trustworthy exactly as far as their inputs);
   * point quotes are "LIVE_TICK".
   */
  source: ProvenanceSource;
  /** Stable producing-feed identifier (aligns with `Provenanced.sourceId`),
   *  e.g. "mt5_broker:EURUSD:M5". */
  sourceId: string;
}

export interface MarketQuote {
  symbol: string;
  bid?: number;
  ask?: number;
  spread?: number;
  last?: number;
  timestamp: string;
}

export interface DataProvider {
  name: string;
  getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]>;
  getQuote(symbol: string): Promise<MarketQuote>;
  isConnected(): Promise<boolean>;
}

export type MarketType = "forex" | "index" | "stock" | "synthetic";

export const SUPPORTED_SYMBOLS: { symbol: string; marketType: MarketType }[] = [
  { symbol: "EURUSD", marketType: "forex" },
  { symbol: "GBPUSD", marketType: "forex" },
  { symbol: "USDJPY", marketType: "forex" },
  { symbol: "AUDUSD", marketType: "forex" },
  { symbol: "USDCAD", marketType: "forex" },
  { symbol: "EURJPY", marketType: "forex" },
  { symbol: "GBPJPY", marketType: "forex" },
  { symbol: "US30", marketType: "index" },
  { symbol: "NAS100", marketType: "index" },
  { symbol: "SPX500", marketType: "index" },
  { symbol: "AAPL", marketType: "stock" },
  { symbol: "TSLA", marketType: "stock" },
  { symbol: "MSFT", marketType: "stock" },
  { symbol: "Volatility 75 Index", marketType: "synthetic" },
  { symbol: "Volatility 75 1s Index", marketType: "synthetic" },
  { symbol: "Volatility 25 1s Index", marketType: "synthetic" },
];

export function getMarketType(symbol: string): MarketType {
  const found = SUPPORTED_SYMBOLS.find((s) => s.symbol === symbol);
  return found?.marketType ?? "synthetic";
}
