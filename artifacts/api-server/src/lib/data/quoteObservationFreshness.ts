// Quote observation evidence — what a quote's time actually means and whether
// the quote is still current under the shared quote budget.
//
// Every quote ARX hands to a reader (the /data/quote route, Ruby's market
// tools) must say WHEN its price was observed and on WHAT basis, and must read
// stale once it is older than the budget. A quote whose time is unknown, or
// that carries no price, is never "fresh".
//
// Time basis:
//   - producer_tick:   the producer's own tick time (MT5 EA tick, Deriv epoch).
//   - provider_as_of:  the data vendor's own "as of" stamp for the quote.
//   - server_receive:  the time ARX received or assembled it — the market tick
//                      may be older, so this can never confirm "fresh" (capped
//                      at "delayed").
//   - none:            no usable time.
//
// Budgets are the shared ones in ./freshness.ts (QUOTE_FRESH_TTL_MS /
// QUOTE_STALE_AFTER_MS). Pure; describes only — no gate reads it.

import {
  QUOTE_FRESH_TTL_MS,
  QUOTE_STALE_AFTER_MS,
  classifyQuoteFreshness,
} from "./freshness.js";

export type QuoteTimeBasis = "producer_tick" | "provider_as_of" | "server_receive" | "none";

export interface QuoteObservation {
  /** ISO time the price was observed, or null when unknown / no price. */
  observedAt: string | null;
  timeBasis: QuoteTimeBasis;
  /** Age of observedAt at evaluation time; null when unknown. */
  ageMs: number | null;
  /** fresh ≤ freshAfterMs; delayed ≤ staleAfterMs; stale beyond; unknown = no usable time; unavailable = no price. */
  freshness: "fresh" | "delayed" | "stale" | "unknown" | "unavailable";
  /** True for stale, unknown and unavailable — the quote must not read as current. */
  stale: boolean;
  freshAfterMs: number;
  staleAfterMs: number;
  /** One plain-English sentence: what was observed, from which source, as of when — or that it could not be. */
  plainEnglish: string;
}

/** Tolerated clock skew before a future-stamped quote is treated as an unknown time. */
const FUTURE_SKEW_MS = 5_000;

function fmtAge(ms: number): string {
  if (ms < 1_000) return "under a second";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export function quoteObservationFreshness(input: {
  /** Whether a usable price is present at all. */
  hasPrice: boolean;
  /** The quote's own timestamp (ISO string or epoch ms), if any. */
  observedAt: string | number | null | undefined;
  /** What that timestamp means. Ignored when observedAt is missing. */
  basis: Exclude<QuoteTimeBasis, "none">;
  /** Plain-English source name for the sentence (e.g. "MT5 broker feed"). */
  sourceLabel?: string | null;
  nowMs?: number;
}): QuoteObservation {
  const nowMs = input.nowMs ?? Date.now();
  const from = input.sourceLabel ? ` from ${input.sourceLabel}` : "";
  const base = { freshAfterMs: QUOTE_FRESH_TTL_MS, staleAfterMs: QUOTE_STALE_AFTER_MS };
  if (!input.hasPrice) {
    return {
      ...base,
      observedAt: null,
      timeBasis: "none",
      ageMs: null,
      freshness: "unavailable",
      stale: true,
      plainEnglish: `No price was available${from}, so there is no current quote.`,
    };
  }
  const raw = input.observedAt;
  const ms = typeof raw === "number" ? raw : typeof raw === "string" && raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms) || ms - nowMs > FUTURE_SKEW_MS) {
    return {
      ...base,
      observedAt: null,
      timeBasis: "none",
      ageMs: null,
      freshness: "unknown",
      stale: true,
      plainEnglish: `A price${from} was returned, but when it was observed is unknown, so it cannot be treated as current.`,
    };
  }
  const ageMs = Math.max(0, nowMs - ms);
  const verdict = classifyQuoteFreshness(ageMs);
  let freshness: QuoteObservation["freshness"] = verdict.freshness;
  // A receive-time stamp is not the market tick: it cannot confirm "fresh".
  if (input.basis === "server_receive" && freshness === "fresh") freshness = "delayed";
  const observedAt = new Date(ms).toISOString();
  const basisWords =
    input.basis === "producer_tick" ? "tick time"
      : input.basis === "provider_as_of" ? "provider time"
        : "time ARX received it (the market tick may be older)";
  const stale = freshness === "stale";
  const state = stale
    ? `older than the ${fmtAge(QUOTE_STALE_AFTER_MS)} budget, so it is a last-known price, not a current one`
    : freshness === "delayed"
      ? "not confirmed as current"
      : "current";
  return {
    ...base,
    observedAt,
    timeBasis: input.basis,
    ageMs,
    freshness,
    stale,
    plainEnglish: `Price${from} observed ${fmtAge(ageMs)} ago (${basisWords} ${observedAt}) — ${state}.`,
  };
}

// ── GET /api/data/quote response ─────────────────────────────────────────────

type RoutedQuote = {
  ok: boolean;
  quote: { symbol: string; bid?: number; ask?: number; last?: number; spread?: number; timestamp: string } | null;
  primaryProvider: string | null;
  provenance?: { providerId: string } | undefined;
  tickTimeObserved?: boolean;
};

/**
 * The /data/quote body: the router's quote (unchanged legacy fields) plus its
 * observation evidence. When no provider served a quote the body carries NO
 * price, `available: false`, `observedAt: null`, and `timestamp` is the time
 * the check ran (never presented as an observation). Tick time is claimed only
 * when the router says the producer observed it.
 */
export function quoteRouteResponse(symbol: string, r: RoutedQuote | null, nowMs: number = Date.now()) {
  const checkedAt = new Date(nowMs).toISOString();
  const q = r?.ok ? r.quote : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const hasPrice = !!q && (num(q.last) != null || num(q.bid) != null || num(q.ask) != null);
  const source = q ? (r?.provenance?.providerId ?? r?.primaryProvider ?? null) : null;
  const obs = quoteObservationFreshness({
    hasPrice,
    observedAt: q?.timestamp ?? null,
    basis: r?.tickTimeObserved === true ? "producer_tick" : "server_receive",
    sourceLabel: source,
    nowMs,
  });
  const evidence = {
    available: hasPrice,
    source,
    observedAt: obs.observedAt,
    timeBasis: obs.timeBasis,
    ageMs: obs.ageMs,
    freshness: obs.freshness,
    stale: obs.stale,
    staleAfterMs: obs.staleAfterMs,
    checkedAt,
    observationNote: obs.plainEnglish,
  };
  if (!q || !hasPrice) {
    return { symbol, timestamp: checkedAt, ...evidence };
  }
  return { ...q, ...evidence };
}
