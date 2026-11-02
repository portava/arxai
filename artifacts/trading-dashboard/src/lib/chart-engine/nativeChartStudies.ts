import { StudyCalculator, studyVisibleAtInterval, studyIntervalSuffix, studySourceIssue, studyDefinition, studyChannelColor, studyId, studyLabel, formatStudyNumber, type ChartStudy, type StudyReferenceLevel } from './chartStudies';
import { validatePreferences, type ChartScaleMode } from './chartWorkspace';
import { unchangedCandlePrefix } from './candleReconciliation';
import { sanitizeCandlestickData, isValidCandlestickPoint } from './candleSanitize';
import { projectVolumeProfile } from './chartVolumeProfilePrimitive';
import type { VolumeProfileInspection, VolumeProfileResult } from './chartVolumeProfile';
import type { ChartEngineCandle } from './types';
import type { LogicalWindow } from './chartNavigation';
import type { NativePlot, NativePriceFrame } from './nativePriceRenderer';

export interface NativeStudyPoint { readonly time:number; readonly values:readonly (number|null)[]; readonly reason?:string }
export interface NativeStudySnapshot {
  readonly config:Readonly<ChartStudy>;
  /** Zero is the price pane; auxiliary panes start at one. */
  readonly paneIndex:number;
  readonly intervalHidden?:boolean;
  readonly points:readonly NativeStudyPoint[];
  readonly profile?:VolumeProfileResult;
}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
function freezeConfig(config:ChartStudy):ChartStudy {
  if(config.lineStyles){config.lineStyles.forEach(Object.freeze);Object.freeze(config.lineStyles);}
  if(config.referenceLevels){config.referenceLevels.forEach(Object.freeze);Object.freeze(config.referenceLevels);}
  if(config.paneScale)Object.freeze(config.paneScale);
  if(config.visibleIntervals)Object.freeze(config.visibleIntervals);
  if(config.studySource)Object.freeze(config.studySource);
  if(config.vwapAnchor)Object.freeze(config.vwapAnchor);
  if(config.profileRange)Object.freeze(config.profileRange);
  return Object.freeze(config);
}
function copyCandles(candles:readonly ChartEngineCandle[]):ChartEngineCandle[] {
  return sanitizeCandlestickData(candles).map(bar=>Object.isFrozen(bar)&&(!bar.volumeEvidence||Object.isFrozen(bar.volumeEvidence))&&(!bar.profileEvidence||Object.isFrozen(bar.profileEvidence))?bar:Object.freeze({...bar,
    ...(bar.volumeEvidence?{volumeEvidence:Object.freeze({...bar.volumeEvidence})}:{}),
    ...(bar.profileEvidence?{profileEvidence:Object.freeze({...bar.profileEvidence})}:{})}));
}
/** Calculation ownership only. All indicator and volume qualification math is
 * supplied by the existing StudyCalculator; presentation never invents inputs. */
