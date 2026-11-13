import { useCallback, useEffect, useState } from "react";
import { SmartChartLayout } from "@/components/charts/SmartChartLayout";
import { readChartStorage, writeChartStorage } from "@/lib/chart-engine/chartWorkspace";
import { restoreChartInterval } from "@/lib/chart-engine/chartIntervals";
import {
  ARXNativeChart,
  type ArxTimeframe,
} from "@/components/charts/ARXNativeChart";
import { CHART_ENGINE_DESCRIPTORS, DEFAULT_CHART_ENGINE_ID } from "@/lib/chart-engine";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartPositionOverlayPanel } from "@/components/charts/ChartPositionOverlayPanel";
import { LivePendingOrders } from "@/components/live/LivePendingOrders";
import { ChartAiOverlayPanel } from "@/components/charts/ChartAiOverlayPanel";
import { ChartSetupPreviewPanel } from "@/components/charts/ChartSetupPreviewPanel";
import { ChartDecisionReceiptsPanel } from "@/components/charts/ChartDecisionReceiptsPanel";
import { ChartModes } from "@/components/charts/ChartModes";
import { ChartTradeEntry, type ChartTradePrefill } from "@/components/charts/ChartTradeEntry";
import { OneClickTradePanel } from "@/components/oneclick/OneClickTradePanel";
import { PositionPickerPanel } from "@/components/positions/PositionPickerPanel";
import { useLivePositionOverlays } from "@/hooks/useLivePositionOverlays";
import { useAiChartOverlays } from "@/hooks/useAiChartOverlays";
import { useChartSetupPreview } from "@/hooks/useChartSetupPreview";
import type { SetupPreview } from "@/lib/setup-preview";
import { useTradingMode } from "@/hooks/useTradingMode";
import { LiveChartModeNotice } from "@/components/charts/LiveChartModeNotice";
import { useProductRole } from "@/hooks/useProductRole";
import { bareSymbol, useChartSymbol } from "@/lib/use-chart-symbol";
import { PageTabs } from "@/components/ui/PageTabs";

