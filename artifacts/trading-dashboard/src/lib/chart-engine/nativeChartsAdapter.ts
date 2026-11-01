import type {ChartEngineAdapter,ChartEngineCapabilities,ChartEngineCandle,ChartEngineFeedState,ChartEngineInitOptions,ChartStructureLine,ChartStructureMarker} from './types';
import {NativeChartViewport} from './nativeChartViewport';
import {sanitizeCandlestickData} from './candleSanitize';
import {sameCandle} from './candleReconciliation';
import {chartIntervalSeconds} from './chartIntervals';
import {candleAtLinkedTime,validTimeRange,type ChartTimeRange,type ChartViewEvent} from './chartViewLink';
import {panChartWindow,zoomChartWindow,type LogicalWindow} from './chartNavigation';
import {formatSourceChartTime} from './chartClockEvidence';
import {vwapAnchorEvidence} from './chartVwapAnchor';
import type {ChartStudy,VwapAnchor} from './chartStudies';
import type {ChartAnchor,ChartDrawing,ChartStyle,ChartScaleMode} from './chartWorkspace';
import type {DrawingInteraction} from './chartDrawingEditor';
import type {SmartChartAnnotation} from './smartChartAnnotation';
import type {ChartTimeZone} from './chartTimeZone';
import type {ChartOverlay} from '@/lib/chart-overlays';