export class NativeChartStudies {
  private candles:ChartEngineCandle[]=[];
  private calculators:StudyCalculator[]=[];
  private snapshots:readonly NativeStudySnapshot[]=Object.freeze([]);
  private retained=new Map<StudyCalculator,NativeStudySnapshot>();
  private bindings=new Map<StudyCalculator,{parent:StudyCalculator|undefined;issue:string|null}>();
  private timeframe='M1';
  setTimeframe(timeframe:string):void {this.timeframe=timeframe;}
  get paneCount():number {return Math.max(0,...this.getDisplayStudies().map(study=>study.paneIndex));}
  getStudies():readonly Readonly<ChartStudy>[] {return Object.freeze(this.snapshots.map(study=>study.config));}
  getRenderStudies():readonly NativeStudySnapshot[] {return this.snapshots;}
  /** Keep hidden owners only when a visible dependent still shares their pane.
   * Calculation snapshots stay intact; display indices contain no empty panes. */
  getDisplayStudies():readonly NativeStudySnapshot[] {
    const snapshots=this.getRenderStudies();
    if(snapshots.every(s=>s.config.visibleIntervals===undefined))return snapshots;
    const visible=(s:NativeStudySnapshot)=>studyVisibleAtInterval(s.config,this.timeframe);
    const active=new Set(snapshots.filter(s=>s.paneIndex>0&&visible(s)).map(s=>s.paneIndex));
    const panes=new Map([...active].sort((a,b)=>a-b).map((id,i)=>[id,i+1]));
    return Object.freeze(snapshots.filter(s=>s.paneIndex?active.has(s.paneIndex):visible(s)).map(s=>Object.freeze({...s,paneIndex:s.paneIndex?panes.get(s.paneIndex)!:0,intervalHidden:!visible(s)})));
  }
  setStudies(configs:readonly ChartStudy[],candles:readonly ChartEngineCandle[]):void {
    const valid=validatePreferences({studies:configs}).studies.map(freezeConfig);
    const prior=new Map(this.calculators.map(calculator=>[studyId(calculator.config),calculator]));
    this.calculators=valid.map(config=>{
      const old=prior.get(studyId(config));
      return old?.updatePresentation(config)?old:new StudyCalculator(config);
    });
    this.setCandles(candles);
  }
  setCandles(candles:readonly ChartEngineCandle[]):void {
    // Empty configurations must not duplicate the viewport's history snapshot.
    if(!this.calculators.length){this.candles=[];this.snapshots=Object.freeze([]);this.retained.clear();this.bindings.clear();return;}
    const next=copyCandles(candles),from=unchangedCandlePrefix(this.candles,next);
    this.calculateFrom(next,from);
  }
  /** Known newest-bar update; no full-history reconciliation or sanitization.
   * Reference arrays/point prefixes still copy O(n); calculator math starts at
   * the changed index. Volume-profile's established full-range math is retained. */
  updateActiveCandle(input:ChartEngineCandle):boolean {
    if(!input||!isValidCandlestickPoint(input))return false;
    if(!this.calculators.length)return true;
    const last=this.candles.at(-1);
    if(last&&input.time<last.time)return false;
    const from=last&&input.time===last.time?this.candles.length-1:this.candles.length;
    const {time,open,high,low,close,volumeEvidence,profileEvidence}=input;
    const next=this.candles.slice(0,from);
    next.push(Object.freeze({time,open,high,low,close,
      ...(volumeEvidence?{volumeEvidence:Object.freeze({...volumeEvidence})}:{}),
      ...(profileEvidence?{profileEvidence:Object.freeze({...profileEvidence})}:{})}));
    this.calculateFrom(next,from);return true;
  }
  private calculateFrom(next:ChartEngineCandle[],from:number):void {
    this.candles=next;
    let pane=0;const retained=new Map<StudyCalculator,NativeStudySnapshot>();
    const bindings=new Map<StudyCalculator,{parent:StudyCalculator|undefined;issue:string|null}>();
    const byId=new Map(this.calculators.map(c=>[studyId(c.config),c]));
    const configs=this.calculators.map(c=>c.config);
    const starts=new Map<StudyCalculator,number>();
    const visit=(calculator:StudyCalculator):NativeStudySnapshot=>{
      const ready=retained.get(calculator);if(ready)return ready;
      const config=calculator.config,issue=studySourceIssue(config,configs);
      const parent=config.studySource&&!issue?byId.get(config.studySource.studyId):undefined;
      const source=parent?visit(parent):undefined;
      const old=this.retained.get(calculator);
      // Parent edits can change every value despite unchanged market candles.
      const priorBinding=this.bindings.get(calculator);
      const rebound=config.studySource && (!priorBinding || priorBinding.parent!==parent || priorBinding.issue!==issue);
      const begin=rebound?0:Math.min(from,calculator.points.length,parent?starts.get(parent)??0:from);
      bindings.set(calculator,{parent,issue});
      starts.set(calculator,begin);
      if(config.studySource)calculator.calculate(next,begin,false,{points:source?.points??[],channel:config.studySource.channel,...(issue?{reason:issue}:{})});
      else calculator.calculate(next,begin,false);
      const keep=Math.min(begin,old?.points.length??0,calculator.points.length);
      let points:readonly NativeStudyPoint[];
      if(old&&keep===calculator.points.length&&old.points.length===keep)points=old.points;
      else {
        const revised:NativeStudyPoint[]=old?old.points.slice(0,keep):[];
        for(let index=keep;index<calculator.points.length;index++){
          const point=calculator.points[index]!;
          revised.push(Object.freeze({time:point.time,values:Object.freeze([...point.values]),...(point.reason?{reason:point.reason}:{})}));
        }
        points=Object.freeze(revised);
      }
      // Scalar overlays keep the parent's units. Oscillators retain their own
      // pane, even when their input is another oscillator. Held orphans never
      // enter the price pane or autoscale.
      const paneIndex=studyDefinition(config.kind).pane?++pane:config.studySource?(source?.paneIndex??++pane):0;
      const snapshot=Object.freeze({config,paneIndex,points,...(calculator.profileResult?{profile:calculator.profileResult}:{})});
      retained.set(calculator,snapshot);return snapshot;
    };
    this.snapshots=Object.freeze(this.calculators.map(visit));
    this.retained=retained;this.bindings=bindings;
  }
  reset():void {this.setStudies(this.getStudies(),[]);}
  getValues(time:number) {
    return Object.freeze(this.snapshots.map(study=>{
      const config=study.config,intervalHidden=!studyVisibleAtInterval(config,this.timeframe);
      const displayLabel=studyLabel(config,this.getStudies())+studyIntervalSuffix(config,this.timeframe);
      if(config.kind==='volume_profile')return Object.freeze({...(config.showInDataWindow===false?{dataWindowVisible:false}:{}),label:studyLabel(config,this.getStudies()),...(intervalHidden?{displayLabel}:{}),color:config.color,
        ...(study.profile?.status==='held'?{reason:study.profile.reason}:{}),values:Object.freeze([Object.freeze({
          name:intervalHidden||config.lineStyles?.[0]?.visible===false?'Frozen-range total trade units (hidden)':'Frozen-range total trade units',
          value:study.profile?.status==='ready'?study.profile.totalTradeUnits:null})])});
      let lo=0,hi=study.points.length-1,point:NativeStudyPoint|undefined;
      if(finite(time))while(lo<=hi){const mid=(lo+hi)>>>1,candidate=study.points[mid]!;if(candidate.time===time){point=candidate;break;}if(candidate.time<time)lo=mid+1;else hi=mid-1;}
      return Object.freeze({...(config.showInDataWindow===false?{dataWindowVisible:false}:{}),label:studyLabel(config,this.getStudies()),...(intervalHidden?{displayLabel}:{}),color:config.color,...(point?.reason?{reason:point.reason}:{}),
        values:Object.freeze(studyDefinition(config.kind).channels.map((name,index)=>Object.freeze({
          name:intervalHidden||config.lineStyles?.[index]?.visible===false?`${name} (hidden)`:name,value:finite(point?.values[index])?point!.values[index]!:null})))});
    }));
  }
  getProfiles():VolumeProfileInspection[] {
    return this.snapshots.flatMap(study=>study.profile?[Object.freeze({id:studyId(study.config),label:studyLabel(study.config),visible:studyVisibleAtInterval(study.config,this.timeframe)&&study.config.lineStyles?.[0]?.visible!==false,result:study.profile})]:[]);
  }
  getPriceBounds(range:LogicalWindow,scale:ChartScaleMode='linear'):number[] {
    if(!finite(range.from)||!finite(range.to)||range.to<=range.from)return [];
    const values:number[]=[];
    for(const study of this.getDisplayStudies()){
      if(study.paneIndex||study.intervalHidden)continue;
      if(study.profile?.status==='ready'&&study.config.lineStyles?.[0]?.visible!==false){
        for(const row of study.profile.rows)values.push(row.low,row.high);continue;
      }
      studyDefinition(study.config.kind).channels.forEach((_,channel)=>{
        if(study.config.lineStyles?.[channel]?.visible!==false)for(const value of visibleChannelValues(study,range,channel,scale))values.push(value);
      });
    }
    return values;
  }
}

