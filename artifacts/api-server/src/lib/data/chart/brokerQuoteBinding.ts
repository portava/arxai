// Broker quote ↔ chart series binding.
//
// The chart Truth broker comparison (SymbolMirrorAccuracy / handshake
// BrokerPriceAlignment) compares the chart's latest closed close with a broker
// bid/ask. Numbers alone do not prove that the quote came from the same
// account/bridge that produced the series, or that it is current. This module
// decides — from OBSERVED facts only — whether a supplied quote is bound to the
// served chart series:
//
//   BOUND      provider, bridge and owner are observed on both sides and equal,
//              the owner is the requesting user, no observed environment /
//              broker-symbol contradiction exists, and the quote carries an
//              observed tick time within the shared quote freshness budget.
//   MISMATCH   an observed identity contradiction (different provider, bridge,
//              owner, environment or native symbol, or another user's account).
//   STALE      identity binds but the observed tick time is too old or future.
//   UNVERIFIED a required fact is unknown (unattributed series/quote, no
//              observed tick time, no quote, unknown requester).
//
// Unknown never binds and is never repaired: no attribution, price, spread or
// timestamp is synthesized here. Read-only; never touches an execution path.

import type { SeriesProvenance } from "../types.js";
import { QUOTE_FRESH_TTL_MS } from "../freshness.js";

/** Observed identity of the series that produced the chart candles. */
export interface ChartSeriesAttribution {
  providerId: string;
  subProviderId: string | null;
  bridgeConnectionId: number | null;
  userId: number | null;
  environment: SeriesProvenance["environment"];
  brokerSymbol: string | null;
}

export type BrokerQuoteSource = "mt5_live_quote" | "mt5_symbol_snapshot";

/** A broker quote as its producer observed it. Unknown facts are null. */
export interface BrokerQuoteObservation {
  source: BrokerQuoteSource;
  providerId: string | null;
  bridgeConnectionId: number | null;
  userId: number | null;
  environment: SeriesProvenance["environment"] | null;
  brokerSymbol: string | null;
  /** Producer-observed tick time (ISO); null when only a receive time exists. */
  tickAt: string | null;
  bid: number | null;
  ask: number | null;
  spreadPoints: number | null;
}

export type BrokerQuoteBindingStatus = "BOUND" | "MISMATCH" | "STALE" | "UNVERIFIED";

export type BrokerQuoteBindingReason =
  | "QUOTE_ABSENT"
  | "REQUESTER_UNKNOWN"
  | "SERIES_UNATTRIBUTED"
  | "QUOTE_UNATTRIBUTED"
  | "PROVIDER_MISMATCH"
  | "BRIDGE_MISMATCH"
  | "OWNER_MISMATCH"
  | "ACCOUNT_NOT_REQUESTER"
  | "ENVIRONMENT_MISMATCH"
  | "BROKER_SYMBOL_MISMATCH"
  | "QUOTE_TIME_UNKNOWN"
  | "QUOTE_TIME_FUTURE"
  | "QUOTE_STALE";

export interface BrokerQuoteBinding {
  status: BrokerQuoteBindingStatus;
  /** Every failed condition, in evaluation order. Empty only when BOUND. */
  reasons: BrokerQuoteBindingReason[];
  quoteSource: BrokerQuoteSource | null;
  /** The quote's observed tick time; null when unknown. */
  quoteObservedAt: string | null;
  /** now − observed tick time; null when the tick time is unknown. */
  quoteAgeMs: number | null;
  freshnessBudgetMs: number;
}

const MISMATCH_REASONS: ReadonlySet<BrokerQuoteBindingReason> = new Set([
  "PROVIDER_MISMATCH", "BRIDGE_MISMATCH", "OWNER_MISMATCH", "ACCOUNT_NOT_REQUESTER",
  "ENVIRONMENT_MISMATCH", "BROKER_SYMBOL_MISMATCH",
]);
const STALE_REASONS: ReadonlySet<BrokerQuoteBindingReason> = new Set(["QUOTE_TIME_FUTURE", "QUOTE_STALE"]);

