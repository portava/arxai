// Strict ISO-4217 forex-pair classification — the PURE half extracted from
// contractSize.ts so unit-only consumers (pip math, spec resolution) can
// import it without touching @workspace/db at module init. contractSize.ts
// re-exports everything here, so the single-definition guarantee its header
// promises still holds: this file is the one definition, and the two cannot
// drift because one re-exports the other.
//
// WHY THE STRICT CLASSIFIER (unchanged from contractSize.ts)
//
// A loose `/^[A-Z]{6}$/` test calls XAUUSD, XAGUSD and BTCUSD "forex" and
// applies FX conventions to them — mis-sizing gold by 1,000× and silver by
// 20×. BOTH halves of the symbol must be real ISO-4217 fiat codes before any
// FX convention may be assumed.

/**
 * ISO-4217 fiat codes ARX trades or quotes against. Deliberately a fixed
 * allowlist: metals (XAU/XAG/XPT/XPD), crypto (BTC/ETH/…) and index tickers
 * must NOT be in here, or they inherit FX conventions.
 */
export const FIAT_CODES: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "SEK", "NOK", "DKK",
  "SGD", "HKD", "ZAR", "MXN", "PLN", "TRY", "CZK", "HUF", "CNH", "CNY", "RUB",
  "INR", "THB", "ILS", "KRW",
]);

/** The standard FX lot: 100,000 units of the base currency. */
export const FX_STANDARD_LOT_UNITS = 100_000;

/**
 * Split a symbol into ISO-4217 base/quote, tolerating a broker suffix
 * (`EURUSD.raw`, `EURUSD_i`, `EURUSD-ECN`). Returns null unless BOTH halves are
 * real fiat codes — so XAUUSD, BTCUSD and US30 all return null.
 */
export function splitForexPair(symbol: string): { base: string; quote: string } | null {
  const m = /^([A-Z]{3})([A-Z]{3})([._-][A-Z0-9]+)?$/.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  const base = m[1]!;
  const quote = m[2]!;
  if (!FIAT_CODES.has(base) || !FIAT_CODES.has(quote)) return null;
  return { base, quote };
}

/** Strict forex classifier: BOTH halves must be ISO-4217 fiat currency codes. */
export function isForexPair(symbol: string): boolean {
  return splitForexPair(symbol) != null;
}
