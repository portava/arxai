// Broker symbol-name resolver — the single translation boundary where an
// ARX-internal command symbol leaves for the MT5 broker.
//
// WHY THIS EXISTS:
// MT5 symbol lookup (SymbolSelect / OrderSend) is CASE-SENSITIVE and uses the
// broker's exact Market Watch string. ARX stores command symbols in an
// internal form — usually an UPPERCASED display name ("VOLATILITY 75 INDEX")
// or a short alias ("V75") — neither of which matches the broker's actual
// "Volatility 75 Index". Dispatching the wrong-case string makes the EA fail
// with a generic broker rejection (observed: EA_REJECTED_NO_DETAIL on
// synthetics) even when every server-side safety gate passed.
//
// This resolver maps the internal symbol to the EXACT broker symbol using the
// authoritative `symbols` registry table (broker_symbol column). It is applied
// at the EA live-command projection only — it is a transport-layer name
// translation and does NOT touch any safety gate, allowlist, or stored value.
//
// SAFETY:
// - Forex is a no-op (EURUSD → EURUSD).
// - Unknown symbols pass through VERBATIM. ARX never invents or guesses a
//   broker symbol; if the registry has no match the EA receives the original
//   string and reports the real broker rejection. We fail honest, never
//   silently re-route to a different instrument.
// - Aliases resolve ONLY through the registry, so an alias can never produce a
//   broker symbol that is not actually registered.

import { db, symbolsTable } from "@workspace/db";
import { logger } from "../logger.js";

// Short-code aliases → canonical `symbols.symbol` value (compact form). These
// are resolved THROUGH the registry map below, so a listed alias only ever
// yields a broker symbol that is genuinely registered.
const ALIAS_TO_CANONICAL_COMPACT: Record<string, string> = {
  V75: "VOLATILITY75INDEX",
  V751S: "VOLATILITY751SINDEX",
  V25: "VOLATILITY25INDEX",
  V251S: "VOLATILITY251SINDEX",
  V10: "VOLATILITY10INDEX",
  V101S: "VOLATILITY101SINDEX",
  V50: "VOLATILITY50INDEX",
  V501S: "VOLATILITY501SINDEX",
  V100: "VOLATILITY100INDEX",
  V1001S: "VOLATILITY1001SINDEX",
};

/** Case/space/paren-insensitive key, e.g. "Volatility 75 (1s) Index" → "VOLATILITY751SINDEX". */
export function compactSymbolKey(s: string): string {
  return (s ?? "").trim().toUpperCase().replace(/[\s()]/g, "");
}

/** Build the compact-key → exact-broker-symbol lookup from registry rows. */
export function buildBrokerSymbolMap(
  rows: ReadonlyArray<{ symbol: string; brokerSymbol: string | null }>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const broker = (r.brokerSymbol && r.brokerSymbol.trim()) || r.symbol;
    m.set(compactSymbolKey(r.symbol), broker);
    m.set(compactSymbolKey(broker), broker);
  }
  return m;
}

/**
 * Detect registry rows whose names normalize to the SAME compact key but map
 * to DIFFERENT broker symbols. Such a collision means `compactSymbolKey` is too
 * lossy for the live registry and one row would silently win — a correctness
 * risk for live dispatch. Pure; returns one entry per colliding key.
 */
export function findCompactKeyCollisions(
  rows: ReadonlyArray<{ symbol: string; brokerSymbol: string | null }>,
): Array<{ key: string; brokerSymbols: string[] }> {
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    const broker = (r.brokerSymbol && r.brokerSymbol.trim()) || r.symbol;
    for (const name of [r.symbol, broker]) {
      const key = compactSymbolKey(name);
      if (!key) continue;
      const set = seen.get(key) ?? new Set<string>();
      set.add(broker);
      seen.set(key, set);
    }
  }
  const collisions: Array<{ key: string; brokerSymbols: string[] }> = [];
  for (const [key, set] of seen) {
    if (set.size > 1) collisions.push({ key, brokerSymbols: [...set] });
  }
  return collisions;
}

/** Pure resolution against a prebuilt map. Verbatim fallback when unknown. */
export function resolveFromMap(map: Map<string, string>, stored: string): string {
  const raw = (stored ?? "").trim();
  if (!raw) return stored;
  const key = compactSymbolKey(raw);
  const direct = map.get(key);
  if (direct) return direct;
  const aliasTarget = ALIAS_TO_CANONICAL_COMPACT[key];
  if (aliasTarget) {
    const viaAlias = map.get(aliasTarget);
    if (viaAlias) return viaAlias;
  }
  return stored;
}

let cache: Map<string, string> | null = null;
let cachedAtMs = 0;
const TTL_MS = 5 * 60 * 1000;

async function getMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (cache && now - cachedAtMs < TTL_MS) return cache;
  const rows = await db
    .select({ symbol: symbolsTable.symbol, brokerSymbol: symbolsTable.brokerSymbol })
    .from(symbolsTable);
  const collisions = findCompactKeyCollisions(rows);
  if (collisions.length > 0) {
    logger.warn(
      { collisions },
      "broker_symbol_compact_key_collision: registry rows normalize to the same compact key with different broker symbols; resolution may be ambiguous",
    );
  }
  cache = buildBrokerSymbolMap(rows);
  cachedAtMs = now;
  return cache;
}

/**
 * Translate an ARX-internal command symbol into the EXACT broker MT5 symbol.
 * No-op for forex; verbatim fallback for anything not in the registry.
 */
export async function resolveBrokerSymbolName(stored: string): Promise<string> {
  if (!stored || !stored.trim()) return stored;
  const map = await getMap();
  return resolveFromMap(map, stored);
}

/**
 * Read-only status of the broker-symbol registry directory, for admin
 * diagnostics. `loaded` is true when the registry has at least one row; an empty
 * registry means broker specs are missing and every symbol resolves verbatim.
 * Never returns symbol contents — only a presence count.
 */
export async function getBrokerSymbolDirectoryStatus(): Promise<{
  loaded: boolean;
  entryCount: number;
}> {
  const map = await getMap();
  // The map stores two keys per registry row (symbol + broker), so report the
  // number of distinct broker symbols rather than the raw key count.
  const distinct = new Set(map.values());
  return { loaded: distinct.size > 0, entryCount: distinct.size };
}
