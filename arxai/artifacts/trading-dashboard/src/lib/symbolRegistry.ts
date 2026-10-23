/**
 * Unified symbol registry + resolver.
 *
 * One canonical list used by: SymbolExplorer, SelectedMarketPanel
 * (Ruby Market Intelligence), scanner, chart, and the global instant
 * trade router. The registry is the source of truth for which markets
 * a user can search, click, focus, and trade across the app.
 *
 * Critically: searching "75" must surface BOTH `V75` and `V75_1S`
 * (synthetic indices), not return "75 unavailable". The previous
 * hard-coded 8-symbol chip list lived in SelectedMarketPanel — that
 * list is gone; everything routes through this registry.
 *
 * No live trading decisions are made here. Safety gates live in
 * `lib/live/instantTrade.ts` + `livePhaseBDispatchGate.ts`. This
 * module is presentation/UX only.
 */

import { resolveUserMarketInput } from "@workspace/markets";
import {
  ARX_FOCUS_MARKETS,
  resolveArxMarket,
  type ArxFocusMarket,
  type ArxMarketCategory,
} from "@workspace/domain/market";

export type MarketType =
  | "forex"
  | "metals"
  | "indices"
  | "crypto"
  | "stocks"
  | "energy"
  | "commodities"
  | "synthetic";

export type DataProvider =
  | "core"            // backend symbolRegistry covers it
  | "deriv"           // needs DERIV_APP_ID; synthetics still selectable when missing
  | "broker_mt5"      // tradable via EA bridge
  | "external"        // TwelveData / TradingView only
  | "unknown";

export interface SymbolEntry {
  /** Canonical app-wide id (e.g. "V75_1S", "EURUSD", "XAUUSD"). */
  canonicalSymbol: string;
  /** Human-readable name shown to the user. */
  displayName: string;
  marketType: MarketType;
  /** Broker / data-feed symbol if it differs from canonical. */
  brokerSymbol?: string;
  dataProvider: DataProvider;
  /** Lowercase free-text aliases. Must NOT include the canonical. */
  aliases: string[];
  /** Is this symbol tradable via the existing live pipeline. */
  isTradable: boolean;
  /** Does the scanner have an analysis pipeline for it. */
  isScannable: boolean;
}

export interface ResolvedSymbol extends SymbolEntry {
  /** Whether the symbol can be selected right now. Synthetics stay
   *  available even when DERIV_APP_ID is missing — the UI just shows
   *  a "feed not configured" badge instead of refusing the symbol. */
  isAvailable: boolean;
  unavailableReason: string | null;
  /** How we matched the user's query (debug/diagnostics row). */
  matchSource: "exact" | "alias" | "prefix" | "contains" | "broker";
}

// ─── Registry ─────────────────────────────────────────────────────────────
// Task #558 — the registry is DERIVED ENTIRELY from the @workspace/domain ARX
// Focus market registry (the SINGLE source of truth: 43 approved markets). The
// picker / explorer / scanner / chart / ticket can therefore only ever surface
// an approved Focus market — nothing outside the 43 is searchable, selectable,
// scannable, chartable, or tradeable. The Focus registry's canonicalSymbol is
// the authoritative routing key (V75, SPX500, GER30, US30, BTCUSD, …).
const R = (e: SymbolEntry): SymbolEntry => e;

function marketTypeForCategory(c: ArxMarketCategory): MarketType {
  switch (c) {
    case "forex_major":
    case "forex_minor":
      return "forex";
    case "metal":
      return "metals";
    case "index":
      return "indices";
    case "crypto":
      return "crypto";
    case "synthetic":
      return "synthetic";
  }
}

function dataProviderForCategory(c: ArxMarketCategory): DataProvider {
  if (c === "synthetic") return "deriv";
  if (c === "crypto") return "external";
  return "core";
}

/** Pick a code-like broker token (e.g. "R_75") over the human MT5 name
 *  ("Volatility 75 Index") for BY_BROKER lookup. Undefined when the only
 *  alias equals the canonical (forex/metals where broker === canonical). */
