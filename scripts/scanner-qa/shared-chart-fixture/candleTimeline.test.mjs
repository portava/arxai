import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installCandleTimeline,recordCandleStage} from './candleTimeline.ts';
import {candleTimelinePlugin} from './candleTimelinePlugin.mjs';
import vm from 'node:vm';
function setup(fetcher=async()=>new Response(JSON.stringify({candles:[{}],privateAccount:'never record'}))) {
 globalThis.location={origin:'http://127.0.0.1:4299',href:'http://127.0.0.1:4299/'};
 globalThis.window={fetch:fetcher};
 class Adapter { setCandles(bars){this.bars=bars;return 7;} }
 return Adapter;
}
test('refuses ordinary or remote origins before changing fetch',()=>{
 const Adapter=setup(),original=window.fetch;location.origin='https://app.invalid';
 assert.throws(()=>installCandleTimeline(Adapter),/diagnostic loopback/);assert.equal(window.fetch,original);
});
test('observes selected transport and JSON without changing values or recording payload',async()=>{
 const Adapter=setup();installCandleTimeline(Adapter);
 const r=await window.fetch('/api/chart/candles?symbol=EURUSD');const value=await r.json();
 assert.equal(value.privateAccount,'never record');assert.deepEqual(window.__arxCandleTimeline.events.map(e=>e.stage),['fetch.start','fetch.resolved','json.start','json.resolved']);
 assert.equal(JSON.stringify(window.__arxCandleTimeline).includes('privateAccount'),false);
 assert.equal(window.__arxCandleTimeline.events.at(-1).detail.count,1);
});
test('preserves fetch input, abort signal and unrelated response identity',async()=>{
 const controller=new AbortController();const response=new Response('{}');let received;
 const Adapter=setup(async(...args)=>{received=args;return response});installCandleTimeline(Adapter);
 const options={signal:controller.signal,credentials:'include'};
 assert.equal(await window.fetch('/api/me',options),response);assert.equal(received[1],options);assert.equal(window.__arxCandleTimeline.events.length,0);
});
test('preserves rejection identity and engine return behavior',async()=>{
 const error=new Error('sentinel');const Adapter=setup(async()=>{throw error});installCandleTimeline(Adapter);
 await assert.rejects(window.fetch('/api/chart/candles'),e=>e===error);
 const a=new Adapter();const bars=[];assert.equal(a.setCandles(bars),7);assert.equal(a.bars,bars);
 assert.deepEqual(window.__arxCandleTimeline.events.slice(-2).map(e=>e.stage),['engine.setCandles.start','engine.setCandles.end']);
});
test('caps timeline and rejects duplicate installation',()=>{
 const Adapter=setup();installCandleTimeline(Adapter);assert.throws(()=>installCandleTimeline(Adapter),/already installed/);
 for(let i=0;i<2005;i++)recordCandleStage('bounded');assert.equal(window.__arxCandleTimeline.events.length,2000);assert.equal(window.__arxCandleTimeline.dropped,5);
});
test('profiling transforms require exact known files and anchors',()=>{
 const root=new URL('../../../',import.meta.url).pathname.replace(/\/$/,'');const plugin=candleTimelinePlugin(root);
 for(const relative of ['artifacts/trading-dashboard/src/App.tsx','artifacts/trading-dashboard/src/components/scanner/ScannerChartPanel.tsx','artifacts/trading-dashboard/src/components/charts/ARXNativeChart.tsx']) {
  const id=root+'/'+relative;const source=readFileSync(id,'utf8');assert.match(plugin.transform(source,id).code,/recordCandleStageQa/);assert.throws(()=>plugin.transform('changed seam',id));
 }
 assert.equal(plugin.transform('untouched',root+'/other.ts'),undefined);
});
test('JSON and engine failures retain the original error object',async()=>{
 const error=new Error('json failed');const response={status:200,json(){return Promise.reject(error)}};
 const Adapter=setup(async()=>response);Adapter.prototype.setCandles=function(){throw error};installCandleTimeline(Adapter);
 await assert.rejects((await window.fetch('/api/chart/candles')).json(),e=>e===error);
 assert.throws(()=>new Adapter().setCandles([]),e=>e===error);
 assert.equal(window.__arxCandleTimeline.events.some(e=>e.stage==='json.rejected'),true);
 assert.equal(window.__arxCandleTimeline.events.at(-1).stage,'engine.setCandles.end');
});
function nativeSetup(action) {
 const Adapter=setup();
 class Viewport {
  paintRevision=2;paintedRevision=-1;raf=null;frame={};series={candles:[{privatePrice:'never record'}]};
  paint(...args){this.paintedRevision=this.paintRevision;return action?.call(this,...args)??17;}
  getState(){throw Error('Observer must not request derived state');}
  getFrame(){throw Error('Observer must not calculate a frame');}
 }
 return {Adapter,Viewport};
}
test('native requests join the actual viewport paint, without inspecting candle values',()=>{
 const {Adapter,Viewport}=nativeSetup();installCandleTimeline(Adapter,Viewport);
 const adapter=new Adapter();adapter.viewport=new Viewport();adapter.setCandles([{}]);
 assert.equal(adapter.viewport.paint(),17);
 const rows=window.__arxCandleTimeline.events;
 assert.deepEqual(rows.map(row=>row.stage),['engine.setCandles.start','engine.setCandles.end','native.paint.start','native.paint.end']);
 assert.equal(rows[0].detail.viewportId,rows[3].detail.viewportId);
 assert.equal(rows[3].detail.currentPaintComplete,true);assert.equal(rows[3].detail.count,1);
 assert.equal(JSON.stringify(rows).includes('privatePrice'),false);
 const other=new Viewport();other.paint();assert.notEqual(rows[3].detail.viewportId,rows.at(-1).detail.viewportId);
});
test('native invalidation, errors, empty frames and destruction cannot claim completed paint',()=>{
 for(const action of [function(){this.paintRevision++;},function(){this.raf=42;},function(){this.paintError='failed';},function(){this.destroyed=true;},function(){this.frame=null;},function(){this.paintRevision=undefined;this.paintedRevision=undefined;}]) {
  const {Adapter,Viewport}=nativeSetup(action);installCandleTimeline(Adapter,Viewport);new Viewport().paint();
  assert.equal(window.__arxCandleTimeline.events.at(-1).detail.currentPaintComplete,false);
 }
});
test('native thrown errors and paint receiver/arguments/return values are preserved',()=>{
 const error=new Error('paint failed');const {Adapter,Viewport}=nativeSetup(function(arg){assert.equal(arg,9);throw error;});
 installCandleTimeline(Adapter,Viewport);assert.throws(()=>new Viewport().paint(9),e=>e===error);
 assert.equal(window.__arxCandleTimeline.events.at(-1).detail.currentPaintComplete,false);
});
test('missing native seam rejects before changing fetch or adapter',()=>{
 const Adapter=setup(),fetch=window.fetch,setCandles=Adapter.prototype.setCandles;
 assert.throws(()=>installCandleTimeline(Adapter,{prototype:{}}),/seam changed/);
 assert.equal(window.fetch,fetch);assert.equal(Adapter.prototype.setCandles,setCandles);assert.equal(window.__arxCandleTimeline,undefined);
});
test('fixture entry selects native timeline only for native profiling and installs none in ordinary builds',()=>{
 const source=readFileSync(new URL('./main.ts',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('  if(__ARX_SCANNER_QA_REACT_PROFILE__)'),source.indexOf('  // Dynamic import'));
 for(const profile of [true,false])for(const native of [true,false]) {
  const calls=[];const NativeChartsAdapter={},NativeChartViewport={},LightweightChartsAdapter={};
  vm.runInNewContext(code,{__ARX_SCANNER_QA_REACT_PROFILE__:profile,__ARX_NATIVE_ENGINE__:native,NativeChartsAdapter,NativeChartViewport,LightweightChartsAdapter,
   installReactProfile:()=>calls.push('react'),installCandleTimeline:(...args)=>calls.push(args)});
  assert.deepEqual(calls,profile?['react',native?[NativeChartsAdapter,NativeChartViewport]:[LightweightChartsAdapter]]:[]);
 }
});
test('native diagnostic driver rejects production, legacy, dirty, overridden or unidentified builds',()=>{
 const source=readFileSync(new URL('../native-first-navigation-profile.js',import.meta.url),'utf8');new vm.Script('('+source+')');
 const helper=source.match(/ function verifyBuild\(metadata,runtime,expectedHead\) \{[^]*?\n \}/)[0];
 const verify=vm.runInNewContext('('+helper+')');
 const clean={diagnosticOnly:true,reactProfiling:true,productionRuntimeChecked:false,nativePaintTimeline:true,candleTimelineEngine:'arx-native',nativeEngine:true,productDefaultEngineId:'arx-native',qaOnlyDefaultEngineOverride:false,sourceUnchanged:true,source:{status:'',head:'abc'},buildId:'fixture'};
 verify(clean,'fixture','abc');
 for(const patch of [{diagnosticOnly:false},{reactProfiling:false},{productionRuntimeChecked:true},{nativePaintTimeline:false},{candleTimelineEngine:'lightweight-charts'},{nativeEngine:false},{productDefaultEngineId:'lightweight-charts'},{qaOnlyDefaultEngineOverride:true},{sourceUnchanged:false},{source:{status:'M file',head:'abc'}}])assert.throws(()=>verify({...clean,...patch},'fixture','abc'));
 for(const [runtime,head]of [['other','abc'],['fixture',null],['fixture','other']])assert.throws(()=>verify(clean,runtime,head));
});
test('diagnostic completeness requires post-click React and completed native paint evidence',()=>{
 const source=readFileSync(new URL('../native-first-navigation-profile.js',import.meta.url),'utf8');
 const helper=source.match(/ function verifyTrace\(profile,timeline,click\) \{[^]*?\n \}/)[0];const verify=vm.runInNewContext('('+helper+')');
 const profile={diagnosticOnly:true,commits:[{at:3,path:'/market-scanner'}]},timeline={diagnosticOnly:true,events:[{at:4,stage:'native.paint.end',detail:{currentPaintComplete:true,count:200}}]},click={trusted:true,at:2};
 verify(profile,timeline,click);
 for(const p of [null,{}, {...profile,diagnosticOnly:false},{...profile,commits:[]},{...profile,commits:[{at:1,path:'/market-scanner'}]},{...profile,commits:[{at:3,path:'/'}]}])assert.throws(()=>verify(p,timeline,click));
 for(const t of [null,{}, {...timeline,diagnosticOnly:false},{...timeline,events:[]},{...timeline,events:[{at:4,stage:'native.paint.end',detail:{currentPaintComplete:false,count:200}}]},{...timeline,events:[{at:1,stage:'native.paint.end',detail:{currentPaintComplete:true,count:200}}]}])assert.throws(()=>verify(profile,t,click));
 for(const c of [null,{trusted:false,at:2},{trusted:true,at:NaN}])assert.throws(()=>verify(profile,timeline,c));
});
