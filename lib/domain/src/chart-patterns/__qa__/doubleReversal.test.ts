import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChartPatterns } from '../patternEngine.js';
import type { ChartPatternCandle } from '../types.js';
const row=(close:number):ChartPatternCandle=>({open:close-.05,high:close+.2,low:close-.2,close,isComplete:true,isForming:false});
function interpolate(points:number[][]):ChartPatternCandle[]{
 return Array.from({length:points.at(-1)![0]!+1},(_,i)=>{const j=points.findIndex(p=>p[0]!>=i);const b=points[j]!,a=points[Math.max(0,j-1)]!;return row(a[0]===b[0]?a[1]!:a[1]!+(b[1]!-a[1]!)*(i-a[0]!)/(b[0]!-a[0]!));});
}
const fixture=(second=105)=>interpolate([[0,90],[8,96],[12,105],[20,99],[28,second],[30,102],[31,98],[32,97]]);
const mirror=(bars:ChartPatternCandle[])=>bars.map(c=>({...c,open:220-c.open,high:220-c.low,low:220-c.high,close:220-c.close}));
for(const bottom of [false,true]){
 const label=bottom?'bottom':'top';
 const find=(bars:ChartPatternCandle[])=>detectChartPatterns(bottom?mirror(bars):bars).patterns.find(p=>p.id===(bottom?'double_bottom':'double_top'));
 test(`${label}: formation and confirmation record actual causal bars`,()=>{
  const forming=find(fixture().slice(0,31));assert.ok(forming);assert.equal(forming.status,'forming');
  assert.equal(forming.doubleReversalLifecycle?.formationKnownAtIndex,30);
  assert.deepEqual(forming.keyPoints.map(p=>p.index),[12,20,28]);
  for(const length of [32,33]){const p=find(fixture().slice(0,length));assert.ok(p);assert.equal(p.status,'confirmed');assert.equal(p.doubleReversalLifecycle?.confirmedIndex,31);}
 });
 test(`${label}: invalidation after confirmation cannot revive`,()=>{
  const p=find([...fixture(),row(108),row(98)]);assert.ok(p);assert.equal(p.status,'invalidated');assert.equal(p.doubleReversalLifecycle?.failedIndex,33);assert.equal(p.doubleReversalLifecycle?.confirmedIndex,31);
 });
 test(`${label}: failure before confirmation stays invalidated`,()=>{
  const p=find([...fixture().slice(0,31),row(108),row(98)]);assert.ok(p);assert.equal(p.status,'invalidated');assert.equal(p.doubleReversalLifecycle?.failedIndex,31);assert.equal(p.doubleReversalLifecycle?.confirmedIndex,null);
 });
 test(`${label}: future volatility cannot qualify an unequal old pair`,()=>{
  const bars=fixture(107);assert.equal(find(bars),undefined);
  assert.equal(find([...bars,{...row(96),high:150,low:50}]),undefined);
 });
 test(`${label}: future quiet bars cannot erase qualifying frozen geometry`,()=>{
  const bars=fixture(105.4),a=find(bars);assert.ok(a);
  const b=find([...bars,...Array.from({length:30},()=>({...row(97),open:97,high:97.01,low:96.99}))]);assert.ok(b);
  assert.deepEqual(b.levels,a.levels);assert.equal(b.doubleReversalLifecycle?.frozenAtr,a.doubleReversalLifecycle?.frozenAtr);assert.equal(b.doubleReversalLifecycle?.confirmedIndex,31);
 });
 test(`${label}: a reversal needs the preceding observed directional context`,()=>{
  const bars=fixture();for(let i=7;i<12;i++)bars[i]=row(100);
  assert.equal(find(bars),undefined);
 });
 test(`${label}: already beyond the neckline when the shape becomes known is not a later crossing`,()=>{
  const bars=fixture();bars[29]=row(98);bars[30]=row(97);bars[31]=row(96);bars[32]=row(95);
  const p=find(bars);assert.ok(p);assert.equal(p.status,'forming');assert.equal(p.doubleReversalLifecycle?.confirmedIndex,null);
 });
 test(`${label}: a wick alone cannot confirm and forming tails do not alter evidence`,()=>{
  const bars=fixture().slice(0,31),wick={...row(100),low:95};
  const p=find([...bars,wick]);assert.ok(p);assert.equal(p.status,'forming');
  assert.deepEqual(find([...bars,{...row(95),isComplete:false,isForming:true}]),find(bars));
 });
 test(`${label}: future prefixes retain formation ATR, levels and first confirmation`,()=>{
  const bars=[...fixture(),row(100),row(99),row(98)],a=find(bars.slice(0,31));assert.ok(a?.doubleReversalLifecycle);
  for(let n=32;n<=bars.length;n++){const p=find(bars.slice(0,n));assert.ok(p);assert.deepEqual(p.levels,a.levels);assert.equal(p.doubleReversalLifecycle?.frozenAtr,a.doubleReversalLifecycle.frozenAtr);assert.deepEqual(p.doubleReversalLifecycle?.formationIndexes,[12,20,28]);assert.equal(p.doubleReversalLifecycle?.confirmedIndex,31);}
 });
 test(`${label}: formation waits for bar24 and never confirms on its first knowable bar`,()=>{
  const bars=interpolate([[0,90],[8,105],[14,99],[20,105],[22,102],[23,98],[24,97]]);
  assert.equal(find(bars.slice(0,23)),undefined);
  const p=find(bars);assert.ok(p);assert.equal(p.doubleReversalLifecycle?.formationKnownAtIndex,23);assert.equal(p.status,'forming');
  bars[23]=row(108);assert.equal(find(bars),undefined,'A shape invalidated before minimum history must not be created later');
 });
 test(`${label}: equal adjacent plateau bars are not invented strict pivots`,()=>{
  const bars=fixture();bars[27]={...bars[28]!};assert.equal(find(bars),undefined);
 });
 test(`${label}: a genuinely new formation can replace an older invalidated event`,()=>{
  const bars=interpolate([[0,90],[8,96],[12,105],[20,99],[28,105],[30,102],[31,98],[32,97],[33,108],[34,98],[38,98],[44,110],[52,102],[60,110],[62,106],[63,101]]);
  const p=find(bars);assert.ok(p);assert.deepEqual(p.doubleReversalLifecycle?.formationIndexes,[44,52,60]);assert.equal(p.doubleReversalLifecycle?.confirmedIndex,63);assert.equal(p.doubleReversalLifecycle?.failedIndex,null);
 });
 test(`${label}: frozen ATR agrees with a separate true-range sum and source indexes preserve offsets`,()=>{
  const bars=fixture(),offset=40, shifted=[...Array.from({length:offset},()=>row(89)),...bars],p=find(shifted);assert.ok(p?.doubleReversalLifecycle);
  let total=0;for(let i=17;i<=30;i++){const c=bars[i]!,prev=bars[i-1]!;total+=Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close));}
  assert.ok(Math.abs(p.doubleReversalLifecycle.frozenAtr-total/14)<1e-12);
  assert.deepEqual(p.doubleReversalLifecycle.formationIndexes,[52,60,68]);assert.equal(p.doubleReversalLifecycle.confirmedIndex,71);
 });
 test(`${label}: minimum history and bounded source context are enforced`,()=>{
  assert.equal(find(fixture().slice(0,23)),undefined);
  assert.equal(find([...fixture(),...Array.from({length:590},()=>row(97))]),undefined);
 });
}
