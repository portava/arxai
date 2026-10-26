import { useEffect, useId, useState, type Dispatch, type SetStateAction } from "react";
import type { ChartEngineAdapter } from "@/lib/chart-engine";
import { STUDY_DEFAULTS } from "@/lib/chart-engine/chartStudies";
import { drawingStorageKey, MAX_DRAWINGS, readChartStorage, TEMPLATE_KEY, validateDrawings, validatePreferences, writeChartStorage, type ChartAnchor, type ChartDrawing, type ChartPreferences, type DrawingKind } from "@/lib/chart-engine/chartWorkspace";
import { Button } from "@/components/ui/button";

const field = "h-8 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100";
const names = { horizontal:"Horizontal level", trend:"Trend line", fibonacci:"Fibonacci retracement" };
interface Props {
  adapter: ChartEngineAdapter | null; epoch: number; symbol: string; timeframe: string;
  preferences: ChartPreferences; onPreferences: Dispatch<SetStateAction<ChartPreferences>>;
  hasCandles: boolean; feedLabel: string;
}
export function ChartWorkbenchTools({adapter,epoch,symbol,timeframe,preferences,onPreferences,hasCandles,feedLabel}: Props) {
  const key = drawingStorageKey(symbol,timeframe);
  const instanceId = useId();
  const [history,setHistory] = useState<{past:ChartDrawing[][];present:ChartDrawing[];future:ChartDrawing[][]}>(()=>({past:[],present:validateDrawings(readChartStorage(key)),future:[]}));
  const [panel,setPanel] = useState<"studies" | "objects" | null>(null);
  const [tool,setTool] = useState<DrawingKind | null>(null);
  const [anchor,setAnchor] = useState<ChartAnchor | null>(null);
  const [hidden,setHidden] = useState(false);
  const [message,setMessage] = useState("");
  const [storageFailed,setStorageFailed] = useState(false);
  const drawings = history.present;
  const persist = (next: ChartDrawing[]) => {
    const saved = writeChartStorage(key,next);
    setStorageFailed(!saved);
    if (saved) window.dispatchEvent(new CustomEvent("arx.chart.drawings.updated",{detail:{key,source:instanceId}}));
  };
  useEffect(()=>{
    const receive = (event:Event) => {
      const detail=(event as CustomEvent<{key:string;source:string}>).detail;
      const changedKey=event instanceof StorageEvent ? event.key : detail?.key;
      if(changedKey===key && detail?.source!==instanceId) {
        setHistory({past:[],present:validateDrawings(readChartStorage(key)),future:[]});
      }
    };
    window.addEventListener("storage",receive);window.addEventListener("arx.chart.drawings.updated",receive);
    return()=>{window.removeEventListener("storage",receive);window.removeEventListener("arx.chart.drawings.updated",receive);};
  },[key,instanceId]);
  const change = (next: ChartDrawing[]) => {
    const valid = validateDrawings(next);
    setHistory(h=>({past:[...h.past.slice(-19),h.present],present:valid,future:[]}));
    persist(valid);
  };
  useEffect(()=>{adapter?.setDrawings?.(hidden ? [] : drawings);},[adapter,epoch,hidden,drawings]);
  useEffect(()=>{
    adapter?.setDrawingHandler?.(tool && hasCandles ? point=>{
      if (drawings.length >= MAX_DRAWINGS) {setMessage(`Limit of ${MAX_DRAWINGS} drawings reached. Delete an object first.`);setTool(null);return;}
      if (tool !== "horizontal" && !anchor) {setAnchor(point);return;}
      if (anchor && point.time === anchor.time) {setMessage("Choose a different candle for the second anchor.");return;}
      change([...drawings,{id:crypto.randomUUID(),kind:tool,start:anchor ?? point,...(anchor ? {end:point} : {}),color:"#fbbf24"}]);
      setTool(null);setAnchor(null);setHidden(false);setMessage("Drawing added. Edit its levels in Objects.");
    } : null);
    return ()=>adapter?.setDrawingHandler?.(null);
  },[adapter,epoch,tool,anchor,drawings,hasCandles,key]);
  useEffect(()=>{
    const cancel = (event: KeyboardEvent) => {if(event.key === "Escape"){setTool(null);setAnchor(null);}};
    window.addEventListener("keydown",cancel);return()=>window.removeEventListener("keydown",cancel);
  },[]);
  const undo = (redo = false) => {
    const source = redo ? history.future : history.past;
    const next = source.at(-1); if (!next) return;
    setHistory(h=>redo ? {past:[...h.past,h.present],present:next,future:h.future.slice(0,-1)} : {past:h.past.slice(0,-1),present:next,future:[...h.future,h.present]});
    persist(next);
  };
  const exportImage = () => {
    try {
      const url = adapter?.exportImage?.(); if(!url) return;
      // Include instrument, timeframe, UTC capture time and feed verdict. A PNG
      // must not detach delayed/offline data from its visible provenance.
      const image = new Image(); image.onload = ()=>{
        const canvas = document.createElement("canvas");
        const ctx=canvas.getContext("2d");if(!ctx) return;
        ctx.font="12px sans-serif";
        const labels = [`ARX · ${symbol} ${timeframe}`, `Captured ${new Date().toISOString()}`, feedLabel,
          preferences.studies.map(study=>`${study.kind.toUpperCase()}(${study.period}${study.kind === "macd" ? `,${study.slow},${study.signal}` : study.kind === "bollinger" ? `,${study.multiplier}` : ""})`).join(" · ")].filter(Boolean);
        const lines:string[]=[];
        for(const label of labels) {
          let line="";
          for(const word of label.split(" ")) {const next=line ? `${line} ${word}` : word;if(line && ctx.measureText(next).width > image.width-24){lines.push(line);line=word;}else line=next;}
          if(line) lines.push(line);
        }
        const header=lines.length*18+20;
        canvas.width=image.width;canvas.height=image.height+header;
        ctx.fillStyle="#09090b";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle="#fafafa";ctx.font="12px sans-serif";
        lines.forEach((line,index)=>ctx.fillText(line,12,20+index*18));
        ctx.drawImage(image,0,header);const link=document.createElement("a");link.download=`ARX-${symbol}-${timeframe}.png`;link.href=canvas.toDataURL("image/png");link.click();
      };image.src=url;
    } catch {setMessage("Chart image could not be saved in this browser.");}
  };
  return <div className="border-b border-zinc-800 px-3 py-2 text-xs" data-testid="chart-workbench-tools">
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2">Style <select className={field} aria-label="Chart style" value={preferences.style} onChange={e=>onPreferences(p=>({...p,style:e.target.value as ChartPreferences["style"]}))}>
        <option value="candles">Candlesticks</option><option value="bars">OHLC bars</option><option value="line">Close line</option>
      </select></label>
      <Button size="sm" variant="outline" className="h-8 text-xs" aria-expanded={panel === "studies"} onClick={()=>setPanel(p=>p === "studies" ? null : "studies")}>Studies ({preferences.studies.length})</Button>
      <select className={field} aria-label="Drawing tool" value={tool ?? ""} disabled={!hasCandles} onChange={e=>{setTool((e.target.value || null) as DrawingKind | null);setAnchor(null);setMessage("");}}>
        <option value="">Crosshair / pan</option><option value="horizontal">Horizontal level</option><option value="trend">Trend line</option><option value="fibonacci">Fibonacci retracement</option>
      </select>
      <Button size="sm" variant="outline" className="h-8 text-xs" aria-expanded={panel === "objects"} onClick={()=>setPanel(p=>p === "objects" ? null : "objects")}>Objects ({drawings.length})</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!history.past.length} onClick={()=>undo()}>Undo</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!history.future.length} onClick={()=>undo(true)}>Redo</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={()=>{const ok=writeChartStorage(TEMPLATE_KEY,preferences);setMessage(ok ? "Style, scale and studies saved as this browser’s template." : "Template could not be saved; browser storage is unavailable.");}}>Save template</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={()=>{const saved=readChartStorage(TEMPLATE_KEY);if(saved){onPreferences(validatePreferences(saved));setMessage("Template applied. Drawings remain with their instrument and timeframe.");}else setMessage("No template saved in this browser yet.");}}>Load template</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!hasCandles} onClick={exportImage}>Export PNG</Button>
    </div>
    {preferences.studies.length > 0 && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px]" aria-label="Active studies">{preferences.studies.map(study=><span key={study.kind} style={{color:study.color}}>{study.kind.toUpperCase()} ({study.period}{study.kind === "macd" ? `, ${study.slow}, ${study.signal}` : study.kind === "bollinger" ? `, ${study.multiplier}` : ""})</span>)}</div>}
    {tool && <p className="mt-2 text-amber-300" role="status">{names[tool]}: {anchor ? "choose the second candle and price" : "click or tap a candle at the desired price"}. Escape cancels. Drawings are analysis only.</p>}
    {message && <p className="mt-2 text-zinc-300" role="status">{message}</p>}
    {storageFailed && <p className="mt-2 text-amber-300" role="alert">Browser storage is unavailable. Drawing changes will be lost when this view closes.</p>}
    {panel === "studies" && <div className="mt-3 space-y-2 rounded border border-zinc-800 p-3" aria-label="Study settings">
      <p className="text-zinc-400">Calculated from loaded closes, including the forming bar. Warm-up bars are left blank. Additional history can change seeded values.</p>
      {STUDY_DEFAULTS.map(defaults=>{
        const selected=preferences.studies.find(s=>s.kind===defaults.kind), config=selected ?? defaults;
        const update=(values: Partial<typeof config>)=>onPreferences(p=>validatePreferences({...p,studies:p.studies.map(s=>s.kind===config.kind ? {...s,...values} : s)}));
        return <div key={config.kind} className="flex flex-wrap items-center gap-3">
          <label className="flex w-28 items-center gap-2"><input type="checkbox" checked={!!selected} onChange={e=>onPreferences(p=>({...p,studies:e.target.checked ? [...p.studies,defaults] : p.studies.filter(s=>s.kind!==config.kind)}))}/>{config.kind.toUpperCase()}</label>
          <label className="flex items-center gap-2">{config.kind === "macd" ? "Fast" : "Period"}<input key={`${config.kind}-${config.period}`} className={`${field} w-16`} aria-label={`${config.kind.toUpperCase()} period`} type="number" min={2} max={config.kind === "macd" ? (config.slow ?? 26)-1 : 200} defaultValue={config.period} disabled={!selected} onBlur={e=>{if(e.target.validity.valid && e.target.value) update({period:Number(e.target.value)});else e.target.value=String(config.period);}}/></label>
          {config.kind === "bollinger" && <label className="flex items-center gap-2">Deviation<input key={config.multiplier} className={`${field} w-16`} aria-label="Bollinger deviation" type="number" min={.5} max={5} step={.5} defaultValue={config.multiplier} disabled={!selected} onBlur={e=>{if(e.target.validity.valid && e.target.value) update({multiplier:Number(e.target.value)});else e.target.value=String(config.multiplier);}}/></label>}
          {config.kind === "macd" && (["slow","signal"] as const).map(name=><label key={name} className="flex items-center gap-2">{name}<input key={config[name]} className={`${field} w-16`} aria-label={`MACD ${name}`} type="number" min={name === "slow" ? config.period+1 : 2} max={200} defaultValue={config[name]} disabled={!selected} onBlur={e=>{if(e.target.validity.valid && e.target.value) update({[name]:Number(e.target.value)});else e.target.value=String(config[name]);}}/></label>)}
          <input type="color" aria-label={`${config.kind.toUpperCase()} color`} className="h-7 w-8 bg-transparent" value={config.color} disabled={!selected} onChange={e=>update({color:e.target.value})}/>
        </div>;
      })}
    </div>}
    {panel === "objects" && <div className="mt-3 space-y-2 rounded border border-zinc-800 p-3" aria-label="Drawing objects">
      <div className="flex flex-wrap items-center gap-2"><p className="flex-1 text-zinc-400">Saved on this browser for {symbol} · {timeframe}. Lines outside loaded history appear when their candles load.</p><Button size="sm" variant="outline" className="h-8 text-xs" aria-pressed={hidden} onClick={()=>setHidden(h=>!h)}>{hidden ? "Show drawings" : "Hide drawings"}</Button></div>
      {!drawings.length && <p>No drawings on this chart. Choose a drawing tool to begin.</p>}
      {drawings.map((d,index)=><div key={d.id} className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2" data-testid="chart-drawing-object">
        <span className="w-36">{index+1}. {names[d.kind]}</span>
        {(["start","end"] as const).filter(name=>d[name]).map(name=><label key={name} className="flex flex-wrap items-center gap-2">{name}<input key={d[name]!.price} aria-label={`Drawing ${index+1} ${name} price`} className={`${field} w-32`} type="number" step="any" min="0.00000001" defaultValue={Number(d[name]!.price.toPrecision(10))} onBlur={e=>{const price=Number(e.target.value);if(Number.isFinite(price)&&price>0) change(drawings.map(item=>item.id === d.id ? {...item,[name]:{...item[name]!,price}} : item));else e.target.value=String(d[name]!.price);}}/><span className="text-[10px] text-zinc-500">{new Date(d[name]!.time*1000).toISOString().slice(0,16).replace("T"," ")} UTC</span></label>)}
        <input type="color" aria-label={`Drawing ${index+1} color`} className="h-7 w-8 bg-transparent" value={d.color} onChange={e=>change(drawings.map(item=>item.id===d.id ? {...item,color:e.target.value} : item))}/>
        <Button size="sm" variant="ghost" className="h-8 text-xs" aria-label={`Delete drawing ${index+1}`} onClick={()=>change(drawings.filter(item=>item.id!==d.id))}>Delete</Button>
      </div>)}
    </div>}
  </div>;
}
