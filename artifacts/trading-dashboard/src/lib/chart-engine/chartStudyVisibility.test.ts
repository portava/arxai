import {describe,it,expect,vi} from 'vitest';
import {NativeChartStudies} from './nativeChartStudies';
import {StudyCalculator,type ChartStudy} from './chartStudies';
import {validatePreferences} from './chartWorkspace';
const bars=Array.from({length:30},(_,i)=>({time:60+i*60,open:100+i,high:102+i,low:99+i,close:101+i}));
const rsi:ChartStudy={kind:'rsi',id:'rsi',period:2,color:'#ff0000',visibleIntervals:['M15']};
describe('interval-specific study display',()=>{
 it('retains restrictions, explicit hidden-all and strict validation',()=>{
  expect(validatePreferences({studies:[rsi]}).studies[0]).toEqual(rsi);
  expect(validatePreferences({studies:[{...rsi,visibleIntervals:[]}]}).studies[0]!.visibleIntervals).toEqual([]);
  for(const visibleIntervals of [['M15','invented'],['M15','M15'],'M15',null,['W1']])expect(validatePreferences({studies:[{...rsi,visibleIntervals}]}).studies).toEqual([]);
 });
 it('hides an unmatched pane without deleting settings, changing values or recalculating on an interval change',()=>{
  const m=new NativeChartStudies();m.setStudies([rsi],bars);expect(m.paneCount).toBe(0);expect(m.getStudies()).toHaveLength(1);
  const points=m.getRenderStudies()[0]!.points,spy=vi.spyOn(StudyCalculator.prototype,'calculate');
  m.setTimeframe('15m');expect(m.paneCount).toBe(1);expect(m.getRenderStudies()[0]!.points).toBe(points);expect(spy).not.toHaveBeenCalled();
  m.setTimeframe('H1');expect(m.paneCount).toBe(0);expect(m.getValues(bars.at(-1)!.time)[0]!.values[0]).toMatchObject({name:'RSI (hidden)',value:100});
  expect(m.getValues(bars.at(-1)!.time)[0]!.displayLabel).toContain('hidden on H1');spy.mockRestore();
 });
 it('keeps hidden source calculations and pane ownership for a visible linked overlay',()=>{
  const child:ChartStudy={id:'ma',kind:'sma',period:2,color:'#ffffff',studySource:{studyId:'rsi',channel:0},visibleIntervals:['H1']};
  const m=new NativeChartStudies();m.setTimeframe('H1');m.setStudies([child,rsi],bars);
  expect(m.paneCount).toBe(1);expect(m.getDisplayStudies().find(s=>s.config.id==='rsi')!.intervalHidden).toBe(true);
  expect(m.getValues(bars.at(-1)!.time)[0]!.values[0]!.value).toBe(100);expect(m.getPriceBounds({from:0,to:29})).toEqual([]);
  m.setTimeframe('M1');expect(m.paneCount).toBe(0);expect(m.getDisplayStudies()).toEqual([]);
 });
 it('excludes hidden price overlays from autoscale and compacts remaining pane indices',()=>{
  const m=new NativeChartStudies();m.setTimeframe('H1');m.setStudies([{kind:'sma',id:'price',period:2,color:'#ffffff',visibleIntervals:['M15']},rsi,{kind:'atr',id:'atr',period:2,color:'#ffffff',visibleIntervals:['H1']}],bars);
  expect(m.paneCount).toBe(1);expect(m.getDisplayStudies().map(s=>[s.config.id,s.paneIndex])).toEqual([['atr',1]]);expect(m.getPriceBounds({from:0,to:29})).toEqual([]);
 });
});