const known = <T>(v: T | null | undefined): v is T => v != null && (v as unknown) !== "unknown" && (v as unknown) !== "";

/** Decide whether `quote` is bound to `series` for `requestingUserId` at `now`. */
export function bindBrokerQuote(args: {
  series: ChartSeriesAttribution | null;
  quote: BrokerQuoteObservation | null;
  requestingUserId: number | null;
  now: number;
  freshnessBudgetMs?: number;
}): BrokerQuoteBinding {
  const { series, quote, requestingUserId, now } = args;
  const freshnessBudgetMs = args.freshnessBudgetMs ?? QUOTE_FRESH_TTL_MS;
  const reasons: BrokerQuoteBindingReason[] = [];
  let quoteObservedAt: string | null = null;
  let quoteAgeMs: number | null = null;

  if (!quote) {
    reasons.push("QUOTE_ABSENT");
  } else {
    if (requestingUserId == null) reasons.push("REQUESTER_UNKNOWN");
    if (!series || !known(series.providerId) || series.bridgeConnectionId == null || series.userId == null) {
      reasons.push("SERIES_UNATTRIBUTED");
    }
    if (!known(quote.providerId) || quote.bridgeConnectionId == null || quote.userId == null) {
      reasons.push("QUOTE_UNATTRIBUTED");
    }
    if (series && known(series.providerId) && known(quote.providerId) && series.providerId !== quote.providerId) {
      reasons.push("PROVIDER_MISMATCH");
    }
    if (series?.bridgeConnectionId != null && quote.bridgeConnectionId != null &&
        series.bridgeConnectionId !== quote.bridgeConnectionId) reasons.push("BRIDGE_MISMATCH");
    if (series?.userId != null && quote.userId != null && series.userId !== quote.userId) reasons.push("OWNER_MISMATCH");
    if (requestingUserId != null && quote.userId != null && quote.userId !== requestingUserId) {
      reasons.push("ACCOUNT_NOT_REQUESTER");
    }
    if (series && known(series.environment) && known(quote.environment) && series.environment !== quote.environment) {
      reasons.push("ENVIRONMENT_MISMATCH");
    }
    if (series && known(series.brokerSymbol) && known(quote.brokerSymbol) && series.brokerSymbol !== quote.brokerSymbol) {
      reasons.push("BROKER_SYMBOL_MISMATCH");
    }
    const tickMs = quote.tickAt != null ? Date.parse(quote.tickAt) : NaN;
    if (!Number.isFinite(tickMs) || !Number.isFinite(now)) {
      reasons.push("QUOTE_TIME_UNKNOWN");
    } else {
      quoteObservedAt = new Date(tickMs).toISOString();
      quoteAgeMs = now - tickMs;
      if (quoteAgeMs < 0) reasons.push("QUOTE_TIME_FUTURE");
      else if (quoteAgeMs > freshnessBudgetMs) reasons.push("QUOTE_STALE");
    }
  }

  const status: BrokerQuoteBindingStatus = reasons.length === 0 ? "BOUND"
    : reasons.some((r) => MISMATCH_REASONS.has(r)) ? "MISMATCH"
    : reasons.some((r) => STALE_REASONS.has(r)) ? "STALE"
    : "UNVERIFIED";
  return { status, reasons, quoteSource: quote?.source ?? null, quoteObservedAt, quoteAgeMs, freshnessBudgetMs };
}

/** A binding object built elsewhere (cache, cast) proves nothing unless it is
 *  a well-formed BOUND result with no failed condition. */
export function isBoundBrokerQuote(binding: BrokerQuoteBinding | null | undefined): boolean {
  return binding != null && binding.status === "BOUND" && Array.isArray(binding.reasons) && binding.reasons.length === 0;
}

// ── Series attribution carried beside a chart response (server-internal) ────
// A symbol-keyed, non-enumerable property: JSON responses never include it,
// so the /chart/candles wire shape is unchanged.
const seriesAttributionKey: unique symbol = Symbol("chartSeriesAttribution");

