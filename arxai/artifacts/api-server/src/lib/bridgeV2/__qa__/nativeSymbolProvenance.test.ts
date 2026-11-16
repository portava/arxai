import {beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {bridgeV2} from '@workspace/domain';
const {tickPayloadSchema,candlePayloadSchema}=bridgeV2;
import {feedMarketDataStore} from '../ingest.js';
import {__resetMt5ProviderStore,readMt5Quote,readMt5Candles} from '../../data/providers/mt5Provider.js';
import {normalizeCandles} from '../../data/chart/candleNormalization.js';
import {routeCandles,routeQuote} from '../../data/marketDataRouter.js';
const bridge={bridgeConnectionId:15,userId:7};
const keys=['TWELVEDATA_API_KEY','POLYGON_API_KEY','FINNHUB_API_KEY','ALPHA_VANTAGE_API_KEY','NEWSAPI_API_KEY'];let saved:(string|undefined)[];
beforeEach(()=>{__resetMt5ProviderStore();saved=keys.map(k=>process.env[k]);keys.forEach(k=>delete process.env[k]);});
afterEach(()=>{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});});
function tick(native:string|undefined,delta:number){const now=Date.now()-100+delta;feedMarketDataStore({messageType:'TICK',payload:tickPayloadSchema.parse({symbol:'DXY',brokerSymbol:native,bid:101.5+delta/10000,ask:101.6+delta/10000,brokerTimeEpochMs:now}),freshnessVerdict:'FRESH',eaCreatedAtEpochMs:now,bridge});}
function candle(native:string|undefined,offset=0){const time=Math.floor(Date.now()/60000)*60000-60000-offset;feedMarketDataStore({messageType:'CANDLE',payload:candlePayloadSchema.parse({symbol:'DXY',brokerSymbol:native,timeframe:'M1',openTimeEpochMs:time,open:101,high:102,low:100,close:101.5,volume:20,isClosed:true}),freshnessVerdict:'FRESH',eaCreatedAtEpochMs:Date.now(),bridge});}
test('exact DXYUSD is preserved through schema, authenticated ingest, stores and routed provenance',async()=>{
 tick('DXYUSD',0);tick('DXYUSD',1);candle('DXYUSD');
 assert.equal(readMt5Quote('DXY',{bridgeConnectionId:15})?.quote.brokerSymbol,'DXYUSD');
 assert.equal(readMt5Quote('DXY',{bridgeConnectionId:15})?.tickTimeObserved,true);
 assert.equal(readMt5Candles('DXY','M1',200,{bridgeConnectionId:15}).candles[0]?.brokerSymbol,'DXYUSD');
 assert.equal((await routeCandles('DXY','M1',200)).provenance?.brokerSymbol,'DXYUSD');
 assert.equal((await routeQuote('DXY')).provenance?.brokerSymbol,'DXYUSD');
});
test('legacy missing native identity stays unknown; no canonical-name fabrication',async()=>{
 tick(undefined,0);tick(undefined,1);candle(undefined);assert.equal((await routeCandles('DXY','M1',200)).provenance?.brokerSymbol,null);assert.equal((await routeQuote('DXY')).provenance?.brokerSymbol,null);
});
test('changing native instrument cannot inherit prior first-sight tick bound',()=>{
 tick('DXYUSD',0);tick('DXYUSD',1);tick('USD_BASKET',2);assert.equal(readMt5Quote('DXY',{bridgeConnectionId:15})?.tickTimeObserved,false);
});
test('conflicting native instruments cannot form a single broker series',async()=>{
 tick('DXYUSD',0);candle('DXYUSD',60000);candle('OTHER_INDEX');const r=await routeCandles('DXY','M1',200);assert.equal(r.attempts[0]?.reason,'MT5_NATIVE_SYMBOL_CONFLICT');assert.notEqual(r.primaryProvider,'mt5_broker');
});
test('native metadata rejects controls, whitespace and oversized values',()=>{
 for(const brokerSymbol of [' DXYUSD','DXYUSD\n','x'.repeat(129)])assert.equal(tickPayloadSchema.safeParse({symbol:'DXY',brokerSymbol,bid:1,ask:2,brokerTimeEpochMs:Date.now()}).success,false);
});

test('chart normalization preserves the native identity of each surviving duplicate bar',()=>{
 const time=new Date(Date.now()-60000).toISOString();
 const raw=[{time,open:100,high:102,low:99,close:101,brokerSymbol:'OLD'}, {time,open:100,high:102,low:99,close:101,brokerSymbol:'DXYUSD'}];
 const r=normalizeCandles(raw,{symbol:'DXY',displaySymbol:'US Dollar Index',timeframe:'M1',source:'mt5_broker'});
 assert.equal(r.candles[0]?.brokerSymbol,'DXYUSD');assert.equal(r.candles[0]?.providerSymbol,'DXYUSD');
 const missing=normalizeCandles([{time,open:100,high:102,low:99,close:101}],{symbol:'DXY',displaySymbol:'US Dollar Index',timeframe:'M1',source:'mt5_broker'});
 assert.equal(missing.candles[0]?.brokerSymbol,null);assert.equal(missing.candles[0]?.providerSymbol,null);
});
