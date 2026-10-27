import type { ChartCandlesResponse } from "@workspace/api-client-react";
export const NOW=Date.parse("2026-10-26T12:00:00Z");
export function replayResponse(count=200):ChartCandlesResponse {
 const candles=Array.from({length:count},(_,i)=>{const openTime=NOW-(count-i)*900_000,price=100+Math.sin(i/8)*5;return{
  symbol:"V75",displaySymbol:"V75",timeframe:"M15",source:"deriv_public",openTime:new Date(openTime).toISOString(),closeTime:new Date(openTime+900_000).toISOString(),
  open:price,high:price+2,low:price-2,close:price+1,volume:0,tickVolume:null,isComplete:true,isFinal:true,isForming:false,sourceMode:"live",priceBasis:"SYNTHETIC",receivedAt:new Date(NOW).toISOString(),qualityFlags:[]};});
 return {symbol:"V75",timeframe:"M15",candles,feedStatus:{source:"deriv_public"},marketEvidence:{symbol:"V75",timeframe:"M15",source:"deriv_public",sourceIdentity:"a".repeat(64),lastClosedCandleAt:new Date(NOW).toISOString()}} as unknown as ChartCandlesResponse;
}
