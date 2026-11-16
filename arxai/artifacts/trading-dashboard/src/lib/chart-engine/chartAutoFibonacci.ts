import { findSwings } from "@workspace/domain/chart-patterns";
import { type SmartChartAnalysisInput } from "./smartChartAnalysis";
import { selectAppliedSmartChartWindow } from "./chartAppliedWindow";
import type { ChartEngineCandle } from "./types";
import type { ChartDrawing, FibonacciOrigin } from "./chartWorkspace";

export interface ChartFibonacciProposal {
  /** Local comparison key, not a cryptographic evidence claim. */
  comparisonKey: string;
  origin: FibonacciOrigin;
  note: string;
}
export type ChartFibonacciRead = {status:"ready";proposal:ChartFibonacciProposal;reason:null}|{status:"unavailable";proposal:null;reason:string};
const unavailable=(reason:string):ChartFibonacciRead=>({status:"unavailable",proposal:null,reason});
/** One causal proposal over the actual, source-matched visible closed window.
 * It observes fractal pivots; it neither forecasts a reversal nor grants entry. */
export function proposeChartFibonacci(input:SmartChartAnalysisInput,actual:readonly ChartEngineCandle[]):ChartFibonacciRead {
  const applied=selectAppliedSmartChartWindow(input,actual,"Fibonacci");
  if(applied.status!=="ready")return unavailable(applied.reason);
  const {selected}=applied,bars=selected.bars;
  const swings=findSwings(bars,2);
  const latest=swings.at(-1);
  if(!latest)return unavailable("Two opposite confirmed swings are needed. Each needs two closed bars on either side.");
  // A candle can be both a strict high and low. Do not guess intrabar order,
  // or skip such a pivot to manufacture an older apparently clean pair.
  const ambiguous=new Set(swings.filter((s,i)=>swings[i-1]?.index===s.index||swings[i+1]?.index===s.index).map(s=>s.index));
  if(ambiguous.has(latest.index))return unavailable("The latest swing candle is both a high and a low; its order is unknown.");
  let prior=swings.length-2;
  while(prior>=0&&swings[prior]!.kind===latest.kind&&!ambiguous.has(swings[prior]!.index))prior--;
  const first=swings[prior];
  if(!first)return unavailable("A prior opposite confirmed swing is not available in this window.");
  if(ambiguous.has(first.index))return unavailable("An intervening swing candle is both a high and a low; no unambiguous pair is proposed.");
  if(first.price===latest.price)return unavailable("The proposed anchors have the same price; no Fibonacci range can be drawn.");
  const origin:FibonacciOrigin={method:"confirmed-swings-v1",span:2,symbol:input.symbol,timeframe:input.timeframe,source:input.source!,sourceIdentity:input.sourceIdentity!,
    start:{time:bars[first.index]!.time,price:first.price},end:{time:bars[latest.index]!.time,price:latest.price},confirmedAt:bars[latest.index+2]!.closeTime,
    windowFrom:bars[0]!.time,windowTo:bars.at(-1)!.closeTime,closedBars:bars.length};
  return {status:"ready",reason:null,proposal:{origin,
    comparisonKey:applied.comparisonKey,
    note:`${selected.coverage.note??`${bars.length} visible closed candles analyzed.`} Two observed closed bars on each side confirm each strict pivot; equal highs/lows are not pivots. This is historical geometry, not a trade signal.`}};
}
/** The same existing Fibonacci geometry owns preview and editable kept object. */
export function fibonacciProposalDrawing(proposal:ChartFibonacciProposal,id:string,preview:boolean):ChartDrawing {
  return {id,kind:"fibonacci",start:{...proposal.origin.start},end:{...proposal.origin.end},color:"#fbbf24",dashed:true,locked:preview,...(!preview?{fibonacciOrigin:{...proposal.origin,start:{...proposal.origin.start},end:{...proposal.origin.end}}}:{})};
}
