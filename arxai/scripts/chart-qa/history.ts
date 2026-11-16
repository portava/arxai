// Offline fixture: no older pages exist. Mirrors ChartDeepHistoryState in
// artifacts/trading-dashboard/src/lib/useChartDeepHistory.ts.
const empty: never[] = [];
const noop = () => {};
const state = {olderCandles:empty,analysisCandles:empty,archiveCandles:empty,analysisEvidence:null,nativeHistory:null,
 loading:false,hasMore:false,providerCapped:true,limitationReason:"Offline fixture",coverageDays:0,depthTargetDays:0,
 loadedAny:false,loadError:null,loadOlder:noop,reset:noop};
export const useChartDeepHistory = (..._args: unknown[]) => state;
