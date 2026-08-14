// ── ARX Focus Market Registry (Phase 1) ─────────────────────────────────────
//
// SINGLE SOURCE OF TRUTH for the fixed, approved ARX market universe. ARX is
// locked to exactly these 43 markets: a symbol that is not in this registry is
// invisible across scanner / chart / Ruby / trade-ticket and is refused by the
// additive API + live-pipeline backstop.
//
// This module is PURE: no IO, no DB, no HTTP. It is imported by BOTH the
// api-server and the trading-dashboard (one file serves frontend and backend).
//
// SAFETY: this registry is ADDITIVE. It never relaxes, replaces, or bypasses
// any existing gate (synthetic floor, 16-gate evaluator, SL policy, caps, kill
// switch, owner/admin relaxations). It only adds an "is this symbol approved?"
// answer. Position management (close / modify / cancel) is NEVER gated by it —
// only NEW-entry discovery and placement.
//
// CRITICAL: the synthetic "(1s)" variants are DISTINCT symbols mapping to
// DIFFERENT Deriv ids (e.g. "Volatility 75 (1s) Index" → 1HZ75V vs
// "Volatility 75 Index" → R_75). canonicalSymbol / aliases / mt5Aliases keep
// them separate so resolution never collides.

export type ArxMarketCategory =
  | "synthetic"
  | "forex_major"
  | "forex_minor"
  | "metal"
  | "index"
  | "crypto";

export type ArxFocusMarket = {
  /** Stable internal id (lowercased canonical). */
  id: string;
  /** User-safe display name (never a raw broker token in user copy). */
  displayName: string;
  /** App-wide routing key (e.g. "V75", "V75_1S", "EURUSD", "SPX500"). */
  canonicalSymbol: string;
  category: ArxMarketCategory;
  /** Lowercase free-text nicknames / spoken forms. */
  aliases: string[];
  /** Broker / data-provider symbol strings (verified against the connected
   *  broker symbol spec / provider routing map). */
  mt5Aliases: string[];
  enabledForScanner: boolean;
  enabledForChart: boolean;
  enabledForRuby: boolean;
  enabledForBacktest: boolean;
  enabledForLiveTrading: boolean;
  /** Ordered data-source preference (descriptive — never an execution gate). */
  dataSourcePriority: string[];
  defaultTimeframe: string;
  supportedTimeframes: string[];
  priorityTier: "tier_1" | "tier_2";
  riskProfile: string;
  sessionProfile: string;
  visibility: "approved_only";
};

const STD_TF = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
const SYNTH_SOURCES = ["deriv", "mt5_broker"];
const REAL_SOURCES = ["mt5_broker", "assistant_real"];

/** Shorthand builder — fills the common defaults so each entry stays terse. */
function m(
  partial: Pick<
    ArxFocusMarket,
    "displayName" | "canonicalSymbol" | "category" | "aliases" | "mt5Aliases"
  > &
    Partial<ArxFocusMarket> & { priorityTier: "tier_1" | "tier_2" },
): ArxFocusMarket {
  const isSynth = partial.category === "synthetic";
  return {
    id: partial.canonicalSymbol.toLowerCase(),
    displayName: partial.displayName,
    canonicalSymbol: partial.canonicalSymbol,
    category: partial.category,
    aliases: partial.aliases,
    mt5Aliases: partial.mt5Aliases,
    enabledForScanner: partial.enabledForScanner ?? true,
    enabledForChart: partial.enabledForChart ?? true,
    enabledForRuby: partial.enabledForRuby ?? true,
    enabledForBacktest: partial.enabledForBacktest ?? true,
    enabledForLiveTrading: partial.enabledForLiveTrading ?? true,
    dataSourcePriority:
      partial.dataSourcePriority ?? (isSynth ? SYNTH_SOURCES : REAL_SOURCES),
    defaultTimeframe: partial.defaultTimeframe ?? "M15",
    supportedTimeframes: partial.supportedTimeframes ?? STD_TF,
    priorityTier: partial.priorityTier,
    riskProfile:
      partial.riskProfile ??
      (isSynth || partial.category === "crypto" ? "high_volatility" : "standard"),
    sessionProfile:
      partial.sessionProfile ??
      (isSynth || partial.category === "crypto" ? "24_7" : "london_newyork"),
    visibility: "approved_only",
  };
}

