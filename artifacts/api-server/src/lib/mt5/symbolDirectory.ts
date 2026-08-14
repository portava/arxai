// T033 Phase 6 (backend) — symbol read + brokerSymbol resolver.
//
// Builds on the EXISTING arx_symbol_specs table + getBrokerSymbolSpec resolver
// (Task #30). Adds:
//   1. listSymbolsForUser() — the data behind GET /api/mt5/symbols, with
//      freshness derived at read time.
//   2. resolveBrokerSymbol() — display/internal/alias → exact brokerSymbol,
//      with ambiguity → candidate list, and unknown → SYMBOL_NOT_FOUND. Never
//      silently falls back to EURUSD or any default.
//
// SAFETY: read-only. Resolution NEVER enables execution; it only returns the
// exact broker string (or candidates / a reason). The preflight + guard chain
// still run on every order.

import { and, eq } from "drizzle-orm";
import {
  db,
  arxSymbolSpecsTable,
  userMasterLiveAccessTable,
  arxMasterAccountConfigTable,
  mt5ConnectionTable,
} from "@workspace/db";

export type SymbolFreshness = "FRESH" | "STALE" | "MISSING";
export const SYMBOL_FRESH_WINDOW_MS = 5 * 60_000;    // enumeration is infrequent
export const SYMBOL_MISSING_WINDOW_MS = 60 * 60_000; // 1h unseen → missing

export function deriveSymbolFreshness(seenAt: Date | null, now = Date.now()): SymbolFreshness {
  if (!seenAt) return "MISSING";
  const age = now - seenAt.getTime();
  if (age <= SYMBOL_FRESH_WINDOW_MS) return "FRESH";
  if (age <= SYMBOL_MISSING_WINDOW_MS) return "STALE";
  return "MISSING";
}

// ─── asset-class derivation ─────────────────────────────────────────────────
// The EA's ENUMERATE_SYMBOLS payload does not carry an asset-class/group field,
// so arx_symbol_specs.category is NULL for enumerated rows. We derive a stable,
// user-facing group from the broker symbol + display name at read time (so the
// scanner picker can render collapsible market groups) WITHOUT inventing any
// instrument — every group is computed from the symbol the broker actually
// reported. If a future EA build populates the category column it takes
// precedence (see toView). Derivation is deterministic and side-effect free.
const FX_FIAT = new Set([
  "USD","EUR","GBP","JPY","CHF","AUD","CAD","NZD","SEK","NOK","DKK","SGD",
  "HKD","MXN","ZAR","TRY","PLN","CZK","HUF","CNH","CNY","THB","INR",
]);
const FX_MAJORS = new Set(["USD","EUR","GBP","JPY","CHF","AUD","CAD","NZD"]);
const CRYPTO_BASES = new Set([
  "BTC","ETH","LTC","XRP","BCH","EOS","ADA","DOGE","SOL","DOT","LNK","UNI",
  "XLM","XMR","DSH","IOT","NEO","TRX","ZEC","BNB","AVA","ALG","MATIC","SHIB",
  "DOG","ZRX","XTZ","MKR","AAVE",
]);
const INDEX_COUNTRIES = new Set([
  "US","UK","AUSTRALIA","GERMANY","FRANCE","JAPAN","NETHERLANDS","SWITZERLAND",
  "SWISS","HONG","HONGKONG","WALL","EUROPE","SPAIN","ITALY","CHINA",
]);
const SYNTHETIC_KEYWORDS =
  /\b(VOLATILITY|BOOM|CRASH|JUMP|RANGE BREAK|DRIFT SWITCH|MULTI STEP|VOLSWITCH|VOL SWITCH|SKEW|TREK|BEAR MARKET|BULL MARKET|RSI)\b/;

export type SymbolCategory =
  | "Forex Majors" | "Forex Minors" | "Metals" | "Indices" | "Crypto"
  | "Synthetics" | "Baskets" | "Commodities" | "Stocks" | "Other";

