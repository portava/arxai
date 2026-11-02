import {it,expect} from 'vitest';
import {anchoredPaneScale} from './anchoredPaneScale';
import {validatePreferences} from './chartWorkspace';
import {NativeChartStudies} from './nativeChartStudies';
import type {ChartStudy} from './chartStudies';
it('pins the chosen value at its percentage from the bottom and retains the observed span',()=>{
 for(const percent of [0,5,25,50,95,100]){
  const mapping=anchoredPaneScale(20,80,50,percent)!;
  expect(mapping.fraction(50)).toBe(percent/100);
  expect(mapping.high-mapping.low).toBeCloseTo(60*1.16);
  expect(mapping.fraction(mapping.low)).toBeCloseTo(0);expect(mapping.fraction(mapping.high)).toBeCloseTo(1);
 }
});
it('keeps finite zero, constant and extreme display ranges or explicitly refuses them',()=>{
 for(const [low,high,value] of [[0,0,0],[50,50,50],[-1e300,1e300,0],[1e-300,2e-300,1e-300]]){
  const m=anchoredPaneScale(low,high,value,50)!;expect(m).not.toBeNull();expect(Number.isFinite(m.low)&&Number.isFinite(m.high)&&m.high>m.low).toBe(true);expect(m.fraction(value)).toBe(.5);
 }
 for(const args of [[0,1,0,-1],[0,1,0,101],[0,1,NaN,50],[2,1,0,50],[-Number.MAX_VALUE,Number.MAX_VALUE,Number.MAX_VALUE,50]])expect(anchoredPaneScale(...args as [number,number,number,number])).toBeNull();
});
it('persists anchored settings only on pane owners without recalculating observations',()=>{
 const config:ChartStudy={kind:'rsi',id:'r',period:2,color:'#ffffff'},paneScale={mode:'line' as const,value:50,percent:25};
 expect(validatePreferences({studies:[{...config,paneScale}]}).studies[0]).toEqual({...config,paneScale});
 for(const value of ['50',null,NaN,Infinity])expect(validatePreferences({studies:[{...config,paneScale:{...paneScale,value}}]}).studies).toEqual([]);
 for(const percent of [-1,101,'50',null])expect(validatePreferences({studies:[{...config,paneScale:{...paneScale,percent}}]}).studies).toEqual([]);
 expect(validatePreferences({studies:[{...config,kind:'sma',paneScale}]}).studies).toEqual([]);
 const bars=Array.from({length:20},(_,i)=>({time:60+i*60,open:100+i,high:102+i,low:99+i,close:101+i})),model=new NativeChartStudies();model.setStudies([config],bars);const points=model.getRenderStudies()[0]!.points;
 model.setStudies([{...config,paneScale}],bars);expect(model.getRenderStudies()[0]!.points).toBe(points);
});

it('matches Auto fallback for zero and constant observations and refuses a lost observed span',()=>{
 expect(anchoredPaneScale(0,0,0,50)).toMatchObject({low:-.01,high:.01});
 expect(anchoredPaneScale(50,50,50,50)).toMatchObject({low:49.5,high:50.5});
 expect(anchoredPaneScale(20,80,1e20,50)).toBeNull();
 expect(anchoredPaneScale(20,80,1e200,50)).toBeNull();
});