/** Preserve every configured pane. Caller must report unavailable space and
 * may resize; silently dropping an oscillator would misrepresent preferences. */
export function layoutNativeStudyPanes(fullPlot:NativePlot,count:number):{price:NativePlot;panes:NativePlot[]}|null {
  if(!Number.isInteger(count)||count<0||count>12||![fullPlot.left,fullPlot.top,fullPlot.width,fullPlot.height].every(finite)
    ||fullPlot.width<=0||fullPlot.height<=0||!finite(fullPlot.left+fullPlot.width)||!finite(fullPlot.top+fullPlot.height))return null;
  if(count===0)return {price:Object.freeze({...fullPlot}),panes:[]};
  const unit=fullPlot.height/(count+3),priceHeight=unit*3;
  if(unit<40||priceHeight<100)return null;
  return {price:Object.freeze({...fullPlot,height:priceHeight}),panes:Array.from({length:count},(_,i)=>Object.freeze({...fullPlot,top:fullPlot.top+priceHeight+unit*i,height:unit}))};
}

function isHistogram(config:Readonly<ChartStudy>,channel:number):boolean {
  return (config.kind==='macd'&&channel===2)||config.kind==='trade_volume'||config.kind==='tick_volume';
}
/** Bounds are drawn geometry, not unseen adjacent extrema. Intersections are
 * display-only; no synthetic point is added to calculations or inspection. */
