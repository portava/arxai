import { useCallback, useMemo, useState } from "react";
import {useUnifiedPositions} from "./useUnifiedPositions";
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
    const tag = p.accountMode === "LIVE" ? "Reported LIVE account" : "Reported DEMO account";
    const side = p.side;
    const arrow = side === "BUY" ? "▲" : side === "SELL" ? "▼" : "";

    if (p.entryPrice != null && Number.isFinite(p.entryPrice) && p.entryPrice > 0) {
      overlays.push({
        id: `pos-${key}-entry`,
        type: "line",
        symbol,
        price: p.entryPrice,
        label: `${tag} ${side ?? "Side unknown"} ${arrow} Entry`,
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
        label: `${tag} last price`,
        severity: "neutral",
        source: "position",
        style: "dashed",
        lineWidth: 1,
        // The renderer reads `pnl` here to draw a floating P/L bubble.
        metadata: { brokerTicket: p.brokerTicket, side, mode: tag, pnl: p.floatingPnl, observationTimeVerified:false, currencyVerified:false, reported:true },
      });
    }
    if (side && p.entryPrice != null && Number.isFinite(p.entryPrice) && p.entryPrice > 0) {
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
  const {data,reload,resolveCurrentPosition,userId}=useUnifiedPositions();
  const positions=useMemo(()=>[...(data?.live??[]),...(data?.demo??[])],[data]);
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

  const symbolPositions = useMemo(
    () => positions.filter((p) => normSym(p.symbol) === normSym(normalized)),
    [positions, normalized],
  );

  const overlays = useMemo(
    () => buildPositionOverlays(symbolPositions, normalized),
    [symbolPositions, normalized],
  );


  // Gated full-close. Mirrors ScannerChartPanel: every action goes through the
  // Global Instant Trade Router, which re-runs the full server-side gate set.
  // We acknowledge dispatch honestly ("sent to bridge") — never claim the broker
  // has executed from a mere accept — and surface the server's refusal verbatim.
  const closePosition = useCallback(async (p: ChartPosition) => {
    const current=resolveCurrentPosition(p);
    if (!current?.brokerTicket || !tradeMode || current.scope!==tradeMode) return;
    setBusyTicket(current.brokerTicket);
    try {
      const res = await executeInstantTrade({
        source: "chart",
        action: "CLOSE",
        accountMode: tradeMode,
        positionId: current.brokerTicket,
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
      reload();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Close failed",
        description: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setBusyTicket(null);
    }
  }, [tradeMode, canTrade, toast, resolveCurrentPosition, reload, userId]);

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
