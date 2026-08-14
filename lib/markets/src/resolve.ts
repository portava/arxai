// Lookup + Ruby-style resolution for the approved Top 250 universe.
//
// All resolution is GATED to the approved directory. A free-text input
// resolves only into an approved market, surfaces a Top-250-scoped
// clarifying set when ambiguous, or is reported as outside the universe.
// This builds on the same normalization ideas as the broker resolver /
// synthetic shorthand matcher but never widens beyond the approved list.

import type { ArxMarket, MarketResolveResult, MarketMatchSource } from "./types.js";
import { ARX_TOP_250 } from "./universe.js";

/** Normalize for tolerant comparison: lowercase, collapse separators. */
export function normalizeMarketInput(s: string): string {
  return s.trim().toLowerCase().replace(/[_/\\-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Compact key: strip every separator for tolerant equality. */
export function compactMarketKey(s: string): string {
  return s.toLowerCase().replace(/[\s_/\\().-]+/g, "");
}

// ── Lookup indexes (built once) ────────────────────────────────────────────
const BY_ID = new Map<string, ArxMarket>();
const BY_STANDARD = new Map<string, ArxMarket>(); // compact standardSymbol
const BY_DISPLAY = new Map<string, ArxMarket>(); // compact displayName
const BY_PROVIDER = new Map<string, ArxMarket>(); // compact providerSymbol / brokerAlias
const BY_ALIAS = new Map<string, ArxMarket[]>(); // normalized alias → markets (may be many)

for (const m of ARX_TOP_250) {
  BY_ID.set(m.id, m);
  BY_STANDARD.set(compactMarketKey(m.standardSymbol), m);
  BY_DISPLAY.set(compactMarketKey(m.displayName), m);
  for (const p of m.providerSymbols) {
    const k = compactMarketKey(p);
    if (!BY_PROVIDER.has(k)) BY_PROVIDER.set(k, m);
  }
  for (const b of m.brokerAliases) {
    const k = compactMarketKey(b);
    if (!BY_PROVIDER.has(k)) BY_PROVIDER.set(k, m);
  }
  for (const a of m.aliases) {
    const k = normalizeMarketInput(a);
    const arr = BY_ALIAS.get(k) ?? [];
    if (!arr.includes(m)) arr.push(m);
    BY_ALIAS.set(k, arr);
  }
}

/** Exact lookup by stable id. */
export function findMarketById(id: string): ArxMarket | null {
  return BY_ID.get(id) ?? null;
}

/** Exact lookup by canonical standard symbol (case/separator tolerant). */
export function findMarketByStandardSymbol(symbol: string): ArxMarket | null {
  if (!symbol) return null;
  return BY_STANDARD.get(compactMarketKey(symbol)) ?? null;
}

/** Whether a symbol is the exact standard symbol of an approved market. */
export function isApprovedStandardSymbol(symbol: string): boolean {
  return findMarketByStandardSymbol(symbol) !== null;
}

// Synthetic volatility shorthand: "v75", "v 75 1s", "vol75(1s)" → index.
const VOL_SHORTHAND = /^v(?:ol(?:atility)?)?\s*(\d+)\s*(\(?\s*1s\s*\)?)?$/i;

function matchSyntheticShorthand(normalized: string): ArxMarket[] {
  const m = normalized.match(VOL_SHORTHAND);
  if (!m) return [];
  const base = m[1];
  const oneSec = !!m[2];
  const wanted = oneSec ? `volatility ${base} 1s index` : `volatility ${base} index`;
  const hit = ARX_TOP_250.find(
    (mk) => mk.assetClass === "synthetic" && normalizeMarketInput(mk.standardSymbol) === wanted,
  );
  return hit ? [hit] : [];
}

/**
 * Resolve a user-typed/spoken market input into the approved Top 250.
 *
 * Order: exact standard symbol → display name → provider/broker alias →
 * free-text alias (1 hit = resolved, >1 = ambiguous) → synthetic shorthand.
 * Anything else is reported as outside the universe — never guessed.
 */
export function resolveUserMarketInput(input: string): MarketResolveResult {
  const raw = (input ?? "").trim();
  if (!raw) return { status: "not_in_universe", market: null, candidates: [], matchSource: null };

  const norm = normalizeMarketInput(raw);
  const compact = compactMarketKey(raw);

  const resolved = (market: ArxMarket, matchSource: MarketMatchSource): MarketResolveResult => ({
    status: "resolved",
    market,
    candidates: [],
    matchSource,
  });

  const std = BY_STANDARD.get(compact);
  if (std) return resolved(std, "standard");

  const disp = BY_DISPLAY.get(compact);
  if (disp) return resolved(disp, "display");

  const prov = BY_PROVIDER.get(compact);
  if (prov) return resolved(prov, "provider");

  const aliasHits = BY_ALIAS.get(norm);
  if (aliasHits && aliasHits.length === 1) return resolved(aliasHits[0], "alias");
  if (aliasHits && aliasHits.length > 1) {
    return {
      status: "ambiguous",
      market: null,
      candidates: [...aliasHits].sort((a, b) => a.rank - b.rank),
      matchSource: "alias",
    };
  }

  const synth = matchSyntheticShorthand(norm);
  if (synth.length === 1) return resolved(synth[0], "synthetic");

  return { status: "not_in_universe", market: null, candidates: [], matchSource: null };
}
