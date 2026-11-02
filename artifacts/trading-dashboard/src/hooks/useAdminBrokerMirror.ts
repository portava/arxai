import {useQuery, useQueryClient} from '@tanstack/react-query';
import {getAdminFundBookBrokerMirror, getGetAdminFundBookBrokerMirrorQueryKey} from '@workspace/api-client-react';
import {useCurrentUser, type CurrentUser} from './useCurrentUser';
import {useAccountRefreshPreference} from './useAccountRefreshPreference';
import {readAccountResponse} from './readSharedAccountSummary';

const ownerKey=(user:CurrentUser|null|undefined)=>user&&Number.isSafeInteger(user.id)&&user.id>0&&['ADMIN','OWNER'].includes(user.role)?`${user.id}:${user.role}`:null;
export function useAdminBrokerMirror(){
 const client=useQueryClient();
 const identity=useCurrentUser();
 const owner=identity.isError?null:ownerKey(identity.user);
 const [autoRefreshEnabled,setAutoRefreshEnabled]=useAccountRefreshPreference();
 const query=useQuery({
  queryKey:[...getGetAdminFundBookBrokerMirrorQueryKey(),owner],
  enabled:owner!==null,
  queryFn:async({signal})=>{
   const report=await readAccountResponse(signal,getAdminFundBookBrokerMirror);
   if(report?.ok!==true||!Array.isArray(report.bridges)||!Array.isArray(report.openPositions))throw Error('Account report unavailable.');
   const text=(value:unknown)=>value==null||typeof value==='string';
   const optionalNumber=(value:unknown)=>value==null||(typeof value==='number'&&Number.isFinite(value));
   const positiveId=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
   const ids=new Set<number>();
   for(const bridge of report.bridges){
    if(!bridge||!positiveId(bridge.bridgeConnectionId)||ids.has(bridge.bridgeConnectionId)
      ||!text(bridge.connectionName)||typeof bridge.status!=='string'||typeof bridge.accountType!=='string'
      ||!['FRESH','DELAYED','STALE','MISSING'].includes(bridge.freshness)
      ||!text(bridge.freshnessAsOf)||!text(bridge.lastHeartbeatAt)||!text(bridge.lastPositionsSnapshotAt)
      ||!Number.isSafeInteger(bridge.openPositionCount)||bridge.openPositionCount<0)
      throw Error('Account connection report unavailable.');
    ids.add(bridge.bridgeConnectionId);
   }
   const tickets=new Set<string>();
   for(const position of report.openPositions){
    if(!position||!positiveId(position.bridgeConnectionId)||!ids.has(position.bridgeConnectionId)
      ||typeof position.brokerTicket!=='string'||!position.brokerTicket||typeof position.symbol!=='string'
      ||!text(position.side)||!text(position.allocationStatus)||!text(position.lastSyncedAt)
      ||!optionalNumber(position.volume)||!optionalNumber(position.floatingPl)
      ||(position.strategyPoolId!=null&&!positiveId(position.strategyPoolId)))
      throw Error('Position report unavailable.');
    const key=JSON.stringify([position.bridgeConnectionId,position.brokerTicket]);
    if(tickets.has(key))throw Error('Position report identity unavailable.');
    tickets.add(key);
   }
   return report;
  },
  retry:false,refetchInterval:autoRefreshEnabled?5000:false,
  refetchIntervalInBackground:false,refetchOnWindowFocus:autoRefreshEnabled,refetchOnReconnect:autoRefreshEnabled,
 });
 const refetch=()=>{
  const state=client.getQueryState(['me']);
  if(owner!==null&&state?.status==='success'&&ownerKey(client.getQueryData<CurrentUser>(['me']))===owner)return query.refetch();
  return undefined;
 };
 return {...query,data:owner!==null&&!query.isError?query.data:undefined,
  isLoading:identity.isLoading||(owner!==null&&query.isLoading),
  isError:identity.isError||(!identity.isLoading&&owner===null)||query.isError,
  autoRefreshEnabled,setAutoRefreshEnabled,refetch};
}
