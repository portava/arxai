import type { IPrimitivePaneRenderer, ISeriesPrimitive, SeriesAttachedParameter, UTCTimestamp } from "lightweight-charts";
import type { ChartEngineCandle } from "./types";
import { cloneSmartChartAnnotation, paintSmartChartAnnotation, type SmartChartAnnotation } from "./smartChartAnnotationCanvas";
export { cloneSmartChartAnnotation, paintSmartChartAnnotation, type SmartChartAnnotation, type SmartChartAnnotationProjection } from "./smartChartAnnotationCanvas";

/** One focused pattern over actual candles, with shared ARX geometry/painter. */
export class SmartChartAnnotationPrimitive implements ISeriesPrimitive {
  private attachment:SeriesAttachedParameter|null=null;
  private annotation:SmartChartAnnotation|null=null;
  private times=new Set<number>();
  private renderer:IPrimitivePaneRenderer={draw:target=>target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
    const host=this.attachment;
    if(!host)return;
    paintSmartChartAnnotation(ctx,mediaSize,this.annotation,{
      timeToX:time=>this.times.has(time)?host.chart.timeScale().timeToCoordinate(time as UTCTimestamp):null,
      priceToY:price=>host.series.priceToCoordinate(price),
    });
  })};
  attached(attachment:SeriesAttachedParameter):void {this.attachment=attachment;attachment.requestUpdate();}
  detached():void {this.attachment=null;}
  paneViews(){return[{zOrder:()=>"normal" as const,renderer:()=>this.renderer}];}
  updateAllViews():void {}
  setData(annotation:SmartChartAnnotation|null,candles:readonly ChartEngineCandle[]):void {
    this.annotation=cloneSmartChartAnnotation(annotation);
    this.times=new Set(candles.map(c=>c.time));this.attachment?.requestUpdate();
  }
}
