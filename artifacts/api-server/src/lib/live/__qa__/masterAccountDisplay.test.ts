import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPinnedMasterAccount } from '../masterAccountDisplay.js';
import { MT5_ACCOUNT_SNAPSHOT_FRESH_MS } from '../../brokerHub/freshness.js';
import type { ConnectionAccountFacts } from '../../brokerHub/accountSnapshot.js';
const NOW=Date.parse('2026-11-01T12:00:00Z');
const connection=(over:Partial<ConnectionAccountFacts>={}):ConnectionAccountFacts=>({id:7,userId:23,accountNumber:'12345678',brokerName:'Fixture broker',serverName:'Fixture server',accountCurrency:'USD',accountBalance:100,accountEquity:120,margin:5,freeMargin:115,accountSyncedAt:new Date(NOW-1000),...over});
const project=(over:Partial<ConnectionAccountFacts>={},nowMs=NOW)=>projectPinnedMasterAccount({masterConnectionId:7,connection:connection(over),nowMs});
for(const [name,time] of [['missing',null],['invalid',new Date('invalid')],['future',new Date(NOW+1)],['epoch',new Date(0)],['pre-epoch',new Date(-1)]] as const){
 test(`${name} account time never turns column defaults into observed funds`,()=>{const p=project({accountSyncedAt:time,accountBalance:0,accountEquity:0});assert.equal(p.snapshotStatus,'MISSING');assert.equal(p.syncStatus,'UNAVAILABLE');assert.equal(p.lastMt5SnapshotAt,null);assert.equal(p.snapshotAgeMs,null);for(const key of ['mt5Balance','mt5Equity','mt5UsedMargin','mt5FreeMargin','mt5OpenPnl'] as const)assert.equal(p[key],null);});
}
for(const age of [0,MT5_ACCOUNT_SNAPSHOT_FRESH_MS,MT5_ACCOUNT_SNAPSHOT_FRESH_MS+1]){
 test(`account-update age boundary ${age} uses the shared account policy`,()=>{const p=project({accountSyncedAt:new Date(NOW-age)});assert.equal(p.snapshotAgeMs,age);assert.equal(p.snapshotStatus,age>MT5_ACCOUNT_SNAPSHOT_FRESH_MS?'STALE':'FRESH');assert.equal(p.lastMt5SnapshotAt,new Date(NOW-age).toISOString());assert.equal(p.mt5Balance,100);});
}
test('observed exact zero is retained, including zero margin',()=>{const p=project({accountBalance:0,accountEquity:0,margin:0,freeMargin:0});assert.equal(p.snapshotStatus,'FRESH');assert.equal(p.mt5Balance,0);assert.equal(p.mt5Equity,0);assert.equal(p.mt5UsedMargin,0);assert.equal(p.mt5FreeMargin,0);});
test('a valid update cannot prove monetary observations were simultaneous',()=>{const p=project();assert.equal(p.accountObservationScope,'LATEST_ACCOUNT_UPDATE');assert.equal(p.amountsCoherent,false);assert.equal(p.mt5OpenPnl,null);});
for(const field of ['accountBalance','accountEquity'] as const){test(`missing ${field} keeps other reported figures but cannot advertise a complete account update`,()=>{const p=project({[field]:null});assert.equal(p.snapshotStatus,'MISSING');assert.equal(p.syncStatus,'UNAVAILABLE');assert.equal(p.snapshotAgeMs,1000);assert.equal(p.mt5Balance,field==='accountBalance'?null:100);assert.equal(p.mt5Equity,field==='accountEquity'?null:120);assert.equal(p.mt5OpenPnl,null);});}
test('invalid scalar values never become numeric zero or JSON-infinite money',()=>{const p=project({accountBalance:NaN,accountEquity:Infinity,margin:null,freeMargin:Infinity});assert.equal(p.mt5Balance,null);assert.equal(p.mt5Equity,null);assert.equal(p.mt5UsedMargin,null);assert.equal(p.mt5FreeMargin,null);assert.equal(p.snapshotStatus,'MISSING');});
test('negative reported equity remains a fact rather than being clamped away',()=>{const p=project({accountEquity:-20,freeMargin:-25});assert.equal(p.mt5Equity,-20);assert.equal(p.mt5FreeMargin,-25);});
test('a connection other than the supplied pin cannot contribute any monetary value',()=>{const p=projectPinnedMasterAccount({masterConnectionId:8,connection:connection(),nowMs:NOW});assert.equal(p.mt5Balance,null);assert.equal(p.accountCurrency,null);assert.equal(p.snapshotStatus,'MISSING');});
test('missing pin/connection and an invalid evaluation clock fail closed',()=>{for(const input of [{masterConnectionId:null,connection:connection(),nowMs:NOW},{masterConnectionId:7,connection:null,nowMs:NOW},{masterConnectionId:7,connection:connection(),nowMs:NaN},{masterConnectionId:7,connection:connection(),nowMs:Infinity},{masterConnectionId:7,connection:connection(),nowMs:0}]){const p=projectPinnedMasterAccount(input);assert.equal(p.snapshotStatus,'MISSING');assert.equal(p.mt5Balance,null);}});

test('generated response validators retain nullable amounts and explicit observation scope',async()=>{
 const {GetMeSharedAccountSummaryResponse,RefreshMeSharedAccountSnapshotResponse}=await import('../../../../../../lib/api-zod/src/generated/api.js');
 const masterMt5={...project({accountSyncedAt:null}),openPositions:null,arxAllocated:0,arxAvailable:0,arxReserved:0,realizedPnl7d:0,isOverAllocated:false,unattributedCount:0};
 const summary=GetMeSharedAccountSummaryResponse.parse({ok:true,userId:1,accounts:[],masterMt5});const refresh=RefreshMeSharedAccountSnapshotResponse.parse({ok:true,masterMt5});
 assert.equal(summary.masterMt5?.mt5Balance,null);assert.equal(refresh.masterMt5?.openPositions,null);assert.equal(summary.masterMt5?.accountObservationScope,'LATEST_ACCOUNT_UPDATE');assert.equal(refresh.masterMt5?.amountsCoherent,false);
 assert.equal(RefreshMeSharedAccountSnapshotResponse.safeParse({ok:true,masterMt5:{...masterMt5,accountObservationScope:'HEARTBEAT'}}).success,false);
});

for(const value of [12.345,0.0001,Number.MAX_VALUE]){
 test(`finite stored amount ${value} is preserved without two-decimal rounding`,()=>{
  const p=project({accountBalance:value,accountEquity:value,margin:value,freeMargin:value});
  assert.equal(p.mt5Balance,value);assert.equal(p.mt5Equity,value);assert.equal(p.mt5UsedMargin,value);assert.equal(p.mt5FreeMargin,value);
 });
}
