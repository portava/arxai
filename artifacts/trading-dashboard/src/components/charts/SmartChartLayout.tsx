import { useEffect, useRef, useState, type ReactNode } from "react";
import { ARXNativeChart, type ArxTimeframe } from "./ARXNativeChart";
import { readChartStorage, writeChartStorage } from "@/lib/chart-engine/chartWorkspace";
import { CHART_LAYOUT_KEY, validateChartLayout, isChartInterval, type ComparisonView } from "@/lib/chart-engine/chartLayout";
import { ChartViewLink } from "@/lib/chart-engine/chartViewLink";
import { ChartLinkContext } from "./ChartLinkContext";
import { SymbolExplorer } from "@/components/scanner/SymbolExplorer";
import { Button } from "@/components/ui/button";

function ComparisonInstrument({primary, view, onSymbol}: {primary:string;view:ComparisonView;onSymbol:(symbol:string|null)=>void}) {
  const details = useRef<HTMLDetailsElement>(null);
  return <details ref={details} className="mb-2 rounded border border-zinc-800 px-3 py-2 text-xs">
    <summary className="cursor-pointer text-zinc-300">Instrument: {view.symbol ?? primary}{view.symbol === null ? " · follows primary" : " · independent"}</summary>
    <div className="mt-3 space-y-3">
      <label className="flex items-center gap-2"><input type="checkbox" checked={view.symbol === null} onChange={event => onSymbol(event.target.checked ? null : primary)} />Follow primary instrument</label>
      <SymbolExplorer activeSymbol={view.symbol ?? primary} showDiagnostics={false} onSelect={symbol => {onSymbol(symbol); if (details.current) details.current.open = false;}} />
      <p className="text-zinc-400">Changes this comparison only. Available history depends on its feed.</p>
    </div>
  </details>;
}

/** Primary view stays mounted and alone supplies intelligence / ticket context.
 * Comparisons never publish to the shared symbol bus or inherit trade overlays. */
export function SmartChartLayout({symbol,children}: {symbol:string;children:ReactNode}) {
  const [layout,setLayout] = useState(() => validateChartLayout(readChartStorage(CHART_LAYOUT_KEY) ?? readChartStorage("arx.chart.layout.v1")));
  const [saved,setSaved] = useState(true);
  const [links] = useState(() => new ChartViewLink());
  useEffect(() => {setSaved(writeChartStorage(CHART_LAYOUT_KEY,layout));},[layout]);
  useEffect(() => {links.configure({crosshair:layout.count > 1 && layout.crosshair,range:layout.count > 1 && layout.range});},[links,layout.count,layout.crosshair,layout.range]);
  const changeView = (index:number, patch:Partial<ComparisonView>) => setLayout(previous => ({...previous,comparisons:previous.comparisons.map((view,i) => i === index ? {...view,...patch} : view)}));
  return <ChartLinkContext.Provider value={links}><div className="min-w-0 space-y-3" data-testid="smart-chart-layout">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1" role="group" aria-label="Chart layout">
        {([[1,"One chart"],[2,"Two charts"],[4,"Four charts"]] as const).map(([count,label]) => <Button key={count} size="sm" variant={layout.count === count ? "secondary" : "ghost"} aria-pressed={layout.count === count} onClick={() => setLayout(previous => ({...previous,count}))}>{label}</Button>)}
      </div>
      {layout.count > 1 && <div className="flex flex-wrap gap-4 text-xs text-zinc-300" role="group" aria-label="Link chart views">
        <label className="flex items-center gap-2"><input type="checkbox" checked={layout.crosshair} onChange={event => setLayout(previous => ({...previous,crosshair:event.target.checked}))}/>Link crosshair</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={layout.range} onChange={event => setLayout(previous => ({...previous,range:event.target.checked}))}/>Link time range</label>
      </div>}
    </div>
    {layout.count > 1 && <p className="text-xs text-zinc-400">Independent instruments and intervals · primary chart supplies setup context. Linked views follow the chart you navigate, within loaded history; crosshairs use each view’s candle close.</p>}
    {!saved && <p role="alert" className="text-xs text-amber-300">Browser storage is unavailable. This layout will reset when you close the page.</p>}
    <div className={layout.count > 1 ? "grid min-w-0 gap-3 2xl:grid-cols-2" : "min-w-0"}>
      <div className="min-w-0">{layout.count > 1 && <p className="mb-2 text-xs text-zinc-400">Primary chart</p>}{children}</div>
      {layout.comparisons.slice(0,layout.count - 1).map((view,index) => <section key={index} className="min-w-0" aria-label={`Comparison chart ${index + 1}`} data-testid="comparison-chart">
        <p className="mb-2 text-xs text-zinc-400">Comparison chart {index + 1} · analysis only</p>
        <ComparisonInstrument primary={symbol} view={view} onSymbol={symbol => changeView(index,{symbol})} />
        <ARXNativeChart workspaceId={index === 0 ? "comparison" : index === 1 ? "comparison-2" : "comparison-3"} symbol={view.symbol ?? symbol} timeframe={view.timeframe} onTimeframeChange={(timeframe:ArxTimeframe) => {if (isChartInterval(timeframe)) changeView(index,{timeframe});}} height={520} showFeedStatus />
      </section>)}
    </div>
  </div></ChartLinkContext.Provider>;
}
