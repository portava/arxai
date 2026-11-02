import type { ChartCandlesResponse } from "@workspace/api-client-react";
export const start = Date.parse("2026-10-25T10:00:00Z") / 1000;
export function comparisonFixture(symbol="EURUSD", closes=[100,110,120,90]): ChartCandlesResponse {
  const candles=closes.map((close,i)=>({symbol,timeframe:"M5",source:"deriv_public",sourceMode:"live",priceBasis:"LAST",
    openTime:new Date((start+i*300)*1000).toISOString(),closeTime:new Date((start+(i+1)*300)*1000).toISOString(),
    open:close,high:close+1,low:close-1,close,isComplete:true,isFinal:true,isForming:false,qualityFlags:[],
    timeBasisEvidence:{kind:"original_utc",basis:"UTC",authority:"offline:controlled-utc-fixture",reason:null}}));
  return {symbol,timeframe:"M5",source:"deriv_public",quality:"clean",candles,feedStatus:{symbol,source:"deriv_public",stale:false},
    marketEvidence:{symbol,timeframe:"M5",source:"deriv_public",sourceIdentity:"a".repeat(64),lastClosedCandleAt:candles.at(-1)!.closeTime}} as unknown as ChartCandlesResponse;
}
