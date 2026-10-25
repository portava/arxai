// Normalize broker-suffixed symbols to a canonical base used by the scanner.
//
// Examples:
//   EURUSDm     -> EURUSD
//   XAUUSD.r    -> XAUUSD
//   US30.cash   -> US30
//   BTCUSD-pro  -> BTCUSD
//   "  eurusd " -> EURUSD
//
// We only strip well-known broker suffixes/decorations. Anything unrecognised
// is returned upper-cased and trimmed so a user typing "FOO" still sees a
// clean "FOO not available" envelope rather than a 500.
//
// Support is delegated to the SAME ARX Focus registry the chart/scanner use
// (@workspace/domain/market) so this module can never drift from the rest of
// ARX again; the small legacy list below is kept only for symbols (stocks,
// USDT-quoted crypto) that predate the registry.

import { resolveArxMarket, isApprovedArxMarket, ARX_FOCUS_MARKETS } from "@workspace/domain/market";

const SUFFIX_PATTERNS: RegExp[] = [
  /\.(cash|pro|raw|ecn|c|m|r|i|spot|sb)$/i,
  /[._-](cash|pro|raw|ecn|m|i|spot|sb)$/i,
  /(?<=[A-Z]{6})[mciM]$/, // e.g. EURUSDm, EURUSDc
];

const CANONICAL_ALIASES: Record<string, string> = {
  NAS100: "NAS100",
  NASDAQ100: "NAS100",
  US100: "NAS100",
  US30: "US30",
  DJ30: "US30",
  WS30: "US30",
  GOLD: "XAUUSD",
  XAUUSD: "XAUUSD",
  BTC: "BTCUSD",
  BTCUSD: "BTCUSD",
  BTCUSDT: "BTCUSDT",
  ETHUSD: "ETHUSD",
  ETHUSDT: "ETHUSDT",
};

export function normalizeSymbol(raw: string): string {
  let s = String(raw ?? "").trim().toUpperCase();
  if (!s) return "";
  for (const rx of SUFFIX_PATTERNS) {
    s = s.replace(rx, "");
  }
  s = s.replace(/[^A-Z0-9]/g, "");
  const legacy = CANONICAL_ALIASES[s] ?? s;
  // Legacy canonical mappings win when they hit the legacy list (preserves the
  // existing BTCUSDT/NAS100-style canonicals). Otherwise, resolve through the
  // shared ARX Focus registry so synthetics ("V75", "Volatility 75 Index",
  // "R_75", …) normalize to the same canonical the chart pipeline uses.
  if (LEGACY_SYMBOLS.includes(legacy)) return legacy;
  const arx = resolveArxMarket(raw) ?? resolveArxMarket(legacy);
  if (arx) return arx.canonicalSymbol;
  return legacy;
}

// Legacy whitelist retained for symbols that predate the ARX Focus registry
// (stocks, USDT-quoted crypto). Everything in the registry is supported too.
const LEGACY_SYMBOLS: readonly string[] = [
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "NZDUSD", "USDCHF",
  "XAUUSD", "XAGUSD",
  "BTCUSDT", "ETHUSDT", "BTCUSD", "ETHUSD",
  "AAPL", "TSLA", "MSFT", "NVDA",
  "US30", "NAS100", "SPX500",
];

/** Supported = the shared ARX Focus registry (source of truth) OR the small
 *  legacy list above. The registry side means the Selected Market panel
 *  supports exactly what the chart/scanner support — including synthetics. */
export function isSupported(canonical: string): boolean {
  return LEGACY_SYMBOLS.includes(canonical) || isApprovedArxMarket(canonical);
}

/** Kept for compatibility with existing imports/tests. */
export const SUPPORTED_SYMBOLS: readonly string[] = LEGACY_SYMBOLS;

/** Full advertised support list: ARX Focus registry canonicals + the legacy
 *  extras. This is what discovery endpoints should return so the advertised
 *  list matches what isSupported() actually accepts. */
export const ALL_SUPPORTED_SYMBOLS: readonly string[] = Array.from(
  new Set([...ARX_FOCUS_MARKETS.map((mkt) => mkt.canonicalSymbol), ...LEGACY_SYMBOLS]),
);
