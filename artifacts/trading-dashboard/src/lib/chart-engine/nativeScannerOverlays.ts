import type { NativePriceFrame } from "./nativePriceRenderer";
import type { ScannerEventMarker, ScannerOverlayHandle, ScannerOverlaySurface, ScannerPriceLine } from "./scannerChartSurface";

/** Internal trade arrows may point up; this does not widen the scanner contract. */
export type NativeScannerMarker = Omit<ScannerEventMarker, "shape"> & { shape: ScannerEventMarker["shape"] | "arrowUp" };
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const color = (value: unknown): value is string => typeof value === "string" && /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value);
const label = (value: unknown): value is string => typeof value === "string" && value.length <= 160 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
function lineCopy(value: ScannerPriceLine): ScannerPriceLine | null {
  if (!value || !positive(value.price) || !color(value.color) || !label(value.title)
    || (value.lineWidth !== 1 && value.lineWidth !== 2) || (value.lineStyle !== "solid" && value.lineStyle !== "dashed")
    || typeof value.axisLabelVisible !== "boolean") return null;
  return {price:value.price,color:value.color,title:value.title,lineWidth:value.lineWidth,lineStyle:value.lineStyle,axisLabelVisible:value.axisLabelVisible};
}
function markerCopy(value: NativeScannerMarker, internal = false): NativeScannerMarker | null {
  if (!value || !positive(value.time) || !color(value.color) || !label(value.text)
    || (value.position !== "aboveBar" && value.position !== "belowBar")
    || (value.shape !== "circle" && value.shape !== "arrowDown" && !(internal && value.shape === "arrowUp"))) return null;
  return {time:value.time,color:value.color,text:value.text,position:value.position,shape:value.shape};
}
function insideY(frame: NativePriceFrame, y: number | null): y is number {
  return y != null && Number.isFinite(y) && y >= frame.plot.top && y <= frame.plot.top + frame.plot.height;
}
function clipped(ctx: CanvasRenderingContext2D, frame: NativePriceFrame, paint: () => void): void {
  ctx.save();
  try { const p=frame.plot;ctx.beginPath();ctx.rect(p.left,p.top,p.width,p.height);ctx.clip();paint(); }
  finally { ctx.restore(); }
}
/** Original-price labels intentionally bypass percentage/indexed axis transforms. */
export function paintScannerPriceLines(ctx: CanvasRenderingContext2D, frame: NativePriceFrame, canvasWidth: number, lines: readonly ScannerPriceLine[]): void {
  for (const value of lines) {
    const line=lineCopy(value);if (!line) continue;
    const y=frame.priceToY(line.price);if (!insideY(frame,y)) continue;
    clipped(ctx,frame,()=>{
      ctx.strokeStyle=line.color;ctx.fillStyle=line.color;ctx.lineWidth=line.lineWidth;
      ctx.setLineDash(line.lineStyle==="dashed"?[5,4]:[]);
      ctx.beginPath();ctx.moveTo(frame.plot.left,y);ctx.lineTo(frame.plot.left+frame.plot.width,y);ctx.stroke();
      if (line.title) {ctx.font="11px sans-serif";ctx.textAlign="left";ctx.textBaseline="bottom";ctx.fillText(line.title,frame.plot.left+4,y-3);}
    });
    const left=frame.plot.left+frame.plot.width, width=canvasWidth-left;
    if (line.axisLabelVisible && Number.isFinite(width) && width>0) {
      ctx.save();
      try {
        ctx.beginPath();ctx.rect(left,frame.plot.top,width,frame.plot.height);ctx.clip();
        ctx.fillStyle=line.color;ctx.fillRect(left,y-8,width,16);
        ctx.fillStyle="#ffffff";ctx.font="11px monospace";ctx.textAlign="left";ctx.textBaseline="middle";
        if(width>8)ctx.fillText(String(line.price),left+4,y,width-8);
      } finally {ctx.restore();}
    }
  }
}
/** Canonical OHLC anchors remain canonical even when the price style is HA. */
export function paintScannerMarkers(ctx: CanvasRenderingContext2D, frame: NativePriceFrame, markers: readonly NativeScannerMarker[]): void {
  if (!markers.length) return;
  clipped(ctx,frame,()=>{
    for (const value of markers) {
      const marker=markerCopy(value,true);if (!marker) continue;
      const x=frame.timeToX(marker.time);
      if (x==null || !Number.isFinite(x) || x<frame.plot.left || x>frame.plot.left+frame.plot.width) continue;
      const bar=frame.barAtX(x);if (!bar || bar.time!==marker.time) continue;
      const anchor=frame.priceToY(marker.position==="aboveBar"?bar.high:bar.low);
      if (!insideY(frame,anchor)) continue;
      const y=anchor+(marker.position==="aboveBar"?-10:10);
      ctx.fillStyle=marker.color;ctx.strokeStyle=marker.color;ctx.lineWidth=1;ctx.setLineDash([]);ctx.beginPath();
      if(marker.shape==="circle")ctx.arc(x,y,3.5,0,Math.PI*2);
      else {
        const direction=marker.shape==="arrowDown"?1:-1;
        ctx.moveTo(x,y+direction*5);ctx.lineTo(x-4,y-direction*2);ctx.lineTo(x+4,y-direction*2);ctx.closePath();
      }
      ctx.fill();
      if(marker.text){ctx.font="11px sans-serif";ctx.textAlign="center";ctx.textBaseline=marker.position==="aboveBar"?"bottom":"top";ctx.fillText(marker.text,x,y+(marker.position==="aboveBar"?-7:7));}
    }
  });
}
interface Options {
  container: HTMLElement;
  getFrame(): NativePriceFrame | null;
  getSize(): {width:number;height:number};
  invalidate(): void;
}
type Layer = {lines: ScannerPriceLine[];markers: NativeScannerMarker[]};
/** One view-only scanner lease. No feed, autoscale, execution or money authority. */
export class NativeScannerOverlays {
  private generation=0;
  private destroyed=false;
  private surface: ScannerOverlaySurface | null=null;
  private layers=new Map<ScannerOverlayHandle,Layer>();
  constructor(private readonly options: Options) {}
  getSurface(): ScannerOverlaySurface {
    if(this.surface)return this.surface;
    const generation=this.generation;
    let disposed=false;
    const handles=new Set<ScannerOverlayHandle>();
    const available=()=>!this.destroyed&&!disposed&&generation===this.generation;
    const read=()=>{if(!available())return null;const frame=this.options.getFrame();return available()?frame:null;};
    const own=(layer:Layer):ScannerOverlayHandle=>{
      let released=false;
      const handle={dispose:()=>{
        if(released)return;released=true;handles.delete(handle);
        if(this.layers.delete(handle))this.options.invalidate();
      }};
      handles.add(handle);this.layers.set(handle,layer);this.options.invalidate();return handle;
    };
    const surface:ScannerOverlaySurface={
      container:this.options.container,
      priceToCoordinate:price=>{
        if(!positive(price))return null;const frame=read();if(!frame)return null;
        const y=frame.priceToY(price);return available()&&insideY(frame,y)?y:null;
      },
      coordinateToPrice:y=>{
        const frame=read();if(!frame||!insideY(frame,y))return null;
        const price=frame.yToPrice(y);return available()&&positive(price)?price:null;
      },
      createPriceLine:value=>{
        if(!available())return null;const line=lineCopy(value);return line&&available()?own({lines:[line],markers:[]}):null;
      },
      createMarkers:values=>{
        const frame=read();if(!frame||!Array.isArray(values)||!values.length)return null;
        const times=new Set(frame.series.candles.map(bar=>bar.time)),markers:NativeScannerMarker[]=[];let previous=-Infinity;
        for(const value of values){const marker=markerCopy(value);if(!marker||!times.has(marker.time)||marker.time<previous)return null;previous=marker.time;markers.push(marker);}
        return available()?own({lines:[],markers}):null;
      },
      dispose:()=>{
        if(disposed)return;disposed=true;
        // Revoke the lease before callbacks can obtain a replacement.
        if(this.surface===surface)this.surface=null;
        for(const handle of [...handles])handle.dispose();
      },
    };
    if(!this.destroyed)this.surface=surface;
    return surface;
  }
  paint(ctx:CanvasRenderingContext2D):void {
    if(this.destroyed)return;
    const generation=this.generation,frame=this.options.getFrame(),size=this.options.getSize();
    if(this.destroyed||generation!==this.generation||!frame)return;
    const layers=[...this.layers.values()];
    paintScannerPriceLines(ctx,frame,size.width,layers.flatMap(layer=>layer.lines));
    if(this.destroyed||generation!==this.generation)return;
    paintScannerMarkers(ctx,frame,layers.flatMap(layer=>layer.markers));
  }
  reset():void {
    if(this.destroyed)return;
    this.generation++;this.surface=null;this.layers.clear();this.options.invalidate();
  }
  destroy():void {
    if(this.destroyed)return;
    this.destroyed=true;this.generation++;this.surface=null;this.layers.clear();this.options.invalidate();
  }
  getState(){return Object.freeze({destroyed:this.destroyed,leaseActive:this.surface!==null,handleCount:this.layers.size,priceLineCount:[...this.layers.values()].reduce((n,l)=>n+l.lines.length,0),markerCount:[...this.layers.values()].reduce((n,l)=>n+l.markers.length,0)});}
}
