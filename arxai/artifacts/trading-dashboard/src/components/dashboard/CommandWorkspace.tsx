import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useAssistantName } from "@/lib/assistant-name";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";
import { useViewMode } from "@/hooks/useViewMode";
import { useTraderTier } from "@/hooks/useTraderTier";
import { useProductRole } from "@/hooks/useProductRole";
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
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  Activity, Search, Crosshair, Shield, Brain, Briefcase, Eye, CalendarDays,
  BarChart3, Settings2, Pin, PinOff, ChevronDown, ChevronUp, LayoutGrid,
  Wallet, ScanLine,
} from "lucide-react";
import { buildDashboardCatalog, filterDashboardCatalog, dashboardPanelForTool, applyWorkspacePreset, toggleWorkspacePanel, type WorkspacePanelId, type WorkspacePreset } from "./commandWorkspaceModel";

const ICONS = [Activity, Search, Crosshair, Shield, Brain, Briefcase, Eye, CalendarDays, BarChart3, Settings2, Wallet, ScanLine];
const PANELS = [
  { id: "discovery", title: "Market discovery", icon: Search },
  { id: "chart", title: "Smart Chart", icon: Activity },
  { id: "heat", title: "Global market heat", icon: BarChart3 },
  { id: "intelligence", title: "Market intelligence", icon: ScanLine },
  { id: "clock", title: "World clock", icon: CalendarDays },
  { id: "ruby", title: "Ruby read", icon: Brain },
  { id: "risk", title: "Risk & permission", icon: Shield },
  { id: "order", title: "Order entry", icon: Crosshair },
  { id: "positions", title: "Open positions", icon: Briefcase },
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
  try {
    const raw = storage?.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const value = JSON.parse(raw) as Partial<LayoutState>;
    const valid = (items: unknown) => Array.isArray(items) ? items.filter((x): x is PanelId => PANELS.some(p => p.id === x)) : [];
    const pinned = valid(value.pinned);
    return {
      collapsed: valid(value.collapsed).filter(id => !pinned.includes(id)),
      pinned,
      preset: value.preset === "Analyze" || value.preset === "Trade" || value.preset === "Review" ? value.preset : "Analyze",
    };
  } catch { return DEFAULT_LAYOUT; }
}

export function persistWorkspaceLayout(layout: LayoutState, storage?: Pick<Storage, "setItem">) {
  try { (storage ?? window.localStorage).setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* storage can be unavailable */ }
}

export function WorkspacePanel({
  id, title, icon: Icon, collapsed, pinned, onCollapse, onPin, children, className,
}: {
  id: PanelId; title: string; icon: typeof Search; collapsed: boolean; pinned: boolean;
  onCollapse: () => void; onPin: () => void; children: ReactNode; className?: string;
}) {
  const isCollapsed = collapsed && !pinned;
  return <section id={`workspace-${id}`} className={cn("arx-panel min-w-0", className)} aria-label={title} tabIndex={-1}>
    <div className="arx-panel-head">
      <div className="flex min-w-0 items-center gap-2"><Icon size={15} className="text-cyan-300" /><h2 className="truncate">{title}</h2>{pinned && <span className="arx-pin-label">PINNED</span>}</div>
      <div className="flex items-center gap-1">
        <button type="button" aria-pressed={pinned} aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`} title={pinned ? "Unpin panel" : "Pin panel"} onClick={onPin} className="arx-icon-btn">{pinned ? <PinOff size={13}/> : <Pin size={13}/>}</button>
        <button type="button" disabled={pinned} aria-expanded={!isCollapsed} aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${title}`} title={pinned ? "Pinned panels stay expanded" : `${isCollapsed ? "Expand" : "Collapse"} panel`} onClick={onCollapse} className="arx-icon-btn">{isCollapsed ? <ChevronDown size={14}/> : <ChevronUp size={14}/>}</button>
      </div>
    </div>
    {!isCollapsed && <div className="arx-panel-body">{children}</div>}
  </section>;
}

