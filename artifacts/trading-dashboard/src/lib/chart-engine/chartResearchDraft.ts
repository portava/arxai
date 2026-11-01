import { RESEARCH_V2_STRATEGY_VERSION, validateResearchV2Config, validateResearchV2Strategy, type ResearchV2Config } from "@workspace/domain/backtest/research-core";
import { chartIntervalSeconds, isChartInterval, parseChartInterval, type ChartInterval } from "./chartIntervals";

/** Editable configuration only. These helpers cannot fetch bars, run research,
 * change chart context, call a model, persist an experiment or send an order. */
export interface ChartResearchContext {
  symbol: string;
  timeframe: string;
  /** Caller-observed exclusive end of the latest eligible closed candle.
   * Never pass a wall-clock time or the end of a currently forming candle. */
  closedThroughMs: number;
}
export interface ChartResearchSettings {
  requestedWindow: { fromInclusiveMs: number; toExclusiveMs: number };
  strategy: ResearchV2Config["strategy"];
  costs: ResearchV2Config["costs"];
  maxEntryGapMs: number;
  partitions: { trainFraction: number; validationFraction: number };
}
export interface ChartResearchDraft extends ChartResearchSettings {
  schemaVersion: "arx-chart-research-draft-v1";
  symbol: string;
  timeframe: ChartInterval;
  intervalMs: number;
}
export type ChartResearchDraftResult = { kind: "draft"; draft: ChartResearchDraft; disclosures: string[] }
  | { kind: "unsupported"; message: string };
const refused=(message:string):ChartResearchDraftResult=>({kind:"unsupported",message:`Historical test not started. ${message}`});
const isStamp=(value:unknown):value is number=>typeof value==="number" && Number.isSafeInteger(value) && value>0 && value<=8_640_000_000_000_000;
const nonnegative=(value:unknown):value is number=>typeof value==="number" && Number.isFinite(value) && value>=0;
const onlyKeys=(value:unknown,allowed:readonly string[]):boolean=>value!=null && typeof value==="object" && !Array.isArray(value) && Object.keys(value).every(key=>allowed.includes(key));
const pct=(fraction:number)=>`${Number((fraction*100).toPrecision(10))}%`;

/** Fresh editable scenario values shared by the manual panel and text parser.
 * These are research assumptions, never account sizing or broker defaults. */
export function defaultChartResearchSettings(requestedWindow:ChartResearchSettings["requestedWindow"]):ChartResearchSettings {
  return {requestedWindow:{...requestedWindow},
    strategy:{version:RESEARCH_V2_STRATEGY_VERSION,fastPeriod:20,slowPeriod:50,atrPeriod:14,stopAtrMultiple:2,targetR:2,maxHoldingBars:100,direction:"long_only"},
    costs:{fullSpreadPriceUnits:0,adverseSlippagePerFillPriceUnits:0,feePerFillPriceUnits:0},
    maxEntryGapMs:0,partitions:{trainFraction:.6,validationFraction:.2}};
}