function visibleChannelValues(study:NativeStudySnapshot,range:LogicalWindow,channel:number,scale:ChartScaleMode='linear',halfBar?:number):number[] {
  const values=new Set<number>(),margin=halfBar==null?1:Math.max(1,Math.ceil(halfBar));
  const first=Math.max(0,Math.floor(range.from)-margin),last=Math.min(study.points.length-1,Math.ceil(range.to)+margin);
  if(halfBar!=null){
    for(let i=first;i<=last;i++){const value=study.points[i]!.values[channel];if(finite(value)&&i+halfBar>range.from&&i-halfBar<range.to)values.add(value);}
  }else for(let i=first;i<last;i++){
    const a=study.points[i]!.values[channel],b=study.points[i+1]!.values[channel];
    if(!finite(a)||!finite(b))continue;
    const start=Math.max(range.from,i),end=Math.min(range.to,i+1);if(end<=start)continue;
    // Invalid logarithmic endpoints cannot produce a valid displayed segment.
    // Keep the explicit invalid bound so the owning price frame withholds it.
    if(scale==='log'&&(a<=0||b<=0)){values.add(a);values.add(b);continue;}
    for(const boundary of [start,end]){
      const weight=boundary-i;
      const value=weight===0?a:weight===1?b:scale==='log'?Math.exp(Math.log(a)*(1-weight)+Math.log(b)*weight):a*(1-weight)+b*weight;
      if(finite(value))values.add(value);
    }
  }
  return [...values];
}
function visiblePoints(study:NativeStudySnapshot,frame:NativePriceFrame):readonly NativeStudyPoint[] {
  const hasHistogram=studyDefinition(study.config.kind).channels.some((_,channel)=>isHistogram(study.config,channel));
  const half=hasHistogram?Math.max(1,Math.min(24,frame.spacing*.7))/(2*frame.spacing):1;
  const margin=Math.max(1,Math.ceil(half));
  return study.points.slice(Math.max(0,Math.floor(frame.range.from)-margin),Math.min(study.points.length,Math.ceil(frame.range.to)+margin+1));
}
function referenceLevels(config:Readonly<ChartStudy>):readonly StudyReferenceLevel[] {
  return config.referenceLevels??(studyDefinition(config.kind).levels??[]).map(value=>({value}));
}
/** One representable step, used only if an automatic padded edge rounds back
 * onto the fixed boundary. It changes display bounds, never observations. */