// ─────────────────────────────────────────────────────────────────────────────
// Smart Chart Shell (Task #373).
//
// This page is the Shell PARENT CONTROLLER: it owns ALL chart state and
// intelligence — the symbol (shared bus), the timeframe (controlled), the chart
// context + intelligence snapshot, the read-only position + AI overlays, and the
// role gating — and drives the chart RENDERER (ARX Native, which renders through
// the swappable chart-engine adapter). The actual rendering engine is pluggable behind the adapter;
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
  // The active first-party rendering engine descriptor. Surfaced
  // as a small label so the Shell is honest about which engine is drawing and so
  // a future engine swap is visible without code spelunking.
  const activeEngine = CHART_ENGINE_DESCRIPTORS[DEFAULT_CHART_ENGINE_ID];
  const [chartSymbol] = useChartSymbol();
  // The Shell owns the timeframe (controlled). The Native renderer reflects this
  // value and reports user changes back via onTimeframeChange, so the Shell — not
  // the renderer — is the single source of truth for the timeframe on screen.
  const [timeframe, setTimeframe] = useState<ArxTimeframe>(()=>{
    const saved=readChartStorage("arx.chart.primaryTimeframe.v1");
    return restoreChartInterval(saved);
  });
  useEffect(()=>{writeChartStorage("arx.chart.primaryTimeframe.v1",timeframe);},[timeframe]);
  const [chartHeight, setChartHeight] = useState(() =>
    typeof window === "undefined" ? 500 : Math.min(560, Math.max(390, Math.floor(window.innerHeight * 0.62))),
  );
  useEffect(() => {
    const updateHeight = () =>
      setChartHeight(Math.min(560, Math.max(390, Math.floor(window.innerHeight * 0.62))));
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);
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
  // Task #374 — AI/Eleanor setup-preview drawing for the exact instrument on
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
  // The chart only reports a state once one matches its instrument, so the
  // last one held here can belong to the previous symbol/timeframe. Show it
  // only for the instrument on screen (same normalisation as the chart);
  // otherwise the panels show their waiting state until the new read lands.
  const onScreenSymbol = bareSymbol(chartSymbol || "EURUSD").toUpperCase();
  const shownIntelligence =
    chartIntelligence != null
    && chartIntelligence.symbol === onScreenSymbol
    && chartIntelligence.timeframe === timeframe
      ? chartIntelligence
      : null;
  return (
    <div
      className="mx-auto w-full max-w-[1600px] space-y-3 p-2 sm:p-3 md:p-4 pb-24 md:pb-4"
      data-testid="smart-chart-primary-workspace"
    >
      <h1 className="sr-only">Smart Chart</h1>
      {canSeeTradeEntry && <div className="flex justify-end lg:hidden">
        <a
          href="#chart-order-ticket"
          className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-xs font-semibold text-primary"
          data-testid="link-jump-order-ticket"
        >Jump to order ticket</a>
      </div>}
      <div className={`grid min-w-0 gap-3 ${canSeeTradeEntry ? "lg:grid-cols-[minmax(0,1fr)_320px]" : "grid-cols-1"}`}>
        <section className="min-w-0" aria-label="ARX Smart Chart">
          <SmartChartLayout symbol={chartSymbol} primaryTimeframe={timeframe}>
            <ARXNativeChart
              symbol={chartSymbol}
              mode={mode.cleanModeLabel}
              timeframe={timeframe}
              onTimeframeChange={onTimeframeChange}
              height={chartHeight}
              mobileHeight={360}
              compactWorkspace
              showFeedStatus
              overlays={[...overlayData.overlays, ...aiOverlays.overlays, ...setupPreview.overlays]}
              onChartContextChange={onChartContextChange}
              onIntelligenceChange={onIntelligenceChange}
            />
          </SmartChartLayout>
        </section>
        {canSeeTradeEntry && <aside
          id="chart-order-ticket"
          className="min-w-0 scroll-mt-24"
          aria-label="Reviewed order ticket"
          data-testid="chart-order-ticket"
        >
          <ChartTradeEntry prefill={tradePrefill} timeframe={timeframe} />
        </aside>}
      </div>
      <PageTabs
        storageKey="chart-workspace-details"
        defaultTab="analysis"
        variant="pill"
        tabs={[
          {
            id: "analysis",
            label: "Eleanor & analysis",
            content: <div className="space-y-3">
              <ChartModes state={shownIntelligence} />
              <ChartSetupPreviewPanel data={setupPreview} canUseSetup={canSeeTradeEntry} onUseSetup={onUseSetup} />
              {canSeeTradeEntry && <ChartDecisionReceiptsPanel
                symbol={bareSymbol(chartCtx.symbol || chartSymbol || "").toUpperCase()}
                timeframe={chartCtx.timeframe || timeframe}
              />}
            </div>,
          },
          {
            id: "positions",
            label: "Positions & orders",
            content: <div className="space-y-3">
              <ChartPositionOverlayPanel symbol={chartSymbol} data={overlayData} />
              <LivePendingOrders symbol={chartSymbol} enabled={mode.isLiveShared} compact />
              <PositionPickerPanel />
            </div>,
          },
          {
            id: "layers",
            label: "Chart layers",
            content: <ChartAiOverlayPanel data={aiOverlays} />,
          },
          {
            id: "status",
            label: "Trading & status",
            content: <div className="space-y-3">
              {canSeeTradeEntry && <OneClickTradePanel
                symbol={bareSymbol(chartSymbol)}
                positions={overlayData.positions}
                onPositionsChanged={overlayData.reload}
              />}
              <LiveChartModeNotice mode={mode} />
              <p className="text-[10px] text-txt-secondary" data-testid="chart-engine-label">
                Rendering engine: {activeEngine.label}
              </p>
            </div>,
          },
        ]}
      />
    </div>
  );
}
