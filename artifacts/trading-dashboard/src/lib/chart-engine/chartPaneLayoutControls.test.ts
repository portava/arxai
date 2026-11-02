import {describe,it,expect} from 'vitest';
import {NativeChartStudies,layoutNativeStudyPanes} from './nativeChartStudies';
import {validatePreferences} from './chartWorkspace';
import type {ChartStudy} from './chartStudies';
const bars=Array.from({length:80},(_,i)=>({time:1700000000+i*60,open:100+i,high:102+i,low:99+i,close:101+i}));
const rsi:ChartStudy={id:'rsi',kind:'rsi',period:14,color:'#ffffff'};
const macd:ChartStudy={id:'macd',kind:'macd',period:12,slow:26,signal:9,color:'#ff0000'};
describe('native pane layout controls',()=>{
 it('preserves valid weights and rejects invalid values and overlay ownership',()=>{
  for(const paneWeight of [.25,1,2.5,8])expect(validatePreferences({studies:[{...rsi,paneWeight}]}).studies[0]?.paneWeight).toBe(paneWeight);
  for(const paneWeight of [0,.24,8.01,Infinity,NaN,'2',null])expect(validatePreferences({studies:[{...rsi,paneWeight}]}).studies).toEqual([]);
  expect(validatePreferences({studies:[{kind:'sma',period:10,color:'#ffffff',paneWeight:2}]}).studies).toEqual([]);
 });
 it('weights visible panes without changing default geometry or violating minimum space',()=>{
  const plot={left:8,top:8,width:700,height:500};
  const normal=layoutNativeStudyPanes(plot,2)!;expect(layoutNativeStudyPanes(plot,2,[1,1])).toEqual(normal);
  const weighted=layoutNativeStudyPanes(plot,2,[4,.25])!;
  expect(weighted.panes[0]!.height).toBeGreaterThan(normal.panes[0]!.height);
  expect(weighted.price.height).toBeGreaterThanOrEqual(100);expect(weighted.panes[1]!.height).toBeGreaterThanOrEqual(40);
  expect(weighted.panes.at(-1)!.top+weighted.panes.at(-1)!.height).toBeCloseTo(plot.top+plot.height,10);
  for(const weights of [[],[1],[1,0],[1,Infinity],[1,9]])expect(layoutNativeStudyPanes(plot,2,weights)).toBeNull();
 });
 it('keeps hidden-owner weights and linked math attached to the right pane after reorder',()=>{
  const linked:ChartStudy={id:'sma',kind:'sma',period:3,color:'#00ff00',studySource:{studyId:'rsi',channel:0}};
  const model=new NativeChartStudies();model.setTimeframe('M15');model.setStudies([rsi,linked,macd],bars);
  const numbers=()=>Object.fromEntries(model.getRenderStudies().map(s=>[s.config.id,s.points]));const before=numbers();
  model.setStudies([linked,macd,{...rsi,paneWeight:3,visibleIntervals:[]}],bars);
  expect(model.getPaneWeights()).toEqual([1,3]);expect(numbers()).toEqual(before);
  expect(model.getRenderStudies().find(s=>s.config.id==='sma')!.points).toBe(before.sma);
  expect(model.getDisplayStudies().find(s=>s.config.id==='sma')!.paneIndex).toBe(2);
 });
});
it('does not overflow weighted layout for extreme finite extents',()=>{
 const result=layoutNativeStudyPanes({left:0,top:0,width:700,height:Number.MAX_VALUE},1,[8])!;
 expect(result).not.toBeNull();for(const p of [result.price,...result.panes])expect([p.top,p.height,p.top+p.height].every(Number.isFinite)).toBe(true);
 const end=result.panes[0]!.top+result.panes[0]!.height;
 // The exact boundary may lie between representable sums; accept at most one
 // relative machine epsilon of unused geometry, never an infinite extent.
 expect(end).toBeLessThanOrEqual(Number.MAX_VALUE);
 expect(Number.MAX_VALUE-end).toBeLessThanOrEqual(Number.MAX_VALUE*Number.EPSILON);
});
