import type { IPrimitivePaneRenderer, ISeriesPrimitive, SeriesAttachedParameter, UTCTimestamp } from "lightweight-charts";
import type { ChartEngineCandle } from "./types";

export interface SmartChartAnnotation {
  id: string;
  anchors: {time:number;price:number;label:string}[];
  level?: {price:number;label:string};
  guide?: {from:{time:number;price:number};to:{time:number;price:number}};
  color: string;
  dashed: boolean;
}

/** One focused pattern, drawn over actual candles. No auxiliary price series,
 * scale changes, synthetic timestamps, persistent drawings or hit targets. */
export class SmartChartAnnotationPrimitive implements ISeriesPrimitive {
  private attachment:SeriesAttachedParameter|null=null;
  private annotation:SmartChartAnnotation|null=null;
  private times=new Set<number>();
  private renderer:IPrimitivePaneRenderer={draw:target=>target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
    const a=this.annotation,host=this.attachment;
    if(!a||!host)return;
    const points=a.anchors.map(anchor=>{
      if(!this.times.has(anchor.time))return null;
      const x=host.chart.timeScale().timeToCoordinate(anchor.time as UTCTimestamp),y=host.series.priceToCoordinate(anchor.price);
      return x!=null&&y!=null&&Number.isFinite(x)&&Number.isFinite(y)?{x,y,label:anchor.label}:null;
    });
    // Missing anchors are never snapped onto a different observed candle.
    if(!points.length||points.some(point=>point==null))return;
    const p=points.filter((point):point is NonNullable<typeof point>=>point!=null);
    ctx.save();
    try {
      ctx.beginPath();ctx.rect(0,0,mediaSize.width,mediaSize.height);ctx.clip();
      ctx.strokeStyle=a.color;ctx.fillStyle=a.color;ctx.lineWidth=1.5;ctx.setLineDash(a.dashed?[4,4]:[]);
      ctx.beginPath();p.forEach((point,i)=>i?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));ctx.stroke();
      if(a.level&&p.length>1){
        const y=host.series.priceToCoordinate(a.level.price);
        if(y!=null&&Number.isFinite(y)){ctx.setLineDash([3,5]);ctx.beginPath();ctx.moveTo(p[0]!.x,y);ctx.lineTo(p.at(-1)!.x,y);ctx.stroke();}
      }
      if(a.guide&&this.times.has(a.guide.from.time)&&this.times.has(a.guide.to.time)){
        const x1=host.chart.timeScale().timeToCoordinate(a.guide.from.time as UTCTimestamp),x2=host.chart.timeScale().timeToCoordinate(a.guide.to.time as UTCTimestamp);
        const y1=host.series.priceToCoordinate(a.guide.from.price),y2=host.series.priceToCoordinate(a.guide.to.price);
        if(x1!=null&&x2!=null&&y1!=null&&y2!=null&&[x1,x2,y1,y2].every(Number.isFinite)){
          ctx.setLineDash([3,5]);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
        }
      }
      ctx.setLineDash([]);ctx.font="11px sans-serif";
      const labels:{x:number;y:number;width:number}[]=[];
      for(const point of p){
        if(point.x<0||point.x>mediaSize.width||point.y<0||point.y>mediaSize.height)continue;
        ctx.beginPath();ctx.arc(point.x,point.y,3,0,Math.PI*2);ctx.fill();
        if(labels.length>=3||!point.label)continue;
        const label=point.label.slice(0,30),width=ctx.measureText(label).width+10;
        const x=Math.max(2,Math.min(mediaSize.width-width-2,point.x-width/2)),y=Math.max(15,point.y-12);
        if(labels.some(previous=>Math.abs(previous.y-y)<18&&x<previous.x+previous.width+4&&x+width>previous.x-4))continue;
        labels.push({x,y,width});ctx.fillStyle="#09090be8";ctx.fillRect(x,y-12,width,16);
        ctx.fillStyle=a.color;ctx.fillText(label,x+5,y);
      }
    } finally {ctx.restore();}
  })};
  attached(attachment:SeriesAttachedParameter):void {this.attachment=attachment;attachment.requestUpdate();}
  detached():void {this.attachment=null;}
  paneViews(){return[{zOrder:()=>"normal" as const,renderer:()=>this.renderer}];}
  updateAllViews():void {}
  setData(annotation:SmartChartAnnotation|null,candles:readonly ChartEngineCandle[]):void {
    this.annotation=annotation&&/^#[a-f\d]{6}$/i.test(annotation.color)&&annotation.anchors.length<=8
      &&annotation.anchors.every(p=>Number.isFinite(p.time)&&p.time>0&&Number.isFinite(p.price)&&p.price>0)
      &&(!annotation.guide||[annotation.guide.from,annotation.guide.to].every(p=>Number.isFinite(p.time)&&p.time>0&&Number.isFinite(p.price)&&p.price>0))
      &&(!annotation.level||Number.isFinite(annotation.level.price)&&annotation.level.price>0)?annotation:null;
    this.times=new Set(candles.map(c=>c.time));this.attachment?.requestUpdate();
  }
}
