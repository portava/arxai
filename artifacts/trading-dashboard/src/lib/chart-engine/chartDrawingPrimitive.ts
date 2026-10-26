import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, ISeriesPrimitiveAxisView, SeriesAttachedParameter, UTCTimestamp } from "lightweight-charts";
import { drawingSegments, type ChartAnchor, type ChartDrawing } from "./chartWorkspace";
import type { ChartEngineCandle } from "./types";

interface PixelPoint { x: number; y: number }
export interface DrawingStroke { id: string; start: PixelPoint; end: PixelPoint; color: string; dashed: boolean; label?: string }
export type ProjectAnchor = (anchor: ChartAnchor, priceOnly?: boolean) => PixelPoint | null;

/** Drawing geometry never contributes timestamps, prices, or autoscale extents
 * to the market series. Forty Fibs are forty objects, not 280 data series. */
export function drawingStrokes(drawings: ChartDrawing[], project: ProjectAnchor, width: number): DrawingStroke[] {
  const strokes: DrawingStroke[] = [];
  for (const drawing of drawings) {
    if (drawing.kind === "horizontal") {
      const start = project(drawing.start, true);
      if (start) strokes.push({ id: drawing.id, start: { x: 0, y: start.y }, end: { x: width, y: start.y }, color: drawing.color, dashed: true });
      continue;
    }
    for (const segment of drawingSegments(drawing)) {
      const start = project(segment.start), end = project(segment.end);
      if (!start || !end) continue;
      strokes.push({ id: drawing.id, start, end, color: drawing.color, dashed: drawing.kind === "fibonacci", ...(drawing.kind === "fibonacci" ? { label: segment.label } : {}) });
    }
  }
  return strokes;
}

export class ChartDrawingPrimitive implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private drawings: ChartDrawing[] = [];
  private times = new Set<number>();
  private strokes: DrawingStroke[] = [];
  private dirty = true;
  private labels: ISeriesPrimitiveAxisView[] = [];
  private renderer: IPrimitivePaneRenderer = {
    draw: target => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (this.dirty) this.updateGeometry();
      ctx.save();
      try {
        ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
        ctx.font = "10px sans-serif";
        for (const stroke of this.strokes) {
          // Clip large offscreen histories without changing stored anchors.
          if (Math.max(stroke.start.x, stroke.end.x) < 0 || Math.min(stroke.start.x, stroke.end.x) > mediaSize.width) continue;
          if (Math.max(stroke.start.y, stroke.end.y) < 0 || Math.min(stroke.start.y, stroke.end.y) > mediaSize.height) continue;
          ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color;
          ctx.lineWidth = 1; ctx.setLineDash(stroke.dashed ? [4, 4] : []);
          ctx.beginPath(); ctx.moveTo(stroke.start.x, stroke.start.y); ctx.lineTo(stroke.end.x, stroke.end.y); ctx.stroke();
          if (stroke.label) {
            const left = stroke.start.x < stroke.end.x ? stroke.start : stroke.end;
            ctx.fillText(stroke.label, Math.max(3, left.x + 3), left.y - 3);
          }
        }
      } finally { ctx.restore(); }
    }),
  };
  private views: IPrimitivePaneView[] = [{ zOrder: () => "normal", renderer: () => this.renderer }];

  attached(attachment: SeriesAttachedParameter): void { this.attachment = attachment; this.updateAllViews(); }
  detached(): void { this.attachment = null; this.strokes = []; this.labels = []; }
  paneViews(): readonly IPrimitivePaneView[] { return this.views; }
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this.labels; }

  setData(drawings: ChartDrawing[], candles: ChartEngineCandle[]): void {
    this.drawings = drawings;
    this.times = new Set(candles.map(candle => candle.time));
    this.labels = drawings.filter(drawing => drawing.kind === "horizontal").map(drawing => ({
      coordinate: () => this.attachment?.series.priceToCoordinate(drawing.start.price) ?? -1e6,
      text: () => this.attachment?.series.priceFormatter().format(drawing.start.price) ?? String(drawing.start.price),
      textColor: () => "#09090b", backColor: () => drawing.color,
      visible: () => this.attachment != null && this.times.size > 0,
    }));
    this.updateAllViews();
    this.attachment?.requestUpdate();
  }

  // The chart can invalidate primitives for every series/tick in a burst.
  // Projection belongs at draw time, once per frame, not once per invalidation.
  updateAllViews(): void { this.dirty = true; }
  private updateGeometry(): void {
    this.dirty = false;
    const attached = this.attachment;
    if (!attached) return;
    this.strokes = drawingStrokes(this.drawings, (anchor, priceOnly) => {
      const y = attached.series.priceToCoordinate(anchor.price);
      if (y == null || !Number.isFinite(y) || !this.times.size) return null;
      // Horizontal levels are price-only and remain visible after backfill rolls.
      const x = priceOnly ? 0 : this.times.has(anchor.time) ? attached.chart.timeScale().timeToCoordinate(anchor.time as UTCTimestamp) : null;
      return x == null ? null : { x, y };
    }, attached.chart.timeScale().width());
  }
}
