import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveAccountSnapshot, normalizePositionPL, type LivePositionRow } from '../liveAccountSnapshot.js';
const now=1700000000000;
const bands={liveMs:5000,freshMs:30000,delayedMs:120000};
const row=(extra:Partial<LivePositionRow>={}):LivePositionRow=>({id:1,brokerTicket:'1',symbol:'EURUSD',side:'buy',volume:1,entryPrice:1,currentPrice:1.1,floatingPl:10,stopLoss:null,takeProfit:null,closedAt:null,reconcileState:null,lastSyncedAtMs:now-1000,...extra});
const snapshot=(rows:LivePositionRow[],balance=1000,equity=1110)=>buildLiveAccountSnapshot({userId:7,accountMode:'LIVE_SHARED',rows,account:{balance,equity,syncedAtMs:now-1000},now});

test('credit-like equity difference cannot replace native account profit or establish a discrepancy',()=>{
 const s=snapshot([row()]); assert.equal(s.positions[0]?.unrealizedPL,10); assert.equal(s.openPL,10);
 assert.equal(s.reconciliation?.discrepancy,null); assert.equal(s.reconciliation?.exceedsThreshold,false);
 assert.equal((s.reconciliation as any)?.status,'unverified');
 assert.equal(s.reconciliation?.equityMinusBalancePL,110);
});
test('equal arithmetic is not a matched native account report',()=>{
 const s=snapshot([row()],1000,1010);
 assert.equal((s.reconciliation as any)?.status,'unverified'); assert.equal(s.reconciliation?.discrepancy,null);
 assert.equal((s.reconciliation as any)?.positionPnlScope,'supplied_rows');
});
test('a known subtotal cannot masquerade as the total when a position has unknown P/L',()=>{
 const s=snapshot([row(),row({id:2,floatingPl:null})]);
 assert.equal(s.openPL,null); assert.equal(s.reconciliation?.snapshotSummedPL,10);
 assert.equal((s.reconciliation as any)?.positionPnlComplete,false);
 assert.equal(s.positions[0]?.unrealizedPL,10);
});
test('genuine zero and negative per-position broker values remain exact',()=>{
 const s=snapshot([row({floatingPl:0}),row({id:2,floatingPl:-12.345})]);
 assert.deepEqual(s.positions.map(p=>p.unrealizedPL),[0,-12.345]); assert.equal(s.openPL,-12.345);
 assert.equal((s.reconciliation as any)?.positionPnlComplete,true);
});
for(const value of [NaN,Infinity,-Infinity]) test(`nonfinite broker P/L ${value} cannot enter totals`,()=>{
 const s=snapshot([row({floatingPl:value})]); assert.equal(s.openPL,null); assert.equal(s.positions[0]?.brokerPL,null);
});
for(const timestamp of [now+1,NaN,Infinity,0,null]) test(`unproven timestamp ${timestamp} cannot promote broker P/L`,()=>{
 const p=normalizePositionPL(row({lastSyncedAtMs:timestamp}),undefined,now,bands);
 assert.equal(p.unrealizedPL,null); assert.equal(p.freshness,'unavailable');
});
test('a valid stale observation retains its real value with stale status',()=>{
 const p=normalizePositionPL(row({lastSyncedAtMs:now-200000}),undefined,now,bands);
 assert.equal(p.unrealizedPL,10); assert.equal(p.freshness,'stale'); assert.equal(p.plIsEstimate,true);
});
test('sum overflow is unknown rather than an infinite monetary total',()=>{
 const s=snapshot([row({floatingPl:Number.MAX_VALUE}),row({id:2,floatingPl:Number.MAX_VALUE})]);
 assert.equal(s.openPL,null); assert.equal(s.reconciliation?.snapshotSummedPL,null);
 assert.equal((s.reconciliation as any)?.positionPnlComplete,false);
});
test('a nonfinite quote estimate cannot become known profit',()=>{
 const p=normalizePositionPL(row({floatingPl:null}),{bid:Infinity,tsMs:now-100},now,bands);
 assert.equal(p.unrealizedPL,null); assert.equal(p.plSource,'unavailable');
});
test('an empty supplied row set does not establish a whole-account zero profit',()=>{
 const s=snapshot([]); assert.equal(s.openPL,null); assert.equal((s.reconciliation as any)?.positionPnlComplete,false);
 assert.equal((s.reconciliation as any)?.status,'unverified');
});