export function CommandWorkspace() {
  const { name } = useAssistantName();
  const [symbol, setSymbol] = useChartSymbol();
  const { effectiveIsAdmin } = useViewMode();
  const { isApprovedTrader } = useTraderTier();
  const { isInvestor } = useProductRole();
  const [layout, setLayout] = useState<LayoutState>(() => readWorkspaceLayout(typeof window === "undefined" ? undefined : window.localStorage));
  const [allToolsOpen, setAllToolsOpen] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [orderReviewOpen, setOrderReviewOpen] = useState(false);
  const [query, setQuery] = useState("");
  const catalog = useMemo(() => buildDashboardCatalog(name, { isAdmin: effectiveIsAdmin, isApprovedTrader, isInvestor }), [name, effectiveIsAdmin, isApprovedTrader, isInvestor]);
  const results = useMemo(() => filterDashboardCatalog(catalog, query), [catalog, query]);
  const updateLayout = (next: LayoutState) => { setLayout(next); persistWorkspaceLayout(next); };
  const togglePanel = (id: PanelId) => updateLayout(toggleWorkspacePanel(layout, id, "collapse"));
  const togglePin = (id: PanelId) => updateLayout(toggleWorkspacePanel(layout, id, "pin"));
  const choosePreset = (preset: WorkspacePreset) => updateLayout(applyWorkspacePreset(layout, preset));
  const focusPanel = (id: PanelId, closeToolSheet = false) => {
    if (layout.collapsed.includes(id)) updateLayout({ ...layout, collapsed: layout.collapsed.filter(x => x !== id) });
    if (closeToolSheet) { setAllToolsOpen(false); setMobileToolsOpen(false); }
    window.setTimeout(() => {
      const target = document.getElementById(`workspace-${id}`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    }, closeToolSheet ? 320 : 0);
  };
  const active = bareSymbol(symbol || "V75").toUpperCase();

  const tools = <div className="space-y-4">
    <label className="relative block"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/><Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search all tools…" aria-label="Search all tools" className="h-10 border-slate-700 bg-[#07111a] pl-9 text-sm"/></label>
    {results.length === 0 ? <p className="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-400">No tools match “{query}”. Try a route name or task.</p> : <div className="space-y-4">
      {[...new Set(results.map(x => x.group))].map(group => <div key={group}><div className="mb-2 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">{group}</div><div className="grid gap-1 sm:grid-cols-2">
        {results.filter(x => x.group === group).map((item, index) => {
          const Icon = ICONS[index % ICONS.length];
          const panel = dashboardPanelForTool(item.href);
          const className = "flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5 text-left text-sm text-slate-200 transition hover:border-cyan-500/50 hover:bg-cyan-950/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300";
          return panel
            ? <button key={item.href} type="button" onClick={() => focusPanel(panel, true)} aria-label={`Open ${item.label} panel in workspace`} className={`${className} w-full`}><Icon size={15} className="text-cyan-300"/><span>{item.label}</span><span className="ml-auto text-[10px] text-cyan-300">Workspace panel</span></button>
            : <a key={item.href} href={item.href} className={className}><Icon size={15} className="text-cyan-300"/><span>{item.label}</span><span className="ml-auto truncate text-[10px] text-slate-500">{item.href}</span></a>;
        })}
      </div></div>)}
    </div>}
  </div>;

  return <div className="arx-workspace">
    <aside className="arx-dock" aria-label="Workspace tools">
      <div className="arx-dock-brand">ARX<span>AI</span></div>
      <button type="button" onClick={() => setAllToolsOpen(true)} className="arx-dock-tool" aria-label="Open all tools"><LayoutGrid size={17}/><span>All tools</span></button>
      {PANELS.map(({ id, title, icon: Icon }) => <button key={id} type="button" onClick={() => focusPanel(id)} className="arx-dock-tool" aria-label={`Focus ${title}`}><Icon size={17}/><span>{title.replace("Market ", "")}</span></button>)}
      <div className="mt-auto hidden md:block"><span className="arx-dock-caption">WORKSPACE</span></div>
    </aside>
    <main className="arx-workspace-main">
      <header className="arx-workspace-top">
        <div className="arx-workspace-title min-w-0"><div className="arx-eyebrow"><span className="arx-workspace-label">COMMAND WORKSPACE</span><span>·</span><time className="arx-workspace-date">{new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</time></div><h1>Market desk <span className="arx-symbol">{active}</span></h1></div>
        <div className="arx-preset-group" role="group" aria-label="Workspace preset">
          {(["Analyze", "Trade", "Review"] as const).map(preset => <button key={preset} type="button" aria-pressed={layout.preset === preset} onClick={() => choosePreset(preset)}>{preset}</button>)}
        </div>
        <div className="arx-refresh-control"><DashboardAutoRefreshControl/></div>
        <button type="button" className="arx-mobile-tools" onClick={() => setMobileToolsOpen(true)} aria-label="Open workspace tools"><LayoutGrid size={17}/></button>
      </header>
      <AccountCommandStrip />
      <div className="arx-workspace-grid">
        <div className="arx-col arx-col-left">
          <WorkspacePanel id="discovery" title="Market discovery" icon={Search} collapsed={layout.collapsed.includes("discovery")} pinned={layout.pinned.includes("discovery")} onCollapse={() => togglePanel("discovery")} onPin={() => togglePin("discovery")}><SymbolExplorer activeSymbol={symbol} onSelect={canonical => setSymbol(canonical)}/></WorkspacePanel>
          <WorkspacePanel id="heat" title="Global market heat" icon={BarChart3} collapsed={layout.collapsed.includes("heat")} pinned={layout.pinned.includes("heat")} onCollapse={() => togglePanel("heat")} onPin={() => togglePin("heat")}><GlobalMarketHeatCard/></WorkspacePanel>
          <WorkspacePanel id="clock" title="World clock" icon={CalendarDays} collapsed={layout.collapsed.includes("clock")} pinned={layout.pinned.includes("clock")} onCollapse={() => togglePanel("clock")} onPin={() => togglePin("clock")}><WorkspaceClock/></WorkspacePanel>
        </div>
        <div className="arx-col arx-col-center">
          <WorkspacePanel id="chart" title="Smart Chart" icon={Activity} collapsed={layout.collapsed.includes("chart")} pinned={layout.pinned.includes("chart")} onCollapse={() => togglePanel("chart")} onPin={() => togglePin("chart")} className="arx-chart-panel"><ScannerChartPanel compactWorkspace/></WorkspacePanel>
          <WorkspacePanel id="intelligence" title="Market intelligence" icon={ScanLine} collapsed={layout.collapsed.includes("intelligence")} pinned={layout.pinned.includes("intelligence")} onCollapse={() => togglePanel("intelligence")} onPin={() => togglePin("intelligence")}><div className="arx-intelligence-grid"><CriticalEventsCard/><BestMarketsCard/><AvoidMarketsCard/><AlertsSummaryCard/></div></WorkspacePanel>
        </div>
        <div className="arx-col arx-col-right">
          <WorkspacePanel id="ruby" title={`${name} · Market read`} icon={Brain} collapsed={layout.collapsed.includes("ruby")} pinned={layout.pinned.includes("ruby")} onCollapse={() => togglePanel("ruby")} onPin={() => togglePin("ruby")}><RubyMarketReadCard symbol={active}/></WorkspacePanel>
          <WorkspacePanel id="risk" title="Risk & permission" icon={Shield} collapsed={layout.collapsed.includes("risk")} pinned={layout.pinned.includes("risk")} onCollapse={() => togglePanel("risk")} onPin={() => togglePin("risk")}><div className="space-y-3"><RiskUtilizationSummary/><TradingPermissionSummaryCard/></div></WorkspacePanel>
          <WorkspacePanel id="order" title="Order entry" icon={Crosshair} collapsed={layout.collapsed.includes("order")} pinned={layout.pinned.includes("order")} onCollapse={() => togglePanel("order")} onPin={() => togglePin("order")}><ReviewedOrderCallout symbol={active} onOpen={() => setOrderReviewOpen(true)}/></WorkspacePanel>
        </div>
      </div>
      <WorkspacePanel id="positions" title="Open positions" icon={Briefcase} collapsed={layout.collapsed.includes("positions")} pinned={layout.pinned.includes("positions")} onCollapse={() => togglePanel("positions")} onPin={() => togglePin("positions")} className="arx-positions"><OpenPositionsCard/></WorkspacePanel>
    </main>
    <ReviewedOrderFlowSheet open={orderReviewOpen} onOpenChange={setOrderReviewOpen} symbol={active}/>
    <Sheet open={allToolsOpen} onOpenChange={setAllToolsOpen}><SheetContent side="right" className="w-full overflow-y-auto border-slate-700 bg-[#07111a] text-slate-100 sm:max-w-xl"><SheetHeader><SheetTitle className="text-slate-100">All tools</SheetTitle></SheetHeader><div className="mt-6">{tools}</div></SheetContent></Sheet>
    <Sheet open={mobileToolsOpen} onOpenChange={setMobileToolsOpen}><SheetContent side="bottom" className="max-h-[82dvh] overflow-y-auto border-slate-700 bg-[#07111a] text-slate-100"><SheetHeader><SheetTitle className="text-slate-100">Workspace tools</SheetTitle></SheetHeader><div className="mt-4 flex gap-2 overflow-x-auto pb-2">{PANELS.map(({ id, title, icon: Icon }) => <button type="button" key={id} onClick={() => focusPanel(id, true)} className="flex shrink-0 items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs"><Icon size={14}/>{title}</button>)}<button type="button" onClick={() => { setMobileToolsOpen(false); setAllToolsOpen(true); }} className="rounded-lg border border-cyan-500/50 px-3 py-2 text-xs text-cyan-200">All tools</button></div></SheetContent></Sheet>
    <nav className="arx-mobile-tray" aria-label="Workspace tool tray">
      {(["discovery", "chart", "heat", "clock", "order"] as const).map(id => { const panel = PANELS.find(item => item.id === id)!; const Icon = panel.icon; return <button type="button" key={id} onClick={() => focusPanel(id)} aria-label={`Focus ${panel.title}`}><Icon size={16}/><span>{panel.title.replace("Market ", "")}</span></button>; })}
      <button type="button" onClick={() => setAllToolsOpen(true)} aria-label="Open all tools"><LayoutGrid size={16}/><span>Tools</span></button>
    </nav>
  </div>;
}

export function CommandWorkspaceProviders() {
  return <LiveAccountSnapshotProvider><RubyReadStoreProvider><SelectedActionStoreProvider><CommandWorkspace/></SelectedActionStoreProvider></RubyReadStoreProvider></LiveAccountSnapshotProvider>;
}

