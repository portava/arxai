import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import type { DeepReadonly, ResearchV2Config, ResearchV2Result } from "@workspace/domain/backtest/research-core";
import { freezeResearch } from "@workspace/domain/backtest/research-core";
import { captureChartResearchWindow, bindChartResearchResult, chartResearchContextKey, type ChartResearchSnapshot } from "@/lib/chart-engine/chartResearchEvidence";
import { createChartResearchDraft, defaultChartResearchSettings, describeChartResearchDraft, finalizeChartResearchConfig, parseChartResearchRequest, type ChartResearchSettings } from "@/lib/chart-engine/chartResearchDraft";
import type { ChartEngineCandle } from "@/lib/chart-engine";
import type { ChartOverlay } from "@/lib/chart-overlays";
import { createBrowserResearchRunner } from "@/lib/chart-research/researchRunner";
import type { ChartResearchExplanation } from "@/lib/chart-research/chartResearchAssistant";
import { Button } from "@/components/ui/button";

interface Props {
  data: ChartCandlesResponse | undefined;
  symbol: string; timeframe: string;
  canonicalBars: readonly ChartEngineCandle[];
  getVisibleBars: () => ChartEngineCandle[];
  request: { id: number; text: string } | null;
  onOverlays: (overlays: ChartOverlay[]) => void;
  onExplanation: (evidence: ChartResearchExplanation | null) => void;
  onClose: () => void;
}
type Completed = { snapshot: ChartResearchSnapshot; config: ResearchV2Config; result: DeepReadonly<ResearchV2Result> };
const number = (value: number) => Number.isFinite(value) ? Number(value.toPrecision(8)).toString() : "Unavailable";
const stamp = (value: number) => Number.isFinite(value) ? new Date(value).toISOString() : "";
const label = (value: string) => value.replaceAll("_", " ");

/** An editor/view over the existing causal engine, never a second simulator.
 * Mounted on demand; calculation lives in a disposable Worker, not the chart. */