function adjacentFloat(value:number,direction:1|-1):number {
  if(value===0)return direction*Number.MIN_VALUE;
  const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value);
  const bits=view.getBigUint64(0);
  view.setBigUint64(0,(value>0)===(direction>0)?bits+1n:bits-1n);
  return view.getFloat64(0);
}
function paneMapping(group:readonly NativeStudySnapshot[],frame:NativePriceFrame,plot:NativePlot) {
  // A linked overlay may be listed before its oscillator; display order cannot
  // transfer ownership of the shared pane's scale.
  const owner=group.find(s=>studyDefinition(s.config.kind).pane)??group[0]!;
  const scale=owner.config.paneScale;
  const manual=scale?.mode==='fixed'?scale:undefined;
  const fixed=manual?.min!==undefined&&manual.max!==undefined?[manual.min,manual.max]:!scale&&group.length===1?studyDefinition(owner.config.kind).range:undefined;
  const values:number[]=[];
  // Default oscillator range is scale context even when its own drawing is hidden.
  if(!scale&&!fixed)values.push(...(studyDefinition(owner.config.kind).range??[]));
  for(const study of group){
    if(study.intervalHidden)continue;
    const definition=studyDefinition(study.config.kind);
    if(!fixed){
      if(!scale)values.push(...(definition.range??[]));
      values.push(...referenceLevels(study.config).filter(level=>level.visible!==false).map(level=>level.value));
    }
    definition.channels.forEach((_,channel)=>{
      if(study.config.lineStyles?.[channel]?.visible===false)return;
      const half=isHistogram(study.config,channel)?Math.max(1,Math.min(24,frame.spacing*.7))/(2*frame.spacing):undefined;
      if(!fixed)for(const value of visibleChannelValues(study,frame.range,channel,'linear',half))values.push(value);

    });
    if(!fixed&&(study.config.kind==='trade_volume'||study.config.kind==='tick_volume'||study.config.kind==='macd'))values.push(0);
  }
  if(fixed)values.push(...fixed);
  if(manual?.min!==undefined)values.push(manual.min);
  if(manual?.max!==undefined)values.push(manual.max);
  if(!values.length)return null;
  let low=Infinity,high=-Infinity;for(const value of values){low=Math.min(low,value);high=Math.max(high,value);}
  const magnitude=Math.max(Math.abs(low),Math.abs(high))||1;
  const a=low/magnitude,b=high/magnitude,padding=fixed?0:b>a?(b-a)*.08:.01;
  let bottom=a-padding,top=b+padding;
  if(manual&&!fixed){
    // Work in normalized units to avoid overflowing opposite-sign/extreme
    // values. Pad only the automatic side, never move the user's boundary.
    bottom=manual.min!==undefined?manual.min/magnitude:a;
    top=manual.max!==undefined?manual.max/magnitude:b;
    if(!(top>bottom)){if(manual.min!==undefined)top=bottom+.02;else bottom=top-.02;}
    const pad=(top-bottom)*.08;
    if(manual.min===undefined)bottom-=pad;
    if(manual.max===undefined)top+=pad;
    low=manual.min??Math.max(-Number.MAX_VALUE,bottom*magnitude);
    high=manual.max??Math.min(Number.MAX_VALUE,top*magnitude);
    if(!(high>low)){
      if(manual.min!==undefined)high=adjacentFloat(low,1);
      else low=adjacentFloat(high,-1);
    }
    bottom=low/magnitude;top=high/magnitude;
  }
  const extent=top-bottom;
  if(!finite(extent)||extent<=0)return null;
  const note=manual?(fixed?'Fixed scale · values outside limits are clipped':manual.min!==undefined?'Fixed minimum · lower values are clipped':'Fixed maximum · higher values are clipped'):scale?.mode==='auto'?'Auto scale':'';
  return {low,high,note,y:(value:number):number|null=>{if(!finite(value))return null;const y=plot.top+plot.height*(1-(value/magnitude-bottom)/extent);return finite(y)?y:null;}};
}
function clipped(ctx:CanvasRenderingContext2D,plot:NativePlot,draw:()=>void){ctx.save();try{ctx.beginPath();ctx.rect(plot.left,plot.top,plot.width,plot.height);ctx.clip();ctx.globalAlpha=1;draw();}finally{ctx.restore();}}
/** Exact observed timestamps on the shared X scale, independent linear units
 * for each auxiliary pane. Null values lift the pen; no gap interpolation. */
