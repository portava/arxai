import {prepareVwapStudy} from "./chartVwapAnchor";
import { formatSourceChartTime } from "./chartClockEvidence";
import { MAX_STUDIES, STUDY_CATALOG, studyDefinition, studyLabel, studyId, formatStudyNumber, type ChartStudy, type StudyKind } from "./chartStudies";
import type { ChartEngineAdapter } from "./types";

// A local display action in the existing assistant, not an AI score or a trade
// tool. Only this small complete grammar may mutate the current chart. Extra
// instructions (another asset, timeframe, source, negation, etc.) fail closed.
export type AverageSelection = { kind: "sma" | "ema"; period: number };
export type AverageComparisonRequest = { action: "compare"; studies: [AverageSelection, AverageSelection] };
export type StudyRequest = { kind: StudyKind; action: "show" | "hide" | "remove"; period?: number; preserveVisibility?: boolean; reanchor?:boolean } | AverageComparisonRequest | { error: string };
const help = 'Chart not changed. Try “show RSI”, “set RSI period to 21”, “hide RSI” or “remove RSI”. Other settings and repeated instances are editable in Studies.';
const aliases = STUDY_CATALOG.flatMap(d=>[{name:d.defaults.kind,kind:d.defaults.kind},{name:d.name.toLowerCase(),kind:d.defaults.kind}])
  .concat([{name:"bollinger bands",kind:"bollinger"},{name:"adx",kind:"dmi"},{name:"volume bars",kind:"trade_volume"},{name:"traded volume",kind:"trade_volume"},{name:"volume",kind:"trade_volume"}]);
export function parseStudyRequest(text:string): StudyRequest | null {
  const input=text.trim().toLowerCase().replace(/[?!.]+$/g,"").replace(/^please\s+/,"");
  if(/^(?:reanchor|anchor) (?:the )?vwap to (?:the )?first visible bar$/.test(input))return {kind:"vwap",action:"show",reanchor:true};
  const comparison=input.match(/^compare (?:the )?(\d+) (sma|ema) (?:and|with|vs\.?) (?:the )?(\d+) (sma|ema)(?: (?:on|for) (?:this|the current) chart)?$/);
  if(comparison) {
    const first={kind:comparison[2] as "sma"|"ema",period:Number(comparison[1])};
    const second={kind:comparison[4] as "sma"|"ema",period:Number(comparison[3])};
    if([first,second].some(s=>!Number.isInteger(s.period)||s.period<1||s.period>1000)||(first.kind===second.kind&&first.period===second.period))return {error:'Chart not changed. Compare two different SMA/EMA selections, each with a whole-number period from 1 to 1000; for example “compare the 20 EMA and 50 EMA”.'};
    return {action:"compare",studies:[first,second]};
  }
  if (/\bvolume profile\b/.test(input)) return {error:"Chart not changed. Volume profile has no calculated overlay yet. Anchored VWAP and trade-volume bars are separate tools; no profile has been added."};
  const found=aliases.filter(a=>new RegExp(`(?:^|\\W)${a.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?=\\W|$)`).test(input));
  if (!found.length) {
    return null;
  }
  // Prefer a full catalogue name over its embedded alias (DEMA includes EMA's
  // full name). The complete grammar below still refuses multiple tools.
  const alias=found.sort((a,b)=>b.name.length-a.name.length)[0]!;
  const name=alias.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const simple=input.match(new RegExp(`^(?:(add|show|apply|hide|remove|explain) )?${name}(?: (\\d+))?(?: (?:to|on) (?:this|the current) chart)?$`));
  const edit=input.match(new RegExp(`^(?:set|change|adjust) ${name} period(?: to)? (\\d+)$`));
  const curiosity=new RegExp(`^(?:what does ${name} (?:tell|show) me about this chart|what is ${name}|explain ${name} on this chart)$`).test(input);
  if (!simple && !edit && !curiosity) return {error:help};
  const period=edit ? Number(edit[1]) : simple?.[2] ? Number(simple[2]) : undefined;
  const action=simple?.[1]==="hide" ? "hide" : simple?.[1]==="remove" ? "remove" : "show";
  // MACD fast/slow relationship and multi-input tools remain in the existing
  // settings editor. Do not guess what a bare MACD number meant.
  if (period!=null && (!Number.isInteger(period) || period<1 || period>1000 || (["macd","tick_volume","trade_volume","vwap"].includes(alias.kind)) || action!=="show")) return {error:help};
  return {kind:alias.kind,action,period,...(edit ? {preserveVisibility:true} : {})};
}
export interface StudyAssistantContext {
  adapter: Pick<ChartEngineAdapter,"setStudies"|"getVisibleCandles"|"getStudyValues"> | null;
  studies: ChartStudy[];
  symbol:string; timeframe:string; feedLabel:string;
  utcClockQualified?:boolean;
  save:(studies:ChartStudy[])=>void;
}
const observationTime=(seconds:number,qualified:boolean)=>{const date=new Date(seconds*1000);return Number.isFinite(date.getTime())?formatSourceChartTime(seconds,qualified,"UTC",{seconds:true}):"unavailable timestamp";};
/** One renderer transaction for a complete requested collection. Restoration
 * is best-effort: an exception never becomes a claim that nothing changed. */
