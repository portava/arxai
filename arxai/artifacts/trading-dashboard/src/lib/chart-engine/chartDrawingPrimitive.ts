import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, ISeriesPrimitiveAxisView, SeriesAttachedParameter, UTCTimestamp } from "lightweight-charts";
import { drawingSegments, type ChartAnchor, type ChartDrawing } from "./chartWorkspace";
import { measurementLabels } from "./chartRangeMeasurement";
import type { ChartEngineCandle } from "./types";
import { measureDrawingRender, type DrawingFidelity } from "./drawingRenderFidelity";
import { layoutTextNote, NOTE_FONT, NOTE_HEADER_HEIGHT, NOTE_LINE_HEIGHT, NOTE_PADDING, type MeasureNoteText, type NoteLayout } from "./chartTextNote";

export interface PixelPoint { x: number; y: number }
export interface DrawingStroke { id: string; start: PixelPoint; end: PixelPoint; color: string; dashed: boolean; width: number; label?: string; measurement?: string[] }
export type ProjectAnchor = (anchor: ChartAnchor, priceOnly?: boolean) => PixelPoint | null;
export interface DrawingNote extends NoteLayout { id: string; anchor: PixelPoint; x: number; y: number; color: string; truncated: boolean; compact: boolean }

/** Notes follow real loaded candle anchors. They never pin to the window when
 * their anchor scrolls away, contribute prices to autoscale, or invent bars. */
export function drawingNotes(drawings: ChartDrawing[], project: ProjectAnchor, width: number, height: number, measure?: MeasureNoteText): DrawingNote[] {
  const notes: DrawingNote[] = [];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height < NOTE_PADDING * 2 + NOTE_LINE_HEIGHT + 8) return notes;
  for (const drawing of drawings) {
    if (drawing.hidden || drawing.kind !== "text") continue;
    const point = project(drawing.start);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > width || point.y < 0 || point.y > height) continue;
    const layout = layoutTextNote(drawing.text ?? "", width - 8, measure);
    if (!layout) continue;
    const availableHeight = height - 8;
    const truncated = layout.height > availableHeight;
    const compact = truncated && availableHeight < NOTE_PADDING * 2 + NOTE_HEADER_HEIGHT + NOTE_LINE_HEIGHT;
    const maxLines = Math.max(0, Math.floor((availableHeight - NOTE_PADDING * 2 - NOTE_HEADER_HEIGHT - NOTE_LINE_HEIGHT) / NOTE_LINE_HEIGHT));
    const lines = truncated ? layout.lines.slice(0, compact ? 0 : maxLines) : layout.lines;
    const noteHeight = !truncated ? layout.height : compact ? NOTE_PADDING * 2 + NOTE_LINE_HEIGHT : NOTE_PADDING * 2 + NOTE_HEADER_HEIGHT + (lines.length + 1) * NOTE_LINE_HEIGHT;
    notes.push({ ...layout, lines, height: noteHeight, truncated, compact, id: drawing.id, anchor: point, color: drawing.color,
      x: Math.max(4, Math.min(point.x + 8, width - layout.width - 4)),
      y: Math.max(4, Math.min(point.y + 8, height - noteHeight - 4)),
    });
  }
  return notes;
}

/** Drawing geometry never contributes timestamps, prices, or autoscale extents
 * to the market series. Forty Fibs are forty objects, not 280 data series. */
