// Deterministic synthetic price paths for calibration tests. PURE.
//
// `gbmBars` is driftless geometric Brownian motion: by construction no score
// computed from the past can predict the future better than the base rate.
// `momentumBars` plants a real, persistent edge (AR(1) returns) so tests can
// show the machinery detects signal when it exists, i.e. that a "no edge"
// verdict on GBM is a finding and not a broken test.

export interface SyntheticBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Mulberry32: tiny, fast, deterministic. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function buildBars(
  n: number,
  seed: number,
  start: number,
  stepMs: number,
  nextReturn: (rand: () => number, prev: number) => number,
  sigma: number,
): SyntheticBar[] {
  const rand = seededRandom(seed);
  const bars: SyntheticBar[] = [];
  let price = start;
  let prevRet = 0;
  const t0 = Date.UTC(2026, 0, 5, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const r = nextReturn(rand, prevRet);
    prevRet = r;
    const open = price;
    const close = open * Math.exp(r);
    // Intrabar extremes from two extra half-steps of the same process (no drift).
    const e1 = open * Math.exp(sigma * 0.5 * gaussian(rand));
    const e2 = close * Math.exp(sigma * 0.5 * gaussian(rand));
    const high = Math.max(open, close, e1, e2);
    const low = Math.min(open, close, e1, e2);
    bars.push({ time: new Date(t0 + i * stepMs).toISOString(), open, high, low, close, volume: 100 });
    price = close;
  }
  return bars;
}

/** Driftless GBM: log-return ~ N(-σ²/2, σ²), i.e. a martingale in price. */
export function gbmBars(n: number, seed: number, sigma = 0.002, start = 1000, stepMs = 60_000): SyntheticBar[] {
  return buildBars(n, seed, start, stepMs, (rand) => -0.5 * sigma * sigma + sigma * gaussian(rand), sigma);
}

/** AR(1) log-returns with coefficient `phi`: trends persist, so trend
 *  strategies have a real, measurable edge. */
export function momentumBars(
  n: number,
  seed: number,
  phi = 0.35,
  sigma = 0.002,
  start = 1000,
  stepMs = 60_000,
): SyntheticBar[] {
  return buildBars(n, seed, start, stepMs, (rand, prev) => phi * prev + sigma * gaussian(rand), sigma);
}

/** Aggregate bars into coarser bars of `factor` source bars. */
export function aggregateBars(bars: readonly SyntheticBar[], factor: number): SyntheticBar[] {
  const out: SyntheticBar[] = [];
  for (let i = 0; i + factor <= bars.length; i += factor) {
    const chunk = bars.slice(i, i + factor);
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}
