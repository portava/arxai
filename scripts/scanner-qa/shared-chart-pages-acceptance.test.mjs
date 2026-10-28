import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {isOfflineChartPagePath,SHARED_CHART_PAGE_PATHS} from './shared-chart-fixture/routes.mjs';

const source=readFileSync(new URL('./shared-chart-pages-acceptance.js',import.meta.url),'utf8');
function helper(name) {
  const body=source.match(new RegExp('  (?:async )?function '+name+'\\([^]*?\\n  \\}'))?.[0];
  assert.ok(body,'Actual acceptance helper: '+name);return body;
}
const completed=vm.runInNewContext('('+helper('completedSeries')+')');
const classify=vm.runInNewContext('('+helper('classifyWrite')+')');
const expected={symbol:'GBPUSD',timeframe:'M5',source:'offline_fixture',canonical:[
  {time:100,open:1,high:3,low:.5,close:2},{time:400,open:2,high:4,low:1,close:3},
]};
const context={symbol:'GBPUSD',intervalSeconds:300};
const current=()=>({state:{symbol:'GBPUSD',intervalSeconds:300,style:'candles',feed:{source:'offline_fixture'},barCount:2},
  data:{canonical:structuredClone(expected.canonical),display:structuredClone(expected.canonical)}});

test('static server admits exactly the four extra chart routes, not API, nested or arbitrary pages',()=>{
  assert.deepEqual(SHARED_CHART_PAGE_PATHS,['/live-chart','/live-manual','/live-ai-assist','/live-ai-auto-test']);
  for(const path of ['/', '/market-scanner',...SHARED_CHART_PAGE_PATHS])assert.equal(isOfflineChartPagePath(path),true,path);
  for(const path of ['/api/live-chart','/live-chart/execute','/live-chart/','/orders','/admin','/LIVE-CHART','//live-chart','/live-chart?execute=true',null,undefined])assert.equal(isOfflineChartPagePath(path),false,String(path));
  assert.throws(()=>SHARED_CHART_PAGE_PATHS.push('/other'));
});
test('server keeps API and write rejection ahead of the expanded static route map',()=>{
  const server=readFileSync(new URL('./shared-chart-fixture/build.mjs',import.meta.url),'utf8');
  assert.ok(server.indexOf("if(req.method!=='GET' || pathname.startsWith('/api/'))")<server.indexOf('isOfflineChartPagePath(pathname)'));
  assert.match(server,/relative in info\.hashes/);
});
test('after-frame series authority includes full canonical and actual displayed OHLC',()=>{
  assert.equal(completed(current(),expected,context),true);
  for(const collection of ['canonical','display'])for(const field of ['time','open','high','low','close']){
    const actual=current();actual.data[collection][0][field]+=1;
    assert.equal(completed(actual,expected,context),false,collection+'.'+field);
  }
});
test('context changes and an empty canvas never pass with matching arrays',()=>{
  for(const patch of [{symbol:'EURUSD'},{intervalSeconds:900},{style:'heikinAshi'},{feed:{source:'other'}},{barCount:0}]){
    const actual=current();Object.assign(actual.state,patch);assert.equal(completed(actual,expected,context),false);
  }
  const actual=current();actual.state.barCount=0;actual.data={canonical:[],display:[]};
  assert.equal(completed(actual,{...expected,canonical:[]},context),false);
});
test('new-page response acquisition rejects a matching response from the preceding route',async()=>{
  let now=0,reads=0;const wait=vm.runInNewContext('('+helper('expectedResponse')+')',{Date:{now:()=>now}});
  const fresh={...expected,source:'fresh'};
  const page={evaluate:async()=>({candleResponses:++reads===3?[expected,fresh]:[expected]}),waitForTimeout:async ms=>{now+=ms;}};
  assert.equal(await wait(page,'GBPUSD','M5',1,100),fresh);assert.equal(reads,3);
});
test('a previous-page response or wrong interval times out instead of reusing cached authority',async()=>{
  let now=0;const wait=vm.runInNewContext('('+helper('expectedResponse')+')',{Date:{now:()=>now}});
  const page={evaluate:async()=>({candleResponses:[expected,{...expected,timeframe:'H1'}]}),waitForTimeout:async ms=>{now+=ms;}};
  await assert.rejects(wait(page,'GBPUSD','M5',1,50),/No current-page candle response/);assert.equal(now,50);
});
test('actual browser predicate is synchronous and cannot pass on Promise truthiness',()=>{
  const body=source.match(/await page\.waitForFunction\((\(\{symbol,intervalSeconds,expected\}\)=>\{[^]*?)\n    \},\{symbol,intervalSeconds,expected\}/)?.[1]+'\n}';
  assert.ok(body.startsWith('({'));
  let actual=current();
  const predicate=vm.runInNewContext('('+body+')',{window:{__arxChartQa:{snapshot:()=>actual.state,data:()=>actual.data}}});
  assert.equal(predicate({...context,expected}),true);
  actual.state.barCount=0;const pending=predicate({...context,expected});assert.equal(typeof pending,'boolean');assert.equal(Boolean(pending),false);
  actual=current();actual.data.display[0].close=99;assert.equal(predicate({...context,expected}),false);
  assert.doesNotMatch(source,/waitForFunction\(async\b/);
});
test('tester intent submission is forbidden, just like live execution and unknown writes',()=>{
  for(const path of ['/api/live-intent/submit','/api/trades/instant/execute','/api/me/live/commands','/api/me/assistant/instant-trade-command'])assert.equal(classify({method:'POST',path}),'trade',path);
  assert.equal(classify({method:'POST',path:'/api/new-action'}),'unclassified');
  assert.equal(classify({method:'POST',path:'/api/live-intent/submit/extra'}),'trade');
});
test('only exact established nontrading background POSTs get that reporting category; still blocked by setup',()=>{
  for(const path of ['/api/me/activity-ping','/api/me/chart/ai-alerts/scan']){
    assert.equal(classify({method:'POST',path}),'background');
    assert.equal(classify({method:'DELETE',path}),'unclassified');
  }
  assert.equal(classify({method:'POST',path:'/api/me/scalp/focus'}),'analysis');
  assert.equal(classify({method:'POST',path:'/api/me/scalp/focus/execute'}),'unclassified');
  assert.equal(classify({method:'GET',path:'/api/market-scanner/selected-market'}),'read');
});
