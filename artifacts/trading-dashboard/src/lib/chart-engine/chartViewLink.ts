import type { ChartEngineAdapter, ChartEngineCandle } from "./types";

export interface ChartTimeRange { from: number; to: number }
export type ChartViewEvent = { kind: "crosshair"; time: number | null } | { kind: "range"; range: ChartTimeRange };
export interface ChartLinkOptions { crosshair: boolean; range: boolean }

export function validTimeRange(range: ChartTimeRange): boolean {
  return Number.isFinite(range.from) && Number.isFinite(range.to) && range.from > 0 && range.to > range.from;
}

/** Find the actual bar containing a timestamp. Do not bridge a session gap or
 * substitute the latest candle when the linked timestamp has no loaded data. */
export function candleAtLinkedTime(candles: ChartEngineCandle[], time: number, intervalSeconds: number): ChartEngineCandle | null {
  if (!Number.isFinite(time) || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (candles[mid]!.time <= time) lo = mid + 1; else hi = mid; }
  const bar = candles[lo - 1];
  return bar && time < bar.time + intervalSeconds ? bar : null;
}

/** Workspace-local display bus. It never writes the primary symbol, timeframe,
 * intelligence, or trade ticket. Adapters publish user-originated changes only;
 * the guard also contains synchronous echo from alternative chart engines. */
export class ChartViewLink {
  private charts = new Map<string, ChartEngineAdapter>();
  private applying = new Set<ChartEngineAdapter>();
  private options: ChartLinkOptions = { crosshair: false, range: false };
  private lastRange: ChartTimeRange | null = null;

  configure(options: ChartLinkOptions): void {
    const old = this.options;
    this.options = options;
    if (!options.range) this.lastRange = null;
    for (const adapter of this.charts.values()) this.apply(adapter, () => {
      if (old.crosshair && !options.crosshair) adapter.setLinkedCrosshair?.(null);
      if (old.range && !options.range) adapter.setLinkedTimeRange?.(null);
    });
  }

  register(id: string, adapter: ChartEngineAdapter): () => void {
    this.charts.get(id)?.setViewLinkHandler?.(null);
    this.charts.set(id, adapter);
    adapter.setViewLinkHandler?.(event => this.publish(id, adapter, event));
    if (this.options.range && this.lastRange) this.apply(adapter, () => adapter.setLinkedTimeRange?.(this.lastRange));
    return () => {
      adapter.setViewLinkHandler?.(null);
      if (this.charts.get(id) === adapter) this.charts.delete(id);
    };
  }

  private apply(adapter: ChartEngineAdapter, fn: () => void): void {
    this.applying.add(adapter);
    try { fn(); } finally { this.applying.delete(adapter); }
  }

  private publish(id: string, source: ChartEngineAdapter, event: ChartViewEvent): void {
    if (this.charts.get(id) !== source || this.applying.has(source)) return;
    if (event.kind === "crosshair") {
      if (!this.options.crosshair || (event.time !== null && (!Number.isFinite(event.time) || event.time <= 0))) return;
    } else {
      if (!this.options.range || !validTimeRange(event.range)) return;
      this.lastRange = { ...event.range };
    }
    for (const adapter of this.charts.values()) {
      if (adapter === source) continue;
      this.apply(adapter, () => event.kind === "crosshair"
        ? adapter.setLinkedCrosshair?.(event.time)
        : adapter.setLinkedTimeRange?.(event.range));
    }
  }
}
