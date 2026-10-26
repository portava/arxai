/** Offline same-process comparison against the exact preceding core commit.
 * Run from api-server: node --import tsx ../trading-dashboard/src/lib/chart-engine/smartChartAnalysis.catalogue.benchmark.ts
 * Temporary baseline module is removed even when an assertion fails. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanCandlestickCatalogue, CANDLE_DEFINITIONS } from "@workspace/domain/chart-patterns";
import { analyzeSmartChart, bindSmartChartBars, type SmartChartAnalysisBar } from "./smartChartAnalysis";
import { CANDLE_FIXTURES } from "../../../../../lib/domain/src/chart-patterns/__qa__/candlestickFixtures";

const baselineCommit=process.argv[2]??"d50027cc4214ada92527bc28eb1630756df589d7";
assert.match(baselineCommit,/^[a-f0-9]{8,40}$/);
const root=fileURLToPath(new URL("../../../../../",import.meta.url));
const baselineFile=fileURLToPath(new URL(`.candle-baseline-${process.pid}.ts`,import.meta.url));
const baselineSource=execFileSync("git",["show",`${baselineCommit}:artifacts/trading-dashboard/src/lib/chart-engine/smartChartAnalysis.ts`],{cwd:root,encoding:"utf8"});
writeFileSync(baselineFile,baselineSource,{flag:"wx"});
try {
 const baseline=await import(pathToFileURL(baselineFile).href) as typeof import("./smartChartAnalysis");
 const context={symbol:"EURUSD",timeframe:"M5",source:"mt5_broker",sourceIdentity:"a".repeat(64)};
 const start=1_700_000_000;
 const candles:SmartChartAnalysisBar[]=Array.from({length:5000},(_,i)=>{
  const close=1.1+.004*Math.sin(i/8)+.001*Math.sin(i/3)+i*.000001,open=close+(i%2===0?-1:1)*.0003;
  return {time:start+i*300,closeTime:start+(i+1)*300,open,close,high:Math.max(open,close)+.0006,low:Math.min(open,close)-.0006,isComplete:true,isFinal:true,isForming:false};
 });
 const args={...context,bars:candles,asOfMs:candles.at(-1)!.closeTime*1000,dataState:"current" as const};
 const batches=[{evidence:context,bars:candles.slice(0,4550)},{evidence:context,bars:candles.slice(4500)}];
 const recent=candles.slice(-600);
 assert.equal(analyzeSmartChart(args).coverage.analyzed,600);
 assert.equal(analyzeSmartChart(args).catalogue!.definedVariants,34);
 const patternArgs=CANDLE_FIXTURES.map(f=>({...context,bars:f.bars,asOfMs:f.bars.at(-1)!.closeTime*1000,dataState:"current" as const}));
 // Correctness witness on the same inputs, separately from measurements.
 for(let i=0;i<CANDLE_FIXTURES.length;i++)assert.ok(analyzeSmartChart(patternArgs[i]!).allFindings.some(f=>f.id===`${CANDLE_FIXTURES[i]!.id}:${patternArgs[i]!.bars.at(-1)!.time}`));
 const operations:Record<string,()=>unknown>={
  baseline_model_5000:()=>baseline.analyzeSmartChart(args),
  expanded_model_5000:()=>analyzeSmartChart(args),
  baseline_bind_model_5000:()=>baseline.analyzeSmartChart({...args,bars:baseline.bindSmartChartBars(context,batches).bars}),
  expanded_bind_model_5000:()=>analyzeSmartChart({...args,bars:bindSmartChartBars(context,batches).bars}),
  catalogue_600_latest12:()=>scanCandlestickCatalogue(recent,{asOf:recent.at(-1)!.closeTime,intervalSeconds:300}),
  all34_fixtures_one_batch:()=>patternArgs.map(p=>analyzeSmartChart(p)),
 };
 const samples:Record<string,number[]>=Object.fromEntries(Object.keys(operations).map(k=>[k,[]]));
 let witness=0;
 for(let i=0;i<80;i++)for(const fn of Object.values(operations)){fn();witness++;}
 for(let i=0;i<500;i++){
  const names=Object.keys(operations);if(i%2)names.reverse();
  for(const name of names){const t=performance.now();const value=operations[name]!();samples[name]!.push(performance.now()-t);if(value!=null)witness++;}
 }
 const q=(xs:number[],fraction:number)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*fraction)-1]!;
 const metrics=Object.fromEntries(Object.entries(samples).map(([name,xs])=>[name,{samples:xs.length,medianMs:q(xs,.5),p95Ms:q(xs,.95),p99Ms:q(xs,.99),maxMs:Math.max(...xs)}]));
 const acceptance=Object.fromEntries(["expanded_model_5000","expanded_bind_model_5000"].map(name=>[name,{p95Under10ms:metrics[name]!.p95Ms<=10,p99Under20ms:metrics[name]!.p99Ms<=20}]));
 const result={baselineCommit,criteriaVariants:CANDLE_DEFINITIONS.length,node:process.version,
  scope:"Pure synchronous computation only. Identical 5,000-bar inputs and 600-bar cap; 34-fixture batch exercises actual findings. No browser acknowledgement, paint, network, broker, or order latency.",
  comparison:"Same Node process, shared unchanged core detector and dependencies, interleaved order after 80 warmups; added correctness/features are not competitor parity.",
  metrics,acceptance,witness};
 console.log(JSON.stringify(result,null,2));
 for(const row of Object.values(acceptance))assert.ok(row.p95Under10ms&&row.p99Under20ms,"Pure processing budget missed");
} finally {unlinkSync(baselineFile);}
