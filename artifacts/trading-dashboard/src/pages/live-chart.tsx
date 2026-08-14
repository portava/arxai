import { useCallback, useState } from "react";
import TradingViewLiveChart from "@/components/charts/TradingViewLiveChart";
import {
  ARXNativeChart,
  type ArxTimeframe,
} from "@/components/charts/ARXNativeChart";
import { CHART_ENGINE_DESCRIPTORS, DEFAULT_CHART_ENGINE_ID } from "@/lib/chart-engine";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartPositionOverlayPanel } from "@/components/charts/ChartPositionOverlayPanel";
import { ChartAiOverlayPanel } from "@/components/charts/ChartAiOverlayPanel";
import { ChartSetupPreviewPanel } from "@/components/charts/ChartSetupPreviewPanel";
import { ChartModes } from "@/components/charts/ChartModes";
import { ChartTradeEntry, type ChartTradePrefill } from "@/components/charts/ChartTradeEntry";
import { PositionPickerPanel } from "@/components/positions/PositionPickerPanel";
import { useLivePositionOverlays } from "@/hooks/useLivePositionOverlays";
import { useAiChartOverlays } from "@/hooks/useAiChartOverlays";
import { useChartSetupPreview } from "@/hooks/useChartSetupPreview";
import type { SetupPreview } from "@/lib/setup-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CandlestickChart, BarChart3 } from "lucide-react";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useProductRole } from "@/hooks/useProductRole";
import { useChartSymbol } from "@/lib/use-chart-symbol";

type ChartView = "tv" | "native";

// ─────────────────────────────────────────────────────────────────────────────
// Smart Chart Shell (Task #373).
//
// This page is the Shell PARENT CONTROLLER: it owns ALL chart state and
// intelligence — the symbol (shared bus), the timeframe (controlled), the chart
// context + intelligence snapshot, the read-only position + AI overlays, and the
// role gating — and drives the chart RENDERER (ARX Native, which renders through
// the swappable chart-engine adapter). The TradingView reference remains a
// labeled toggle. The actual rendering engine is pluggable behind the adapter;
// the Shell never touches engine-specific code.
//
// SAFETY: the Shell is view + state only. The single trade-entry surface
// (ChartTradeEntry) still routes through the gated instant-trade router; the
// Shell merely hides it from view-only (investor) roles. Logged-out access is
// handled upstream by the route guard.
// ─────────────────────────────────────────────────────────────────────────────

