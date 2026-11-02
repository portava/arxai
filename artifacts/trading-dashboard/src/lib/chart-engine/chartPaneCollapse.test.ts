import {it,expect} from 'vitest';
import {NativeChartStudies,layoutNativeStudyPanes,paintNativeStudies} from './nativeChartStudies';
import {validatePreferences} from './chartWorkspace';
import {prepareNativePriceSeries,createNativePriceFrame} from './nativePriceRenderer';
import type {ChartStudy} from './chartStudies';
const bars=Array.from({length:80},(_,i)=>({time:1700000000+i*60,open:100+i,high:102+i,low:99+i,close:101+i}));
const rsi:ChartStudy={id:'rsi',kind:'rsi',period:14,color:'#ffffff'};
const sma:ChartStudy={id:'sma',kind:'sma',period:3,color:'#00ff00',studySource:{studyId:'rsi',channel:0}};
it('persists explicit collapse only on pane owners',()=>{
 for(const paneCollapsed of [true,false])expect(validatePreferences({studies:[{...rsi,paneCollapsed}]}).studies[0]?.paneCollapsed).toBe(paneCollapsed);
 for(const paneCollapsed of [1,'true',null])expect(validatePreferences({studies:[{...rsi,paneCollapsed}]}).studies).toEqual([]);
 expect(validatePreferences({studies:[{...sma,paneCollapsed:true}]}).studies).toEqual([]);
});
it('retains linked calculations and readouts while the entire pane is collapsed',()=>{
 const model=new NativeChartStudies();model.setTimeframe('M15');model.setStudies([rsi,sma],bars);const points=model.getRenderStudies().map(s=>s.points);const values=model.getValues(bars.at(-1)!.time).map(s=>s.values);
 model.setStudies([sma,{...rsi,paneCollapsed:true,paneWeight:3,visibleIntervals:[]}],bars);
 expect(model.getPaneCollapsed()).toEqual([true]);expect(model.getPaneWeights()).toEqual([3]);
 expect(model.getRenderStudies()[0]!.points).toBe(points[1]);expect(model.getRenderStudies()[1]!.points).toBe(points[0]);
 expect(model.getValues(bars.at(-1)!.time)[0]!.values).toEqual(values[1]);expect(model.getValues(bars.at(-1)!.time)[0]!.displayLabel).toContain('pane collapsed');
 model.setStudies([sma,{...rsi,paneCollapsed:false,paneWeight:3}],bars);expect(model.getPaneCollapsed()).toEqual([false]);
});
it('reclaims collapsed space with a labelled strip while preserving open minima',()=>{
 const plot={left:8,top:8,width:700,height:400};
 const normal=layoutNativeStudyPanes(plot,2,[3,1])!;
 const collapsed=layoutNativeStudyPanes(plot,2,[3,1],[true,false])!;
 expect(collapsed.panes[0]!.height).toBe(24);expect(collapsed.price.height).toBeGreaterThan(normal.price.height);expect(collapsed.panes[1]!.height).toBeGreaterThan(normal.panes[1]!.height);
 for(let count=1;count<=12;count++){
  const layout=layoutNativeStudyPanes({...plot,height:100+count*24},count,Array(count).fill(1),Array(count).fill(true))!;
  expect(layout).not.toBeNull();expect(layout.price.height).toBe(100);expect(layout.panes.every(p=>p.height===24)).toBe(true);
 }
 expect(layoutNativeStudyPanes({...plot,height:123},1,[1],[true])).toBeNull();
 expect(layoutNativeStudyPanes(plot,2,[1,1],[true])).toBeNull();
});
it('paints a collapsed title but no indicator geometry or axis values',()=>{
 const model=new NativeChartStudies();model.setStudies([{...rsi,paneCollapsed:true},sma],bars);
 const calls:{op:string;args:any[]}[]=[];const ctx:any={};for(const op of ['save','restore','beginPath','rect','clip','setLineDash','moveTo','lineTo','stroke','fillRect','fillText'])ctx[op]=(...args:any[])=>calls.push({op,args});
 const result=createNativePriceFrame(prepareNativePriceSeries(bars),{plot:{left:8,top:8,width:700,height:300},range:{from:0,to:79},style:'candles',scale:'linear',referencePrice:bars[0]!.close});expect(result.ok).toBe(true);if(!result.ok)return;
 paintNativeStudies(ctx,result.frame,[{left:8,top:308,width:700,height:24}],model);
 const text=calls.filter(c=>c.op==='fillText');expect(text).toHaveLength(1);expect(text[0]!.args[0]).toContain('collapsed');expect(calls.filter(c=>c.op==='lineTo')).toHaveLength(1);expect(calls.filter(c=>c.op==='fillRect')).toHaveLength(0);
});

it('keeps mixed collapsed and open panes finite and readable over fractional extents',()=>{
 for(let count=1;count<=12;count++)for(const extra of [0,.1,17.3,500])for(const weight of [.25,1,8]){
  const flags=Array.from({length:count},(_,i)=>i%2===0),n=flags.filter(Boolean).length,height=100+n*24+(count-n)*40+extra;
  const layout=layoutNativeStudyPanes({left:8,top:8,width:700,height},count,Array(count).fill(weight),flags)!;
  expect(layout).not.toBeNull();expect(layout.price.height).toBeGreaterThanOrEqual(100);
  layout.panes.forEach((pane,i)=>{expect(pane.height).toBeGreaterThanOrEqual(flags[i]?24:40);if(flags[i])expect(pane.height).toBe(24);});
  const end=layout.panes.at(-1)!;expect(end.top+end.height).toBeCloseTo(8+height,9);
 }
});
