import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChartPatterns } from '../patternEngine.js';
import type { ChartPatternCandle } from '../types.js';
const row=(close:number,half=.2):ChartPatternCandle=>({open:close,high:close+half,low:close-half,close,isComplete:true,isForming:false});
const formation=()=>[...Array.from({length:6},()=>row(100)),...Array.from({length:8},(_,i)=>row(100+i)),...Array.from({length:6},(_,i)=>row(106.8-i*.2))];
const mirror=(bars:ChartPatternCandle[])=>bars.map(c=>({...c,open:220-c.open,high:220-c.low,low:220-c.high,close:220-c.close}));
for(const bear of [false,true]){
 const label=bear?'bear':'bull';
 const find=(bars:ChartPatternCandle[])=>detectChartPatterns(bear?mirror(bars):bars).patterns.find(p=>p.id===(bear?'bear_flag':'bull_flag'));
 test(`${label}: closed crossing confirms after a fixed six-bar channel`,()=>{
  const bars=formation(),a=find(bars);assert.ok(a);assert.equal(a.status,'forming');assert.ok(!a.keyPoints.some(p=>p.role==='flag_break'));
  const p=find([...bars,row(106.2)]);assert.ok(p);assert.equal(p.status,'confirmed');assert.equal(p.flagLifecycle?.formationKnownAtIndex,19);assert.equal(p.flagLifecycle?.confirmedIndex,20);
  assert.deepEqual([p.flagLifecycle?.poleStartIndex,p.flagLifecycle?.poleEndIndex,p.flagLifecycle?.flagStartIndex],[6,13,14]);
  assert.equal(p.keyPoints.find(p=>p.role==='flag_break')?.index,20);
 });
 test(`${label}: later data cannot rewrite formation slope, ATR, quality or first crossing`,()=>{
  const a=find([...formation(),row(106.2)]),b=find([...formation(),row(106.2),{...row(106.3),high:150,low:50}]);assert.ok(a?.flagLifecycle);assert.ok(b?.flagLifecycle);
  assert.equal(b.flagLifecycle.formationKnownAtIndex,19);assert.equal(b.flagLifecycle.channelSlope,a.flagLifecycle.channelSlope);assert.equal(b.flagLifecycle.frozenAtr,a.flagLifecycle.frozenAtr);assert.equal(b.confidence,a.confidence);assert.deepEqual(b.levels,a.levels);assert.equal(b.flagLifecycle.confirmedIndex,20);
 });
 test(`${label}: failure before confirmation is sticky through a later recovery`,()=>{
  const p=find([...formation(),row(105),row(106.2)]);assert.ok(p);assert.equal(p.status,'invalidated');assert.equal(p.flagLifecycle?.failedIndex,20);assert.equal(p.flagLifecycle?.confirmedIndex,null);assert.equal(p.flagLifecycle?.levelAtIndex,20);
 });
 test(`${label}: failure after confirmation retains the actual break`,()=>{
  const p=find([...formation(),row(106.2),row(105),row(106.4)]);assert.ok(p);assert.equal(p.status,'invalidated');assert.equal(p.flagLifecycle?.failedIndex,21);assert.equal(p.flagLifecycle?.confirmedIndex,20);assert.equal(p.flagLifecycle?.levelAtIndex,20);
 });
 test(`${label}: wick-only crossing does not confirm or invalidate`,()=>{
  const p=find([...formation(),{...row(105.6),high:109,low:101}]);assert.ok(p);assert.equal(p.status,'forming');assert.equal(p.flagLifecycle?.confirmedIndex,null);assert.equal(p.flagLifecycle?.failedIndex,null);
 });
 test(`${label}: target is a closed-candle outcome retained after retracement`,()=>{
  const p=find([...formation(),row(106.2),row(113),row(107)]);assert.ok(p);assert.equal(p.status,'exhausted');assert.equal(p.flagLifecycle?.targetReachedIndex,21);assert.equal(p.flagLifecycle?.confirmedIndex,20);
 });
 test(`${label}: target and confirmation may be observed on the same close`,()=>{
  const p=find([...formation(),row(113)]);assert.ok(p);assert.equal(p.status,'exhausted');assert.equal(p.flagLifecycle?.targetReachedIndex,20);assert.equal(p.flagLifecycle?.confirmedIndex,20);
 });
 test(`${label}: a later structural failure keeps the earlier target history`,()=>{
  const p=find([...formation(),row(106.2),row(113),row(105),row(107)]);assert.ok(p);assert.equal(p.status,'invalidated');assert.equal(p.flagLifecycle?.targetReachedIndex,21);assert.equal(p.flagLifecycle?.failedIndex,22);
 });
 test(`${label}: a narrow but deep disconnected pullback is not a flag`,()=>{
  const bars=formation();for(let i=14;i<20;i++)bars[i]=row(90-(i-14)*.2);assert.equal(find(bars),undefined);
 });
 test(`${label}: a shallow but price-gapped pullback is not a continuous channel`,()=>{
  const bars=formation();for(let i=14;i<20;i++)bars[i]=row(104.5-(i-14)*.2);assert.equal(find(bars),undefined);
 });
 test(`${label}: forming levels follow the frozen projected channel`,()=>{
  const p=find([...formation(),row(105.6)]);assert.ok(p?.flagLifecycle);const life=p.flagLifecycle;
  assert.equal(life.levelAtIndex,20);assert.equal(life.confirmedIndex,null);
  const upper=life.upperAtStart+life.channelSlope*(20-life.flagStartIndex),lower=life.lowerAtStart+life.channelSlope*(20-life.flagStartIndex);
  assert.ok(Math.abs(life.confirmationLevel-(bear?lower:upper))<1e-10);assert.ok(Math.abs(life.invalidationLevel-(bear?upper:lower))<1e-10);
 });
 test(`${label}: a converging wedge is not relabelled as a parallel flag`,()=>{
  const bars=formation();for(let i=14;i<20;i++){const c=bars[i]!;bars[i]={...c,high:c.close+(.6-(i-14)*.1),low:c.close-(.6-(i-14)*.1)};}
  assert.equal(find(bars),undefined);
 });
 test(`${label}: a single pole jump does not establish a sustained impulse`,()=>{
  const bars=formation();for(let i=6;i<14;i++)bars[i]=row(i<10?100:107);assert.equal(find(bars),undefined);
 });
 test(`${label}: an internal price gap breaks formation continuity`,()=>{
  const bars=formation();for(let i=16;i<20;i++)bars[i]=row(105.5-(i-16)*.2);assert.equal(find(bars),undefined);
 });
 test(`${label}: exact channel contact is not a strict closed breakout`,()=>{
  const a=find(formation());assert.ok(a?.flagLifecycle);const life=a.flagLifecycle;
  const boundary=(bear?life.lowerAtStart:life.upperAtStart)+life.channelSlope*(20-life.flagStartIndex);
  const p=find([...formation(),row(bear?220-boundary:boundary)]);assert.ok(p);assert.equal(p.status,'forming');assert.equal(p.flagLifecycle?.confirmedIndex,null);
 });
 test(`${label}: first confirmation and target survive every later prefix`,()=>{
  const bars=[...formation(),row(106.2),row(107),row(113),row(107),row(105),row(108)],a=find(bars.slice(0,21));assert.ok(a?.flagLifecycle);
  for(let n=22;n<=bars.length;n++){
   const p=find(bars.slice(0,n));assert.ok(p?.flagLifecycle);assert.equal(p.flagLifecycle.formationKnownAtIndex,19);assert.equal(p.flagLifecycle.confirmedIndex,20);assert.equal(p.flagLifecycle.frozenAtr,a.flagLifecycle.frozenAtr);assert.deepEqual(p.levels,a.levels);
   assert.equal(p.flagLifecycle.targetReachedIndex,n>=23?22:null);assert.equal(p.flagLifecycle.failedIndex,n>=25?24:null);
  }
 });
 test(`${label}: independent ATR and exact source index offsets match formation evidence`,()=>{
  const bars=formation(),offset=40,p=find([...Array.from({length:offset},()=>row(100)),...bars]);assert.ok(p?.flagLifecycle);
  let total=0;for(let i=6;i<=19;i++){const c=bars[i]!,prev=bars[i-1]!;total+=Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close));}
  assert.ok(Math.abs(p.flagLifecycle.frozenAtr-total/14)<1e-12);assert.equal(p.flagLifecycle.formationKnownAtIndex,59);assert.equal(p.flagLifecycle.poleStartIndex,46);
 });
 test(`${label}: a separate non-overlapping formation may replace the older event`,()=>{
  const bars=[...formation(),...Array.from({length:6},()=>row(107)),...Array.from({length:8},(_,i)=>row(107+i)),...Array.from({length:6},(_,i)=>row(113.8-i*.2))];
  const p=find(bars);assert.ok(p?.flagLifecycle);assert.ok(p.flagLifecycle.poleStartIndex>19);assert.ok(p.flagLifecycle.formationKnownAtIndex>19);
  const before=find(bars.slice(0,p.flagLifecycle.formationKnownAtIndex+1));assert.equal(before?.flagLifecycle?.formationKnownAtIndex,p.flagLifecycle.formationKnownAtIndex);
 });
 test(`${label}: old formations age out of the explicit600-bar search`,()=>{
  assert.equal(find([...formation(),...Array.from({length:600},()=>row(106))]),undefined);
 });
 for(const {offset,scale} of [{offset:1000,scale:1},{offset:946000,scale:1},{offset:.9,scale:.01},{offset:1,scale:.00001}]){
  test(`${label}: regression remains source-correct at offset${offset} scale${scale}`,()=>{
   const shiftedFormation=formation();for(let i=14;i<20;i++)shiftedFormation[i]=row(106.8-(i-14)*.17);
   const raw=[...shiftedFormation,row(106.5)],source=(bear?mirror(raw):raw).map(c=>({...c,open:c.open*scale+offset,high:c.high*scale+offset,low:c.low*scale+offset,close:c.close*scale+offset}));
   const base=find(raw),p=detectChartPatterns(source).patterns.find(p=>p.id===(bear?'bear_flag':'bull_flag'));assert.ok(base?.flagLifecycle);assert.ok(p?.flagLifecycle);
   const life=p.flagLifecycle;assert.equal(p.status,base.status);assert.equal(life.formationKnownAtIndex,19);assert.equal(life.confirmedIndex,20);
   const closes=source.slice(14,20).map(c=>c.close),origin=closes[0]!;
   // Independent centered-index covariance, avoiding subtraction of large sums.
   const expected=closes.reduce((sum,v,i)=>sum+(i-2.5)*(v-origin),0)/17.5;
   const range=Math.max(...closes)-Math.min(...closes);
   assert.ok(Math.abs(life.channelSlope-expected)<=Number.EPSILON*range*64,`source slope mismatch: ${life.channelSlope} vs ${expected}`);
   const ulpTolerance=Number.EPSILON*Math.max(...source.map(c=>Math.abs(c.close)))*64;
   assert.ok(Math.abs(life.channelSlope-base.flagLifecycle.channelSlope*scale)<=ulpTolerance);
   assert.ok(Math.abs(life.upperAtStart-(base.flagLifecycle.upperAtStart*scale+offset))<=ulpTolerance);
   assert.ok(Math.abs(life.lowerAtStart-(base.flagLifecycle.lowerAtStart*scale+offset))<=ulpTolerance);
   assert.ok(Math.abs(life.confirmationLevel-(base.flagLifecycle.confirmationLevel*scale+offset))<=ulpTolerance);
   assert.ok(Math.abs(life.invalidationLevel-(base.flagLifecycle.invalidationLevel*scale+offset))<=ulpTolerance);
  });
 }
 test(`${label}: minimum history and forming tails are respected`,()=>{
  assert.equal(find(formation().slice(0,19)),undefined);
  assert.deepEqual(find([...formation(),{...row(113),isComplete:false,isForming:true}]),find(formation()));
 });
}