export default function LiveChartPage() {
  const mode = useTradingMode();
  // Effective product role for gating the trade-entry surface. Investors are
  // view-only and must never see a trade ticket; while identity resolves we keep
  // the ticket hidden (fail-safe) rather than flashing it to an investor.
  const { isInvestor, isLoading: roleLoading } = useProductRole();
  const canSeeTradeEntry = !isInvestor && !roleLoading;
  // The active rendering engine descriptor (lightweight-charts today). Surfaced
  // as a small label so the Shell is honest about which engine is drawing and so
  // a future engine swap is visible without code spelunking.
  const activeEngine = CHART_ENGINE_DESCRIPTORS[DEFAULT_CHART_ENGINE_ID];
  // TradingView is the proven default; ARX Native is shown beside it for the
  // user to opt into. The chart-symbol bus is shared so switching views keeps
  // the same instrument.
  const [chartView, setChartView] = useState<ChartView>("tv");
  const [chartSymbol] = useChartSymbol();
  // The Shell owns the timeframe (controlled). The Native renderer reflects this
  // value and reports user changes back via onTimeframeChange, so the Shell — not
  // the renderer — is the single source of truth for the timeframe on screen.
  const [timeframe, setTimeframe] = useState<ArxTimeframe>("M15");
  const onTimeframeChange = useCallback((tf: ArxTimeframe) => setTimeframe(tf), []);
  // Level 4 — read-only open-position overlays for the ARX Native chart, sourced
  // from the existing per-user live-position endpoint. Always called (hooks rule)
  // but only consumed by the native view; the panel renders nothing when empty.
  const overlayData = useLivePositionOverlays(chartSymbol);
  // Level 5 — the chart reports its resolved symbol/timeframe + the Level 3
  // aiUsable verdict here so we can source AI overlays against the exact
  // instrument on screen and suppress them on an unconfirmed feed. Defaults are
  // conservative (aiUsable=false) until the chart reports a clean feed.
  const [chartCtx, setChartCtx] = useState<{
    symbol: string;
    timeframe: string;
    aiUsable: boolean;
  }>({ symbol: chartSymbol || "", timeframe, aiUsable: false });
  const aiOverlays = useAiChartOverlays(chartCtx);
  // Task #374 — AI/Ruby setup-preview drawing for the exact instrument on
  // screen. User-initiated, suppressed on an unconfirmed feed, mapped through
  // the bounded chart-command contract into pure `source:"preview"` overlays.
  const setupPreview = useChartSetupPreview({
    symbol: chartCtx.symbol || chartSymbol || "",
    timeframe: chartCtx.timeframe || timeframe,
    aiUsable: chartCtx.aiUsable,
  });
  // "Use this setup" prefill for the gated trade ticket. Token bumps on each
  // pick so re-using the same setup re-applies. A prefill only OPENS + fills the
  // ticket — the user still confirms and every server gate runs.
  const [tradePrefill, setTradePrefill] = useState<ChartTradePrefill | null>(null);
  const onUseSetup = useCallback(
    (preview: SetupPreview) => {
      if (!preview.levels || !preview.side) return;
      // Honesty: tell the user exactly where these pre-filled levels came from
      // (AI setup preview, setup type, confidence, and the feed-trust basis the
      // drawing was produced against) so the ticket never hides their origin.
      const sourceNote =
        `From AI setup preview — ${preview.setupType}, ` +
        `${preview.confidence.label} confidence · ${preview.dataFreshness.trustLine}`;
      setTradePrefill((prev) => ({
        token: (prev?.token ?? 0) + 1,
        side: preview.side as "BUY" | "SELL",
        stopLoss: preview.levels!.sl,
        takeProfit: preview.levels!.tp,
        sourceNote,
      }));
      // Advance the drawing's ephemeral lifecycle to user_confirmed — the user
      // has acted on this preview. This is purely client-side state for the
      // drawing; it never places an order (the gated ticket still requires an
      // explicit Confirm and every server gate runs on dispatch).
      setupPreview.confirm();
    },
    [setupPreview],
  );
  const onChartContextChange = useCallback(
    (ctx: { symbol: string; timeframe: string; aiUsable: boolean }) =>
      setChartCtx(ctx),
    [],
  );
  // Chart Brain v2 — hold the latest centralized Chart Intelligence State,
  // captured non-blocking from the chart's separate fetch. Task 3 renders it
  // through the Chart Pulse + Chart Modes panels below the native chart. The
  // state-driven panels never block candle render or live execution.
  const [chartIntelligence, setChartIntelligence] =
    useState<ChartIntelligenceResponse["state"] | null>(null);
  const onIntelligenceChange = useCallback(
    (state: ChartIntelligenceResponse["state"]) => setChartIntelligence(state),
    [],
  );
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 p-4 md:p-6 pb-32 md:pb-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold leading-tight">
          Live Market Chart
          {mode.envelope && (
            <Badge variant="outline" className="text-[10px]" data-testid="chart-mode-badge">{mode.cleanModeLabel}</Badge>
          )}
        </h1>
        <p className="text-sm text-txt-secondary">
          {chartView === "tv"
            ? "TradingView Advanced Real-Time Chart. Symbols, intervals, indicators, and watchlist available below."
            : "ARX Native chart — candles served directly by the ARX market-data contract. Switch back to TradingView anytime."}
        </p>
      </div>
      <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1" role="tablist" data-testid="chart-view-toggle">
        <Button
          size="sm"
          variant={chartView === "tv" ? "default" : "ghost"}
          className="h-8 px-3 text-xs"
          onClick={() => setChartView("tv")}
          role="tab"
          aria-selected={chartView === "tv"}
          data-testid="chart-view-tv"
        >
          <BarChart3 className="mr-1.5 h-3.5 w-3.5" /> TradingView Reference
        </Button>
        <Button
          size="sm"
          variant={chartView === "native" ? "default" : "ghost"}
          className="h-8 px-3 text-xs"
          onClick={() => setChartView("native")}
          role="tab"
          aria-selected={chartView === "native"}
          data-testid="chart-view-native"
        >
          <CandlestickChart className="mr-1.5 h-3.5 w-3.5" /> ARX Native
        </Button>
      </div>
      <div className="flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 text-warning" />
        <p>
          {mode.isLiveShared
            ? <>Live chart active. The chart itself is read-only — orders only dispatch after you <strong>review and confirm</strong> in the trade ticket, and every server safety check still applies.</>
            : <>Read-only chart. The trade ticket on this page still requires your confirmation, and in {mode.cleanModeLabel} no real broker order is placed.</>}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        {chartView === "tv" ? (
          <TradingViewLiveChart defaultSymbol={chartSymbol || "V75"} height={680} />
        ) : (
          <div className="space-y-4">
            <ARXNativeChart
              symbol={chartSymbol}
              mode={mode.cleanModeLabel}
              timeframe={timeframe}
              onTimeframeChange={onTimeframeChange}
              height={680}
              showFeedStatus
              showFallbackToggle
              onRequestFallback={() => setChartView("tv")}
              overlays={[...overlayData.overlays, ...aiOverlays.overlays, ...setupPreview.overlays]}
              onChartContextChange={onChartContextChange}
              onIntelligenceChange={onIntelligenceChange}
            />
            <p className="text-[10px] text-txt-secondary" data-testid="chart-engine-label">
              Rendering engine: {activeEngine.label}
            </p>
            <ChartPositionOverlayPanel symbol={chartSymbol} data={overlayData} />
            <ChartAiOverlayPanel data={aiOverlays} />
            <ChartSetupPreviewPanel
              data={setupPreview}
              canUseSetup={canSeeTradeEntry}
              onUseSetup={onUseSetup}
            />
            <ChartModes state={chartIntelligence} />
          </div>
        )}
        <div className="space-y-4">
          {/* Trade entry is the single gated order surface. Hidden from view-only
              (investor) roles and while identity resolves; placement itself still
              routes through the server-side instant-trade router + 16-gate. */}
          {canSeeTradeEntry && <ChartTradeEntry prefill={tradePrefill} />}
          <PositionPickerPanel />
        </div>
      </div>
    </div>
  );
}
