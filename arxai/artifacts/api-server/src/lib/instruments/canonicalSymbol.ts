// ARX AI — Canonical symbol resolution (R4 slice 6 — audit-marketdata §4.1/§4.2).
//
// THE single resolver from any user/route/scanner symbol token to a canonical
// identity. Built ON `@workspace/markets` (the approved ARX Top 250 universe,
// `resolveUserMarketInput`) so the data layer finally consults the same
// canonical registry the market-visibility choke point uses, instead of the
// five parallel symbol registries the audit flagged (§4.2: lib/markets
// universe, brain symbolRegistry, lib/data/types.ts SUPPORTED_SYMBOLS, the
// deriv map, the router's private FOREX_PAIRS/METALS/INDICES sets).
//
// Resolution order:
//   1. `resolveUserMarketInput` against the approved Top 250 (exact standard
//      symbol → display name → provider/broker alias → free-text alias →
//      synthetic shorthand; ambiguity is surfaced, never guessed).
//   2. LEGACY-SHAPE fallback: the router's previous regex/set classification,
//      ported VERBATIM from marketDataRouter.classifySymbol so every symbol
//      the old classifier knew keeps its class when the universe does not
//      contain it (e.g. "GER30", "DXY", "XPTUSD"-style tokens are all in the
//      universe or the legacy sets — nothing silently loses its class).
//   3. Anything neither knows → assetClass "unknown". NEVER a silent default:
//      the old `getMarketType` in lib/data/types.ts defaulted unknown symbols
//      to "synthetic" (audit §4.2 item 3 — the mis-defaulting foot-gun); this
//      resolver returns an explicit "unknown", which the router routes to its
//      existing honest no-feed refusal ("This symbol isn't supported by any
//      configured feed…") — never to the Deriv synthetic chain.
//
// Deriv-map coverage note (why this module does NOT import derivProvider):
// every identifier `isDerivSyntheticSymbol` accepts — short codes (V75…),
// Deriv WS ids (R_75, 1HZ75V, BOOM500N, JD10, stpRNG…), display names and
// their compacted forms — is covered by the universe's synthetic
// providerSymbols/display entries or by the legacy synthetic regexes below
// (every Deriv display name contains VOLATILITY/BOOM/CRASH/STEP/JUMP). The
// synthetic classification boundary is therefore preserved exactly without a
// dependency edge into the provider layer; symbolResolution.test.ts locks
// this by classifying every DERIV_SYNTHETIC_SYMBOLS identifier.
//
// Constraints that must hold:
//   - This module depends ONLY on `@workspace/markets` (pure data, no I/O).
//     It must never import marketDataRouter (which imports it) or any
//     provider/db module.
//   - `classifySymbol` behavior is preserved for symbols the legacy
//     classifier knew. Documented, deliberate improvements (all in the
//     truth direction, pinned by tests):
//       · Universe tokens the legacy regexes mis-bucketed now classify by
//         family: "DAX"/"SPX"/"NDX"/"NASDAQ" → indices (were stocks/unknown),
//         "PEPEUSD"/"BNBUSD" → crypto (were unknown), "XAUEUR" → metals (was
//         unknown), "COPPER"/"COFFEE" → stocks (were unknown), "R75" →
//         synthetic (compact form of Deriv id R_75; was unknown).
//       · Free-text aliases resolve ("GOLD" → XAUUSD → metals, "CABLE" →
//         GBPUSD → forex). These were previously mis-bucketed as stocks by
//         the 1–5-letter regex.
//   - Router-facing assetClass buckets for families the router has no lane
//     for (energy, commodity, etf) map to "stocks" — the SAME bucket the
//     legacy 1–5-letter regex put USOIL/COCOA/SPY in, so provider routing
//     for those symbols is unchanged. `family` carries the true class; the
//     coarse bucket can be split once the router grows real lanes.

import {
  resolveUserMarketInput,
  type ArxAssetClass,
  type ArxMarket,
  type MarketMatchSource,
} from "@workspace/markets";

// ── Router-facing asset-class union ─────────────────────────────────────────
// The SINGLE declaration of the coarse asset-class union the market-data
// router keys its provider chains on. marketDataRouter re-exports this as
// `AssetClass` (alias), so every existing `import type { AssetClass } from
// "./marketDataRouter.js"` keeps working unchanged.
export type CanonicalAssetClass =
  | "synthetic" // Deriv volatility / boom / crash / step / jump
  | "forex" // EURUSD, GBPUSD, …
  | "metals" // XAU, XAG, …
  | "indices" // US30, NAS100, SPX500, …
  | "crypto" // BTCUSD/BTCUSDT, …
  | "stocks" // TSLA, AAPL — plus etf/energy/commodity (no router lane yet)
  | "unknown";

/** Universe family → router-facing coarse bucket. Exported so tests (and the
 *  eventual venue-alias tables) can pin the mapping. */
export const ROUTER_CLASS_BY_FAMILY: Record<ArxAssetClass, CanonicalAssetClass> = {
  forex_major: "forex",
  forex_cross: "forex",
  forex_exotic: "forex",
  metal: "metals",
  // No energy/commodity/etf lane exists in the router's CHAIN_BY_CLASS.
  // "stocks" is the bucket the legacy 1–5-letter regex already used for
  // USOIL / COCOA / SPY, so routing behavior is preserved; `family` keeps
  // the honest fine-grained class.
  energy: "stocks",
  index: "indices",
  stock: "stocks",
  etf: "stocks",
  crypto: "crypto",
  synthetic: "synthetic",
  commodity: "stocks",
};