/** Derive a user-facing asset-class group from a broker symbol + display name. */
export function deriveSymbolCategory(
  symbol: string,
  displaySymbol?: string | null,
  marginCurrency?: string | null,
  profitCurrency?: string | null,
): SymbolCategory {
  const raw = (symbol ?? "").trim();
  if (!raw) return "Other";
  const U = raw.toUpperCase();
  const base = U.replace(/\.[A-Z]{1,4}$/, "");       // strip variant suffix (.s, .US…)
  const firstWord = U.split(" ")[0];
  const mc = (marginCurrency ?? "").toUpperCase();
  const pc = (profitCurrency ?? "").toUpperCase();

  // Deriv baskets ("AUD Basket", "Gold Basket") — before metals/forex.
  if (U.includes("BASKET")) return "Baskets";
  // True synthetic keyword (Volatility/Boom/Crash/Step/…) always wins.
  if (SYNTHETIC_KEYWORDS.test(U) || /^STEP\b/.test(U) || /^VOL\s/.test(U)) return "Synthetics";
  // "Index"/"DEX" naming is synthetic UNLESS it's a country-prefixed cash index
  // (a real broker may literally name a cash index "US 500 Index").
  if ((/\bINDEX\b/.test(U) || /\bDEX\b/.test(U)) && !INDEX_COUNTRIES.has(firstWord)) return "Synthetics";
  // Exchange-suffixed equities/ETFs (AAPL.OQ, BA.N, ARKK.US…).
  if (/\.(OQ|N|US|NYSE|NAS|PA|DE|L|MI|AS|SW|HK)$/.test(U)) return "Stocks";
  // Metals.
  if (/^(XAU|XAG|XPT|XPD)/.test(base) || /^(GOLD|SILVER|PLATINUM|PALLADIUM)\b/.test(U)) return "Metals";
  // Soft/hard commodities & energies (incl. named oils/gas like "UK Brent Oil").
  if (/^(XCU|COPPER|COFFEE|COCOA|SUGAR|COTTON|WHEAT|CORN|SOYBEAN)/.test(U)) return "Commodities";
  if (/^(XBR|XTI|XNG|USOIL|UKOIL|NGAS|WTI|BRENT)/.test(base) || /\b(OIL|BRENT|WTI|CRUDE|NATURAL GAS|GASOLINE)\b/.test(U)) return "Commodities";
  // Crypto — 6-char pair where either leg is a crypto ticker (BTCUSD, LNKUSD, BTCETH…).
  if (/^[A-Z]{6}$/.test(base) && (CRYPTO_BASES.has(base.slice(0, 3)) || CRYPTO_BASES.has(base.slice(3)))) return "Crypto";
  // Stock indices — country + number, never contain "Index".
  if (INDEX_COUNTRIES.has(firstWord)) return "Indices";
  // Forex — 6-alpha with both legs fiat.
  if (/^[A-Z]{6}$/.test(base)) {
    const a = base.slice(0, 3), b = base.slice(3);
    if (FX_FIAT.has(a) && FX_FIAT.has(b)) {
      const major = FX_MAJORS.has(a) && FX_MAJORS.has(b) && (a === "USD" || b === "USD");
      return major ? "Forex Majors" : "Forex Minors";
    }
  }
  // Single-token equity priced in its own currency (ADS, AIR, BAY = EUR/EUR).
  if (mc && mc === pc && !raw.includes(" ") && raw.length <= 6 && /^[A-Z.]+$/.test(U)) return "Stocks";
  return "Other";
}

/** Derive spread in points from bid/ask/point when the EA did not report it. */
export function deriveSpreadPoints(
  bid: number | null | undefined,
  ask: number | null | undefined,
  point: number | null | undefined,
): number | null {
  if (bid == null || ask == null || point == null || point <= 0) return null;
  const spread = Math.round((ask - bid) / point);
  return spread >= 0 ? spread : null;
}

