// AI chat audit 2026-11-04 (A4). The instant-trade command route used the last
// 1-minute candle close as "current price" with no freshness or provenance
// check, so a stale feed could pick the wrong trigger direction (and, if the
// evaluator ever runs, fire a conditional order on a dead price). This helper
// turns a routed quote into a price only when the quote is a producer-observed
// tick that is recent enough; otherwise it returns null with the reason.

export const BOUND_QUOTE_MAX_AGE_MS = 15_000;
// Tolerate small forward skew between the producer clock and this server.
export const BOUND_QUOTE_FUTURE_SKEW_MS = 5_000;

export interface QuoteLike {
  bid?: number;
  ask?: number;
  last?: number;
  timestamp: string;
}

export interface BoundQuoteInput {
  ok: boolean;
  quote: QuoteLike | null;
  tickTimeObserved?: boolean;
  primaryProvider?: string | null;
}

export type BoundQuoteReason =
  | "NO_QUOTE"
  | "TICK_TIME_NOT_OBSERVED"
  | "BAD_TIMESTAMP"
  | "STALE"
  | "FUTURE"
  | "NO_PRICE";

export interface BoundQuote {
  price: number | null;
  ageMs: number | null;
  provider: string | null;
  reason: BoundQuoteReason | null;
}

export function boundQuotePrice(input: BoundQuoteInput, nowMs: number = Date.now(), maxAgeMs: number = BOUND_QUOTE_MAX_AGE_MS): BoundQuote {
  const provider = input.primaryProvider ?? null;
  if (!input.ok || !input.quote) return { price: null, ageMs: null, provider, reason: "NO_QUOTE" };
  if (input.tickTimeObserved !== true) return { price: null, ageMs: null, provider, reason: "TICK_TIME_NOT_OBSERVED" };
  const ts = Date.parse(input.quote.timestamp);
  if (!Number.isFinite(ts)) return { price: null, ageMs: null, provider, reason: "BAD_TIMESTAMP" };
  const ageMs = nowMs - ts;
  if (ageMs > maxAgeMs) return { price: null, ageMs, provider, reason: "STALE" };
  if (ageMs < -BOUND_QUOTE_FUTURE_SKEW_MS) return { price: null, ageMs, provider, reason: "FUTURE" };
  const { bid, ask, last } = input.quote;
  const finitePos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  let price: number | null = null;
  if (finitePos(bid) && finitePos(ask)) price = (bid + ask) / 2;
  else if (finitePos(last)) price = last;
  else if (finitePos(bid)) price = bid;
  else if (finitePos(ask)) price = ask;
  if (price == null) return { price: null, ageMs, provider, reason: "NO_PRICE" };
  return { price, ageMs, provider, reason: null };
}
