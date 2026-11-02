import {describe,it,expect,vi} from 'vitest';
import {NativeChartStudies,layoutNativeStudyPanes,paintNativeStudies} from './nativeChartStudies';
import {STUDY_CATALOG,StudyCalculator,studyDefinition,studyLabel,type ChartStudy} from './chartStudies';
import {validatePreferences} from './chartWorkspace';
import {TRADE_VOLUME_AUTHORITY} from './chartVolume';
import {prepareNativePriceSeries,createNativePriceFrame,type NativePriceFrame} from './nativePriceRenderer';
import {projectVolumeProfile} from './chartVolumeProfilePrimitive';
import type {ChartEngineCandle} from './types';
const identity='a'.repeat(64);
const bars=(count=150):ChartEngineCandle[]=>Array.from({length:count},(_,i)=>{const close=100+Math.sin(i/4)*10+i*.03;return {time:60+i*60,open:close-.3,high:close+1,low:close-1,close,
  volumeEvidence:{kind:'real_volume',unit:'provider_trade_units',quantity:100+i,reason:null,authority:TRADE_VOLUME_AUTHORITY,seriesIdentity:identity},
  profileEvidence:{finality:'closed',clockAuthority:TRADE_VOLUME_AUTHORITY}};});
function setup(kind:ChartStudy['kind'],input=bars()){
  const config=structuredClone(STUDY_CATALOG.find(item=>item.defaults.kind===kind)!.defaults);
  if(kind==='vwap')config.vwapAnchor={kind:'observed_bar',time:input[0]!.time,seriesIdentity:identity};
  if(kind==='volume_profile')config.profileRange={kind:'observed_range',fromTime:input[0]!.time,toTime:input.at(-1)!.time,seriesIdentity:identity,clockAuthority:TRADE_VOLUME_AUTHORITY};
  if(kind==='tick_volume')for(const bar of input)bar.volumeEvidence={kind:'tick_count',unit:'ticks',quantity:bar.time/60,reason:null};
  return {config,input};
}
function expected(config:ChartStudy,input:ChartEngineCandle[]){const calc=new StudyCalculator(validatePreferences({studies:[config]}).studies[0]!);calc.calculate(input);return calc;}
function frame(input:ChartEngineCandle[],scale:'linear'|'log'|'percent'='linear'):NativePriceFrame{
  const result=createNativePriceFrame(prepareNativePriceSeries(input),{plot:{left:20,top:10,width:700,height:300},range:{from:0,to:input.length-1},style:'candles',scale,referencePrice:input[0]!.close});if(!result.ok)throw Error(result.reason);return result.frame;
}
function context(){
  const paths:{op:string;args:any[];stroke?:string;fill?:string;width?:number;dash?:number[]}[]=[];
  const ctx:any={strokeStyle:'inherited',fillStyle:'inherited',lineWidth:99,dash:[],save:vi.fn(),restore:vi.fn(),setLineDash(value:number[]){this.dash=value;paths.push({op:'dash',args:[value]});}};
  for(const op of ['beginPath','rect','clip','moveTo','lineTo','stroke','fillRect','strokeRect','fillText'])ctx[op]=(...args:any[])=>paths.push({op,args,stroke:ctx.strokeStyle,fill:ctx.fillStyle,width:ctx.lineWidth,dash:[...ctx.dash]});
  return {ctx:ctx as CanvasRenderingContext2D,paths};
}
describe('native study model reuses the established catalog calculations',()=>{
  it('covers exactly the current23 kinds and honors validated configuration limits',()=>{expect(STUDY_CATALOG).toHaveLength(23);const model=new NativeChartStudies();model.setStudies([{kind:'invented',period:1,color:'#ffffff'} as any],bars());expect(model.getStudies()).toEqual([]);model.setStudies(Array.from({length:20},(_,i)=>({kind:'sma' as const,id:`s${i}`,period:2,color:'#ffffff'})),bars());expect(model.getStudies()).toHaveLength(12);});
  it.each(STUDY_CATALOG.map(item=>item.defaults.kind))('%s values and reasons match the canonical calculator across corrections and replay',kind=>{
    const {config,input}=setup(kind),model=new NativeChartStudies();model.setStudies([config],input);
    const check=(current:ChartEngineCandle[])=>{const calc=expected(config,current),actual=model.getRenderStudies()[0]!;expect(actual.points).toEqual(calc.points);expect(actual.profile).toEqual(calc.profileResult);
      if(kind!=='volume_profile')expect(model.getValues(current.at(-1)!.time)[0]!.values.map(item=>item.value)).toEqual(calc.points.at(-1)!.values.map(value=>Number.isFinite(value)?value:null));};
    check(input);const revised=structuredClone(input);revised[75]!.close+=.2;model.setCandles(revised);check(revised);
    const truncated=revised.slice(0,80);model.setCandles(truncated);check(truncated);if(kind==='volume_profile')expect(model.getProfiles()[0]!.result.status).toBe('held');else expect(model.getValues(input.at(-1)!.time)[0]!.values.every(value=>value.value===null)).toBe(true);
    model.setCandles(revised);check(revised);
  });
  it('passes the unchanged evidence-aware prefix to reused calculators and starts new calculations at0',()=>{
    const {config,input}=setup('ema'),model=new NativeChartStudies(),spy=vi.spyOn(StudyCalculator.prototype,'calculate');model.setStudies([config],input);spy.mockClear();
    const next=structuredClone(input);next.at(-1)!.close+=.1;model.setCandles(next);expect(spy.mock.calls[0]![1]).toBe(input.length-1);
    spy.mockClear();delete next[30]!.volumeEvidence;model.setCandles(next);expect(spy.mock.calls[0]![1]).toBe(30);
    spy.mockRestore();
  });
  it('presentation-only updates reuse checkpoints without confusing ids, and changed math rebuilds',()=>{
    const {config,input}=setup('ema'),model=new NativeChartStudies();model.setStudies([{...config,id:'one'}],input);const spy=vi.spyOn(StudyCalculator.prototype,'updatePresentation');
    model.setStudies([{...config,id:'one',color:'#ff0000',lineStyles:[{visible:false}]}],input);expect(spy.mock.results[0]!.value).toBe(true);expect(model.getValues(input.at(-1)!.time)[0]!.values[0]!.name).toBe('EMA (hidden)');
    model.setStudies([{...config,id:'one',period:3}],input);expect(model.getRenderStudies()[0]!.points).toEqual(expected({...config,period:3},input).points);spy.mockRestore();
  });
  it.each(['vwap','trade_volume','volume_profile'] as const)('withdraws %s when an unchanged OHLC bar loses qualified volume',kind=>{
    const {config,input}=setup(kind),model=new NativeChartStudies();model.setStudies([config],input);const original=model.getRenderStudies()[0]!;
    delete input[20]!.volumeEvidence;model.setCandles(input);const next=model.getRenderStudies()[0]!;expect(next.profile??next.points).toEqual(expected(config,input).profileResult??expected(config,input).points);
    if(kind==='volume_profile')expect(model.getProfiles()[0]!.result.status).toBe('held');else expect(model.getValues(input[20]!.time)[0]!.values[0]!.value).toBeNull();
    expect(original.profile?.status??original.points[20]!.values[0]).not.toBe(kind==='volume_profile'?'held':null);
  });
  it('profile clock withdrawal recalculates and reset retains configuration but no future observations',()=>{
    const {config,input}=setup('volume_profile'),model=new NativeChartStudies();model.setStudies([config],input);input[5]!.profileEvidence!.clockAuthority=null;model.setCandles(input);expect(model.getProfiles()[0]!.result.status).toBe('held');
    model.reset();expect(model.getStudies()).toHaveLength(1);expect(model.getRenderStudies()[0]!.points).toEqual([]);expect(model.getProfiles()[0]!.result.status).toBe('held');
  });
  it('snapshots do not retain caller-mutable candles/configs or expose mutable points',()=>{
    const {config,input}=setup('ema'),model=new NativeChartStudies();config.lineStyles=[{color:'#123456'}];model.setStudies([config],input);const old=model.getRenderStudies(),oldValue=old[0]!.points.at(-1)!.values[0];
    input.at(-1)!.close=999;config.lineStyles[0]!.color='#ffffff';expect(model.getStudies()[0]!.lineStyles![0]!.color).toBe('#123456');expect(()=>{(old[0]!.points.at(-1)!.values as any)[0]=999;}).toThrow();
    model.setCandles(bars(20));expect(old[0]!.points.at(-1)!.values[0]).toBe(oldValue);expect(old[0]!.points.length).toBe(150);
  });
  it('uses exact observed times, preserving whitespace and refusing nearest-bar substitutions',()=>{
    const {config,input}=setup('sma'),model=new NativeChartStudies();model.setStudies([config],input);expect(model.getValues(61)[0]!.values[0]!.value).toBeNull();expect(model.getValues(NaN)[0]!.values[0]!.value).toBeNull();expect(model.getValues(60)[0]!.values[0]!.value).toBeNull();
  });
});
describe('study panes and price bounds',()=>{
  it('allocates3:1 panes with independent exact geometry and refuses crowded/invalid layouts',()=>{
    const layout=layoutNativeStudyPanes({left:20,top:10,width:700,height:500},2)!;expect(layout.price).toEqual({left:20,top:10,width:700,height:300});expect(layout.panes).toEqual([{left:20,top:310,width:700,height:100},{left:20,top:410,width:700,height:100}]);
    expect(layoutNativeStudyPanes({left:0,top:0,width:200,height:159},1)).toBeNull();expect(layoutNativeStudyPanes({left:0,top:0,width:200,height:500},12)).toBeNull();expect(layoutNativeStudyPanes({left:0,top:0,width:Infinity,height:500},1)).toBeNull();expect(layoutNativeStudyPanes({left:0,top:0,width:200,height:99},0)!.price.height).toBe(99);
  });
  it('auxiliary values and hidden channels do not enter price autoscale',()=>{
    const input=bars(),model=new NativeChartStudies();model.setStudies([{kind:'sma',period:2,color:'#ffffff',lineStyles:[{visible:false}]},STUDY_CATALOG.find(item=>item.defaults.kind==='rsi')!.defaults],input);expect(model.paneCount).toBe(1);expect(model.getPriceBounds({from:100,to:140})).toEqual([]);
    model.setStudies([{kind:'sma',period:2,color:'#ffffff'}],input);const values=model.getPriceBounds({from:100,to:140});expect(values).toHaveLength(41);expect(values).toEqual(expected({kind:'sma',period:2,color:'#ffffff'},input).points.slice(100,141).map(point=>point.values[0]));
  });
  it('includes visible ready profile price limits, and removes them when hidden/held',()=>{
    const {config,input}=setup('volume_profile'),model=new NativeChartStudies();model.setStudies([config],input);expect(model.getPriceBounds({from:100,to:140}).length).toBeGreaterThan(0);model.setStudies([{...config,lineStyles:[{visible:false}]}],input);expect(model.getPriceBounds({from:100,to:140})).toEqual([]);model.setStudies([config],input.slice(0,5));expect(model.getPriceBounds({from:0,to:4})).toEqual([]);
  });
});
describe('native study Canvas painter',()=>{
  it('lifts the line pen over a missing observed volume without inventing zero',()=>{
    const input=bars(8);for(const b of input)b.volumeEvidence={kind:'tick_count',unit:'ticks',quantity:10,reason:null};delete input[3]!.volumeEvidence;
    // Use the canonical calculator's null-bearing points through a line study
    // snapshot fixture; this isolates painter gap behavior from volume bars.
    const model=new NativeChartStudies();model.setStudies([{kind:'tick_volume',period:1,color:'#123456'}],input);
    const original=model.getRenderStudies()[0]!;vi.spyOn(model,'getRenderStudies').mockReturnValue([{...original,config:{kind:'rsi',period:1,color:'#123456'}}]);
    const {ctx,paths}=context();paintNativeStudies(ctx,frame(input),[{left:20,top:320,width:700,height:100}],model);
    const moves=paths.filter(path=>path.op==='moveTo'&&path.stroke==='#123456');expect(moves).toHaveLength(2);expect(moves[1]!.args[0]).toBe(frame(input).timeToX(input[4]!.time));
  });
  it('respects hidden channels and custom line color width and dash',()=>{
    const input=bars(30),model=new NativeChartStudies();model.setStudies([{kind:'bollinger',period:3,multiplier:2,color:'#111111',lineStyles:[{visible:false},{color:'#123456',width:3,style:'dotted'},{visible:false}]}],input);
    const {ctx,paths}=context();paintNativeStudies(ctx,frame(input),[],model);const strokes=paths.filter(path=>path.op==='stroke');expect(strokes).toHaveLength(1);expect(strokes[0]).toMatchObject({stroke:'#123456',width:3,dash:[2,3]});
  });
  it('MACD negative histogram grows below its independent zero and is unchanged by main logarithmic/percent scale',()=>{
    const {config,input}=setup('macd'),model=new NativeChartStudies();model.setStudies([config],input);const panes=[{left:20,top:320,width:700,height:100}];
    const first=context();paintNativeStudies(first.ctx,frame(input),panes,model);const rects=first.paths.filter(path=>path.op==='fillRect');expect(rects.some(path=>path.fill==='#ef4444'&&path.args[3]>0)).toBe(true);expect(rects.some(path=>path.fill==='#10b981'&&path.args[3]>0)).toBe(true);
    for(const scale of ['log','percent'] as const){const other=context();paintNativeStudies(other.ctx,frame(input,scale),panes,model);expect(other.paths.filter(path=>path.op==='fillRect')).toEqual(rects);}
    const zero=first.paths.find(path=>path.op==='moveTo'&&path.stroke==='#64748b')!.args[1];for(const rect of rects.filter(path=>path.fill==='#ef4444'))expect(rect.args[1]).toBeCloseTo(zero);
  });
  it('volume bars keep qualified zeros but missing evidence yields no bar',()=>{
    const input=bars(4);input.forEach((bar,i)=>bar.volumeEvidence={kind:'tick_count',quantity:i,unit:'ticks',reason:null});delete input[2]!.volumeEvidence;
    const model=new NativeChartStudies();model.setStudies([{kind:'tick_volume',period:1,color:'#123456'}],input);const {ctx,paths}=context();paintNativeStudies(ctx,frame(input),[{left:20,top:320,width:700,height:100}],model);
    const rects=paths.filter(path=>path.op==='fillRect');expect(rects).toHaveLength(3);expect(rects[0]!.args[3]).toBe(0);expect(model.getValues(input[0]!.time)[0]!.values[0]!.value).toBe(0);expect(model.getValues(input[2]!.time)[0]!.values[0]!.value).toBeNull();
  });
  it('paints exact shared profile geometry and labels estimates rather than observed trades-at-price',()=>{
    const {config,input}=setup('volume_profile',bars(8)),model=new NativeChartStudies();model.setStudies([config],input);const f=frame(input),profile=model.getProfiles()[0]!.result;
    const geometry=projectVolumeProfile(profile,p=>f.priceToY(p)!-f.plot.top,f.plot.width,f.plot.height);const {ctx,paths}=context();paintNativeStudies(ctx,f,[],model);
    expect(paths.filter(path=>path.op==='fillRect').map(path=>path.args)).toEqual(geometry.map(row=>[f.plot.left+row.x,f.plot.top+row.y,row.width,row.height]));expect(paths.some(path=>path.op==='fillText'&&path.args[0]==='Estimated profile')).toBe(true);
  });
  it('refuses missing panes instead of silently omitting configured studies and isolates canvas state',()=>{
    const {config,input}=setup('rsi'),model=new NativeChartStudies();model.setStudies([config],input);const {ctx}=context();expect(()=>paintNativeStudies(ctx,frame(input),[],model)).toThrow('pane layout');
    paintNativeStudies(ctx,frame(input),[{left:20,top:320,width:700,height:100}],model);expect(ctx.save).toHaveBeenCalledTimes(2);expect(ctx.restore).toHaveBeenCalledTimes(2);
  });
  it('clips every pane and only requests loaded observation timestamps',()=>{
    const {config,input}=setup('sma'),model=new NativeChartStudies();model.setStudies([config],input);const original=frame(input),times:number[]=[];
    const restricted={...original,timeToX:(time:number)=>{times.push(time);return original.timeToX(time);}};const {ctx,paths}=context();paintNativeStudies(ctx,restricted,[],model);
    expect(paths.some(path=>path.op==='rect'&&JSON.stringify(path.args)===JSON.stringify([20,10,700,300]))).toBe(true);expect(times.every(time=>input.some(bar=>bar.time===time))).toBe(true);
  });
});

