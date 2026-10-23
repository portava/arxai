// T033 Phase 6B — client hooks for the backend symbol directory.
//
// Single source every trade surface reads so the picker, scanner cards, chart
// panel, and trade ticket all use the SAME exact brokerSymbol data and never
// drift. Mirrors the useTradability.ts pattern (React Query, BASE prefix,
// credentials, abort ceiling).
//
// The UI shows displaySymbol; execution MUST submit brokerSymbol. These hooks
// never invent a symbol and never fall back to a default.

import { useQuery } from "@tanstack/react-query";

// BASE is the app's base path. Under Vite (browser) it comes from
// import.meta.env.BASE_URL; under plain Node (tests) import.meta.env is
// undefined, so guard it so the module loads in both environments.
const BASE = (() => {
  try {
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
    return (env?.BASE_URL || "/").replace(/\/$/, "");
  } catch {
    return "";
  }
})();

export type SymbolFreshness = "FRESH" | "STALE" | "MISSING";

export interface Mt5SymbolView {
  symbol: string;                 // ARX-facing key
  brokerSymbol: string | null;    // EXACT broker string — use this for execution
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

export interface Mt5SymbolsResponse {
  ok: boolean;
  count: number;
  overallFreshness: SymbolFreshness;
  symbols: Mt5SymbolView[];
}

/**
 * The user's EA-reported symbol inventory. Empty/MISSING until the EA has run
 * ENUMERATE_SYMBOLS against the connected terminal. Never returns a mock list.
 */
export function useMt5Symbols(opts: { includeStale?: boolean; tradableOnly?: boolean } = {}) {
  const params = new URLSearchParams();
  if (opts.includeStale) params.set("includeStale", "1");
  if (opts.tradableOnly) params.set("tradableOnly", "1");
  const qs = params.toString();
  return useQuery<Mt5SymbolsResponse>({
    queryKey: ["mt5-symbols", opts.includeStale ?? false, opts.tradableOnly ?? false],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8_000);
      try {
        const r = await fetch(`${BASE}/api/me/mt5/symbols${qs ? `?${qs}` : ""}`, {
          credentials: "include",
          signal: ctrl.signal,
        });
        if (!r.ok) return { ok: false, count: 0, overallFreshness: "MISSING", symbols: [] };
        const j = (await r.json()) as any;
        return {
          ok: !!j?.ok,
          count: typeof j?.count === "number" ? j.count : 0,
          overallFreshness: (j?.overallFreshness as SymbolFreshness) ?? "MISSING",
          symbols: Array.isArray(j?.symbols) ? (j.symbols as Mt5SymbolView[]) : [],
        };
      } catch {
        return { ok: false, count: 0, overallFreshness: "MISSING", symbols: [] };
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

// ─── Merged symbol universe (picker) ────────────────────────────────────────
// /api/me/symbols returns the approved ARX Focus universe (always present, so
// the picker never goes dark) enriched with the broker's enumerated metadata.
// `tradeable` is honest — true only when the broker enumerated the instrument
// AND reported it tradable; everything else carries
// executionRequiresBrokerConfirmation. This is display/scanner only; execution
// re-gates at the trade ticket.

export type ResolvedSymbolSource = "shared_bridge" | "enumerated" | "default";

export interface ResolvedSymbol {
  symbol: string;
  displayName: string;
  brokerSymbol: string | null;
  market: string;
  category: string;
  source: ResolvedSymbolSource;
  tradeable: boolean;
  scannerEnabled: boolean;
  candlesEnabled: boolean;
  executionRequiresBrokerConfirmation: boolean;
  freshness: SymbolFreshness;
}

export interface ResolvedSymbolsResponse {
  ok: boolean;
  symbols: ResolvedSymbol[];
  sourceSummary: {
    sharedBridge: number;
    enumerated: number;
    defaults: number;
  };
  warnings: string[];
  enumerationStatus: {
    available: boolean;
    count: number;
    lastEnumeratedAt: string | null;
  };
}

const EMPTY_RESOLVED: ResolvedSymbolsResponse = {
  ok: false,
  symbols: [],
  sourceSummary: {
    sharedBridge: 0,
    enumerated: 0,
    defaults: 0,
  },
  warnings: [],
  enumerationStatus: { available: false, count: 0, lastEnumeratedAt: null },
};

/**
 * The merged approved+enumerated symbol universe for the picker. Always returns
 * the approved markets (EURUSD, V75, …) even before the EA enumerates, so the
 * picker is never empty.
 */
export function useResolvedSymbols() {
  return useQuery<ResolvedSymbolsResponse>({
    queryKey: ["resolved-symbols"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8_000);
      try {
        const r = await fetch(`${BASE}/api/me/symbols`, {
          credentials: "include",
          signal: ctrl.signal,
        });
        if (!r.ok) return EMPTY_RESOLVED;
        const j = (await r.json()) as Partial<ResolvedSymbolsResponse> | null;
        return {
          ok: !!j?.ok,
          symbols: Array.isArray(j?.symbols) ? (j!.symbols as ResolvedSymbol[]) : [],
          sourceSummary: j?.sourceSummary ?? EMPTY_RESOLVED.sourceSummary,
          warnings: Array.isArray(j?.warnings) ? (j!.warnings as string[]) : [],
          enumerationStatus: j?.enumerationStatus ?? EMPTY_RESOLVED.enumerationStatus,
        };
      } catch {
        return EMPTY_RESOLVED;
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

// ─── Manual typed-symbol resolution ─────────────────────────────────────────
export type SymbolResolution =
  | { ok: true; brokerSymbol: string; matched: Mt5SymbolView }
  | { ok: false; reasonCode: "SYMBOL_NOT_FOUND"; requested: string }
  | { ok: false; reasonCode: "SYMBOL_AMBIGUOUS"; requested: string; candidates: Mt5SymbolView[] }
  | { ok: false; reasonCode: "NO_BROKER_SYMBOL"; requested: string; matched: Mt5SymbolView }
  | { ok: false; reasonCode: "RESOLVE_ERROR"; requested: string };

/**
 * Resolve a user-typed label to an exact brokerSymbol via the backend.
 * Imperative (call on submit / on blur), not a hook — so callers control when.
 * NEVER returns a default symbol; on no match it returns SYMBOL_NOT_FOUND, and
 * on multiple matches it returns the candidate list for the user to choose.
 */
export async function resolveBrokerSymbol(typed: string): Promise<SymbolResolution> {
  const requested = (typed ?? "").trim();
  if (!requested) return { ok: false, reasonCode: "SYMBOL_NOT_FOUND", requested };
  try {
    const r = await fetch(`${BASE}/api/me/mt5/resolve-symbol`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: requested }),
    });
    const j = (await r.json()) as any;
    if (j?.ok && j?.resolution?.ok) {
      return { ok: true, brokerSymbol: j.resolution.brokerSymbol, matched: j.resolution.matched };
    }
    // Backend returns { ok:false, reasonCode, ... } for not-found/ambiguous.
    if (j?.reasonCode === "SYMBOL_AMBIGUOUS") {
      return { ok: false, reasonCode: "SYMBOL_AMBIGUOUS", requested, candidates: j.candidates ?? [] };
    }
    if (j?.reasonCode === "NO_BROKER_SYMBOL") {
      return { ok: false, reasonCode: "NO_BROKER_SYMBOL", requested, matched: j.matched };
    }
    return { ok: false, reasonCode: "SYMBOL_NOT_FOUND", requested };
  } catch {
    return { ok: false, reasonCode: "RESOLVE_ERROR", requested };
  }
}

/** Convenience: find a symbol view by ARX key or broker string within an inventory. */
export function findSymbol(symbols: Mt5SymbolView[], key: string): Mt5SymbolView | null {
  const k = key.trim().toUpperCase();
  return symbols.find((s) =>
    s.symbol.toUpperCase() === k ||
    (s.brokerSymbol && s.brokerSymbol.toUpperCase() === k) ||
    (s.displaySymbol && s.displaySymbol.toUpperCase() === k)) ?? null;
}
