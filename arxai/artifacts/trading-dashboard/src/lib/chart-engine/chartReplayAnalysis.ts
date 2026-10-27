import { replayPrefix, type ChartReplaySnapshot } from "./chartReplay";
import { bindSmartChartBars, type SmartChartAnalysisContext, type SmartChartBoundBars } from "./smartChartAnalysis";

export interface ChartReplayReadWindow { snapshot: ChartReplaySnapshot; installedCount: number }
export type ChartReplayAnalysisPrefix = SmartChartBoundBars & {
  context: SmartChartAnalysisContext;
  asOfMs: number | null;
  replayCutoff: number | null;
};

/** A replay snapshot already contains validated closed observations. Only the
 * count acknowledged by the adapter may enter analysis; never the requested
 * cursor, full snapshot endpoint, current feed, or wall clock. */
export function captureReplayAnalysisPrefix(window: ChartReplayReadWindow,
  expected: {symbol:string;timeframe:string}): ChartReplayAnalysisPrefix {
  const {snapshot,installedCount}=window;
  const context={symbol:snapshot.symbol,timeframe:snapshot.timeframe,source:snapshot.source,sourceIdentity:snapshot.sourceIdentity};
  const unavailable=(reason:string):ChartReplayAnalysisPrefix=>({context,status:"unavailable",reason,bars:[],asOfMs:null,replayCutoff:null});
  if (snapshot.symbol!==expected.symbol || snapshot.timeframe!==expected.timeframe
    || !Number.isSafeInteger(installedCount) || installedCount<1 || installedCount>snapshot.bars.length) {
    return unavailable("Waiting for this historical replay prefix to be installed.");
  }
  const bars=replayPrefix(snapshot,installedCount).map(bar=>({...bar,isComplete:true,isFinal:true,isForming:false}));
  const bound=bindSmartChartBars(context,[{evidence:context,bars}]);
  if(bound.status!=="ready")return {...bound,context,asOfMs:null,replayCutoff:null};
  const replayCutoff=bound.bars.at(-1)!.closeTime;
  return {...bound,context,replayCutoff,asOfMs:replayCutoff*1000};
}
