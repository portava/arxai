import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createStockProfileFixture} from './stock-profile-fixture.mjs';
import {prepareStockProfileAcceptance,ORIGINAL_STOCK_SHA256} from './prepare-stock-profile-acceptance.mjs';
import {acceptStockVolumeProfile,inspectStockProfileNetwork} from './shared-chart-stock-profile-acceptance.mjs';
const bytes=await readFile(new URL('./fixtures/stock-normalized-20261101.json',import.meta.url));
const stock=JSON.parse(bytes),setupSource=await readFile(new URL('./shared-chart-setup.js',import.meta.url),'utf8');

async function hookFixture(){const exposed={};const hooks=createStockProfileFixture(stock);await hooks.install({exposeFunction:async(name,fn)=>{exposed[name]=fn;}});return {hooks,exposed};}
test('checked-in original response retains exact provenance and session gap flags',async()=>{
 assert.equal(createHash('sha256').update(bytes).digest('hex'),ORIGINAL_STOCK_SHA256);
 const {hooks}=await hookFixture();const result=hooks.candleResponse({symbol:'AAPL',timeframe:'M15'});
 assert.deepEqual(result,stock.data);assert.notEqual(result,stock.data);
 assert.deepEqual(result.candles.flatMap((row,i)=>row.qualityFlags.includes('STALE_FROM_PREV_TF')?[i]:[]),[18,44,70,96,122,148,174]);
 assert.equal(result.marketEvidence,null);assert.equal(result.feedStatus.isLive,false);assert.equal(result.aiUsable,false);
});
test('variant probes mutate copies and retain original data when restored',async()=>{
 const {hooks,exposed}=await hookFixture(),get=()=>hooks.candleResponse({symbol:'AAPL',timeframe:'M15'});
 exposed.__fixtureSetVariant('quantity');assert.equal(get().candles[100].volumeEvidence.quantity,stock.data.candles[100].volumeEvidence.quantity*2);
 exposed.__fixtureSetVariant('withdrawn');assert.equal(get().candles[100].volumeEvidence.kind,'unavailable');
 exposed.__fixtureSetVariant('series');assert.ok(get().candles.every(c=>c.volumeEvidence.seriesIdentity==='b'.repeat(64)));
 exposed.__fixtureSetVariant('clock');assert.ok(get().candles.every(c=>!c.timeBasisEvidence));
 exposed.__fixtureSetVariant('finality');assert.equal(get().candles[100].isFinal,false);assert.equal(get().candles[100].isForming,false);
 exposed.__fixtureSetVariant('forming');assert.equal(get().candles.at(-1).isFinal,false);assert.equal(get().candles[100].isFinal,true);
 exposed.__fixtureSetVariant('mismatch');assert.equal(get().symbol,'MSFT');
 exposed.__fixtureSetVariant('original');assert.deepEqual(get(),stock.data);assert.deepEqual(JSON.parse(bytes),stock);
 assert.throws(()=>exposed.__fixtureSetVariant('live'),/Unknown QA/);
});
test('stock fixture does not relabel original bars under another timeframe',async()=>{
 const {hooks}=await hookFixture();const result=hooks.candleResponse({symbol:'AAPL',timeframe:'H1'});
 assert.equal(result.quality,'unavailable');assert.deepEqual(result.candles,[]);assert.equal(result.marketEvidence,null);
});
test('constructed primary keeps absent traded-volume and original-clock authority',async()=>{
 const {hooks}=await hookFixture();const fallback={symbol:'EURUSD',timeframe:'M15',quality:'invalid',feedStatus:{isLive:false,quality:'invalid'},candles:Array.from({length:8},(_,i)=>({time:i,open:1,close:1,source:'mt5_broker',qualityFlags:['MOCK_DATA']}))};
 const result=hooks.candleResponse({symbol:'EURUSD',timeframe:'M15',fallback});
 assert.equal(result.candles[0].volumeEvidence.kind,'unavailable');assert.equal(result.candles[1].volumeEvidence.kind,'tick_count');assert.ok(result.candles.every(c=>!c.timeBasisEvidence));assert.equal(result.feedStatus.isLive,false);assert.deepEqual(fallback.candles[0].qualityFlags,['MOCK_DATA']);
});
async function boundary(hooks={}){
 const exposed={},routes=[];
 const locator={waitFor:async()=>{}};
 const context={serviceWorkers:()=>[],routeWebSocket:async()=>{},route:async(_pattern,fn)=>routes.push(fn)};
 const page={context:()=>context,exposeFunction:async(name,fn)=>{exposed[name]=fn;},on(){},addInitScript:async()=>{},setViewportSize:async()=>{},goto:async()=>{},getByTestId:()=>locator,waitForFunction:async()=>{},url:()=> 'http://127.0.0.1:4199/market-scanner',locator:()=>({count:async()=>1})};
 const setup=vm.runInNewContext('('+setupSource+')',{SCANNER_QA_HOOKS:hooks,URL,Date,structuredClone,setTimeout:fn=>fn()});await setup(page);
 return {exposed,route:routes[0]};
}
function request(url,method='GET'){return {url:()=>url,method:()=>method};}
test('hooks cannot bypass external-origin or non-GET network blocks',async()=>{
 let overrides=0;const {route,exposed}=await boundary({readResponse(){overrides++;return {fake:true};}});
 let externalAborted=false;await route({request:()=>request('https://example.invalid/api/me'),abort:()=>{externalAborted=true;}});assert.equal(externalAborted,true);assert.equal(overrides,0);
 let body;await route({request:()=>request('http://127.0.0.1:4199/api/orders','POST'),fulfill:value=>{body=value;}});assert.equal(body.status,503);assert.equal(overrides,0);
 const log=exposed.__readFixtureLog();assert.equal(log.blocked.length,2);assert.equal(log.requests[0].status,503);
});
test('completed response marker appears only after fulfill resolves, retaining cancelled requests',async()=>{
 const {route,exposed}=await boundary();let release,started;
 const arrived=new Promise(resolve=>{started=resolve;});const pending=route({request:()=>request('http://127.0.0.1:4199/api/chart/candles?symbol=EURUSD&timeframe=M15&limit=300'),fulfill:()=>{started();return new Promise(resolve=>{release=resolve;});}});
 await arrived;let log=exposed.__readFixtureLog();assert.equal(log.candleResponses[0].requestQuery,'?symbol=EURUSD&timeframe=M15&limit=300');assert.equal(log.candleResponses[0].requestStarted,log.requests[0].started);assert.equal(log.requests[0].fulfilledAt,undefined);
 release();await pending;assert.equal(typeof log.requests[0].fulfilledAt,'number');
 await route({request:()=>request('http://127.0.0.1:4199/api/chart/candles?symbol=EURUSD&timeframe=M15&limit=300'),fulfill:()=>Promise.reject(Error('cancelled'))});log=exposed.__readFixtureLog();assert.equal(log.requests[1].cancelled,true);assert.equal(log.requests[1].fulfilledAt,undefined);
});
test('portable composer reuses shared boundary and keeps all old failures separate',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'arx-profile-tooling-'));
 try{for(const journey of ['desktop','mobile']){const outputDirectory=path.join(parent,journey),receipt=await prepareStockProfileAcceptance({outputDirectory,journey});const source=await readFile(receipt.filename,'utf8');new vm.Script('('+source+')');assert.ok(source.includes(setupSource.trim()));assert.ok(source.includes('q.fulfilledAt!=null&&!q.cancelled'));assert.ok(source.includes("get('limit')==='300'"));assert.ok(source.includes('dataRevision>previous'));assert.ok(!source.includes('/Users/areyouok/'));assert.equal(receipt.fixtureSha256,ORIGINAL_STOCK_SHA256);await assert.rejects(prepareStockProfileAcceptance({outputDirectory,journey}),/EEXIST/);}
  await assert.rejects(prepareStockProfileAcceptance({outputDirectory:path.join(parent,'external'),origin:'https://example.invalid'}),/loopback/);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('strict shared network acceptance permits only exactly known blocked POSTs',()=>{
 const paths=['/api/me/activity-ping','/api/me/chart/ai-alerts/scan','/api/me/scalp/focus'];
 const log={errors:[],requests:[{method:'GET',path:'/api/unavailable-reader',status:503},...paths.map(path=>({method:'POST',path,status:503}))],blocked:paths.map(path=>({kind:'mutation',method:'POST',path,status:503})),unknown:[{path:'/api/unavailable-reader'}]};
 assert.equal(inspectStockProfileNetwork(log).pass,true);assert.equal(log.unknown.length,1);
 for(const mutation of [
  value=>value.blocked.push({kind:'websocket',url:'ws://127.0.0.1:4199'}),
  value=>value.blocked.push({kind:'external',url:'https://example.invalid'}),
  value=>value.blocked.push({kind:'mutation',method:'POST',path:'/api/unknown-write',status:503}),
  value=>value.requests.push({method:'POST',path:'/api/unknown-write',status:503}),
  value=>value.requests[1].method='DELETE',
  value=>value.requests[1].status=200,
  value=>value.blocked[0].status=200,
  value=>value.blocked.pop(),
  value=>value.errors.push('Unhandled browser error'),
 ]){const changed=structuredClone(log);mutation(changed);assert.equal(inspectStockProfileNetwork(changed).pass,false);}
 assert.equal(inspectStockProfileNetwork(null).pass,false);
});

test('both journeys reject diagnostic/profiling manifests and preserve evidence when diagnostics also fail',async()=>{
 for(const journey of ['desktop','mobile'])for(const invalid of [{diagnosticOnly:true},{reactProfiling:true},{productionRuntimeChecked:false}]){
  let calls=0;const locator={first(){return this;},getByTestId(){return this;}};
  const page={getByTestId:()=>locator,evaluate:async()=>{calls++;if(calls===1)return {buildId:'frozen',sourceUnchanged:true,source:{status:''},productionRuntimeChecked:true,...invalid};if(calls===2)return 'frozen';throw Error('page disconnected while collecting evidence');}};
  const result=await acceptStockVolumeProfile(page,{stock,artifactDirectory:'/offline-output',journey});
  assert.match(result.error,/Clean source and production runtime/);assert.equal(result.checks.length,2);assert.equal(result.checks[0].pass,true);assert.equal(result.checks[1].pass,false);assert.equal(result.collectionErrors.length,2);assert.ok(result.collectionErrors.every(e=>e.error.includes('page disconnected')));
 }
});
