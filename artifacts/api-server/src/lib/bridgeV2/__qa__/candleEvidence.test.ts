// Actual v2 validation + ingest + memory provider + router + Truth integration.
// Only the transaction transport is a deterministic double: no database/network.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../data/types.js';
import { bridgeV2 } from '@workspace/domain';
import { scannerSourceIdentity } from '../../scannerInputIntegrity.js';
import { mt5PriceBasisEvidence } from '../../data/candlePriceBasisEvidence.js';
import { runCandleTruth } from '../../data/chart/candleTruthEngine.js';
import { __resetMt5ProviderStore, mergeCandleFromMT5, readMt5Candles, __setMt5ContentionWarnSink } from '../../data/providers/mt5Provider.js';

const database = await import('@workspace/db');
type State = {lastSequence: number|null};
let states=new Map<string,State>(),events:any[]=[],failCommit=false,failUpdate=false,beforeCommit:(()=>void)|null=null;
let rejected:any[]=[];
const fakeDb={
 insert:()=>({values:async(row:unknown)=>{rejected.push(row);}}),
 transaction:async(callback:(tx:any)=>Promise<any>)=>{
  const pendingStates=new Map([...states].map(([key,value])=>[key,{...value}]));
  const pendingEvents=[...events];let key='';
  const tx={
   insert:(table:unknown)=>({values:(row:any)=>{
    if(table===database.bridgeV2StreamStateTable){
     key=JSON.stringify([row.userId,row.bridgeConnectionId,row.messageType,row.streamKey]);
     return {onConflictDoNothing:async()=>{if(!pendingStates.has(key))pendingStates.set(key,{lastSequence:null});}};
    }
    if(table!==database.bridgeV2EventsTable)throw new Error('Unexpected table');
    if(pendingEvents.some(event=>event.userId===row.userId&&event.idempotencyKey===row.idempotencyKey))return Promise.reject(Object.assign(new Error('duplicate'),{code:'23505'}));
    pendingEvents.push(row);return Promise.resolve();
   }}),
   select:()=>({from:()=>({where:()=>({for:()=>({limit:async()=>[pendingStates.get(key)]})})})}),
   update:()=>({set:(row:any)=>({where:async()=>{if(failUpdate)throw new Error('state update failed');pendingStates.set(key,{lastSequence:row.lastSequence});}})}),
  };
  const result=await callback(tx);beforeCommit?.();if(failCommit)throw new Error('commit failed');
  states=pendingStates;events=pendingEvents;return result;
 },
};
mock.module('@workspace/db',{namedExports:{...database,db:fakeDb}});
const {ingestBridgeV2Message}=await import('../ingest.js');
const {routeCandles}=await import('../../data/marketDataRouter.js');
const now=Date.UTC(2026,10,1,12,0),baseTime=now-3*60_000;
const bar=(time=baseTime,close=1.101):Candle=>({time:new Date(time).toISOString(),open:1.1,high:1.103,low:1.099,close,volume:17});
const payload=(basis?:unknown,time=baseTime)=>({symbol:'EURUSD',timeframe:'M1',openTimeEpochMs:time,open:1.1,high:1.103,low:1.099,close:1.101,volume:17,isClosed:true,...(basis!==undefined?{priceBasis:basis}:{})});
const message=(body:unknown,sequence=1,extra:Record<string,unknown>={})=>({protocolVersion:2,messageType:'CANDLE',streamKey:'EURUSD|M1',sequence,idempotencyKey:'offline-'+sequence,eaCreatedAtEpochMs:now,eaVersion:'1.54',payload:body,...extra});
const send=(raw:unknown,bridgeConnectionId:number|null=17,userId=3)=>ingestBridgeV2Message({userId,bridgeConnectionId,raw,serverReceivedAtEpochMs:now});
const read=(id?:number)=>readMt5Candles('EURUSD','M1',100,id==null?undefined:{bridgeConnectionId:id});
const snapshot=()=>JSON.stringify([read(),read(17),read(28)]);
const truth=(candles:Candle[])=>runCandleTruth(candles,{symbol:'EURUSD',displaySymbol:'EUR/USD',timeframe:'M1',source:'mt5_broker',assetClass:'forex',limit:100,now});
beforeEach(()=>{__resetMt5ProviderStore();__setMt5ContentionWarnSink(()=>{});states=new Map();events=[];rejected=[];failCommit=false;failUpdate=false;beforeCommit=null;});

for(const basis of ['bid','mid','last','ask',undefined])test(`wire declaration ${basis??'missing'} follows existing batch semantics`,()=>{
 const result=bridgeV2.validateBridgeV2Message(message(payload(basis)));assert.equal(result.ok,true);
 if(!result.ok)return;
 assert.equal((result.payload as any).priceBasis,basis);
});

