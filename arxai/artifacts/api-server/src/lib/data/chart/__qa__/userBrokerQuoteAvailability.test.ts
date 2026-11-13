// Exercise the integration seam with the real binding and price-alignment
// functions. No DB connection, broker request, or trade is made.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { computeBrokerPriceAlignment, hasMeasuredBrokerAlignment } from "../brokerPriceAlignment.js";

const now = Date.UTC(2026, 10, 13, 12);
const ownSeries = { providerId: "mt5_broker", subProviderId: null, userId: 70, bridgeConnectionId: 7,
  brokerSymbol: "EURUSD.native", environment: "unknown" as const };
const state = { assetClass: "forex", latestClosedCandle: { close: 1.1 } };
const freshQuote = () => ({ quote: { bid: 1.1, ask: 1.1002, timestamp: new Date(now - 1_000).toISOString(), brokerSymbol: "EURUSD.native" },
  userId: 70 as number | null, bridgeConnectionId: 7 as number | null, tickTimeObserved: true });
let series: typeof ownSeries | null = ownSeries;
let live: ReturnType<typeof freshQuote> | null = freshQuote();
let basis = "BID", lookupCount = 0, readCount = 0, dbFails = true;
let specRows: object[] = [];
mock.module("../chartIntelligence.js", { namedExports: {
  getCachedIntelligenceContext: () => ({ state, truthResult: { priceBasis: basis }, feedStatus: {}, seriesAttribution: series }),
  enrichStateWithBrokerAlignment: (s: object, _truth: unknown, _feed: unknown, inputs: Parameters<typeof computeBrokerPriceAlignment>[0]) =>
    ({ ...s, brokerAlignment: computeBrokerPriceAlignment(inputs) }),
} });
mock.module("../../providers/mt5Provider.js", { namedExports: {
  readMt5Quote: (_symbol: string, pin: {bridgeConnectionId:number}) => {
    readCount++; assert.equal(pin.bridgeConnectionId,7); return live;
  },
} });
const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, db: {
  select: () => { lookupCount++; return {from:()=>({where:()=>({limit:async()=>{
    if(dbFails) throw new Error("fixture optional snapshot lookup unavailable");
    return specRows;
  }})})}; },
} } });
const { enrichStateWithUserBrokerQuote } = await import("../userBrokerAlignment.js");
beforeEach(() => {
  mock.timers.enable({apis:["Date"],now});
  series=ownSeries; live=freshQuote(); basis="BID"; lookupCount=0; readCount=0; dbFails=true; specRows=[];
});
afterEach(() => mock.timers.reset());
const run = () => enrichStateWithUserBrokerQuote(state as any, {userId:70,symbol:"EURUSD",timeframe:"M15",limit:200});

test("a fresh BOUND own-bridge quote works without touching a failing optional DB", async () => {
  const a=(await run()).brokerAlignment;
  assert.equal(lookupCount,0); assert.equal(readCount,1);
  assert.equal(a.quoteBinding?.status,"BOUND"); assert.equal(a.quoteBinding?.quoteSource,"mt5_live_quote");
  assert.equal(a.aligned,true); assert.equal(hasMeasuredBrokerAlignment(a),true);
  assert.equal(a.chartPriceBasis,"BID"); assert.equal(a.chartPrice,1.1);
});
test("a valid same-owner snapshot can replace a stale live candidate", async () => {
  live!.quote.timestamp=new Date(now-60_000).toISOString(); dbFails=false;
  specRows=[{userId:70,bridgeConnectionId:7,accountType:null,brokerSymbol:"EURUSD.native",bid:1.1,ask:1.1002,spreadPoints:2,lastTickTime:new Date(now-500)}];
  const a=(await run()).brokerAlignment;
  assert.equal(lookupCount,1); assert.equal(a.quoteBinding?.status,"BOUND");
  assert.equal(a.quoteBinding?.quoteSource,"mt5_symbol_snapshot"); assert.equal(a.aligned,true);
});
for (const [name, mutate, reason] of [
  ["stale tick", () => {live!.quote.timestamp=new Date(now-60_000).toISOString();}, "QUOTE_STALE"],
  ["mismatched bridge", () => {live!.bridgeConnectionId=8;}, "BRIDGE_MISMATCH"],
  ["mismatched owner", () => {live!.userId=71;}, "OWNER_MISMATCH"],
  ["unattributed quote", () => {live!.bridgeConnectionId=null;live!.userId=null;}, "QUOTE_UNATTRIBUTED"],
  ["unobserved tick time", () => {live!.tickTimeObserved=false;}, "QUOTE_TIME_UNKNOWN"],
  ["mismatched native symbol", () => {live!.quote.brokerSymbol="EURUSD.other";}, "BROKER_SYMBOL_MISMATCH"],
] as const) test(`optional DB failure preserves ${name} reason without granting alignment`,async()=>{
  mutate(); const a=(await run()).brokerAlignment;
  assert.equal(lookupCount,1); assert.notEqual(a.quoteBinding?.status,"BOUND");
  assert.ok(a.quoteBinding?.reasons.includes(reason));
  assert.equal(a.aligned,false); assert.equal(hasMeasuredBrokerAlignment(a),false);
});
test("absent quote and unavailable snapshot leave the state unenriched",async()=>{
  live=null; assert.equal(await run(),state); assert.equal(lookupCount,1);
});
test("unattributed or another owner's series never reads a live quote",async()=>{
  series=null; assert.equal(await run(),state); assert.equal(readCount,0);
  series={...ownSeries,userId:71}; assert.equal(await run(),state); assert.equal(readCount,0);
});
test("BOUND identity does not invent a missing candle price basis",async()=>{
  basis="UNKNOWN"; const a=(await run()).brokerAlignment;
  assert.equal(lookupCount,0); assert.equal(a.quoteBinding?.status,"BOUND");
  assert.equal(a.chartPriceBasis,"UNKNOWN"); assert.equal(a.aligned,false);
  assert.equal(hasMeasuredBrokerAlignment(a),false);
});