function brokerSymbolForMarket(mk: ArxFocusMarket): string | undefined {
  const code = mk.mt5Aliases.find(
    (a) => /^[A-Za-z0-9_]+$/.test(a) && a.toUpperCase() !== mk.canonicalSymbol.toUpperCase(),
  );
  return code ? code.toUpperCase() : undefined;
}

function aliasesForFocusMarket(mk: ArxFocusMarket): string[] {
  const canon = mk.canonicalSymbol.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...mk.aliases, ...mk.mt5Aliases]) {
    const a = raw.toLowerCase().trim();
    if (!a || a === canon || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/** The user-facing registry: every approved ARX Focus market, in canonical
 *  default order. Locked to the 43 approved markets — nothing else exists. */
export const SYMBOL_REGISTRY: SymbolEntry[] = ARX_FOCUS_MARKETS.map((mk) =>
  R({
    canonicalSymbol: mk.canonicalSymbol,
    displayName: mk.displayName,
    marketType: marketTypeForCategory(mk.category),
    brokerSymbol: brokerSymbolForMarket(mk),
    dataProvider: dataProviderForCategory(mk.category),
    aliases: aliasesForFocusMarket(mk),
    isTradable: mk.enabledForLiveTrading,
    isScannable: mk.enabledForScanner,
  }),
);


// Fast lookup tables built once at module load.
const BY_CANONICAL: Map<string, SymbolEntry> = new Map();
const BY_BROKER: Map<string, SymbolEntry> = new Map();
const BY_ALIAS: Map<string, SymbolEntry> = new Map();
for (const e of SYMBOL_REGISTRY) {
  BY_CANONICAL.set(e.canonicalSymbol.toUpperCase(), e);
  if (e.brokerSymbol) BY_BROKER.set(e.brokerSymbol.toUpperCase(), e);
  for (const a of e.aliases) BY_ALIAS.set(a.toLowerCase().trim(), e);
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[_/-]+/g, " ").replace(/\s+/g, " ");
}
function compact(s: string): string {
  // "v 75 1s" → "v751s"; used for tolerant equality.
  return s.toLowerCase().replace(/[\s_/-]+/g, "");
}

/** Availability rule: synthetics stay selectable even when DERIV_APP_ID
 *  is missing. The UI shows a compact "Deriv feed not configured" badge
 *  instead of returning "75 unavailable". */
function availabilityFor(e: SymbolEntry, opts: ResolveOptions): { isAvailable: boolean; unavailableReason: string | null } {
  if (e.dataProvider === "deriv" && opts.derivFeedConfigured === false) {
    // Still available for selection + UI focus; scanner data may be empty.
    return { isAvailable: true, unavailableReason: "DERIV_FEED_NOT_CONFIGURED" };
  }
  return { isAvailable: true, unavailableReason: null };
}

export interface ResolveOptions {
  /** When false, synthetic symbols are still selectable but flagged. */
  derivFeedConfigured?: boolean;
}

/** Single best resolve. Returns null only when query is empty / nothing
 *  matches even loosely. */
export function resolveSymbol(query: string, opts: ResolveOptions = {}): ResolvedSymbol | null {
  const hits = searchSymbols(query, { limit: 1, ...opts });
  return hits[0] ?? null;
}

export interface SearchOptions extends ResolveOptions {
  limit?: number;
}

/** Ranked search. Always returns the strongest matches first so the
 *  caller can show suggestions (e.g. "75" → [V75, V75_1S, V25, ...]). */
export function searchSymbols(query: string, opts: SearchOptions = {}): ResolvedSymbol[] {
  const limit = opts.limit ?? 12;
  const q = norm(query);
  if (!q) return [];
  const qc = compact(q);

  const scored: Array<{ e: SymbolEntry; score: number; source: ResolvedSymbol["matchSource"] }> = [];
  const push = (e: SymbolEntry, score: number, source: ResolvedSymbol["matchSource"]) => {
    scored.push({ e, score, source });
  };

  // 1) Exact canonical
  const cExact = BY_CANONICAL.get(q.toUpperCase()) ?? BY_CANONICAL.get(qc.toUpperCase());
  if (cExact) push(cExact, 1000, "exact");

  // 2) Exact broker symbol
  const bExact = BY_BROKER.get(q.toUpperCase()) ?? BY_BROKER.get(qc.toUpperCase());
  if (bExact) push(bExact, 950, "broker");

  // 3) Exact alias
  const aExact = BY_ALIAS.get(q);
  if (aExact) push(aExact, 900, "alias");

  // 4) Per-entry scoring: aliases / canonical / displayName / broker
  for (const e of SYMBOL_REGISTRY) {
    const canon = e.canonicalSymbol.toLowerCase();
    const canonC = compact(canon);
    const disp = e.displayName.toLowerCase();
    const broker = (e.brokerSymbol ?? "").toLowerCase();

    if (canon.startsWith(q) || canonC.startsWith(qc)) push(e, 800, "prefix");
    else if (canon.includes(q) || canonC.includes(qc)) push(e, 600, "contains");
    if (disp.includes(q)) push(e, 550, "contains");
    if (broker && (broker === q || broker.startsWith(q))) push(e, 700, "broker");

    for (const a of e.aliases) {
      if (a === q) push(e, 900, "alias");
      else if (a.startsWith(q)) push(e, 720, "alias");
      else if (compact(a).startsWith(qc) && qc.length >= 2) push(e, 680, "alias");
      else if (a.includes(q) && q.length >= 2) push(e, 500, "alias");
    }
  }

  // De-dup keeping the highest score per entry.
  const best = new Map<string, { score: number; source: ResolvedSymbol["matchSource"] }>();
  for (const s of scored) {
    const cur = best.get(s.e.canonicalSymbol);
    if (!cur || s.score > cur.score) best.set(s.e.canonicalSymbol, { score: s.score, source: s.source });
  }

  const entries = Array.from(best.entries())
    .map(([k, v]) => ({ e: BY_CANONICAL.get(k)!, score: v.score, source: v.source }))
    .filter((x) => !!x.e)
    .sort((a, b) => b.score - a.score || a.e.canonicalSymbol.localeCompare(b.e.canonicalSymbol))
    .slice(0, limit);

  return entries.map(({ e, source }) => {
    const a = availabilityFor(e, opts);
    return { ...e, matchSource: source, isAvailable: a.isAvailable, unavailableReason: a.unavailableReason };
  });
}

/**
 * Approved near-match suggestions for a typed token that did NOT resolve to a
 * single approved market. Sourced ONLY from `resolveUserMarketInput`'s
 * `ambiguous` candidates (e.g. "oil" → WTI / Brent) — every returned entry is
 * guaranteed to be in the approved Top 250 and visible in the registry. This
 * never invents a match and never surfaces a non-approved market: when the
 * input resolves cleanly, is empty, or is genuinely outside the universe, it
 * returns []. Used to turn a dead-end ("isn't in the approved list") into a
 * one-tap redirect in the Symbol Explorer and the watchlist add box.
 */
export function suggestApprovedSymbols(query: string, opts: ResolveOptions = {}): ResolvedSymbol[] {
  const q = (query ?? "").trim();
  if (!q) return [];
  const r = resolveUserMarketInput(q);
  if (r.status !== "ambiguous") return [];
  const out: ResolvedSymbol[] = [];
  const seen = new Set<string>();
  for (const m of r.candidates) {
    // Map each ambiguous candidate through the ARX Focus registry: a candidate
    // outside the 43 approved markets resolves to null and is dropped, so a
    // suggestion can ONLY ever be an approved + visible Focus market. The
    // canonical routing key stays consistent with every other surface.
    const focus = resolveArxMarket(m.standardSymbol);
    if (!focus) continue;
    const entry = BY_CANONICAL.get(focus.canonicalSymbol.toUpperCase());
    if (!entry || seen.has(entry.canonicalSymbol)) continue;
    seen.add(entry.canonicalSymbol);
    const a = availabilityFor(entry, opts);
    out.push({ ...entry, matchSource: "alias", isAvailable: a.isAvailable, unavailableReason: a.unavailableReason });
  }
  return out;
}

/** Group by market type. Used by the collapsible Symbol Explorer. */
export function groupByMarketType(entries: SymbolEntry[] = SYMBOL_REGISTRY): Record<MarketType, SymbolEntry[]> {
  const out: Record<MarketType, SymbolEntry[]> = {
    forex: [], metals: [], indices: [], crypto: [], stocks: [], energy: [], commodities: [], synthetic: [],
  };
  for (const e of entries) out[e.marketType].push(e);
  return out;
}

export function isCanonical(s: string): boolean {
  return BY_CANONICAL.has(s.trim().toUpperCase());
}

// ─── TradingView embed symbols (Task #558) ──────────────────────────────────
// The third-party TradingView widget needs exchange-prefixed symbols
// ("FX:EURUSD", "TVC:DXY"). This map is keyed by the Focus registry's canonical
// symbol, so the TradingView chart selector can ONLY ever offer an approved
// market — nothing outside the 43 is selectable there. Markets TradingView
// cannot render (the Deriv synthetics: V75/Boom/Crash/… ) have NO entry and are
// therefore omitted from the selector entirely rather than shown as a dead
// option. No data is fetched for an unmapped/unapproved symbol.
const CANONICAL_TO_TRADINGVIEW: Record<string, string> = {
  EURUSD: "FX:EURUSD", GBPUSD: "FX:GBPUSD", USDJPY: "FX:USDJPY",
  USDCHF: "FX:USDCHF", USDCAD: "FX:USDCAD", AUDUSD: "FX:AUDUSD", NZDUSD: "FX:NZDUSD",
  EURJPY: "FX:EURJPY", EURGBP: "FX:EURGBP", EURAUD: "FX:EURAUD", EURCAD: "FX:EURCAD",
  GBPJPY: "FX:GBPJPY", GBPAUD: "FX:GBPAUD", GBPCAD: "FX:GBPCAD",
  AUDJPY: "FX:AUDJPY", CADJPY: "FX:CADJPY", CHFJPY: "FX:CHFJPY",
  XAUUSD: "OANDA:XAUUSD", XAGUSD: "OANDA:XAGUSD",
  DXY: "TVC:DXY", SPX500: "OANDA:SPX500USD", GER30: "OANDA:DE30EUR", US30: "OANDA:US30USD",
  BTCUSD: "BINANCE:BTCUSDT", ETHUSD: "BINANCE:ETHUSDT",
};

export interface TradingViewSymbolOption {
  /** Canonical Focus symbol (routing key, e.g. "EURUSD"). */
  canonical: string;
  /** Exchange-prefixed symbol the TradingView widget understands. */
  tv: string;
  /** Human-readable label for the selector. */
  label: string;
}

// Built by iterating the approved Focus registry IN ORDER, keeping only markets
// that have a TradingView mapping — so the result is approved-only by
// construction and stays in the canonical default order.
export const APPROVED_TRADINGVIEW_SYMBOLS: TradingViewSymbolOption[] =
  ARX_FOCUS_MARKETS.flatMap((mk) => {
    const tv = CANONICAL_TO_TRADINGVIEW[mk.canonicalSymbol.toUpperCase()];
    if (!tv) return [];
    return [{ canonical: mk.canonicalSymbol, tv, label: mk.canonicalSymbol }];
  });

/**
 * Resolve any incoming chart symbol (canonical "EURUSD", bus value, or an
 * already-TradingView-formatted "FX:EURUSD") to an approved TradingView symbol.
 * Returns null when the symbol is not an approved, TradingView-renderable Focus
 * market (e.g. a synthetic, or anything outside the 43) so callers can fall back
 * honestly instead of fetching data for a blocked symbol.
 */
export function approvedTradingViewSymbol(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  // Already a known TradingView value?
  const directTv = APPROVED_TRADINGVIEW_SYMBOLS.find(
    (o) => o.tv.toUpperCase() === raw.toUpperCase(),
  );
  if (directTv) return directTv.tv;
  // Otherwise resolve through the Focus registry (handles aliases + the
  // "EXCHANGE:" prefix) and map the canonical to its TradingView symbol.
  const focus = resolveArxMarket(raw);
  if (!focus) return null;
  return CANONICAL_TO_TRADINGVIEW[focus.canonicalSymbol.toUpperCase()] ?? null;
}