function applyStudyCollection(context:StudyAssistantContext,updated:ChartStudy[]):string|null {
  try {
    context.adapter!.setStudies!(updated);
    context.save(updated);
    return null;
  } catch {
    try {context.adapter!.setStudies!(context.studies);} catch { /* uncertainty is reported */ }
    return "Chart change could not be verified. Settings may be incomplete. Check the chart and Studies before retrying.";
  }
}
function executeAverageComparison(request:AverageComparisonRequest,context:StudyAssistantContext):string {
  const {adapter,studies,symbol,timeframe,feedLabel}=context;
  const time=(seconds:number)=>observationTime(seconds,context.utcClockQualified===true);
  const visible=adapter?.getVisibleCandles?.()??[];
  if(!adapter?.setStudies||!adapter.getStudyValues||!visible.length)return "Comparison not applied: the current chart has no ready renderer and visible candle window yet. Wait for candles, then retry.";
  const matches=request.studies.map(selection=>studies.filter(s=>s.kind===selection.kind&&s.period===selection.period));
  if(matches.some(rows=>rows.length>1))return "Chart not changed: multiple matching manual averages exist. Select the intended instances in Studies; no existing settings were guessed or overwritten.";
  if(studies.length+matches.filter(rows=>!rows.length).length>MAX_STUDIES)return "Chart not changed: the study limit would be exceeded by this comparison. Remove a study in Studies first; neither average was partially added.";
  const updated=[...studies],ids=new Set(studies.map(studyId));
  const usedColors=new Set(matches.flat().map(s=>(s.lineStyles?.[0]?.color??s.color).toLowerCase()));
  const pair=request.studies.map((selection,index)=>{
    const existing=matches[index]![0];
    const next:ChartStudy={...(existing??studyDefinition(selection.kind).defaults),period:selection.period};
    if(!existing){
      let suffix=1;while(ids.has(`assistant-${selection.kind}-${suffix}`))suffix++;
      next.id=`assistant-${selection.kind}-${suffix}`;ids.add(next.id);
      next.color=["#38bdf8","#fbbf24","#4ade80","#f472b6"].find(color=>!usedColors.has(color))??next.color;
      usedColors.add(next.color.toLowerCase());
    }
    next.lineStyles=studyDefinition(next.kind).channels.map((_,i)=>({...next.lineStyles?.[i],visible:true}));
    if(existing)updated[studies.indexOf(existing)]=next;else updated.push(next);
    return next;
  });
  const failed=applyStudyCollection(context,updated);if(failed)return failed;
  const last=visible.at(-1)!;
  let rendered:ReturnType<NonNullable<ChartEngineAdapter["getStudyValues"]>>=[];
  try{rendered=adapter.getStudyValues(last.time);}catch{ /* no invented fallback calculation */ }
  const values=pair.map(study=>{
    const value=rendered.find(row=>row.label===studyLabel(study))?.values.find(v=>v.name===study.kind.toUpperCase())?.value;
    return typeof value==="number"&&Number.isFinite(value)?value:null;
  });
  const observed=pair.map((study,index)=>`${studyLabel(study)}: ${values[index]===null?"unavailable / warming up":formatStudyNumber(values[index]!,study.kind.toUpperCase())}`).join("; ");
  const [a,b]=values;
  const relation=a!=null&&b!=null
    ?`${studyLabel(pair[0]!)} is ${a>b?"above":a<b?"below":"equal to"} ${studyLabel(pair[1]!)}${a===b?"":Number.isFinite(a-b)?` by ${formatStudyNumber(Math.abs(a-b),"Price")} source price units`:"; the difference is outside the supported numerical range"}. This is a current-bar comparison, not a crossover or a forecast.`
    :"A numerical comparison is unavailable until both rendered averages have finite values. No missing value was replaced with zero.";
  const inputs=(pair[0]!.source??"close")===(pair[1]!.source??"close")?"Both use the same applied-price input.":"The existing applied-price inputs differ; this comparison preserves and names them rather than silently changing your settings.";
  return `Applied the average comparison on ${symbol} · ${timeframe} · ${feedLabel}. Existing calculation/style settings retained; new averages use catalogue defaults apart from the requested periods and distinct colors. The requested averages are both enabled for display; other tools are unchanged.\nVisible window: ${time(visible[0]!.time)} to ${time(last.time)}. Actual renderer observation at bar open ${time(last.time)}: ${observed}. Times identify source bar coordinates; ISO formatting does not independently prove UTC. ${inputs}\nCalculated observation: ${relation} The last visible bar may still be forming. Studies use underlying source prices, not averaged display candles; loaded bars before this window may supply warmup. Feed status describes this request, not historical liveness. This is not a buy/sell instruction or a confidence score. Edit, hide or remove either average in Studies; manual settings use the same renderer. No order was sent.`;
}
export function executeStudyRequest(request:StudyRequest,context:StudyAssistantContext):string {
  if ("error" in request) return request.error;
  if(request.action==="compare")return executeAverageComparison(request,context);
  const {adapter,studies,symbol,timeframe,feedLabel}=context;
  const time=(seconds:number)=>observationTime(seconds,context.utcClockQualified===true);
  const visible=adapter?.getVisibleCandles?.() ?? [];
  if (!adapter?.setStudies || !adapter.getStudyValues || !visible.length) return "Study not applied: the current chart has no ready renderer and visible candle window yet. Wait for candles, then retry.";
  const matches=studies.filter(s=>s.kind===request.kind);
  if (matches.length>1) return "Chart not changed: multiple instances of this study exist. Choose the instance in Studies so your manual settings are preserved.";
  const existing=matches[0];
  if (!existing && request.action!=="show") return `Chart not changed: ${request.kind.toUpperCase()} is not on this chart.`;
  if (!existing && studies.length>=MAX_STUDIES) return "Chart not changed: the study limit is reached. Remove a study in Studies first.";
  const definition=studyDefinition(request.kind);
  let next:ChartStudy={...(existing ?? definition.defaults)};
  if(request.reanchor)next.vwapAnchor=undefined;
  if(request.action === "show" && request.kind === "vwap") {
    const prepared=prepareVwapStudy(next,visible);
    if(!prepared.study)return prepared.reason;
    next=prepared.study;
  }
  if (!existing) {
    let suffix=1;
    while (studies.some(study=>studyId(study)===`assistant-${request.kind}-${suffix}`)) suffix++;
    next.id=`assistant-${request.kind}-${suffix}`;
  }
  if (request.period!=null) next.period=request.period;
  const preserveVisibility=existing != null && request.preserveVisibility === true;
  if (!preserveVisibility) next.lineStyles=definition.channels.map((_,i)=>({...next.lineStyles?.[i],visible:request.action!=="hide"}));
  const updated=request.action==="remove" ? studies.filter(s=>s!==existing)
    : existing ? studies.map(s=>s===existing ? next : s) : [...studies,next];
  // The same synchronous renderer used by manual settings supplies the receipt.
  // Never substitute a separately calculated or model-generated study value.
  const failed=applyStudyCollection(context,updated);if(failed)return failed;
  const title=`${symbol} · ${timeframe} · ${feedLabel}`;
  if (request.action!=="show") return `${request.action==="hide" ? "Hidden" : "Removed"} ${studyLabel(next)} on ${title}. You can change this in Studies. Display only; no order was sent.`;
  const last=visible[visible.length-1]!;
  let result:ReturnType<NonNullable<ChartEngineAdapter["getStudyValues"]>>[number] | undefined;
  try { result=adapter.getStudyValues(last.time).find(row=>row.label===studyLabel(next)); } catch { /* Applied, but observation remains unavailable. */ }
  const values=definition.channels.map(name=>{
    const channel=result?.values.find(v=>v.name===name || v.name===`${name} (hidden)`);
    const value=channel?.value;
    return `${channel?.name ?? name}: ${typeof value==="number" && Number.isFinite(value) ? formatStudyNumber(value,name) : (result?.reason ?? (request.kind==="tick_volume" ? "unavailable: no qualified per-bar tick count" : "unavailable / warming up"))}`;
  }).join("; ");
  const firstValue=result?.values[0]?.value;
  const finiteFirst=typeof firstValue==="number" && Number.isFinite(firstValue);
  const observed=request.kind==="rsi" && finiteFirst
    ? firstValue>=70 ? "The calculated RSI is at or above 70, a commonly used high-momentum reference; it does not prove the price must fall. "
      : firstValue<=30 ? "The calculated RSI is at or below 30, a commonly used low-momentum reference; it does not prove the price must rise. "
      : "The calculated RSI is between the common 30 and 70 references. "
    : ["sma","ema","smma","wma","dema","tema"].includes(request.kind) && finiteFirst
      ? `The underlying source candle close is ${last.close>firstValue ? "above" : last.close<firstValue ? "below" : "equal to"} this average. ` : "";
  const anchorNote=next.kind === "vwap" && next.vwapAnchor ? `Frozen observed-bar anchor: ${observationTime(next.vwapAnchor.time,false)}. Uses only loaded observations from that exact bar, with the captured source series. Panning and loading older history do not move it. Missing volume holds the cumulative suffix; zero quantities are not qualified by the current provider. This is not a complete-session claim. Say “reanchor VWAP to first visible bar” or select an observed bar in Studies to change it. ` : "";
  const caveat=request.kind==="rsi" ? "RSI describes recent gains relative to losses; even an extreme reading does not establish a reversal."
    : request.kind==="atr" ? "ATR describes price-range volatility, not direction."
    : request.kind==="macd" ? "MACD compares fast and slow averages; its signal and histogram describe momentum, not a forecast."
    : definition.description;
  return `Applied ${studyLabel(next)} to the current chart (${existing ? "existing calculation settings retained unless explicitly changed" : "catalogue defaults, except any requested period"}; ${preserveVisibility ? "channel visibility retained; hidden channels are labelled" : "all channels shown"}).\n${title} (feed status at request time, not a claim that historical bars are live).\nVisible window: ${time(visible[0]!.time)} to ${time(last.time)}. Observation at bar open ${time(last.time)}: ${values}. The last visible bar may still be forming. Studies use underlying source prices, not averaged display candles. Calculations can use loaded bars before this window for warmup.\nCalculated observation: ${observed}${anchorNote}${caveat} This is not a buy/sell instruction or a confidence score. Edit or remove it in Studies; manual settings use the same renderer. This local receipt is kept in this open chat only. Display only; no order was sent.`;
}

type Handler=(request:StudyRequest)=>string;
let current:Handler | null=null;
export function registerChartStudyAssistant(handler:Handler):()=>void {
  current=handler;
  return ()=>{if(current===handler)current=null;};
}
/** No requests leave the browser for these bounded display-only actions. */
export function requestChartStudy(text:string):string | null {
  const request=parseStudyRequest(text);
  if (!request) return null;
  if ("error" in request) return request.error;
  return current ? current(request) : "Open the current Smart Chart before applying a study. No chart was changed.";
}