export interface SymbolView {
  symbol: string;                 // ARX-facing key
  brokerSymbol: string | null;    // exact broker string (for execution)
  displaySymbol: string | null;
  category: string | null;
  tradable: boolean | null;
  reasonNotTradable: string | null;
  bid: number | null;
  ask: number | null;
  spreadPoints: number | null;
  digits: number | null;
  point: number | null;
  tickSize: number | null;
  tickValue: number | null;
  contractSize: number | null;
  minLot: number | null;
  maxLot: number | null;
  lotStep: number | null;
  tradeMode: string | null;
  fillingModes: string | null;
  orderModes: string | null;
  stopsLevel: number | null;
  freezeLevel: number | null;
  marginCurrency: string | null;
  profitCurrency: string | null;
  lastTickTime: string | null;
  selectResult: boolean | null;
  freshness: SymbolFreshness;
  snapshotAt: string | null;
  lastSeenAt: string | null;
}

type Row = typeof arxSymbolSpecsTable.$inferSelect;

function toView(r: Row, now: number): SymbolView {
  const seen = (r.lastSeenAt ?? r.reportedAt) ?? null;
  return {
    symbol: r.symbol,
    brokerSymbol: r.brokerSymbol ?? null,
    displaySymbol: r.displaySymbol ?? null,
    category: r.category ?? deriveSymbolCategory(r.symbol, r.displaySymbol, r.marginCurrency, r.profitCurrency),
    tradable: r.tradeAllowed ?? null,
    reasonNotTradable: r.reasonNotTradable ?? null,
    bid: r.bid ?? null,
    ask: r.ask ?? null,
    spreadPoints: r.spreadPoints ?? deriveSpreadPoints(r.bid, r.ask, r.point),
    digits: r.digits ?? null,
    point: r.point ?? null,
    tickSize: r.tickSize ?? null,
    tickValue: r.tickValue ?? null,
    contractSize: r.contractSize ?? null,
    minLot: r.minVolume ?? null,
    maxLot: r.maxVolume ?? null,
    lotStep: r.volumeStep ?? null,
    tradeMode: r.tradeMode ?? null,
    fillingModes: r.fillingModes ?? null,
    orderModes: r.orderModes ?? null,
    stopsLevel: r.stopsLevelPoints ?? null,
    freezeLevel: r.freezeLevelPoints ?? null,
    marginCurrency: r.marginCurrency ?? null,
    profitCurrency: r.profitCurrency ?? null,
    lastTickTime: r.lastTickTime ? r.lastTickTime.toISOString() : null,
    selectResult: r.selectResult ?? null,
    freshness: deriveSymbolFreshness(seen, now),
    snapshotAt: r.snapshotAt ? r.snapshotAt.toISOString() : null,
    lastSeenAt: seen ? seen.toISOString() : null,
  };
}

/** All symbols the EA has reported for a user. Freshness derived at read time. */
export async function listSymbolsForUser(
  userId: number,
  opts: { includeStale?: boolean; tradableOnly?: boolean } = {},
): Promise<SymbolView[]> {
  const rows = await db.select().from(arxSymbolSpecsTable)
    .where(eq(arxSymbolSpecsTable.userId, userId));
  const now = Date.now();
  let views = rows.map((r) => toView(r, now));
  if (!opts.includeStale) views = views.filter((v) => v.freshness !== "MISSING");
  if (opts.tradableOnly) views = views.filter((v) => v.tradable === true);
  return views;
}

