export interface SmartChartAnnotation {
  id: string;
  anchors: {time:number;price:number;label:string}[];
  /** False for separate events, which do not define a connecting price path. */
  connectAnchors?: boolean;
  level?: {price:number;label:string};
  guide?: {from:{time:number;price:number};to:{time:number;price:number}};
  /** Explicit independent lines, such as a pole and parallel channel edges. */
  segments?: {from:{time:number;price:number};to:{time:number;price:number}}[];
  color: string;
  dashed: boolean;
}


const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const point = (value: unknown): value is { time:number; price:number } => record(value) && positive(value.time) && positive(value.price);
const segment = (value: unknown): value is { from:{time:number;price:number};to:{time:number;price:number} } => record(value) && point(value.from) && point(value.to);

/** Defensive evidence snapshot. Invalid shapes are withheld, never repaired. */
export function cloneSmartChartAnnotation(input: SmartChartAnnotation | null): SmartChartAnnotation | null {
  if (!record(input) || typeof input.id !== "string" || typeof input.color !== "string" || !/^#[a-f\d]{6}$/i.test(input.color)
    || typeof input.dashed !== "boolean" || !Array.isArray(input.anchors) || input.anchors.length > 8
    || !input.anchors.every(anchor => point(anchor) && typeof (anchor as {label?:unknown}).label === "string")
    || (input.connectAnchors !== undefined && typeof input.connectAnchors !== "boolean")
    || (input.level !== undefined && (!record(input.level) || !positive(input.level.price) || typeof input.level.label !== "string"))
    || (input.guide !== undefined && !segment(input.guide))
    || (input.segments !== undefined && (!Array.isArray(input.segments) || input.segments.length > 3
      || !input.segments.every(row => segment(row) && row.from.time < row.to.time)))) return null;
  return { id:input.id, color:input.color, dashed:input.dashed,
    anchors:input.anchors.map(anchor => ({time:anchor.time,price:anchor.price,label:anchor.label})),
    ...(input.connectAnchors === undefined ? {} : {connectAnchors:input.connectAnchors}),
    ...(input.level === undefined ? {} : {level:{price:input.level.price,label:input.level.label}}),
    ...(input.guide === undefined ? {} : {guide:{from:{...input.guide.from},to:{...input.guide.to}}}),
    ...(input.segments === undefined ? {} : {segments:input.segments.map(row=>({from:{...row.from},to:{...row.to}}))}),
  };
}

export interface SmartChartAnnotationProjection {
  /** Null means this exact timestamp is not an observed loaded candle. */
  timeToX(time:number):number|null;
  priceToY(price:number):number|null;
}

/** Plot-local painter shared by registered and native chart renderers. */
export function paintSmartChartAnnotation(ctx: CanvasRenderingContext2D, mediaSize:{width:number;height:number}, annotation:SmartChartAnnotation|null, project:SmartChartAnnotationProjection):void {
  if (!Number.isFinite(mediaSize.width) || !Number.isFinite(mediaSize.height) || mediaSize.width <= 0 || mediaSize.height <= 0) return;
  const a=cloneSmartChartAnnotation(annotation);
  if (!a || a.segments?.some(row => [project.timeToX(row.from.time),project.timeToX(row.to.time)].some(value => value === null || !Number.isFinite(value)))) return;
    const points=a.anchors.map(anchor=>{
      const x=project.timeToX(anchor.time),y=project.priceToY(anchor.price);
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
      for(const segment of a.segments??[]){
        const x1=project.timeToX(segment.from.time),x2=project.timeToX(segment.to.time);
        const y1=project.priceToY(segment.from.price),y2=project.priceToY(segment.to.price);
        if(x1!=null&&x2!=null&&y1!=null&&y2!=null&&[x1,x2,y1,y2].every(Number.isFinite)){
          ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
        }
      }
      if(a.level&&p.length>1){
        const y=project.priceToY(a.level.price);
        if(y!=null&&Number.isFinite(y)){ctx.setLineDash([3,5]);ctx.beginPath();ctx.moveTo(p[0]!.x,y);ctx.lineTo(p.at(-1)!.x,y);ctx.stroke();}
      }
      if(a.guide){
        const x1=project.timeToX(a.guide.from.time),x2=project.timeToX(a.guide.to.time);
        const y1=project.priceToY(a.guide.from.price),y2=project.priceToY(a.guide.to.price);
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
}