it('reuses only immutable unchanged point prefixes; caller configs remain editable',()=>{
  const {config,input}=setup('vwap'),model=new NativeChartStudies();config.lineStyles=[{color:'#123456'}];model.setStudies([config],input);const old=model.getRenderStudies()[0]!;
  expect(Object.isFrozen(config)).toBe(false);expect(Object.isFrozen(config.lineStyles)).toBe(false);expect(Object.isFrozen(config.lineStyles[0])).toBe(false);expect(Object.isFrozen(config.vwapAnchor)).toBe(false);
  const revised=structuredClone(input);revised.at(-1)!.close+=.1;model.setCandles(revised);const current=model.getRenderStudies()[0]!;
  expect(current.points[50]).toBe(old.points[50]);expect(current.points.at(-1)).not.toBe(old.points.at(-1));
  model.setStudies([{...config,color:'#ffffff'}],revised);expect(model.getRenderStudies()[0]!.points).toBe(current.points);
  model.setStudies([{kind:'sma',period:2,color:'#ffffff'}],revised);expect(model.getRenderStudies()[0]!.points[50]).not.toBe(current.points[50]);
});
it('empty study configurations never inspect or copy candle objects',()=>{
  const bar={get time(){throw Error('should not read unused history');}} as ChartEngineCandle;
  const model=new NativeChartStudies();expect(()=>model.setCandles([bar])).not.toThrow();expect(model.getRenderStudies()).toEqual([]);
});
it('freezing profile preferences does not freeze the saved caller range',()=>{
  const {config,input}=setup('volume_profile'),model=new NativeChartStudies();model.setStudies([config],input);expect(Object.isFrozen(config.profileRange)).toBe(false);config.profileRange!.fromTime=120;expect(model.getStudies()[0]!.profileRange!.fromTime).toBe(60);
});