// ── The 36 approved markets, in the canonical default order ──────────────────
export const ARX_FOCUS_MARKETS: ArxFocusMarket[] = [
  // ── Synthetics (Deriv) ──
  m({
    displayName: "Volatility 75 Index",
    canonicalSymbol: "V75",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["v75", "v 75", "vol 75", "volatility 75", "volatility 75 index", "75"],
    mt5Aliases: ["Volatility 75 Index", "R_75"],
  }),
  m({
    displayName: "Volatility 75 (1s) Index",
    canonicalSymbol: "V75_1S",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: [
      "v75 1s", "v 75 1s", "vol 75 1s", "volatility 75 1s",
      "volatility 75 (1s)", "volatility 75 (1s) index", "75 1s", "v75_1s",
    ],
    mt5Aliases: ["Volatility 75 (1s) Index", "1HZ75V"],
  }),
  m({
    displayName: "Volatility 100 Index",
    canonicalSymbol: "V100",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["v100", "v 100", "vol 100", "volatility 100", "volatility 100 index", "100"],
    mt5Aliases: ["Volatility 100 Index", "R_100"],
  }),
  m({
    displayName: "Volatility 50 Index",
    canonicalSymbol: "V50",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["v50", "v 50", "vol 50", "volatility 50", "volatility 50 index", "50"],
    mt5Aliases: ["Volatility 50 Index", "R_50"],
  }),
  m({
    displayName: "Volatility 50 (1s) Index",
    canonicalSymbol: "V50_1S",
    category: "synthetic",
    priorityTier: "tier_2",
    aliases: [
      "v50 1s", "v 50 1s", "vol 50 1s", "volatility 50 1s",
      "volatility 50 (1s)", "volatility 50 (1s) index", "50 1s", "v50_1s",
    ],
    mt5Aliases: ["Volatility 50 (1s) Index", "1HZ50V"],
  }),
  m({
    displayName: "Volatility 25 (1s) Index",
    canonicalSymbol: "V25_1S",
    category: "synthetic",
    priorityTier: "tier_2",
    aliases: [
      "v25 1s", "v 25 1s", "vol 25 1s", "volatility 25 1s",
      "volatility 25 (1s)", "volatility 25 (1s) index", "25 1s", "v25_1s",
    ],
    mt5Aliases: ["Volatility 25 (1s) Index", "1HZ25V"],
  }),
  m({
    displayName: "Volatility 10 Index",
    canonicalSymbol: "V10",
    category: "synthetic",
    priorityTier: "tier_2",
    aliases: ["v10", "v 10", "vol 10", "volatility 10", "volatility 10 index", "10"],
    mt5Aliases: ["Volatility 10 Index", "R_10"],
  }),
  m({
    displayName: "Boom 1000 Index",
    canonicalSymbol: "BOOM1000",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["boom1000", "boom 1000", "boom 1000 index"],
    mt5Aliases: ["Boom 1000 Index", "BOOM1000"],
  }),
  m({
    displayName: "Crash 1000 Index",
    canonicalSymbol: "CRASH1000",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["crash1000", "crash 1000", "crash 1000 index"],
    mt5Aliases: ["Crash 1000 Index", "CRASH1000"],
  }),
  m({
    displayName: "Boom 500 Index",
    canonicalSymbol: "BOOM500",
    category: "synthetic",
    priorityTier: "tier_2",
    aliases: ["boom500", "boom 500", "boom 500 index"],
    mt5Aliases: ["Boom 500 Index", "BOOM500"],
  }),
  m({
    displayName: "Crash 500 Index",
    canonicalSymbol: "CRASH500",
    category: "synthetic",
    priorityTier: "tier_2",
    aliases: ["crash500", "crash 500", "crash 500 index"],
    mt5Aliases: ["Crash 500 Index", "CRASH500"],
  }),
  // ── Tier-1 synthetics (Task #570) — Jump 10/25/50/75/100 + Boom/Crash 300.
  //    Each opens a live chart via the Deriv per-symbol feed: the canonicalSymbol
  //    matches DERIV_SYNTHETIC_SYMBOLS.symbol and the mt5Alias carries the Deriv
  //    id (JD10…JD100, BOOM300N, CRASH300N) so resolution never collides.
  m({
    displayName: "Jump 10 Index",
    canonicalSymbol: "JUMP10",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["jump10", "jump 10", "jump 10 index", "jd10"],
    mt5Aliases: ["Jump 10 Index", "JD10"],
  }),
  m({
    displayName: "Jump 25 Index",
    canonicalSymbol: "JUMP25",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["jump25", "jump 25", "jump 25 index", "jd25"],
    mt5Aliases: ["Jump 25 Index", "JD25"],
  }),
  m({
    displayName: "Jump 50 Index",
    canonicalSymbol: "JUMP50",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["jump50", "jump 50", "jump 50 index", "jd50"],
    mt5Aliases: ["Jump 50 Index", "JD50"],
  }),
  m({
    displayName: "Jump 75 Index",
    canonicalSymbol: "JUMP75",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["jump75", "jump 75", "jump 75 index", "jd75"],
    mt5Aliases: ["Jump 75 Index", "JD75"],
  }),
  m({
    displayName: "Jump 100 Index",
    canonicalSymbol: "JUMP100",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["jump100", "jump 100", "jump 100 index", "jd100"],
    mt5Aliases: ["Jump 100 Index", "JD100"],
  }),
  m({
    displayName: "Boom 300 Index",
    canonicalSymbol: "BOOM300",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["boom300", "boom 300", "boom 300 index"],
    mt5Aliases: ["Boom 300 Index", "BOOM300N"],
  }),
  m({
    displayName: "Crash 300 Index",
    canonicalSymbol: "CRASH300",
    category: "synthetic",
    priorityTier: "tier_1",
    aliases: ["crash300", "crash 300", "crash 300 index"],
    mt5Aliases: ["Crash 300 Index", "CRASH300N"],
  }),

  // ── Forex majors ──
  m({
    displayName: "EUR/USD",
    canonicalSymbol: "EURUSD",
    category: "forex_major",
    priorityTier: "tier_1",
    aliases: ["eurusd", "eur usd", "euro dollar", "fiber"],
    mt5Aliases: ["EURUSD"],
  }),
  m({
    displayName: "GBP/USD",
    canonicalSymbol: "GBPUSD",
    category: "forex_major",
    priorityTier: "tier_1",
    aliases: ["gbpusd", "gbp usd", "cable", "pound dollar"],
    mt5Aliases: ["GBPUSD"],
  }),
  m({
    displayName: "USD/JPY",
    canonicalSymbol: "USDJPY",
    category: "forex_major",
    priorityTier: "tier_2",
    aliases: ["usdjpy", "usd jpy", "dollar yen"],
    mt5Aliases: ["USDJPY"],
  }),
  m({
    displayName: "USD/CHF",
    canonicalSymbol: "USDCHF",
    category: "forex_major",
    priorityTier: "tier_2",
    aliases: ["usdchf", "usd chf", "swissy"],
    mt5Aliases: ["USDCHF"],
  }),
  m({
    displayName: "USD/CAD",
    canonicalSymbol: "USDCAD",
    category: "forex_major",
    priorityTier: "tier_2",
    aliases: ["usdcad", "usd cad", "loonie"],
    mt5Aliases: ["USDCAD"],
  }),
  m({
    displayName: "AUD/USD",
    canonicalSymbol: "AUDUSD",
    category: "forex_major",
    priorityTier: "tier_2",
    aliases: ["audusd", "aud usd", "aussie"],
    mt5Aliases: ["AUDUSD"],
  }),
  m({
    displayName: "NZD/USD",
    canonicalSymbol: "NZDUSD",
    category: "forex_major",
    priorityTier: "tier_2",
    aliases: ["nzdusd", "nzd usd", "kiwi"],
    mt5Aliases: ["NZDUSD"],
  }),

  // ── Forex minors (crosses) ──
  m({
    displayName: "EUR/JPY",
    canonicalSymbol: "EURJPY",
    category: "forex_minor",
    priorityTier: "tier_2",
    aliases: ["eurjpy", "eur jpy"],
    mt5Aliases: ["EURJPY"],
  }),
  m({
    displayName: "EUR/GBP",
    canonicalSymbol: "EURGBP",
    category: "forex_minor",
    priorityTier: "tier_2",
    aliases: ["eurgbp", "eur gbp"],
    mt5Aliases: ["EURGBP"],
  }),
  m({
    displayName: "EUR/AUD",
    canonicalSymbol: "EURAUD",
    category: "forex_minor",
    priorityTier: "tier_2",
    aliases: ["euraud", "eur aud"],
    mt5Aliases: ["EURAUD"],
  }),
  m({
    displayName: "EUR/CAD",
    canonicalSymbol: "EURCAD",
    category: "forex_minor",
    priorityTier: "tier_2",
    aliases: ["eurcad", "eur cad"],
    mt5Aliases: ["EURCAD"],
  }),
  m({
    displayName: "GBP/JPY",
    canonicalSymbol: "GBPJPY",
    category: "forex_minor",
    priorityTier: "tier_2",
    aliases: ["gbpjpy", "gbp jpy", "beast"],
    mt5Aliases: ["GBPJPY"],
  }),
  m({
    displayName: "GBP/AUD",
    canonicalSymbol: "GBPAUD",
    category: "forex_minor",
    priorityTier: "tier_2",
    aliases: ["gbpaud", "gbp aud"],
    mt5Aliases: ["GBPAUD"],
  }),
  m({
    displayName: "GBP/CAD",
    canonicalSymbol: "GBPCAD",
    category: "forex_minor",
    priorityTier: "tier_2",
    aliases: ["gbpcad", "gbp cad"],
    mt5Aliases: ["GBPCAD"],
  }),
  m({
    displayName: "AUD/JPY",
    canonicalSymbol: "AUDJPY",
    category: "forex_minor",
    priorityTier: "tier_2",
    aliases: ["audjpy", "aud jpy"],
    mt5Aliases: ["AUDJPY"],
  }),
  m({
    displayName: "CAD/JPY",
    canonicalSymbol: "CADJPY",
    category: "forex_minor",
    priorityTier: "tier_2",
    aliases: ["cadjpy", "cad jpy"],
    mt5Aliases: ["CADJPY"],
  }),
  m({
    displayName: "CHF/JPY",
    canonicalSymbol: "CHFJPY",
    category: "forex_minor",
    priorityTier: "tier_2",
    aliases: ["chfjpy", "chf jpy"],
    mt5Aliases: ["CHFJPY"],
  }),

  // ── Metals ──
  m({
    displayName: "Gold (XAU/USD)",
    canonicalSymbol: "XAUUSD",
    category: "metal",
    priorityTier: "tier_1",
    aliases: ["xauusd", "xau usd", "gold", "xau", "gold usd"],
    mt5Aliases: ["XAUUSD", "Gold"],
  }),
  m({
    displayName: "Silver (XAG/USD)",
    canonicalSymbol: "XAGUSD",
    category: "metal",
    priorityTier: "tier_1",
    aliases: ["xagusd", "xag usd", "silver", "xag"],
    mt5Aliases: ["XAGUSD", "Silver"],
  }),

  // ── Indices ── (broker symbols verified against arx_symbol_specs)
  m({
    displayName: "US Dollar Index (DXY)",
    canonicalSymbol: "DXY",
    category: "index",
    priorityTier: "tier_1",
    aliases: ["dxy", "dollar index", "us dollar index", "usdx", "dx"],
    mt5Aliases: ["DXYUSD", "DXY"],
    sessionProfile: "cash_session",
  }),
  m({
    displayName: "S&P 500 (SPX500)",
    canonicalSymbol: "SPX500",
    category: "index",
    priorityTier: "tier_1",
    aliases: ["spx500", "spx", "sp500", "sp 500", "s&p", "s and p", "s&p 500", "us500", "us 500"],
    mt5Aliases: ["US SP 500", "SPX500", "US500"],
    sessionProfile: "cash_session",
  }),
  m({
    displayName: "Germany 40 / DAX (GER30)",
    canonicalSymbol: "GER30",
    category: "index",
    priorityTier: "tier_1",
    aliases: ["ger30", "ger 30", "germany 30", "dax", "germany 40", "ger40", "de40", "dax 40", "dax 30"],
    mt5Aliases: ["Germany 40", "GER40", "DE40"],
    sessionProfile: "cash_session",
  }),
  m({
    displayName: "Dow Jones (US30)",
    canonicalSymbol: "US30",
    category: "index",
    priorityTier: "tier_1",
    aliases: ["us30", "us 30", "dow", "dow jones", "djia", "wall street", "wall street 30", "dj30"],
    mt5Aliases: ["Wall Street 30", "US30", "DJ30"],
    sessionProfile: "cash_session",
  }),

  // ── Crypto ──
  m({
    displayName: "Bitcoin (BTC/USD)",
    canonicalSymbol: "BTCUSD",
    category: "crypto",
    priorityTier: "tier_1",
    aliases: ["btcusd", "btc usd", "btc", "bitcoin", "btcusdt", "btc usdt"],
    mt5Aliases: ["BTCUSD", "BTCUSDT"],
  }),
  m({
    displayName: "Ethereum (ETH/USD)",
    canonicalSymbol: "ETHUSD",
    category: "crypto",
    priorityTier: "tier_1",
    aliases: ["ethusd", "eth usd", "eth", "ether", "ethereum", "ethusdt", "eth usdt"],
    mt5Aliases: ["ETHUSD", "ETHUSDT"],
  }),
];

