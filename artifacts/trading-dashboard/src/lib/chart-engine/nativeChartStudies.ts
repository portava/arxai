import {anchoredPaneScale} from './anchoredPaneScale';
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
  getPaneWeights():number[] {
    const displayed=this.getDisplayStudies();
    return Array.from({length:Math.max(0,...displayed.map(s=>s.paneIndex))},(_,i)=>displayed.find(s=>s.paneIndex===i+1&&studyDefinition(s.config.kind).pane)?.config.paneWeight??1);
  }
  getPaneCollapsed():boolean[] {
    const displayed=this.getDisplayStudies();
    return Array.from({length:Math.max(0,...displayed.map(s=>s.paneIndex))},(_,i)=>displayed.some(s=>s.paneIndex===i+1&&studyDefinition(s.config.kind).pane&&s.config.paneCollapsed===true));
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
    // Presentation order belongs to pane owners, not the dependency traversal.
    // A linked overlay listed early must not pull its source pane above others.
    const paneOwners=new Map<string,number>();
    for(const config of configs)if(studyDefinition(config.kind).pane||(config.studySource&&studySourceIssue(config,configs)))paneOwners.set(studyId(config),++pane);
    const paneFor=(config:Readonly<ChartStudy>):number=>{
      const own=paneOwners.get(studyId(config));if(own!==undefined)return own;
      if(!config.studySource)return 0;
      const parent=byId.get(config.studySource.studyId);
      return parent?paneFor(parent.config):0;
    };
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
      const paneIndex=paneFor(config);
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
      const collapsed=study.paneIndex>0&&this.snapshots.some(s=>s.paneIndex===study.paneIndex&&studyDefinition(s.config.kind).pane&&s.config.paneCollapsed===true);
      const displayLabel=studyLabel(config,this.getStudies())+studyIntervalSuffix(config,this.timeframe)+(collapsed?' (pane collapsed)':'');
      if(config.kind==='volume_profile')return Object.freeze({...(config.showInStatusLine===true?{statusLineVisible:true}:{}),...(config.showInDataWindow===false?{dataWindowVisible:false}:{}),label:studyLabel(config,this.getStudies()),...(intervalHidden||collapsed?{displayLabel}:{}),color:config.color,
        ...(study.profile?.status==='held'?{reason:study.profile.reason}:{}),values:Object.freeze([Object.freeze({
          name:intervalHidden||config.lineStyles?.[0]?.visible===false?'Frozen-range total trade units (hidden)':'Frozen-range total trade units',
          value:study.profile?.status==='ready'?study.profile.totalTradeUnits:null})])});
      let lo=0,hi=study.points.length-1,point:NativeStudyPoint|undefined;
      if(finite(time))while(lo<=hi){const mid=(lo+hi)>>>1,candidate=study.points[mid]!;if(candidate.time===time){point=candidate;break;}if(candidate.time<time)lo=mid+1;else hi=mid-1;}
      return Object.freeze({...(config.showInStatusLine===true?{statusLineVisible:true}:{}),...(config.showInDataWindow===false?{dataWindowVisible:false}:{}),label:studyLabel(config,this.getStudies()),...(intervalHidden||collapsed?{displayLabel}:{}),color:config.color,...(point?.reason?{reason:point.reason}:{}),
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
export function layoutNativeStudyPanes(fullPlot:NativePlot,count:number,paneWeights?:readonly number[],paneCollapsed?:readonly boolean[]):{price:NativePlot;panes:NativePlot[]}|null {
  if(!Number.isInteger(count)||count<0||count>12||![fullPlot.left,fullPlot.top,fullPlot.width,fullPlot.height].every(finite)
    ||fullPlot.width<=0||fullPlot.height<=0||!finite(fullPlot.left+fullPlot.width)||!finite(fullPlot.top+fullPlot.height))return null;
  if(paneWeights!==undefined&&(paneWeights.length!==count||Array.from(paneWeights).some(w=>!finite(w)||w<.25||w>8)))return null;
  if(paneCollapsed!==undefined&&(paneCollapsed.length!==count||Array.from(paneCollapsed).some(v=>typeof v!=="boolean")))return null;
  if(count===0)return {price:Object.freeze({...fullPlot}),panes:[]};
  // Retain existing minimum-space acceptance. Redistribution must not make an
  // already unavailable stack appear complete by squeezing away a pane.
  const collapsed=[false,...(paneCollapsed??Array(count).fill(false))],collapsedCount=collapsed.filter(Boolean).length;
  if(collapsedCount?fullPlot.height<100+(count-collapsedCount)*40+collapsedCount*24:fullPlot.height/(count+3)<40)return null;
  const weights=[3,...(paneWeights??Array(count).fill(1))],minimum=[100,...Array(count).fill(40)];
  const heights:number[]=collapsed.map(value=>value?24:0),remaining=new Set(weights.map((_,i)=>i).filter(i=>!collapsed[i]));let available=fullPlot.height-collapsedCount*24;
  // Water-fill constrained panes before redistributing the remaining space.
  while(remaining.size){
    const total=[...remaining].reduce((sum,i)=>sum+weights[i]!,0);
    const constrained=[...remaining].filter(i=>available*(weights[i]!/total)<minimum[i]!);
    if(!constrained.length){for(const i of remaining)heights[i]=available*(weights[i]!/total);break;}
    for(const i of constrained){heights[i]=minimum[i]!;available-=minimum[i]!;remaining.delete(i);}
  }
  let top=fullPlot.top+heights[0];
  const bottom=fullPlot.top+fullPlot.height;
  const panes=heights.slice(1).map((requested,index)=>{
    // Preserve the readable minimum when subtraction rounds a fractional final
    // pane just below 40px. At the largest finite extent, recombining a rounded
    // difference can overflow; use the adjacent representable height instead.
    let height=collapsed[index+1]?24:index===count-1?Math.max(40,bottom-top):requested;
    if(!finite(top+height))height=adjacentFloat(height,-1);
    const pane=Object.freeze({...fullPlot,top,height});top+=height;return pane;
  });
  if(!finite(heights[0])||heights[0]<100||panes.some((p,i)=>![p.top,p.height,p.top+p.height].every(finite)||p.height<(collapsed[i+1]?24:40)))return null;
  return {price:Object.freeze({...fullPlot,height:heights[0]}),panes};
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
export interface NativePaneScalePreview {id:string;value:number;percent:number}
function paneMapping(group:readonly NativeStudySnapshot[],frame:NativePriceFrame,plot:NativePlot,preview?:NativePaneScalePreview|null) {
  // A linked overlay may be listed before its oscillator; display order cannot
  // transfer ownership of the shared pane's scale.
  const owner=group.find(s=>studyDefinition(s.config.kind).pane)??group[0]!;
  const scale=preview?.id===studyId(owner.config)?{mode:"line" as const,value:preview.value,percent:preview.percent}:owner.config.paneScale;
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
  if(scale?.mode==='line'){
    const anchored=anchoredPaneScale(low,high,scale.value,scale.percent);if(!anchored)return null;
    return {low:anchored.low,high:anchored.high,note:`Scale anchor ${formatStudyNumber(scale.value,studyDefinition(owner.config.kind).channels[0]!)} at ${scale.percent}% from bottom · outside values clipped`,anchor:scale.value,
      y:(value:number):number|null=>{const fraction=anchored.fraction(value);if(fraction===null)return null;const y=plot.top+plot.height*(1-fraction);return finite(y)?y:null;}};
  }
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
/** Uses exactly the same validated map as the plot, never a guessed handle position. */
export function nativeStudyPaneAnchor(group:readonly NativeStudySnapshot[],frame:NativePriceFrame,plot:NativePlot,preview?:NativePaneScalePreview|null){
 const owner=group.find(s=>studyDefinition(s.config.kind).pane);if(!owner||owner.config.paneCollapsed||owner.config.paneScale?.mode!=='line')return undefined;
 const scale=preview?.id===studyId(owner.config)?preview:owner.config.paneScale;
 const mapping=paneMapping(group,frame,plot,preview);if(!mapping)return undefined;
 const y=mapping.y(scale.value);return y===null?undefined:{value:scale.value,percent:scale.percent,y};
}
export interface NativeStudyScaleLabel {
  readonly time:number; readonly value:number; readonly channel:string; readonly title:string;
  readonly paneIndex:number; readonly color:string; readonly anchorY:number; readonly top:number;
  readonly plot:NativePlot;
}
/** Latest loaded observations only. Never backfill missing values or clamp an
 * off-scale value to an edge. Displaced labels keep a connector to the true Y.
 * Trade labels get priority; unreadable/crowded labels are omitted. */
export function planNativeStudyScaleLabels(frame:NativePriceFrame,panes:NativePlot[],studies:NativeChartStudies,onlyPane:number|null=null,reserved:readonly {top:number;bottom:number}[]=[],preview?:NativePaneScalePreview|null):NativeStudyScaleLabel[] {
  const displayed=studies.getDisplayStudies();
  if(!displayed.some(s=>s.config.showOnScale===true))return [];
  const latest=frame.series.candles.at(-1);if(!latest)return [];
  const x=frame.timeToX(latest.time);
  if(x==null||x<frame.plot.left||x>frame.plot.left+frame.plot.width)return [];
  const occupied=reserved.filter(r=>finite(r.top)&&finite(r.bottom)&&r.bottom>=r.top).map(r=>({...r}));
  const result:NativeStudyScaleLabel[]=[];
  for(const study of displayed){
    if(study.config.showOnScale!==true||study.intervalHidden||study.config.kind==='volume_profile'||(onlyPane!==null&&study.paneIndex!==onlyPane))continue;
    const group=displayed.filter(s=>s.paneIndex===study.paneIndex);
    if(study.paneIndex&&group.some(s=>studyDefinition(s.config.kind).pane&&s.config.paneCollapsed))continue;
    const plot=study.paneIndex?panes[study.paneIndex-1]:frame.plot;if(!plot||plot.height<52)continue;
    const mapping=study.paneIndex?paneMapping(group,frame,plot,preview):null;
    const point=study.points.at(-1);if(!point||point.time!==latest.time||point.reason)continue;
    const definition=studyDefinition(study.config.kind);
    definition.channels.forEach((channel,index)=>{
      const value=point.values[index];if(!finite(value)||study.config.lineStyles?.[index]?.visible===false)return;
      const y=study.paneIndex?mapping?.y(value):frame.priceToY(value);
      if(y==null||!finite(y)||y<plot.top||y>plot.top+plot.height)return;
      // Keep the pane's low/high ticks legible. Each chip is two 12px lines.
      const lo=plot.top+12,hi=plot.top+plot.height-40;
      const target=Math.max(lo,Math.min(hi,y-14));
      const candidates=[target,lo,hi,...occupied.flatMap(r=>[r.top-30,r.bottom+2])]
        .filter(top=>top>=lo&&top<=hi&&Math.abs(top-target)<=32)
        .sort((a,b)=>Math.abs(a-target)-Math.abs(b-target)||a-b);
      const top=candidates.find(t=>occupied.every(r=>t+28<=r.top-2||t>=r.bottom+2));if(top===undefined)return;
      occupied.push({top,bottom:top+28});
      result.push({time:latest.time,value,channel,title:`${studyLabel(study.config,studies.getStudies())}${definition.channels.length>1?' · '+channel:''}${!study.paneIndex&&(frame.scale==='percent'||frame.scale==='indexed')?' · raw':''}`,paneIndex:study.paneIndex,color:studyChannelColor(study.config,index),anchorY:y,top,plot});
    });
  }
  return result;
}
export function paintNativeStudyScaleLabels(ctx:CanvasRenderingContext2D,frame:NativePriceFrame,panes:NativePlot[],studies:NativeChartStudies,onlyPane:number|null=null,reserved:readonly {top:number;bottom:number}[]=[],preview?:NativePaneScalePreview|null):void {
  for(const label of planNativeStudyScaleLabels(frame,panes,studies,onlyPane,reserved,preview)){
    const left=label.plot.left+label.plot.width;
    ctx.save();try{
      ctx.beginPath();ctx.rect(left,label.plot.top,88,label.plot.height);ctx.clip();ctx.globalAlpha=1;
      ctx.strokeStyle=label.color;ctx.lineWidth=1;ctx.setLineDash([]);ctx.beginPath();
      const endY=label.top+14,dy=endY-label.anchorY;
      let segments:[number,number][]=[[0,1]];
      for(const band of reserved){
        if(!finite(band.top)||!finite(band.bottom)||band.bottom<band.top)continue;
        if(dy===0){if(label.anchorY>=band.top-1&&label.anchorY<=band.bottom+1)segments=[];continue;}
        const a=(band.top-1-label.anchorY)/dy,b=(band.bottom+1-label.anchorY)/dy;
        const start=Math.min(a,b),end=Math.max(a,b);
        segments=segments.flatMap(([lo,hi])=>end<=lo||start>=hi?[[lo,hi] as [number,number]]:
          [...(start>lo?[[lo,start] as [number,number]]:[]),...(end<hi?[[end,hi] as [number,number]]:[])]);
      }
      for(const [start,end] of segments){ctx.moveTo(left+5*start,label.anchorY+dy*start);ctx.lineTo(left+5*end,label.anchorY+dy*end);}ctx.stroke();
      ctx.fillStyle='#0f172a';ctx.fillRect(left+5,label.top,83,28);
      ctx.fillStyle=label.color;ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline='top';
      ctx.fillText(label.title,left+8,label.top+1,77);
      ctx.fillStyle='#f8fafc';ctx.font='11px monospace';ctx.fillText(formatStudyNumber(label.value,label.channel),left+8,label.top+14,77);
    }finally{ctx.restore();}
  }
}
function clipped(ctx:CanvasRenderingContext2D,plot:NativePlot,draw:()=>void){ctx.save();try{ctx.beginPath();ctx.rect(plot.left,plot.top,plot.width,plot.height);ctx.clip();ctx.globalAlpha=1;draw();}finally{ctx.restore();}}
/** Exact observed timestamps on the shared X scale, independent linear units
 * for each auxiliary pane. Null values lift the pen; no gap interpolation. */
export function paintNativeStudies(ctx:CanvasRenderingContext2D,frame:NativePriceFrame,panes:NativePlot[],studies:NativeChartStudies,onlyPane:number|null=null,preview?:NativePaneScalePreview|null):void {
  if(panes.length!==studies.paneCount)throw new Error('Native study pane layout is incomplete');
  const displayed=studies.getDisplayStudies();
  for(const study of displayed){
    if(study.config.kind==='volume_profile'||(onlyPane!==null&&study.paneIndex!==onlyPane))continue;
    const plot=study.paneIndex?panes[study.paneIndex-1]!:frame.plot,points=visiblePoints(study,frame);
    const group=displayed.filter(s=>s.paneIndex===study.paneIndex);
    const first=group[0]===study;
    const groupVisible=group.some(s=>!s.intervalHidden&&studyDefinition(s.config.kind).channels.some((_,i)=>s.config.lineStyles?.[i]?.visible!==false));
    const collapsed=study.paneIndex>0&&group.some(s=>studyDefinition(s.config.kind).pane&&s.config.paneCollapsed===true);
    const mapping=study.paneIndex&&!collapsed?paneMapping(group,frame,plot,preview):null;
    const y=study.paneIndex?mapping?.y:(value:number)=>frame.priceToY(value);
    clipped(ctx,plot,()=>{
      const definition=studyDefinition(study.config.kind),anyVisible=!study.intervalHidden&&definition.channels.some((_,i)=>study.config.lineStyles?.[i]?.visible!==false);
      if(study.paneIndex&&first){
        ctx.strokeStyle='#334155';ctx.lineWidth=1;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(plot.left,plot.top);ctx.lineTo(plot.left+plot.width,plot.top);ctx.stroke();
        ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline='top';ctx.fillStyle='#94a3b8';ctx.fillText(group.map(s=>studyLabel(s.config,studies.getStudies())+(s.intervalHidden?' (hidden by interval)':'')).join(' · ')+(collapsed?' · collapsed — restore in Studies':groupVisible?'':' · hidden'),plot.left+5,plot.top+4,Math.max(1,plot.width-(group.some(s=>studyDefinition(s.config.kind).pane)?66:10)));
      }
      if(study.paneIndex&&first&&!mapping&&!collapsed&&group.some(s=>s.config.paneScale?.mode==='line')){ctx.fillStyle='#fbbf24';ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom';ctx.fillText('Scale unavailable — no finite display range',plot.left+5,plot.top+plot.height-3,Math.max(1,plot.width-10));}
      if(study.paneIndex&&first&&mapping?.note){ctx.fillStyle='#fbbf24';ctx.font='10px sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom';ctx.fillText(mapping.note,plot.left+5,plot.top+plot.height-3,Math.max(1,plot.width-10));}
      if(study.paneIndex&&first&&mapping&&'anchor' in mapping&&mapping.anchor!==undefined){
        const anchorY=mapping.y(mapping.anchor);
        if(anchorY!==null){ctx.strokeStyle='#fbbf24';ctx.lineWidth=1;ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(plot.left,anchorY);ctx.lineTo(plot.left+plot.width,anchorY);ctx.stroke();}
      }
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
  const profiles=displayed.filter(study=>onlyPane===null&&!study.intervalHidden&&study.profile?.status==='ready'&&study.config.lineStyles?.[0]?.visible!==false);
  profiles.forEach((study,slot)=>clipped(ctx,frame.plot,()=>{
    const rows=projectVolumeProfile(study.profile!,price=>{const y=frame.priceToY(price);return y==null?null:y-frame.plot.top;},frame.plot.width,frame.plot.height,slot,profiles.length);
    ctx.fillStyle=studyChannelColor(study.config,0);ctx.strokeStyle=studyChannelColor(study.config,0);ctx.lineWidth=1;ctx.setLineDash([]);
    for(const row of rows){ctx.globalAlpha=row.inValueArea ? .33 : .16;ctx.fillRect(frame.plot.left+row.x,frame.plot.top+row.y,row.width,row.height);if(row.poc){ctx.globalAlpha=.9;ctx.strokeRect(frame.plot.left+row.x,frame.plot.top+row.y,row.width,row.height);}}
    if(slot===0&&frame.plot.width>=220){ctx.globalAlpha=1;ctx.fillStyle='#94a3b8';ctx.font='10px sans-serif';ctx.textAlign='right';ctx.textBaseline='top';ctx.fillText(profiles.length===1?'Estimated profile':`Estimated profiles · ${profiles.length}`,frame.plot.left+frame.plot.width-6,frame.plot.top+4);}
  }));
}
