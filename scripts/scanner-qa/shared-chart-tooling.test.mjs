import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const setupSource=readFileSync(new URL('./shared-chart-setup.js',import.meta.url),'utf8');
const acceptanceSource=readFileSync(new URL('./shared-chart-acceptance.js',import.meta.url),'utf8');
const pollSource=acceptanceSource.match(/await page\.waitForFunction\((async\(\{symbol,timeframe,intervalSeconds\}\)=>\{[\s\S]*?)\n    \},\{symbol,timeframe,intervalSeconds\}/)?.[1]+'\n}';
assert.ok(pollSource.startsWith('async('),'Actual-series predicate must remain discoverable');
const expected=[{time:100,open:1,high:3,low:.5,close:2},{time:400,open:2,high:4,low:1,close:3}];
function probe({state={},canonical=expected,display=expected}={}){
  return vm.runInNewContext('('+pollSource+')', {window:{
    __readFixtureLog:async()=>({candleResponses:[{symbol:'EURUSD',timeframe:'M5',source:'offline_fixture',canonical:expected}]}),
    __arxChartQa:{snapshot:()=>({symbol:'EURUSD',intervalSeconds:300,style:'candles',feed:{source:'offline_fixture'},barCount:2,...state}),data:()=>({canonical,display})},
  }})({symbol:'EURUSD',timeframe:'M5',intervalSeconds:300});
}
test('source completion accepts the actual complete canonical and displayed OHLC arrays',async()=>assert.equal(await probe(),true));
test('updated label with old interval or source cannot complete',async()=>{
  assert.equal(await probe({state:{intervalSeconds:900}}),false);
  assert.equal(await probe({state:{feed:{source:'different'}}}),false);
});
test('same count and last bar cannot conceal an incorrect interior canonical bar',async()=>{
  const canonical=structuredClone(expected);canonical[0].open=9;
  assert.equal(await probe({canonical}),false);
});
test('canonical update without actual displayed series update cannot complete',async()=>{
  const display=structuredClone(expected);display[0].close=9;
  assert.equal(await probe({display}),false);
});

async function fixture(){
  let handler;const exposed={};
  const page={on(){},exposeFunction:async(name,fn)=>{exposed[name]=fn;},
    context:()=>({serviceWorkers:()=>[],routeWebSocket:async()=>{},route:async(_,fn)=>{handler=fn;}}),
    addInitScript:async()=>{},setViewportSize:async()=>{},goto:async()=>{},waitForFunction:async()=>{},
    getByTestId:()=>({waitFor:async()=>{}}),url:()=> 'http://127.0.0.1:4199/market-scanner',locator:()=>({count:async()=>2})};
  await vm.runInNewContext('('+setupSource+')',{URL,Date,setTimeout:fn=>{fn();}})(page);
  const call=async(url,method='GET')=>{let result;await handler({request:()=>({url:()=>url,method:()=>method}),abort:()=>{result={aborted:true};},continue:()=>{result={continued:true};},fulfill:response=>{result=response;}});return result;};
  return {call,log:exposed.__readFixtureLog};
}
test('fixture blocks external reads and mutations before any real request',async()=>{
  const f=await fixture();
  assert.equal((await f.call('https://example.com/api/chart/candles')).aborted,true);
  assert.equal((await f.call('http://127.0.0.1:4199/api/orders','POST')).status,503);
  assert.equal((await f.call('http://127.0.0.1:4199/non-api-action','POST')).status,503);
  assert.equal(f.log().blocked.length,3);
});
test('fixture allows local assets, refuses unmocked API reads and caps synthetic history',async()=>{
  const f=await fixture();
  assert.equal((await f.call('http://127.0.0.1:4199/assets/app.js')).continued,true);
  assert.equal((await f.call('http://127.0.0.1:4199/api/unknown')).status,503);
  const data=JSON.parse((await f.call('http://127.0.0.1:4199/api/chart/candles?symbol=GBPUSD&timeframe=M2&limit=5000')).body);
  assert.equal(data.candles.length,1000);
  assert.equal(Date.parse(data.candles[1].openTime)-Date.parse(data.candles[0].openTime),120000);
  assert.equal(data.aiUsable,false);assert.equal(data.feedStatus.isLive,false);
  assert.equal(f.log().candleResponses[0].canonical.length,1000);
});