const capabilities:ChartEngineCapabilities={id:'arx-native',label:'ARX Native Canvas',available:true,candles:true,priceLines:true,markers:true,zones:true,coordinateApi:true,drawingTools:true,draggableOrders:false};
const clone=(c:Readonly<ChartEngineCandle>):ChartEngineCandle=>({...c,...(c.volumeEvidence?{volumeEvidence:{...c.volumeEvidence}}:{}),...(c.profileEvidence?{profileEvidence:{...c.profileEvidence}}:{})});
/** View-only bridge to the existing native viewport. No data provider or trade authority. */
export class NativeChartsAdapter implements ChartEngineAdapter {
 readonly capabilities=capabilities;
 private viewport:NativeChartViewport|null=null;
 private container:HTMLElement|null=null;
 private mount=0;
 private epoch=0;
 private frame:number|null=null;
 private listeners=new Set<()=>void>();
 private crosshair:((c:ChartEngineCandle|null)=>void)|null=null;
 private viewLink:((event:ChartViewEvent)=>void)|null=null;
 private linkStatus:((message:string)=>void)|null=null;
 private reachStart:(()=>void)|null=null;
 private threshold=20;
 private pendingCursor:number|null|undefined;
 private hoveredTime:number|null=null;
 private cursorDirty=false;
 private linkedCursor:number|null|undefined;
 private linkedRange:ChartTimeRange|null=null;
 private ownsRange=false;
 private mutedLinks=0;
 private lastRangeKey='';
 private lastReachKey='';
 private feed:ChartEngineFeedState={livePriceAffordance:false,source:null};
 private tip:ChartEngineCandle|null=null;
 private visibleDesktop=150;
 private visibleMobile=80;
 private scale:ChartScaleMode='linear';
 private inverted=false;
 private timeZone:ChartTimeZone='UTC';
 private timeframe='M1';
 private interval=60;
 private symbol='';
 private current(viewport:NativeChartViewport,epoch=this.epoch){return this.viewport===viewport&&this.epoch===epoch;}
 private notify(callback:()=>void){try{callback();}catch(error){console.warn('Native chart callback failed',error);}}
 private candles(){return this.viewport?.getCandles()??[];}
 private defaultCount(){return typeof window!=='undefined'&&window.innerWidth<768?this.visibleMobile:this.visibleDesktop;}
 init(options:ChartEngineInitOptions):void {
  this.destroy();
  this.container=options.container;
  this.visibleDesktop=Number.isFinite(options.visibleDesktop)&&options.visibleDesktop!>0?options.visibleDesktop!:150;
  this.visibleMobile=Number.isFinite(options.visibleMobile)&&options.visibleMobile!>0?options.visibleMobile!:80;
  const mount=this.mount;
  let viewport:NativeChartViewport;
  viewport=new NativeChartViewport(options.container,{height:options.height,visibleBars:this.defaultCount(),timeframe:this.timeframe,timeZone:this.timeZone,
   onCrosshair:value=>{if(this.mount!==mount||this.viewport!==viewport)return;if(!this.mutedLinks)this.linkedCursor=undefined;this.hoveredTime=value?.candle.time??null;if(!this.mutedLinks)this.pendingCursor=this.hoveredTime;this.cursorDirty=true;this.queue();},
   onViewportChange:()=>{if(this.mount===mount&&this.viewport===viewport)this.queue();},
   onUserRangeChange:()=>{if(this.mount!==mount||this.viewport!==viewport)return;this.takeRangeOwnership();this.queue();},
  });
  this.viewport=viewport;
  options.container.dataset.chartEngine='arx-native';options.container.dataset.chartNavigation='inspect';
 }
 destroy():void {
  this.mount++;this.epoch++;
  const viewport=this.viewport;this.viewport=null;
  if(this.frame!=null)cancelAnimationFrame(this.frame);this.frame=null;
  this.listeners.clear();this.crosshair=null;this.viewLink=null;this.linkStatus=null;this.reachStart=null;
  this.pendingCursor=undefined;this.hoveredTime=null;this.cursorDirty=false;this.linkedCursor=undefined;this.linkedRange=null;this.ownsRange=false;this.lastRangeKey='';this.lastReachKey='';
  this.tip=null;this.feed={livePriceAffordance:false,source:null};this.scale='linear';this.inverted=false;this.timeZone='UTC';this.timeframe='M1';this.interval=60;this.symbol='';this.threshold=20;
  if(this.container){delete this.container.dataset.chartEngine;delete this.container.dataset.chartNavigation;}
  this.container=null;viewport?.destroy();
 }
 resize(width?:number,height?:number):void {this.viewport?.resize(width,height);}
 setFeedState(state:ChartEngineFeedState):void {
  if(this.feed.source!==state.source)this.tip=null;
  this.feed={livePriceAffordance:state.livePriceAffordance===true,source:state.source};
  this.viewport?.setLivePriceAffordance(this.feed.livePriceAffordance);
 }
 resetDataContext():void {
  const viewport=this.viewport;if(!viewport)return;
  this.epoch++;if(this.frame!=null)cancelAnimationFrame(this.frame);this.frame=null;
  this.tip=null;this.feed={livePriceAffordance:false,source:null};this.pendingCursor=undefined;this.hoveredTime=null;this.linkedCursor=undefined;this.linkedRange=null;this.ownsRange=false;this.lastRangeKey='';this.lastReachKey='';this.cursorDirty=true;
  // Clearing a data context is not a user moving/leaving the crosshair.
  this.mutedLinks++;try{viewport.resetContext();}finally{this.mutedLinks--;}
  viewport.setLivePriceAffordance(false);viewport.setNavigationMode('inspect');
  if(this.container)this.container.dataset.chartNavigation='inspect';this.queue();
 }
 setCandles(input:ChartEngineCandle[],view?:{revealLatest?:boolean}):void {
  const viewport=this.viewport,epoch=this.epoch;if(!viewport)return;
  let next=sanitizeCandlestickData(input);
  // An explicit replay prefix is the complete revealed history, not a lagging poll.
  if(view?.revealLatest)this.tip=null;
  if(next.length&&this.tip&&this.tip.time>next.at(-1)!.time)next=[...next,clone(this.tip)];else this.tip=null;
  const previous=viewport.getCandles();
  if(next.length!==previous.length||next.some((bar,i)=>!sameCandle(bar,previous[i]!))){
   // Reconciliation may withdraw local hover, but must not send a synthetic
   // pointer-leave event to every other chart in the linked workspace.
   this.mutedLinks++;try{viewport.setCandles(next);}finally{this.mutedLinks--;}
  }
  if(!this.current(viewport,epoch))return;
  if(view?.revealLatest&&next.length){this.takeRangeOwnership();if(!this.current(viewport,epoch))return;viewport.goLatest();}
  if(this.linkedRange)this.applyLinkedRange(this.linkedRange);
  if(!this.current(viewport,epoch))return;
  if(this.linkedCursor!==undefined)this.applyLinkedCursor(this.linkedCursor);
  this.cursorDirty=true;this.queue();
 }
 updateActiveCandle(input:ChartEngineCandle):void {
  const viewport=this.viewport,epoch=this.epoch;if(!viewport)return;
  const candle=sanitizeCandlestickData([input])[0];if(!candle)return;
  if(!viewport.updateActiveCandle(candle)||!this.current(viewport,epoch))return;
  this.tip=clone(candle);
  if(this.linkedCursor!==undefined)this.applyLinkedCursor(this.linkedCursor);
  this.cursorDirty=true;this.queue();
 }
 private queue():void {
  if(!this.viewport||this.frame!=null)return;
  const viewport=this.viewport,epoch=this.epoch;
  const id=requestAnimationFrame(()=>{
   if(this.frame!==id||!this.current(viewport,epoch))return;this.frame=null;
   if(this.cursorDirty){this.cursorDirty=false;const bars=viewport.getCandles();const bar=(this.hoveredTime==null?null:bars.find(c=>c.time===this.hoveredTime))??(this.linkedCursor===undefined?bars.at(-1)??null:null);this.notify(()=>this.crosshair?.(bar?clone(bar):null));}
   if(!this.current(viewport,epoch))return;
   const cursor=this.pendingCursor;this.pendingCursor=undefined;
   if(cursor!==undefined)this.notify(()=>this.viewLink?.({kind:'crosshair',time:cursor}));
   if(!this.current(viewport,epoch))return;
   if(this.ownsRange){const bars=viewport.getVisibleCandles();const first=bars[0],last=bars.at(-1);if(first&&last){const range={from:first.time,to:last.time};const key=JSON.stringify(range);if(validTimeRange(range)&&key!==this.lastRangeKey){this.lastRangeKey=key;this.notify(()=>this.viewLink?.({kind:'range',range}));}}}
   if(!this.current(viewport,epoch))return;
   for(const listener of [...this.listeners]){if(!this.listeners.has(listener))continue;this.notify(listener);if(!this.current(viewport,epoch))return;}
   const range=viewport.getRange(),bars=viewport.getCandles();
   const reachKey=range&&bars.length?`${range.from}:${range.to}:${bars[0]!.time}:${bars.length}`:'';
   if(!this.linkedRange&&range&&range.from<this.threshold&&bars.length&&reachKey!==this.lastReachKey){this.lastReachKey=reachKey;this.notify(()=>this.reachStart?.());}
  });this.frame=id;
 }
 private takeRangeOwnership(){this.ownsRange=true;this.linkedRange=null;this.notify(()=>this.linkStatus?.(''));}
 private navigate(action:(viewport:NativeChartViewport)=>void):boolean {
  const viewport=this.viewport,epoch=this.epoch;if(!viewport)return false;
  this.takeRangeOwnership();if(!this.current(viewport,epoch))return false;action(viewport);if(!this.current(viewport,epoch))return false;this.queue();return true;
 }
 resetScale():void {const count=this.candles().length;if(!count)return;this.navigate(v=>v.setRange({from:count+1-this.defaultCount(),to:count+1}));}
 goToLatest(_animated=true):void {this.navigate(v=>v.goLatest());}
 fitHistory():void {this.navigate(v=>v.fit());}
 panBy(fraction:number):boolean {const range=panChartWindow(this.viewport?.getRange()??null,fraction,this.candles().length);return range?this.navigate(v=>v.setRange(range)):false;}
 zoomBy(factor:number):boolean {const range=zoomChartWindow(this.viewport?.getRange()??null,factor,this.candles().length);return range?this.navigate(v=>v.setRange(range)):false;}
 private lower(time:number){const bars=this.candles();let lo=0,hi=bars.length;while(lo<hi){const mid=(lo+hi)>>>1;if(bars[mid]!.time<time)lo=mid+1;else hi=mid;}return lo;}
 goToTime(time:number):boolean {const bars=this.candles();if(!Number.isFinite(time)||!bars.length||time<bars[0]!.time||time>bars.at(-1)!.time)return false;const index=this.lower(time),range=this.viewport!.getRange(),span=Math.max(20,range?range.to-range.from:this.defaultCount());return this.navigate(v=>v.setRange({from:index-span/2,to:index+span/2}));}
 showRecentRange(seconds:number):{complete:boolean}|null {const bars=this.candles(),first=bars[0],last=bars.at(-1);if(!first||!last||!Number.isFinite(seconds)||seconds<=0)return null;const start=last.time-seconds,index=this.lower(start);return this.navigate(v=>v.setRange({from:index,to:bars.length+2}))?{complete:first.time<=start}:null;}
 getVisibleCandles(){return this.viewport?.getVisibleCandles()??[];}
 subscribeViewport(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 setCrosshairHandler(handler:((candle:ChartEngineCandle|null)=>void)|null){this.crosshair=handler;}
 setViewLinkHandler(handler:((event:ChartViewEvent)=>void)|null){this.viewLink=handler;this.lastRangeKey='';}
 setViewLinkStatusHandler(handler:((message:string)=>void)|null){this.linkStatus=handler;}
 setLinkedCrosshair(time:number|null):void {if(time!==null&&(!Number.isFinite(time)||time<=0))return;this.linkedCursor=time;this.pendingCursor=undefined;this.applyLinkedCursor(time);}
 private applyLinkedCursor(time:number|null){const viewport=this.viewport;if(!viewport)return;const candle=time==null?null:candleAtLinkedTime(viewport.getCandles() as ChartEngineCandle[],time,this.interval);this.hoveredTime=candle?.time??null;viewport.setLinkedCrosshair(this.hoveredTime);this.cursorDirty=true;this.queue();}
 setLinkedTimeRange(range:ChartTimeRange|null):void {if(range&&!validTimeRange(range))return;this.ownsRange=false;this.pendingCursor=undefined;this.linkedRange=range?{...range}:null;if(range)this.applyLinkedRange(range);else this.notify(()=>this.linkStatus?.(''));}
 private applyLinkedRange(range:ChartTimeRange):void {
  const viewport=this.viewport,epoch=this.epoch;if(!viewport)return;
  const bars=viewport.getCandles(),first=bars[0],last=bars.at(-1);
  if(!first||!last){this.notify(()=>this.linkStatus?.('Linked time range is waiting for candles.'));return;}
  let from=this.lower(range.from);if(from>0&&range.from<bars[from-1]!.time+this.interval)from--;
  let to=this.lower(range.to);if(bars[to]?.time!==range.to)to--;
  if(from>to||from>=bars.length||to<0){this.notify(()=>this.linkStatus?.('Linked time range is outside loaded history. This view has not moved.'));return;}
  const current=viewport.getRange();const target:LogicalWindow=from===to?{from:from-.5,to:to+.5}:{from,to};
  if(!current||current.from!==target.from||current.to!==target.to){this.mutedLinks++;try{viewport.setRange(target);}finally{this.mutedLinks--;}}
  if(!this.current(viewport,epoch))return;
  const applied=viewport.getRange();
  const adjusted=applied&&(Math.abs(applied.from-target.from)>1e-6||Math.abs(applied.to-target.to)>1e-6);
  this.notify(()=>this.linkStatus?.(adjusted?'Linked time range is adjusted to this view’s loaded history and navigation limits.':range.from<first.time||range.to>=last.time+this.interval?'Linked time range is clipped to this view\'s loaded history.':''));
 }
 setReachStartHandler(handler:(()=>void)|null,thresholdBars?:number){this.reachStart=handler;this.lastReachKey='';if(thresholdBars!=null&&Number.isFinite(thresholdBars)&&thresholdBars>=0)this.threshold=thresholdBars;}
 getVwapAnchorEvidence(anchor:VwapAnchor){const index=this.lower(anchor.time);return vwapAnchorEvidence(anchor,this.candles().slice(Math.max(0,index-1),index+2));}
 getStudyValues(time:number){
  const studies=this.viewport?.getStudies()??[];
  return (this.viewport?.getStudyValues(time)??[]).map((row,index)=>{
   const study=studies[index],anchor=study?.kind==='vwap'?study.vwapAnchor:undefined;
   return {...row,...(anchor?{displayLabel:`VWAP · ${study!.source??'hlc3'} · observed-bar anchor ${formatSourceChartTime(anchor.time,this.getVwapAnchorEvidence(anchor).utcQualified,'UTC',{seconds:true})}`} : {}),values:row.values.map(value=>({...value}))};
  });
 }

 getVolumeProfiles(){return this.viewport?.getVolumeProfiles()??[];}
 getDisplayCandle(time:number){return this.viewport?.getDisplayCandle(time)??null;}
 setStudies(studies:ChartStudy[]){this.viewport?.setStudies(studies);}
 setDrawings(drawings:ChartDrawing[]){this.viewport?.setDrawings(drawings);}
 setDrawingInteraction(config:DrawingInteraction|null){this.viewport?.setDrawingInteraction(config);}
 setDrawingHandler(handler:((anchor:ChartAnchor)=>void)|null){this.viewport?.setDrawingHandler(handler);}
 setNavigationMode(mode:'inspect'|'pan'){this.viewport?.setNavigationMode(mode);if(this.container)this.container.dataset.chartNavigation=mode;}
 setSmartAnnotation(annotation:SmartChartAnnotation|null){this.viewport?.setSmartAnnotation(annotation);}
 setStructureLines(lines:ChartStructureLine[],markers:ChartStructureMarker[]){this.viewport?.setStructureLines(lines,markers);}
 setOverlays(overlays:ChartOverlay[],latestBarTime:number|null){this.viewport?.setOverlays(overlays,latestBarTime);}
 setChartStyle(style:ChartStyle){this.viewport?.setStyle(style);}
 setScaleMode(scale:ChartScaleMode){this.scale=scale;this.viewport?.setScale(scale,this.inverted);}
 setPriceScaleInverted(value:boolean){this.inverted=value;this.viewport?.setScale(this.scale,value);}
 setPriceOnlyScale(value:boolean){this.viewport?.setPriceOnlyScale(value);}
 setSourceClockQualified(qualified:boolean){this.viewport?.setSourceClockQualified(qualified);}
 setDisplayTimeZone(zone:ChartTimeZone){this.timeZone=zone;this.viewport?.setDisplayTimeZone(zone,this.timeframe);}
 setSymbol(symbol:string){this.symbol=symbol;this.viewport?.setSymbol(symbol);}
 setTimeframe(timeframe:string){this.timeframe=timeframe;this.interval=chartIntervalSeconds(timeframe)??0;this.viewport?.setDisplayTimeZone(this.timeZone,timeframe);}
 setAnalysisFocus(enabled:boolean){this.viewport?.setAnalysisFocus(enabled);}
 isAnalysisFocused(){return this.viewport?.isAnalysisFocused()??false;}
 isAnalysisFocusVerified(){return this.viewport?.isAnalysisFocusVerified()??false;}
 priceToCoordinate(price:number){return this.viewport?.getScannerOverlaySurface()?.priceToCoordinate(price)??null;}
 getScannerOverlaySurface(){return this.viewport?.getScannerOverlaySurface()??null;}
 exportImage(){return this.viewport?.exportImage()??null;}
}
