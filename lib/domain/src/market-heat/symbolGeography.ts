// ── Symbol → Geography mapping (Task #611) ──────────────────────────────────
//
// PURE, deterministic mapping from an approved ARX symbol to the countries /
// currencies / macro scope it is exposed to. Used by the Market Heat map to
// attribute a country/currency verdict to its affected symbols, and to keep
// Deriv synthetics OUT of the country map (they are immune to real-world macro
// events — they live only under the Synthetic Markets panel).
//
// HONESTY: this is metadata only. It never gates, slows, or places a trade. It
// only answers "which countries/currencies does this market depend on?".
//
// Resolution is anchored to the single source of truth, the ARX Focus registry
// (`resolveArxMarket`): a symbol that is not approved returns null here too.

import { resolveArxMarket, type ArxMarketCategory } from "../market/index.js";

/** Macro scope of a symbol. `synthetic` is explicitly NOT a country. */
export type GeoScope = "fx" | "metal" | "index" | "crypto" | "synthetic";

export interface SymbolGeography {
  /** Canonical ARX symbol (e.g. "EURUSD", "XAUUSD", "V75"). */
  symbol: string;
  displayName: string;
  category: ArxMarketCategory;
  scope: GeoScope;
  /** True for Deriv synthetics — these never map to a country. */
  isSynthetic: boolean;
  /** ISO-4217 currency codes whose news/strength move this symbol. */
  currencies: string[];
  /** Country / region keys whose macro events move this symbol. Empty for
   *  synthetics and pure global/crypto instruments. */
  countries: string[];
  /** Commodity keys (e.g. "gold", "silver") — empty for non-metals. */
  commodities: string[];
  /** True when the symbol tracks global risk sentiment (gold, crypto, indices)
   *  rather than a single country. */
  global: boolean;
}

/** ISO-4217 currency → primary country/region key. */
const CURRENCY_COUNTRY: Record<string, string> = {
  USD: "US",
  EUR: "Eurozone",
  JPY: "Japan",
  GBP: "UK",
  CHF: "Switzerland",
  CAD: "Canada",
  AUD: "Australia",
  NZD: "New Zealand",
  CNY: "China",
};

/** Human-readable country/region display labels. */
export const COUNTRY_DISPLAY: Record<string, string> = {
  US: "United States",
  Eurozone: "Eurozone",
  Japan: "Japan",
  UK: "United Kingdom",
  Switzerland: "Switzerland",
  Canada: "Canada",
  Australia: "Australia",
  "New Zealand": "New Zealand",
  China: "China",
  Germany: "Germany",
  Global: "Global",
};

/** Currency display labels (used by the currency heat tiles). */
export const CURRENCY_DISPLAY: Record<string, string> = {
  USD: "US Dollar",
  EUR: "Euro",
  JPY: "Japanese Yen",
  GBP: "British Pound",
  CHF: "Swiss Franc",
  CAD: "Canadian Dollar",
  AUD: "Australian Dollar",
  NZD: "New Zealand Dollar",
  CNY: "Chinese Yuan",
};

/** Split a 6-char forex canonical (e.g. "EURUSD") into [base, quote]. */
function splitForexPair(canonical: string): [string, string] | null {
  const c = canonical.toUpperCase();
  if (c.length !== 6) return null;
  return [c.slice(0, 3), c.slice(3, 6)];
}

function countriesForCurrencies(currencies: string[]): string[] {
  const out: string[] = [];
  for (const ccy of currencies) {
    const country = CURRENCY_COUNTRY[ccy];
    if (country && !out.includes(country)) out.push(country);
  }
  return out;
}

/**
 * Resolve a free-text / canonical / broker symbol to its geography, or null
 * when it is outside the approved ARX market universe.
 */
export function getSymbolGeography(input: string): SymbolGeography | null {
  const market = resolveArxMarket(input);
  if (!market) return null;

  const canonical = market.canonicalSymbol;
  const base = {
    symbol: canonical,
    displayName: market.displayName,
    category: market.category,
  };

  switch (market.category) {
    case "synthetic":
      // Synthetics are immune to real-world macro events — never a country.
      return {
        ...base,
        scope: "synthetic",
        isSynthetic: true,
        currencies: [],
        countries: [],
        commodities: [],
        global: false,
      };

    case "forex_major":
    case "forex_minor": {
      const pair = splitForexPair(canonical);
      const currencies = pair ? [pair[0], pair[1]] : [];
      return {
        ...base,
        scope: "fx",
        isSynthetic: false,
        currencies,
        countries: countriesForCurrencies(currencies),
        commodities: [],
        global: false,
      };
    }

    case "metal": {
      // Gold / silver are priced in USD and trade as a global risk/inflation
      // hedge: USD news + global sentiment, never a single non-US country.
      const commodity = canonical.startsWith("XAU") ? "gold" : "silver";
      return {
        ...base,
        scope: "metal",
        isSynthetic: false,
        currencies: ["USD"],
        countries: ["US", "Global"],
        commodities: [commodity],
        global: true,
      };
    }

    case "index": {
      // Equity indices: GER30 is Eurozone/Germany; the rest are US-centric.
      if (canonical === "GER30") {
        return {
          ...base,
          scope: "index",
          isSynthetic: false,
          currencies: ["EUR"],
          countries: ["Germany", "Eurozone"],
          commodities: [],
          global: false,
        };
      }
      // DXY, SPX500, US30 (and other US indices) → US + USD.
      return {
        ...base,
        scope: "index",
        isSynthetic: false,
        currencies: ["USD"],
        countries: ["US"],
        commodities: [],
        global: false,
      };
    }

    case "crypto":
      // Crypto is a global, USD-quoted risk asset — not a country.
      return {
        ...base,
        scope: "crypto",
        isSynthetic: false,
        currencies: ["USD"],
        countries: ["Global"],
        commodities: [],
        global: true,
      };

    default:
      return null;
  }
}

/** Display label for a country/region key (falls back to the raw key). */
export function countryDisplayName(key: string): string {
  return COUNTRY_DISPLAY[key] ?? key;
}

/** Display label for a currency code (falls back to the raw code). */
export function currencyDisplayName(code: string): string {
  return CURRENCY_DISPLAY[code] ?? code;
}

/** Trading-session → currency codes whose markets are most active then. Used
 *  ONLY as a view filter over the heat universe — never a data claim. */
export const SESSION_CURRENCIES: Record<string, string[]> = {
  sydney: ["AUD", "NZD"],
  tokyo: ["JPY", "CNY"],
  london: ["EUR", "GBP", "CHF"],
  newyork: ["USD", "CAD"],
};

export type TradingSession = keyof typeof SESSION_CURRENCIES;

/**
 * True when a symbol belongs in the given trading session's view. Synthetics
 * (24/7) are always in-session. An unrecognised session name does not filter
 * (returns true) — this is a presentation filter, never a safety gate.
 */
export function marketMatchesSession(geo: SymbolGeography, session: string): boolean {
  if (geo.isSynthetic) return true;
  const wanted = SESSION_CURRENCIES[session.toLowerCase()];
  if (!wanted) return true;
  return geo.currencies.some((c) => wanted.includes(c));
}
