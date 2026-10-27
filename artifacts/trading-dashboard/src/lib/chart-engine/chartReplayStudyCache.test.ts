import {describe,expect,it} from 'vitest';
import {StudyCalculator,STUDY_CATALOG,type ReplayStudyContext} from './chartStudies';
import {MAX_REPLAY_BARS} from './chartReplayLimits';
const context:ReplayStudyContext={sessionId:'replay-one',ownerId:7,source:'deriv_public',sourceIdentity:'a'.repeat(64),symbol:'V75',timeframe:'M15'};
const bars=(count:number)=>Array.from({length:count},(_,i)=>({time:100+i*900,open:100+Math.sin(i/7),high:103+Math.sin(i/7),low:97+Math.sin(i/7),close:100+Math.cos(i/3)}));
const cache=(calc:StudyCalculator)=>(calc as any).replayCache;
describe('earned Replay study checkpoints',()=>{
  it.each(STUDY_CATALOG)('$name matches full recomputation through rewinds, mutations, corrections and prepends',({defaults})=>{
    const calc=new StudyCalculator(defaults),original=bars(240);
    const verify=(input:typeof original,scope=context)=>{
      calc.calculateReplay(input,scope);
      expect(calc.points).toEqual(new StudyCalculator(defaults).calculate(input));
      expect(calc.points).toHaveLength(input.length);
      expect((calc as any).states).toHaveLength(input.length);
    };
    verify(original.slice(0,20));expect(cache(calc).count).toBe(20);
    verify(original);expect(cache(calc).points[239]).toBeUndefined();
    verify(original.slice(0,1));const earned=cache(calc).points[239];expect(cache(calc).count).toBe(240);expect(calc.points.at(-1)?.time).toBe(original[0]!.time);
    verify(original);expect(calc.points[239]).toBe(earned); // genuine reuse, not recomputation
    const corrected=original.map((bar,i)=>i===80?{...bar,close:101.7}:bar);
    verify(corrected.slice(0,100));expect(cache(calc).count).toBe(100); // unseen old suffix discarded
    verify(corrected);expect(calc.points[239]).not.toBe(earned);
    verify([{...original[0]!,time:1},...original]);
    verify(original.slice(100));verify([]);expect(cache(calc)).toBeNull();verify(original.slice(0,1));
  });
  it.each(STUDY_CATALOG)('$name invalidates same-close OHLC/time corrections and matches full values',({defaults})=>{
    const original=bars(180);
    for(const field of ['open','high','low','time'] as const){
      const config={...defaults,source:'ohlc4' as const},calc=new StudyCalculator(config);
      calc.calculateReplay(original,context);const prior=calc.points[179];
      calc.calculateReplay(original.slice(0,20),context);
      const corrected=original.map((bar,i)=>i===60?{...bar,[field]:bar[field]+(field==='low'?-1:1)}:bar);
      expect(corrected[60]!.close).toBe(original[60]!.close);
      calc.calculateReplay(corrected,context);
      expect(calc.points).toEqual(new StudyCalculator(config).calculate(corrected));
      expect(calc.points[179]).not.toBe(prior);
      expect(cache(calc).inputs[60*5+['time','open','high','low','close'].indexOf(field)]).toBe(corrected[60]![field]);
    }
  });
  it.each(STUDY_CATALOG)('$name matches repeated corrections after rewind and subsequent growth',({defaults})=>{
    const config={...defaults,source:'ohlc4' as const},calc=new StudyCalculator(config);
    let input=bars(280);
    const verify=(count:number)=>{
      const prefix=input.slice(0,count);
      calc.calculateReplay(prefix,context);
      expect(calc.points).toEqual(new StudyCalculator(config).calculate(prefix));
      expect(calc.points).toHaveLength(count);
      expect((calc as any).states).toHaveLength(count);
    };
    verify(240);verify(40);
    input=input.map((bar,i)=>i===70?{...bar,high:bar.high+2}:bar);
    verify(100);expect(cache(calc).count).toBe(100);
    verify(280);verify(20);
    input=input.map((bar,i)=>i===30?{...bar,open:bar.open-1,low:bar.low-2}:bar);
    verify(60);expect(cache(calc).count).toBe(60);
    verify(280);verify(1);
    input=input.map((bar,i)=>i===130?{...bar,time:bar.time+1,close:bar.close+0.25}:bar);
    verify(150);expect(cache(calc).count).toBe(150);
    verify(280);verify(80);verify(280);
  });
  it('never reads an unrevealed input and protects private output values before materialization',()=>{
    const calc=new StudyCalculator(STUDY_CATALOG[1]!.defaults),full=bars(100);
    const prefix=new Proxy(full.slice(0,1),{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key)&&Number(key)>=1)throw new Error('future bar accessed');return Reflect.get(target,key,receiver);}});
    calc.calculateReplay(prefix,context);expect(cache(calc).count).toBe(1);expect(cache(calc).points).toHaveLength(1);expect(cache(calc).points[0]).toBeUndefined();
    const expected=structuredClone(calc.points);calc.points[0]!.values[0]=9;calc.points[0]!.time=999;
    calc.calculateReplay(prefix,context);expect(calc.points).toEqual(expected);
    expect(Object.isFrozen(calc.points[0])).toBe(true);expect(Object.isFrozen(calc.points[0]!.values)).toBe(true);
    expect(()=>{calc.points[0]!.values[0]=9;}).toThrow();
  });
  it('copies identity inputs so mutation of caller objects or arrays cannot poison earned checkpoints',()=>{
    const input=bars(100),original=structuredClone(input),calc=new StudyCalculator(STUDY_CATALOG[0]!.defaults);
    calc.calculateReplay(input,context);calc.calculateReplay(input.slice(0,1),context);const last=cache(calc).points[99];
    input[50]!.close=999;input.reverse();
    calc.calculateReplay(original,context);expect(calc.points[99]).toBe(last);
    expect(calc.points).toEqual(new StudyCalculator(STUDY_CATALOG[0]!.defaults).calculate(original));
    calc.calculateReplay(original.slice(0,20),context);expect(cache(calc).inputs[50*5+4]).toBe(original[50]!.close);
  });
  it.each(['sessionId','ownerId','source','sourceIdentity','symbol','timeframe'] as const)('invalidates %s identity even when prices match',field=>{
    const calc=new StudyCalculator(STUDY_CATALOG[0]!.defaults),input=bars(100);
    calc.calculateReplay(input,context);const old=calc.points[99];
    const next={...context,[field]:field==='ownerId'?8:field==='sourceIdentity'?'b'.repeat(64):String(context[field])+'-changed'};
    calc.calculateReplay(input,next);expect(calc.points[99]).not.toBe(old);expect(cache(calc).key).not.toBe(JSON.stringify(context));
    expect(calc.points).toEqual(new StudyCalculator(STUDY_CATALOG[0]!.defaults).calculate(input));
  });
  it('invalidates config mutation, falls back on invalid context and never retains native-live history',()=>{
    const config={...STUDY_CATALOG[0]!.defaults},calc=new StudyCalculator(config),input=bars(100);
    calc.calculateReplay(input,context);const old=calc.points[99];config.period=3;
    calc.calculateReplay(input,context);expect(calc.points[99]).not.toBe(old);expect(calc.points).toEqual(new StudyCalculator(config).calculate(input));
    calc.calculate(input.slice(0,20),20);expect(cache(calc)).toBeNull();expect(calc.points).toHaveLength(20);
    calc.calculateReplay(input,{...context,sourceIdentity:''});expect(cache(calc)).toBeNull();
    calc.calculateReplay(input,context);calc.clearReplayCache();expect(cache(calc)).toBeNull();
  });
  it('does not let mutable first-reveal outputs poison private values earned on the first rewind',()=>{
    const input=bars(180),config=STUDY_CATALOG.find(d=>d.defaults.kind==='macd')!.defaults,calc=new StudyCalculator(config);
    const expected=new StudyCalculator(config).calculate(input);
    calc.calculateReplay(input,context);
    expect(cache(calc).points.every((point:any)=>point==null)).toBe(true);
    calc.points[80]!.values.fill(999);calc.points[179]={time:1,values:[999,999,999]};
    calc.calculateReplay(input.slice(0,1),context);expect(calc.points).toEqual(expected.slice(0,1));
    expect(cache(calc).points).toHaveLength(180);expect(cache(calc).points.every(Object.isFrozen)).toBe(true);
    calc.calculateReplay(input,context);expect(calc.points).toEqual(expected);
    const revised=input.map((bar,i)=>i===20?{...bar,high:bar.high+1}:bar);
    calc.calculateReplay(revised.slice(0,40),context);expect(cache(calc).count).toBe(40);
    expect(Array.from(cache(calc).inputs.slice(40*5,180*5)).every(Number.isNaN)).toBe(true);
    expect(Array.from(cache(calc).outputs.slice(40*3,180*3)).every(Number.isNaN)).toBe(true);
    calc.calculateReplay(revised,context);expect(calc.points).toEqual(new StudyCalculator(config).calculate(revised));
  });
  it('preserves signed zero, null and normalized nonfinite channels through packed restoration',()=>{
    const input=Array.from({length:8},(_,i)=>({time:100+i,open:-0,high:0,low:-0,close:-0}));
    input[0]={time:100,open:1,high:1,low:1,close:1};
    const calc=new StudyCalculator({...STUDY_CATALOG.find(d=>d.defaults.kind==='momentum')!.defaults,period:1});
    calc.calculateReplay(input,context);expect(Object.is(calc.points[1]!.values[0],-0)).toBe(true);const expected=structuredClone(calc.points);
    calc.calculateReplay(input.slice(0,1),context);calc.calculateReplay(input,context);
    expect(calc.points).toEqual(expected);
    expect(Object.is(calc.points[1]!.values[0],-0)).toBe(true);
    for(let i=1;i<input.length;i++)expect(Object.is(cache(calc).inputs[i*5+4],-0)).toBe(true);
    const bad=input.map((bar,i)=>i===4?{...bar,close:Infinity}:bar);
    calc.calculateReplay(bad,context);const normalized=new StudyCalculator(calc.config).calculate(bad);
    calc.calculateReplay(bad.slice(0,1),context);calc.calculateReplay(bad,context);
    expect(calc.points).toEqual(normalized);expect(calc.points.every(p=>p.values.every(v=>v===null||Number.isFinite(v)))).toBe(true);
  });
  it('bounds retained history and opts unknown future study kinds out',()=>{
    const calc=new StudyCalculator(STUDY_CATALOG[0]!.defaults),input=bars(MAX_REPLAY_BARS+1);
    calc.calculateReplay(input.slice(0,MAX_REPLAY_BARS),context);expect(cache(calc).count).toBe(MAX_REPLAY_BARS);
    calc.calculateReplay(input,context);expect(cache(calc)).toBeNull();expect(calc.points).toHaveLength(input.length);
    const future=new StudyCalculator({...STUDY_CATALOG[0]!.defaults,kind:'future-volume-study' as any});
    future.calculateReplay(input.slice(0,1),context);expect(cache(future)).toBeNull();
  });
});
