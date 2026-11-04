import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAssistantName } from "@/lib/assistant-name";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";
import { ScannerChartPanel } from "@/components/scanner/ScannerChartPanel";
import { SymbolExplorer } from "@/components/scanner/SymbolExplorer";
import { RubyMarketReadCard } from "@/components/scanner/RubyMarketReadCard";
import { GlobalMarketHeatCard } from "@/components/scanner/GlobalMarketHeatCard";
import { ReviewedOrderCallout } from "@/components/dashboard/ReviewedOrderCallout";
import { ReviewedOrderFlowSheet } from "@/components/dashboard/ReviewedOrderFlowSheet";
import { RiskUtilizationSummary } from "@/components/dashboard/RiskUtilizationSummary";
import { AccountCommandStrip } from "@/components/dashboard/AccountCommandStrip";
import { WorkspaceClock } from "@/components/dashboard/WorkspaceClock";
import {
  TradingPermissionSummaryCard, OpenPositionsCard,
  CriticalEventsCard, AlertsSummaryCard,
} from "@/components/dashboard/cockpit/CockpitCards";
import { BestMarketsCard, AvoidMarketsCard } from "@/components/dashboard/cockpit/CockpitTimingWidgets";
import { LiveAccountSnapshotProvider, useLiveAccountSnapshotCtx } from "@/hooks/useLiveAccountSnapshotContext";
import { useLiveBridgeRefreshState } from "@/hooks/useLiveBridgeRefresh";
import { LiveBridgeAutoRefreshControl } from "@/components/live/LiveBridgeAutoRefreshControl";
import { RubyReadStoreProvider } from "@/components/scanner/rubyReadStore";
import { SelectedActionStoreProvider } from "@/components/scanner/selectedActionStore";
import {
  Activity, Search, Crosshair, Shield, Brain, Briefcase, CalendarDays,
  BarChart3, ScanLine,
} from "lucide-react";
import { applyWorkspacePreset, toggleWorkspacePanel, type WorkspacePanelId, type WorkspacePreset } from "./commandWorkspaceModel";
import { LayoutPanel } from "@/components/layout/LayoutPanel";
import { useRoutePanelLayout } from "@/components/layout/useRoutePanelLayout";
import { readRoutePanelLayout, persistRoutePanelLayout } from "@/components/layout/shellLayoutModel";

const PANELS = [
  { id: "discovery", title: "Scanner", icon: Search },
  { id: "chart", title: "Chart", icon: Activity },
  { id: "heat", title: "Heat", icon: BarChart3 },
  { id: "intelligence", title: "Intelligence", icon: ScanLine },
  { id: "clock", title: "Desk clock", icon: CalendarDays },
  { id: "ruby", title: "AI read", icon: Brain },
  { id: "risk", title: "Risk", icon: Shield },
  { id: "order", title: "Order entry", icon: Crosshair },
  { id: "positions", title: "Positions", icon: Briefcase },
] as const;
type PanelId = WorkspacePanelId;
const LAYOUT_KEY = "arx.command-workspace.layout.v1";
type LayoutState = { collapsed: PanelId[]; pinned: PanelId[]; preset: WorkspacePreset };
const DEFAULT_LAYOUT: LayoutState = { collapsed: [], pinned: [], preset: "Analyze" };

function DashboardAutoRefreshControl() {
  const base = useLiveAccountSnapshotCtx();
  const bridge = useLiveBridgeRefreshState(base);
  return <LiveBridgeAutoRefreshControl
    autoRefreshEnabled={bridge.autoRefreshEnabled}
    toggleAutoRefresh={bridge.toggleAutoRefresh}
    refreshNow={bridge.refreshNow}
    isRefreshing={bridge.isRefreshing}
    lastRefreshAt={bridge.lastRefreshAt}
    nextRefreshInMs={bridge.nextRefreshInMs}
    bridgeState={bridge.bridgeState}
  />;
}

export function readWorkspaceLayout(storage?: Pick<Storage, "getItem">): LayoutState {
  const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  if (!source) return DEFAULT_LAYOUT;
  return readRoutePanelLayout(
    { getItem: source.getItem.bind(source), setItem: () => undefined },
    "anonymous",
    "cockpit",
    PANELS.map(panel => panel.id),
    { legacyKey: LAYOUT_KEY, defaultPreset: "Analyze" },
  ) as LayoutState;
}

