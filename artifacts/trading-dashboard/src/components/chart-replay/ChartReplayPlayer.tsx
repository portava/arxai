import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChartWorkbenchTools } from "@/components/charts/ChartWorkbenchTools";
import { SmartChartReader } from "@/components/charts/SmartChartReader";
import { createChartEngineAdapter, type ChartEngineAdapter } from "@/lib/chart-engine";
import { validatePreferences } from "@/lib/chart-engine/chartWorkspace";
import { replayCount, replayCountAtClose, replayDrawingKey, replayPrefix, REPLAY_SPEEDS, type ChartReplaySnapshot } from "@/lib/chart-engine/chartReplay";
const NO_OLDER = [] as const;
const utc=(time:number)=>new Date(time*1000).toISOString().replace("T"," ").replace(".000Z"," UTC");
const dateInput=(time:number)=>new Date(time*1000).toISOString().slice(0,19);

/** No data hooks, SSE, positions, order controls or current intelligence. The
 * view-only adapter receives only the immutable source-bound historical prefix. */
export default function ChartReplayPlayer({snapshot,onExit}:{snapshot:ChartReplaySnapshot;onExit:()=>void}) {
  const [count,setCount]=useState(Math.min(100,snapshot.bars.length));
  const [playing,setPlaying]=useState(false);
  const [speed,setSpeed]=useState<number>(1);
  const [preferences,setPreferences]=useState(()=>validatePreferences(snapshot.preferences));
  const [epoch,setEpoch]=useState(0);
  const [date,setDate]=useState("");
  const [message,setMessage]=useState("");
  const [installed,setInstalled]=useState(0);
  const container=useRef<HTMLDivElement>(null);
  const adapter=useRef<ChartEngineAdapter|null>(null);
  const replayRead=useMemo(()=>({snapshot,installedCount:installed}),[snapshot,installed]);
  const current=snapshot.bars[count-1]!;
  const seek=(next:number)=>{setPlaying(false);setCount(replayCount(next,snapshot.bars.length));setMessage("");};
  useLayoutEffect(()=>{
    if(!container.current)return;
    const engine=createChartEngineAdapter();adapter.current=engine;
    engine.init({container:container.current,height:600,visibleDesktop:150,visibleMobile:80});
    engine.setSymbol?.(snapshot.symbol);engine.setTimeframe?.(snapshot.timeframe);
    engine.setFeedState({livePriceAffordance:false,source:snapshot.source});
    engine.setOverlays([],null);engine.setStructureLines?.([],[]);
    const observer=new ResizeObserver(()=>engine.resize());observer.observe(container.current);
    setEpoch(value=>value+1);
    return()=>{observer.disconnect();engine.destroy();adapter.current=null;};
  },[snapshot]);
  useLayoutEffect(()=>{
    const engine=adapter.current;if(!engine)return;
    engine.setChartStyle?.(preferences.style);engine.setScaleMode?.(preferences.scale);
    engine.setPriceScaleInverted?.(preferences.inverted===true);engine.setStudies?.(preferences.studies);
  },[preferences,epoch]);
  useLayoutEffect(()=>{
    const engine=adapter.current;if(!engine)return;
    const prefix=replayPrefix(snapshot,count);
    // Synchronous before-paint replacement prevents a backwards seek from
    // showing a later bar under the new cursor. The adapter recalculates studies
    // only from the supplied prefix, including backwards and non-adjacent seeks.
    engine.setCandles(prefix,{revealLatest:true});
    setInstalled(count);
    const witness={sessionId:snapshot.id,symbol:snapshot.symbol,timeframe:snapshot.timeframe,source:snapshot.source,
      sourceIdentity:snapshot.sourceIdentity,count,lastOpenTime:prefix.at(-1)!.time,lastClose:prefix.at(-1)!.close,appliedAt:performance.now()};
    container.current?.dispatchEvent(new CustomEvent("arx.chart.replay.applied",{bubbles:true,detail:witness}));
  },[snapshot,count,epoch]);
  useEffect(()=>{
    if(!playing || count>=snapshot.bars.length || document.hidden){if(playing)setPlaying(false);return;}
    // One bar per delivered timer. No catch-up burst after a busy/hidden tab.
    const timer=window.setTimeout(()=>setCount(value=>Math.min(snapshot.bars.length,value+1)),1000/speed);
    return()=>clearTimeout(timer);
  },[playing,count,speed,snapshot.bars.length]);
  useEffect(()=>{
    const pause=()=>{if(document.hidden)setPlaying(false);};
    document.addEventListener("visibilitychange",pause);window.addEventListener("blur",pause);
    return()=>{document.removeEventListener("visibilitychange",pause);window.removeEventListener("blur",pause);};
  },[]);
  useEffect(()=>{
    const keyboard=(event:KeyboardEvent)=>{
      const target=event.target;
      if((target instanceof Element && target.closest("input,select,textarea,button,[contenteditable=true]")) || event.altKey || event.ctrlKey || event.metaKey)return;
      if(event.key==="ArrowRight"){event.preventDefault();seek(count+1);}
      if(event.key==="ArrowLeft"){event.preventDefault();seek(count-1);}
      if(event.code==="Space"){event.preventDefault();if(!document.hidden && count<snapshot.bars.length)setPlaying(value=>!value);}
    };
    window.addEventListener("keydown",keyboard);return()=>window.removeEventListener("keydown",keyboard);
  },[count,snapshot.bars.length]);
  return <main className="min-h-screen min-w-0 bg-zinc-950 p-3 text-zinc-100 md:p-5" data-testid="chart-replay">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-wider text-amber-300">Historical replay · analysis only</p>
        <h1 className="text-xl font-semibold">{snapshot.symbol} · {snapshot.timeframe}</h1></div>
      <Button variant="outline" onClick={()=>{setPlaying(false);onExit();}}>Exit replay · load current data</Button>
    </header>
    <p className="my-3 max-w-4xl text-xs text-zinc-400">Frozen {snapshot.source} response window: {snapshot.bars.length.toLocaleString()} closed bars, {utc(snapshot.bars[0]!.time)} to {utc(snapshot.lastClosedAt)}. Captured {utc(snapshot.capturedAt/1000)}. Current prices, positions, trading and live advice are not shown here. This is not a fill simulation or verified strategy result.</p>
    {snapshot.source==="mt5_broker" && <p className="mb-3 text-xs text-amber-300">This source identity does not attest each candle’s historical broker account. Account-era history remains unverified.</p>}
    {snapshot.gaps>0 && <p className="mb-3 text-xs text-amber-300">{snapshot.gaps} gaps in the available history. No missing bars were filled; session closures and missing data are not distinguished here.</p>}
    <section aria-label="Replay controls" className="space-y-3 rounded border border-amber-600/40 bg-amber-950/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={()=>seek(1)} disabled={count===1}>Start</Button>
        <Button variant="outline" onClick={()=>seek(count-1)} disabled={count===1} aria-label="Previous replay bar">← Previous</Button>
        <Button onClick={()=>{if(!document.hidden)setPlaying(value=>!value);}} disabled={count===snapshot.bars.length} aria-pressed={playing}>{playing ? "Pause" : "Play"}</Button>
        <Button variant="outline" onClick={()=>seek(count+1)} disabled={count===snapshot.bars.length} aria-label="Next replay bar">Next →</Button>
        <label className="flex items-center gap-2 text-xs">Speed <select aria-label="Replay speed" className="rounded border border-zinc-700 bg-zinc-900 p-2" value={speed} onChange={event=>setSpeed(Number(event.target.value))}>{REPLAY_SPEEDS.map(value=><option key={value} value={value}>{value} bars/s</option>)}</select></label>
        <span role="status" className="text-xs" data-testid="replay-cursor">Bar {count.toLocaleString()} / {snapshot.bars.length.toLocaleString()} · closed {utc(current.closeTime)} · {count===snapshot.bars.length ? "End of available history" : playing ? "Playing" : "Paused"}</span>
      </div>
      <input aria-label="Replay position" type="range" className="w-full accent-amber-400" min={1} max={snapshot.bars.length} value={count} onChange={event=>seek(Number(event.target.value))}/>
      <form className="flex flex-wrap items-center gap-2 text-xs" onSubmit={event=>{event.preventDefault();const next=replayCountAtClose(snapshot,Date.parse(`${date}Z`)/1000);if(next==null)setMessage("Choose a UTC close within the loaded window.");else{seek(next);setMessage("Showing closed candles at or before that UTC time.");}}}>
        <label>Through UTC close <input className="ml-2 max-w-full rounded border border-zinc-700 bg-zinc-900 p-2" type="datetime-local" step="1" aria-label="Replay through UTC close" min={dateInput(snapshot.bars[0]!.closeTime)} max={dateInput(snapshot.lastClosedAt)} value={date} onChange={event=>setDate(event.target.value)} required/></label>
        <Button size="sm" variant="outline" type="submit">Seek</Button>
        <span className="text-zinc-400">Arrow keys step outside the chart · Space plays/pauses outside controls</span>
      </form>
      {message && <p role="status" className="text-xs text-amber-200">{message}</p>}
    </section>
    <div className="mt-3 overflow-hidden rounded border border-zinc-800">
      <SmartChartReader adapter={adapter.current} epoch={epoch} symbol={snapshot.symbol} timeframe={snapshot.timeframe}
        data={undefined} older={NO_OLDER} historyEvidence={null} liveConfirmed={false} readFailed={false} view={preferences} replay={replayRead}/>
      <ChartWorkbenchTools key={snapshot.id} adapter={adapter.current} epoch={epoch} symbol={snapshot.symbol} timeframe={snapshot.timeframe}
        preferences={preferences} onPreferences={setPreferences} hasCandles={installed>0}
        drawingKey={replayDrawingKey(snapshot)} ephemeralDrawings historyWindowOnly feedLabel={`HISTORICAL REPLAY · ${snapshot.source} · through ${utc(current.closeTime)} · not live or tradable`}/>
      <div ref={container} className="w-full" style={{height:600}} data-testid="replay-canvas"
        tabIndex={0} role="region" aria-label={`${snapshot.symbol} ${snapshot.timeframe} historical replay chart. Arrow keys pan, plus or minus zoom; Home fits revealed bars and End returns to the replay cursor.`}
        onKeyDown={event=>{
          if(event.target!==event.currentTarget || event.ctrlKey || event.metaKey || event.altKey)return;
          if(!["ArrowLeft","ArrowRight","+","=","-","_","Home","End"].includes(event.key))return;
          event.preventDefault();event.stopPropagation();
          if(event.key==="ArrowLeft" || event.key==="ArrowRight")adapter.current?.panBy?.(event.key==="ArrowLeft"?-.25:.25);
          if(event.key==="+" || event.key==="=")adapter.current?.zoomBy?.(.75);
          if(event.key==="-" || event.key==="_")adapter.current?.zoomBy?.(4/3);
          if(event.key==="Home")adapter.current?.fitHistory?.();
          if(event.key==="End")adapter.current?.goToLatest?.(false);
        }} data-installed-count={installed}
        data-source={snapshot.source} data-source-identity={snapshot.sourceIdentity} data-last-open={snapshot.bars[Math.max(0,installed-1)]?.time}/>
    </div>
    <p className="mt-3 text-xs text-zinc-400">Studies use only revealed bars. Replay drawings are separate from live charts and belong only to this private session. Multi-chart replay, saved sessions and historical order simulation are not yet available.</p>
  </main>;
}