export function drawingStrokes(drawings: ChartDrawing[], project: ProjectAnchor, width: number, height = 0): DrawingStroke[] {
  const strokes: DrawingStroke[] = [];
  for (const drawing of drawings) {
    if (drawing.hidden) continue;
    const style = { id: drawing.id, color: drawing.color, width: drawing.width ?? 1, dashed: drawing.dashed ?? ["horizontal", "fibonacci"].includes(drawing.kind) };
    if (drawing.kind === "horizontal") {
      const start = project(drawing.start, true);
      if (start) strokes.push({ ...style, start: { x: 0, y: start.y }, end: { x: width, y: start.y } });
      continue;
    }
    if (drawing.kind === "vertical") {
      const point = project(drawing.start);
      if (point) strokes.push({ ...style, start: { x: point.x, y: 0 }, end: { x: point.x, y: height } });
      continue;
    }
    if (drawing.kind === "measure") {
      const start=project(drawing.start), end=drawing.end && project(drawing.end);
      if (!start || !end || !drawing.end) continue;
      const corner={x:end.x,y:start.y};
      strokes.push({...style,start,end,measurement:measurementLabels(drawing.start,drawing.end)},
        {...style,dashed:true,start,end:corner},{...style,dashed:true,start:corner,end});
      continue;
    }
    if (drawing.kind === "channel") {
      const start = project(drawing.start), end = drawing.end && project(drawing.end), offset = drawing.offset && project(drawing.offset);
      if (!start || !end || !offset || Math.abs(end.x - start.x) < .001) continue;
      // Project first: parallelism is measured in the displayed price scale,
      // including logarithmic/inverted modes and real candle-index spacing.
      const shift = offset.y - (start.y + (end.y - start.y) * (offset.x - start.x) / (end.x - start.x));
      if (!Number.isFinite(shift)) continue;
      // Left/right describe time-axis directions, not drawing gesture order.
      // Keep original handles/anchors; only the displayed segments extend.
      const slope = (end.y - start.y) / (end.x - start.x);
      const left = Math.min(start.x,end.x), right = Math.max(start.x,end.x);
      const x1 = drawing.extendLeft ? Math.min(0,left) : left;
      const x2 = drawing.extendRight ? Math.max(width,right) : right;
      const at = (x:number,delta=0) => ({x,y:start.y+slope*(x-start.x)+delta});
      // Preserve finite-channel ordering for existing objects and drag logic.
      const from = start.x <= end.x ? x1 : x2, to = start.x <= end.x ? x2 : x1;
      const first = {start:at(from),end:at(to)}, second = {start:at(from,shift),end:at(to,shift)};
      if (![first.start.y,first.end.y,second.start.y,second.end.y].every(Number.isFinite)) continue;
      strokes.push({...style,...first}, {...style,...second});
      if (drawing.middleLine) strokes.push({...style,dashed:true,start:at(from,shift/2),end:at(to,shift/2)});
      continue;
    }
    for (const segment of drawingSegments(drawing)) {
      let start = project(segment.start), end = project(segment.end);
      if (!start || !end) continue;
      if (["ray", "extended"].includes(drawing.kind)) {
        const dx = end.x - start.x;
        if (Math.abs(dx) < .001) continue;
        const slope = (end.y - start.y) / dx;
        const at = (x: number) => ({ x, y: start!.y + slope * (x - start!.x) });
        end = at(dx > 0 ? width : 0);
        if (drawing.kind === "extended") start = at(dx > 0 ? 0 : width);
      }
      strokes.push({ ...style, start, end, ...(drawing.kind === "fibonacci" ? { label: segment.label } : {}) });
    }
  }
  return strokes;
}

export function drawingHandles(drawing: ChartDrawing, project: ProjectAnchor, width: number, height: number): { part: "start" | "end" | "offset"; point: PixelPoint }[] {
  if (drawing.hidden) return [];
  const start = project(drawing.start, drawing.kind === "horizontal");
  if (!start) return [];
  if (drawing.kind === "horizontal") return [{ part: "start", point: { x: width / 2, y: start.y } }];
  if (drawing.kind === "vertical") return [{ part: "start", point: { x: start.x, y: height / 2 } }];
  if (drawing.kind === "text") return [{ part: "start", point: start }];
  const end = drawing.end && project(drawing.end);
  if (!end) return [];
  if (drawing.kind === "channel") {
    const offset = drawing.offset && project(drawing.offset);
    return offset ? [{part:"start",point:start},{part:"end",point:end},{part:"offset",point:offset}] : [];
  }
  return [{ part: "start", point: start }, { part: "end", point: end }];
}