it('pane quantity labels preserve exact count digits and map to actual range values',()=>{
  const input=bars(4);input.forEach((bar,i)=>bar.volumeEvidence={kind:'tick_count',quantity:123456789+i,unit:'ticks',reason:null});
  const model=new NativeChartStudies();model.setStudies([{kind:'tick_volume',period:1,color:'#123456'}],input);const {ctx,paths}=context();paintNativeStudies(ctx,frame(input),[{left:20,top:320,width:700,height:100}],model);
  const high=paths.find(path=>path.op==='fillText'&&path.args[0]==='123456792')!;expect(high).toBeDefined();expect(high.args[2]).toBeGreaterThan(320);expect(high.args[2]).toBeLessThan(340);
  const zero=paths.find(path=>path.op==='fillText'&&path.args[0]==='0')!;expect(zero.args[2]).toBeLessThan(420);
});
function rangedFrame(input:ChartEngineCandle[],from:number,to:number,scale:'linear'|'log'='linear'){
  const result=createNativePriceFrame(prepareNativePriceSeries(input),{plot:{left:20,top:10,width:700,height:300},range:{from,to},style:'candles',scale});if(!result.ok)throw Error(result.reason);return result.frame;
}
it('offscreen histogram spikes cannot flatten the visible auxiliary pane',()=>{
  const input=bars(30);input.forEach((bar,i)=>bar.volumeEvidence={kind:'tick_count',unit:'ticks',quantity:i===9?1e12:10,reason:null});
  const model=new NativeChartStudies();model.setStudies([{kind:'tick_volume',period:1,color:'#123456'}],input);const {ctx,paths}=context();paintNativeStudies(ctx,rangedFrame(input,10,20),[{left:20,top:320,width:700,height:100}],model);
  expect(paths.some(path=>path.op==='fillText'&&path.args[0]==='1000000000000')).toBe(false);expect(paths.some(path=>path.op==='fillText'&&path.args[0]==='10')).toBe(true);
  const visible=paths.filter(path=>path.op==='fillRect'&&path.args[0]>=20&&path.args[0]<=720);expect(visible.every(path=>path.args[3]>50)).toBe(true);
});
it('fractional price overlay bounds use clipped line crossings instead of offscreen extrema',()=>{
  const input=bars(25);input.forEach((bar,i)=>{const value=i===9?1000:i===11?20:i===12?30:10;bar.open=bar.close=value;bar.high=value+1;bar.low=value-1;});
  const model=new NativeChartStudies();model.setStudies([{kind:'sma',period:1,color:'#123456'}],input);
  const values=model.getPriceBounds({from:9.9,to:11.1});expect(Math.max(...values)).toBeCloseTo(109,10);expect(Math.min(...values)).toBe(10);
});
it('no overlay line is invented across a null warmup boundary',()=>{
  const input=bars(25),model=new NativeChartStudies();model.setStudies([{kind:'sma',period:11,color:'#123456'}],input);expect(model.getPriceBounds({from:9.1,to:9.9})).toEqual([]);
});
it('auxiliary labels occupy the reserved right gutter, not the data plot',()=>{
  const {config,input}=setup('macd'),model=new NativeChartStudies();model.setStudies([config],input);const {ctx,paths}=context();paintNativeStudies(ctx,frame(input),[{left:20,top:320,width:700,height:100}],model);
  const labels=paths.filter(path=>path.op==='fillText'&&typeof path.args[0]==='string'&&!path.args[0].startsWith('MACD'));expect(labels).toHaveLength(2);expect(labels.every(path=>path.args[1]===726&&path.args[3]===76)).toBe(true);
});

