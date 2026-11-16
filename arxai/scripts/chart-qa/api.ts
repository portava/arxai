export * from "../../lib/api-client-react/src/index";
import { useMemo } from "react";
import { chartIntervalSeconds, chartBarCloseSeconds } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartIntervals";
// Synthetic bar opens (Unix seconds). Fixed intervals step by their duration;
// MN1 has no fixed duration, so its bars open on UTC calendar-month boundaries.
// Only bars after the Unix epoch are served (the chart accepts positive times
// only), so W1/MN1 return fewer than `limit` bars.
function barOpens(timeframe: string, limit: number): number[] | undefined {
 if (timeframe === "MN1") {
  const now = new Date();
  return Array.from({length:limit},(_,i)=>Date.UTC(now.getUTCFullYear(), now.getUTCMonth()-(limit-1-i), 1)/1000).filter(open=>open>0);
 }
 const interval = chartIntervalSeconds(timeframe);
 if (interval == null) return undefined; // Disabled/unsupported requests never get fabricated fixture bars.
 const end = Math.floor(Date.now()/1000/interval)*interval;
 return Array.from({length:limit},(_,i)=>end-(limit-1-i)*interval).filter(open=>open>0);
}
export function useGetChartCandles({symbol,timeframe,limit}: {symbol:string;timeframe:string;limit:number}) {
 const data = useMemo(() => {
 const opens = barOpens(timeframe, limit);
 if (!opens) return undefined;
 const base=symbol === "EURUSD" ? 1.08 : 2300;
 const step=base/1000;
 const candles=opens.map((openSec,i)=>{
 const time=openSec*1000;
 const open=base+Math.sin(i/17)*step+Math.sin(i/3)*step/5;
 const close=open+Math.sin(i*7)*step/8;
 return {symbol,displaySymbol:symbol,timeframe,openTime:new Date(time).toISOString(),closeTime:new Date(chartBarCloseSeconds(openSec,timeframe)!*1000).toISOString(),open:+open.toFixed(5),high:+(Math.max(open,close)+step/7).toFixed(5),low:+(Math.min(open,close)-step/7).toFixed(5),close:+close.toFixed(5),source:"offline_fixture",isComplete:true,
  // The fixture generates every open in UTC, so its time basis is original UTC.
  timeBasisEvidence:{kind:"original_utc",basis:"UTC",reason:null,authority:"offline_fixture"}};
 });
 return {symbol,timeframe,candles,feedStatus:{symbol,source:"offline_fixture",quality:"delayed",isLive:false,stale:false,aiUsable:false,latencyMs:0,missingCandleCount:0,warning:"Synthetic fixture — not market data"}};
 },[symbol,timeframe,limit]);
 return {data,isLoading:false,isError:false,isFetching:false};
}
export const useGetMeChartIntelligence = () => ({data:undefined});