export interface CanonicalSymbolResolution {
  /** Stable canonical key: the universe market id (slug) when resolved;
   *  otherwise the normalized (trim+uppercase) input token so unresolved
   *  symbols still key stores consistently — clearly NOT a universe id. */
  canonicalKey: string;
  /** Router-facing coarse class. "unknown" is an explicit, honest outcome —
   *  never silently defaulted to synthetic (or anything else). */
  assetClass: CanonicalAssetClass;
  /** Fine-grained universe family, or "unknown" when the input did not
   *  resolve into the approved universe. */
  family: ArxAssetClass | "unknown";
  /** Universe standard symbol when resolved; the trimmed input otherwise. */
  displaySymbol: string;
  /** How the universe lookup went. "resolved" iff `market` is non-null. */
  universeStatus: "resolved" | "ambiguous" | "not_in_universe";
  /** Which universe tier matched (standard/display/provider/alias/synthetic),
   *  null when not resolved. */
  matchSource: MarketMatchSource;
  /** The resolved approved market, or null. */
  market: ArxMarket | null;
}

// ── Legacy-shape fallback classification ────────────────────────────────────
// Ported VERBATIM from marketDataRouter.classifySymbol (pre-R4-slice-6) so
// symbols outside the universe keep their exact previous class. These sets are
// now the FALLBACK tier only — the universe is consulted first — and they must
// not grow: new symbols belong in @workspace/markets.
const LEGACY_FOREX_PAIRS = new Set([
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURJPY", "GBPJPY", "EURGBP", "EURCHF", "AUDJPY", "CADJPY", "CHFJPY",
  "NZDJPY", "AUDNZD", "EURAUD", "EURCAD", "EURNZD", "GBPAUD", "GBPCAD",
  "GBPCHF", "GBPNZD",
]);
const LEGACY_METALS = new Set(["XAUUSD", "XAGUSD", "XPTUSD", "XPDUSD"]);
const LEGACY_INDICES = new Set([
  "US30", "NAS100", "SPX500", "GER40", "UK100", "JP225",
  "FRA40", "AUS200", "HK50", "EU50",
  // ARX Focus index canonicals not covered above (Task #558): DXY and GER30
  // (DAX alias) — neither is a universe standard/provider symbol, so the
  // fallback keeps them classified as indices exactly as before.
  "DXY", "GER30",
]);

/** The pre-slice-6 regex/set classifier, minus the deriv-map lookup (covered
 *  by the universe tier — see the module header's coverage note). */
function legacyRegexClass(s: string): CanonicalAssetClass {
  if (!s) return "unknown";

  // Synthetic — tolerant V## / VOLATILITY / BOOM / CRASH / STEP / JUMP.
  if (/^V\d+(_1S)?$/.test(s)) return "synthetic";
  if (/VOLATILITY|BOOM|CRASH|STEP|JUMP/.test(s)) return "synthetic";

  if (LEGACY_METALS.has(s)) return "metals";
  if (LEGACY_INDICES.has(s)) return "indices";
  if (LEGACY_FOREX_PAIRS.has(s)) return "forex";

  // Crypto: BASE + USDT or BASE + USD (3-6 letters base).
  if (/^[A-Z]{3,6}USDT$/.test(s)) return "crypto";
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|MATIC|LTC|LINK|DOT)USD$/.test(s)) return "crypto";

  // Stocks: 1-5 plain letters (TSLA, AAPL, MSFT, NVDA, AMZN, META, GOOGL).
  if (/^[A-Z]{1,5}$/.test(s)) return "stocks";

  return "unknown";
}

/** Normalized (trim+uppercase) token — the canonicalKey for unresolved input,
 *  matching the providers'/router's own symbol-key normalization. */
function normalizedToken(input: string): string {
  return (input ?? "").trim().toUpperCase();
}

/**
 * Resolve any symbol/label into its canonical identity.
 *
 * UNKNOWN IS A VALID OUTCOME: an input neither the approved universe nor the
 * legacy classifier knows returns `{ assetClass: "unknown", family:
 * "unknown" }`. Callers must treat that as "refuse/ask", never substitute a
 * guessed class (the deprecated types.ts `getMarketType` synthetic default is
 * exactly the bug this replaces).
 */
export function resolveCanonicalSymbol(input: string): CanonicalSymbolResolution {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    return {
      canonicalKey: "",
      assetClass: "unknown",
      family: "unknown",
      displaySymbol: "",
      universeStatus: "not_in_universe",
      matchSource: null,
      market: null,
    };
  }

  const universe = resolveUserMarketInput(trimmed);
  if (universe.status === "resolved" && universe.market) {
    const market = universe.market;
    return {
      canonicalKey: market.id,
      assetClass: ROUTER_CLASS_BY_FAMILY[market.assetClass],
      family: market.assetClass,
      displaySymbol: market.standardSymbol,
      universeStatus: "resolved",
      matchSource: universe.matchSource,
      market,
    };
  }

  // Ambiguous or outside the universe → legacy-shape fallback. Ambiguity is
  // NOT collapsed into a guessed market (honesty doctrine); the fallback only
  // supplies the coarse class the old classifier would have given the token.
  const token = normalizedToken(trimmed);
  return {
    canonicalKey: token,
    assetClass: legacyRegexClass(token),
    family: "unknown",
    displaySymbol: trimmed,
    universeStatus: universe.status,
    matchSource: null,
    market: null,
  };
}