// ─── shared-bridge effective symbol-directory owner ─────────────────────────
// A user who trades on the shared master bridge does NOT run their own EA, so
// they have no rows in arx_symbol_specs of their own. Their tradable instrument
// universe IS the master account's enumerated directory (their orders execute
// on that master account). For DISPLAY/RESOLVE purposes only, resolve the
// effective directory owner: the user themselves when they have their own
// enumerated symbols, otherwise — for an APPROVED shared-bridge user — the
// active master connection's owner.
//
// SAFETY: this is read-only and display/resolve only. arx_symbol_specs hold
// instrument metadata (digits, lot steps, tick size) — never positions,
// balances, account numbers, or tokens — so surfacing the master's instrument
// directory to an approved shared-bridge tenant is not a per-user data leak.
// The live EXECUTION path resolves broker symbols via resolveBrokerSymbolName
// (symbolsTable), NOT this function, and is unaffected. No gate is weakened.
export async function resolveEffectiveSymbolOwnerId(
  userId: number,
): Promise<{ ownerId: number; viaSharedMaster: boolean }> {
  // 1. If the user has their own enumerated symbols, always use them.
  const own = await db.select({ userId: arxSymbolSpecsTable.userId })
    .from(arxSymbolSpecsTable)
    .where(eq(arxSymbolSpecsTable.userId, userId))
    .limit(1);
  if (own.length > 0) return { ownerId: userId, viaSharedMaster: false };

  // 2. Only APPROVED shared-bridge users inherit the master directory.
  const access = await db.select({
    approved: userMasterLiveAccessTable.approvedForMasterLive,
    status: userMasterLiveAccessTable.masterLiveStatus,
  }).from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, userId))
    .limit(1);
  const a = access[0];
  if (!a || !a.approved || a.status !== "APPROVED") {
    return { ownerId: userId, viaSharedMaster: false };
  }

  // 3. Resolve the active master connection → its owner.
  const cfg = await db.select({
    masterConnectionId: arxMasterAccountConfigTable.masterConnectionId,
  }).from(arxMasterAccountConfigTable)
    .where(eq(arxMasterAccountConfigTable.isActive, true))
    .limit(1);
  const masterConnId = cfg[0]?.masterConnectionId;
  if (masterConnId == null) return { ownerId: userId, viaSharedMaster: false };

  const conn = await db.select({ userId: mt5ConnectionTable.userId })
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.id, masterConnId))
    .limit(1);
  const masterOwnerId = conn[0]?.userId;
  if (masterOwnerId == null || masterOwnerId === userId) {
    return { ownerId: userId, viaSharedMaster: false };
  }
  return { ownerId: masterOwnerId, viaSharedMaster: true };
}

// ─── brokerSymbol resolver ──────────────────────────────────────────────────
export type SymbolResolution =
  | { ok: true; brokerSymbol: string; matched: SymbolView }
  | { ok: false; reasonCode: "SYMBOL_NOT_FOUND"; requested: string }
  | { ok: false; reasonCode: "SYMBOL_AMBIGUOUS"; requested: string; candidates: SymbolView[] }
  | { ok: false; reasonCode: "NO_BROKER_SYMBOL"; requested: string; matched: SymbolView };

// ─── EA v1.50 ENUMERATE_SYMBOLS → sync-symbol-specs mapper ──────────────────
// The v1.50 EA emits enumeration entries with field names that differ from the
// existing /mt5/sync-symbol-specs SymbolSpecItem schema (e.g. tradeMode arrives
// as a numeric MT5 enum, `tradable`/`selected` instead of `tradeAllowed`/
// `visible`, plus bid/ask/currencies the old schema drops). Rather than change
// the EA, translate its payload into the SymbolSpecItem shape here. The backend
// can then run a single ingestion path.
//
// MT5 SYMBOL_TRADE_MODE enum → our string union:
//   0 DISABLED · 1 LONGONLY · 2 SHORTONLY · 3 CLOSEONLY · 4 FULL
const MT5_TRADE_MODE: Record<number, "DISABLED" | "LONGONLY" | "SHORTONLY" | "CLOSEONLY" | "FULL"> = {
  0: "DISABLED", 1: "LONGONLY", 2: "SHORTONLY", 3: "CLOSEONLY", 4: "FULL",
};

export interface V150EnumEntry {
  symbol?: string;
  description?: string;
  path?: string;
  bid?: number; ask?: number;
  digits?: number; point?: number;
  tickSize?: number; tickValue?: number; contractSize?: number;
  minVolume?: number; maxVolume?: number; volumeStep?: number;
  tradeMode?: number;            // numeric MT5 enum
  stopsLevel?: number; freezeLevel?: number;
  marginCurrency?: string; profitCurrency?: string;
  selected?: boolean; tradable?: boolean;
  [k: string]: unknown;
}

