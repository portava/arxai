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
    verify(original.slice(0,20));expect(cache(calc).inputs).toHaveLength(20);
    verify(original);const earned=cache(calc).points[239];
    verify(original.slice(0,1));expect(cache(calc).inputs).toHaveLength(240);expect(calc.points.at(-1)?.time).toBe(original[0]!.time);
    verify(original);expect(calc.points[239]).toBe(earned); // genuine reuse, not recomputation
    const corrected=original.map((bar,i)=>i===80?{...bar,close:101.7}:bar);
    verify(corrected.slice(0,100));expect(cache(calc).inputs).toHaveLength(100); // unseen old suffix discarded
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
      expect(cache(calc).inputs[60][field]).toBe(corrected[60]![field]);
    }
  });
  it('never reads or calculates an unrevealed input and freezes reused output values',()=>{
    const calc=new StudyCalculator(STUDY_CATALOG[1]!.defaults),full=bars(100);
    const prefix=new Proxy(full.slice(0,1),{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key)&&Number(key)>=1)throw new Error('future bar accessed');return Reflect.get(target,key,receiver);}});
    calc.calculateReplay(prefix,context);expect(cache(calc).inputs).toHaveLength(1);expect(cache(calc).points).toHaveLength(1);
    expect(Object.isFrozen(calc.points[0])).toBe(true);expect(Object.isFrozen(calc.points[0]!.values)).toBe(true);
    expect(()=>{calc.points[0]!.values[0]=9;}).toThrow();
  });
  it('copies identity inputs so mutation of caller objects or arrays cannot poison earned checkpoints',()=>{
    const input=bars(100),original=structuredClone(input),calc=new StudyCalculator(STUDY_CATALOG[0]!.defaults);
    calc.calculateReplay(input,context);const last=cache(calc).points[99];
    input[50]!.close=999;input.reverse();
    calc.calculateReplay(original,context);expect(calc.points[99]).toBe(last);
    expect(calc.points).toEqual(new StudyCalculator(STUDY_CATALOG[0]!.defaults).calculate(original));
    calc.calculateReplay(original.slice(0,20),context);expect(cache(calc).inputs[50].close).toBe(original[50]!.close);
  });
  it.each(['sessionId','ownerId','source','sourceIdentity','symbol','timeframe'] as const)('invalidates %s identity even when prices match',field=>{
    const calc=new StudyCalculator(STUDY_CATALOG[0]!.defaults),input=bars(100);
    calc.calculateReplay(input,context);const old=cache(calc).points[99];
    const next={...context,[field]:field==='ownerId'?8:field==='sourceIdentity'?'b'.repeat(64):String(context[field])+'-changed'};
    calc.calculateReplay(input,next);expect(calc.points[99]).not.toBe(old);expect(cache(calc).key).not.toBe(JSON.stringify(context));
    expect(calc.points).toEqual(new StudyCalculator(STUDY_CATALOG[0]!.defaults).calculate(input));
  });
  it('invalidates config mutation, falls back on invalid context and never retains native-live history',()=>{
    const config={...STUDY_CATALOG[0]!.defaults},calc=new StudyCalculator(config),input=bars(100);
    calc.calculateReplay(input,context);const old=cache(calc).points[99];config.period=3;
    calc.calculateReplay(input,context);expect(calc.points[99]).not.toBe(old);expect(calc.points).toEqual(new StudyCalculator(config).calculate(input));
    calc.calculate(input.slice(0,20),20);expect(cache(calc)).toBeNull();expect(calc.points).toHaveLength(20);
    calc.calculateReplay(input,{...context,sourceIdentity:''});expect(cache(calc)).toBeNull();
    calc.calculateReplay(input,context);calc.clearReplayCache();expect(cache(calc)).toBeNull();
  });
  it('bounds retained history and opts unknown future study kinds out',()=>{
    const calc=new StudyCalculator(STUDY_CATALOG[0]!.defaults),input=bars(MAX_REPLAY_BARS+1);
    calc.calculateReplay(input.slice(0,MAX_REPLAY_BARS),context);expect(cache(calc).inputs).toHaveLength(MAX_REPLAY_BARS);
    calc.calculateReplay(input,context);expect(cache(calc)).toBeNull();expect(calc.points).toHaveLength(input.length);
    const future=new StudyCalculator({...STUDY_CATALOG[0]!.defaults,kind:'future-volume-study' as any});
    future.calculateReplay(input.slice(0,1),context);expect(cache(future)).toBeNull();
  });
});