it('logarithmic overlay crossings use display-space interpolation',()=>{
  const input=bars(25);input.forEach((bar,i)=>{const value=i===9?1000:i===11?20:i===12?30:10;bar.open=bar.close=value;bar.high=value+1;bar.low=value-1;});
  const model=new NativeChartStudies();model.setStudies([{kind:'sma',period:1,color:'#123456'}],input);const values=model.getPriceBounds({from:9.9,to:11.1},'log');
  expect(Math.max(...values)).toBeCloseTo(Math.exp(Math.log(20)*.9+Math.log(30)*.1),10);expect(Math.min(...values)).toBe(10);
});
it('a partially clipped histogram body still contributes its actual observation',()=>{
  const input=bars(30);input.forEach((bar,i)=>bar.volumeEvidence={kind:'tick_count',unit:'ticks',quantity:i===9?1000:10,reason:null});
  const model=new NativeChartStudies();model.setStudies([{kind:'tick_volume',period:1,color:'#123456'}],input);const {ctx,paths}=context();paintNativeStudies(ctx,rangedFrame(input,9.1,20),[{left:20,top:320,width:700,height:100}],model);
  expect(paths.some(path=>path.op==='fillText'&&path.args[0]==='1000')).toBe(true);
});
it('fractional auxiliary line bounds use visible intersections, not full offscreen neighbours',()=>{
  const input=bars(25),model=new NativeChartStudies();model.setStudies([{kind:'atr',period:1,color:'#123456'}],input);
  const original=model.getRenderStudies()[0]!;vi.spyOn(model,'getRenderStudies').mockReturnValue([{...original,points:input.map((bar,i)=>({time:bar.time,values:[i===9?1000:i===11?20:i===12?30:10]}))}]);
  const {ctx,paths}=context();paintNativeStudies(ctx,rangedFrame(input,9.9,11.1),[{left:20,top:320,width:700,height:100}],model);
  expect(paths.some(path=>path.op==='fillText'&&path.args[0]==='1000')).toBe(false);expect(paths.some(path=>path.op==='fillText'&&path.args[0]==='109')).toBe(true);
});
it('large distinct visible histories do not become a function argument list',()=>{
  // Isolate bound collection from indicator calculation cost. This immutable
  // snapshot has the same shape as the already-tested calculator snapshots.
  const model=new NativeChartStudies();const points=Array.from({length:150000},(_,i)=>({time:60+i*60,values:[i+1]}));
  (model as unknown as {snapshots:unknown}).snapshots=[{config:{kind:'sma',period:1,color:'#123456'},paneIndex:0,points}];
  expect(()=>model.getPriceBounds({from:0,to:149999})).not.toThrow();
  const values=model.getPriceBounds({from:0,to:149999});expect(values.length).toBe(150000);expect(values.at(-1)).toBe(150000);
});