/** Map one v1.50 enumeration entry to the SymbolSpecItem the ingest accepts. */
export function mapV150EnumEntryToSpecItem(e: V150EnumEntry): Record<string, unknown> {
  const mode = typeof e.tradeMode === "number" ? MT5_TRADE_MODE[e.tradeMode] ?? null : null;
  return {
    symbol: e.symbol ?? "",
    brokerSymbol: e.symbol ?? null,          // for Deriv, the broker symbol IS the enumerated name
    visible: typeof e.selected === "boolean" ? e.selected : null,
    tradeAllowed: typeof e.tradable === "boolean" ? e.tradable : null,
    tradeMode: mode,
    marketOpen: mode != null ? mode !== "DISABLED" && mode !== "CLOSEONLY" : null,
    digits: e.digits ?? null,
    point: e.point ?? null,
    minVolume: e.minVolume ?? null,
    maxVolume: e.maxVolume ?? null,
    volumeStep: e.volumeStep ?? null,
    contractSize: e.contractSize ?? null,
    tickSize: e.tickSize ?? null,
    tickValue: e.tickValue ?? null,
    stopsLevelPoints: e.stopsLevel ?? null,
    freezeLevelPoints: e.freezeLevel ?? null,
    spreadPoints: null,
    // v1.50 extras (consumed by the extended arx_symbol_specs columns):
    bid: e.bid ?? null,
    ask: e.ask ?? null,
    marginCurrency: e.marginCurrency ?? null,
    profitCurrency: e.profitCurrency ?? null,
    displaySymbol: e.description || e.symbol || null,
    reasonNotTradable: (e.tradable === false)
      ? (mode === "DISABLED" ? "Trading disabled for this symbol" : "Symbol not tradable") : null,
    raw: e,
  };
}

/** Map a full v1.50 ENUMERATE_SYMBOLS data block (data.symbols[]) to spec items. */
export function mapV150Enumeration(data: { symbols?: V150EnumEntry[] } | null | undefined): Record<string, unknown>[] {
  const arr = data?.symbols ?? [];
  return arr.filter((e) => typeof e.symbol === "string" && e.symbol.length > 0)
            .map(mapV150EnumEntryToSpecItem);
}

function norm(s: string): string {
  return s.toUpperCase().replace(/[\s()_\-]/g, "").replace(/INDEX/g, "");
}

// ─── synthetic shorthand resolver ───────────────────────────────────────────
// Deriv synthetics are enumerated under their full broker names ("Volatility 75
// Index", "Volatility 75 (1s) Index"), but users and internal code refer to them
// by shorthand ("V75", "V75 1s"). This maps a clean V<base>[ (1s) ] token to the
// enumerated instruments by EXACT base number (so V10 never collides with V100)
// and feeds the SAME ambiguous/candidate machinery as the main resolver: a base
// that has BOTH a standard and a (1s) instrument returns BOTH candidates (the
// user/UI must choose — never a silent pick between two different-risk live
// instruments); a (1s)-qualified shorthand, or a base with only one enumerated
// instrument, resolves directly. This NEVER enables execution — it only yields a
// broker string (or candidates); the preflight + 16-gate chain still run.

interface SyntheticShorthand { base: number; oneSecond: boolean | null }

/** Parse "V75", "V75(1s)", "V75 1s", "V751s" → {base, oneSecond}. `oneSecond`
 *  is `true` when the (1s) qualifier is present, else `null` (any variant).
 *  Returns null when the input is not a synthetic shorthand (caller should fall
 *  through to the normal resolver). */
export function parseSyntheticShorthand(requested: string): SyntheticShorthand | null {
  const m = /^v\s*(\d+)\s*(\(?\s*1s\s*\)?)?$/i.exec((requested ?? "").trim());
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isInteger(base) || base <= 0) return null;
  const oneSecond = m[2] && /1s/i.test(m[2]) ? true : null;
  return { base, oneSecond };
}

/** Parse an enumerated Volatility broker name → {base, oneSecond}; null if the
 *  name is not a Volatility instrument. */
