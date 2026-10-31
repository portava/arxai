export * from "../../lib/api-client-react/src/index";
import { useMemo } from "react";
import { chartIntervalSeconds } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartIntervals";
export function useGetChartCandles({symbol,timeframe,limit}: {symbol:string;timeframe:string;limit:number}) {
 const data = useMemo(() => {
 const interval = chartIntervalSeconds(timeframe);
 if (interval == null) return undefined; // Disabled/unsupported requests never get fabricated fixture bars.
 const end = Math.floor(Date.now()/1000/interval)*interval;
 const base=symbol === "EURUSD" ? 1.08 : 2300;
 const step=base/1000;
 const candles=Array.from({length:limit},(_,i)=>{
 const time=(end-(limit-1-i)*interval)*1000;
 const open=base+Math.sin(i/17)*step+Math.sin(i/3)*step/5;
 const close=open+Math.sin(i*7)*step/8;
 return {symbol,displaySymbol:symbol,timeframe,openTime:new Date(time).toISOString(),closeTime:new Date(time+interval*1000).toISOString(),open:+open.toFixed(5),high:+(Math.max(open,close)+step/7).toFixed(5),low:+(Math.min(open,close)-step/7).toFixed(5),close:+close.toFixed(5),source:"offline_fixture",isComplete:true};
 });
 return {symbol,timeframe,candles,feedStatus:{symbol,source:"offline_fixture",quality:"delayed",isLive:false,stale:false,aiUsable:false,latencyMs:0,missingCandleCount:0,warning:"Synthetic fixture — not market data"}};
 },[symbol,timeframe,limit]);
 return {data,isLoading:false,isError:false,isFetching:false};
}
export const useGetMeChartIntelligence = () => ({data:undefined});
