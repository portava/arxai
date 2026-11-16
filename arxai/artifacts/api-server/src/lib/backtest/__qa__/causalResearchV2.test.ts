import { test } from "node:test";
import assert from "node:assert/strict";
import { runCausalResearchV2, runCausalResearch, ResearchInputError, RESEARCH_V2_ENGINE_VERSION,
  validateResearchV2Config, validateResearchV2Strategy, type ResearchV2Config, type ResearchV2Input } from "@workspace/domain/backtest/research";
import { runCausalResearchV2Web } from "@workspace/domain/backtest/research-browser";
import { input, config, workload, STEP } from "./causalResearch.fixture.js";
const near = (a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
const cfg = (direction: ResearchV2Config["strategy"]["direction"] = "both"): ResearchV2Config => ({
  strategy:{version:"ema-cross-atr-v1",fastPeriod:1,slowPeriod:3,atrPeriod:2,stopAtrMultiple:2,targetR:2,maxHoldingBars:1,direction},
  costs:{fullSpreadPriceUnits:0,adverseSlippagePerFillPriceUnits:0,feePerFillPriceUnits:0},maxEntryGapMs:0,
  splits:{trainEndExclusive:7,validationEndExclusive:9},
});
const source = (sign=1, basis:ResearchV2Input["priceBasis"]="MID"):ResearchV2Input=>({
  symbol:"TEST",priceBasis:basis,intervalMs:STEP,asOfMs:10*STEP,source:{kind:"generated",reference:"independent-ema-atr-fixture"},
  bars:[10,10,9,11,11,11,11,11,11,11].map((p,i)=>{const close=10+sign*(p-10);return{openTimeMs:i*STEP,open:close,high:close+.1,low:close-.1,close};}),
});

test("independent EMA/ATR seed fixture freezes signal distances and fills next open",()=>{
 const out=runCausalResearchV2(source(),cfg()),p=out.partitions[0]!,d=p.decisions[0]!,t=p.trades[0]!;
 assert.equal(out.engineVersion,RESEARCH_V2_ENGINE_VERSION);assert.equal(d.signalIndex,3);assert.equal(d.entryIndex,4);
 assert.equal(d.knownThroughMs,4*STEP);assert.equal(t.entryTimeMs,4*STEP);assert.equal(t.exitIndex,5);
 near(d.signal.previousFastEma,9);near(d.signal.previousSlowEma,29/3);near(d.signal.fastEma,11);near(d.signal.slowEma,31/3);
 // TR = .2,.2,1.1,2.1; Wilder ATR2 = .2,.65,1.375.
 near(d.signal.atr,1.375);near(d.signal.stopDistancePriceUnits,2.75);near(d.signal.targetDistancePriceUnits,5.5);
 near(t.stopPrice,8.25);near(t.targetPrice,16.5);assert.equal(t.reason,"max_hold_next_open");
 assert.equal(t.entryReferencePrice,11);assert.equal(t.exitReferencePrice,11);assert.ok(!("entryMid" in t));
 assert.equal(out.inputSnapshot.priceBasis,"MID");assert.deepEqual(out.authority,{promotionEligible:false,brokerVerified:false,persistedExperiment:false});
});
for(const basis of ["MID","BID"] as const)for(const sign of [1,-1])test(`${basis} ${sign===1?"long":"short"}: actual sides and independent gross-to-net accounting`,()=>{
 const c=cfg();c.costs={fullSpreadPriceUnits:.2,adverseSlippagePerFillPriceUnits:.05,feePerFillPriceUnits:.03};
 const out=runCausalResearchV2(source(sign,basis),c),t=out.partitions[0]!.trades[0]!;
 const reference=sign===1?11:9;
 const expectedEntry=basis==="BID"?(sign===1?reference+.25:reference-.05):reference+sign*.15;
 const expectedExit=basis==="BID"?(sign===1?reference-.05:reference+.25):reference-sign*.15;
 near(t.entryPrice,expectedEntry);near(t.exitPrice,expectedExit);near(t.netPriceUnits,-.36);
 near(t.grossPriceUnits-t.spreadCostPriceUnits-t.slippageCostPriceUnits-t.feeCostPriceUnits,t.netPriceUnits);
 assert.equal(out.inputSnapshot.priceBasis,basis);assert.equal(t.entryReferencePrice,reference);assert.equal(t.exitReferencePrice,reference);
});
test("entry-bar volatility cannot widen signal ATR bracket; dual-touch is conservative",()=>{
 const s=source();(s.bars as any[])[4]={openTimeMs:4*STEP,open:12,close:12,high:100,low:.5};
 const t=runCausalResearchV2(s,cfg()).partitions[0]!.trades[0]!;
 near(t.stopPrice,9.25);near(t.targetPrice,17.5);near(t.exitPrice,9.25);
 assert.equal(t.entryIndex,4);assert.equal(t.exitIndex,4);assert.equal(t.reason,"stop");assert.equal(t.ambiguousStopAndTarget,true);
 assert.deepEqual(t.exitTime,{earliestMs:4*STEP,latestMs:5*STEP,precision:"bar_interval"});
});
test("direction filters do not create entries or reinterpret the opposite cross",()=>{
 assert.equal(runCausalResearchV2(source(1),cfg("short_only")).partitions[0]!.decisions.length,0);
 assert.equal(runCausalResearchV2(source(-1),cfg("long_only")).partitions[0]!.decisions.length,0);
 assert.equal(runCausalResearchV2(source(1),cfg("long_only")).partitions[0]!.trades[0]!.side,"BUY");
 assert.equal(runCausalResearchV2(source(-1),cfg("short_only")).partitions[0]!.trades[0]!.side,"SELL");
});
test("crossovers require an actual preceding warmed-up EMA pair",()=>{
 const s=source();s.bars=s.bars.map((b,i)=>({...b,open:10+i,high:10.1+i,low:9.9+i,close:10+i}));
 assert.equal(runCausalResearchV2(s,cfg()).partitions.flatMap(p=>p.decisions).length,0);
});
test("entry expires across an unsupported gap, and partitions cannot carry pending signals",()=>{
 const s=source();s.bars=s.bars.map((b,i)=>i<4?b:{...b,openTimeMs:b.openTimeMs+STEP});s.asOfMs+=STEP;
 const p=runCausalResearchV2(s,cfg()).partitions[0]!;assert.equal(p.decisions[0]!.disposition,"gap_expired");assert.equal(p.trades.length,0);
 const c=cfg();c.splits.trainEndExclusive=4;const out=runCausalResearchV2(source(),c);
 assert.equal(out.partitions[0]!.decisions[0]!.disposition,"partition_ended");assert.equal(out.partitions[0]!.trades.length,0);
 assert.equal(out.partitions[1]!.trades.length,0);
});
test("prefix and holdout changes cannot alter earlier decisions, fills or marks",()=>{
 const s={...workload(200),priceBasis:"BID" as const},c=cfg();c.strategy={...c.strategy,fastPeriod:3,slowPeriod:5,atrPeriod:3,maxHoldingBars:2};c.splits={trainEndExclusive:120,validationEndExclusive:160};
 const before=runCausalResearchV2(s,c),changed=structuredClone(s);
 changed.bars=changed.bars.map((b,i)=>i<80?b:{...b,open:b.open+200,high:b.high+200,low:b.low+200,close:b.close+200});
 const after=runCausalResearchV2(changed,c);
 assert.deepEqual(before.partitions[0]!.decisions.filter(d=>d.signalIndex<79),after.partitions[0]!.decisions.filter(d=>d.signalIndex<79));
 assert.deepEqual(before.partitions[0]!.trades.filter(t=>t.exitIndex<80),after.partitions[0]!.trades.filter(t=>t.exitIndex<80));
 assert.deepEqual(before.partitions[0]!.markedCurve.filter(m=>m.index<80),after.partitions[0]!.markedCurve.filter(m=>m.index<80));
 changed.bars=s.bars.map((b,i)=>i<160?b:{...b,open:b.open+200,high:b.high+200,low:b.low+200,close:b.close+200});
 assert.deepEqual(before.partitions.slice(0,2),runCausalResearchV2(changed,c).partitions.slice(0,2));
});
test("V2 Node/WebCrypto/manual/AI-identical inputs produce identical frozen results",async()=>{
 const s=source(-1,"BID"),c=cfg(),node=runCausalResearchV2(s,c),pending=runCausalResearchV2Web(s,c);
 (s.bars as any[])[0].close=999;c.strategy.fastPeriod=999;
 const web=await pending;assert.equal(JSON.stringify(web),JSON.stringify(node));assert.ok(Object.isFrozen(web.inputSnapshot.bars));
 const again=await runCausalResearchV2Web(structuredClone(source(-1,"BID")),structuredClone(cfg()));assert.deepEqual(again.fingerprints,web.fingerprints);
});
test("v1 still rejects BID and V2 never reinterprets LAST/SYNTHETIC/ASK data",()=>{
 assert.throws(()=>runCausalResearch({...input(),priceBasis:"BID"} as any,config()),(e:any)=>e.code==="MID_PRICE_BASIS_REQUIRED");
 for(const basis of ["LAST","SYNTHETIC","ASK",undefined])assert.throws(()=>runCausalResearchV2({...source(),priceBasis:basis} as any,cfg()),(e:any)=>e.code==="UNSUPPORTED_PRICE_BASIS");
});
test("shared manual/parser validators normalize only supported explicit parameters",()=>{
 const c=cfg();assert.deepEqual(validateResearchV2Config({...c,extra:"ignored"} as any,10),c);
 assert.deepEqual(validateResearchV2Strategy({...c.strategy,extra:"ignored"} as any),c.strategy);
 for(const edit of [{fastPeriod:3},{atrPeriod:0},{direction:"buy"},{stopAtrMultiple:0},{targetR:Infinity},{maxHoldingBars:0}]){
   assert.throws(()=>validateResearchV2Strategy({...c.strategy,...edit} as any),ResearchInputError);
 }
 const missing=cfg();delete (missing.costs as any).fullSpreadPriceUnits;assert.throws(()=>runCausalResearchV2(source(),missing),ResearchInputError);
});
test("V2 browser wrapper refuses a document context before any input access",async()=>{
 Object.defineProperty(globalThis,"document",{value:{},configurable:true});
 try{await assert.rejects(runCausalResearchV2Web(new Proxy({} as any,{get(){throw Error("must not read");}}),cfg()),(e:any)=>e.code==="RESEARCH_WORKER_REQUIRED");}
 finally{delete(globalThis as any).document;}
});

test("next-open entry uses the later observed open, not the signal close",()=>{
 const s=source();s.bars=s.bars.map((b,i)=>i>=4?{...b,open:12,high:12.1,low:11.9,close:12}:b);
 const t=runCausalResearchV2(s,cfg()).partitions[0]!.trades[0]!;
 assert.equal(t.entryIndex,4);assert.equal(t.entryReferencePrice,12);assert.equal(t.entryPrice,12);near(t.stopPrice,9.25);
});
for(const sign of [1,-1])test(`BID ${sign}: adverse stop gap uses actual modeled liquidation quote`,()=>{
 const s=source(sign,"BID"),c=cfg();c.strategy.maxHoldingBars=5;c.costs={fullSpreadPriceUnits:.2,adverseSlippagePerFillPriceUnits:.05,feePerFillPriceUnits:.03};
 const gap=sign===1?6:14;
 s.bars=s.bars.map((b,i)=>i===5?{...b,open:gap,high:gap+.1,low:gap-.1,close:gap}:b);
 const t=runCausalResearchV2(s,c).partitions[0]!.trades[0]!;
 assert.equal(t.reason,"stop_gap");assert.equal(t.exitIndex,5);assert.equal(t.exitReferencePrice,gap);
 near(t.exitPrice,sign===1?5.95:14.25);assert.equal(t.exitTime.precision,"open");
});