export function persistWorkspaceLayout(layout: LayoutState, storage?: Pick<Storage, "setItem">) {
  const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  if (!source) return;
  persistRoutePanelLayout(
    { getItem: () => null, setItem: source.setItem.bind(source) },
    "anonymous",
    "cockpit",
    layout,
  );
}

export function WorkspacePanel({
  id, title, icon: Icon, collapsed, pinned, onCollapse, onPin, children, className, hidden = false,
}: {
  id: PanelId; title: string; icon: typeof Search; collapsed: boolean; pinned: boolean;
  onCollapse: () => void; onPin: () => void; children: ReactNode; className?: string; hidden?: boolean;
}) {
  return <LayoutPanel
    id={id}
    title={title}
    icon={Icon}
    collapsed={collapsed}
    pinned={pinned}
    onCollapse={onCollapse}
    onPin={onPin}
    hidden={hidden}
    className={className}
  >{children}</LayoutPanel>;
}

export function CommandWorkspace({
  headerActions,
  warningContent,
}: {
  headerActions?: ReactNode;
  warningContent?: ReactNode;
}) {
  const { name } = useAssistantName();
  const [symbol, setSymbol] = useChartSymbol();
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const routeLayout = useRoutePanelLayout(
    "cockpit",
    PANELS.map(panel => panel.id),
    { legacyKey: LAYOUT_KEY, defaultPreset: "Analyze" },
  );
  const layout = {
    collapsed: routeLayout.layout.collapsed as PanelId[],
    pinned: routeLayout.layout.pinned as PanelId[],
    preset: routeLayout.layout.preset ?? "Analyze",
  } satisfies LayoutState;
  const [isDesktopWorkspace, setIsDesktopWorkspace] = useState(() => typeof window !== "undefined" && window.innerWidth > 767);
  const [mobileFocusMode, setMobileFocusMode] = useState(() => typeof window !== "undefined" && window.innerWidth <= 767);
  const [mobileFocusedPanel, setMobileFocusedPanel] = useState<PanelId>("chart");
  const [mobileCollapsedPanels, setMobileCollapsedPanels] = useState<PanelId[]>([]);
  // Existing collapse/preset preferences remain stored, but older saved
  // layouts cannot hide the core desk on its first desktop opening.
  const [savedLayoutControlsUsed, setSavedLayoutControlsUsed] = useState(false);
  const [orderReviewOpen, setOrderReviewOpen] = useState(false);
  useEffect(() => {
    const updateViewport = () => {
      const desktop = window.innerWidth > 767;
      setIsDesktopWorkspace(desktop);
      setMobileFocusMode(!desktop);
      if (!desktop) {
        setMobileFocusedPanel("chart");
        setMobileCollapsedPanels([]);
      }
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);
  const updateLayout = useCallback((next: LayoutState) => {
    routeLayout.setLayout(next);
  }, [routeLayout.setLayout]);
  const initialDesktopLayout = !savedLayoutControlsUsed && isDesktopWorkspace;
  const mobileCoreIds: PanelId[] = ["chart", "positions", ...layout.pinned, mobileFocusedPanel];
  const mobileOpenIds = new Set(mobileCoreIds.filter(id => !mobileCollapsedPanels.includes(id)));
  const mobileHidden = (id: PanelId) => !isDesktopWorkspace && mobileFocusMode
    && id !== "chart" && id !== "positions" && id !== mobileFocusedPanel && !layout.pinned.includes(id);
  const mobileCollapsed = PANELS.filter(panel => !mobileOpenIds.has(panel.id)).map(panel => panel.id);
  const visibleLayout = initialDesktopLayout
    ? { ...layout, collapsed: [] }
    : !isDesktopWorkspace && mobileFocusMode
      ? { ...layout, collapsed: mobileCollapsed }
      : layout;
  const togglePanel = useCallback((id: PanelId) => {
    if (!isDesktopWorkspace && mobileFocusMode) {
      setMobileCollapsedPanels(current => current.includes(id) ? current.filter(panel => panel !== id) : [...current, id]);
      return;
    }
    setSavedLayoutControlsUsed(true);
    updateLayout(toggleWorkspacePanel(initialDesktopLayout ? { ...layout, collapsed: [] } : layout, id, "collapse"));
  }, [initialDesktopLayout, isDesktopWorkspace, layout, mobileFocusMode, updateLayout]);
  const togglePin = useCallback((id: PanelId) => {
    setSavedLayoutControlsUsed(true);
    updateLayout(toggleWorkspacePanel(initialDesktopLayout ? { ...layout, collapsed: [] } : layout, id, "pin"));
  }, [initialDesktopLayout, layout, updateLayout]);
  const choosePreset = useCallback((preset: WorkspacePreset) => {
    if (isDesktopWorkspace) {
      setMobileFocusMode(false);
    } else {
      setMobileFocusMode(true);
      setMobileFocusedPanel(preset === "Trade" ? "order" : preset === "Review" ? "positions" : "chart");
      setMobileCollapsedPanels([]);
    }
    setSavedLayoutControlsUsed(true);
    updateLayout(applyWorkspacePreset(initialDesktopLayout ? { ...layout, collapsed: [] } : layout, preset));
  }, [initialDesktopLayout, isDesktopWorkspace, layout, updateLayout]);
  const focusPanel = useCallback((id: PanelId) => {
    if (!isDesktopWorkspace) {
      setMobileFocusMode(true);
      setMobileFocusedPanel(id);
      setMobileCollapsedPanels(current => current.filter(panel => panel !== id));
      window.setTimeout(() => {
        const target = document.getElementById(`workspace-${id}`);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        target?.focus({ preventScroll: true });
      }, 0);
      return;
    }
    if (layout.collapsed.includes(id)) updateLayout({ ...layout, collapsed: layout.collapsed.filter(x => x !== id) });
    window.setTimeout(() => {
      const target = document.getElementById(`workspace-${id}`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    }, 0);
  }, [isDesktopWorkspace, layout, updateLayout]);
  useEffect(() => {
    const onFocusPanel = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id && PANELS.some(panel => panel.id === id)) focusPanel(id as PanelId);
    };
    window.addEventListener("arx:focus-workspace-panel", onFocusPanel);
    return () => window.removeEventListener("arx:focus-workspace-panel", onFocusPanel);
  }, [focusPanel]);
  const active = bareSymbol(symbol || "V75").toUpperCase();
  const cockpitHeaderControls = useMemo(() => <div className="arx-shell-cockpit-controls">
    <div className="arx-preset-group" role="group" aria-label="Workspace preset">
      {(["Analyze", "Trade", "Review"] as const).map(preset => <button key={preset} type="button" aria-pressed={layout.preset === preset} onClick={() => choosePreset(preset)}>{preset}</button>)}
    </div>
    <div className="arx-refresh-control"><DashboardAutoRefreshControl /></div>
    {headerActions}
  </div>, [choosePreset, headerActions, layout.preset]);
  useLayoutEffect(() => {
    setHeaderSlot(document.querySelector<HTMLElement>("[data-cockpit-header-slot]"));
  }, []);
  const cockpitHeaderPortal = headerSlot ? createPortal(cockpitHeaderControls, headerSlot) : null;

  return <>
  <div className="arx-dashboard-root arx-workspace">
    <div className="arx-workspace-body">
      <AccountCommandStrip />
      {warningContent && <div className="arx-workspace-warnings" aria-label="Account and safety notices">{warningContent}</div>}
      {!isDesktopWorkspace && mobileFocusMode && <div className="arx-mobile-focus-hint" aria-live="polite">
        Focus view · {PANELS.find(panel => panel.id === mobileFocusedPanel)?.title ?? "Chart"} · Chart and positions stay available; use the tool tray to switch.
      </div>}
      <div className="arx-workspace-grid">
        <div className="arx-col arx-col-left">
          <WorkspacePanel id="discovery" hidden={mobileHidden("discovery")} title="Market scanner" icon={Search} collapsed={visibleLayout.collapsed.includes("discovery")} pinned={layout.pinned.includes("discovery")} onCollapse={() => togglePanel("discovery")} onPin={() => togglePin("discovery")}><SymbolExplorer compactWorkspace activeSymbol={symbol} onSelect={canonical => setSymbol(canonical)}/></WorkspacePanel>
          <WorkspacePanel id="heat" hidden={mobileHidden("heat")} title="Market heat" icon={BarChart3} collapsed={visibleLayout.collapsed.includes("heat")} pinned={layout.pinned.includes("heat")} onCollapse={() => togglePanel("heat")} onPin={() => togglePin("heat")}><GlobalMarketHeatCard compactWorkspace/></WorkspacePanel>
          <WorkspacePanel id="clock" hidden={mobileHidden("clock")} title="Desk & world time" icon={CalendarDays} collapsed={visibleLayout.collapsed.includes("clock")} pinned={layout.pinned.includes("clock")} onCollapse={() => togglePanel("clock")} onPin={() => togglePin("clock")}><WorkspaceClock compactWorkspace/></WorkspacePanel>
        </div>
        <div className="arx-col arx-col-center">
          <WorkspacePanel id="chart" hidden={mobileHidden("chart")} title="Smart Chart" icon={Activity} collapsed={visibleLayout.collapsed.includes("chart")} pinned={layout.pinned.includes("chart")} onCollapse={() => togglePanel("chart")} onPin={() => togglePin("chart")} className="arx-chart-panel"><ScannerChartPanel compactWorkspace/></WorkspacePanel>
          <WorkspacePanel id="intelligence" hidden={mobileHidden("intelligence")} title="Market intelligence" icon={ScanLine} collapsed={visibleLayout.collapsed.includes("intelligence")} pinned={layout.pinned.includes("intelligence")} onCollapse={() => togglePanel("intelligence")} onPin={() => togglePin("intelligence")}><div className="arx-intelligence-grid"><CriticalEventsCard compactWorkspace/><BestMarketsCard compactWorkspace/><AvoidMarketsCard compactWorkspace/><AlertsSummaryCard compactWorkspace/></div></WorkspacePanel>
        </div>
        <div className="arx-col arx-col-right">
          <WorkspacePanel id="ruby" hidden={mobileHidden("ruby")} title={`${name} · AI read`} icon={Brain} collapsed={visibleLayout.collapsed.includes("ruby")} pinned={layout.pinned.includes("ruby")} onCollapse={() => togglePanel("ruby")} onPin={() => togglePin("ruby")}><RubyMarketReadCard compactWorkspace symbol={active}/></WorkspacePanel>
          <WorkspacePanel id="risk" hidden={mobileHidden("risk")} title="Risk & permission" icon={Shield} collapsed={visibleLayout.collapsed.includes("risk")} pinned={layout.pinned.includes("risk")} onCollapse={() => togglePanel("risk")} onPin={() => togglePin("risk")}><div className="arx-risk-compact-stack"><RiskUtilizationSummary/><TradingPermissionSummaryCard compactWorkspace/></div></WorkspacePanel>
          <WorkspacePanel id="order" hidden={mobileHidden("order")} title="Order entry" icon={Crosshair} collapsed={visibleLayout.collapsed.includes("order")} pinned={layout.pinned.includes("order")} onCollapse={() => togglePanel("order")} onPin={() => togglePin("order")}><ReviewedOrderCallout symbol={active} onOpen={() => setOrderReviewOpen(true)}/></WorkspacePanel>
        </div>
      </div>
      <WorkspacePanel id="positions" hidden={mobileHidden("positions")} title="Open positions" icon={Briefcase} collapsed={visibleLayout.collapsed.includes("positions")} pinned={layout.pinned.includes("positions")} onCollapse={() => togglePanel("positions")} onPin={() => togglePin("positions")} className="arx-positions"><OpenPositionsCard compactWorkspace/></WorkspacePanel>
    </div>
    <ReviewedOrderFlowSheet open={orderReviewOpen} onOpenChange={setOrderReviewOpen} symbol={active}/>
  </div>
  {cockpitHeaderPortal}
  </>;
}

export function CommandWorkspaceProviders(props: { headerActions?: ReactNode; warningContent?: ReactNode }) {
  return <LiveAccountSnapshotProvider><RubyReadStoreProvider><SelectedActionStoreProvider><CommandWorkspace {...props}/></SelectedActionStoreProvider></RubyReadStoreProvider></LiveAccountSnapshotProvider>;
}

