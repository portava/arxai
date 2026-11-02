import {it,expect} from 'vitest';
import {NativeChartStudies} from './nativeChartStudies';
import {StudyCalculator,type ChartStudy} from './chartStudies';
import {validatePreferences} from './chartWorkspace';
const candles=Array.from({length:40},(_,i)=>({time:60+i*60,open:100+i,high:102+i,low:99+i,close:101+i}));
const rsi:ChartStudy={kind:'rsi',id:'r',period:2,color:'#ffffff'};
it('round-trips only boolean status-line preferences, with old workspaces opt-out',()=>{
 for(const showInStatusLine of [true,false])expect(validatePreferences({studies:[{...rsi,showInStatusLine}]}).studies[0]).toEqual({...rsi,showInStatusLine});
 for(const showInStatusLine of ['false',0,1,null,[]])expect(validatePreferences({studies:[{...rsi,showInStatusLine}]}).studies).toEqual([]);
 expect(validatePreferences({studies:[rsi]}).studies[0]).toEqual(rsi);
});
it('retains exact calculation checkpoints, links and panes while independently exposing status values',()=>{
 const model=new NativeChartStudies(),child:ChartStudy={kind:'sma',id:'s',period:2,color:'#00ff00',studySource:{studyId:'r',channel:0}};
 model.setStudies([rsi,child],candles);const before=model.getRenderStudies().map(s=>s.points),panes=model.paneCount;
 model.setStudies([{...rsi,showInStatusLine:true,showInDataWindow:false},child],candles);
 expect(model.getValues(candles.at(-1)!.time)[0]).toMatchObject({statusLineVisible:true,dataWindowVisible:false,values:[{name:'RSI',value:100}]});
 expect(model.getValues(candles.at(-1)!.time)[1]!.statusLineVisible).not.toBe(true);
 expect(model.getValues(candles.at(-1)!.time)[1]!.values[0]!.value).toBe(100);
 expect(model.paneCount).toBe(panes);model.getRenderStudies().forEach((s,i)=>expect(s.points).toBe(before[i]));
 expect(new StudyCalculator(rsi).updatePresentation({...rsi,showInStatusLine:true})).toBe(true);
});
it('never substitutes another candle for missing selected observations and marks hidden plots',()=>{
 const model=new NativeChartStudies();model.setTimeframe('M15');model.setStudies([{...rsi,showInStatusLine:true,visibleIntervals:['H1']}],candles);
 const missing=model.getValues(61)[0]!;expect(missing.statusLineVisible).toBe(true);expect(missing.values[0]!.value).toBeNull();expect(missing.displayLabel).toContain('hidden');
 expect(model.getValues(candles[0]!.time)[0]!.values[0]!.value).toBeNull();
 model.setStudies([{...rsi,showInStatusLine:false}],candles);expect(model.getValues(candles.at(-1)!.time)[0]!.statusLineVisible).not.toBe(true);
});