export function paintNativeStudies(ctx:CanvasRenderingContext2D,frame:NativePriceFrame,panes:NativePlot[],studies:NativeChartStudies):void {
  if(panes.length!==studies.paneCount)throw new Error('Native study pane layout is incomplete');
  const displayed=studies.getDisplayStudies();
  for(const study of displayed){
    if(study.config.kind==='volume_profile')continue;
    const plot=study.paneIndex?panes[study.paneIndex-1]!:frame.plot,points=visiblePoints(study,frame);
    const group=displayed.filter(s=>s.paneIndex===study.paneIndex);
    const first=group[0]===study;
    const groupVisible=group.some(s=>!s.intervalHidden&&studyDefinition(s.config.kind).channels.some((_,i)=>s.config.lineStyles?.[i]?.visible!==false));
    const mapping=study.paneIndex?paneMapping(group,frame,plot):null;
    const y=study.paneIndex?mapping?.y:(value:number)=>frame.priceToY(value);
    clipped(ctx,plot,()=>{
      const definition=studyDefinition(study.config.kind),anyVisible=!study.intervalHidden&&definition.channels.some((_,i)=>study.config.lineStyles?.[i]?.visible!==false);
      if(study.paneIndex&&first){
        ctx.strokeStyle='#334155';ctx.lineWidth=1;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(plot.left,plot.top);ctx.lineTo(plot.left+plot.width,plot.top);ctx.stroke();
        ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline='top';ctx.fillStyle='#94a3b8';ctx.fillText(group.map(s=>studyLabel(s.config,studies.getStudies())+(s.intervalHidden?' (hidden by interval)':'')).join(' · ')+(groupVisible?'':' · hidden'),plot.left+5,plot.top+4,Math.max(1,plot.width-10));
      }
      if(study.paneIndex&&first&&mapping?.note){ctx.fillStyle='#fbbf24';ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom';ctx.fillText(mapping.note,plot.left+5,plot.top+plot.height-3,Math.max(1,plot.width-10));}
      if(!y||!anyVisible)return;
      for(const level of referenceLevels(study.config)){
        if(level.visible===false)continue;
        const py=y(level.value);if(py==null||py<plot.top||py>plot.top+plot.height)continue;
        ctx.strokeStyle=level.color??'#64748b';ctx.lineWidth=level.width??1;
        ctx.setLineDash(level.style==='solid'?[]:level.style==='dotted'?[2,3]:[4,4]);
        ctx.beginPath();ctx.moveTo(plot.left,py);ctx.lineTo(plot.left+plot.width,py);ctx.stroke();
        if(level.label){ctx.fillStyle=level.color??'#94a3b8';ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline=py<plot.top+16?'top':'bottom';ctx.fillText(`${formatStudyNumber(level.value,definition.channels[0]!)} · ${level.label}`,plot.left+5,py,Math.max(1,plot.width-10));}
      }
      definition.channels.forEach((_,channel)=>{
        const style=study.config.lineStyles?.[channel];if(style?.visible===false)return;
        const histogram=isHistogram(study.config,channel);
        ctx.strokeStyle=studyChannelColor(study.config,channel);ctx.fillStyle=studyChannelColor(study.config,channel);ctx.lineWidth=style?.width??1;
        ctx.setLineDash(style?.style==='dashed'?[6,4]:style?.style==='dotted'?[2,3]:[]);
        if(histogram){
          const zero=y(0);if(zero==null)return;const width=Math.max(1,Math.min(24,frame.spacing*.7));
          for(const point of points){const value=point.values[channel];if(!finite(value))continue;const px=frame.timeToX(point.time),py=y(value);if(px==null||py==null)continue;
            ctx.fillStyle=study.config.kind==='macd'?(value>=0?'#10b981':'#ef4444'):studyChannelColor(study.config,channel);
            ctx.fillRect(px-width/2,Math.min(zero,py),width,Math.abs(zero-py));
          }
        }else{
          let connected=false;ctx.beginPath();
          for(const point of points){const value=point.values[channel],px=frame.timeToX(point.time),py=finite(value)?y(value):null;
            if(px==null||py==null){connected=false;continue;}if(connected)ctx.lineTo(px,py);else ctx.moveTo(px,py);connected=true;
          }ctx.stroke();
        }
      });

    });
    if(mapping&&first&&groupVisible){
      // The viewport reserves an88px axis gutter. Pane labels use that same
      // gutter, outside the data clip; quantities retain their exact digits.
      const channel=studyDefinition(study.config.kind).channels[0]!;
      ctx.save();try{
        ctx.beginPath();ctx.rect(plot.left+plot.width,plot.top,88,plot.height);ctx.clip();ctx.globalAlpha=1;
        ctx.fillStyle='#94a3b8';ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline='top';
        ctx.fillText(formatStudyNumber(mapping.high,channel),plot.left+plot.width+6,mapping.y(mapping.high)!,76);
        if(mapping.low!==mapping.high){ctx.textBaseline='bottom';ctx.fillText(formatStudyNumber(mapping.low,channel),plot.left+plot.width+6,mapping.y(mapping.low)!,76);}
      }finally{ctx.restore();}
    }
  }
  const profiles=displayed.filter(study=>!study.intervalHidden&&study.profile?.status==='ready'&&study.config.lineStyles?.[0]?.visible!==false);
  profiles.forEach((study,slot)=>clipped(ctx,frame.plot,()=>{
    const rows=projectVolumeProfile(study.profile!,price=>{const y=frame.priceToY(price);return y==null?null:y-frame.plot.top;},frame.plot.width,frame.plot.height,slot,profiles.length);
    ctx.fillStyle=studyChannelColor(study.config,0);ctx.strokeStyle=studyChannelColor(study.config,0);ctx.lineWidth=1;ctx.setLineDash([]);
    for(const row of rows){ctx.globalAlpha=row.inValueArea ? .33 : .16;ctx.fillRect(frame.plot.left+row.x,frame.plot.top+row.y,row.width,row.height);if(row.poc){ctx.globalAlpha=.9;ctx.strokeRect(frame.plot.left+row.x,frame.plot.top+row.y,row.width,row.height);}}
    if(slot===0&&frame.plot.width>=220){ctx.globalAlpha=1;ctx.fillStyle='#94a3b8';ctx.font='10px sans-serif';ctx.textAlign='right';ctx.textBaseline='top';ctx.fillText(profiles.length===1?'Estimated profile':`Estimated profiles · ${profiles.length}`,frame.plot.left+frame.plot.width-6,frame.plot.top+4);}
  }));
}