export function hitTestDrawings(drawings: ChartDrawing[], selected: string | null, project: ProjectAnchor, width: number, height: number, point: PixelPoint, tolerance = 8): { id: string; part: "start" | "end" | "offset" | "body" } | null {
  const active = drawings.find(drawing => drawing.id === selected && !drawing.hidden);
  if (active && !active.locked) for (const handle of drawingHandles(active, project, width, height)) {
    if (Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= tolerance + 2) return { id: active.id, part: handle.part };
  }
  // Text cards render above line geometry, in object order.
  for (const note of drawingNotes(drawings, project, width, height).reverse()) {
    if (point.x >= note.x && point.x <= note.x + note.width && point.y >= note.y && point.y <= Math.min(height, note.y + note.height)) return { id: note.id, part: "body" };
    if (Math.hypot(point.x - note.anchor.x, point.y - note.anchor.y) <= tolerance) return { id: note.id, part: "body" };
  }
  for (const stroke of drawingStrokes(drawings, project, width, height).reverse()) {
    const dx = stroke.end.x - stroke.start.x, dy = stroke.end.y - stroke.start.y;
    const length = dx * dx + dy * dy;
    const fraction = length ? Math.max(0, Math.min(1, ((point.x - stroke.start.x) * dx + (point.y - stroke.start.y) * dy) / length)) : 0;
    if (Math.hypot(point.x - stroke.start.x - dx * fraction, point.y - stroke.start.y - dy * fraction) <= tolerance + stroke.width / 2) return { id: stroke.id, part: "body" };
  }
  return null;
}

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
      ctx.save();
      try {
        ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
        ctx.font = "10px sans-serif";
        for (const stroke of this.strokes) {
          // Clip large offscreen histories without changing stored anchors.
          if (Math.max(stroke.start.x, stroke.end.x) < 0 || Math.min(stroke.start.x, stroke.end.x) > mediaSize.width) continue;
          if (Math.max(stroke.start.y, stroke.end.y) < 0 || Math.min(stroke.start.y, stroke.end.y) > mediaSize.height) continue;
          ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color;
          ctx.lineWidth = stroke.width; ctx.setLineDash(stroke.dashed ? [4, 4] : []);
          ctx.beginPath(); ctx.moveTo(stroke.start.x, stroke.start.y); ctx.lineTo(stroke.end.x, stroke.end.y); ctx.stroke();
          if (stroke.measurement?.length && mediaSize.width >= 100 && mediaSize.height >= 44) {
            // Keep the compact readout inside the plot. Objects retains the full
            // values when a very narrow pane cannot show a readable label.
            const width=Math.min(mediaSize.width-8,Math.max(...stroke.measurement.map(line=>ctx.measureText(line).width))+12);
            const height=stroke.measurement.length*14+8;
            const x=Math.max(4,Math.min(stroke.end.x+8,mediaSize.width-width-4));
            const y=Math.max(4,Math.min(stroke.end.y+8,mediaSize.height-height-4));
            ctx.save();ctx.fillStyle="#09090bee";ctx.fillRect(x,y,width,height);
            ctx.beginPath();ctx.rect(x,y,width,height);ctx.clip();ctx.fillStyle=stroke.color;
            stroke.measurement.forEach((line,index)=>ctx.fillText(line,x+6,y+14+index*14));ctx.restore();
          }
          if (stroke.label) {
            const left = stroke.start.x < stroke.end.x ? stroke.start : stroke.end;
            ctx.fillText(stroke.label, Math.max(3, left.x + 3), left.y - 3);
          }
        }
        ctx.font = NOTE_FONT;
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        for (const note of this.notes) {
          ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeStyle = note.color;
          ctx.beginPath(); ctx.moveTo(note.anchor.x, note.anchor.y); ctx.lineTo(note.x, note.y); ctx.stroke();
          ctx.fillStyle = "#18181bee"; ctx.fillRect(note.x, note.y, note.width, note.height);
          ctx.strokeRect(note.x, note.y, note.width, note.height);
          ctx.fillStyle = note.color;
          ctx.fillText(note.compact ? "Your note · Objects" : "Your note", note.x + NOTE_PADDING, note.y + NOTE_PADDING, note.width - NOTE_PADDING * 2);
          ctx.fillStyle = "#f4f4f5";
          note.lines.forEach((line, index) => ctx.fillText(line, note.x + NOTE_PADDING, note.y + NOTE_PADDING + NOTE_HEADER_HEIGHT + index * NOTE_LINE_HEIGHT, note.width - NOTE_PADDING * 2));
          if (note.truncated && !note.compact) {
            ctx.fillStyle = note.color;
            ctx.fillText("More in Objects", note.x + NOTE_PADDING, note.y + NOTE_PADDING + NOTE_HEADER_HEIGHT + note.lines.length * NOTE_LINE_HEIGHT, note.width - NOTE_PADDING * 2);
          }
          ctx.beginPath(); ctx.arc(note.anchor.x, note.anchor.y, 3, 0, Math.PI * 2); ctx.fillStyle = note.color; ctx.fill();
        }
        ctx.setLineDash([]); ctx.lineWidth = 2; ctx.strokeStyle = "#38bdf8"; ctx.fillStyle = "#09090b";
        for (const point of this.handles) {
          ctx.beginPath(); ctx.arc(point.x, point.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      } finally { ctx.restore(); }
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
  /**
   * Render-fidelity read-back (drawingRenderFidelity.ts): the geometry this
   * primitive paints, measured against the stored anchors through the
   * engine's own pixel→price / pixel→time axes. null when not attached.
   */
  measureRender(priceStep: number): DrawingFidelity | null {
    const attached = this.attachment;
    if (!attached) return null;
    if (this.dirty) this.updateGeometry();
    const width = attached.chart.timeScale().width(), height = attached.series.getPane().getHeight();
    return measureDrawingRender(this.drawings, this.strokes, this.notes, this.projector(), {
      price: y => attached.series.coordinateToPrice(y),
      time: x => { const t = attached.chart.timeScale().coordinateToTime(x); return typeof t === "number" ? t : null; },
    }, width, height, priceStep);
  }

  private projector(): ProjectAnchor {
    const attached = this.attachment!;
    return (anchor, priceOnly) => {
      const y = attached.series.priceToCoordinate(anchor.price);
      if (y == null || !Number.isFinite(y) || !this.times.size) return null;
      // Horizontal levels are price-only and remain visible after backfill rolls.
      const x = priceOnly ? 0 : this.times.has(anchor.time) ? attached.chart.timeScale().timeToCoordinate(anchor.time as UTCTimestamp) : null;
      return x == null ? null : { x, y };
    };
  }

  private updateGeometry(): void {
    this.dirty = false;
    const attached = this.attachment;
    if (!attached) return;
    const project = this.projector();
    const width = attached.chart.timeScale().width(), height = attached.series.getPane().getHeight();
    this.strokes = drawingStrokes(this.drawings, project, width, height);
    this.notes = drawingNotes(this.drawings, project, width, height);
    const selected = this.drawings.find(drawing => drawing.id === this.selected);
    this.handles = selected && !selected.locked ? drawingHandles(selected, project, width, height).map(handle => handle.point) : [];
  }
}
