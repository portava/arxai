import { mock, test } from "node:test";
import assert from "node:assert/strict";
const calls: unknown[][]=[];
mock.module("../chartDataService.js",{namedExports:{getChartCandles:async(...args:unknown[])=>{calls.push(args);return {captured:true};},getChartFeedStatus:async()=>null}});
mock.module("../../candleHistoryService.js",{namedExports:{getCandleHistory:async()=>null}});
mock.module("../../../../routes/chartTickStream.js",{namedExports:{handleChartTickStream:()=>{}}});
const {default:router}=await import("../../../../routes/chart.js");
const handler=(router as any).stack.find((s:any)=>s.route?.path==="/chart/candles").route.stack[0].handle;
for(const view of [undefined,"display","analysis","invalid",["analysis","display"]])test(`candle view ${JSON.stringify(view)} is validated and forwarded without broker I/O`,async()=>{
 calls.length=0;let code=200,body:unknown;
 const res={status(n:number){code=n;return this;},json(value:unknown){body=value;return this;}};
 await handler({query:{symbol:"EURUSD",timeframe:"H1",limit:"120",...(view===undefined?{}:{view})},log:{warn(){}}},res);
 if(view==="invalid"||Array.isArray(view)){assert.equal(code,400);assert.equal(calls.length,0);}else{
 assert.equal(code,200);assert.deepEqual(body,{captured:true});assert.deepEqual(calls,[["EURUSD","H1",120,view!=="analysis"]]);}
});
