import {validatePreferences} from "./chartWorkspace";
import {prepareVolumeProfileStudy} from "./chartVolumeProfile";
import {describeVolumeProfile,readMatchingVolumeProfile} from "./chartVolumeProfileDescription";
import {formatSavedVwapAnchor,studyDisplayLabel} from "./chartStudyDisplay";
import {prepareVwapStudy} from "./chartVwapAnchor";
import { formatSourceChartTime } from "./chartClockEvidence";
import { MAX_STUDIES, STUDY_CATALOG, studyDefinition, studyLabel, studyId, formatStudyNumber, type ChartStudy, type StudyKind } from "./chartStudies";
import type { ChartEngineAdapter } from "./types";

// A local display action in the existing assistant, not an AI score or a trade
// tool. Only this small complete grammar may mutate the current chart. Extra
// instructions (another asset, timeframe, source, negation, etc.) fail closed.
export type AverageSelection = { kind: "sma" | "ema"; period: number };
export type AverageComparisonRequest = { action: "compare"; studies: [AverageSelection, AverageSelection] };
export type ReadabilityRequest = {action:"simplify"} | {action:"restore"} | {action:"explain_finding"};
export type StudyRequest = ReadabilityRequest | { kind: StudyKind; action: "show" | "hide" | "remove"; period?: number; slow?: number; signal?: number; signalMethod?: "sma"|"ema"; multiplier?:number; preserveVisibility?: boolean; reanchor?:boolean; profileRows?:number; profileValueAreaPercent?:number; refreezeProfile?:boolean } | AverageComparisonRequest | { error: string };
const help = 'Chart not changed. Try “show RSI”, “set RSI period to 21”, “hide RSI” or “remove RSI”. Other settings and repeated instances are editable in Studies.';
const aliases = STUDY_CATALOG.flatMap(d=>[{name:d.defaults.kind,kind:d.defaults.kind},{name:d.name.toLowerCase(),kind:d.defaults.kind}])
  .concat([{name:"bollinger bands",kind:"bollinger"},{name:"adx",kind:"dmi"},{name:"volume bars",kind:"trade_volume"},{name:"traded volume",kind:"trade_volume"},{name:"volume",kind:"trade_volume"}]);
