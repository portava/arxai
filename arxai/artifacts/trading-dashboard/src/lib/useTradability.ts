// Tiny client wrapper around /api/market-data/tradability — single source
// of truth that every UI surface (trade ticket, scanner card, Ruby panel)
// reads so they never drift apart.
import { useQuery } from "@tanstack/react-query";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export type TradabilityState = "yes" | "no" | "unknown";
export type DataProviderLabel = "deriv" | "external" | "unknown";

export interface SymbolTradability {
  ok: true;
  symbol: string;
  assetClass: string;
  dataProvider: DataProviderLabel;
  dataAvailable: boolean;
  mt5Tradable: TradabilityState;
  executionProvider: "mt5" | "none";
  liveExecutionAllowed: boolean;
  badgeLabel: "Tradable via MT5" | "Data-only via Deriv" | "Analysis only" | "Tradability not verified";
  userMessage: string;
}

export function useTradability(symbol: string | null | undefined) {
  const s = (symbol ?? "").trim().toUpperCase();
  return useQuery<SymbolTradability | null>({
    queryKey: ["tradability", s],
    enabled: s.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    // Retry a single time on transient failure, then surface a stable
    // null verdict so the badge doesn't sit on "Checking tradability…"
    // forever when the upstream provider is slow or unreachable.
    retry: 1,
    queryFn: async () => {
      // Hard 8s ceiling — the tradability endpoint should answer in well
      // under a second; if it doesn't, we'd rather render "Tradability
      // not verified" than an infinite loading badge.
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8_000);
      try {
        const r = await fetch(`${BASE}/api/market-data/tradability?symbol=${encodeURIComponent(s)}`, {
          credentials: "include",
          signal: ctrl.signal,
        });
        if (!r.ok) return null;
        const j = await r.json();
        if (!j?.ok) return null;
        return j as SymbolTradability;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
