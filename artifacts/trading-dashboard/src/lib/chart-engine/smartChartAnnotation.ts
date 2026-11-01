import type { IPrimitivePaneRenderer, ISeriesPrimitive, SeriesAttachedParameter, UTCTimestamp } from "lightweight-charts";
import type { ChartEngineCandle } from "./types";

export interface SmartChartAnnotation {
  id: string;
  anchors: {time:number;price:number;label:string}[];
  /** False for separate events, which do not define a connecting price path. */
  connectAnchors?: boolean;
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
      if(a.connectAnchors!==false){ctx.beginPath();p.forEach((point,i)=>i?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));ctx.stroke();}
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
      ctx.setLineDash([]);ctx.font="11px sans-serif";ctx.textAlign="left";ctx.textBaseline="alphabetic";
      const labels:{x:number;y:number;width:number}[]=[];
      for(const point of p){
        if(point.x<0||point.x>mediaSize.width||point.y<0||point.y>mediaSize.height)continue;
        ctx.beginPath();ctx.arc(point.x,point.y,3,0,Math.PI*2);ctx.fill();
        if(labels.length>=3||!point.label)continue;
        // Bound text to the plot, not the price scale. Try nearby positions
        // above/below/beside the point before dropping a crowded label. Only
        // text moves: candle anchors and pattern geometry remain untouched.
        const margin=4,height=16,maxWidth=mediaSize.width-2*margin;
        let label=point.label.slice(0,30);
        if(point.label.length>30)label=label.slice(0,-1)+"…";
        while(label&&ctx.measureText(label).width+10>maxWidth){
          const body=label.endsWith("…")?label.slice(0,-1):label;
          label=body.length>1?body.slice(0,-1)+"…":"";
        }
        if(!label||mediaSize.height<height+2*margin)continue;
        const width=ctx.measureText(label).width+10;
        const centeredX=Math.max(margin,Math.min(mediaSize.width-margin-width,point.x-width/2));
        const candidates=[{x:centeredX,y:point.y-24},{x:centeredX,y:point.y+12},
          {x:point.x-width-8,y:point.y-height/2},{x:point.x+8,y:point.y-height/2}];
        const box=candidates.find(box=>box.x>=margin&&box.y>=margin
          &&box.x+width<=mediaSize.width-margin&&box.y+height<=mediaSize.height-margin
          &&!labels.some(other=>box.x<other.x+other.width+4&&box.x+width>other.x-4&&box.y<other.y+height+4&&box.y+height>other.y-4)
          &&!p.some(anchor=>box.x<anchor.x+5&&box.x+width>anchor.x-5&&box.y<anchor.y+5&&box.y+height>anchor.y-5));
        if(!box)continue;
        labels.push({...box,width});ctx.fillStyle="#09090be8";ctx.fillRect(box.x,box.y,width,height);
        ctx.fillStyle=a.color;ctx.fillText(label,box.x+5,box.y+12);
      }
    } finally {ctx.restore();}
  })};
  attached(attachment:SeriesAttachedParameter):void {this.attachment=attachment;attachment.requestUpdate();}
  detached():void {this.attachment=null;}
  paneViews(){return[{zOrder:()=>"normal" as const,renderer:()=>this.renderer}];}
  updateAllViews():void {}
  setData(annotation:SmartChartAnnotation|null,candles:readonly ChartEngineCandle[]):void {
    this.annotation=annotation&&/^#[a-f\d]{6}$/i.test(annotation.color)&&annotation.anchors.length<=8
      &&(annotation.connectAnchors===undefined||typeof annotation.connectAnchors==="boolean")
      &&annotation.anchors.every(p=>Number.isFinite(p.time)&&p.time>0&&Number.isFinite(p.price)&&p.price>0)
      &&(!annotation.guide||[annotation.guide.from,annotation.guide.to].every(p=>Number.isFinite(p.time)&&p.time>0&&Number.isFinite(p.price)&&p.price>0))
      &&(!annotation.level||Number.isFinite(annotation.level.price)&&annotation.level.price>0)?annotation:null;
    this.times=new Set(candles.map(c=>c.time));this.attachment?.requestUpdate();
  }
}
