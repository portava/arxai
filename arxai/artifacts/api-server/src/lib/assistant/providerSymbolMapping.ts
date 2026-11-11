import { findMarketByStandardSymbol } from "@workspace/markets";

/** Only the approved currency universe can become an FX request. Six letters
 * alone do not establish a currency pair (or an entitlement at the provider). */
export function approvedFxPair(input: string, metals = false): { base: string; quote: string } | null {
  const symbol = input.trim().toUpperCase();
  const market = findMarketByStandardSymbol(symbol);
  const isForex = market?.assetClass.startsWith("forex_") === true;
  if (!/^[A-Z]{6}$/.test(symbol) || !(isForex || metals && ["XAUUSD", "XAGUSD"].includes(symbol))) return null;
  return { base: symbol.slice(0, 3), quote: symbol.slice(3) };
}

/** Preserve legacy stock lookup, but never send a known non-stock instrument
 * (including the legacy DXY focus-market symbol) to a stock endpoint. */
export function stockStyleSymbol(input: string): string | null {
  const symbol = input.trim().toUpperCase();
  const market = findMarketByStandardSymbol(symbol);
  if (symbol === "DXY" || market && !["stock", "etf"].includes(market.assetClass)) return null;
  return /^[A-Z.]{1,8}$/.test(symbol) ? symbol : null;
}
