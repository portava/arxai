import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installCandleTimeline,recordCandleStage} from './candleTimeline.ts';
import {candleTimelinePlugin} from './candleTimelinePlugin.mjs';
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