// ── Category display order (used by UI chrome chips) ─────────────────────────
export const ARX_FOCUS_CATEGORY_ORDER: ArxMarketCategory[] = [
  "synthetic",
  "forex_major",
  "forex_minor",
  "metal",
  "index",
  "crypto",
];

/** Default approved market the chart falls back to (Volatility 75 Index). */
export const ARX_DEFAULT_MARKET = "V75";

/** Typed error thrown by `assertApprovedArxMarket`. */
export class UnapprovedArxMarketError extends Error {
  readonly requestedSymbol: string;
  readonly code = "SYMBOL_NOT_IN_ARX_FOCUS";
  constructor(requestedSymbol: string) {
    super(
      `Market "${requestedSymbol}" is outside the active ARX approved market universe.`,
    );
    this.name = "UnapprovedArxMarketError";
    this.requestedSymbol = requestedSymbol;
  }
}

// ── Normalization + lookup index ─────────────────────────────────────────────
//
// Resolution is EXACT (case-insensitive) over the normalized form of
// canonicalSymbol + aliases + mt5Aliases. Exact matching (not substring) is
// what keeps the "(1s)" variants distinct from their standard counterparts.

/** Normalize a symbol/alias to a comparison key: strip an exchange prefix
 *  ("FX:EURUSD" → "EURUSD"), lowercase, turn separators / parens into spaces,
 *  and collapse whitespace. */
