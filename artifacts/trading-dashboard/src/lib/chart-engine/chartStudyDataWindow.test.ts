import {it,expect} from 'vitest';
import {NativeChartStudies} from './nativeChartStudies';
import {StudyCalculator,type ChartStudy} from './chartStudies';
import {validatePreferences} from './chartWorkspace';
import {executeStudyRequest,parseStudyRequest} from './chartStudyAssistant';
const candles=Array.from({length:40},(_,i)=>({time:60+i*60,open:100+i,high:102+i,low:99+i,close:101+i}));
const rsi:ChartStudy={kind:'rsi',id:'r',period:2,color:'#ffffff'};
it('persists an independent boolean without accepting truthy invalid values',()=>{
 for(const showInDataWindow of [true,false])expect(validatePreferences({studies:[{...rsi,showInDataWindow}]}).studies[0]).toEqual({...rsi,showInDataWindow});
 for(const showInDataWindow of ['false',0,1,null,[]])expect(validatePreferences({studies:[{...rsi,showInDataWindow}]}).studies).toEqual([]);
 expect(validatePreferences({studies:[rsi]}).studies[0]).toEqual(rsi);
});
it('changes readout metadata without changing calculations, visible plots or linked values',()=>{
 const model=new NativeChartStudies();const child:ChartStudy={kind:'sma',id:'s',period:2,color:'#00ff00',studySource:{studyId:'r',channel:0}};
 model.setStudies([rsi,child],candles);const before=model.getRenderStudies().map(s=>s.points),panes=model.paneCount;
 model.setStudies([{...rsi,showInDataWindow:false},child],candles);
 expect(model.getValues(candles.at(-1)!.time)[0]).toMatchObject({dataWindowVisible:false,values:[{name:'RSI',value:100}]});
 expect(model.getValues(candles.at(-1)!.time)[1]!.values[0]!.value).toBe(100);
 expect(model.paneCount).toBe(panes);expect(model.getDisplayStudies()).toHaveLength(2);
 model.getRenderStudies().forEach((s,i)=>expect(s.points).toBe(before[i]));
 const calc=new StudyCalculator(rsi);expect(calc.updatePresentation({...rsi,showInDataWindow:false})).toBe(true);
});
it('Eleanor can explain the real hidden readout without overriding its preference',()=>{
 let studies:ChartStudy[]=[{...rsi,showInDataWindow:false}];const model=new NativeChartStudies();model.setStudies(studies,candles);
 const reply=executeStudyRequest(parseStudyRequest('explain RSI')!,{studies,symbol:'EURUSD',timeframe:'M1',feedLabel:'Offline synthetic',adapter:{setStudies:next=>model.setStudies(next,candles),getStudyValues:t=>model.getValues(t),getVisibleCandles:()=>candles},save:next=>{studies=next;}});
 expect(reply).toContain('RSI: 100');expect(studies[0]!.showInDataWindow).toBe(false);
});
