// QA entry only. This module is never imported by the production dashboard.
// Observe the real adapter; do not derive completion from React button state.
export function installChartQaWitnesses(Adapter: { prototype: any }): () => void {
  const prototype = Adapter.prototype;
  const original = {
    init: prototype.init, destroy: prototype.destroy,
    setCandles: prototype.setCandles, updateActiveCandle: prototype.updateActiveCandle,
  };
  const registry = new Map<HTMLElement, any>();
  const ids = new WeakMap<object, number>();
  const revisions = new WeakMap<object, number>();
  let sequence = 0;
  const id = (value: object | null | undefined) => {
    if (!value) return null;
    let found = ids.get(value);
    if (found === undefined) { found = ++sequence; ids.set(value, found); }
    return found;
  };
  const bar = (value: any) => value ? {time:value.time,open:value.open,high:value.high,low:value.low,close:value.close} : null;
  prototype.init = function (...args: any[]) {
    const result = original.init.apply(this, args);
    if (this.container) registry.set(this.container, this);
    return result;
  };
  prototype.destroy = function (...args: any[]) {
    const container = this.container;
    try { return original.destroy.apply(this, args); }
    finally { if (container) registry.delete(container); }
  };
  // Count every attempted data installation, even an unchanged write. A toolbar
  // disclosure must not trigger these methods at all. This also catches in-place
  // forming-candle changes whose array identity would otherwise stay unchanged.
  for (const method of ['setCandles', 'updateActiveCandle'] as const) {
    prototype[method] = function (...args: any[]) {
      revisions.set(this, (revisions.get(this) ?? 0) + 1);
      return original[method].apply(this, args);
    };
  }
  const adapterFor = (index = 0) => {
    const container = document.querySelectorAll<HTMLElement>('[data-testid="arx-native-canvas"]')[index];
    const adapter = container && registry.get(container);
    return container && adapter && adapter.chart && adapter.series ? {container,adapter} : null;
  };
  const api = {
    schemaVersion: 1,
    snapshot(index = 0) {
      const found = adapterFor(index); if (!found) return null;
      const {container,adapter} = found;
      const range = adapter.chart.timeScale().getVisibleLogicalRange();
      const bounds = container.getBoundingClientRect();
      return {
        adapterId:id(adapter),containerId:id(container),chartId:id(adapter.chart),seriesId:id(adapter.series),
        canvasIds:[...container.querySelectorAll('canvas')].map(id),
        candlesId:id(adapter.candles),dataRevision:revisions.get(adapter) ?? 0,
        barCount:adapter.candles.length,first:bar(adapter.candles[0]),last:bar(adapter.candles.at(-1)),
        symbol:adapter.symbol,intervalSeconds:adapter.intervalSeconds,style:adapter.style,
        feed:{source:adapter.feedState.source,livePriceAffordance:adapter.feedState.livePriceAffordance},
        range:range ? {from:range.from,to:range.to} : null,
        bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},
      };
    },
    configuration(index = 0) {
      const found = adapterFor(index); if (!found) return null;
      const scale = found.adapter.series.priceScale().options();
      return {
        scale: { mode: scale.mode, inverted: scale.invertScale },
        studies: (found.adapter.analysis?.studies ?? []).map((study: any) => ({
          config: { ...study.calculator.config },
          lines: study.lines.map((line: any) => line.data().map((point: any) => ({ ...point }))),
        })),
      };
    },
    // Expensive full snapshots are captured outside timed actions. No cached
    // checksum can conceal an in-place mutation or a hash collision.
    data(index = 0) {
      const found = adapterFor(index); if (!found) return null;
      return {canonical:found.adapter.candles.map(bar),display:found.adapter.series.data().map((point: any) => ({...point}))};
    },
  };
  (window as any).__arxChartQa = api;
  return () => {
    for (const method of Object.keys(original) as (keyof typeof original)[]) prototype[method] = original[method];
    registry.clear();
    if ((window as any).__arxChartQa === api) delete (window as any).__arxChartQa;
  };
}
