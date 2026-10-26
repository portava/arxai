import { useEffect, useState, type ReactNode } from "react";
import { ARXNativeChart, type ArxTimeframe } from "./ARXNativeChart";
import { readChartStorage, writeChartStorage } from "@/lib/chart-engine/chartWorkspace";
import { Button } from "@/components/ui/button";
const KEY = "arx.chart.layout.v1";
const TIMEFRAMES = ["M1","M5","M15","M30","H1","H4","D1"];

/** The primary view alone supplies intelligence and ticket context. The second
 * view shares the symbol but has its own interval, scale, drawings and studies. */
export function SmartChartLayout({symbol,children}: {symbol:string;children:ReactNode}) {
  const [layout,setLayout] = useState<1 | 2>(()=>(readChartStorage(KEY) as any)?.count === 2 ? 2 : 1);
  const [timeframe,setTimeframe] = useState<ArxTimeframe>(()=>{
    const tf=(readChartStorage(KEY) as any)?.timeframe;return TIMEFRAMES.includes(tf) ? tf : "H1";
  });
  useEffect(()=>{writeChartStorage(KEY,{count:layout,timeframe});},[layout,timeframe]);
  return <div className="min-w-0 space-y-3" data-testid="smart-chart-layout">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1" role="group" aria-label="Chart layout">
        <Button size="sm" variant={layout===1 ? "secondary" : "ghost"} aria-pressed={layout===1} onClick={()=>setLayout(1)}>One chart</Button>
        <Button size="sm" variant={layout===2 ? "secondary" : "ghost"} aria-pressed={layout===2} onClick={()=>setLayout(2)}>Two charts</Button>
      </div>
      {layout===2 && <p className="text-xs text-zinc-400">Same instrument · independent timeframes · primary chart supplies setup context</p>}
    </div>
    <div className={layout===2 ? "grid min-w-0 gap-3 2xl:grid-cols-2" : "min-w-0"}>
      <div className="min-w-0">{layout===2 && <p className="mb-2 text-xs text-zinc-400">Primary chart</p>}{children}</div>
      {layout===2 && <div className="min-w-0" data-testid="comparison-chart"><p className="mb-2 text-xs text-zinc-400">Comparison chart · analysis only</p><ARXNativeChart workspaceId="comparison" symbol={symbol} timeframe={timeframe} onTimeframeChange={setTimeframe} height={520} showFeedStatus /></div>}
    </div>
  </div>;
}
