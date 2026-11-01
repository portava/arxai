import {findSwings} from "@workspace/domain/chart-patterns";
import {selectAppliedSmartChartWindow} from "./chartAppliedWindow";
import type {SmartChartAnalysisInput} from "./smartChartAnalysis";
import type {ChartEngineCandle} from "./types";

export interface ChartPivotLevel {
  side:"support"|"resistance";
  price:number;
  pivotTime:number;
  confirmedAt:number;
  /** Observed closes after confirmation beyond the level, not touch/retest counts. */
  laterCloseCrossings:number;
}
export interface ChartSupportResistanceProposal {
  comparisonKey:string;
  method:"latest-confirmed-pivots-v1";
  span:2;
  symbol:string;
  timeframe:string;
  source:string;
  sourceIdentity:string;
  windowFrom:number;
  windowTo:number;
  closedBars:number;
  referenceClose:{time:number;price:number};
  levels:[ChartPivotLevel,ChartPivotLevel];
  note:string;
}
export type ChartSupportResistanceRead =
  |{status:"ready";proposal:ChartSupportResistanceProposal;reason:null}
  |{status:"unavailable";proposal:null;reason:string};
/** Reuses the same causal pivots and applied-source qualification as Fibonacci.
 * These are inspectable historical candidates, never estimates of future success. */
export function proposeChartSupportResistance(input:SmartChartAnalysisInput,actual:readonly ChartEngineCandle[]):ChartSupportResistanceRead {
  const unavailable=(reason:string):ChartSupportResistanceRead=>({status:"unavailable",proposal:null,reason});
  const applied=selectAppliedSmartChartWindow(input,actual,"support and resistance");
  if(applied.status!=="ready")return unavailable(applied.reason);
  const bars=applied.selected.bars,last=bars.at(-1)!;
  const swings=findSwings(bars,2);
  const low=swings.findLast(p=>p.kind==="low"&&p.price<last.close);
  const high=swings.findLast(p=>p.kind==="high"&&p.price>last.close);
  if(!low||!high)return unavailable(`No two-sided confirmed-pivot range is available in this displayed closed window: ${!low?"support below the last closed price":""}${!low&&!high?" and ":""}${!high?"resistance above the last closed price":""} is missing. No level was invented or borrowed from outside the window.`);
  const level=(pivot:typeof low,side:ChartPivotLevel["side"]):ChartPivotLevel=>({side,price:pivot.price,pivotTime:bars[pivot.index]!.time,confirmedAt:bars[pivot.index+2]!.closeTime,
    laterCloseCrossings:bars.slice(pivot.index+3).filter(b=>side==="support"?b.close<pivot.price:b.close>pivot.price).length});
  return {status:"ready",reason:null,proposal:{comparisonKey:applied.comparisonKey,method:"latest-confirmed-pivots-v1",span:2,symbol:input.symbol,timeframe:input.timeframe,source:input.source!,sourceIdentity:input.sourceIdentity!,windowFrom:bars[0]!.time,windowTo:last.closeTime,closedBars:bars.length,referenceClose:{time:last.closeTime,price:last.close},levels:[level(low,"support"),level(high,"resistance")],
    note:`${applied.selected.coverage.note??`${bars.length} visible closed observations analyzed.`} On each side of the last closed price, select the most recent strict pivot with two observed closed bars on either side. Equal highs/lows are not pivots. A pivot is knowable only at its confirmation close, not its earlier anchor. These are historical reference levels, not zones, unbroken-level claims, predictions or trade instructions. Gaps need not represent adjacent market intervals. No ordering within a candle is inferred.`}};
}

/** Existing horizontal object format, with immutable archived provenance after keep. */
export function levelProposalDrawings(p:ChartSupportResistanceProposal,prefix:string,preview:boolean):import("./chartWorkspace").ChartDrawing[] {
 return p.levels.map(level=>({id:`${prefix}-${level.side}`,kind:"horizontal",start:{time:level.pivotTime,price:level.price},color:level.side==="support"?"#38bdf8":"#fbbf24",dashed:true,locked:preview,...(!preview?{pivotLevelOrigin:{method:p.method,span:p.span,symbol:p.symbol,timeframe:p.timeframe,source:p.source,sourceIdentity:p.sourceIdentity,windowFrom:p.windowFrom,windowTo:p.windowTo,closedBars:p.closedBars,referenceClose:{...p.referenceClose},level:{...level}}}:{})}));
}