export default function ChartResearchWorkbench({ data, symbol, timeframe, canonicalBars, getVisibleBars, request, onOverlays, onExplanation, onClose }: Props) {
  const runner = useMemo(createBrowserResearchRunner, []);
  const capture = () => captureChartResearchWindow({ data, expected: {symbol,timeframe}, visibleBars:getVisibleBars(), asOfMs:Date.now() });
  const [initial] = useState(capture);
  const [settings, setSettings] = useState<ChartResearchSettings | null>(() => initial.status === "ready" ? defaultChartResearchSettings({fromInclusiveMs:initial.snapshot.coverage.fromInclusiveMs,toExclusiveMs:initial.snapshot.coverage.toExclusiveMs}) : null);
  const [closedThrough, setClosedThrough] = useState(initial.status === "ready" ? initial.snapshot.coverage.toExclusiveMs : 0);
  const [message, setMessage] = useState(initial.reason ?? "Review the explicit scenario below, then run. Nothing runs automatically.");
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<Completed | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const generation = useRef(0);
  const contextKey = chartResearchContextKey({symbol,timeframe},data?.marketEvidence?.source,data?.marketEvidence?.sourceIdentity);
  const current = useRef({contextKey,bars:canonicalBars,data,asOfMs:Date.now()});
  current.current={contextKey,bars:canonicalBars,data,asOfMs:Date.now()};
  const invalidate = () => { generation.current++;runner.cancel();setBusy(false);setCompleted(null);setSelected(null);setPage(0); };
  useEffect(() => () => runner.cancel(), [runner]);
  const draft = useMemo(() => settings ? createChartResearchDraft({symbol,timeframe,closedThroughMs:closedThrough},settings) : null,[settings,symbol,timeframe,closedThrough]);

  useEffect(() => {
    if (!request) return;
    const captured=capture();
    invalidate();
    if(captured.status!=="ready") {setSettings(null);setMessage(captured.reason);return;}
    const parsed=parseChartResearchRequest(request.text,{symbol,timeframe,closedThroughMs:captured.snapshot.coverage.toExclusiveMs});
    if(!parsed||parsed.kind==="unsupported") {setSettings(null);setMessage(parsed?.message??"This request is not a supported historical rule. Choose visible closed bars to prepare a new manual draft; no request was partially applied.");return;}
    setClosedThrough(captured.snapshot.coverage.toExclusiveMs);setSettings(parsed.draft);
    setMessage(parsed.disclosures[0]!);
    // A request is consumed exactly once. Feed polls do not reset manual edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[request?.id]);

  const binding=useMemo(()=>completed?bindChartResearchResult(completed.snapshot,completed.result,{contextKey,bars:canonicalBars,data,asOfMs:Date.now()},completed.config):null,[completed,contextKey,canonicalBars,data]);
  const selectedTrade=selected!=null&&binding?.status==="ready"?binding.trades[selected]:null;
  const selectedLedger=selectedTrade&&completed?.result.partitions.find(p=>p.name===selectedTrade.partition)?.trades[selectedTrade.tradeIndex];
  const explanation = useMemo(()=>{
    if(!selectedTrade||!selectedLedger||!completed)return null;
    const decision=completed.result.partitions.find(p=>p.name===selectedTrade.partition)?.decisions.find(d=>d.signalIndex===selectedLedger.signalIndex);
    if(!decision)return null;
    const s=decision.signal;
    return `${symbol} ${timeframe}, selected ${selectedTrade.partition} historical trade (result ${completed.result.fingerprints.result.slice(0,12)}). At signal close ${stamp(decision.knownThroughMs)}, fast/slow EMA changed from ${number(s.previousFastEma)}/${number(s.previousSlowEma)} to ${number(s.fastEma)}/${number(s.slowEma)}. ATR was ${number(s.atr)}; the frozen stop distance was ${number(s.stopDistancePriceUnits)}. The ${selectedTrade.side} entry was modeled at the next observed open, ${stamp(selectedTrade.entry.barOpenMs)}, price ${number(selectedTrade.entry.price)}. Stop ${number(selectedTrade.stopPrice)}; target ${number(selectedTrade.targetPrice)}. Exit ${number(selectedTrade.exit.price)}: ${label(selectedTrade.reason)}, ${selectedTrade.exit.fillTime.precision==='open'?'modeled at open':'somewhere in the OHLC interval'} ${stamp(selectedTrade.exit.fillTime.earliestMs)}${selectedTrade.exit.fillTime.precision==='bar_interval'?' to '+stamp(selectedTrade.exit.fillTime.latestMs):''}. ${selectedTrade.ambiguousStopAndTarget?'Both stop and target touched; conservative stop-first ordering was used. ':''}Gross ${number(selectedLedger.grossPriceUnits)} minus spread ${number(selectedLedger.spreadCostPriceUnits)}, slippage ${number(selectedLedger.slippageCostPriceUnits)} and fees ${number(selectedLedger.feeCostPriceUnits)} gives net ${number(selectedLedger.netPriceUnits)} price units per unit. This is a ledger-derived simulation, not a broker fill, account-currency return, confidence score or forecast.`;
  },[selectedTrade,selectedLedger,completed,symbol,timeframe]);
  const explanationEvidence = useMemo<ChartResearchExplanation>(()=>{
    if (!completed) return {status:"no_result",reason:"No completed historical test is available on this chart. Run a supported historical test before selecting a simulated trade. No trade was inferred and no order was sent."};
    if (binding?.status!=="ready") return {status:"unavailable",reason:`The historical result no longer matches the current chart evidence. ${binding?.reason??"Current source binding is unavailable."} Select a source-qualified result before asking about a trade; no other trade was substituted.`};
    if (selected === null) return {status:"no_selection",reason:"Select one completed simulated trade in Test an idea before asking about its outcome. No last, worst or live trade was substituted."};
    if (!selectedTrade || !selectedLedger || !explanation) return {status:"unavailable",reason:"The selected historical trade has incomplete ledger evidence. Its outcome cannot be explained; no other trade was substituted."};
    return {status:"ready",text:explanation,netPriceUnits:selectedLedger.netPriceUnits};
  },[completed,binding,selected,selectedTrade,selectedLedger,explanation]);
  useLayoutEffect(()=>{onExplanation(explanationEvidence);return()=>onExplanation(null);},[explanationEvidence,onExplanation]);
  const overlays=useMemo<ChartOverlay[]>(()=>{
    if(!selectedTrade)return [];
    const t=selectedTrade,prefix=`research:${completed!.result.fingerprints.result}:${t.partition}:${t.tradeIndex}`;
    const common={symbol,timeframe,source:"research" as const,metadata:{historical:true,executionAuthority:false}};
    return [
      {...common,id:prefix+":entry",type:"marker",startTime:t.entry.barOpenMs/1000,price:t.entry.price,label:`Test ${t.side} entry`,marker:{side:t.side},severity:"info"},
      {...common,id:prefix+":exit",type:"marker",startTime:t.exit.barOpenMs/1000,price:t.exit.price,label:`Test exit: ${label(t.reason)}`,marker:{side:t.side==="BUY"?"SELL":"BUY"},severity:"neutral"},
      {...common,id:prefix+":stop",type:"line",startTime:t.entry.barOpenMs/1000,endTime:t.exit.barOpenMs/1000,price:t.stopPrice,label:"Test stop",severity:"danger"},
      {...common,id:prefix+":target",type:"line",startTime:t.entry.barOpenMs/1000,endTime:t.exit.barOpenMs/1000,price:t.targetPrice,label:"Test target",severity:"success"},
    ];
  },[selectedTrade,completed,symbol,timeframe]);
  useLayoutEffect(()=>{onOverlays(overlays);return()=>onOverlays([]);},[overlays,onOverlays]);

  function edit(change:(previous:ChartResearchSettings)=>ChartResearchSettings) {
    invalidate();setMessage("Rules changed. Run again to calculate this scenario; the previous result has been cleared.");setSettings(previous=>previous?change(previous):previous);
  }
  function useVisible() {
    invalidate();const captured=capture();
    if(captured.status!=="ready"){setMessage(captured.reason);return;}
    setClosedThrough(captured.snapshot.coverage.toExclusiveMs);
    setSettings(previous=>previous?{...previous,requestedWindow:{fromInclusiveMs:captured.snapshot.coverage.fromInclusiveMs,toExclusiveMs:captured.snapshot.coverage.toExclusiveMs}}:defaultChartResearchSettings({fromInclusiveMs:captured.snapshot.coverage.fromInclusiveMs,toExclusiveMs:captured.snapshot.coverage.toExclusiveMs}));
    setMessage(`Selected ${captured.snapshot.coverage.closedBars} visible closed bars. ${captured.snapshot.coverage.excludedFormingBars} forming bar(s) excluded. No broader calendar coverage is claimed.`);
  }
  function run() {
    if(!draft||draft.kind!=="draft"){setMessage(draft?.message??"Load a source-qualified closed chart window first.");return;}
    const captured=captureChartResearchWindow({data,expected:{symbol,timeframe},visibleBars:getVisibleBars(),asOfMs:Date.now(),requestedWindow:draft.draft.requestedWindow});
    if(captured.status!=="ready"){setMessage(captured.reason);return;}
    const finalized=finalizeChartResearchConfig(draft.draft,captured.snapshot.researchInput.bars.length);
    if(!finalized.ok){setMessage(finalized.message);return;}
    invalidate();
    const revision=generation.current;
    setBusy(true);setMessage("Calculating the captured historical scenario in the background. The chart remains available.");
    runner.run(captured.snapshot.researchInput,finalized.config,outcome=>{
      if(revision!==generation.current)return;
      setBusy(false);
      if(outcome.status==="error"){setMessage(outcome.message);return;}
      const bound=bindChartResearchResult(captured.snapshot,outcome.result,current.current,finalized.config);
      if(bound.status!=="ready"){setMessage(bound.reason);return;}
      // Structured cloning from a Worker drops Object.freeze. Restore the
      // immutable snapshot before exposing any ledger row to the UI.
      setCompleted(freezeResearch({snapshot:captured.snapshot,config:finalized.config,result:outcome.result}));
      setMessage("Historical calculation finished. Results are simulated, unverified and expressed per unit in source price units. Select a trade to inspect its chart markers.");
    });
  }
  function download() {
    if(!completed)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(completed,null,2)],{type:"application/json"}));
    const a=document.createElement("a");a.href=url;a.download=`arx-historical-${completed.result.fingerprints.result.slice(0,12)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),0);
  }
  const numeric=(name:string,value:number,update:(value:number)=>void,step="any")=><label className="grid gap-1 text-xs">{name}<input className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5" aria-label={name} type="number" step={step} value={Number.isFinite(value)?value:""} onChange={e=>update(e.target.value===""?NaN:Number(e.target.value))}/></label>;
  return <section className="border-t border-zinc-700 bg-zinc-950 p-3 text-zinc-200" aria-label="Chart historical research" data-testid="chart-research-workbench">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">Test an idea · {symbol} {timeframe}</h3><p className="text-xs text-amber-300">Exploratory simulation · one unit · no orders or account-money returns</p></div><Button size="sm" variant="outline" onClick={onClose}>Close historical test</Button></div>
    <p role="status" className="my-2 text-xs" data-testid="chart-research-status">{message}</p>
    <Button size="sm" variant="outline" onClick={useVisible}>Use visible closed bars</Button>
    {settings&&<>
      <div className="my-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1 text-xs">Start UTC (inclusive)<input aria-label="Historical start UTC" className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5" type="datetime-local" step="60" value={stamp(settings.requestedWindow.fromInclusiveMs).slice(0,19)} onChange={e=>edit(s=>({...s,requestedWindow:{...s.requestedWindow,fromInclusiveMs:Date.parse(e.target.value+"Z")}}))}/></label>
        <label className="grid gap-1 text-xs">End UTC (exclusive)<input aria-label="Historical end UTC" className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5" type="datetime-local" step="60" value={stamp(settings.requestedWindow.toExclusiveMs).slice(0,19)} onChange={e=>edit(s=>({...s,requestedWindow:{...s.requestedWindow,toExclusiveMs:Date.parse(e.target.value+"Z")}}))}/></label>
        {([['Fast EMA','fastPeriod'],['Slow EMA','slowPeriod'],['ATR period','atrPeriod'],['Stop × ATR','stopAtrMultiple'],['Target R','targetR'],['Maximum hold bars','maxHoldingBars']] as const).map(([name,key])=><div key={key}>{numeric(name,settings.strategy[key],value=>edit(s=>({...s,strategy:{...s.strategy,[key]:value}})))}</div>)}
        <label className="grid gap-1 text-xs">Direction<select aria-label="Historical direction" className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5" value={settings.strategy.direction} onChange={e=>edit(s=>({...s,strategy:{...s.strategy,direction:e.target.value as ChartResearchSettings['strategy']['direction']}}))}><option value="long_only">Long only</option><option value="short_only">Short only</option><option value="both">Both directions</option></select></label>
        {([['Full spread · price units','fullSpreadPriceUnits'],['Slippage per fill · price units','adverseSlippagePerFillPriceUnits'],['Fee per fill · price units','feePerFillPriceUnits']] as const).map(([name,key])=><div key={key}>{numeric(name,settings.costs[key],value=>edit(s=>({...s,costs:{...s.costs,[key]:value}})))}</div>)}
        {numeric('Maximum entry delay · ms',settings.maxEntryGapMs,value=>edit(s=>({...s,maxEntryGapMs:value})),"1")}
        {numeric('Development share · %',settings.partitions.trainFraction*100,value=>edit(s=>({...s,partitions:{...s.partitions,trainFraction:value/100}})))}
        {numeric('Validation share · %',settings.partitions.validationFraction*100,value=>edit(s=>({...s,partitions:{...s.partitions,validationFraction:value/100}})))}
        <p className="self-end text-xs">Holdout receives the remaining share. Repeated editing exposes this holdout; it is not untouched validation.</p>
      </div>
      {draft?.kind==="draft"?<details className="my-2 text-xs"><summary className="cursor-pointer">Inspect executable rules and assumptions</summary><ul className="list-disc space-y-1 pl-5 pt-2">{describeChartResearchDraft(draft.draft).map(text=><li key={text}>{text}</li>)}</ul></details>:<p role="alert" className="my-2 text-xs text-amber-300">{draft?.message}</p>}
      <div className="flex gap-2"><Button size="sm" disabled={busy||draft?.kind!=="draft"} onClick={run}>Run historical test</Button>{busy&&<Button size="sm" variant="outline" onClick={()=>{invalidate();setMessage("Historical calculation cancelled. No result was accepted.");}}>Cancel calculation</Button>}</div>
    </>}
    {completed&&<div className="mt-4 space-y-3" data-testid="chart-research-result">
      <p className="text-xs">Frozen {completed.snapshot.coverage.closedBars}-bar sample · {completed.snapshot.researchInput.priceBasis} source prices · {stamp(completed.snapshot.coverage.fromInclusiveMs)} to {stamp(completed.snapshot.coverage.toExclusiveMs)}. Observed gaps: {completed.result.gapCount}.</p>
      {binding?.status==="unavailable"&&<p role="alert" className="text-xs text-amber-300">{binding.reason} The frozen result remains inspectable; its chart markers are withheld.</p>}
      <div className="overflow-x-auto"><table className="w-full min-w-[720px] whitespace-nowrap text-left text-xs [&_td]:px-2 [&_td]:py-2"><caption className="pb-2 text-left">Separate chronological partitions · all P&amp;L and drawdown values are price units per unit</caption><thead><tr>{['Partition','Closed trades','Net','Win rate','Profit factor','Bar-close drawdown','Open outcome'].map(x=><th className="p-2" key={x}>{x}</th>)}</tr></thead><tbody>{completed.result.partitions.map(p=><tr key={p.name} className="border-t border-zinc-800"><td className="p-2">{p.name==='train'?'development':p.name}</td><td>{p.metrics.completedTrades}</td><td>{number(p.metrics.completedNetPriceUnits)}</td><td>{p.metrics.winRate==null?'Unavailable':number(p.metrics.winRate*100)+'%'}</td><td>{p.metrics.profitFactor==null?label(p.metrics.profitFactorUnavailable??'unavailable'):number(p.metrics.profitFactor)}</td><td>{number(p.metrics.maxMarkedDrawdownPriceUnits)}</td><td>{p.openPosition?'Unresolved; hypothetical net '+number(p.openPosition.netIfLiquidatedPriceUnits):'None'}</td></tr>)}</tbody></table></div>
      {binding?.status==="ready"&&<>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] whitespace-nowrap text-left text-xs [&_td]:px-2 [&_td]:py-2"><caption className="text-left">Completed simulated trades · select one for two chart markers and stop/target references</caption><thead><tr>{['Inspect','Partition','Side','Entry UTC / price','Exit bar UTC / price','Reason','Net price units'].map(x=><th className="p-2" key={x}>{x}</th>)}</tr></thead><tbody>{binding.trades.slice(page*20,page*20+20).map((t,i)=>{const index=page*20+i,ledger=completed.result.partitions.find(p=>p.name===t.partition)!.trades[t.tradeIndex]!;return <tr key={`${t.partition}:${t.tradeIndex}`} className="border-t border-zinc-800"><td className="p-2"><button className="rounded border border-zinc-600 px-2 py-1" aria-pressed={selected===index} onClick={()=>setSelected(selected===index?null:index)}>Trade {index+1}</button></td><td>{t.partition==='train'?'development':t.partition}</td><td>{t.side}</td><td>{stamp(t.entry.barOpenMs)}<br/>{number(t.entry.price)}</td><td>{stamp(t.exit.barOpenMs)}<br/>{number(t.exit.price)}</td><td>{label(t.reason)}</td><td>{number(ledger.netPriceUnits)}</td></tr>;})}</tbody></table></div>
        {!binding.trades.length&&<p className="text-xs">No completed trades in this sample. Review partition decisions and unresolved positions in the snapshot; no winning result is inferred.</p>}
        {binding.trades.length>20&&<div className="flex items-center gap-2 text-xs"><Button size="sm" variant="outline" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Previous trades</Button><span>Page {page+1} of {Math.ceil(binding.trades.length/20)}</span><Button size="sm" variant="outline" disabled={(page+1)*20>=binding.trades.length} onClick={()=>setPage(p=>p+1)}>Next trades</Button></div>}
      </>}
      {selectedTrade&&selectedLedger&&<div className="space-y-2 rounded border border-zinc-700 p-3 text-xs" data-testid="chart-research-trade-detail"><p>{explanation}</p><p>Chart arrows use the observed bar open, not a fabricated intrabar timestamp. {selectedTrade.entry.barOpenMs===selectedTrade.exit.barOpenMs?'Entry and exit share one bar; no horizontal holding-duration segment is fabricated.':'Dashed red/green segments show only this selected trade’s stop and target over its observed holding bars.'}</p></div>}
      <details className="text-xs"><summary className="cursor-pointer">Source limits and reproducible snapshot</summary><ul className="list-disc space-y-1 pl-5 pt-2">{[...completed.snapshot.limitations,...completed.result.limitations].map((text,i)=><li key={i}>{text}</li>)}</ul><p className="my-2 break-all">Result SHA-256: {completed.result.fingerprints.result}</p><Button size="sm" variant="outline" onClick={download}>Save test snapshot</Button></details>
    </div>}
  </section>;
}
