import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, ISeriesPrimitiveAxisView, SeriesAttachedParameter, UTCTimestamp } from "lightweight-charts";
import type { ChartDrawing } from "./chartWorkspace";
import type { ChartEngineCandle } from "./types";
import { drawingStrokes, drawingNotes, drawingHandles, paintChartDrawings, type DrawingStroke, type DrawingNote, type PixelPoint, type ProjectAnchor } from "./chartDrawingCanvas";
// Compatibility exports keep existing callers on the same implementation.
export { drawingStrokes, drawingNotes, drawingHandles, hitTestDrawings, paintChartDrawings } from "./chartDrawingCanvas";
export type { DrawingStroke, DrawingNote, PixelPoint, ProjectAnchor } from "./chartDrawingCanvas";

export class ChartDrawingPrimitive implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private drawings: ChartDrawing[] = [];
  private times = new Set<number>();
  private strokes: DrawingStroke[] = [];
  private notes: DrawingNote[] = [];
  private dirty = true;
  private selected: string | null = null;
  private candleRef: ChartEngineCandle[] | null = null;
  private candleKey = "";
  private handles: PixelPoint[] = [];
  private labels: ISeriesPrimitiveAxisView[] = [];
  private renderer: IPrimitivePaneRenderer = {
    draw: target => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (this.dirty) this.updateGeometry();
      paintChartDrawings(ctx, mediaSize, this.strokes, this.notes, this.handles);
    }),
  };
  private views: IPrimitivePaneView[] = [{ zOrder: () => "normal", renderer: () => this.renderer }];

  attached(attachment: SeriesAttachedParameter): void { this.attachment = attachment; this.updateAllViews(); }
  detached(): void { this.attachment = null; this.strokes = []; this.notes = []; this.labels = []; this.handles = []; }
  paneViews(): readonly IPrimitivePaneView[] { return this.views; }
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this.labels; }

  setData(drawings: ChartDrawing[], candles: ChartEngineCandle[]): void {
    this.drawings = drawings.filter(drawing => !drawing.hidden);
    const key = `${candles.length}:${candles[0]?.time}:${candles.at(-1)?.time}`;
    if (this.candleRef !== candles || this.candleKey !== key) {
      this.times = new Set(candles.map(candle => candle.time)); this.candleRef = candles; this.candleKey = key;
    }
    this.labels = this.drawings.filter(drawing => drawing.kind === "horizontal").map(drawing => ({
      coordinate: () => this.attachment?.series.priceToCoordinate(drawing.start.price) ?? -1e6,
      text: () => this.attachment?.series.priceFormatter().format(drawing.start.price) ?? String(drawing.start.price),
      textColor: () => "#09090b", backColor: () => drawing.color,
      visible: () => this.attachment != null && this.times.size > 0,
    }));
    this.updateAllViews();
    this.attachment?.requestUpdate();
  }

  setSelection(id: string | null): void {
    // Toolbar callbacks may refresh without changing selection. Data/viewport
    // invalidations have their own paths; an identical ID needs no repaint.
    if (this.selected === id) return;
    this.selected = id;
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
    const project: ProjectAnchor = (anchor, priceOnly) => {
      const y = attached.series.priceToCoordinate(anchor.price);
      if (y == null || !Number.isFinite(y) || !this.times.size) return null;
      // Horizontal levels are price-only and remain visible after backfill rolls.
      const x = priceOnly ? 0 : this.times.has(anchor.time) ? attached.chart.timeScale().timeToCoordinate(anchor.time as UTCTimestamp) : null;
      return x == null ? null : { x, y };
    };
    const width = attached.chart.timeScale().width(), height = attached.series.getPane().getHeight();
    this.strokes = drawingStrokes(this.drawings, project, width, height);
    this.notes = drawingNotes(this.drawings, project, width, height);
    const selected = this.drawings.find(drawing => drawing.id === this.selected);
    this.handles = selected && !selected.locked ? drawingHandles(selected, project, width, height).map(handle => handle.point) : [];
  }
}
