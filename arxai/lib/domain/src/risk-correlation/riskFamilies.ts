// ── Risk families: conservative STATIC groupings (R3 slice 6, spec check 20) ─
//
// Pure, deterministic mapping from an instrument to a risk family. This is the
// first (static) stage of the correlation/concentration guard: audit-risk.md
// check 20 is a GAP — "a user can stack EURUSD+GBPUSD+DXY-correlated positions
// to the per-symbol cap on each with zero cross-symbol constraint". Families
// here are deliberately coarse; a dynamic correlation matrix is a later slice.
//
// Constraints this module enforces:
//   - No IO, no clock, no imports outside this package. The family data is
//     DERIVED from lib/markets (types.ts + universe.ts) but not imported:
//     lib/domain/package.json carries no @workspace/markets dependency and
//     shared package.json files are frozen this wave. The exhaustive test in
//     scripts/src/riskCorrelationTest.ts pins this file against the live
//     universe, so drift is caught in CI rather than hidden here.
//   - Unknown correlation must NOT create capacity (spec check 20): a symbol
//     that cannot be classified resolves to its OWN single-symbol family
//     ("unknown:<SYMBOL>"), never to a shared pool. Pooling strangers into one
//     "unknown" family would assert they correlate with each other and not
//     with anything else — two claims this module cannot honestly make.
//   - An unrecognized asset-class label is ignored (falls through to symbol
//     inference, then the unknown fallback). A family is never fabricated
//     from an unvetted class string.

/** Mirrors ArxAssetClass in lib/markets/src/types.ts (no runtime dependency
 *  allowed from this package; see module header). */
export type RiskAssetClass =
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

export type RiskFamilySource = "asset_class" | "symbol_pattern" | "unknown_fallback";

export interface RiskFamilyResolution {
  /** Stable family key, e.g. "fx:usd-bloc", "synthetic:volatility",
   *  "unknown:XYZ123". */
  family: string;
  source: RiskFamilySource;
  /** True only for the per-symbol unknown fallback. */
  isUnknown: boolean;
}

/** Prefix of every per-symbol unknown fallback family. */
export const UNKNOWN_FAMILY_PREFIX = "unknown:";

export function isUnknownFamily(family: string): boolean {
  return family.startsWith(UNKNOWN_FAMILY_PREFIX);
}

// Fiat currency codes present in the approved universe (majors + crosses +
// exotics). Used only to recognise a 6-letter symbol as an FX pair.
const FIAT_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD",
  "TRY", "ZAR", "SEK", "NOK", "MXN", "PLN", "HUF", "CNH",
  "HKD", "SGD", "THB", "ILS", "CLP", "INR", "KRW",
]);

// Crypto base assets in the approved universe (crypto ranks 191–220).
const CRYPTO_BASES = new Set([
  "BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "DOGE", "AVAX", "LINK", "DOT",
  "LTC", "BCH", "XLM", "TRX", "MATIC", "NEAR", "ATOM", "UNI", "AAVE", "FIL",
  "ICP", "ETC", "ARB", "OP", "SUI", "APT", "INJ", "RNDR", "FET", "PEPE",
]);

// Index / energy / commodity standard symbols in the approved universe.
// Class-less inference only; the assetClass path does not consult these.
const INDEX_SYMBOLS = new Set([
  "US30", "US100", "US500", "US2000", "GER40", "UK100", "FRA40", "EU50",
  "JPN225", "AUS200", "HK50", "CHINA50", "SPA35", "ITA40", "SWI20", "NETH25",
  "SG30", "INDIA50",
]);
const ENERGY_SYMBOLS = new Set([
  "USOIL", "UKOIL", "BRENT", "WTI", "NATGAS", "GASOLINE", "HEATINGOIL",
]);
const COMMODITY_SYMBOLS = new Set([
  "COPPER", "COCOA", "COFFEE", "SUGAR", "WHEAT", "CORN",
]);

// Deriv synthetic families. Patterns cover the universe's standard symbols
// (full display names, e.g. "Volatility 75 Index") plus the provider codes
// (R_75, 1HZ75V, BOOM500N, CRASH1000N, JD50, stpRNG). "range" is defined for
// Deriv Range Break instruments even though none are in the Top 250 today.
const SYNTHETIC_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^volatility\s/i, "synthetic:volatility"],
  [/^(r_\d+|1hz\d+v)$/i, "synthetic:volatility"],
  [/^boom\s/i, "synthetic:boom-crash"],
  [/^crash\s/i, "synthetic:boom-crash"],
  [/^(boom|crash)\d+n?$/i, "synthetic:boom-crash"],
  [/^jump\s/i, "synthetic:jump"],
  [/^jd\d+$/i, "synthetic:jump"],
  [/^step(\s|$)/i, "synthetic:step"],
  [/^stprng$/i, "synthetic:step"],
  [/^range\s?break/i, "synthetic:range"],
];

const VALID_ASSET_CLASSES = new Set<string>([
  "forex_major", "forex_cross", "forex_exotic", "metal", "energy", "index",
  "stock", "etf", "crypto", "synthetic", "commodity",
]);