test('same authenticated connection batch + v2 merge into one actual partition after commit',async()=>{
 mergeCandleFromMT5('EURUSD',{...bar(),priceBasisEvidence:mt5PriceBasisEvidence('bid')},'M1',{bridgeConnectionId:17,userId:3});
 const before=snapshot();beforeCommit=()=>assert.equal(snapshot(),before,'memory must stay unchanged until commit resolves');
 assert.equal((await send(message(payload('bid',baseTime+60_000)))).accepted,true);
 assert.equal(read(17).candles.length,2);assert.equal(read().bridgeConnectionId,17);assert.equal(read().userId,3);
 assert.ok(read(17).candles.every(c=>c.priceBasisEvidence?.basis==='BID'));
 assert.deepEqual(truth(read(17).candles).verifiedCandles.map(c=>c.priceBasis),['BID','BID']);
 assert.equal(events[0].payload.priceBasis,'bid');
});

test('different authenticated writers never blend or accept spoofed payload identity',async()=>{
 await send(message({...payload('bid'),bridgeConnectionId:28,userId:9}),17,3);
 await send(message(payload('last',baseTime+60_000)),28,9);
 assert.equal(read(17).candles.length,1);assert.equal(read(28).candles.length,1);
 assert.equal(read(17).candles[0]?.priceBasisEvidence?.basis,'BID');assert.equal(read(28).candles[0]?.priceBasisEvidence?.basis,'LAST');
 assert.equal(read(17).userId,3);assert.equal(read(28).userId,9);assert.equal(read().contention,true);
 assert.equal(read(999).candles.length,0);
});

test('source identity stays stable for batch + same connection stream, changes for another writer',async()=>{
 mergeCandleFromMT5('EURUSD',{...bar(),priceBasisEvidence:mt5PriceBasisEvidence('bid')},'M1',{bridgeConnectionId:17,userId:3});
 const first=scannerSourceIdentity(await routeCandles('EURUSD','M1',100));
 await send(message(payload('bid',baseTime+60_000)));const second=scannerSourceIdentity(await routeCandles('EURUSD','M1',100));
 assert.equal(first,second);
 await send(message(payload('last')),28,9);assert.notEqual(scannerSourceIdentity(await routeCandles('EURUSD','M1',100)),second);
});

for(const basis of [undefined,'ask'])test(`same-time ${basis??'missing'} declaration withdraws earlier basis without inventing volume`,async()=>{
 mergeCandleFromMT5('EURUSD',{...bar(),priceBasisEvidence:mt5PriceBasisEvidence('bid'),volumeEvidence:{kind:'tick_count',quantity:17,unit:'ticks',reason:null}},'M1',{bridgeConnectionId:17,userId:3});
 await send(message(payload(basis)));const stored=read(17).candles;
 assert.equal(stored.length,1);assert.equal(stored[0]?.priceBasisEvidence?.kind,'unavailable');assert.equal(stored[0]?.volumeEvidence,undefined);
 assert.equal(truth(stored).verifiedCandles[0]?.priceBasis,'UNKNOWN');
});

for(const [bridge,user] of [[null,3],[0,3],[-1,3],[1.5,3],[Number.MAX_SAFE_INTEGER+1,3],[17,0],[17,-2],[17,NaN],[17,Infinity]] as const)test(`invalid context ${bridge}/${user} never falls back into unattributed memory`,async()=>{
 const before=snapshot();await send(message({...payload('bid'),bridgeConnectionId:17,userId:3}),bridge,user);assert.equal(snapshot(),before);
});

for(const kind of ['sequence duplicate','idempotency duplicate','stale','invalid payload','unsupported declaration','invalid envelope','commit rollback','state update rollback'])test(`${kind} has no market-memory side effects`,async()=>{
 await send(message(payload('bid')));const before=snapshot();let raw:any=message(payload('last',baseTime+60_000),2);
 if(kind==='sequence duplicate')raw=message(payload('last'),1,{idempotencyKey:'different-key'});
 if(kind==='idempotency duplicate')raw=message(payload('last'),2,{idempotencyKey:'offline-1'});
 if(kind==='stale')raw.eaCreatedAtEpochMs=now-60_000;
 if(kind==='invalid payload')raw.payload.isClosed=false;
 if(kind==='unsupported declaration')raw.payload.priceBasis='synthetic';
 if(kind==='invalid envelope')raw.protocolVersion=1;
 if(kind==='commit rollback')failCommit=true;
 if(kind==='state update rollback')failUpdate=true;
 if(kind.endsWith('rollback'))await assert.rejects(()=>send(raw),/failed/);else await send(raw);
 assert.equal(snapshot(),before);
});


test('new attributed v2 writer never promotes or inherits existing unattributed history',async()=>{
 mergeCandleFromMT5('EURUSD',{...bar(),priceBasisEvidence:mt5PriceBasisEvidence('bid')},'M1');
 const legacyIdentity=scannerSourceIdentity(await routeCandles('EURUSD','M1',100));
 await send(message(payload('bid',baseTime+60_000)));
 assert.equal(read(17).candles.length,1);
 assert.equal(read(17).candles[0]?.time,new Date(baseTime+60_000).toISOString());
 assert.notEqual(scannerSourceIdentity(await routeCandles('EURUSD','M1',100)),legacyIdentity);
});

test('explicit LAST and MID declarations reach actual normalization without becoming inferred BID',async()=>{
 await send(message(payload('last')));
 assert.equal(truth(read(17).candles).verifiedCandles[0]?.priceBasis,'LAST');
 await send(message(payload('mid'),2));
 assert.equal(truth(read(17).candles).verifiedCandles[0]?.priceBasis,'MID');
});