export function parseStudyRequest(text:string): StudyRequest | null {
  const input=text.trim().toLowerCase().replace(/[?!.]+$/g,"").replace(/^please\s+/,"");
  if(/^(?:explain (?:this|the selected|selected) (?:pattern|finding)|what does (?:this|the selected) (?:pattern|finding) mean)$/.test(input))return {action:"explain_finding"};
  if(/^(?:explain (?:this|the selected|selected) (?:pattern|finding)|what does (?:this|the selected) (?:pattern|finding)\b)/.test(input))return {error:'Use “explain this pattern” for the selected chart finding. Extra actions or another market were not applied.'};
  if (/^(?:simplify (?:this |the )?chart|make this chart easier to understand|focus on price)$/.test(input))return {action:"simplify"};
  if (/^(?:restore (?:my |the )?(?:chosen |chart )?tools|restore this chart)$/.test(input))return {action:"restore"};
  if (/\bsimplify\b|\brestore.*\b(?:chart|tools)\b|easier to understand|focus on price/.test(input))return {error:'Chart not changed. Use “make this chart easier to understand” or “restore chosen tools” for the selected pane. This temporarily hides analysis layers, preserving settings and trade/risk overlays; compound instructions are unsupported.'};
  const macdTuple=input.match(/^(?:set|change|adjust) macd periods(?: to)? (\d+),\s*(\d+),\s*(\d+)$/);
  if(macdTuple)return {kind:"macd",action:"show",period:Number(macdTuple[1]),slow:Number(macdTuple[2]),signal:Number(macdTuple[3]),preserveVisibility:true};
  const macdPeriod=input.match(/^(?:set|change|adjust) macd (fast|slow|signal)(?: period)?(?: to)? (\d+)$/);
  if(macdPeriod)return {kind:"macd",action:"show",[macdPeriod[1]==="fast"?"period":macdPeriod[1]!]:Number(macdPeriod[2]),preserveVisibility:true};
  const macdMethod=input.match(/^(?:set|change|adjust) macd signal method(?: to)? (sma|ema)$/);
  if(macdMethod)return {kind:"macd",action:"show",signalMethod:macdMethod[1] as "sma"|"ema",preserveVisibility:true};
  const deviation=input.match(/^(?:set|change|adjust) bollinger(?: bands)? (?:deviation|standard deviations|multiplier)(?: to)? (\d+(?:\.\d+)?)$/);
  if(deviation)return {kind:"bollinger",action:"show",multiplier:Number(deviation[1]),preserveVisibility:true};
  if(/^(?:reanchor|anchor) (?:the )?vwap to (?:the )?first visible bar$/.test(input))return {kind:"vwap",action:"show",reanchor:true};
  const comparison=input.match(/^compare (?:the )?(\d+) (sma|ema) (?:and|with|vs\.?) (?:the )?(\d+) (sma|ema)(?: (?:on|for) (?:this|the current) chart)?$/);
  if(comparison) {
    const first={kind:comparison[2] as "sma"|"ema",period:Number(comparison[1])};
    const second={kind:comparison[4] as "sma"|"ema",period:Number(comparison[3])};
    if([first,second].some(s=>!Number.isInteger(s.period)||s.period<1||s.period>1000)||(first.kind===second.kind&&first.period===second.period))return {error:'Chart not changed. Compare two different SMA/EMA selections, each with a whole-number period from 1 to 1000; for example “compare the 20 EMA and 50 EMA”.'};
    return {action:"compare",studies:[first,second]};
  }
  if (/\b(?:volume profile|volume_profile)\b/.test(input)) {
    const profileInput=input.replace(/volume_profile/g,"volume profile");
    const simple=profileInput.match(/^(?:(add|show|apply|hide|remove|explain)(?: me)? )?(?:estimated )?volume profile(?: (?:to|on) (?:this|the current) chart)?$/);
    const curiosity=/^(?:what does (?:estimated )?volume profile (?:tell|show) me about this chart|what is (?:estimated )?volume profile)$/.test(profileInput);
    const rows=profileInput.match(/^(?:set|change|adjust) volume profile rows(?: to)? (\d+)$/);
    const area=profileInput.match(/^(?:set|change|adjust) volume profile value area(?: to)? (\d+)(?: percent|%)$/);
    const refreeze=/^(?:freeze|refreeze) volume profile to (?:the )?visible range$/.test(profileInput);
    if(rows && Number(rows[1])>=8 && Number(rows[1])<=128)return {kind:"volume_profile",action:"show",profileRows:Number(rows[1]),preserveVisibility:true};
    if(area && Number(area[1])>=1 && Number(area[1])<=100)return {kind:"volume_profile",action:"show",profileValueAreaPercent:Number(area[1]),preserveVisibility:true};
    if(refreeze)return {kind:"volume_profile",action:"show",refreezeProfile:true,preserveVisibility:true};
    if(simple||curiosity)return {kind:"volume_profile",action:simple?.[1]==="hide"?"hide":simple?.[1]==="remove"?"remove":"show"};
    return {error:'Chart not changed. Use “show volume profile”, “set volume profile rows to 32” (8–128), “set volume profile value area to 70 percent” (1–100), “freeze volume profile to visible range”, “hide volume profile” or “remove volume profile”. Exact observed endpoints are editable in Studies. Other assets, timeframes, session rules and compound instructions are unsupported.'};
  }
  const found=aliases.filter(a=>new RegExp(`(?:^|\\W)${a.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?=\\W|$)`).test(input));
  if (!found.length) {
    return null;
  }
  // Prefer a full catalogue name over its embedded alias (DEMA includes EMA's
  // full name). The complete grammar below still refuses multiple tools.
  const alias=found.sort((a,b)=>b.name.length-a.name.length)[0]!;
  const name=alias.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const simple=input.match(new RegExp(`^(?:(add|show|apply|hide|remove|explain)(?: me)? )?${name}(?: (\\d+))?(?: (?:to|on) (?:this|the current) chart)?$`));
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
  adapter: Pick<ChartEngineAdapter,"setStudies"|"getVisibleCandles"|"getStudyValues"|"getVolumeProfiles"|"getVwapAnchorEvidence"|"setAnalysisFocus"|"isAnalysisFocused"|"isAnalysisFocusVerified"> | null;
  studies: ChartStudy[];
  symbol:string; timeframe:string; feedLabel:string;
  utcClockQualified?:boolean;
  save:(studies:ChartStudy[])=>void;
  onAnalysisFocus?:(focused:boolean)=>void;
  explainFinding?:()=>string;
}
const observationTime=(seconds:number,qualified:boolean)=>{const date=new Date(seconds*1000);return Number.isFinite(date.getTime())?formatSourceChartTime(seconds,qualified,"UTC",{seconds:true}):"unavailable timestamp";};
/** One renderer transaction for a complete requested collection. Restoration
 * is best-effort: an exception never becomes a claim that nothing changed. */
