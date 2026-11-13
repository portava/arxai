import type { IPrimitivePaneRenderer,IPrimitivePaneView,ISeriesPrimitive,SeriesAttachedParameter } from './arxCanvas';
import type { VolumeProfileResult } from './chartVolumeProfile';
export interface ProfilePixelRow {index:number;x:number;y:number;width:number;height:number;poc:boolean;inValueArea:boolean}
/** Distribution columns use at most 28% of the price pane. Multiple profile
 * instances share that budget rather than hiding or painting over each other.
 * X is a quantity scale, not a fabricated time coordinate. */
export function projectVolumeProfile(result:VolumeProfileResult|null,project:(price:number)=>number|null,width:number,height:number,slot=0,count=1):ProfilePixelRow[] {
 if(!result||result.status!=='ready'||![width,height].every(n=>Number.isFinite(n)&&n>0)||!Number.isInteger(count)||count<1||slot<0||slot>=count)return [];
 const budget=Math.min(280,width*.28),column=budget/count,right=width-5-slot*column,maxWidth=Math.max(0,column-3),max=Math.max(...result.rows.map(r=>r.estimatedTradeUnits));
 if(maxWidth<=0||max<=0)return [];
 const geometry:ProfilePixelRow[]=[];
 result.rows.forEach((row,index)=>{const a=project(row.low),b=project(row.high);if(a==null||b==null||!Number.isFinite(a)||!Number.isFinite(b))return;
  const low=Math.min(a,b),high=Math.max(a,b),y=Math.max(0,low===high?low-1:low),bottom=Math.min(height,low===high?high+1:high);
  if(bottom<=y)return;const w=maxWidth*row.estimatedTradeUnits/max;if(w<=0)return;
  geometry.push({index,x:right-w,y,width:w,height:bottom-y,poc:index===result.pocIndex,inValueArea:index>=result.valueArea.fromIndex&&index<=result.valueArea.toIndex});
 });return geometry;
}
/** Geometry only; the existing study calculator owns the immutable aggregate. */
export class ChartVolumeProfilePrimitive implements ISeriesPrimitive {
 private attachment:SeriesAttachedParameter|null=null;
 private result:VolumeProfileResult|null=null;
 private color='#a78bfa';private slot=0;private count=1;
 private geometry:ProfilePixelRow[]=[];
 private dirty=true;
 private renderer:IPrimitivePaneRenderer={draw:target=>target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
  if(this.dirty){this.geometry=projectVolumeProfile(this.result,p=>this.attachment?.series.priceToCoordinate(p)??null,mediaSize.width,mediaSize.height,this.slot,this.count);this.dirty=false;}
  if(!this.geometry.length)return;
  ctx.save();try{ctx.beginPath();ctx.rect(0,0,mediaSize.width,mediaSize.height);ctx.clip();ctx.fillStyle=this.color;
   for(const row of this.geometry){ctx.globalAlpha=row.inValueArea ? .33 : .16;ctx.fillRect(row.x,row.y,row.width,row.height);if(row.poc){ctx.globalAlpha=.9;ctx.strokeStyle=this.color;ctx.lineWidth=1;ctx.strokeRect(row.x,row.y,row.width,row.height);}}
   if(this.slot===0&&mediaSize.width>=220){ctx.globalAlpha=1;ctx.font='10px sans-serif';ctx.textAlign='right';ctx.fillText(this.count===1?'Estimated profile':'Estimated profiles · '+this.count,mediaSize.width-6,13);}
  }finally{ctx.restore();}
 })};
 private views:IPrimitivePaneView[]=[{zOrder:()=> 'bottom',renderer:()=>this.renderer}];
 attached(value:SeriesAttachedParameter):void{this.attachment=value;this.dirty=true;}
 detached():void{this.attachment=null;this.geometry=[];this.dirty=true;}
 paneViews():readonly IPrimitivePaneView[]{return this.views;}
 updateAllViews():void{this.dirty=true;}
 setData(result:VolumeProfileResult,color:string,slot:number,count:number):void{if(this.result===result&&this.color===color&&this.slot===slot&&this.count===count)return;this.result=result;this.color=color;this.slot=slot;this.count=count;this.geometry=[];this.dirty=true;this.attachment?.requestUpdate();}
}
