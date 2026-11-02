import {it,expect,vi} from 'vitest';
import {NativeChartStudies, planNativeStudyScaleLabels, paintNativeStudyScaleLabels} from './nativeChartStudies';
import {StudyCalculator,type ChartStudy} from './chartStudies';
import {validatePreferences} from './chartWorkspace';
import {prepareNativePriceSeries,createNativePriceFrame} from './nativePriceRenderer';
const bars=Array.from({length:40},(_,i)=>({time:60+i*60,open:100+i,high:102+i,low:99+i,close:101+i}));
const sma:ChartStudy={kind:'sma',id:'s',period:2,color:'#abcdef'};
function setup(configs:ChartStudy[],range={from:0,to:42}){
 const model=new NativeChartStudies();model.setStudies(configs,bars);
 const result=createNativePriceFrame(prepareNativePriceSeries(bars),{plot:{left:8,top:18,width:600,height:300},range,style:'candles',scale:'linear'});
 if(!result.ok)throw Error(result.reason);
 return {model,frame:result.frame};
}
it('validates persisted scale visibility independently and keeps calculation checkpoints',()=>{
 for(const value of [true,false])expect(validatePreferences({studies:[{...sma,showOnScale:value}]}).studies[0]).toEqual({...sma,showOnScale:value});
 for(const value of ['true',1,null,[]])expect(validatePreferences({studies:[{...sma,showOnScale:value}]}).studies).toEqual([]);
 const {model}=setup([sma]);const old=model.getRenderStudies()[0]!.points;
 model.setStudies([{...sma,showOnScale:true}],bars);expect(model.getRenderStudies()[0]!.points).toBe(old);
 expect(new StudyCalculator(sma).updatePresentation({...sma,showOnScale:true})).toBe(true);
});
it('opts in, uses the exact latest observation and never backfills absent points',()=>{
 const {model,frame}=setup([sma]);expect(planNativeStudyScaleLabels(frame,[],model)).toEqual([]);
 model.setStudies([{...sma,showOnScale:true}],bars);
 const labels=planNativeStudyScaleLabels(frame,[],model);expect(labels).toHaveLength(1);
 expect(labels[0]).toMatchObject({time:bars.at(-1)!.time,value:139.5,channel:'SMA',paneIndex:0});
 model.setCandles(bars.slice(0,-1));expect(planNativeStudyScaleLabels(frame,[],model)).toEqual([]);
});
it('hides history-offscreen, hidden channels, interval-hidden and maximized-away labels',()=>{
 const {model,frame}=setup([{...sma,showOnScale:true}],{from:0,to:20});expect(planNativeStudyScaleLabels(frame,[],model)).toEqual([]);
 const all=setup([{...sma,showOnScale:true,lineStyles:[{visible:false}]}]);expect(planNativeStudyScaleLabels(all.frame,[],all.model)).toEqual([]);
 all.model.setStudies([{...sma,showOnScale:true,visibleIntervals:['H1']}],bars);expect(planNativeStudyScaleLabels(all.frame,[],all.model)).toEqual([]);
 model.setStudies([{...sma,showOnScale:true}],bars);expect(planNativeStudyScaleLabels(all.frame,[],model,1)).toEqual([]);
});
it('never paints over reserved trade labels; crowded rows are withheld',()=>{
 const {model,frame}=setup([{...sma,showOnScale:true}]);const first=planNativeStudyScaleLabels(frame,[],model)[0]!;
 const moved=planNativeStudyScaleLabels(frame,[],model,null,[{top:first.top,bottom:first.top+28}]);
 for(const label of moved)expect(label.top+28<=first.top-2||label.top>=first.top+30).toBe(true);
 expect(planNativeStudyScaleLabels(frame,[],model,null,[{top:0,bottom:1000}])).toEqual([]);
});
it('uses independent pane units and hides collapsed panes',()=>{
 const config:ChartStudy={kind:'rsi',id:'r',period:2,color:'#abcdef',showOnScale:true,paneScale:{mode:'fixed',min:0,max:100}};
 const {model,frame}=setup([config]);const panes=[{left:8,top:318,width:600,height:180}];
 expect(planNativeStudyScaleLabels(frame,panes,model)[0]).toMatchObject({value:100,channel:'RSI',paneIndex:1});
 model.setStudies([{...config,paneCollapsed:true}],bars);expect(planNativeStudyScaleLabels(frame,panes,model)).toEqual([]);
});

it('withholds null latest quantities, warm-up and fixed-scale outliers',()=>{
 const tick:ChartStudy={kind:'tick_volume',period:1,color:'#ffffff',showOnScale:true};
 const {model,frame}=setup([tick]);expect(planNativeStudyScaleLabels(frame,[{left:8,top:318,width:600,height:180}],model)).toEqual([]);
 model.setStudies([{...sma,period:80,showOnScale:true}],bars);expect(planNativeStudyScaleLabels(frame,[],model)).toEqual([]);
 model.setStudies([{kind:'rsi',period:2,color:'#ffffff',showOnScale:true,paneScale:{mode:'fixed',min:0,max:90}}],bars);
 expect(planNativeStudyScaleLabels(frame,[{left:8,top:318,width:600,height:180}],model)).toEqual([]);
});
it('retains original price quantities on transformed axes and linked oscillator units',()=>{
 const {model}=setup([{...sma,showOnScale:true}]);
 for(const scale of ['log','percent','indexed'] as const){
  const f=createNativePriceFrame(prepareNativePriceSeries(bars),{plot:{left:8,top:18,width:600,height:300},range:{from:0,to:42},style:'heikinAshi',scale,referencePrice:101});if(!f.ok)throw Error(f.reason);
  const row=planNativeStudyScaleLabels(f.frame,[],model)[0]!;expect(row.value).toBe(139.5);expect(row.anchorY).toBe(f.frame.priceToY(139.5));if(scale!=='log')expect(row.title).toContain('raw');
 }
 const f=setup([{kind:'rsi',id:'r',period:2,color:'#ffffff'}, {...sma,showOnScale:true,studySource:{studyId:'r',channel:0}}]);
 const row=planNativeStudyScaleLabels(f.frame,[{left:8,top:318,width:600,height:180}],f.model)[0]!;expect(row.paneIndex).toBe(1);expect(row.value).toBe(100);
});

it('connector segments never cross a reserved price badge',()=>{
 const {model,frame}=setup([{...sma,showOnScale:true}]);const anchor=planNativeStudyScaleLabels(frame,[],model)[0]!.anchorY;
 const ctx=new Proxy({} as any,{get:(t,k)=>t[k]??(t[k]=vi.fn()),set:(t,k,v)=>(t[k]=v,true)});
 paintNativeStudyScaleLabels(ctx,frame,[],model,null,[{top:anchor-8,bottom:anchor+8}]);
 expect(ctx.fillText.mock.calls.length).toBeGreaterThan(0);
 const moves=ctx.moveTo.mock.calls,ends=ctx.lineTo.mock.calls;
 for(let i=0;i<moves.length;i++){const a=moves[i][1],b=ends[i][1];expect(Math.max(a,b)<=anchor-8||Math.min(a,b)>=anchor+8).toBe(true);}
});