function parseSyntheticName(name: string): { base: number; oneSecond: boolean } | null {
  const m = /^\s*volatility\s+(\d+)\s*(\(\s*1s\s*\))?\s*index\s*$/i.exec(name ?? "");
  if (!m) return null;
  return { base: Number(m[1]), oneSecond: Boolean(m[2]) };
}

/** Match a synthetic shorthand against an enumerated inventory by EXACT base.
 *  Returns null when `requested` is not a shorthand (caller falls through); an
 *  array (possibly empty) of matches otherwise — 1 → resolve, >1 → ambiguous. */
export function matchSyntheticShorthand<T extends { symbol: string; brokerSymbol: string | null }>(
  requested: string,
  inventory: readonly T[],
): T[] | null {
  const short = parseSyntheticShorthand(requested);
  if (!short) return null;
  return inventory.filter((v) => {
    const parsed = parseSyntheticName(v.brokerSymbol ?? v.symbol);
    if (!parsed || parsed.base !== short.base) return false;
    if (short.oneSecond === true) return parsed.oneSecond === true;
    return true;
  });
}

/**
 * Resolve an ARX-sent label (displaySymbol, internal symbol, alias, or a raw
 * broker string) to the exact broker symbol. Order:
 *   1. exact brokerSymbol match
 *   2. exact ARX symbol-key match (→ its brokerSymbol)
 *   3. exact displaySymbol match
 *   4. normalized contains-match across all of the above
 * Ambiguous (>1 normalized hit) → candidates, never a guess. No default.
 */
export async function resolveBrokerSymbol(userId: number, requested: string): Promise<SymbolResolution> {
  const req = (requested ?? "").trim();
  if (!req) return { ok: false, reasonCode: "SYMBOL_NOT_FOUND", requested };
  const all = await listSymbolsForUser(userId, { includeStale: true });

  // 1–3: exact matches (case-insensitive) on broker / key / display.
  const reqUp = req.toUpperCase();
  const exact = all.find((v) =>
    (v.brokerSymbol && v.brokerSymbol.toUpperCase() === reqUp) ||
    v.symbol.toUpperCase() === reqUp ||
    (v.displaySymbol && v.displaySymbol.toUpperCase() === reqUp));
  if (exact) {
    if (!exact.brokerSymbol) return { ok: false, reasonCode: "NO_BROKER_SYMBOL", requested: req, matched: exact };
    return { ok: true, brokerSymbol: exact.brokerSymbol, matched: exact };
  }

  // 3.5: synthetic shorthand ("V75" → both Volatility 75 variants → ambiguous;
  // "V75 1s" → the (1s) variant; "V150" → the only enumerated base-150 row).
  // Exact-base match (V10 ≠ V100); 2+ matches return candidates, never a guess.
  const shortHits = matchSyntheticShorthand(req, all);
  if (shortHits && shortHits.length > 0) {
    if (shortHits.length === 1 && shortHits[0]!.brokerSymbol) {
      return { ok: true, brokerSymbol: shortHits[0]!.brokerSymbol, matched: shortHits[0]! };
    }
    if (shortHits.length > 1) {
      return { ok: false, reasonCode: "SYMBOL_AMBIGUOUS", requested: req, candidates: shortHits.slice(0, 8) };
    }
  }

  // 4: normalized contains-match.
  const target = norm(req);
  const hits = all.filter((v) => {
    const cands = [v.brokerSymbol, v.symbol, v.displaySymbol].filter(Boolean) as string[];
    return cands.some((c) => {
      const n = norm(c);
      return n === target || n.includes(target) || target.includes(n);
    });
  });
  if (hits.length === 1 && hits[0]!.brokerSymbol) {
    return { ok: true, brokerSymbol: hits[0]!.brokerSymbol, matched: hits[0]! };
  }
  if (hits.length > 1) {
    return { ok: false, reasonCode: "SYMBOL_AMBIGUOUS", requested: req, candidates: hits.slice(0, 8) };
  }
  return { ok: false, reasonCode: "SYMBOL_NOT_FOUND", requested: req };
}
