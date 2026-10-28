import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source=readFileSync(new URL('./shared-chart-latency.js',import.meta.url),'utf8');
const extract=(name,indent='  ')=>{const found=source.match(new RegExp(indent+'function '+name+'\\([^]*?\\n'+indent+'\\}'))?.[0];assert.ok(found,name);return found;};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b),close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<.002;
const assess=vm.runInNewContext('('+extract('assessCompletion','    ')+')',{equal,close});
const stats=vm.runInNewContext('('+extract('stats')+')');
const summarize=vm.runInNewContext('('+extract('summarizeControl')+')',{stats});
const isolateSource=source.match(/  async function performWithStyleIsolation\([^]*?\n  \}/)?.[0];
assert.ok(isolateSource);const isolate=vm.runInNewContext('('+isolateSource+')');
test('unsupported native style is attempted once, preserves proof, and cannot suppress navigation samples',async()=>{
  const run={controlFailures:[],skippedActions:[]};let navigation=0,style=0;
  for(let rep=0;rep<82;rep++){
    await isolate({kind:'zoom',control:'Zoom in',rep,pass:1,record:rep>=2},run,async()=>{navigation++;},async()=>{throw Error('not used');});
    await isolate({kind:'style',control:'Style bars',rep,pass:1,record:rep>=2},run,async()=>{style++;throw Error('no trusted change');},async()=>({kind:'trusted selection change was not observed',pendingArm:{id:1},inputAttempts:[{type:'keydown',trusted:true}]}));
  }
  assert.equal(navigation,82);assert.equal(style,1);assert.equal(run.controlFailures.length,1);assert.equal(run.controlFailures[0].pendingArm.id,1);assert.equal(run.skippedActions.filter(x=>x.record).length,80);
  const summary=summarize([],'Style bars',80,100);assert.equal(summary.meetsTarget,false);assert.equal(summary.recordedSamples,0);
});
test('isolation never converts an observed navigation failure into a skipped style',async()=>{
  await assert.rejects(isolate({kind:'pan',control:'Pan earlier'},{controlFailures:[],skippedActions:[]},async()=>{throw Error('wrong actual range');},async()=>({})),/wrong actual range/);
});
const bars=[{time:100,open:1,high:3,low:0,close:2},{time:400,open:2,high:4,low:1,close:3}];
function baseline(){return {state:{adapterId:1,containerId:2,chartId:3,seriesId:4,canvasIds:[5],candlesId:6,dataRevision:1,symbol:'EURUSD',intervalSeconds:900,barCount:2,style:'candles',feed:{source:'offline_fixture',livePriceAffordance:false},range:{from:20,to:100},bounds:{x:100,y:200,width:900,height:520}},data:{canonical:structuredClone(bars),display:structuredClone(bars)}};}
function arm(kind,extra={}){return {id:1,kind,control:kind,event:kind==='style'?'change':'click',selector:'button',record:true,timeoutMs:1000,before:baseline(),authority:bars,viewport:{width:1440,height:1100},...extra};}
test('zoom needs intended span and midpoint, not merely a changed range',()=>{
  const a=arm('zoom',{factor:.75}),current=baseline();
  assert.equal(assess(a,current,{}).pass,false);
  current.state.range={from:30,to:90};assert.equal(assess(a,current,{}).pass,true);
  current.state.range={from:31,to:91};assert.equal(assess(a,current,{}).pass,false);
});
test('pan needs exact direction/distance and unchanged width',()=>{
  const a=arm('pan',{fraction:-.25}),current=baseline();
  current.state.range={from:0,to:80};assert.equal(assess(a,current,{}).pass,true);
  current.state.range={from:19,to:99};assert.equal(assess(a,current,{}).pass,false);
  current.state.range={from:0,to:79};assert.equal(assess(a,current,{}).pass,false);
});
test('selection acknowledgment without real series replacement does not complete',()=>{
  const a=arm('style',{style:'bars'}),current=baseline();
  assert.equal(assess(a,current,{style:'bars'}).pass,false);
  current.state.style='bars';assert.equal(assess(a,current,{style:'bars'}).pass,false);
  current.state.seriesId=7;assert.equal(assess(a,current,{style:'bars'}).pass,true);
});
test('same count/last bar cannot conceal wrong canonical or displayed interior OHLC',()=>{
  for(const field of ['canonical','display']){
    const a=arm('zoom',{factor:.75}),current=baseline();current.state.range={from:30,to:90};current.data[field][0].open=99;
    assert.equal(assess(a,current,{}).pass,false,field);
  }
});
test('changed source/engine or offscreen plot cannot pass source-correct navigation',()=>{
  for(const mutate of [c=>{c.state.symbol='GBPUSD';},c=>{c.state.adapterId=9;},c=>{c.state.feed.source='other';},c=>{c.state.bounds.y=-1000;}]){
    const current=baseline();current.state.range={from:30,to:90};mutate(current);assert.equal(assess(arm('zoom',{factor:.75}),current,{}).pass,false);
  }
});
test('unrelated identical refresh is retained as an observation, not hidden or called a regression',()=>{
  const current=baseline();current.state.range={from:30,to:90};current.state.dataRevision=2;current.state.candlesId=99;
  const result=assess(arm('zoom',{factor:.75}),current,{});assert.equal(result.pass,true);assert.equal(result.sourceRevisionChanged,true);assert.equal(result.canonicalIdentityChanged,true);
});
test('Tools requires real Style/Studies visibility and cannot pass an empty disclosure',()=>{
  const a=arm('tools',{expanded:true}),c=baseline();
  const controls={associated:true,total:3,expanded:true,visible:true,visibleOnscreen:true,styleVisible:true,studiesVisible:true};
  assert.equal(assess(a,c,controls).pass,true);
  for(const change of [{total:0},{styleVisible:false},{studiesVisible:false},{visibleOnscreen:false},{associated:false}])assert.equal(assess(a,c,{...controls,...change}).pass,false);
  assert.equal(assess(arm('tools',{expanded:false}),c,{...controls,expanded:false}).pass,false);
});
test('summary retains a slow outlier and fails missing, failed or malformed samples',()=>{
  const samples=Array.from({length:80},(_,i)=>({id:i,control:'zoom',record:true,trusted:true,failure:null,completedOpportunityMs:i===79?500:40,inputCapturedMs:1,controlAcknowledgementMs:null,actualStateMs:20,witnessCostMs:2}));
  const valid=summarize(samples,'zoom',80,100);assert.equal(valid.meetsTarget,true);assert.equal(valid.completedOpportunity.p95,40);assert.equal(valid.completedOpportunity.p99,500);assert.equal(valid.completedOpportunity.max,500);assert.deepEqual([...valid.outlierSampleIds],[79]);
  assert.equal(summarize(samples.slice(1),'zoom',80,100).meetsTarget,false);
  for(const mutation of [{failure:'timeout'},{completedOpportunityMs:undefined},{trusted:false}]){
    const next=structuredClone(samples);Object.assign(next[0],mutation);const summary=summarize(next,'zoom',80,100);assert.equal(summary.meetsTarget,false);assert.equal(summary.failedSamples,1);assert.ok(summary.outlierSampleIds.includes(0));
  }
});
function sampler(){
  let now=10,current=baseline();const events={},frames=[],timers=new Map();let sequence=0;
  const select={value:'candles'};
  const window={__arxChartQa:{snapshot:()=>current.state,data:()=>current.data},addEventListener:(type,fn)=>events[type]=fn,removeEventListener:()=>{}};
  const document={querySelector:()=>({querySelector:selector=>selector.startsWith('select')?select:null})};
  vm.runInNewContext('('+extract('installSampler')+')()',{window,document,performance:{now:()=>now},requestAnimationFrame:fn=>frames.push(fn),
    setTimeout:fn=>{timers.set(++sequence,fn);return sequence;},clearTimeout:id=>timers.delete(id),PerformanceObserver:class{observe(){}disconnect(){}},getComputedStyle:()=>({}),innerWidth:1440,innerHeight:1100});
  return {state:window.__scannerLatency,set:value=>{current=value;},select,
    event:(options={})=>events.click({type:'click',isTrusted:true,timeStamp:5,target:{closest:()=>true},...options}),
    frame:time=>{now=time;frames.shift()?.();},timeout:()=>{const tasks=[...timers.values()];timers.clear();tasks.forEach(fn=>fn());}};
}
test('completion requires consecutive correct frames and includes input capture delay',()=>{
  const s=sampler();s.state.armed=arm('zoom',{factor:.75});s.event();
  const correct=baseline();correct.state.range={from:30,to:90};s.set(correct);s.frame(20);
  assert.equal(s.state.samples.length,0);assert.equal(s.state.inFlight.actualStateMs,15);
  const wrong=structuredClone(correct);wrong.data.display[0].open=99;s.set(wrong);s.frame(30);assert.equal(s.state.samples.length,0);
  s.set(correct);s.frame(40);assert.equal(s.state.samples.length,0);s.frame(50);
  const sample=s.state.samples[0];assert.equal(sample.failure,null);assert.equal(sample.eventTimeStamp,5);assert.equal(sample.capturedAt,10);assert.equal(sample.inputCapturedMs,5);assert.equal(sample.completedOpportunityMs,45);assert.equal(sample.captureToCompletedOpportunityMs,40);
});
test('rAF starvation preserves the failed sample; untrusted or mismatched inputs preserve pending arm',()=>{
  const s=sampler();s.state.armed=arm('zoom',{factor:.75});s.event({isTrusted:false});assert.ok(s.state.armed);assert.equal(s.state.inFlight,null);
  s.event();s.timeout();assert.equal(s.state.samples.length,1);assert.equal(s.state.samples[0].failure,'completion deadline exceeded');assert.equal(s.state.samples[0].completedOpportunityMs,null);
});
test('clearing a failed style arm cannot later capture an unrelated trusted event',()=>{
  const s=sampler();s.state.armed=arm('style',{style:'bars'});s.state.cancelPending('failed style');s.event();assert.equal(s.state.armed,null);assert.equal(s.state.inFlight,null);assert.equal(s.state.samples.length,0);
});
test('future or negative input clocks fail rather than silently exclude capture delay',()=>{
  for(const stamp of [-1,1000000000000]){const s=sampler();s.state.armed=arm('zoom',{factor:.75});s.event({timeStamp:stamp});assert.equal(s.state.samples[0].failure,'unsupported input event clock');}
});