function normalizeSymbol(symbol: string): string {
  return symbol.trim().replace(/\s+/g, " ").toUpperCase();
}

function unknownFamily(normalized: string): RiskFamilyResolution {
  // One family PER SYMBOL: strangers must not pool (spec check 20 — unknown
  // correlation must not create capacity).
  return {
    family: `${UNKNOWN_FAMILY_PREFIX}${normalized}`,
    source: "unknown_fallback",
    isUnknown: true,
  };
}

// FX bloc assignment. Membership precedence USD → EUR → JPY-crosses, then a
// per-base-currency bloc for pairs touching none of the three. USD is checked
// first so all USD pairs (the seven majors included) share one bloc — the
// audit's failure scenario is exactly EURUSD+GBPUSD stacking with no
// cross-symbol constraint, so those two MUST land in the same family.
// "fx:jpy-crosses" therefore holds only the non-USD non-EUR yen crosses.
function fxFamily(normalized: string): string | null {
  if (!/^[A-Z]{6}$/.test(normalized)) return null;
  const base = normalized.slice(0, 3);
  const quote = normalized.slice(3);
  if (!FIAT_CODES.has(base) || !FIAT_CODES.has(quote)) return null;
  if (base === "USD" || quote === "USD") return "fx:usd-bloc";
  if (base === "EUR" || quote === "EUR") return "fx:eur-bloc";
  if (base === "JPY" || quote === "JPY") return "fx:jpy-crosses";
  return `fx:${base.toLowerCase()}-bloc`;
}

function syntheticFamily(raw: string): string | null {
  const trimmed = raw.trim();
  for (const [pattern, family] of SYNTHETIC_PATTERNS) {
    if (pattern.test(trimmed)) return family;
  }
  return null;
}

function metalFamily(normalized: string): string | null {
  return /^X(AU|AG|PT|PD)[A-Z]{3}$/.test(normalized) ? "metals" : null;
}

function cryptoFamily(normalized: string): string | null {
  const m = /^([A-Z]{2,6})(USDT|USD)$/.exec(normalized);
  if (m && m[1] !== undefined && CRYPTO_BASES.has(m[1])) return "crypto";
  return null;
}

// Class-less inference. Order matters only for auditability — the recognizer
// sets are mutually exclusive over the approved universe (pinned by test).
function inferFamilyFromSymbol(normalized: string): string | null {
  return (
    syntheticFamily(normalized) ??
    metalFamily(normalized) ??
    cryptoFamily(normalized) ??
    fxFamily(normalized) ??
    (INDEX_SYMBOLS.has(normalized) ? "indices" : null) ??
    (ENERGY_SYMBOLS.has(normalized) ? "energy" : null) ??
    (COMMODITY_SYMBOLS.has(normalized) ? "commodities" : null)
  );
}

/**
 * Resolve the static risk family for one instrument.
 *
 * `assetClass` (when it is a recognised ArxAssetClass value) is authoritative
 * for the non-FX, non-synthetic classes. FX and synthetic classes still parse
 * the symbol for the sub-family split; a symbol that fails that parse falls to
 * the per-symbol unknown family rather than a pooled class-wide family.
 *
 * Single stocks and ETFs are NOT inferable from a bare symbol (any short
 * ticker could be anything) — without an assetClass they resolve to the
 * unknown fallback by design.
 */
export function resolveRiskFamily(
  symbol: string,
  assetClass?: string,
): RiskFamilyResolution {
  const normalized = normalizeSymbol(symbol ?? "");
  if (normalized.length === 0) return unknownFamily(normalized);

  const cls =
    assetClass !== undefined && VALID_ASSET_CLASSES.has(assetClass)
      ? (assetClass as RiskAssetClass)
      : null;

  if (cls !== null) {
    switch (cls) {
      case "forex_major":
      case "forex_cross":
      case "forex_exotic": {
        const family = fxFamily(normalized);
        return family !== null
          ? { family, source: "asset_class", isUnknown: false }
          : unknownFamily(normalized);
      }
      case "synthetic": {
        const family = syntheticFamily(symbol);
        return family !== null
          ? { family, source: "asset_class", isUnknown: false }
          : unknownFamily(normalized);
      }
      case "metal":
        return { family: "metals", source: "asset_class", isUnknown: false };
      case "energy":
        return { family: "energy", source: "asset_class", isUnknown: false };
      case "index":
        return { family: "indices", source: "asset_class", isUnknown: false };
      case "stock":
        return { family: "stocks", source: "asset_class", isUnknown: false };
      case "etf":
        return { family: "etf", source: "asset_class", isUnknown: false };
      case "crypto":
        return { family: "crypto", source: "asset_class", isUnknown: false };
      case "commodity":
        return { family: "commodities", source: "asset_class", isUnknown: false };
    }
  }

  const inferred = inferFamilyFromSymbol(normalized);
  if (inferred !== null) {
    return { family: inferred, source: "symbol_pattern", isUnknown: false };
  }
  return unknownFamily(normalized);
}