function applyStudyCollection(context:StudyAssistantContext,updated:ChartStudy[]):string|null {
  const focused=context.adapter?.isAnalysisFocused?.()===true;
  try {
    context.adapter!.setStudies!(updated);
    if(focused){context.adapter!.setAnalysisFocus!(false);if(context.adapter!.isAnalysisFocused?.()!==false)throw Error("Restore not confirmed");context.onAnalysisFocus?.(false);}
    context.save(updated);
    return null;
  } catch {
    try {context.adapter!.setStudies!(context.studies);if(focused){context.adapter!.setAnalysisFocus!(true);context.onAnalysisFocus?.(true);}} catch { /* uncertainty is reported */ }
    context.onAnalysisFocus?.(context.adapter?.isAnalysisFocused?.()===true);
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
  try{rendered=adapter.getStudyValues!(last.time);}catch{ /* no invented fallback calculation */ }
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
  const focused=context.adapter?.isAnalysisFocused?.()===true;
  const result=executeStudyRequestCore(request,context);
  return focused && context.adapter?.isAnalysisFocused?.()===false && !("action" in request&&request.action==="restore")
    ? `Restored your chosen analysis layers before applying this request. ${result}` : result;
}
function executeStudyRequestCore(request:StudyRequest,context:StudyAssistantContext):string {
  if ("error" in request) return request.error;
  if(request.action==="explain_finding")return context.adapter&&context.explainFinding
    ?context.explainFinding():"Select a ready Smart Chart and a finding first. No other pane or pattern was substituted.";
  if(request.action==="simplify"||request.action==="restore") {
    const adapter=context.adapter;
    if(!adapter?.setAnalysisFocus||!adapter.isAnalysisFocused||!adapter.getVisibleCandles?.().length)return "Chart view not changed: select a ready chart with visible candles first. No other pane was substituted.";
    const focused=request.action==="simplify";
    try {adapter.setAnalysisFocus(focused);if(adapter.isAnalysisFocused()!==focused)throw Error("Unconfirmed presentation");context.onAnalysisFocus?.(focused);}
    catch{context.onAnalysisFocus?.(adapter.isAnalysisFocused());return "Chart view change could not be verified. Reload the chart before changing tools; visible layers are unverified. No order was sent.";}
    return focused ? `Simplified ${context.symbol} · ${context.timeframe}: studies, drawings and automatic pattern annotations are temporarily hidden. Your chosen settings and hidden/locked choices are preserved. Prices, trade/risk overlays, research results and feed warnings remain. Use “restore chosen tools” or the Restore tools button. Asking to show a tool restores the view before applying it. This temporary view resets on reload; it does not improve confidence or trade readiness. No order was sent.`
      : `Restored chosen analysis layers on ${context.symbol} · ${context.timeframe} with their current settings. Individually hidden tools stay hidden; no removed or old-source objects were resurrected. No order was sent.`;
  }
  if(context.adapter?.isAnalysisFocusVerified?.()===false)return "Chart visibility is unverified after a renderer failure. Reload the chart before changing studies.";
  if(request.action==="compare")return executeAverageComparison(request,context);
  const {adapter,studies,symbol,timeframe,feedLabel}=context;
  const time=(seconds:number)=>observationTime(seconds,context.utcClockQualified===true);
  const visible=adapter?.getVisibleCandles?.() ?? [];
  if (!adapter?.setStudies || (request.kind === "volume_profile" ? !adapter.getVolumeProfiles : !adapter.getStudyValues) || !visible.length) return "Study not applied: the current chart has no ready renderer and visible candle window yet. Wait for candles, then retry.";
  const matches=studies.filter(s=>s.kind===request.kind);
  if (matches.length>1) return "Chart not changed: multiple instances of this study exist. Choose the instance in Studies so your manual settings are preserved.";
  const existing=matches[0];
  if (!existing && request.action!=="show") return `Chart not changed: ${request.kind.toUpperCase()} is not on this chart.`;
  if (!existing && studies.length>=MAX_STUDIES) return "Chart not changed: the study limit is reached. Remove a study in Studies first.";
  const definition=studyDefinition(request.kind);
  let next:ChartStudy={...(existing ?? definition.defaults)};
  if(request.reanchor)next.vwapAnchor=undefined;
  if(request.profileRows!=null)next.profileRows=request.profileRows;
  if(request.profileValueAreaPercent!=null)next.profileValueAreaPercent=request.profileValueAreaPercent;
  if(request.refreezeProfile)next.profileRange=undefined;
  if(request.action === "show" && request.kind === "volume_profile") {
    const prepared=prepareVolumeProfileStudy(next,visible);
    if(!prepared.study)return prepared.reason;
    next=prepared.study;
  }
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
  if(request.kind==="macd") {
    if(request.slow!=null)next.slow=request.slow;
    if(request.signal!=null)next.signal=request.signal;
    if(request.signalMethod!=null)next.signalMethod=request.signalMethod;
  }
  if(request.kind==="bollinger"&&request.multiplier!=null)next.multiplier=request.multiplier;
  // Manual and assistant edits pass the same configuration validator. Validate
  // the full tuple before touching either renderer or stored preferences.
  if(!validatePreferences({studies:[next]}).studies.length)return "Chart not changed: invalid study settings. Periods must be whole numbers from 1 to 1000; MACD slow must exceed fast; Bollinger deviation must be greater than 0 and at most 100. Existing settings were preserved.";
  const preserveVisibility=existing != null && request.preserveVisibility === true;
  if (!preserveVisibility) next.lineStyles=definition.channels.map((_,i)=>({...next.lineStyles?.[i],visible:request.action!=="hide"}));
  const updated=request.action==="remove" ? studies.filter(s=>s!==existing)
    : existing ? studies.map(s=>s===existing ? next : s) : [...studies,next];
  // The same synchronous renderer used by manual settings supplies the receipt.
  // Never substitute a separately calculated or model-generated study value.
  const failed=applyStudyCollection(context,updated);if(failed)return failed;
  const title=`${symbol} · ${timeframe} · ${feedLabel}`;
  if (request.action!=="show") return `${request.action==="hide" ? "Hidden" : "Removed"} ${studyLabel(next)} on ${title}. You can change this in Studies. Display only; no order was sent.`;
  if(request.kind === "volume_profile") {
    const aggregate=readMatchingVolumeProfile(adapter,next);
    return `Applied ${studyDisplayLabel(next,adapter)} on ${title}. ${existing ? "Existing settings retained unless explicitly changed" : "Editable defaults: 32 rows and a 70% value-area target unless explicitly requested otherwise"}; ${preserveVisibility ? "visibility retained" : "profile enabled for display"}.\n${describeVolumeProfile(aggregate,next)}\nThe range is frozen to exact observed bars; panning does not move it. Default selection excludes only a forming tail and never skips an unqualified closed bar. Change rows, value area or exact endpoints in Studies; say “freeze volume profile to visible range” to deliberately replace the range. This is a local display tool, not a buy/sell instruction or confidence score. No order was sent.`;
  }
  const last=visible[visible.length-1]!;
  let result:ReturnType<NonNullable<ChartEngineAdapter["getStudyValues"]>>[number] | undefined;
  try { result=adapter.getStudyValues!(last.time).find(row=>row.label===studyLabel(next)); } catch { /* Applied, but observation remains unavailable. */ }
  const values=definition.channels.map(name=>{
    const channel=result?.values.find(v=>v.name===name || v.name===`${name} (hidden)`);
    const value=channel?.value;
    return `${channel?.name ?? name}: ${typeof value==="number" && Number.isFinite(value) ? formatStudyNumber(value,name) : (result?.reason ?? (request.kind==="tick_volume" ? "unavailable: no qualified per-bar tick count" : "unavailable / warming up"))}`;
  }).join("; ");
  const channelValue=(name:string):number|null=>{
    const matches=result?.values.filter(value=>value.name===name||value.name===`${name} (hidden)`)??[];
    const value=matches.length===1?matches[0]!.value:null;
    return typeof value==="number"&&Number.isFinite(value)?value:null;
  };
  const firstValue=channelValue(definition.channels[0]!);
  let observed=request.kind==="rsi" && firstValue!=null
    ? firstValue>=70 ? "The calculated RSI is at or above 70, a commonly used high-momentum reference; it does not prove the price must fall. "
      : firstValue<=30 ? "The calculated RSI is at or below 30, a commonly used low-momentum reference; it does not prove the price must rise. "
      : "The calculated RSI is between the common 30 and 70 references. "
    : ["sma","ema","smma","wma","dema","tema"].includes(request.kind) && firstValue!=null && Number.isFinite(last.close)
      ? `The underlying source candle close is ${last.close>firstValue ? "above" : last.close<firstValue ? "below" : "equal to"} this average. ` : "";
  if(request.kind==="macd") {
    const macd=channelValue("MACD"),signal=channelValue("Signal");
    observed=macd!=null&&signal!=null
      ?`MACD is ${macd>signal?"above":macd<signal?"below":"equal to"} its signal. MACD is ${macd>0?"above":macd<0?"below":"equal to"} zero. This compares one observed bar, not a crossover, divergence or a forecast. `
      :"MACD/signal comparison is unavailable until both named channels have finite values. No missing value is replaced with zero. ";
  }
  if(request.kind==="bollinger") {
    const upper=channelValue("Upper"),basis=channelValue("Basis"),lower=channelValue("Lower");
    observed=upper!=null&&basis!=null&&lower!=null&&upper>=basis&&basis>=lower&&Number.isFinite(last.close)&&Number.isFinite(upper-lower)
      ?`The underlying source candle close is ${last.close>upper?"above the upper band":last.close<lower?"below the lower band":last.close===upper&&last.close===lower?"equal to both coincident bands":last.close===upper?"on the upper band":last.close===lower?"on the lower band":"inside the bands"}. Band width: ${formatStudyNumber(upper-lower,"Price")} source price units. This single observation does not establish a breakout or reversal, a volatility trend or a future price range. `
      :"Band comparison is unavailable: finite, correctly ordered upper/basis/lower values and the source close are required. No range was invented. ";
  }
  const anchorNote=next.kind === "vwap" && next.vwapAnchor ? `Frozen observed-bar anchor: ${formatSavedVwapAnchor(next.vwapAnchor,adapter)}. Uses only loaded observations from that exact bar, with the captured source series. Panning and loading older history do not move it. Missing volume holds the cumulative suffix; zero quantities are not qualified by the current provider. This is not a complete-session claim. Say “reanchor VWAP to first visible bar” or select an observed bar in Studies to change it. ` : "";
  const caveat=request.kind==="rsi" ? "RSI describes recent gains relative to losses; even an extreme reading does not establish a reversal."
    : request.kind==="atr" ? "ATR describes price-range volatility, not direction."
    : request.kind==="macd" ? "MACD compares fast and slow averages; its signal and histogram describe momentum, not a forecast."
    : definition.description;
  return `Applied ${studyDisplayLabel(next,adapter)} to the current chart (${existing ? "existing calculation settings retained unless explicitly changed" : "catalogue defaults, except explicitly requested settings"}; ${preserveVisibility ? "channel visibility retained; hidden channels are labelled" : "all channels shown"}).\n${title} (feed status at request time, not a claim that historical bars are live).\nVisible window: ${time(visible[0]!.time)} to ${time(last.time)}. Observation at bar open ${time(last.time)}: ${values}. The last visible bar may still be forming. Studies use underlying source prices, not averaged display candles. Calculations can use loaded bars before this window for warmup.\nCalculated observation: ${observed}${anchorNote}${caveat} This is not a buy/sell instruction or a confidence score. Edit or remove it in Studies; manual settings use the same renderer. This local receipt is kept in this open chat only. Display only; no order was sent.`;
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
  return current ? current(request) : "Select a ready Smart Chart with “Use chart with assistant” before applying a study. No other pane was substituted. No chart was changed.";
}
