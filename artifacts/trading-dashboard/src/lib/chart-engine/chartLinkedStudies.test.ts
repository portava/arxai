import {describe,it,expect} from 'vitest';
import {NativeChartStudies} from './nativeChartStudies';
import {validatePreferences} from './chartWorkspace';
import {StudyCalculator,type ChartStudy} from './chartStudies';
const bars=(values:number[])=>values.map((close,i)=>({time:60+i*60,open:close,high:close+1,low:close-1,close}));
const base:ChartStudy={id:'rsi',kind:'rsi',period:2,color:'#ffffff'};
const linked:ChartStudy={id:'smooth',kind:'sma',period:2,color:'#00ffff',studySource:{studyId:'rsi',channel:0}};
const data=bars([10,12,10,14,12,16,14,12,15]);
const run=(configs:ChartStudy[],input=data)=>{const m=new NativeChartStudies();m.setStudies(configs,input);return m;};
describe('linked study source authority',()=>{
 it('calculates SMA of RSI, keeps its warmup blank and shares oscillator units without changing price bounds',()=>{
  const m=run([base,linked]),out=m.getRenderStudies();
  expect(out[1]!.points.slice(0,3).map(p=>p.values[0])).toEqual([null,null,null]);
  const rsi=out[0]!.points.map(p=>p.values[0]);
  for(let i=3;i<data.length;i++)expect(out[1]!.points[i]!.values[0]).toBeCloseTo((rsi[i-1]!+rsi[i]!)/2);
  expect(out.map(s=>s.paneIndex)).toEqual([1,1]);expect(m.paneCount).toBe(1);expect(m.getPriceBounds({from:0,to:8})).toEqual([]);
 });
 it('preserves a typed reference in saved settings and does not turn a missing parent into close prices',()=>{
  expect(validatePreferences({studies:[linked]}).studies[0]!.studySource).toEqual(linked.studySource);
  const out=run([linked]).getRenderStudies()[0]!;expect(out.points.every(p=>p.values[0]===null)).toBe(true);expect(out.points[4]!.reason).toMatch(/unavailable/i);
 });
 it('calculates dependencies regardless of display order and updates descendants after parent parameter changes',()=>{
  const m=run([linked,base]);expect(m.getRenderStudies()[0]!.points).toEqual(run([base,linked]).getRenderStudies()[1]!.points);
  m.setStudies([linked,{...base,period:3}],data);
  expect(m.getRenderStudies()[0]!.points).toEqual(run([{...base,period:3},linked]).getRenderStudies()[1]!.points);
  expect(m.getRenderStudies()[0]!.points).not.toEqual(run([base,linked]).getRenderStudies()[1]!.points);
 });
 it('holds cycles, invalid channels and dependents instead of silently falling back',()=>{
  const cases=[[{...base,studySource:{studyId:'smooth',channel:0}},linked],[base,{...linked,studySource:{studyId:'rsi',channel:8}}]];
  for(const configs of cases){const out=run(configs).getRenderStudies();expect(out.at(-1)!.points.every(p=>p.values.every(v=>v===null))).toBe(true);}
 });
 it('resets a smoothing warmup after missing source values; zero is a real observation',()=>{
  const input=data.map((bar,i)=>({...bar,volumeEvidence:i===4?undefined:{kind:'tick_count' as const,unit:'ticks' as const,quantity:i===2?0:i+1,reason:null}}));
  const m=run([{id:'ticks',kind:'tick_volume',period:1,color:'#ffffff'},{...linked,studySource:{studyId:'ticks',channel:0}}],input);
  expect(m.getRenderStudies()[1]!.points.map(p=>p.values[0])).toEqual([null,1.5,1,2,null,null,6.5,7.5,8.5]);
 });
 it('keeps every prefix causal and corrections/appends/replay equal a fresh dependency calculation',()=>{
  const configs=[base,linked,{...linked,id:'second',kind:'ema' as const,studySource:{studyId:'smooth',channel:0}}];
  const m=run(configs),revised=data.map(b=>({...b}));revised[4]!.close+=.5;
  m.setCandles(revised);expect(m.getRenderStudies()).toEqual(run(configs,revised).getRenderStudies());
  m.setCandles(revised.slice(0,6));expect(m.getRenderStudies()).toEqual(run(configs,revised.slice(0,6)).getRenderStudies());
  m.setCandles(revised);expect(m.getRenderStudies()).toEqual(run(configs,revised).getRenderStudies());
  for(let n=1;n<data.length;n++)expect(run(configs,data.slice(0,n)).getRenderStudies().map(s=>s.points)).toEqual(run(configs).getRenderStudies().map(s=>s.points.slice(0,n)));
 });
 it('never computes a linked study without explicitly supplied parent observations',()=>{
  expect(new StudyCalculator(linked).calculate(data).every(p=>p.values[0]===null)).toBe(true);
 });
});
it('withdraws and restores existing descendants when a parent disappears or returns without candle changes',()=>{
 const m=run([base,linked]);const original=m.getRenderStudies()[1]!.points;
 m.setStudies([linked],data);expect(m.getRenderStudies()[0]!.points.every(p=>p.values[0]===null)).toBe(true);
 m.setStudies([base,linked],data);expect(m.getRenderStudies()[1]!.points).toEqual(original);
});
it('selects a specific signed MACD channel, preserves hidden inputs and frozen source settings',()=>{
 const macd:ChartStudy={id:'macd',kind:'macd',period:2,slow:3,signal:2,color:'#ffffff',lineStyles:[{visible:false}]};
 const selected={...linked,studySource:{studyId:'macd',channel:2}};
 const m=run([macd,selected]);const p=m.getRenderStudies()[0]!.points;
 for(let i=4;i<data.length;i++)expect(m.getRenderStudies()[1]!.points[i]!.values[0]).toBeCloseTo((p[i-1]!.values[2]!+p[i]!.values[2]!)/2);
 expect(Object.isFrozen(m.getStudies()[1]!.studySource)).toBe(true);
 selected.studySource.channel=0;expect(m.getStudies()[1]!.studySource!.channel).toBe(2);
 m.setStudies([macd,selected],data);expect(m.getRenderStudies()[1]!.points).toEqual(run([macd,selected]).getRenderStudies()[1]!.points);
});
it('restarts ROC across missing source bars rather than joining disconnected observations',()=>{
 const calc=new StudyCalculator({...linked,kind:'roc'});
 const values=[1,2,null,4,5,6,7,8,9];
 expect(calc.calculate(data,0,true,{points:data.map((b,i)=>({time:b.time,values:[values[i]!]})),channel:0}).map(p=>p.values[0])).toEqual([null,null,null,null,null,50,100*(7/5-1),100*(8/6-1),100*(9/7-1)]);
});
it('rejects unsupported and malformed persisted source references without converting them to price studies',()=>{
 for(const patch of [{studyId:'rsi',channel:-1},{studyId:'rsi',channel:1.5},{studyId:'bad:id',channel:0},'rsi'])expect(validatePreferences({studies:[{...linked,studySource:patch}]}).studies).toEqual([]);
 expect(validatePreferences({studies:[{...linked,kind:'atr'}]}).studies).toEqual([]);
});
it('requires exact matching parent timestamps and never substitutes a nearby value',()=>{
 const calc=new StudyCalculator({...linked,period:1});
 const points=data.map(b=>({time:b.time+1,values:[999]}));
 expect(calc.calculate(data,0,true,{points,channel:0}).every(p=>p.values[0]===null)).toBe(true);
});

it('releases dependency checkpoints after removing every study',()=>{
 const model=run([base,linked]);model.setStudies([],data);
 expect(model.getRenderStudies()).toEqual([]);expect(model.paneCount).toBe(0);
 expect((model as unknown as {bindings:Map<unknown,unknown>}).bindings.size).toBe(0);
});