test('positive-price bearish formation retains its confirmed shape with an unavailable negative target',()=>{
 const bars=[...Array.from({length:6},()=>row(100)),...Array.from({length:8},(_,i)=>row(100-i*10)),...Array.from({length:6},(_,i)=>row(30.2+i*.2)),row(30.8)];
 const p=detectChartPatterns(bars).patterns.find(p=>p.id==='bear_flag');assert.ok(p?.flagLifecycle);assert.equal(p.status,'confirmed');assert.equal(p.flagLifecycle.confirmedIndex,20);assert.equal(p.flagLifecycle.targetLevel,null);assert.equal(p.flagLifecycle.targetReachedIndex,null);assert.deepEqual(p.levels.targets,[]);assert.match(p.rationale.join(' '),/no positive.price measured target/i);
 const later=detectChartPatterns([...bars,row(1)]).patterns.find(p=>p.id==='bear_flag');assert.ok(later?.flagLifecycle);assert.equal(later.status,'confirmed');assert.equal(later.flagLifecycle.targetLevel,null);assert.equal(later.flagLifecycle.targetReachedIndex,null);assert.deepEqual(later.levels.targets,[]);
});
test('an invalid projected opposite boundary withholds the pattern instead of publishing negative prices',()=>{
 const bars=[...Array.from({length:6},()=>row(1,.02)),...Array.from({length:8},(_,i)=>row(1+i,.02)),...Array.from({length:6},(_,i)=>row(7.8-i*.2,.2))];
 for(let c=6.6;c>.09;c-=.2)bars.push(row(c,.02));
 bars.push(row(.1,.02));assert.ok(bars.every(c=>c.low>0));
 assert.equal(detectChartPatterns(bars).patterns.find(p=>p.id==='bull_flag'),undefined);
});
test('extreme finite prices cannot publish infinite rounded reference levels',()=>{
 const scale=1.6e306,bars=[...formation(),row(106.2)].map(c=>({...c,open:c.open*scale,high:c.high*scale,low:c.low*scale,close:c.close*scale}));
 assert.ok(bars.every(c=>[c.open,c.high,c.low,c.close].every(n=>Number.isFinite(n)&&n>0)));
 const p=detectChartPatterns(bars).patterns.find(p=>p.id==='bull_flag');
 assert.ok(!p || [p.levels.confirmation,p.levels.invalidation,...p.levels.targets].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0),'No unusable rounded level may escape');
});
