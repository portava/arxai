import {describe,it,expect} from "vitest";
import {runCausalResearchV2} from "@workspace/domain/backtest/research";
import type {ResearchV2Config,ResearchV2Input,ResearchV2Partition} from "@workspace/domain/backtest/research-core";
import {verifyChartResearchCash} from "./chartResearchCashEvidence";
const STEP=60000;
function fixture(basis:ResearchV2Input["priceBasis"]="BID"){
 const input:ResearchV2Input={symbol:"TEST",priceBasis:basis,intervalMs:STEP,asOfMs:10*STEP,source:{kind:"generated",reference:"independent-cash-proof"},bars:[10,10,9,11,11,11,11,11,11,11].map((price,i)=>({openTimeMs:i*STEP,open:price,high:price+.1,low:price-.1,close:price}))};
 const config:ResearchV2Config={strategy:{version:"ema-cross-atr-v1",fastPeriod:1,slowPeriod:3,atrPeriod:2,stopAtrMultiple:2,targetR:2,maxHoldingBars:1,direction:"long_only"},costs:{fullSpreadPriceUnits:.2,adverseSlippagePerFillPriceUnits:.05,feePerFillPriceUnits:.03},maxEntryGapMs:0,splits:{trainEndExclusive:7,validationEndExclusive:9},cash:{version:"cash-fixed-units-v1",initialCapital:100,fixedQuantity:2,pointValue:3,unitLabel:"scenario units",benchmark:"same_quantity_buy_hold"}};
 return {input,config};
}
const run=(input:ResearchV2Input,config:ResearchV2Config)=>runCausalResearchV2(input,config).partitions;
const clone=<T,>(value:T):T=>structuredClone(value);
function writable(value:unknown):ResearchV2Partition {return clone(value) as ResearchV2Partition;}
describe("independent chart cash-account evidence",()=>{
 it.each(["BID","MID"] as const)("verifies every %s partition and independent fill/cost arithmetic",basis=>{
  const {input,config}=fixture(basis),partitions=run(input,config),p=partitions[0],cash=p.cash!;
  for(const part of partitions)expect(verifyChartResearchCash(input,config,part)).toBe(true);
  expect(p.trades).toHaveLength(1);expect(p.trades[0].entryPrice).toBeCloseTo(basis==="BID"?11.25:11.15,12);
  expect(p.trades[0].exitPrice).toBeCloseTo(basis==="BID"?10.95:10.85,12);
  expect(cash.completedNet).toBeCloseTo(-2.16,12);expect(cash.completedCosts).toBeCloseTo(2.16,12);expect(cash.lastEquity).toBeCloseTo(97.84,12);
  expect(cash.curve[4].cash).toBeCloseTo(basis==="BID"?32.32:32.92,12);expect(cash.curve[4].equity).toBeCloseTo(97.84,12);
  expect(cash.benchmark.lastEquity).toBeCloseTo(103.84,12);expect(cash.maxDrawdown).toBeCloseTo(2.16,12);expect(cash.maxDrawdownPercent).toBeCloseTo(2.16,12);expect(cash.annualizedReturnPercent).toBeNull();
 });
 it("retains an unresolved position, with its hypothetical exit fee but no completed trade costs",()=>{
  const {input,config}=fixture();config.strategy.maxHoldingBars=20;const p=run(input,config)[0];
  expect(p.openPosition).not.toBeNull();expect(p.trades).toHaveLength(0);expect(p.cash!.completedCosts).toBe(0);expect(p.cash!.curve.at(-1)!.cash).toBeCloseTo(32.32,12);expect(p.cash!.lastEquity).toBeCloseTo(97.84,12);expect(verifyChartResearchCash(input,config,p)).toBe(true);
  const bad=writable(p);bad.openPosition!.estimatedExitFeePriceUnits=0;expect(verifyChartResearchCash(input,config,bad)).toBe(false);
 });
 it("keeps an unaffordable same-quantity benchmark flat and rejects invented smaller purchases",()=>{
  const {input,config}=fixture();config.cash!.initialCapital=1;const p=run(input,config)[0];expect(verifyChartResearchCash(input,config,p)).toBe(true);expect(p.cash!.benchmark.status).toBe("insufficient_capital");expect(p.cash!.curve.every(point=>point.cash===1&&point.equity===1&&point.benchmarkEquity===1)).toBe(true);
  const bad=writable(p);bad.cash!.benchmark.entryPrice=10.25;bad.cash!.benchmark.status="entered_unresolved";expect(verifyChartResearchCash(input,config,bad)).toBe(false);
 });
 it("allows exact entry affordability, rejects a filled trade below the required debit",()=>{
  const {input,config}=fixture();config.cash!.initialCapital=(11.25+.03)*6;const p=run(input,config)[0];expect(p.trades).toHaveLength(1);expect(verifyChartResearchCash(input,config,p)).toBe(true);
  const altered=clone(config);altered.cash!.initialCapital-=.0001;expect(verifyChartResearchCash(input,altered,p)).toBe(false);
 });
 it("retains fee-driven negative cash and equity instead of clamping a deficit",()=>{
  const {input,config}=fixture();config.costs={fullSpreadPriceUnits:0,adverseSlippagePerFillPriceUnits:0,feePerFillPriceUnits:20};config.cash!.initialCapital=31;config.cash!.fixedQuantity=1;config.cash!.pointValue=1;
  const p=run(input,config)[0];expect(p.trades).toHaveLength(1);expect(p.cash!.lastEquity).toBe(-9);expect(p.cash!.capitalDeficit).toBe(true);expect(p.cash!.maxDrawdownPercent).toBeCloseTo(40/31*100,12);expect(verifyChartResearchCash(input,config,p)).toBe(true);
  const bad=writable(p);for(const point of bad.cash!.curve){point.cash=Math.max(0,point.cash);point.equity=Math.max(0,point.equity);}bad.cash!.lastEquity=0;bad.cash!.capitalDeficit=false;expect(verifyChartResearchCash(input,config,bad)).toBe(false);
 });
 it("annualizes only after 365.25 elapsed days and independently restarts each partition",()=>{
  for(const days of [50,60]){
   const {input,config}=fixture();input.intervalMs=days*86400000;input.asOfMs=input.intervalMs*10;input.bars=input.bars.map((bar,index)=>({...bar,openTimeMs:index*input.intervalMs}));
   const partitions=run(input,config),p=partitions[0];expect(verifyChartResearchCash(input,config,p)).toBe(true);
   if(days===50)expect(p.cash!.annualizedReturnPercent).toBeNull();else expect(p.cash!.annualizedReturnPercent).toBeCloseTo(100*(Math.pow(.9784,365.25/(7*days))-1),10);
   expect(partitions[1].cash!.initialCapital).toBe(100);expect(partitions[1].cash!.curve[0].cash).toBe(100);expect(verifyChartResearchCash(input,config,partitions[1])).toBe(true);
  }
 });
 it.each([
  ["account point",(p:ResearchV2Partition)=>{p.cash!.curve[4].cash+=1;}],
  ["equity point",(p:ResearchV2Partition)=>{p.cash!.curve[4].equity+=1;}],
  ["benchmark point",(p:ResearchV2Partition)=>{p.cash!.curve[4].benchmarkEquity+=1;}],
  ["unit mark",(p:ResearchV2Partition)=>{p.markedCurve[4].netPriceUnits+=1;}],
  ["nonfinite curve",(p:ResearchV2Partition)=>{p.cash!.curve[0].cash=NaN;}],
  ["curve timestamp",(p:ResearchV2Partition)=>{p.cash!.curve[0].observedThroughMs++;}],
  ["curve index",(p:ResearchV2Partition)=>{p.markedCurve[0].index++;}],
  ["entry reference",(p:ResearchV2Partition)=>{p.trades[0].entryReferencePrice+=1;}],
  ["entry fill",(p:ResearchV2Partition)=>{p.trades[0].entryPrice+=1;}],
  ["exit fill",(p:ResearchV2Partition)=>{p.trades[0].exitPrice+=1;}],
  ["exit reference",(p:ResearchV2Partition)=>{p.trades[0].exitReferencePrice+=1;}],
  ["exit precision",(p:ResearchV2Partition)=>{p.trades[0].exitTime.precision="bar_interval";}],
  ["fee decomposition",(p:ResearchV2Partition)=>{p.trades[0].feeCostPriceUnits=0;}],
  ["gross/net consistency",(p:ResearchV2Partition)=>{p.trades[0].grossPriceUnits+=1;}],
  ["duplicate fill",(p:ResearchV2Partition)=>{p.trades.push(clone(p.trades[0]));}],
  ["signal ownership",(p:ResearchV2Partition)=>{const d=p.decisions.find(d=>d.disposition==="filled")!;d.entryIndex=(d.entryIndex??0)+1;}],
  ["wrong side",(p:ResearchV2Partition)=>{p.trades[0].side="SELL";}],
  ["partition bounds",(p:ResearchV2Partition)=>{p.fromInclusive++;}],
  ["capital label",(p:ResearchV2Partition)=>{p.cash!.unitLabel="USD";}],
  ["total cost",(p:ResearchV2Partition)=>{p.cash!.completedCosts=0;}],
  ["total return",(p:ResearchV2Partition)=>{p.cash!.totalReturnPercent=0;}],
  ["drawdown percent",(p:ResearchV2Partition)=>{p.cash!.maxDrawdownPercent=0;}],
  ["annualization under a year",(p:ResearchV2Partition)=>{p.cash!.annualizedReturnPercent=0;}],
  ["deficit flag",(p:ResearchV2Partition)=>{p.cash!.capitalDeficit=true;}],
 ] as const)("rejects tampered %s",(_name,mutate)=>{const {input,config}=fixture(),p=writable(run(input,config)[0]);mutate(p);expect(verifyChartResearchCash(input,config,p)).toBe(false);});
 it("requires absence when disabled and rejects unsupported scenarios or swallowed movements",()=>{
  const {input,config}=fixture(),p=writable(run(input,config)[0]);const none=clone(config);delete none.cash;
  expect(verifyChartResearchCash(input,none,p)).toBe(false);delete p.cash;expect(verifyChartResearchCash(input,none,p)).toBe(true);
  Object.assign(p,{cash:undefined});expect(verifyChartResearchCash(input,none,p)).toBe(false);
  const wrong=clone(config);wrong.strategy.direction="both";expect(verifyChartResearchCash(input,wrong,run(input,config)[0])).toBe(false);
  const huge=clone(config);huge.cash!.initialCapital=1e20;expect(verifyChartResearchCash(input,huge,run(input,config)[0])).toBe(false);
  const unknown=clone(config);Object.assign(unknown.cash!,{leverage:100});expect(verifyChartResearchCash(input,unknown,run(input,config)[0])).toBe(false);
 });
 it("rejects numerically swallowed fills even when every reported cash metric agrees with the huge baseline",()=>{
  const {input,config}=fixture(),p=writable(run(input,config)[0]);config.cash!.initialCapital=1e20;
  const account=p.cash!;account.initialCapital=1e20;account.lastEquity=1e20;account.totalReturnPercent=0;account.maxDrawdown=0;account.maxDrawdownPercent=0;
  account.benchmark.lastEquity=1e20;account.benchmark.totalReturnPercent=0;
  for(const point of account.curve){point.cash=1e20;point.equity=1e20;point.benchmarkEquity=1e20;}
  expect(verifyChartResearchCash(input,config,p)).toBe(false);
 });
 it("binds quantity, point value, costs, benchmark policy and original bar evidence",()=>{
  const {input,config}=fixture(),p=run(input,config)[0];
  for(const change of [(c:ResearchV2Config)=>{c.cash!.fixedQuantity=1;},(c:ResearchV2Config)=>{c.cash!.pointValue=1;},(c:ResearchV2Config)=>{c.costs.fullSpreadPriceUnits=.1;},(c:ResearchV2Config)=>{(c.cash as any).benchmark="resized_buy_hold";}]){const c=clone(config);change(c);expect(verifyChartResearchCash(input,c,p)).toBe(false);}
  const altered=clone(input);altered.bars=altered.bars.map((bar,i)=>i===4?{...bar,open:bar.open+.01}:bar);expect(verifyChartResearchCash(altered,config,p)).toBe(false);
 });
 it("uses the exact 365.25-day annualization threshold including elapsed gaps",()=>{
  const {input,config}=fixture();const year=365.25*86400000;
  input.bars=input.bars.map((bar,i)=>i>=6?{...bar,openTimeMs:year-STEP+(i-6)*STEP}:bar);input.asOfMs=year+3*STEP;
  const p=run(input,config)[0];expect(p.cash!.annualizedReturnPercent).toBeCloseTo(p.cash!.totalReturnPercent,12);expect(verifyChartResearchCash(input,config,p)).toBe(true);
  const shorter=clone(input);shorter.bars=shorter.bars.map((bar,i)=>i>=6?{...bar,openTimeMs:bar.openTimeMs-1}:bar);const q=run(shorter,config)[0];expect(q.cash!.annualizedReturnPercent).toBeNull();expect(verifyChartResearchCash(shorter,config,q)).toBe(true);
 });
 it("proves every refused disposition at the next actual open, including precedence",()=>{
  const gap=fixture();gap.input.bars=gap.input.bars.map((bar,i)=>i>=4?{...bar,openTimeMs:bar.openTimeMs+STEP}:bar);gap.input.asOfMs+=STEP;
  const gapPartition=run(gap.input,gap.config)[0];expect(gapPartition.decisions[0].disposition).toBe("gap_expired");expect(verifyChartResearchCash(gap.input,gap.config,gapPartition)).toBe(true);
  const invalid=fixture();invalid.config.strategy.stopAtrMultiple=100;const invalidPartition=run(invalid.input,invalid.config)[0];expect(invalidPartition.decisions[0].disposition).toBe("invalid_bracket");expect(verifyChartResearchCash(invalid.input,invalid.config,invalidPartition)).toBe(true);
  const poor=fixture();poor.config.cash!.initialCapital=1;const poorPartition=run(poor.input,poor.config)[0];expect(poorPartition.decisions[0].disposition).toBe("insufficient_capital");expect(verifyChartResearchCash(poor.input,poor.config,poorPartition)).toBe(true);
  for(const [f,part] of [[gap,gapPartition],[invalid,invalidPartition],[poor,poorPartition]] as const){
    for(const disposition of ["gap_expired","invalid_bracket","partition_ended","insufficient_capital"] as const){if(disposition===part.decisions[0].disposition)continue;const bad=writable(part);bad.decisions[0].disposition=disposition;expect(verifyChartResearchCash(f.input,f.config,bad)).toBe(false);}
  }
  // Keep zero-trade accounting unchanged while inventing a capital refusal
  // at an open now inside the allowed gap: affordability must disprove it.
  const funded=clone(gap.config);funded.maxEntryGapMs=STEP;const fake=writable(gapPartition);fake.decisions[0].disposition="insufficient_capital";expect(verifyChartResearchCash(gap.input,funded,fake)).toBe(false);
 });
 it("permits partition-ended signals only on the partition's final close",()=>{
  const {input,config}=fixture();config.splits.trainEndExclusive=4;const p=run(input,config)[0];expect(p.decisions[0].disposition).toBe("partition_ended");expect(verifyChartResearchCash(input,config,p)).toBe(true);
  const bad=writable(p);bad.decisions[0].disposition="insufficient_capital";expect(verifyChartResearchCash(input,config,bad)).toBe(false);
 });
 it("rejects a fabricated refusal signal while a position is held",()=>{
  const {input,config}=fixture();config.strategy.maxHoldingBars=20;const p=writable(run(input,config)[0]);expect(verifyChartResearchCash(input,config,p)).toBe(true);
  p.decisions.push({...clone(p.decisions[0]),signalIndex:5,knownThroughMs:6*STEP,entryIndex:null,disposition:"insufficient_capital"});expect(verifyChartResearchCash(input,config,p)).toBe(false);
 });
 it("recomputes win rate, profit factor and their missing-value reasons from closed net results",()=>{
  for(const winning of [false,true]){
    const {input,config}=fixture();if(winning)input.bars=input.bars.map((bar,i)=>i===5?{...bar,open:12,high:12.1,low:11.9,close:12}:bar);
    const p=run(input,config)[0];expect(verifyChartResearchCash(input,config,p)).toBe(true);expect(p.metrics.winRate).toBe(winning?1:0);expect(p.metrics.profitFactor).toBe(winning?null:0);expect(p.metrics.profitFactorUnavailable).toBe(winning?"no_losses":null);
    for(const patch of [{winRate:.5},{profitFactor:99},{profitFactorUnavailable:"no_completed_trades" as const}]){const bad=writable(p);Object.assign(bad.metrics,patch);expect(verifyChartResearchCash(input,config,bad)).toBe(false);}
  }
  const {input,config}=fixture();config.cash!.initialCapital=1;const p=writable(run(input,config)[0]);expect(verifyChartResearchCash(input,config,p)).toBe(true);p.metrics.winRate=0;expect(verifyChartResearchCash(input,config,p)).toBe(false);
 });
 it("does not round tiny explicit account units down to invented zeros",()=>{
  const {input,config}=fixture();config.cash!.initialCapital=100e-18;config.cash!.pointValue=3e-18;
  const p=run(input,config)[0];expect(verifyChartResearchCash(input,config,p)).toBe(true);expect(p.cash!.curve[4].cash).toBeGreaterThan(0);
  const bad=writable(p);bad.cash!.curve[4].cash=0;expect(verifyChartResearchCash(input,config,bad)).toBe(false);
 });
 it("rejects a coherent-looking subnormal account whose fractional marked gain cannot be represented",()=>{
  const {input,config}=fixture();config.costs={fullSpreadPriceUnits:0,adverseSlippagePerFillPriceUnits:0,feePerFillPriceUnits:0};config.strategy.maxHoldingBars=20;config.cash!.fixedQuantity=1;config.cash!.pointValue=1;
  input.bars=input.bars.map((bar,i)=>i===5||i===6?{...bar,close:11.25,high:11.3}:bar);
  const p=writable(run(input,config)[0]);expect(p.openPosition).not.toBeNull();expect(p.markedCurve[5].netPriceUnits).toBe(.25);
  const amount=Number.MIN_VALUE,initial=1e-320;config.cash!.fixedQuantity=amount;config.cash!.initialCapital=initial;
  const account=p.cash!;account.initialCapital=initial;account.completedNet=0;account.completedCosts=0;account.unitLabel=config.cash!.unitLabel;
  let peak=initial,dd=0,ddPercent=0;
  for(const point of account.curve){const entered=point.index>=p.openPosition!.entryIndex;point.cash=initial-(entered?p.openPosition!.entryPrice*amount:0);point.equity=point.cash+(entered?input.bars[point.index].close*amount:0);point.benchmarkEquity=initial-10*amount+input.bars[point.index].close*amount;peak=Math.max(peak,point.equity);dd=Math.max(dd,peak-point.equity);ddPercent=Math.max(ddPercent,(peak-point.equity)/peak*100);}
  account.lastEquity=account.curve.at(-1)!.equity;account.totalReturnPercent=(account.lastEquity-initial)/initial*100;account.maxDrawdown=dd;account.maxDrawdownPercent=ddPercent;account.capitalDeficit=false;
  account.benchmark.lastEquity=account.curve.at(-1)!.benchmarkEquity;account.benchmark.totalReturnPercent=(account.benchmark.lastEquity-initial)/initial*100;
  expect(verifyChartResearchCash(input,config,p)).toBe(false);
 });
 it("rejects malformed unknown objects without throwing",()=>{
  const {input,config}=fixture();for(const bad of [null,{},[],{cash:{}},undefined])expect(verifyChartResearchCash(input,config,bad as any)).toBe(false);
 });
});
