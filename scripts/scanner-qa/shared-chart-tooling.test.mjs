import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const setupSource=readFileSync(new URL('./shared-chart-setup.js',import.meta.url),'utf8');
const acceptanceSource=readFileSync(new URL('./shared-chart-acceptance.js',import.meta.url),'utf8');
const helper=name=>{
  const source=acceptanceSource.match(new RegExp('  function '+name+'\\([^]*?\\n  \\}'))?.[0];
  assert.ok(source,name+' must remain discoverable');return vm.runInNewContext('('+source+')');
};
const matchesExecutedBuild=helper('matchesExecutedBuild');
const matchesCompletedSeries=helper('matchesCompletedSeries');
test('newly fetched metadata cannot validate an older already-executed fixture bundle',()=>{
  assert.equal(matchesExecutedBuild('old-build',{buildId:'new-build'}),false);
  assert.equal(matchesExecutedBuild(undefined,{buildId:'new-build'}),false);
  assert.equal(matchesExecutedBuild('new-build',{buildId:'new-build'}),true);
});
test('runtime build identity is immutable after the fixture entry executes',()=>{
  const entry=readFileSync(new URL('./shared-chart-fixture/main.ts',import.meta.url),'utf8');
  const definition=entry.match(/Object\.defineProperty\(window, "__arxScannerQaBuildId", \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(definition);const window={};
  vm.runInNewContext(definition,{window,__ARX_SCANNER_QA_BUILD_ID__:'built-id'});
  assert.equal(window.__arxScannerQaBuildId,'built-id');
  assert.equal(Reflect.set(window,'__arxScannerQaBuildId','newer-id'),false);
  assert.equal(Reflect.deleteProperty(window,'__arxScannerQaBuildId'),false);
});
const classificationSource=acceptanceSource.match(/  function classifyWrite\(request\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(classificationSource,'Write classifier must remain discoverable');
const classifyWrite=vm.runInNewContext('('+classificationSource+')');
test('background classification requires exact known routes and POST method',()=>{
  for(const path of ['/api/me/activity-ping','/api/me/chart/ai-alerts/scan']){
    assert.equal(classifyWrite({path,method:'POST'}),'background');
    assert.equal(classifyWrite({path,method:'DELETE'}),'unclassified');
  }
  assert.equal(classifyWrite({path:'/api/me/chart/ai-alerts/scan/execute',method:'POST'}),'unclassified');
});
test('trade writes are distinct from blocked annotations and ordinary read requests',()=>{
  for(const path of ['/api/trades/instant/execute','/api/trades/instant/close','/api/me/pending-order-draft/1',
    '/api/me/live/commands/confirm','/api/me/paper/orders','/api/positions/1/close-confirmation',
    '/api/execution-confirmations/1/confirm','/api/me/assistant/instant-trade-command'])assert.equal(classifyWrite({path,method:'POST'}),'trade',path);
  assert.equal(classifyWrite({path:'/api/me/chart-annotations',method:'POST'}),'unclassified');
  assert.equal(classifyWrite({path:'/api/me/live/positions',method:'GET'}),'read');
});
const pollSource=acceptanceSource.match(/await page\.waitForFunction\((async\(\{symbol,timeframe,intervalSeconds\}\)=>\{[\s\S]*?)\n    \},\{symbol,timeframe,intervalSeconds\}/)?.[1]+'\n}';
assert.ok(pollSource.startsWith('async('),'Actual-series predicate must remain discoverable');
const expected=[{time:100,open:1,high:3,low:.5,close:2},{time:400,open:2,high:4,low:1,close:3}];
test('post-frame completion rejects displayed-only corruption after canonical success',()=>{
  const current={state:{symbol:'EURUSD',intervalSeconds:300,style:'candles',feed:{source:'offline_fixture'},barCount:2},data:{canonical:structuredClone(expected),display:structuredClone(expected)}};
  const authority={source:'offline_fixture',canonical:expected};const context={symbol:'EURUSD',intervalSeconds:300};
  assert.equal(matchesCompletedSeries(current,authority,context),true);
  current.data.display[0].close=99;
  assert.equal(matchesCompletedSeries(current,authority,context),false);
});
test('post-frame completion rejects changed context even when both arrays match',()=>{
  const correct={symbol:'EURUSD',intervalSeconds:300,style:'candles',feed:{source:'offline_fixture'},barCount:2};
  const authority={source:'offline_fixture',canonical:expected},context={symbol:'EURUSD',intervalSeconds:300};
  for(const mutation of [{symbol:'GBPUSD'},{intervalSeconds:900},{style:'line'},{feed:{source:'other'}},{barCount:1}]){
    assert.equal(matchesCompletedSeries({state:{...correct,...mutation},data:{canonical:expected,display:expected}},authority,context),false,JSON.stringify(mutation));
  }
});
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
  assert.equal(f.log().blocked.filter(x=>x.kind==='mutation').every(x=>x.status===503),true);
});
test('known background writes are blocked too, never fulfilled as valid side effects',async()=>{
  const f=await fixture();
  for(const path of ['/api/me/activity-ping','/api/me/chart/ai-alerts/scan'])assert.equal((await f.call('http://127.0.0.1:4199'+path,'POST')).status,503);
  assert.equal(f.log().blocked.length,2);
  assert.equal(f.log().blocked.every(x=>x.status===503),true);
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