export function seriesAttributionFrom(provenance: SeriesProvenance | null | undefined): ChartSeriesAttribution | null {
  if (!provenance) return null;
  return {
    providerId: provenance.providerId,
    subProviderId: provenance.subProviderId ?? null,
    bridgeConnectionId: provenance.bridgeConnectionId ?? null,
    userId: provenance.userId ?? null,
    environment: provenance.environment ?? "unknown",
    brokerSymbol: provenance.brokerSymbol ?? null,
  };
}

export function attachSeriesAttribution<T extends object>(target: T, attribution: ChartSeriesAttribution | null): T {
  Object.defineProperty(target, seriesAttributionKey, { value: attribution, enumerable: false });
  return target;
}

export function chartSeriesAttribution(target: object | null | undefined): ChartSeriesAttribution | null {
  if (!target) return null;
  return ((target as { [seriesAttributionKey]?: ChartSeriesAttribution | null })[seriesAttributionKey]) ?? null;
}

// ── Observation builders (no synthesis: unknown facts stay null) ─────────────

export function observationFromMt5Quote(read: {
  quote: { bid?: number; ask?: number; timestamp: string };
  bridgeConnectionId: number | null;
  userId: number | null;
  tickTimeObserved: boolean;
} | null): BrokerQuoteObservation | null {
  if (!read) return null;
  return {
    source: "mt5_live_quote",
    providerId: "mt5_broker",
    bridgeConnectionId: read.bridgeConnectionId,
    userId: read.userId,
    // The live push path does not observe account environment or the
    // broker-native symbol.
    environment: null,
    brokerSymbol: null,
    tickAt: read.tickTimeObserved ? read.quote.timestamp : null,
    bid: read.quote.bid ?? null,
    ask: read.quote.ask ?? null,
    // Price-unit spread exists, but points would need a point size: unknown.
    spreadPoints: null,
  };
}

function environmentFromAccountType(accountType: string | null | undefined): SeriesProvenance["environment"] | null {
  const t = (accountType ?? "").trim().toLowerCase();
  if (t === "demo") return "demo";
  if (t === "live" || t === "real") return "live";
  return null;
}

export function observationFromSymbolSpec(row: {
  userId: number;
  bridgeConnectionId: number | null;
  accountType: string | null;
  brokerSymbol: string | null;
  bid: number | null;
  ask: number | null;
  spreadPoints: number | null;
  lastTickTime: Date | string | null;
} | null): BrokerQuoteObservation | null {
  if (!row) return null;
  const tick = row.lastTickTime instanceof Date ? row.lastTickTime.toISOString() : row.lastTickTime ?? null;
  return {
    source: "mt5_symbol_snapshot",
    providerId: "mt5_broker",
    bridgeConnectionId: row.bridgeConnectionId,
    userId: row.userId,
    environment: environmentFromAccountType(row.accountType),
    brokerSymbol: row.brokerSymbol,
    // Only the EA-reported tick time counts; snapshot/report times do not.
    tickAt: tick,
    bid: row.bid,
    ask: row.ask,
    spreadPoints: row.spreadPoints,
  };
}

/** Pick the first candidate that binds; otherwise the first present candidate
 *  (so its observed failure stays visible). */
export function selectBrokerQuote(
  candidates: Array<BrokerQuoteObservation | null>,
  ctx: { series: ChartSeriesAttribution | null; requestingUserId: number | null; now: number },
): { quote: BrokerQuoteObservation | null; binding: BrokerQuoteBinding } {
  let fallback: { quote: BrokerQuoteObservation; binding: BrokerQuoteBinding } | null = null;
  for (const quote of candidates) {
    if (!quote) continue;
    const binding = bindBrokerQuote({ ...ctx, quote });
    if (binding.status === "BOUND") return { quote, binding };
    fallback ??= { quote, binding };
  }
  return fallback ?? { quote: null, binding: bindBrokerQuote({ ...ctx, quote: null }) };
}
