// Heikin Ashi — the server's own implementation of the canonical transform,
// used to re-derive the bars a chart reports it drew in Heikin Ashi style
// (renderEvidence.ts). Independent of the dashboard's copy
// (trading-dashboard/src/lib/chart-engine/heikinAshi.ts) on purpose: the
// server never takes the chart's word for the transform.
//
//   HA close = (O + H + L + C) / 4
//   HA open  = (previous HA open + previous HA close) / 2; (O + C) / 2 on the first bar
//   HA high  = max(H, HA open, HA close)
//   HA low   = min(L, HA open, HA close)
//
// Heikin Ashi values are averaged DISPLAY values, never tradable prices: no
// read, level, gate or order may quote them as market prices.

export interface OhlcBar { open: number; high: number; low: number; close: number }

export function heikinAshiBar(source: OhlcBar, previous: { open: number; close: number } | null): OhlcBar {
  const close = (source.open + source.high + source.low + source.close) / 4;
  const open = previous ? (previous.open + previous.close) / 2 : (source.open + source.close) / 2;
  return { open, high: Math.max(source.high, open, close), low: Math.min(source.low, open, close), close };
}

/** Transform a run of consecutive source bars. `seed` is the HA bar before the
 * first one (null when the run starts at the first loaded bar). */
export function heikinAshiRun(source: readonly OhlcBar[], seed: { open: number; close: number } | null): OhlcBar[] {
  const out: OhlcBar[] = [];
  let prev = seed;
  for (const bar of source) { const ha = heikinAshiBar(bar, prev); out.push(ha); prev = ha; }
  return out;
}
