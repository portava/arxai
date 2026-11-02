import {it,expect} from 'vitest';
import {NativeChartStudies} from './nativeChartStudies';
import {executeStudyRequest,parseStudyRequest} from './chartStudyAssistant';
import {studyDefinition,type ChartStudy} from './chartStudies';
const candles=Array.from({length:120},(_,i)=>{const close=100+Math.sin(i/7);return {time:60+i*60,open:close,high:close+1,low:close-1,close};});
const rsi:ChartStudy={...studyDefinition('rsi').defaults,id:'rsi'};
function fixture(initial:ChartStudy[]){let studies=initial;const model=new NativeChartStudies();model.setStudies(studies,candles);return {model,context:()=>({studies,symbol:'EURUSD',timeframe:'M1',feedLabel:'Offline synthetic',adapter:{setStudies:(next:ChartStudy[])=>model.setStudies(next,candles),getStudyValues:(time:number)=>model.getValues(time),getVisibleCandles:()=>candles},save:(next:ChartStudy[])=>{studies=next;}})};}
it.each(['sma','bollinger'] as const)('assistant reads actual linked %s values without inventing price-relative conclusions',kind=>{
 const child:ChartStudy={...studyDefinition(kind).defaults,id:'child',period:3,studySource:{studyId:'rsi',channel:0}};
 const f=fixture([rsi,child]);const reply=executeStudyRequest(parseStudyRequest(`show ${kind}`)!,f.context());
 const value=f.model.getValues(candles.at(-1)!.time)[1]!.values[0]!.value!;
 expect(reply).toContain(String(Number(value.toPrecision(8))));expect(reply).toContain('RSI 1 / RSI');
 expect(reply).not.toContain('underlying source candle close is');expect(reply).not.toContain('source price units');expect(reply).toContain('not candle prices');
});
it('comparison uses linked units only for the identical source channel',()=>{
 const a:ChartStudy={...studyDefinition('ema').defaults,id:'a',period:20,studySource:{studyId:'rsi',channel:0}};
 const b:ChartStudy={...a,id:'b',period:50};const f=fixture([rsi,a,b]);
 const reply=executeStudyRequest(parseStudyRequest('compare 20 EMA and 50 EMA')!,f.context());
 expect(reply).toContain('linked input units');expect(reply).not.toContain('source price units');expect(reply).not.toContain('unavailable / warming up');
});
it('comparison never compares a price average with an oscillator average',()=>{
 const a:ChartStudy={...studyDefinition('ema').defaults,id:'a',period:20,studySource:{studyId:'rsi',channel:0}};
 const b:ChartStudy={...studyDefinition('ema').defaults,id:'b',period:50};const f=fixture([rsi,a,b]);
 const reply=executeStudyRequest(parseStudyRequest('compare 20 EMA and 50 EMA')!,f.context());
 expect(reply).toContain('numerical relation is withheld');expect(reply).not.toContain('source price units');
});
it('missing source remains explicitly unavailable in the assistant receipt',()=>{
 const f=fixture([{...studyDefinition('sma').defaults,id:'child',period:3,studySource:{studyId:'missing',channel:0}}]);
 expect(executeStudyRequest(parseStudyRequest('show sma')!,f.context())).toContain('its source study or channel is missing');
});
