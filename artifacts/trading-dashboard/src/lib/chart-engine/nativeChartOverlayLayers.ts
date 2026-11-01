import { overlayColor, type ChartOverlay } from "../chart-overlays";
import { snapSecToCandle } from "./candleSanitize";
import type { ChartStructureLine, ChartStructureMarker } from "./types";
import type { NativePriceFrame } from "./nativePriceRenderer";
import type { ScannerPriceLine } from "./scannerChartSurface";
import { paintScannerPriceLines, paintScannerMarkers, type NativeScannerMarker } from "./nativeScannerOverlays";
import { cloneSmartChartAnnotation, paintSmartChartAnnotation, type SmartChartAnnotation } from "./smartChartAnnotationCanvas";

const price = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const time = price;
const color = (value: unknown): value is string => typeof value === "string" && /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);

/** Display-only channels. Existing shell/producer still owns source, market,
 * account, timeframe and freshness qualification. No inference or execution.
 * These caches hold cloned geometry, never renderer-created candle times. */
export class NativeChartOverlayLayers {
  private lines: ChartStructureLine[] = [];
  private markers: ChartStructureMarker[] = [];
  private annotation: SmartChartAnnotation | null = null;
  private overlays: ChartOverlay[] = [];
  private latest: number | null = null;
  private timeSeries: NativePriceFrame["series"] | null = null;
  private times: number[] = [];
  setStructureLines(lines: readonly ChartStructureLine[], markers: readonly ChartStructureMarker[]): void {
    this.lines = (Array.isArray(lines)?lines:[]).flatMap(line => line && line.start && line.end && time(line.start.time) && time(line.end.time)
      && line.start.time !== line.end.time && price(line.start.price) && price(line.end.price) && color(line.color)
      ? [{id:line.id,start:{...line.start},end:{...line.end},color:line.color,dashed:line.dashed===true,width:line.width===1?1:2}] : []);
    this.markers = (Array.isArray(markers)?markers:[]).flatMap(marker => marker && time(marker.time) && color(marker.color) && text(marker.label)
      && ["aboveBar","belowBar"].includes(marker.position) ? [{...marker}] : []);
  }
  setSmartAnnotation(annotation: SmartChartAnnotation | null): void { this.annotation = cloneSmartChartAnnotation(annotation); }
  setOverlays(overlays: readonly ChartOverlay[], latest: number | null): void {
    this.latest = time(latest) ? latest : null;
    this.overlays = (Array.isArray(overlays)?overlays:[]).flatMap(row => {
      if (!row || !["position","pending","plan","signal","ruby","agent","research","preview"].includes(row.source) || !["line","zone","marker"].includes(row.type) || !text(row.label) || !color(overlayColor(row))) return [];
      // Only fields consumed by rendering are retained. No mutable metadata or
      // trading capability is transferred into this display cache.
      return [{id:row.id,type:row.type,symbol:row.symbol,timeframe:row.timeframe,source:row.source,label:row.label,
        price:row.price,priceMin:row.priceMin,priceMax:row.priceMax,startTime:row.startTime,endTime:row.endTime,
        color:overlayColor(row),style:row.style,lineWidth:row.lineWidth,
        ...(row.marker && ["BUY","SELL"].includes(row.marker.side) ? {marker:{side:row.marker.side}} : {})}];
    });
  }
  reset(): void { this.lines=[];this.markers=[];this.annotation=null;this.overlays=[];this.latest=null;this.timeSeries=null;this.times=[]; }
  getState() { return {structureLines:this.lines.length,structureMarkers:this.markers.length,smartAnnotation:this.annotation!==null,overlays:this.overlays.length}; }
  private paintSegments(ctx:CanvasRenderingContext2D,frame:NativePriceFrame,lines:readonly ChartStructureLine[]) {
    ctx.save();
    try {
      const p=frame.plot;ctx.beginPath();ctx.rect(p.left,p.top,p.width,p.height);ctx.clip();
      for(const line of lines){
        // Exact anchors only: a missing structural endpoint cannot manufacture
        // a new bar on the shared time axis or be moved to another candle.
        const x1=frame.timeToX(line.start.time),x2=frame.timeToX(line.end.time),y1=frame.priceToY(line.start.price),y2=frame.priceToY(line.end.price);
        if(x1==null||x2==null||y1==null||y2==null)continue;
        ctx.strokeStyle=line.color;ctx.lineWidth=line.width===1?1:2;ctx.setLineDash(line.dashed?[4,4]:[]);
        ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
      }
    }finally{ctx.restore();}
  }
  paint(ctx:CanvasRenderingContext2D,frame:NativePriceFrame,canvasWidth:number,analysisFocused=false):void {
    if(this.timeSeries!==frame.series){this.timeSeries=frame.series;this.times=frame.series.candles.map(bar=>bar.time);}
    const times=this.times;
    // Focus changes analysis presentation only. Position/pending/research
    // display channels remain separate, as in the registered adapter.
    if(!analysisFocused){
      if(this.annotation){
        ctx.save();
        try {ctx.translate(frame.plot.left,frame.plot.top);paintSmartChartAnnotation(ctx,frame.plot,this.annotation,{
          timeToX:time=>{const x=frame.timeToX(time);return x==null?null:x-frame.plot.left;},
          priceToY:price=>{const y=frame.priceToY(price);return y==null?null:y-frame.plot.top;},
        });}finally{ctx.restore();}
      }else{
        this.paintSegments(ctx,frame,this.lines);
        // Retain the existing structural-event containing-bar policy; smart
        // annotations and research use strict observed timestamps separately.
        const markers=this.markers.flatMap(marker=>{const time=snapSecToCandle(marker.time,times);return time==null?[]:[{...marker,time,text:marker.label,shape:"circle" as const}];});
        paintScannerMarkers(ctx,frame,markers);
      }
    }
    const priceLines:ScannerPriceLine[]=[],markers:NativeScannerMarker[]=[],research:ChartStructureLine[]=[];
    const addLine=(value:unknown,row:ChartOverlay,title:string)=>{if(price(value))priceLines.push({price:value,color:row.color!,lineWidth:row.lineWidth===1?1:2,lineStyle:row.style==="dashed"?"dashed":"solid",axisLabelVisible:true,title});};
    for(const row of this.overlays){
      if(row.source==="research"){
        if(row.type==="line"&&price(row.price)&&time(row.startTime)&&time(row.endTime)&&row.startTime<row.endTime)
          research.push({id:row.id,start:{time:row.startTime,price:row.price},end:{time:row.endTime,price:row.price},color:row.color!,dashed:true,width:1});
      }else if(row.type==="line")addLine(row.price,row,row.label);
      else if(row.type==="zone"){addLine(row.priceMin,row,`${row.label} ▽`);addLine(row.priceMax,row,`${row.label} △`);}
      if(row.type==="marker"&&row.marker){
        const at=row.source==="research"?time(row.startTime)&&frame.timeToX(row.startTime)!=null?row.startTime:null:this.latest==null?null:snapSecToCandle(this.latest,times);
        if(at!=null)markers.push({time:at,position:row.marker.side==="BUY"?"belowBar":"aboveBar",shape:row.marker.side==="BUY"?"arrowUp":"arrowDown",color:row.color!,text:row.label});
      }
    }
    this.paintSegments(ctx,frame,research);paintScannerPriceLines(ctx,frame,canvasWidth,priceLines);paintScannerMarkers(ctx,frame,markers);
  }
}
