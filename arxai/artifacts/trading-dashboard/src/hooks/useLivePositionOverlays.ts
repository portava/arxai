import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bareSymbol } from "@/lib/use-chart-symbol";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useToast } from "@/hooks/use-toast";
import { humanizeReason } from "@/lib/humanize";
import { executeInstantTrade } from "@/lib/instantTradeRouter";
import { resolveLiveActionCapabilities } from "@/lib/liveActionCapabilities";
import type { ChartOverlay } from "@/lib/chart-overlays";

// useLivePositionOverlays — Level 4 trade-overlay data source.
//
// Reuses the EXISTING per-user live-position endpoint (/api/me/positions/all,
// server-scoped to the calling user, returning {live:[],demo:[]}) — exactly the
// same source ScannerChartPanel already trusts. No new position service.
//
// It does TWO things and nothing else:
//   1. Builds read-only ChartOverlay[] for the chart (entry / SL / TP / mark
//      lines, a direction marker, and a P/L bubble carried in metadata).
//   2. Exposes a gated `closePosition()` that routes through the SAME backend
//      instant-trade path (executeInstantTrade, source:"chart", action:"CLOSE")
//      as every other surface — re-running all server gates. There is NO
//      chart-only execution path here, and closing stays a reduce-only action.
//
// SAFETY: when the fetch fails we render NOTHING (no fake positions, no fake
// lines). The chart and any separate position UI keep working independently.

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

export type ChartPosition = {
  scope: "demo" | "live";
  brokerTicket: string | null;
  symbol: string | null;
  side: "BUY" | "SELL" | null;
  lotSize: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  floatingPnl: number | null;
  accountMode: "DEMO" | "LIVE";
};

