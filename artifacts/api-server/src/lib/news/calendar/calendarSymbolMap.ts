// Pure symbol ⇄ economic-calendar mapping. No network, no execution path.
//
// Maps ARX symbols to the currencies/countries whose macro events move them, and
// reverse-maps a calendar event to the ARX symbols it affects. Synthetic
// instruments (Deriv volatility indices etc.) are macro-news-IMMUNE — they never
// map to a real-world economic event ("macro not applicable").

import type { CalendarEvent, EconomicCalendarImpact } from "./calendarTypes.js";

/** ARX symbol → currencies whose macro events drive it. */
const SYMBOL_CURRENCIES: Record<string, string[]> = {
  // FX majors / crosses
  EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], USDJPY: ["USD", "JPY"],
  AUDUSD: ["AUD", "USD"], USDCAD: ["USD", "CAD"], NZDUSD: ["NZD", "USD"],
  USDCHF: ["USD", "CHF"], EURJPY: ["EUR", "JPY"], GBPJPY: ["GBP", "JPY"],
  EURGBP: ["EUR", "GBP"], AUDJPY: ["AUD", "JPY"],
  // Metals — gold/silver trade on USD macro (real-yield / dollar) primarily.
  XAUUSD: ["USD"], XAGUSD: ["USD"],
  // Indices — US indices key off US (USD) macro; European/Asian off their bloc.
  US30: ["USD"], NAS100: ["USD"], SPX500: ["USD"], US500: ["USD"], US100: ["USD"],
  GER40: ["EUR"], UK100: ["GBP"], JP225: ["JPY"], EU50: ["EUR"],
};

/** ISO currency → Trading Economics country name (for fallback filtering). */
const CURRENCY_COUNTRY: Record<string, string> = {
  USD: "United States",
  EUR: "Euro Area",
  GBP: "United Kingdom",
  JPY: "Japan",
  AUD: "Australia",
  CAD: "Canada",
  NZD: "New Zealand",
  CHF: "Switzerland",
};

const SYNTHETIC_PREFIX_RE =
  /\b(VOLATILITY|CRASH|BOOM|JUMP|STEP|RANGE BREAK|BULL MARKET|BEAR MARKET|DEX|DRIFT SWITCH|MULTI STEP|DAILY RESET)\b/;
const SYNTHETIC_ALIAS_RE = /\b(VOL|V|R_|JD|RB|HZ)\d+/;
// Concatenated Deriv codes ("BOOM1000", "CRASH500", "VOLATILITY75", "JUMP25",
// "STEP200") where the keyword runs straight into the index size with no space —
// the word-boundary forms above would miss these and they MUST be treated as
// synthetic so macro events never leak onto them.
const SYNTHETIC_CONCAT_RE = /\b(VOLATILITY|CRASH|BOOM|JUMP|STEP)\s*\d+/;

/** True when a symbol is a synthetic / non-real-world instrument. */
export function isSyntheticSymbol(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  return (
    SYNTHETIC_PREFIX_RE.test(s) ||
    SYNTHETIC_ALIAS_RE.test(s) ||
    SYNTHETIC_CONCAT_RE.test(s) ||
    /\bR_\d+\b/.test(s)
  );
}

/** True when real-world macro events apply to this symbol at all. */
export function macroApplies(symbol: string): boolean {
  return !isSyntheticSymbol(symbol);
}

/**
 * Currencies whose macro events drive a symbol. Synthetics → []. Unknown
 * non-synthetic equities default to USD (US-listed assumption).
 */
export function currenciesForSymbol(symbol: string): string[] {
  const s = symbol.trim().toUpperCase();
  if (isSyntheticSymbol(s)) return [];
  const mapped = SYMBOL_CURRENCIES[s];
  if (mapped) return mapped;
  // Plain FX pair pattern "ABCDEF" → split into two ISO codes.
  if (/^[A-Z]{6}$/.test(s)) {
    const a = s.slice(0, 3);
    const b = s.slice(3, 6);
    return [a, b];
  }
  // Otherwise treat as a US-listed instrument (equity/index) → USD macro.
  return ["USD"];
}

/** Country names (TE-style) whose events drive a symbol. */
export function countriesForSymbol(symbol: string): string[] {
  const out: string[] = [];
  for (const ccy of currenciesForSymbol(symbol)) {
    const country = CURRENCY_COUNTRY[ccy];
    if (country && !out.includes(country)) out.push(country);
  }
  return out;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

/** True when an event (by currency or country) maps to a given symbol. */
export function eventMatchesSymbol(
  event: Pick<CalendarEvent, "currency" | "country" | "affectedSymbols">,
  symbol: string,
): boolean {
  const s = symbol.trim().toUpperCase();
  if (isSyntheticSymbol(s)) return false;
  if (event.affectedSymbols.some((sym) => norm(sym) === s)) return true;
  const ccys = currenciesForSymbol(s).map(norm);
  if (event.currency && ccys.includes(norm(event.currency))) return true;
  const countries = countriesForSymbol(s).map(norm);
  if (event.country && countries.includes(norm(event.country))) return true;
  return false;
}

/**
 * The ARX symbols a raw event (currency + country) affects. Derived from the
 * static universe above — never fabricated. Used to populate
 * `CalendarEvent.affectedSymbols` at normalization time.
 */
export function affectedSymbolsFor(currency: string, country: string): string[] {
  const out: string[] = [];
  for (const symbol of Object.keys(SYMBOL_CURRENCIES)) {
    if (
      eventMatchesSymbol(
        { currency, country, affectedSymbols: [] },
        symbol,
      )
    ) {
      out.push(symbol);
    }
  }
  return out;
}

/** Short risk note for high/critical events; null for low/medium. */
export function riskNoteFor(impact: EconomicCalendarImpact, currency: string): string | null {
  const ccy = currency ? `${currency} ` : "";
  if (impact === "critical") {
    return `Critical ${ccy}event — expect sharp moves, wider spreads, and slippage around the release.`;
  }
  if (impact === "high") {
    return `High-impact ${ccy}event — elevated volatility likely around the release.`;
  }
  return null;
}

/**
 * Filter a normalized event list to those affecting a symbol. For synthetics
 * the result is always empty (macro not applicable).
 */
export function filterEventsForSymbol(events: CalendarEvent[], symbol: string): CalendarEvent[] {
  if (isSyntheticSymbol(symbol)) return [];
  return events.filter((e) => eventMatchesSymbol(e, symbol));
}