it.each([false,true])('shared oscillator pane retains its axis when the source is hidden (reversed=%s)',reverse=>{
 const input=bars(50),model=new NativeChartStudies();
 const parent:ChartStudy={id:'rsi',kind:'rsi',period:2,color:'#123456',lineStyles:[{visible:false}]};
 const child:ChartStudy={id:'smooth',kind:'sma',period:2,color:'#abcdef',studySource:{studyId:'rsi',channel:0}};
 model.setStudies(reverse?[child,parent]:[parent,child],input);
 const {ctx,paths}=context();paintNativeStudies(ctx,frame(input),[{left:20,top:320,width:700,height:100}],model);
 const labels=paths.filter(p=>p.op==='fillText');
 expect(labels.filter(p=>p.args[1]>720)).toHaveLength(2);
 expect(labels.find(p=>p.args[1]===25)!.args[0]).not.toContain('· hidden');
 expect(paths.some(p=>p.op==='lineTo'&&p.stroke==='#abcdef')).toBe(true);
 expect(model.getPriceBounds({from:0,to:49})).toEqual([]);
});


it('paints a large auxiliary history without spreading observations into arguments',()=>{
 const model=new NativeChartStudies(),count=150000;
 const points=Array.from({length:count},(_,i)=>({time:60+i*60,values:[i+1]}));
 (model as unknown as {snapshots:unknown}).snapshots=[{config:{kind:'atr',period:1,color:'#123456'},paneIndex:1,points}];
 const f={...frame(bars(2)),range:{from:0,to:count-1},spacing:700/count,timeToX:(time:number)=>20+(time/60-1)*700/count};
 const {ctx}=context();expect(()=>paintNativeStudies(ctx,f,[{left:20,top:320,width:700,height:100}],model)).not.toThrow();
});
