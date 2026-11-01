import { MAX_STUDIES, STUDY_CATALOG, studyDefinition, studyLabel, studyId, type ChartStudy, type StudyKind } from "./chartStudies";
import type { ChartEngineAdapter } from "./types";

// A local display action in the existing assistant, not an AI score or a trade
// tool. Only this small complete grammar may mutate the current chart. Extra
// instructions (another asset, timeframe, source, negation, etc.) fail closed.
export type StudyRequest = { kind: StudyKind; action: "show" | "hide" | "remove"; period?: number } | { error: string };
const help = 'Chart not changed. Try “show RSI”, “set RSI period to 21”, “hide RSI” or “remove RSI”. Other settings and repeated instances are editable in Studies.';
const aliases = STUDY_CATALOG.flatMap(d=>[{name:d.defaults.kind,kind:d.defaults.kind},{name:d.name.toLowerCase(),kind:d.defaults.kind}])
  .concat([{name:"bollinger bands",kind:"bollinger"},{name:"adx",kind:"dmi"}]);
export function parseStudyRequest(text:string): StudyRequest | null {
  const input=text.trim().toLowerCase().replace(/[?!.]+$/g,"").replace(/^please\s+/,"");
  const found=aliases.filter(a=>new RegExp(`(?:^|\\W)${a.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?=\\W|$)`).test(input));
  if (!found.length) {
    if (/\b(vwap|volume profile)\b/.test(input)) return {error:"Chart not changed. This assistant cannot apply VWAP or volume profile yet. No calculated overlay has been added."};
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
  if (period!=null && (!Number.isInteger(period) || period<1 || period>1000 || alias.kind==="macd" || action!=="show")) return {error:help};
  return {kind:alias.kind,action,period};
}
export interface StudyAssistantContext {
  adapter: Pick<ChartEngineAdapter,"setStudies"|"getVisibleCandles"|"getStudyValues"> | null;
  studies: ChartStudy[];
  symbol:string; timeframe:string; feedLabel:string;
  save:(studies:ChartStudy[])=>void;
}
const time=(seconds:number)=>new Date(seconds*1000).toISOString();
const number=(value:number)=>Number(value.toPrecision(8)).toString();
export function executeStudyRequest(request:StudyRequest,context:StudyAssistantContext):string {
  if ("error" in request) return request.error;
  const {adapter,studies,symbol,timeframe,feedLabel,save}=context;
  const visible=adapter?.getVisibleCandles?.() ?? [];
  if (!adapter?.setStudies || !adapter.getStudyValues || !visible.length) return "Study not applied: the current chart has no ready renderer and visible candle window yet. Wait for candles, then retry.";
  const matches=studies.filter(s=>s.kind===request.kind);
  if (matches.length>1) return "Chart not changed: multiple instances of this study exist. Choose the instance in Studies so your manual settings are preserved.";
  const existing=matches[0];
  if (!existing && request.action!=="show") return `Chart not changed: ${request.kind.toUpperCase()} is not on this chart.`;
  if (!existing && studies.length>=MAX_STUDIES) return "Chart not changed: the study limit is reached. Remove a study in Studies first.";
  const definition=studyDefinition(request.kind);
  const next:ChartStudy={...(existing ?? definition.defaults)};
  if (!existing) {
    let suffix=1;
    while (studies.some(study=>studyId(study)===`assistant-${request.kind}-${suffix}`)) suffix++;
    next.id=`assistant-${request.kind}-${suffix}`;
  }
  if (request.period!=null) next.period=request.period;
  next.lineStyles=definition.channels.map((_,i)=>({...next.lineStyles?.[i],visible:request.action!=="hide"}));
  const updated=request.action==="remove" ? studies.filter(s=>s!==existing)
    : existing ? studies.map(s=>s===existing ? next : s) : [...studies,next];
  // The same synchronous renderer used by manual settings supplies the receipt.
  // Never substitute a separately calculated or model-generated study value.
  try { adapter.setStudies(updated); } catch {
    // An exception may follow a partial renderer change. Restore the prior
    // collection when possible; never claim a failed write certainly did nothing.
    try { adapter.setStudies(studies); } catch { /* report uncertainty below */ }
    return "Chart change could not be verified. No settings were saved. Check the chart and Studies before retrying.";
  }
  save(updated);
  const title=`${symbol} · ${timeframe} · ${feedLabel}`;
  if (request.action!=="show") return `${request.action==="hide" ? "Hidden" : "Removed"} ${studyLabel(next)} on ${title}. You can change this in Studies. Display only; no order was sent.`;
  const last=visible[visible.length-1]!;
  let result:ReturnType<NonNullable<ChartEngineAdapter["getStudyValues"]>>[number] | undefined;
  try { result=adapter.getStudyValues(last.time).find(row=>row.label===studyLabel(next)); } catch { /* Applied, but observation remains unavailable. */ }
  const values=definition.channels.map(name=>{
    const value=result?.values.find(v=>v.name===name)?.value;
    return `${name}: ${typeof value==="number" && Number.isFinite(value) ? number(value) : "unavailable / warming up"}`;
  }).join("; ");
  const firstValue=result?.values[0]?.value;
  const finiteFirst=typeof firstValue==="number" && Number.isFinite(firstValue);
  const observed=request.kind==="rsi" && finiteFirst
    ? firstValue>=70 ? "The displayed RSI is at or above 70, a commonly used high-momentum reference; it does not prove the price must fall. "
      : firstValue<=30 ? "The displayed RSI is at or below 30, a commonly used low-momentum reference; it does not prove the price must rise. "
      : "The displayed RSI is between the common 30 and 70 references. "
    : ["sma","ema","smma","wma","dema","tema"].includes(request.kind) && finiteFirst
      ? `The visible candle close is ${last.close>firstValue ? "above" : last.close<firstValue ? "below" : "equal to"} this average. ` : "";
  const caveat=request.kind==="rsi" ? "RSI describes recent gains relative to losses; even an extreme reading does not establish a reversal."
    : request.kind==="atr" ? "ATR describes price-range volatility, not direction."
    : request.kind==="macd" ? "MACD compares fast and slow averages; its signal and histogram describe momentum, not a forecast."
    : definition.description;
  return `Applied ${studyLabel(next)} to the current chart (${existing ? "existing settings retained unless explicitly changed" : "catalogue defaults, except any requested period"}).\n${title} (feed status at request time, not a claim that historical bars are live).\nVisible window: ${time(visible[0]!.time)} to ${time(last.time)}. Observation at bar open ${time(last.time)}: ${values}. The last visible bar may still be forming. Calculations can use loaded bars before this window for warmup.\nCalculated observation: ${observed}${caveat} This is not a buy/sell instruction or a confidence score. Edit or remove it in Studies; manual settings use the same renderer. This local receipt is kept in this open chat only. Display only; no order was sent.`;
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