function normKey(input: string): string {
  if (!input) return "";
  let s = input.trim();
  // Strip a leading "EXCHANGE:" prefix (TradingView-style bus symbols).
  const colon = s.indexOf(":");
  if (colon > 0 && colon <= 6) s = s.slice(colon + 1);
  s = s.toLowerCase();
  s = s.replace(/[()/_\-.,]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

const NORM_INDEX: Map<string, ArxFocusMarket> = new Map();
for (const market of ARX_FOCUS_MARKETS) {
  const keys = [market.canonicalSymbol, ...market.aliases, ...market.mt5Aliases];
  for (const raw of keys) {
    const k = normKey(raw);
    if (!k) continue;
    const existing = NORM_INDEX.get(k);
    if (existing && existing.id !== market.id) {
      // A normalized alias collision between two markets is a registry bug —
      // surface it loudly at module load rather than silently mis-resolving.
      throw new Error(
        `ARX Focus registry alias collision on "${k}" between ` +
          `${existing.canonicalSymbol} and ${market.canonicalSymbol}`,
      );
    }
    NORM_INDEX.set(k, market);
  }
}

// ── Public resolver helpers (STEP 2) ─────────────────────────────────────────

/** Resolve a free-text / canonical / broker symbol to its approved market,
 *  or null when it is not in the approved universe. */
export function resolveArxMarket(input: string): ArxFocusMarket | null {
  const k = normKey(input);
  if (!k) return null;
  return NORM_INDEX.get(k) ?? null;
}

/** True iff the input resolves to an approved ARX market. */
export function isApprovedArxMarket(input: string): boolean {
  return resolveArxMarket(input) !== null;
}

/** Canonical routing symbol for an input, or null when unapproved. */
export function normalizeArxSymbol(input: string): string | null {
  return resolveArxMarket(input)?.canonicalSymbol ?? null;
}

/** All approved markets in a category (in default order). */
export function getApprovedMarketsByCategory(
  category: ArxMarketCategory,
): ArxFocusMarket[] {
  return ARX_FOCUS_MARKETS.filter((mk) => mk.category === category);
}

/** Tier-1 priority markets (in default order). */
export function getTierOneMarkets(): ArxFocusMarket[] {
  return ARX_FOCUS_MARKETS.filter((mk) => mk.priorityTier === "tier_1");
}

/** All approved markets in default order. */
export function getAllApprovedArxMarkets(): ArxFocusMarket[] {
  return [...ARX_FOCUS_MARKETS];
}

/** Resolve or throw a typed error — the assertion form used by the backstop. */
export function assertApprovedArxMarket(input: string): ArxFocusMarket {
  const market = resolveArxMarket(input);
  if (!market) throw new UnapprovedArxMarketError(input);
  return market;
}

/**
 * Superset guard (Phase 1, T001). Given a list of symbols currently live in the
 * system (open positions, in-flight commands, …), return the distinct symbols
 * that do NOT resolve to an approved ARX market — i.e. the symbols the 36-market
 * Focus set is NOT a superset of.
 *
 * An empty result means the approved universe is a superset of the supplied live
 * symbols and locking to the 36 cannot strand any of them. This is a pure,
 * deterministic helper; callers (the DB-backed guard / its test) decide whether
 * a non-empty result is a hard failure or an operator warning. De-duplication is
 * by canonical-less normalized key so "V75" and "Volatility 75 Index" collapse,
 * while the FIRST original spelling seen is preserved for reporting.
 */
export function findUnapprovedSymbols(symbols: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of symbols) {
    const s = (raw ?? "").trim();
    if (!s) continue;
    if (isApprovedArxMarket(s)) continue;
    const key = normKey(s) || s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** The exact, locked reply Ruby gives for any unapproved market. */
export const ARX_FOCUS_RUBY_LOCKED_REPLY =
  "ARX is currently focused only on the approved market universe. That market " +
  "is outside the active ARX focus list, so I won't analyze or display it here.";

/** The honest, user-safe blocked reason for the API / live backstop. */
export const ARX_FOCUS_BLOCKED_REASON =
  "Market is outside the active ARX approved market universe.";

// ── Focus-Lock response envelopes (shared, Task #570) ────────────────────────
//
// One blocked-shape and one approved-shape used by every Focus-gated API
// surface (chart/scanner data, backtest, watchlist, dashboard market-data) so
// the refusal/approval contract stays identical everywhere. The blocked shape
// matches the Phase-1 `arxFocusBlockedEnvelope` already returned by the chart
// data route — DO NOT invent a new shape.

export type ArxFocusBlockedEnvelope = {
  requestedSymbol: string;
  isApprovedMarket: false;
  blocked: true;
  reason: string;
};

export type ArxFocusApprovedEnvelope = {
  requestedSymbol: string;
  canonicalSymbol: string;
  isApprovedMarket: true;
  blocked: false;
  category: ArxMarketCategory;
  priorityTier: "tier_1" | "tier_2";
  dataSource: string | null;
  freshness: string | null;
};

/** The locked refusal envelope for any unapproved symbol. */
export function arxFocusBlockedEnvelope(requestedSymbol: string): ArxFocusBlockedEnvelope {
  return {
    requestedSymbol,
    isApprovedMarket: false,
    blocked: true,
    reason: ARX_FOCUS_BLOCKED_REASON,
  };
}

/** The extended approved envelope for an in-universe symbol. `dataSource` /
 *  `freshness` are descriptive metadata, never an execution gate. */
export function arxFocusApprovedEnvelope(
  market: ArxFocusMarket,
  opts?: { dataSource?: string | null; freshness?: string | null },
): ArxFocusApprovedEnvelope {
  return {
    requestedSymbol: market.canonicalSymbol,
    canonicalSymbol: market.canonicalSymbol,
    isApprovedMarket: true,
    blocked: false,
    category: market.category,
    priorityTier: market.priorityTier,
    dataSource: opts?.dataSource ?? market.dataSourcePriority[0] ?? null,
    freshness: opts?.freshness ?? null,
  };
}
