import {prepareVwapStudy,selectVwapAnchor} from "@/lib/chart-engine/chartVwapAnchor";
import {formatSourceChartTime} from "@/lib/chart-engine/chartClockEvidence";
import type {ChartEngineAdapter} from "@/lib/chart-engine/types";
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { MAX_STUDIES, STUDY_CATALOG, studyDefinition, studyId, studyChannelColor, studyLabel, type ChartStudy } from "@/lib/chart-engine/chartStudies";
import { validatePreferences, type ChartPreferences } from "@/lib/chart-engine/chartWorkspace";

const field = "h-8 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100";
const sourceOptions = [
  ["close", "Close"], ["open", "Open"], ["high", "High"], ["low", "Low"],
  ["hl2", "Median (H + L) / 2"], ["hlc3", "Typical (H + L + C) / 3"],
  ["hlcc4", "Weighted (H + L + 2C) / 4"], ["ohlc4", "Average OHLC"],
];
const averageOptions = [["sma", "Simple (SMA)"], ["ema", "Exponential (EMA)"], ["smma", "Wilder (SMMA / RMA)"], ["wma", "Linear weighted (WMA)"]];
interface Props { adapter?:ChartEngineAdapter|null; preferences: ChartPreferences; onPreferences: Dispatch<SetStateAction<ChartPreferences>> }

