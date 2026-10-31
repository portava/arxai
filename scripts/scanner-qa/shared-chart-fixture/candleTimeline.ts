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
export function installCandleTimeline(Adapter: { prototype: any }) {
  if (location.origin !== "http://127.0.0.1:4299") throw Error("Candle timeline requires diagnostic loopback port");
  const target = window as unknown as { __arxCandleTimeline?: RecordState };
  if (target.__arxCandleTimeline) throw Error("Candle timeline already installed");
  target.__arxCandleTimeline = { diagnosticOnly: true, events: [], dropped: 0 };
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
    recordCandleStage("engine.setCandles.start", { count });
    try { return setCandles.apply(this, args); }
    finally { recordCandleStage("engine.setCandles.end", { count }); }
  };
}
