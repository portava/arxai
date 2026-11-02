import type {UseTradingModeResult} from '@/hooks/useTradingMode';
/** Display only. Existing envelope permissions remain the execution authority. */
export interface SafetyReadEvidence {
  data?: {arming?: {killSwitchEngaged?: unknown} | null} | null;
  isLoading?: boolean;
  isError?: boolean;
  isStale?: boolean;
  isFetching?: boolean;
  dataUpdatedAt?: number;
}
export interface AccountModePresentation {
  modeLabel:string;
  statusLabel:string;
  detail:string;
  tone:'neutral'|'warning'|'danger';
  href:'/live-trading'|'/live-shared';
}
function current(read:{isLoading?:boolean;isError?:boolean;isStale?:boolean;isFetching?:boolean;dataUpdatedAt?:number}):boolean {
  return read.isLoading===false && read.isError===false && read.isStale===false && read.isFetching===false
    && typeof read.dataUpdatedAt==='number' && Number.isFinite(read.dataUpdatedAt) && read.dataUpdatedAt>0;
}
function text(value:unknown):string|null {return typeof value==='string' && value.trim()?value.trim():null;}
export function describeAccountMode(mode:UseTradingModeResult,safety:SafetyReadEvidence):AccountModePresentation {
  const env=mode.envelope;
  const modeCurrent=!!env && current(mode);
  const name=env?.currentAccountMode==='LIVE_SHARED'?'Live shared':env?.currentAccountMode==='DEMO'?'Demo':env?.currentAccountMode==='PAPER'?'Simulated':null;
  const modeLabel=name?`${modeCurrent?'Account mode':'Last reported mode'}: ${name}`:'Account mode unavailable';
  const base={modeLabel,href:env?.currentAccountMode==='LIVE_SHARED'?'/live-shared' as const:'/live-trading' as const};
  const status=(statusLabel:string,detail:string,tone:AccountModePresentation['tone']='warning'):AccountModePresentation=>({...base,statusLabel,detail,tone});
  // A direct positive kill report outranks the coarse mode resolver. Failed or
  // expired reads retain the restriction as last reported, never fresh proof.
  if(safety.data?.arming?.killSwitchEngaged===true) return current(safety)
    ?status('Kill switch engaged','The latest safety report has the live kill switch engaged.','danger')
    :status('Last reported kill switch','The last safety report had the live kill switch engaged. Its current state is unverified.','danger');
  if(!modeCurrent || !name){
    const cause=mode.isError?'Account-mode refresh failed.':mode.isLoading?'Account mode is loading.':!env?'No account-mode report is available.':'The account-mode report is awaiting a current check.';
    const previous=text(env?.cleanBlockedReason)??(env?.userFrozenStatus?.isFrozen===true?text(env.userFrozenStatus.freezeMessage)??'Trading was paused.':null);
    return status('Availability unverified',`${cause}${previous?` Last reported restriction: ${previous}`:''}`);
  }
  if(env?.userFrozenStatus?.isFrozen===true) return status('Trading paused',text(env.userFrozenStatus.freezeMessage)??'The account report says trading is paused.');
  const blocked=text(env?.cleanBlockedReason);
  if(blocked) return status('Trading blocked',blocked);
  if(typeof env?.userFrozenStatus?.isFrozen!=='boolean' || !(env.cleanBlockedReason===null || typeof env.cleanBlockedReason==='string') || typeof env.isAdminPreviewingUserMode!=='boolean') return status('Availability unverified','The account report does not establish the current restriction and preview state.');
  if(env?.isAdminPreviewingUserMode===true) return status('User preview','Viewing user account permissions. This does not verify that an order can be sent.','neutral');
  if(env?.currentAccountMode==='LIVE_SHARED' && env.liveExecutionArmed===false) return status('Live orders not armed','Live account mode is selected, but the account report says live execution is not armed.');
  if(!current(safety) || safety.data?.arming?.killSwitchEngaged!==false) return status('Availability unverified','The current safety-switch status is unavailable. Account mode does not establish broker connectivity or live prices.');
  if(env?.currentAccountMode==='LIVE_SHARED'){
    if(env.liveExecutionArmed!==true || typeof env.userCanManualTrade!=='boolean' || typeof env.userCanAutoTrade!=='boolean') return status('Availability unverified','The account report does not establish current arming and trading permissions.');
    if(!env.userCanManualTrade && !env.userCanAutoTrade) return status('Trading access unavailable','The account report does not permit manual or automated trading.');
    return status('Permissions reported',`Manual: ${env.userCanManualTrade?'allowed':'not allowed'}; automated: ${env.userCanAutoTrade?'allowed':'not allowed'}. Broker connectivity, market data and each order are checked separately.`,'neutral');
  }
  return status('Mode selected',env?.currentAccountMode==='DEMO'?'Demo account mode is selected. Broker connectivity and market data are checked separately.':'Simulated account mode is selected. This is not a live broker or market-data status.','neutral');
}
