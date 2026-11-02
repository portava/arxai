import type { QueryClient } from '@tanstack/react-query';
import type { UnifiedPosition } from '@/components/positions/PositionSideCard';
import { readAccountResponse } from './readSharedAccountSummary';
export type UnifiedPositionsResponse = {ok:true;live:UnifiedPosition[];demo:UnifiedPosition[];liveCount:number;demoCount:number;notLiveReason?:string|null};
export const getUnifiedPositionsQueryKey = (userId:number) => ['/api/me/positions/all',userId] as const;
export function authenticatedPositionUserId(value:unknown):number|null {
 const id=value&&typeof value==='object'?(value as {id?:unknown}).id:null;
 return typeof id==='number'&&Number.isSafeInteger(id)&&id>0?id:null;
}
export function readCachedPositionUserId(client:QueryClient):number|null {
 return client.getQueryState(["me"])?.status==='success'?authenticatedPositionUserId(client.getQueryData(["me"])):null;
}
const nullableTextFields=['symbol','openedAt','sourceCommandId'] as const;
const numericFields=['lotSize','entryPrice','currentPrice','stopLoss','takeProfit','floatingPnl'] as const;
function parsePositions(value:unknown):UnifiedPositionsResponse {
 const body=value&&typeof value==='object'?value as Record<string,unknown>:null;
 if(body?.ok!==true||!Array.isArray(body.live)||!Array.isArray(body.demo))throw Error('Position report is unavailable.');
 for(const scope of ['live','demo'] as const)for(const raw of body[scope] as unknown[]){
  const row=raw&&typeof raw==='object'?raw as Record<string,unknown>:null;
  if(!row||row.scope!==scope||row.accountMode!==(scope==='live'?'LIVE':'DEMO')
   ||(row.brokerTicket!==null&&typeof row.brokerTicket!=='string')
   ||nullableTextFields.some(field=>row[field]!==null&&row[field]!==undefined&&typeof row[field]!=='string')
   ||(row.side!==undefined&&row.side!==null&&row.side!=='BUY'&&row.side!=='SELL')
   ||(row.source!==undefined&&typeof row.source!=='string')
   ||numericFields.some(field=>row[field]!==null&&(typeof row[field]!=='number'||!Number.isFinite(row[field]))))throw Error('Position report contains unverified values.');
 }
 // Counts describe exactly the supplied rows; no sum is treated as account profit.
 return {...body,ok:true,live:body.live as UnifiedPosition[],demo:body.demo as UnifiedPosition[],liveCount:body.live.length,demoCount:body.demo.length} as UnifiedPositionsResponse;
}
export function readUnifiedPositions({signal}:{signal:AbortSignal}) {
 const base=(import.meta.env.BASE_URL||'/').replace(/\/$/,'');
 return readAccountResponse(signal,async options=>{
  const response=await fetch(`${base}/api/me/positions/all`,{...options,credentials:'include'});
  if(!response.ok)throw Error(`Position report unavailable (HTTP ${response.status}).`);
  return parsePositions(await response.json());
 });
}
