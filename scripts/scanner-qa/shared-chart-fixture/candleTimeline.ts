// Offline diagnostic only. Never import this from production application code.
type Row = { at: number; stage: string; detail: Record<string, unknown> };
type RecordState = { diagnosticOnly: true; events: Row[]; dropped: number };
const LIMIT = 2000;
export function recordCandleStage(stage: string, detail: Record<string, unknown> = {}) {
  const state = (window as unknown as { __arxCandleTimeline?: RecordState }).__arxCandleTimeline;
  if (!state) return;
  if (state.events.length >= LIMIT) { state.dropped++; return; }
  state.events.push({ at: performance.now(), stage, detail });
}
export function installCandleTimeline(Adapter: { prototype: any }, NativeViewport?: { prototype: any }) {
  if (location.origin !== "http://127.0.0.1:4299") throw Error("Candle timeline requires diagnostic loopback port");
  const target = window as unknown as { __arxCandleTimeline?: RecordState };
  if (target.__arxCandleTimeline) throw Error("Candle timeline already installed");
  if (typeof Adapter.prototype.setCandles !== 'function' || (NativeViewport && typeof NativeViewport.prototype.paint !== 'function')) {
    throw Error('Candle timeline engine seam changed');
  }
  target.__arxCandleTimeline = { diagnosticOnly: true, events: [], dropped: 0 };
  // IDs join adapter requests to viewport paint attempts, without copying bars,
  // prices, account data or querying getState/getFrame (which can do real work).
  const ids = new WeakMap<object, number>();
  let sequence = 0;
  const identity = (object: object | null | undefined) => {
    if (!object) return null;
    let id = ids.get(object);
    if (id === undefined) { id = ++sequence; ids.set(object, id); }
    return id;
  };
  if (NativeViewport) {
    const paint = NativeViewport.prototype.paint;
    NativeViewport.prototype.paint = function (...args: unknown[]) {
      const viewportId = identity(this), requestedRevision = this.paintRevision;
      recordCandleStage('native.paint.start', { viewportId, requestedRevision, count: this.series?.candles?.length ?? null });
      let returned = false;
      try { const value = paint.apply(this, args); returned = true; return value; }
      finally {
        recordCandleStage('native.paint.end', {
          viewportId, requestedRevision, currentRevision: this.paintRevision, paintedRevision: this.paintedRevision,
          count: this.series?.candles?.length ?? null, pendingPaint: this.raf != null,
          // A callback can invalidate a paint before it returns. A successful
          // call alone is not proof that the current frame finished drawing.
          currentPaintComplete: returned && !!this.frame && !this.destroyed && !this.paintError && this.raf === null
            && Number.isInteger(this.paintRevision) && this.paintRevision >= 0 && this.paintedRevision === this.paintRevision,
        });
      }
    };
  }
  const originalFetch = window.fetch;
  let requestId = 0;
  window.fetch = function (...args: Parameters<typeof fetch>) {
    const input = args[0];
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin !== location.origin || url.pathname !== "/api/chart/candles") return originalFetch.apply(this, args);
    const id = ++requestId;
    recordCandleStage("fetch.start", { id });
    return originalFetch.apply(this, args).then(response => {
      recordCandleStage("fetch.resolved", { id, status: response.status });
      const originalJson = response.json;
      response.json = function () {
        recordCandleStage("json.start", { id });
        return originalJson.call(this).then(data => {
          recordCandleStage("json.resolved", { id, count: Array.isArray(data?.candles) ? data.candles.length : null });
          return data;
        }, error => { recordCandleStage("json.rejected", { id }); throw error; });
      };
      return response;
    }, error => { recordCandleStage("fetch.rejected", { id }); throw error; });
  };
  const setCandles = Adapter.prototype.setCandles;
  Adapter.prototype.setCandles = function (...args: unknown[]) {
    const count = Array.isArray(args[0]) ? args[0].length : null;
    const detail = { count, adapterId: identity(this), viewportId: NativeViewport ? identity(this.viewport) : null };
    recordCandleStage("engine.setCandles.start", detail);
    try { return setCandles.apply(this, args); }
    finally { recordCandleStage("engine.setCandles.end", detail); }
  };
}
