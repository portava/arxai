import { useEffect, useLayoutEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ChartEngineAdapter } from "@/lib/chart-engine";
import { studyId, studyLabel } from "@/lib/chart-engine/chartStudies";
import { ChartStudySettings } from "./ChartStudySettings";
import { CHART_TIME_ZONES, captureLabel, convertWallClock, effectiveDisplayZone, formatChartTime, parseWallClockInZone, resolveTimeZone, zoneShortLabel, type ChartTimeZone } from "@/lib/chart-engine/chartTimeZone";
import { DRAWING_NAMES, singleAnchorDrawing, drawingStorageKey, MAX_DRAWINGS, readChartStorage, TEMPLATE_KEY, validateDrawings, validatePreferences, writeChartStorage, type ChartAnchor, type ChartDrawing, type ChartPreferences, type DrawingKind } from "@/lib/chart-engine/chartWorkspace";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Hand, ZoomIn, ZoomOut } from "lucide-react";

const field = "h-8 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100";
const names = DRAWING_NAMES;
interface Props {
  adapter: ChartEngineAdapter | null; epoch: number; symbol: string; timeframe: string;
  preferences: ChartPreferences; onPreferences: Dispatch<SetStateAction<ChartPreferences>>;
  hasCandles: boolean; feedLabel: string;
  /** Optional private analysis namespace; live charts keep their existing key. */
  drawingKey?: string;
  /** Private replay annotations never persist or synchronize across sessions. */
  ephemeralDrawings?: boolean;
  /** Replay has no further history read beyond its frozen window. */
  historyWindowOnly?: boolean;
}
export function ChartWorkbenchTools({adapter,epoch,symbol,timeframe,preferences,onPreferences,hasCandles,feedLabel,drawingKey,ephemeralDrawings=false,historyWindowOnly=false}: Props) {
  const key = drawingKey ?? drawingStorageKey(symbol,timeframe);
  const instanceId = useId();
  const [history,setHistory] = useState<{past:ChartDrawing[][];present:ChartDrawing[];future:ChartDrawing[][]}>(()=>({past:[],present:ephemeralDrawings ? [] : validateDrawings(readChartStorage(key)),future:[]}));
  const [panel,setPanel] = useState<"studies" | "objects" | null>(null);
  const [tool,setTool] = useState<DrawingKind | null>(null);
  const [anchor,setAnchor] = useState<ChartAnchor | null>(null);
  const [hidden,setHidden] = useState(false);
  const [message,setMessage] = useState("");
  const [goToDate,setGoToDate] = useState("");
  const [storageFailed,setStorageFailed] = useState(false);
  const [selectedId,setSelectedId] = useState<string | null>(null);
  const [snap,setSnap] = useState(false);
  const [panOnly,setPanOnly] = useState(false);
  // Display-only zone; daily bars keep UTC. Typed go-to values follow a switch.
  const selectedZone: ChartTimeZone = preferences.timeZone ?? "UTC";
  const zone = effectiveDisplayZone(selectedZone, timeframe);
  const zoneText = zoneShortLabel(zone);
  const previousZone = useRef(zone);
  useLayoutEffect(()=>{
    const from = previousZone.current;
    previousZone.current = zone;
    if (from !== zone) setGoToDate(value=>value && convertWallClock(value,from,zone,false));
  },[zone]);
  useLayoutEffect(()=>{
    adapter?.setNavigationMode?.(panOnly ? "pan" : "inspect");
    return ()=>adapter?.setNavigationMode?.("inspect");
  },[adapter,epoch,panOnly]);
  const drawings = history.present;
  const persist = (next: ChartDrawing[]) => {
    if(ephemeralDrawings)return;
    const saved = writeChartStorage(key,next);
    setStorageFailed(!saved);
    if (saved) window.dispatchEvent(new CustomEvent("arx.chart.drawings.updated",{detail:{key,source:instanceId}}));
  };
  useEffect(()=>{
    if(ephemeralDrawings)return;
    const receive = (event:Event) => {
      const detail=(event as CustomEvent<{key:string;source:string}>).detail;
      const changedKey=event instanceof StorageEvent ? event.key : detail?.key;
      if(changedKey===key && detail?.source!==instanceId) {
        setHistory({past:[],present:ephemeralDrawings ? [] : validateDrawings(readChartStorage(key)),future:[]});
      }
    };
    window.addEventListener("storage",receive);window.addEventListener("arx.chart.drawings.updated",receive);
    return()=>{window.removeEventListener("storage",receive);window.removeEventListener("arx.chart.drawings.updated",receive);};
  },[key,instanceId,ephemeralDrawings]);
  const change = (next: ChartDrawing[]) => {
    const valid = validateDrawings(next);
    if (JSON.stringify(valid) === JSON.stringify(drawings)) return;
    setHistory(h=>({past:[...h.past.slice(-19),h.present],present:valid,future:[]}));
    persist(valid);
  };
  useEffect(()=>{adapter?.setDrawings?.(hidden ? [] : drawings);},[adapter,epoch,hidden,drawings]);
  useEffect(()=>{
    adapter?.setDrawingInteraction?.(hidden ? null : {selectedId,snap,onSelect:setSelectedId,onCommit:change});
  });
  useEffect(()=>()=>adapter?.setDrawingInteraction?.(null),[adapter]);
  useEffect(()=>{if(selectedId && !drawings.some(d=>d.id === selectedId)) setSelectedId(null);},[drawings,selectedId]);
  useEffect(()=>{
    adapter?.setDrawingHandler?.(tool && hasCandles ? point=>{
      if (drawings.length >= MAX_DRAWINGS) {setMessage(`Limit of ${MAX_DRAWINGS} drawings reached. Delete an object first.`);setTool(null);return;}
      if (!singleAnchorDrawing(tool) && !anchor) {setAnchor(point);return;}
      if (anchor && point.time === anchor.time) {setMessage("Choose a different candle for the second anchor.");return;}
      const id = crypto.randomUUID();
      change([...drawings,{id,kind:tool,start:anchor ?? point,...(anchor ? {end:point} : {}),color:"#fbbf24"}]);
      setSelectedId(id);setTool(null);setAnchor(null);setHidden(false);setMessage("Drawing added. Drag the line or its handles to edit; Objects has exact values and locking.");
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
      // Include instrument, timeframe, capture time (display zone with its
      // abbreviation, plus the UTC ISO time when not UTC) and feed verdict. A
      // PNG must not detach delayed/offline data from its visible provenance.
      const image = new Image(); image.onload = ()=>{
        const canvas = document.createElement("canvas");
        const ctx=canvas.getContext("2d");if(!ctx) return;
        ctx.font="12px sans-serif";
        const labels = [`ARX · ${symbol} ${timeframe}`, captureLabel(Date.now(),zone), feedLabel,
          preferences.studies.map(studyLabel).join(" · ")].filter(Boolean);
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
      <div className="flex items-center gap-1 rounded-md border border-zinc-800 p-0.5" role="group" aria-label="Zoom and pan">
        <Button size="sm" variant={panOnly ? "secondary" : "ghost"} className="h-8 gap-1.5 text-xs" aria-pressed={panOnly} disabled={!hasCandles || !adapter?.setNavigationMode} title="Drag freely across candles and drawings. Select again to edit drawings." onClick={()=>{setPanOnly(value=>!value);setTool(null);setAnchor(null);setSelectedId(null);setMessage("");}}><Hand className="h-3.5 w-3.5"/>Pan</Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="Pan to earlier candles" title="Earlier candles (Left arrow on chart)" disabled={!hasCandles || !adapter?.panBy} onClick={()=>adapter?.panBy?.(-0.25)}><ArrowLeft className="h-3.5 w-3.5"/></Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="Pan to later candles" title="Later candles (Right arrow on chart)" disabled={!hasCandles || !adapter?.panBy} onClick={()=>adapter?.panBy?.(0.25)}><ArrowRight className="h-3.5 w-3.5"/></Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="Zoom in chart" title="Zoom in (+ on chart)" disabled={!hasCandles || !adapter?.zoomBy} onClick={()=>adapter?.zoomBy?.(0.75)}><ZoomIn className="h-3.5 w-3.5"/></Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="Zoom out chart" title="Zoom out (− on chart)" disabled={!hasCandles || !adapter?.zoomBy} onClick={()=>adapter?.zoomBy?.(4/3)}><ZoomOut className="h-3.5 w-3.5"/></Button>
      </div>
      <label className="flex items-center gap-2">Style <select className={field} aria-label="Chart style" value={preferences.style} onChange={e=>onPreferences(p=>({...p,style:e.target.value as ChartPreferences["style"]}))}>
        <option value="candles">Candlesticks</option><option value="bars">OHLC bars</option><option value="line">Close line</option>
      </select></label>
      <label className="flex items-center gap-2" title="Display only. Candle times, drawings, links and data requests stay in UTC. No zone here represents broker server time.">Time zone <select className={field} aria-label="Display time zone" value={selectedZone} onChange={e=>{const value=e.target.value as ChartTimeZone;onPreferences(p=>{const next={...p};if(value==="UTC")delete next.timeZone;else next.timeZone=value;return next;});}}>
        {CHART_TIME_ZONES.map(option=><option key={option} value={option}>{option==="local" ? `Browser local (${resolveTimeZone("local")})` : option}</option>)}
      </select></label>
      {zone !== selectedZone && resolveTimeZone(selectedZone) !== "UTC" && <span className="text-[11px] text-zinc-500" data-testid="chart-daily-zone-note">Daily bars keep UTC day labels.</span>}
      <Button size="sm" variant="outline" className="h-8 text-xs" aria-expanded={panel === "studies"} onClick={()=>setPanel(p=>p === "studies" ? null : "studies")}>Studies ({preferences.studies.length})</Button>
      <select className={field} aria-label="Drawing tool" value={tool ?? ""} disabled={!hasCandles} onChange={e=>{setPanOnly(false);setTool((e.target.value || null) as DrawingKind | null);setAnchor(null);setHidden(false);setMessage("");}}>
        <option value="">Select / crosshair / pan</option>{Object.entries(names).map(([kind,name])=><option key={kind} value={kind}>{name}</option>)}
      </select>
      <Button size="sm" variant="ghost" className="h-8 text-xs" aria-pressed={snap} title="Snap new anchors and dragged handles to the nearest open, high, low or close of the candle" onClick={()=>setSnap(value=>!value)}>Magnet {snap ? "on" : "off"}</Button>
      <Button size="sm" variant="outline" className="h-8 text-xs" aria-expanded={panel === "objects"} onClick={()=>setPanel(p=>p === "objects" ? null : "objects")}>Objects ({drawings.length})</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!history.past.length} onClick={()=>undo()}>Undo</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!history.future.length} onClick={()=>undo(true)}>Redo</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={()=>{const {timeZone:_zone,...template}=preferences;const ok=writeChartStorage(TEMPLATE_KEY,template);setMessage(ok ? "Style, scale and studies saved as this browser’s template." : "Template could not be saved; browser storage is unavailable.");}}>Save template</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={()=>{const saved=readChartStorage(TEMPLATE_KEY);if(saved){const {timeZone:_zone,...loaded}=validatePreferences(saved);onPreferences(p=>p.timeZone ? {...loaded,timeZone:p.timeZone} : loaded);setMessage("Template applied. Drawings remain with their instrument and timeframe.");}else setMessage("No template saved in this browser yet.");}}>Load template</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!hasCandles} onClick={exportImage}>Export PNG</Button>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-2 text-zinc-400" aria-label="Chart date navigation">
      <span>Range</span>{[["1D",86400],["5D",432000],["1M",2592000],["3M",7776000],["1Y",31536000]].map(([label,seconds])=><button key={label} type="button" className="rounded px-2 py-1 text-[11px] hover:bg-zinc-800 focus-visible:outline focus-visible:outline-sky-400 disabled:opacity-40" disabled={!hasCandles} onClick={()=>{const range=adapter?.showRecentRange?.(Number(seconds));setMessage(range ? range.complete ? "Range shown from loaded history." : "Showing available history; the requested range starts before the loaded candles." : "No history available.");}}>{label}</button>)}
      <form className="flex flex-wrap items-center gap-2" onSubmit={event=>{event.preventDefault();const parsed=parseWallClockInZone(goToDate,zone);
          if(parsed.kind==="invalid"){setMessage("Enter a complete date and time.");return;}
          if(parsed.kind==="gap"){setMessage(`That time does not exist in ${zoneText} (clock change). Choose another time.`);return;}
          const repeated=parsed.ambiguous ? " Repeated clock-change time: the earlier occurrence was used." : "";
          setMessage((adapter?.goToTime?.(parsed.time) ? `Centered on the first loaded candle at or after that ${zoneText} time.` : historyWindowOnly ? `That ${zoneText} time is outside the revealed replay window. Reveal more bars or choose an earlier time.` : `That ${zoneText} time is outside loaded history. Pan left to load older candles, then try again.`)+repeated);}}>
        <input type="datetime-local" step="60" aria-label={`Go to ${zoneText} date and time`} className={`${field} max-w-full`} value={goToDate} onChange={event=>setGoToDate(event.target.value)} required />
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!hasCandles || !goToDate} type="submit">{`Go to ${zoneText}`}</Button>
      </form>
    </div>
    {preferences.studies.length > 0 && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px]" aria-label="Active studies">{preferences.studies.map(study=><span key={studyId(study)} style={{color:study.color}}>{studyLabel(study)}</span>)}</div>}
    {tool && <p className="mt-2 text-amber-300" role="status">{names[tool]}: {anchor ? "choose the second candle and price" : "click or tap a candle at the desired price"}. Escape cancels. Drawings are analysis only.</p>}
    {panOnly && <p className="mt-2 text-zinc-400" role="status">Pan mode · drag through history without moving drawings. Use + / − to zoom and arrow keys to pan while the chart is focused.</p>}
    {message && <p className="mt-2 text-zinc-300" role="status">{message}</p>}
    {storageFailed && <p className="mt-2 text-amber-300" role="alert">Browser storage is unavailable. Drawing changes will be lost when this view closes.</p>}
    {panel === "studies" && <ChartStudySettings preferences={preferences} onPreferences={onPreferences} />}
    {panel === "objects" && <div className="mt-3 space-y-2 rounded border border-zinc-800 p-3" aria-label="Drawing objects">
      <div className="flex flex-wrap items-center gap-2"><p className="flex-1 text-zinc-400">{ephemeralDrawings ? <>Private to this replay session · {symbol} · {timeframe}. Drawings are discarded when the session closes.</> : <>Saved on this browser for {symbol} · {timeframe}. Lines outside loaded history appear when their candles load.</>}</p><Button size="sm" variant="outline" className="h-8 text-xs" aria-pressed={hidden} onClick={()=>setHidden(h=>!h)}>{hidden ? "Show drawings" : "Hide drawings"}</Button></div>
      {!drawings.length && <p>No drawings on this chart. Choose a drawing tool to begin.</p>}
      {drawings.map((d,index)=><div key={d.id} className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2" data-testid="chart-drawing-object">
        <button type="button" className={`w-36 rounded p-1 text-left ${selectedId===d.id ? "bg-sky-500/15 text-sky-300" : "hover:bg-zinc-800"}`} aria-pressed={selectedId===d.id} aria-label={`Select drawing ${index+1}`} onClick={()=>setSelectedId(d.id)}>{index+1}. {names[d.kind]}</button>
        {(["start","end"] as const).filter(name=>d[name]).map(name=><label key={name} className="flex flex-wrap items-center gap-2">{name}<input key={d[name]!.price} aria-label={`Drawing ${index+1} ${name} price`} className={`${field} w-32`} type="number" step="any" min="0.00000001" disabled={d.locked || d.kind === "vertical"} defaultValue={Number(d[name]!.price.toPrecision(10))} onBlur={e=>{const price=Number(e.target.value);if(Number.isFinite(price)&&price>0) change(drawings.map(item=>item.id === d.id ? {...item,[name]:{...item[name]!,price}} : item));else e.target.value=String(d[name]!.price);}}/><span className="text-[10px] text-zinc-500">{formatChartTime(d[name]!.time,zone)}</span></label>)}
        <input type="color" aria-label={`Drawing ${index+1} color`} className="h-7 w-8 bg-transparent" value={d.color} onChange={e=>change(drawings.map(item=>item.id===d.id ? {...item,color:e.target.value} : item))}/>
        <select className={field} aria-label={`Drawing ${index+1} line width`} value={d.width ?? 1} onChange={event=>change(drawings.map(item=>item.id===d.id ? {...item,width:Number(event.target.value) as 1|2|3} : item))}>{[1,2,3].map(width=><option key={width} value={width}>{width}px</option>)}</select>
        <select className={field} aria-label={`Drawing ${index+1} line style`} value={(d.dashed ?? ["horizontal","fibonacci"].includes(d.kind)) ? "dashed" : "solid"} onChange={event=>change(drawings.map(item=>item.id===d.id ? {...item,dashed:event.target.value==="dashed"} : item))}><option value="solid">Solid</option><option value="dashed">Dashed</option></select>
        <Button size="sm" variant="ghost" className="h-8 text-xs" aria-label={`${d.locked ? "Unlock" : "Lock"} drawing ${index+1}`} aria-pressed={!!d.locked} onClick={()=>change(drawings.map(item=>item.id===d.id ? {...item,locked:!item.locked} : item))}>{d.locked ? "Unlock" : "Lock"}</Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" aria-label={`Delete drawing ${index+1}`} onClick={()=>change(drawings.filter(item=>item.id!==d.id))}>Delete</Button>
      </div>)}
    </div>}
  </div>;
}
