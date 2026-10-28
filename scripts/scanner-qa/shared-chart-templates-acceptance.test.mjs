import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source=readFileSync(new URL('./shared-chart-templates-acceptance.js',import.meta.url),'utf8');
const helper=name=>{const body=source.match(new RegExp('  function '+name+'\\([^]*?\\n  \\}'))?.[0];assert.ok(body);return vm.runInNewContext('('+body+')');};
const series=helper('matchesSeries'),sma=helper('matchesSma');
const candles=Array.from({length:40},(_,i)=>({time:100+i*900,open:i+1,high:i+3,low:i+.5,close:i+2}));
const expected={source:'offline_fixture',canonical:candles};
const current=()=>({state:{symbol:'EURUSD',intervalSeconds:900,style:'bars',feed:{source:'offline_fixture'},barCount:40},data:{canonical:structuredClone(candles),display:structuredClone(candles)}});
const config=(period=10,mode=1)=>({scale:{mode},studies:[{config:{kind:'sma',period},lines:[candles.map((c,i)=>i<period-1?{time:c.time}:{time:c.time,value:candles.slice(i-period+1,i+1).reduce((s,b)=>s+b.close,0)/period})]}]});
test('template completion requires source/context plus full cached AND displayed data',()=>{
  assert.equal(series(current(),expected,'bars'),true);
  for(const collection of ['canonical','display'])for(const key of ['time','open','high','low','close']){const bad=current();bad.data[collection][10][key]+=1;assert.equal(series(bad,expected,'bars'),false);}
  for(const patch of [{symbol:'GBPUSD'},{intervalSeconds:300},{style:'candles'},{feed:{source:'other'}},{barCount:0}]){const bad=current();Object.assign(bad.state,patch);assert.equal(series(bad,expected,'bars'),false);}
  const empty=current();empty.state.barCount=0;empty.data={canonical:[],display:[]};assert.equal(series(empty,{...expected,canonical:[]},'bars'),false);
});
test('study completion rejects stale configuration, stale line values, missing points and wrong scale',()=>{
  assert.equal(sma(config(),candles,10,1),true);assert.equal(sma(config(37,3),candles,37,3),true);
  assert.equal(sma(config(37,3),candles,10,1),false);
  const stale=config(37,1);stale.studies[0].config.period=10;assert.equal(sma(stale,candles,10,1),false);
  const dropped=config();dropped.studies[0].lines[0]=dropped.studies[0].lines[0].slice(-1);assert.equal(sma(dropped,candles,10,1),false);
  const corrupt=config();corrupt.studies[0].lines[0][20].value+=.01;assert.equal(sma(corrupt,candles,10,1),false);
  const duplicate=config();duplicate.studies[0].lines[0][20]={...duplicate.studies[0].lines[0][21]};assert.equal(sma(duplicate,candles,10,1),false);
  const reordered=config();[reordered.studies[0].lines[0][20],reordered.studies[0].lines[0][21]]=[reordered.studies[0].lines[0][21],reordered.studies[0].lines[0][20]];assert.equal(sma(reordered,candles,10,1),false);
  assert.equal(sma(config(10,3),candles,10,1),false);
});
test('tooling forbids async truthy wait predicates and waits for native lock release',()=>{
  assert.doesNotMatch(source,/waitForFunction\(async\b/);
  assert.match(source,/await window\.__templateLockPromise/);
  assert.match(source,/typeof executedBuild==='string'&&executedBuild\.length>0/);
  assert.match(source,/requestPath==='\/api\/chart\/candles'/);
});