/** Each instance has its own identity: editing EMA 20 must not edit EMA 200. */
export function ChartStudySettings({ preferences, onPreferences, adapter }: Props) {
  const [message,setMessage]=useState("");
  const [anchorSearch,setAnchorSearch]=useState("");
  const hasVwap=preferences.studies.some(study=>study.kind === "vwap");
  const [visibleBars,setVisibleBars]=useState<ReturnType<NonNullable<ChartEngineAdapter["getVisibleCandles"]>>>([]);
  const refreshAnchorChoices=()=>setVisibleBars(adapter?.getVisibleCandles?.()??[]);
  // No pan/zoom subscription: getVisibleCandles clones original bars. Read only
  // when focusing anchor controls, then revalidate on the action. Opening the
  // panel or adding unrelated studies does not clone the visible history.
  useEffect(()=>setVisibleBars([]),[adapter,hasVwap]);
  // Cap option DOM work. Every actual visible bar remains reachable by its
  // calendar-coordinate search, rather than silently truncating the selectable range.
  const anchorOptions=useMemo(()=>{
    const found=[] as typeof visibleBars;
    const query=anchorSearch.trim().replace("T"," ");
    for(const bar of visibleBars){
      if(!query || new Date(bar.time*1000).toISOString().slice(0,19).replace("T"," ").includes(query))found.push(bar);
      if(found.length===100)break;
    }
    return found;
  },[visibleBars,anchorSearch]);
  const [query, setQuery] = useState("");
  const full = preferences.studies.length >= MAX_STUDIES;
  const matches = STUDY_CATALOG.filter(item => `${item.name} ${item.defaults.kind} ${item.group} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const add = (config: ChartStudy) => {
    const prepared=prepareVwapStudy(config,config.kind === "vwap" && !config.vwapAnchor ? adapter?.getVisibleCandles?.()??[] : []);
    if(!prepared.study){setMessage(prepared.reason);return;}
    setMessage("");
    onPreferences(previous => previous.studies.length >= MAX_STUDIES ? previous : validatePreferences({
      ...previous, studies: [...previous.studies, { ...prepared.study, id: crypto.randomUUID() }],
    }));
  };
  const update = (id: string, change: Partial<ChartStudy>) => onPreferences(previous => validatePreferences({
    ...previous, studies: previous.studies.map(study => studyId(study) === id ? { ...study, ...change } : study),
  }));
  return <section className="mt-3 space-y-3 rounded border border-zinc-800 p-3" aria-label="Study settings">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="font-medium text-zinc-100">Study library</h3><p className="mt-1 text-zinc-400">{STUDY_CATALOG.length} studies · up to {MAX_STUDIES} independent instances per chart</p></div>
      <input className={`${field} w-full sm:w-64`} type="search" aria-label="Search studies" placeholder="Search name, type or method…" value={query} onChange={event => setQuery(event.target.value)} />
    </div>
    <div className="grid max-h-52 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3" aria-label="Available studies">
      {matches.map(item => <button type="button" key={item.defaults.kind} disabled={full} className="rounded border border-zinc-800 p-2 text-left hover:border-zinc-600 hover:bg-zinc-800/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-40" aria-label={`Add ${item.name}`} title={item.description} onClick={() => add(item.defaults)}>
        <span className="flex items-center justify-between gap-2"><span className="text-zinc-100">{item.name}</span><span aria-hidden="true" className="text-sky-300">+</span></span>
        <span className="mt-1 block text-[10px] text-zinc-500">{item.defaults.kind.toUpperCase()} · {item.group}</span>
      </button>)}
      {!matches.length && <p className="p-2 text-zinc-400">No matching studies.</p>}
    </div>
    {message && <p role="status" className="text-amber-300">{message}</p>}
    {full && <p role="status" className="text-amber-300">This chart has {MAX_STUDIES} studies. Remove one before adding another.</p>}
    <p className="text-[11px] leading-relaxed text-zinc-400">Uses loaded candles, including the forming bar. Warm-up bars stay blank. EMA stages start with a simple average; loading older history can change seeded values. Study settings and price sources must match when comparing platforms.</p>
    {!preferences.studies.length && <p className="text-zinc-400">Add a study above. You can add the same study more than once.</p>}
    <div className="space-y-2">
      {preferences.studies.map((config, index) => {
        const definition = studyDefinition(config.kind);
        const id = studyId(config);
        const label = `${config.kind.toUpperCase()} ${index + 1}`;
        const number = (name: "period" | "slow" | "signal" | "smoothing" | "multiplier", caption: string, min = 1, max = 1000, step = 1) => <label className="flex items-center gap-2">{caption}<input key={`${id}-${name}-${config[name]}`} className={`${field} w-20`} aria-label={`${label} ${caption}`} type="number" min={min} max={max} step={step} defaultValue={config[name]} onBlur={event => {
          if (event.target.validity.valid && event.target.value) update(id, { [name]: Number(event.target.value) });
          else event.target.value = String(config[name]);
        }} /></label>;
        return <fieldset key={id} className="rounded border border-zinc-800 px-3 pb-3" data-testid="chart-study-instance">
          <legend className="px-1 font-medium" style={{ color: config.color }}>{index + 1}. {studyLabel(config)}</legend>
          <p className="mb-2 text-[11px] text-zinc-500">{definition.description}{config.kind === "dmi" ? " Default colors: +DI green, −DI rose; the main Color changes ADX. Individual overrides are in Line appearance. Each stage waits for its full window. Loading older candles can change seeded values." : ""}</p>
          <div className="flex flex-wrap items-center gap-3">
            {!["tick_volume","trade_volume","vwap"].includes(config.kind) && number("period", config.kind === "macd" ? "Fast" : config.kind === "dmi" ? "DI period" : "Period", 1, config.kind === "macd" ? (config.slow ?? 26) - 1 : 1000)}
            {config.kind === "macd" && <>{number("slow", "Slow", config.period + 1)}{number("signal", "Signal")}
              <label className="flex items-center gap-2">Signal method<select aria-label={`${label} Signal method`} className={field} value={config.signalMethod ?? "ema"} onChange={event => update(id, { signalMethod: event.target.value as ChartStudy["signalMethod"] })}><option value="ema">EMA</option><option value="sma">SMA (MT5)</option></select></label>
            </>}
            {config.kind === "dmi" && number("signal", "ADX smoothing")}
            {config.kind === "stochastic" && <>{number("smoothing", "K smoothing")}{number("signal", "D period")}</>}
            {config.kind === "bollinger" && number("multiplier", "Deviation", .1, 100, .1)}
            {config.kind === "envelopes" && number("multiplier", "Width %", .01, 100, .01)}
            {definition.appliedPrice && <label className="flex items-center gap-2">Source<select className={`${field} max-w-52`} aria-label={`${label} Source`} value={config.source ?? (["cci","vwap"].includes(config.kind) ? "hlc3" : "close")} onChange={event => update(id, { source: event.target.value as ChartStudy["source"] })}>{sourceOptions.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>}
            {(config.kind === "atr" || config.kind === "envelopes") && <label className="flex items-center gap-2">Smoothing<select className={`${field} max-w-52`} aria-label={`${label} Smoothing`} value={config.method ?? (config.kind === "atr" ? "smma" : "sma")} onChange={event => update(id, { method: event.target.value as ChartStudy["method"] })}>{averageOptions.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>}
            {config.kind === "vwap" && <div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2">Find visible bar<input className={`${field} w-48`} aria-label={`${label} Find visible anchor bar`} placeholder="YYYY-MM-DD HH:mm" onFocus={refreshAnchorChoices} value={anchorSearch} onChange={event=>setAnchorSearch(event.target.value)}/></label><label className="flex items-center gap-2">Observed-bar anchor<select className={`${field} max-w-80`} aria-label={`${label} Observed-bar anchor`} value={config.vwapAnchor?.time ?? ""} onFocus={refreshAnchorChoices} onChange={event=>{
              const selected=selectVwapAnchor(adapter?.getVisibleCandles?.()??[],Number(event.target.value));
              if(!selected.anchor){setMessage(selected.reason);return;}
              update(id,{vwapAnchor:selected.anchor});setMessage("");
            }}>
              {!config.vwapAnchor && <option value="">Select a qualified visible bar</option>}
              {config.vwapAnchor && !anchorOptions.some(bar=>bar.time===config.vwapAnchor!.time) && <option value={config.vwapAnchor.time}>{formatSourceChartTime(config.vwapAnchor.time,false,"UTC",{seconds:true})} · saved anchor, outside listed matches</option>}
              {anchorOptions.map(bar=><option key={bar.time} value={bar.time}>{formatSourceChartTime(bar.time,false,"UTC",{seconds:true})}</option>)}
            </select></label><button type="button" className="rounded border border-zinc-700 px-2 py-1 text-xs" onClick={()=>{const current=adapter?.getVisibleCandles?.()??[];setVisibleBars(current);const selected=selectVwapAnchor(current);if(!selected.anchor){setMessage(selected.reason);return;}update(id,{vwapAnchor:selected.anchor});setMessage("");}}>Re-anchor to first visible bar</button><span className="text-[11px] text-zinc-400">Frozen original bar; changing the viewport does not change this anchor. Loaded observations only; no assumed session start. Up to 100 matching visible bars are listed; search to select another exact bar.</span></div>}
            <input type="color" aria-label={`${label} Color`} className="h-8 w-9 bg-transparent" value={config.color} onChange={event => update(id, { color: event.target.value })} />
            <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={full} aria-label={`Duplicate study ${index + 1}`} onClick={() => add(config)}>Duplicate</Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" aria-label={`Remove study ${index + 1}`} onClick={() => onPreferences(previous => ({ ...previous, studies: previous.studies.filter(study => studyId(study) !== id) }))}>Remove</Button>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-zinc-300">Line appearance</summary>
            <p className="mt-2 text-[11px] text-zinc-400">Hidden lines keep their calculated values in the data window. Appearance does not change the calculation.</p>
            <div className="mt-2 space-y-2">
              {definition.channels.map((name,channel)=>{
                const style=config.lineStyles?.[channel] ?? {};
                const histogram=["tick_volume","trade_volume"].includes(config.kind) || config.kind === "macd" && channel === 2;
                const change=(patch:Partial<NonNullable<ChartStudy["lineStyles"]>[number]>)=>update(id,{lineStyles:Array.from({length:definition.channels.length},(_,i)=>i === channel ? {...(config.lineStyles?.[i] ?? {}),...patch} : {...(config.lineStyles?.[i] ?? {})})});
                const prefix=`${label} ${name}`;
                return <div key={name} className="flex flex-wrap items-center gap-3">
                  <label className="flex min-w-24 items-center gap-2"><input type="checkbox" aria-label={`${prefix} visible`} checked={style.visible !== false} onChange={event=>change({visible:event.target.checked})}/>{name}</label>
                  {histogram ? <span className="text-[11px] text-zinc-400">Histogram colors keep their positive/negative meaning.</span> : <>
                    <label className="flex items-center gap-2">Color<input type="color" aria-label={`${prefix} color`} className="h-8 w-9 bg-transparent" value={studyChannelColor(config,channel)} onChange={event=>change({color:event.target.value})}/></label>
                    <label className="flex items-center gap-2">Width<select className={field} aria-label={`${prefix} width`} value={style.width ?? 1} onChange={event=>change({width:Number(event.target.value) as 1|2|3})}>{[1,2,3].map(width=><option key={width} value={width}>{width}</option>)}</select></label>
                    <label className="flex items-center gap-2">Style<select className={field} aria-label={`${prefix} style`} value={style.style ?? "solid"} onChange={event=>change({style:event.target.value as "solid"|"dashed"|"dotted"})}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></label>
                  </>}
                </div>;
              })}
              <Button size="sm" variant="ghost" className="h-8 text-xs" aria-label={`Reset study ${index+1} line appearance`} disabled={!config.lineStyles?.length} onClick={()=>update(id,{lineStyles:undefined})}>Reset line appearance</Button>
            </div>
          </details>
        </fieldset>;
      })}
    </div>
  </section>;
}
