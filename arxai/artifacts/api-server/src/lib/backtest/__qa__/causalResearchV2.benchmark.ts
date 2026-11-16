import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { cpus, totalmem, platform, release } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runCausalResearchV2, type ResearchV2Config, type ResearchV2Input } from "@workspace/domain/backtest/research";
import { runCausalResearchV2Web } from "@workspace/domain/backtest/research-browser";
import { workload } from "./causalResearch.fixture.js";

const output = process.argv[2];
if (!output) throw new Error("Pass output JSON path; warmups and outliers are retained.");
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a,b) => a-b);
  const p = (n:number) => sorted[Math.max(0,Math.ceil(sorted.length*n)-1)]!;
  return { count:samples.length, medianMs:p(.5), p95Ms:p(.95), p99Ms:p(.99), maxMs:sorted.at(-1)! };
};
const paths = ["../../lib/domain/src/backtest/researchCore.ts", "../../lib/domain/src/backtest/research.ts", "../../lib/domain/src/backtest/researchBrowser.ts", "../../lib/domain/src/chart-indicator-math/index.ts", "src/lib/backtest/__qa__/causalResearch.fixture.ts", "src/lib/backtest/__qa__/causalResearchV2.benchmark.ts"];
const sources = Object.fromEntries(paths.map(path=>[path,createHash("sha256").update(readFileSync(path)).digest("hex")]));
const startedAt = new Date().toISOString();
const results = [];
const bars = 5000, trials = 50, warmups = 5;
const config: ResearchV2Config = {
  strategy:{version:"ema-cross-atr-v1",fastPeriod:9,slowPeriod:21,atrPeriod:14,stopAtrMultiple:2,targetR:2,maxHoldingBars:100,direction:"both"},
  costs:{fullSpreadPriceUnits:.02,adverseSlippagePerFillPriceUnits:.01,feePerFillPriceUnits:.005},
  maxEntryGapMs:0,splits:{trainEndExclusive:3000,validationEndExclusive:4000},
};
for (let round=1; round<=2; round++) for (const priceBasis of round===1 ? ["BID","MID"] as const : ["MID","BID"] as const) {
  const input:ResearchV2Input = {...workload(bars),priceBasis};
  const expected=runCausalResearchV2(input,config);
  assert.deepEqual(await runCausalResearchV2Web(input,config),expected);
  const samples=[];
  for(let index=-warmups;index<trials;index++) {
    let nodeMs=0, webCryptoMs=0;
    const node=()=>{const start=performance.now();const result=runCausalResearchV2(input,config);nodeMs=performance.now()-start;assert.equal(result.fingerprints.result,expected.fingerprints.result);};
    const web=async()=>{const start=performance.now();const result=await runCausalResearchV2Web(input,config);webCryptoMs=performance.now()-start;assert.equal(result.fingerprints.result,expected.fingerprints.result);};
    const nodeFirst=(index+warmups+round)%2===0;
    if(nodeFirst){node();await web();}else{await web();node();}
    samples.push({phase:index<0?"warmup":"measured",index,order:nodeFirst?"node_then_webcrypto":"webcrypto_then_node",nodeMs,webCryptoMs});
  }
  const measured=samples.filter(s=>s.phase==="measured");
  const node=stats(measured.map(s=>s.nodeMs)),webCrypto=stats(measured.map(s=>s.webCryptoMs));
  results.push({round,priceBasis,bars,trials,warmups,resultFingerprint:expected.fingerprints.result,completedTrades:expected.partitions.map(p=>p.metrics.completedTrades),node,webCrypto,target:{p95Ms:100,nodePassed:node.p95Ms<=100,webCryptoPassed:webCrypto.p95Ms<=100},samples});
}
const receipt={startedAt,finishedAt:new Date().toISOString(),gitHead:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),sources,node:process.version,machine:{cpu:cpus()[0]?.model,cores:cpus().length,ramBytes:totalmem(),platform:platform(),release:release()},config,
 completion:"Full wrapper completion: validation/copies, shared indicator features and execution loop, all SHA-256 fingerprints, recursive freeze. Promise awaited for WebCrypto; equality assertions outside timers.",
 limitations:["Generated deterministic prices are not market returns evidence.","Both wrappers run in Node on this machine; WebCrypto is not a browser Worker or paint measurement.","No HTTP, provider, broker, database, navigation, chart painting or competitor latency is measured.","100 ms p95 is an existing declared 5000-bar calculation budget, not an instant-navigation promise.","All warmups and outliers retained; two rounds with reversed basis order and alternating wrapper order, not a causal speedup experiment."],results};
writeFileSync(output,JSON.stringify(receipt,null,2)+"\n");
process.stdout.write(JSON.stringify(results.map(({round,priceBasis,node,webCrypto,target})=>({round,priceBasis,node,webCrypto,target})),null,2)+"\n");
if(results.some(r=>!r.target.nodePassed||!r.target.webCryptoPassed))process.exitCode=1;