/** The manual form and bounded text request both construct this same draft. */
export function createChartResearchDraft(context:ChartResearchContext,settings:ChartResearchSettings):ChartResearchDraftResult {
  if (!onlyKeys(settings,["requestedWindow","strategy","costs","maxEntryGapMs","partitions","schemaVersion","symbol","timeframe","intervalMs"])
    || !onlyKeys(settings.strategy,["version","fastPeriod","slowPeriod","atrPeriod","stopAtrMultiple","targetR","maxHoldingBars","direction"])
    || !onlyKeys(settings.costs,["fullSpreadPriceUnits","adverseSlippagePerFillPriceUnits","feePerFillPriceUnits"])
    || !onlyKeys(settings.requestedWindow,["fromInclusiveMs","toExclusiveMs"])
    || !onlyKeys(settings.partitions,["trainFraction","validationFraction"]))
    return refused("Unsupported settings cannot be ignored. This schema has no capital, currency, sizing, extra entry rules or broker-order fields.");
  const timeframe=parseChartInterval(context.timeframe);
  if (!isChartInterval(timeframe)) return refused("Select a supported fixed-duration chart interval first. Weekly/monthly or unknown intervals are not guessed.");
  const intervalMs=chartIntervalSeconds(timeframe)!*1000;
  const carried=settings as ChartResearchSettings & Partial<ChartResearchDraft>;
  if (carried.schemaVersion!=null && carried.schemaVersion!=="arx-chart-research-draft-v1"
    || carried.symbol!=null && carried.symbol!==context.symbol
    || carried.timeframe!=null && carried.timeframe!==timeframe
    || carried.intervalMs!=null && carried.intervalMs!==intervalMs)
    return refused("The edited draft no longer matches the selected asset/interval or supported schema. It cannot silently change chart context.");
  if (typeof context.symbol!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,63}$/.test(context.symbol)) return refused("A valid selected chart asset is required; this request cannot select another asset.");
  if (!isStamp(context.closedThroughMs)) return refused("A confirmed closed-history cutoff is required; a forming candle or wall-clock estimate cannot define the endpoint.");
  const window=settings?.requestedWindow;
  if (!window || !isStamp(window.fromInclusiveMs) || !isStamp(window.toExclusiveMs) || window.fromInclusiveMs>=window.toExclusiveMs || window.toExclusiveMs>context.closedThroughMs)
    return refused("Choose an explicit historical start and exclusive closed-candle end. Future or empty windows are unsupported.");
  if ((context.closedThroughMs-window.fromInclusiveMs)%intervalMs!==0 || (context.closedThroughMs-window.toExclusiveMs)%intervalMs!==0)
    return refused("The requested start and end must align to the selected closed-candle interval; no shorter range was substituted.");
  let strategy:ResearchV2Config["strategy"];
  try { strategy=validateResearchV2Strategy(settings.strategy); } catch { return refused("The EMA/ATR rules are outside the research engine's supported bounds. Use valid periods with fast EMA shorter than slow EMA, positive ATR/target multiples and a supported direction."); }
  const costs=settings.costs;
  if (!costs || ![costs.fullSpreadPriceUnits,costs.adverseSlippagePerFillPriceUnits,costs.feePerFillPriceUnits].every(nonnegative))
    return refused("Spread, adverse slippage and fee equivalents must be explicit non-negative price-unit scenarios, not money or broker-fee assumptions.");
  if (!Number.isSafeInteger(settings.maxEntryGapMs) || settings.maxEntryGapMs<0 || settings.maxEntryGapMs>366*86400000)
    return refused("Use an explicit bounded maximum entry-gap duration.");
  const partitions=settings.partitions;
  if (!partitions || !Number.isFinite(partitions.trainFraction) || !Number.isFinite(partitions.validationFraction)
    || partitions.trainFraction<=0 || partitions.validationFraction<=0 || partitions.trainFraction+partitions.validationFraction>=1)
    return refused("Development, validation and holdout must each have a positive share of the historical window.");
  if (!Number.isFinite(costs.fullSpreadPriceUnits+2*costs.adverseSlippagePerFillPriceUnits+2*costs.feePerFillPriceUnits))
    return refused("The combined cost scenario is too large for finite price-unit arithmetic.");
  const draft:ChartResearchDraft={schemaVersion:"arx-chart-research-draft-v1",symbol:context.symbol,timeframe,intervalMs,
    requestedWindow:{...window},strategy:{...strategy},costs:{...costs},maxEntryGapMs:settings.maxEntryGapMs,partitions:{...partitions}};
  return {kind:"draft",draft,disclosures:describeChartResearchDraft(draft)};
}

/** Coverage is NOT proven by barCount. Call only after chartResearchEvidence's
 * bound-source/exact-window gate; this function makes engine split indices and
 * uses the same authoritative config validator as manual and worker runs. */
export function finalizeChartResearchConfig(draft:ChartResearchDraft,verifiedBarCount:number):
  {ok:true;config:ResearchV2Config} | {ok:false;message:string} {
  const checked=createChartResearchDraft({symbol:draft.symbol,timeframe:draft.timeframe,closedThroughMs:draft.requestedWindow.toExclusiveMs},draft);
  if (checked.kind!=="draft") return {ok:false,message:checked.message};
  if (!Number.isSafeInteger(verifiedBarCount) || verifiedBarCount<Math.max(3,draft.strategy.slowPeriod+1,draft.strategy.atrPeriod))
    return {ok:false,message:"Insufficient closed bars for the configured EMA crossover and ATR warmup. No signals or result have been invented."};
  const trainEndExclusive=Math.floor(verifiedBarCount*draft.partitions.trainFraction);
  const validationEndExclusive=Math.floor(verifiedBarCount*(draft.partitions.trainFraction+draft.partitions.validationFraction));
  try {
    return {ok:true,config:validateResearchV2Config({strategy:draft.strategy,costs:draft.costs,maxEntryGapMs:draft.maxEntryGapMs,
      splits:{trainEndExclusive,validationEndExclusive}},verifiedBarCount)};
  } catch { return {ok:false,message:"The edited configuration or chronological partitions are unsupported by the research engine. Review the rules, cost scenarios and data size; no test ran."}; }
}

const counts:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
function subtractCalendar(end:number,count:number,unit:string):number {
  if (unit==="day" || unit==="week") return end-count*(unit==="day"?1:7)*86400000;
  const date=new Date(end), day=date.getUTCDate();
  date.setUTCDate(1);
  if (unit==="year") date.setUTCFullYear(date.getUTCFullYear()-count);
  else date.setUTCMonth(date.getUTCMonth()-count);
  const last=new Date(date.getTime());last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);
  date.setUTCDate(Math.min(day,last.getUTCDate()));
  return date.getTime();
}
/** Full-phrase, deterministic grammar. Unrecognised modifiers never partly
 * apply; ordinary non-research conversation returns null for the caller. */
