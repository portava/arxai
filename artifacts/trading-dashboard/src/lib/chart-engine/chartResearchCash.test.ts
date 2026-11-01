// @vitest-environment node
import {describe,it,expect} from 'vitest';
import {runCausalResearchV2} from '@workspace/domain/backtest/research';
import type {ResearchV2Config,ResearchV2Input} from '@workspace/domain/backtest/research-core';
const STEP=60_000;
const input=(basis:ResearchV2Input['priceBasis']='BID'):ResearchV2Input=>({symbol:'TEST',priceBasis:basis,intervalMs:STEP,asOfMs:10*STEP,source:{kind:'generated',reference:'cash-independent-arithmetic'},bars:[10,10,9,11,11,11,11,11,11,11].map((price,i)=>({openTimeMs:i*STEP,open:price,high:price+.1,low:price-.1,close:price}))});
const config=():ResearchV2Config=>({strategy:{version:'ema-cross-atr-v1',fastPeriod:1,slowPeriod:3,atrPeriod:2,stopAtrMultiple:2,targetR:2,maxHoldingBars:1,direction:'long_only'},costs:{fullSpreadPriceUnits:.2,adverseSlippagePerFillPriceUnits:.05,feePerFillPriceUnits:.03},maxEntryGapMs:0,splits:{trainEndExclusive:7,validationEndExclusive:9},cash:{version:'cash-fixed-units-v1',initialCapital:100,fixedQuantity:2,pointValue:3,unitLabel:'scenario units',benchmark:'same_quantity_buy_hold'}} as ResearchV2Config);
describe('cash-funded research uses the existing causal fills',()=>{
 it('reconciles a hand-calculated BID fill, fees, cash, marked equity and benchmark',()=>{
  const r=runCausalResearchV2(input(),config()),p=r.partitions[0],cash=(p as any).cash;
  expect(p.trades[0].entryPrice).toBe(11.25);expect(p.trades[0].exitPrice).toBe(10.95);expect(cash).toBeDefined();
  expect(cash.curve[4].cash).toBeCloseTo(32.32,10);expect(cash.curve[4].equity).toBeCloseTo(97.84,10);expect(cash.curve[5].cash).toBeCloseTo(97.84,10);
  expect(cash.completedNet).toBeCloseTo(-2.16,10);expect(cash.completedCosts).toBeCloseTo(2.16,10);expect(cash.totalReturnPercent).toBeCloseTo(-2.16,10);expect(cash.maxDrawdownPercent).toBeCloseTo(2.16,10);
  expect(cash.benchmark.status).toBe('entered_unresolved');expect(cash.benchmark.lastEquity).toBeCloseTo(103.84,10);expect(cash.annualizedReturnPercent).toBeNull();
 });
 it('declines an unaffordable next-open fill without charging costs or retrying the signal',()=>{
  const c=config() as any;c.cash.initialCapital=67.67;const p=runCausalResearchV2(input(),c).partitions[0] as any;
  expect(p.decisions[0].disposition).toBe('insufficient_capital');expect(p.decisions[0].entryIndex).toBeNull();expect(p.trades).toEqual([]);expect(p.openPosition).toBeNull();expect(p.cash.completedCosts).toBe(0);expect(p.cash.curve.every((x:any)=>x.cash===67.67&&x.equity===67.67)).toBe(true);
 });
 it('requires an explicit long-only scenario rather than silently dropping short signals',()=>{
  const c=config();c.strategy.direction='both';expect(()=>runCausalResearchV2(input(),c)).toThrow(/CASH_LONG_ONLY/);
 });
 it('has an independent cash baseline for every partition and benchmark refuses unaffordable quantity',()=>{
  const c=config() as any;c.cash.initialCapital=1;const r=runCausalResearchV2(input(),c);
  for(const p of r.partitions as any){expect(p.cash.initialCapital).toBe(1);expect(p.cash.benchmark.status).toBe('insufficient_capital');expect(p.cash.curve.every((x:any)=>x.equity===1&&x.benchmarkEquity===1)).toBe(true);}
 });
 it('does not let later price changes rewrite earlier account marks',()=>{
  const a=input(),b=input();b.bars=b.bars.map((x,i)=>i>5?{...x,close:x.close+.02}:x);const ra=runCausalResearchV2(a,config()),rb=runCausalResearchV2(b,config());expect((ra.partitions[0] as any).cash.curve.slice(0,6)).toEqual((rb.partitions[0] as any).cash.curve.slice(0,6));
 });
 it('hashes capital settings and freezes account results; no scenario retains legacy output shape',()=>{
  const a=config() as any,b=config() as any;b.cash.initialCapital=200;const ra=runCausalResearchV2(input(),a),rb=runCausalResearchV2(input(),b);expect(ra.fingerprints.configuration).not.toBe(rb.fingerprints.configuration);expect(Object.isFrozen((ra.partitions[0] as any).cash.curve)).toBe(true);
  delete a.cash;expect(runCausalResearchV2(input(),a).partitions.every(p=>!('cash' in p))).toBe(true);
 });
});
it.each(['MID','BID'] as const)('funding at the exact modeled %s opening debit is accepted; just below is refused',basis=>{
 const c=config() as any;const expectedEntry=basis==='BID'?11.25:11.15;c.cash.initialCapital=(expectedEntry+.03)*6;
 expect(runCausalResearchV2(input(basis),c).partitions[0].decisions[0].disposition).toBe('filled');c.cash.initialCapital-=1e-8;expect(runCausalResearchV2(input(basis),c).partitions[0].decisions[0].disposition).toBe('insufficient_capital');
});
it('open marks include both modeled fees without reporting a completed trade or closed cost',()=>{
 const c=config();c.strategy.maxHoldingBars=100;const p=runCausalResearchV2(input(),c).partitions[0] as any;expect(p.trades).toEqual([]);expect(p.openPosition.outcome).toBe('unresolved');expect(p.cash.completedCosts).toBe(0);expect(p.cash.completedNet).toBe(0);expect(p.cash.lastEquity).toBeCloseTo(97.84,10);expect(p.cash.curve.at(-1).cash).toBeCloseTo(32.32,10);
});
it('retains fee-driven negative cash and equity, never clamps or claims bounded loss',()=>{
 const c=config() as any;c.cash.initialCapital=200;c.costs.feePerFillPriceUnits=20;const p=runCausalResearchV2(input(),c).partitions[0] as any;expect(p.cash.lastEquity).toBeCloseTo(-41.8,10);expect(p.cash.capitalDeficit).toBe(true);expect(p.cash.totalReturnPercent).toBeLessThan(-100);expect(p.cash.maxDrawdownPercent).toBeGreaterThan(100);
});
it('annualizes only a positive balance after a year of explicitly elapsed time',()=>{
 const a=input();const year=365.25*86400000;a.intervalMs=year;a.asOfMs=10*year;a.bars=a.bars.map((b,i)=>({...b,openTimeMs:i*year}));const p=runCausalResearchV2(a,config()).partitions[0] as any;expect(p.cash.annualizedReturnPercent).toBeCloseTo((Math.pow(.9784,1/7)-1)*100,10);
});
it.each([{initialCapital:1e20},{fixedQuantity:1e308,pointValue:1e308},{fixedQuantity:Number.MIN_VALUE,pointValue:Number.MIN_VALUE},{fixedQuantity:0},{pointValue:-1}])('refuses nonrepresentable or invalid accounting %j',change=>{
 const c=config() as any;Object.assign(c.cash,change);expect(()=>runCausalResearchV2(input(),c)).toThrow();
});
it('rejects tiny nonzero costs or results that disappear when converted to accounting units',()=>{
 const c=config() as any;c.cash.initialCapital=1e-320;c.cash.fixedQuantity=Number.MIN_VALUE;c.cash.pointValue=1;expect(()=>runCausalResearchV2(input(),c)).toThrow(/ACCOUNT_PRECISION_LOSS/);
});
it.each([false,true])('uses settled proceeds, not the starting budget, for the next signal (first trade gain=%s)',gain=>{
 const prices=[10,10,9,11,11,gain?12:10,9,11,gain?11.5:11,11,11,11,11,11];
 const a=input();a.bars=prices.map((price,i)=>({openTimeMs:i*STEP,open:price,high:price+.1,low:price-.1,close:price}));a.asOfMs=prices.length*STEP;
 const c=config();c.cash!.initialCapital=(11.25+.03)*6;c.splits={trainEndExclusive:11,validationEndExclusive:12};
 const p=runCausalResearchV2(a,c).partitions[0];expect(p.decisions.map(d=>[d.signalIndex,d.disposition])).toEqual([[3,'filled'],[7,gain?'filled':'insufficient_capital']]);
 expect(p.cash!.curve[7].cash).toBeCloseTo(gain?71.52:59.52,10);expect(p.trades).toHaveLength(gain?2:1);
 if(gain)expect((p.trades[1].entryPrice+.03)*6).toBeGreaterThan(c.cash!.initialCapital);
});
