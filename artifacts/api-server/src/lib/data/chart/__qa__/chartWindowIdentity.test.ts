import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
// Real chart normalization/projection/hashing; only external sources are doubled.
const now=Date.parse("2026-11-02T10:01:00.000Z");
const open=Math.floor(now/300_000)*300_000;
let bars=Array.from({length:60},(_,i)=>({time:new Date(open-(60-i)*300_000).toISOString(),open:100+i,high:102+i,low:99+i,close:101+i}));
mock.module("../../marketDataRouter.js",{namedExports:{classifySymbol:()=>"forex",routeCandles:async()=>({ok:true,symbol:"EURUSD",assetClass:"forex",candles:bars,primaryProvider:"mt5_broker",attempts:[],provenance:{providerId:"mt5_broker",source:"DERIVED",sourceId:"mt5_broker:EURUSD:M5",delayed:false},userMessage:null})}});
mock.module("../sessionProfile.js",{namedExports:{getSessionProfile:async()=>null,isSlotExpected:()=>true}});
mock.module("../../providers/derivProvider.js",{namedExports:{resolveDerivSymbol:()=>null,getDerivSymbolFeedStatus:()=>null}});
const {getChartCandles}=await import("../chartDataService.js");
const {foldFormingTick,__resetFormingBarStore}=await import("../formingBarComposer.js");
afterEach(()=>{mock.restoreAll();__resetFormingBarStore();});
test("real chart response distinguishes corrected history with unchanged source and closing timestamp",async()=>{
  mock.method(Date,"now",()=>now);
  const first=await getChartCandles("EURUSD","M5",60);
  assert.match(first.marketEvidence?.closedWindowIdentity??"",/^[a-f0-9]{64}$/);
  bars=bars.map((bar,i)=>i===4?{...bar,high:bar.high+0.2}:bar);
  const corrected=await getChartCandles("EURUSD","M5",60);
  assert.equal(first.marketEvidence!.lastClosedCandleAt,corrected.marketEvidence!.lastClosedCandleAt);
  assert.equal(first.marketEvidence!.sourceIdentity,corrected.marketEvidence!.sourceIdentity);
  assert.notEqual(first.marketEvidence!.closedWindowIdentity,corrected.marketEvidence!.closedWindowIdentity);
});
test("display forming tip and routine refetch preserve the same closed-window identity",async()=>{
  mock.method(Date,"now",()=>now);
  const first=await getChartCandles("EURUSD","M5",60);
  foldFormingTick("EURUSD",161,now,now,"mt5_broker");
  const display=await getChartCandles("EURUSD","M5",60,true);
  assert.equal(display.candles.at(-1)?.isForming,true);
  assert.equal(display.marketEvidence!.closedWindowIdentity,first.marketEvidence!.closedWindowIdentity);
  mock.method(Date,"now",()=>now+1000);
  const refreshed=await getChartCandles("EURUSD","M5",60);
  assert.notEqual(refreshed.candles[0]!.receivedAt,first.candles[0]!.receivedAt);
  assert.equal(refreshed.marketEvidence!.closedWindowIdentity,first.marketEvidence!.closedWindowIdentity);
});
