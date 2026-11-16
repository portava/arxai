import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedFxPair, stockStyleSymbol } from '../providerSymbolMapping.js';
import { alphaFxPair } from '../alphaVantageFx.js';
import { getMarketProvider, _resetMarketProviderForTests } from '../marketProvider.js';
const keys=['TWELVEDATA_API_KEY','POLYGON_API_KEY','FINNHUB_API_KEY','ALPHA_VANTAGE_API_KEY','NEWSAPI_API_KEY','ARX_GDELT_ENABLED'];
const originalFetch=globalThis.fetch;let saved:(string|undefined)[];
beforeEach(()=>{saved=keys.map(k=>process.env[k]);keys.forEach(k=>delete process.env[k]);_resetMarketProviderForTests();});
afterEach(()=>{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});globalThis.fetch=originalFetch;_resetMarketProviderForTests();});
test('approved crosses resolve as currencies; arbitrary stocks, baskets and indices do not',()=>{
 for(const s of ['CADJPY','CHFJPY','EURGBP','GBPCAD']){assert.deepEqual(approvedFxPair(s),{base:s.slice(0,3),quote:s.slice(3)});assert.deepEqual(alphaFxPair(s),{from:s.slice(0,3),to:s.slice(3)});assert.equal(stockStyleSymbol(s),null);}
 for(const s of ['DXY','ABCDEF','BTCUSD','SPX500'])assert.equal(approvedFxPair(s),null);
 assert.equal(approvedFxPair('XAUUSD'),null);assert.deepEqual(approvedFxPair('XAUUSD',true),{base:'XAU',quote:'USD'});assert.equal(stockStyleSymbol('DXY'),null);assert.equal(stockStyleSymbol('AAPL'),'AAPL');
});
for(const [key,host,path,expected] of [
 ['TWELVEDATA_API_KEY','api.twelvedata.com','/time_series','CAD/JPY'],
 ['POLYGON_API_KEY','api.polygon.io','/v2/aggs/ticker/C%3ACADJPY/range/1/minute',null],
 ['FINNHUB_API_KEY','finnhub.io','/api/v1/forex/candle','OANDA:CAD_JPY'],
 ['ALPHA_VANTAGE_API_KEY','www.alphavantage.co','/query',null],
] as const){test(`${key} sends CADJPY to currency history, never stock history`,async()=>{
 process.env[key]='fixture';const calls:URL[]=[];globalThis.fetch=async input=>{calls.push(new URL(String(input)));return Response.json({});};await getMarketProvider().getCandles('CADJPY','M1',30);assert.equal(calls.length,1);const u=calls[0]!;assert.equal(u.hostname,host);assert.ok(u.pathname.startsWith(path));if(expected)assert.equal(u.searchParams.get('symbol'),expected);if(key==='ALPHA_VANTAGE_API_KEY'){assert.equal(u.searchParams.get('function'),'FX_INTRADAY');assert.equal(u.searchParams.get('from_symbol'),'CAD');assert.equal(u.searchParams.get('to_symbol'),'JPY');}
});}
test('DXY never calls a stock snapshot or falls back to a Twelve Data stock symbol',async()=>{
 process.env.TWELVEDATA_API_KEY='fixture';process.env.POLYGON_API_KEY='fixture';let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};const q=await getMarketProvider().getLiveQuote('DXY');assert.equal(calls,0);assert.equal(q.price,null);
});
for(const mode of ['empty','stale','error'] as const)test(`hybrid retains Twelve Data quote fallback when Finnhub is ${mode}`,async()=>{
 process.env.TWELVEDATA_API_KEY='fixture';process.env.FINNHUB_API_KEY='fixture';const calls:URL[]=[];const now=Math.floor(Date.now()/1000);
 globalThis.fetch=async input=>{const u=new URL(String(input));calls.push(u);if(u.hostname==='finnhub.io'){if(mode==='error')return Response.json({}, {status:403});return Response.json({c:mode==='empty'?0:110,t:now-86400});}return Response.json({symbol:'CAD/JPY',close:'111.123',timestamp:now});};
 const q=await getMarketProvider().getLiveQuote('CADJPY');assert.equal(q.source,'twelve_data');assert.equal(q.price,111.123);assert.equal(q.stale,false);assert.equal(calls.at(-1)?.searchParams.get('symbol'),'CAD/JPY');assert.equal(q.bid,null);assert.equal(q.ask,null);
});
