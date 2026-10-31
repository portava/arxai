import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source=readFileSync(new URL('./shared-chart-idle-observer.js',import.meta.url),'utf8');
function helper(name) {
  const body=source.match(new RegExp('    function '+name+'\\([^]*?\\n    \\}'))?.[0];
  assert.ok(body,name+' actual observer helper');return vm.runInNewContext('('+body+')',{structuredClone});
}
const bindingErrors=helper('bindingErrors'),wrapMethod=helper('wrapMethod');
function binding() {
  const series={},element={},chart={},engine={},analysis={},primitive={};
  return{element,engine,analysis,primitive,surface:{container:element,series,chart},attachment:{series}};
}
const context=()=>({adapterId:1,containerId:2,chartId:3,seriesId:4,symbol:'EURUSD',intervalSeconds:900,style:'candles',barCount:200,canvasIds:[5,6],feed:{source:'offline_fixture',livePriceAffordance:false}});
test('binding accepts stable object identity and context, but not replacement hidden behind matching data',()=>{
  const captured=binding(),before=context();
  assert.equal(bindingErrors(captured,{...captured,surface:{...captured.surface}},before,context()).length,0);
  for(const key of ['element','engine','analysis','primitive','attachment']) {
    const current={...captured,[key]:{}};assert.ok(bindingErrors(captured,current,before,context()).length,key);
  }
  for(const key of ['series','chart','container']) {
    const current={...captured,surface:{...captured.surface,[key]:{}}};
    assert.ok(bindingErrors(captured,current,before,context()).length,key);
  }
});
test('an unattached or wrong-series primitive is not valid idle evidence',()=>{
  const captured=binding();
  const broken={...captured,attachment:{series:{}}};
  assert.ok(bindingErrors(broken,broken,context(),context()).some(x=>x.includes('captured series')));
  assert.ok(bindingErrors(captured,{...captured,attachment:null},context(),context()).length);
});
test('context/source/canvas changes cannot be concealed by equal-sized series',()=>{
  const captured=binding();
  for(const patch of [{symbol:'GBPUSD'},{intervalSeconds:300},{style:'bars'},{seriesId:44},{adapterId:22},{canvasIds:[5,7]},{feed:{source:'other',livePriceAffordance:false}}]){
    assert.ok(bindingErrors(captured,captured,context(),{...context(),...patch}).length,JSON.stringify(patch));
  }
  assert.ok(bindingErrors(captured,captured,context(),null).length);
  // Identical polling data may receive a new array/revision without invalidating
  // the captured rendering objects. Value equality is checked separately.
  assert.equal(bindingErrors(captured,captured,context(),{...context(),candlesId:99,dataRevision:200}).length,0);
});
test('method wrapping forwards original this/arguments/result and restores inherited shape',()=>{
  const prototype={multiply(x){return this.value*x;}},obj=Object.assign(Object.create(prototype),{value:7}),restores=[];let calls=0;
  wrapMethod(obj,'multiply',()=>{calls++;},restores);
  assert.equal(obj.multiply(6),42);assert.equal(calls,1);assert.ok(Object.hasOwn(obj,'multiply'));
  restores[0]();assert.equal(Object.hasOwn(obj,'multiply'),false);assert.equal(obj.multiply,prototype.multiply);
});
test('partial installation failure restores earlier methods in cleanup scope',()=>{
  const original=function(){return 19;},obj={first:original},restores=[];let failure;
  try {wrapMethod(obj,'first',()=>{},restores);wrapMethod(null,'requestUpdate',()=>{},restores);}
  catch(error){failure=error;}
  finally{for(const restore of restores.reverse())restore();}
  assert.match(failure.message,/Missing method/);assert.equal(obj.first,original);
  assert.deepEqual(Object.getOwnPropertyDescriptor(obj,'first'),{value:original,writable:true,configurable:true,enumerable:true});
  // Production installation is inside the cleanup scope, not before it.
  assert.ok(source.indexOf('    try {\n      captured=readBinding()')<source.indexOf('        wrapMethod(obj,key,'));
  assert.match(source,/finally \{[\s\S]*restores\.reverse\(\)/);
});
test('restoration detects concurrent method replacement without overwriting the new implementation',()=>{
  const obj={method(){return 1;}},restores=[],replacement=()=>2;
  wrapMethod(obj,'method',()=>{},restores);obj.method=replacement;
  assert.throws(()=>restores[0](),/Observed method replaced/);assert.equal(obj.method,replacement);
});
test('initial note evidence is copied rather than aliased to mutable library options',()=>{
  const copy=vm.runInNewContext('('+source.match(/    function cloneEvidence\(value\) \{[^\n]+/)[0].trim()+')',{structuredClone});
  const options={price:.999,title:'S OFFLINE QA',nested:{color:'cyan'}},before=copy(options);
  options.price=2;options.nested.color='red';assert.equal(before.price,.999);assert.equal(before.nested.color,'cyan');
  assert.match(source,/optionsBefore:cloneEvidence\(noteBefore\.options\(\)\)/);
});
test('synthetic note interception remains exact-symbol GET-only and defers every write to the shared barrier',async()=>{
  const setup=readFileSync(new URL('./shared-chart-idle-setup.js',import.meta.url),'utf8');let handler;
  await vm.runInNewContext('('+setup+')',{URL})({route:async(_,fn)=>{handler=fn;}});
  const call=async(symbol,method)=>{let response;await handler({request:()=>({method:()=>method,url:()=>`http://127.0.0.1:4199/api/me/chart/annotations?symbol=${symbol}`}),fallback:()=>{response={fallback:true};},fulfill:value=>{response=value;}});return response;};
  assert.equal(JSON.parse((await call('EURUSD','GET')).body).annotations.length,1);
  assert.equal(JSON.parse((await call('GBPUSD','GET')).body).annotations.length,0);
  assert.equal((await call('EURUSD','POST')).fallback,true);
});