// Strip exchange prefixes/suffixes so "EURUSD", "FX:EURUSD" and "EURUSD.r" all
// compare equal to the chart symbol.
function normSym(s: string | null | undefined): string {
  if (!s) return "";
  const bare = s.includes(":") ? s.split(":")[1]! : s;
  return bare.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Build read-only overlays for a single symbol's open positions. Each position
 * contributes: an entry line (with a direction arrow), SL/TP lines when present,
 * a dashed "mark" line at the broker's current price carrying floating P/L in
 * metadata (the renderer turns that into a P/L bubble), and a direction marker.
 */
export function buildPositionOverlays(
  positions: ChartPosition[],
  symbol: string,
): ChartOverlay[] {
  const overlays: ChartOverlay[] = [];
  positions.forEach((p, i) => {
    const key = p.brokerTicket ?? `${p.accountMode}-${i}`;
    const tag = p.accountMode === "LIVE" ? "LIVE" : "DEMO";
    const side = p.side ?? "BUY";
    const arrow = side === "BUY" ? "▲" : "▼";

    if (p.entryPrice != null && Number.isFinite(p.entryPrice) && p.entryPrice > 0) {
      overlays.push({
        id: `pos-${key}-entry`,
        type: "line",
        symbol,
        price: p.entryPrice,
        label: `${tag} ${side} ${arrow} Entry`,
        severity: "info",
        source: "position",
        color: side === "BUY" ? "#3b82f6" : "#a855f7",
        style: "solid",
        lineWidth: 2,
        metadata: { brokerTicket: p.brokerTicket, side, mode: tag, primary: true },
      });
    }
    if (p.stopLoss != null && Number.isFinite(p.stopLoss) && p.stopLoss > 0) {
      overlays.push({
        id: `pos-${key}-sl`,
        type: "line",
        symbol,
        price: p.stopLoss,
        label: `${tag} SL`,
        severity: "danger",
        source: "position",
        style: "dashed",
        lineWidth: 2,
        metadata: { brokerTicket: p.brokerTicket, role: "invalidation" },
      });
    }
    if (p.takeProfit != null && Number.isFinite(p.takeProfit) && p.takeProfit > 0) {
      overlays.push({
        id: `pos-${key}-tp`,
        type: "line",
        symbol,
        price: p.takeProfit,
        label: `${tag} TP`,
        severity: "success",
        source: "position",
        style: "dashed",
        lineWidth: 2,
        metadata: { brokerTicket: p.brokerTicket, role: "target" },
      });
    }
    if (p.currentPrice != null && Number.isFinite(p.currentPrice) && p.currentPrice > 0) {
      overlays.push({
        id: `pos-${key}-mark`,
        type: "line",
        symbol,
        price: p.currentPrice,
        label: `${tag} Mark`,
        severity: "neutral",
        source: "position",
        style: "dashed",
        lineWidth: 1,
        // The renderer reads `pnl` here to draw a floating P/L bubble.
        metadata: { brokerTicket: p.brokerTicket, side, mode: tag, pnl: p.floatingPnl },
      });
    }
    if (p.entryPrice != null && Number.isFinite(p.entryPrice) && p.entryPrice > 0) {
      overlays.push({
        id: `pos-${key}-marker`,
        type: "marker",
        symbol,
        price: p.entryPrice,
        label: `${side} @ ${p.entryPrice}`,
        severity: side === "BUY" ? "success" : "danger",
        source: "position",
        marker: { side },
        metadata: { brokerTicket: p.brokerTicket, side },
      });
    }
  });
  return overlays;
}

export interface UseLivePositionOverlaysResult {
  /** Read-only overlays for the chart renderer. */
  overlays: ChartOverlay[];
  /** The symbol's open positions (for an optional legend / close panel). */
  positions: ChartPosition[];
  /** Number of open positions on this symbol. */
  positionCount: number;
  /** True when a real (live/demo) account can submit a gated action. */
  canTrade: boolean;
  /** brokerTicket currently being closed (for button busy state), else null. */
  busyTicket: string | null;
  /** Honest reason trading is unavailable, when canTrade is false. */
  noTradeReason: string | null;
  /** Gated full-close. Routes through executeInstantTrade(source:"chart"). */
  closePosition: (p: ChartPosition) => Promise<void>;
  /** Force an immediate positions refresh. */
  reload: () => void;
}

/**
 * Source live-position overlays for a chart symbol. The symbol is normalised the
 * same way ARXNativeChart normalises its incoming symbol, so overlays line up
 * with the rendered candles.
 */
export function useLivePositionOverlays(symbol: string): UseLivePositionOverlaysResult {
  const normalized = useMemo(
    () => bareSymbol(symbol || "").toUpperCase(),
    [symbol],
  );
  const [positions, setPositions] = useState<ChartPosition[]>([]);
  const [reloadAt, setReloadAt] = useState(0);
  const [busyTicket, setBusyTicket] = useState<string | null>(null);

  const mode = useTradingMode();
  const { toast } = useToast();

  const tradeMode: "live" | "demo" | null = mode.isLiveShared
    ? "live"
    : mode.isDemo
      ? "demo"
      : null;
  const canTrade =
    tradeMode != null &&
    resolveLiveActionCapabilities({
      canManualTrade: mode.canManualTrade,
      isFrozen: mode.isFrozen,
    }).canOpen;
  const noTradeReason = canTrade
    ? null
    : tradeMode == null
      ? "Trading is not available for this account mode."
      : "Manual trading is currently blocked for your account.";

  // Poll the per-user positions endpoint; pause while the tab is hidden.
  useEffect(() => {
    if (!normalized) {
      setPositions([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(u("/api/me/positions/all"), { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null));
        if (cancelled) return;
        const live = Array.isArray(res?.live) ? (res.live as ChartPosition[]) : [];
        const demo = Array.isArray(res?.demo) ? (res.demo as ChartPosition[]) : [];
        setPositions([...live, ...demo]);
      } catch {
        // Honest empty on failure — never fabricate positions.
        if (!cancelled) setPositions([]);
      }
    };
    void load();
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (id == null) id = setInterval(load, 10_000); };
    const stop = () => { if (id != null) { clearInterval(id); id = null; } };
    const onVis = () => { if (document.hidden) stop(); else { void load(); start(); } };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [normalized, reloadAt]);

  const symbolPositions = useMemo(
    () => positions.filter((p) => normSym(p.symbol) === normSym(normalized)),
    [positions, normalized],
  );

  const overlays = useMemo(
    () => buildPositionOverlays(symbolPositions, normalized),
    [symbolPositions, normalized],
  );

  const reload = useCallback(() => setReloadAt(Date.now()), []);

  // Gated full-close. Mirrors ScannerChartPanel: every action goes through the
  // Global Instant Trade Router, which re-runs the full server-side gate set.
  // We acknowledge dispatch honestly ("sent to bridge") — never claim the broker
  // has executed from a mere accept — and surface the server's refusal verbatim.
  const closePosition = useCallback(async (p: ChartPosition) => {
    if (!p.brokerTicket || !tradeMode) return;
    setBusyTicket(p.brokerTicket);
    try {
      const res = await executeInstantTrade({
        source: "chart",
        action: "CLOSE",
        accountMode: tradeMode,
        positionId: p.brokerTicket,
        oneClick: true,
      });
      if (!res.ok) {
        const h = humanizeReason(res.primaryReason || res.error);
        toast({ variant: "destructive", title: "Close blocked", description: h.description });
        return;
      }
      toast({
        title: "Close sent to bridge",
        description: "Waiting for the broker to confirm. Check Open Positions or Trade Logs for the final result.",
      });
      setReloadAt(Date.now());
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Close failed",
        description: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setBusyTicket(null);
    }
  }, [tradeMode, toast]);

  return {
    overlays,
    positions: symbolPositions,
    positionCount: symbolPositions.length,
    canTrade,
    busyTicket,
    noTradeReason,
    closePosition,
    reload,
  };
}