export function parseChartResearchRequest(text:string,context:ChartResearchContext):ChartResearchDraftResult | null {
  const input=text.trim().toLowerCase().replace(/[\u2010-\u2015]/g,"-").replace(/\s+/g," ").replace(/^please /,"").replace(/[.!?]+$/,"");
  if (!/^(?:test|backtest)\b/.test(input)) return null;
  if (input.length>1000) return refused("Use one bounded historical-rule request at a time.");
  if (/[$€£%]|\b(capital|currency|dollars?|leverage|lots?|position sizing)\b/.test(input))
    return refused("This version models one synthetic unit in price units. Capital, account-currency returns, leverage and position sizing are unsupported; they cannot be silently ignored.");
  const match=/^(?:test|backtest) (buying|selling) when (?:the )?(\d{1,4})\s*ema crosses (above|below) (?:the )?(\d{1,4})\s*ema,? with (?:an? )?atr(?:-| )based stop,? over (?:the )?last (\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten) (day|week|month|year)s?$/.exec(input);
  if (!match) return refused("Supported example: “Test buying when the 20 EMA crosses above the 50 EMA, with an ATR-based stop, over the last two years.” The selected asset/timeframe is reused. Extra assets, intervals or rules require an explicit supported edit; nothing was partially applied.");
  const [,side,fast,,slow,countText,unit]=match;
  if (side==="buying" && match[3]!=="above" || side==="selling" && match[3]!=="below")
    return refused("This strategy version supports buying an upward EMA crossover or selling a downward crossover; the requested direction was not reinterpreted.");
  const timeframe=parseChartInterval(context.timeframe), interval=chartIntervalSeconds(timeframe);
  if (!interval || !isStamp(context.closedThroughMs)) return refused("A supported selected interval and explicit latest closed-candle endpoint are required.");
  const count=counts[countText!] ?? Number(countText);
  if (!Number.isSafeInteger(count) || count<1) return refused("Use a positive historical duration.");
  const nominalFrom=subtractCalendar(context.closedThroughMs,count,unit!);
  if (!isStamp(nominalFrom)) return refused("The requested calendar window is outside supported historical timestamps.");
  const intervalMs=interval*1000;
  const from=context.closedThroughMs-Math.floor((context.closedThroughMs-nominalFrom)/intervalMs)*intervalMs;
  const defaults=defaultChartResearchSettings({fromInclusiveMs:from,toExclusiveMs:context.closedThroughMs});
  const result=createChartResearchDraft(context,{...defaults,
    strategy:{...defaults.strategy,fastPeriod:Number(fast),slowPeriod:Number(slow),direction:side==="buying"?"long_only":"short_only"},
  });
  if (result.kind==="draft") result.disclosures.unshift(`Requested last ${count} ${unit}${count===1?"":"s"} uses UTC calendar arithmetic through the supplied closed-history endpoint.${from!==nominalFrom ? ` Start aligned forward from ${new Date(nominalFrom).toISOString()} to ${new Date(from).toISOString()}; this adjustment is explicit.` : " No date range was shortened."}`);
  return result;
}

export function describeChartResearchDraft(draft:ChartResearchDraft):string[] {
  const {strategy:s,costs:c}=draft;
  return [
    "Editable historical draft only. No test has run and no order can be sent by this feature.",
    `${draft.symbol} · ${draft.timeframe}; requested UTC window ${new Date(draft.requestedWindow.fromInclusiveMs).toISOString()} inclusive to ${new Date(draft.requestedWindow.toExclusiveMs).toISOString()} exclusive. Exact source-bound closed-history endpoints are required; internal gaps are disclosed and never interpolated; never substitute the latest 200 bars.`,
    `${s.direction}: EMA ${s.fastPeriod}/${s.slowPeriod} closed-candle crossover; enter at the next observed open. ATR ${s.atrPeriod} × ${s.stopAtrMultiple} stop distance frozen at the signal and anchored to the modeled entry fill; target ${s.targetR}R; maximum hold ${s.maxHoldingBars} bars schedules an exit at the next observed open.`,
    "EMA uses underlying source closes and an SMA seed; ATR uses Wilder smoothing with the first bar’s high-low range. Opposite crosses do not exit an open position. Stops, targets and the holding rule are the exits; no averaged display prices replace source data.",
    `Explicit constant cost scenario in source price units: full spread ${c.fullSpreadPriceUnits}, adverse slippage per fill ${c.adverseSlippagePerFillPriceUnits}, fee equivalent per fill ${c.feePerFillPriceUnits}. These are assumptions, not historical broker costs.${Object.values(c).every(value=>value===0)?" This zero-cost exploratory baseline excludes those costs until edited; it is not a claim of cost-free trading.":""}`,
    `Maximum delay from signal close to entry open: ${draft.maxEntryGapMs} ms. One synthetic unit; no capital, contract multiplier, account-currency returns or sizing model.`,
    `Chronological development ${pct(draft.partitions.trainFraction)}, validation ${pct(draft.partitions.validationFraction)}, holdout ${pct(1-draft.partitions.trainFraction-draft.partitions.validationFraction)}. Fixed parameters; no optimization, untouched-holdout or profitability claim. All rules and scenario values remain editable before running.`,
  ];
}
