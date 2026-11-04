import type { ChartCandlesResponse } from "@workspace/api-client-react";
import type { ChartHistoryPage } from "@/lib/chartCandlesQuery";
import type { Candle } from "@/components/scanner/scannerCandleAdapter";
import { bindSmartChartBars, smartChartIntervalSeconds, type SmartChartAnalysisContext, type SmartChartBoundBars, type SmartChartAnalysisBar } from "./smartChartAnalysis";

/** Analysis gets the underlying observations and their original response
 * identity. Renderer sanitization/stream tips never become confirmed history. */
export function captureSmartChartBars(data: ChartCandlesResponse | undefined,
  expected: {symbol:string;timeframe:string}, older: readonly Candle[],
  historyEvidence: ChartHistoryPage["historyEvidence"], now: number): SmartChartBoundBars & {context:SmartChartAnalysisContext} {
  const evidence = data?.marketEvidence;
  const context:SmartChartAnalysisContext = {...expected,source:evidence?.source ?? null,sourceIdentity:evidence?.sourceIdentity ?? null};
  const unavailable=(reason:string)=>({status:"unavailable" as const,reason,bars:[],context});
  if (!data || !evidence || data.symbol !== expected.symbol || data.timeframe !== expected.timeframe
    || evidence.symbol !== expected.symbol || evidence.timeframe !== expected.timeframe
    || evidence.source !== data.feedStatus?.source || evidence.source !== data.source
    || ["invalid","empty","unavailable"].includes(data.quality)) return unavailable("Waiting for matching, usable candle-source evidence.");
  const interval=smartChartIntervalSeconds(expected.timeframe);
  if (!interval || !Number.isFinite(now)) return unavailable("This chart interval cannot be analyzed yet.");
  const current:SmartChartAnalysisBar[]=[];
  for (const [index,c] of data.candles.entries()) {
    if (c.symbol !== expected.symbol || c.timeframe !== expected.timeframe || c.source !== evidence.source
      || !["live","demo"].includes(c.sourceMode)
      || c.qualityFlags?.some(flag=>["OHLC_INVALID","TIMESTAMP_INVALID","MOCK_DATA","DUPLICATE_BUCKET"].includes(flag))) return unavailable("Candle identity or quality does not support automatic analysis.");
    if (!c.isComplete || !c.isFinal || c.isForming) {
      if (index === data.candles.length-1 && c.isComplete === false && c.isFinal === false && c.isForming === true) continue;
      return unavailable("A candle has conflicting closed-bar evidence.");
    }
    current.push({time:Date.parse(c.openTime)/1000,closeTime:Date.parse(c.closeTime)/1000,
      open:c.open,high:c.high,low:c.low,close:c.close,isComplete:c.isComplete,isFinal:c.isFinal,isForming:c.isForming});
  }
  if (current.some((bar,i)=>i>0&&bar.time<=current[i-1]!.time)) return unavailable("The current candle window is not in a unique chronological order.");
  if (!current.length || Date.parse(evidence.lastClosedCandleAt) !== current.at(-1)!.closeTime*1000) return unavailable("The confirmed candle endpoint does not match its source evidence.");
  const batches=[{evidence:context,bars:current}];
  if (older.length) {
    if (!historyEvidence || historyEvidence.scope !== "public_provider" || historyEvidence.source !== "deriv_public") return unavailable("Older candles are visible, but their original source is not verified for analysis.");
    const end=Date.parse(historyEvidence.lastClosedCandleAt)/1000;
    if (!Number.isFinite(end) || end*1000>now || older.some((c,i)=>c.time/1000+interval>end||(i>0&&c.time<=older[i-1]!.time))) return unavailable("Older history does not have a valid closed-candle boundary.");
    batches.push({evidence:historyEvidence,bars:older.map(c=>({time:c.time/1000,closeTime:c.time/1000+interval,open:c.open,high:c.high,low:c.low,close:c.close,isComplete:true,isFinal:true,isForming:false}))});
  }
  return {...bindSmartChartBars(context,batches),context};
}
