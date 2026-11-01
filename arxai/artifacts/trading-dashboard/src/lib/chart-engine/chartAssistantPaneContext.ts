import type {ChartCandlesResponse} from '@workspace/api-client-react';
import {observedTradeVolumeIdentity} from './chartVolume';
/** Display-source identity only. Stock volume/clock evidence can identify a
 * chart without granting market-read, research price-basis or trading authority.
 * Quantities/OHLC are deliberately excluded so revisions do not retarget tools. */
export function chartAssistantPaneContext(data:ChartCandlesResponse|undefined,symbol:string,timeframe:string,engineGeneration:number):string {
 const series=new Set<string>(),clocks=new Set<string>(),bases=new Set<string>();
 for(const bar of data?.candles??[]){
  const volume=observedTradeVolumeIdentity(bar.volumeEvidence);if(volume)series.add(volume);
  clocks.add(JSON.stringify(bar.timeBasisEvidence??null));
  bases.add(JSON.stringify(bar.priceBasisEvidence??null));
 }
 return JSON.stringify([symbol,timeframe,data?.source??null,data?.feedStatus?.source??null,data?.marketEvidence?.sourceIdentity??null,[...series].sort(),[...clocks].sort(),[...bases].sort(),engineGeneration]);
}
