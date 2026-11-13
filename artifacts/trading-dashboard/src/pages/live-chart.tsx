import { useCallback, useState } from "react";
import {
  ARXNativeChart,
  type ArxTimeframe,
} from "@/components/charts/ARXNativeChart";
import {
  CHART_ENGINE_DESCRIPTORS,
  DEFAULT_CHART_ENGINE_ID,
} from "@/lib/chart-engine";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartPositionOverlayPanel } from "@/components/charts/ChartPositionOverlayPanel";
import { ChartAiOverlayPanel } from "@/components/charts/ChartAiOverlayPanel";
import { ChartSetupPreviewPanel } from "@/components/charts/ChartSetupPreviewPanel";
import { ChartModes } from "@/components/charts/ChartModes";
import {
  ChartTradeEntry,
  type ChartTradePrefill,
} from "@/components/charts/ChartTradeEntry";
import { PositionPickerPanel } from "@/components/positions/PositionPickerPanel";
import { useLivePositionOverlays } from "@/hooks/useLivePositionOverlays";
import { useAiChartOverlays } from "@/hooks/useAiChartOverlays";
import { useChartSetupPreview } from "@/hooks/useChartSetupPreview";
import type { SetupPreview } from "@/lib/setup-preview";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useProductRole } from "@/hooks/useProductRole";
import { PageTabs } from "@/components/ui/PageTabs";
import { SymbolPicker } from "@/components/layout/SymbolPicker";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import {
  toApiTimeframe,
  normalizeChartTimeframe,
} from "@/lib/chartCandlesQuery";
import { useChartSymbol } from "@/lib/use-chart-symbol";

// ─────────────────────────────────────────────────────────────────────────────
// Smart Chart Shell (Task #373).
//
// This page is the Shell PARENT CONTROLLER: it owns ALL chart state and
// intelligence — the symbol (shared bus), the timeframe (controlled), the chart
// context + intelligence snapshot, the read-only position + AI overlays, and the
// role gating — and drives the chart RENDERER (ARX Native, which renders through
// the first-party Canvas adapter). The rendering engine lives behind the adapter;
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

  const [chartSymbol] = useChartSymbol();
  // The Shell owns the timeframe (controlled). The Native renderer reflects this
  // value and reports user changes back via onTimeframeChange, so the Shell — not
  // the renderer — is the single source of truth for the timeframe on screen.
  const [sharedTimeframe, setSharedTimeframe] = useScannerTimeframe();
  const timeframe = toApiTimeframe(sharedTimeframe) as ArxTimeframe;
  const onTimeframeChange = useCallback(
    (tf: ArxTimeframe) => {
      const ui = normalizeChartTimeframe(tf);
      setSharedTimeframe(ui);
    },
    [setSharedTimeframe],
  );
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
  const [tradePrefill, setTradePrefill] = useState<ChartTradePrefill | null>(
    null,
  );
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
  const [chartIntelligence, setChartIntelligence] = useState<
    ChartIntelligenceResponse["state"] | null
  >(null);
  const onIntelligenceChange = useCallback(
    (state: ChartIntelligenceResponse["state"]) => setChartIntelligence(state),
    [],
  );
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 pb-12">
      <div className="workspace-page-heading">
        <div>
          <span className="workspace-eyebrow">REVIEW & TRADE</span>
          <h1>Chart</h1>
          <p>Selected market, analysis and order entry in one workspace.</p>
        </div>
        <div className="flex items-center gap-3">
          <SymbolPicker />
          {mode.envelope && (
            <Badge variant="outline" data-testid="chart-mode-badge">
              {mode.cleanModeLabel}
            </Badge>
          )}
        </div>
      </div>
      <div className="workspace-chart-grid">
        <div className="space-y-5">
          <ARXNativeChart
            symbol={chartSymbol}
            mode={mode.cleanModeLabel}
            timeframe={timeframe}
            onTimeframeChange={onTimeframeChange}
            height={500}
            mobileHeight={360}
            showFeedStatus
            overlays={[
              ...overlayData.overlays,
              ...aiOverlays.overlays,
              ...setupPreview.overlays,
            ]}
            onChartContextChange={onChartContextChange}
            onIntelligenceChange={onIntelligenceChange}
          />
          <PageTabs
            storageKey="chart-workspace-details"
            defaultTab="analysis"
            tabs={[
              {
                id: "analysis",
                label: "Analysis & setups",
                content: (
                  <div className="space-y-4">
                    <ChartSetupPreviewPanel
                      data={setupPreview}
                      canUseSetup={canSeeTradeEntry}
                      onUseSetup={onUseSetup}
                    />
                    <ChartModes state={chartIntelligence} />
                  </div>
                ),
              },
              {
                id: "positions",
                label: "Positions",
                content: (
                  <div className="space-y-4">
                    <ChartPositionOverlayPanel
                      symbol={chartSymbol}
                      data={overlayData}
                    />
                    <PositionPickerPanel />
                  </div>
                ),
              },
              {
                id: "overlays",
                label: "Chart layers",
                content: (
                  <div className="space-y-4">
                    <ChartAiOverlayPanel data={aiOverlays} />
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="chart-engine-label"
                    >
                      Rendering engine: {activeEngine.label}
                    </p>
                  </div>
                ),
              },
            ]}
          />
        </div>
        <aside
          className="workspace-chart-ticket space-y-4"
          aria-label="Order ticket"
        >
          {canSeeTradeEntry && <ChartTradeEntry prefill={tradePrefill} />}
          <div className="workspace-chart-note">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {mode.isLiveShared
                ? "Live account. Review the direction, size and protective levels before confirming an order."
                : `Current account mode: ${mode.cleanModeLabel}. Review the ticket's execution status before confirming.`}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
