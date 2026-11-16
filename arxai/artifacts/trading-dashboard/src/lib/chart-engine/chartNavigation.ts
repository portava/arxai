export interface LogicalWindow { from: number; to: number }

/** Navigation is bounded by real loaded bars, with a small inspection margin.
 * It changes only the view: zoom/pan never manufacture future/history candles. */
function bounded(center: number, span: number, count: number): LogicalWindow | null {
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(center) || !Number.isFinite(span)) return null;
  const width = Math.max(4, Math.min(count + 5, span));
  const from = Math.max(-3, Math.min(count + 2 - width, center - width / 2));
  return { from, to: from + width };
}
function valid(range: LogicalWindow | null): range is LogicalWindow {
  return !!range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from;
}
export function panChartWindow(range: LogicalWindow | null, fraction: number, count: number): LogicalWindow | null {
  if (!valid(range) || !Number.isFinite(fraction) || Math.abs(fraction) > 1) return null;
  const span = range.to - range.from;
  return bounded((range.from + range.to) / 2 + span * fraction, span, count);
}
/** factor < 1 zooms in; > 1 zooms out, preserving the visible midpoint. */
export function zoomChartWindow(range: LogicalWindow | null, factor: number, count: number): LogicalWindow | null {
  if (!valid(range) || !Number.isFinite(factor) || factor <= 0 || factor > 4) return null;
  return bounded((range.from + range.to) / 2, (range.to - range.from) * factor, count);
}
