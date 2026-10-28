import { describe, expect, it } from "vitest";
import { heikinAshi, heikinAshiBar, heikinAshiSuffix, hollowPoint, HOLLOW_DOWN_COLOR, HOLLOW_UP_COLOR } from "./heikinAshi";
import type { ChartEngineCandle } from "./types";

// Varied OHLC: deterministic pseudo-random walk with real bodies and wicks.
function walk(n: number, seed = 7, start = 100): ChartEngineCandle[] {
  let x = seed, close = start;
  const rand = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  return Array.from({ length: n }, (_, i) => {
    const open = close + (rand() - 0.5);
    close = open + (rand() - 0.5) * 3;
    return { time: 1_700_000_000 + i * 60, open, high: Math.max(open, close) + rand(), low: Math.min(open, close) - rand(), close };
  });
}
const near = (a: ChartEngineCandle, b: ChartEngineCandle) => {
  expect(a.time).toBe(b.time);
  for (const key of ["open", "high", "low", "close"] as const) expect(Math.abs(a[key] - b[key])).toBeLessThanOrEqual(1e-12);
};

describe("Heikin Ashi display transform", () => {
  it("matches hand-computed HA bars, including the first-bar (O+C)/2 seed", () => {
    const candles = [
      { time: 1, open: 10, high: 12, low: 9, close: 11 },
      { time: 2, open: 11, high: 15, low: 10.5, close: 14 },
      { time: 3, open: 14, high: 14.5, low: 8, close: 9 },
    ];
    const ha = heikinAshi(candles);
    // Bar 0: close (10+12+9+11)/4 = 10.5; open (10+11)/2 = 10.5; high max(12,10.5,10.5); low min(9,...).
    near(ha[0]!, { time: 1, open: 10.5, high: 12, low: 9, close: 10.5 });
    // Bar 1: close (11+15+10.5+14)/4 = 12.625; open (10.5+10.5)/2 = 10.5.
    near(ha[1]!, { time: 2, open: 10.5, high: 15, low: 10.5, close: 12.625 });
    // Bar 2: close (14+14.5+8+9)/4 = 11.375; open (10.5+12.625)/2 = 11.5625.
    near(ha[2]!, { time: 3, open: 11.5625, high: 14.5, low: 8, close: 11.375 });
    // The HA extremes always contain the canonical extremes.
    for (const [i, bar] of ha.entries()) {
      expect(bar.high).toBeGreaterThanOrEqual(candles[i]!.high);
      expect(bar.low).toBeLessThanOrEqual(candles[i]!.low);
    }
    expect(heikinAshiBar(candles[1]!, ha[0]!)).toEqual(ha[1]);
  });

  it("rebuilds only the suffix and equals a full recompute for every shared prefix", () => {
    const old = walk(40, 3), next = old.map((c, i) => i >= 25 ? { ...c, close: c.close + 0.7, high: Math.max(c.high, c.close + 0.7) } : c);
    for (let from = 0; from <= 25; from++) {
      const cache = heikinAshi(old);
      const result = heikinAshiSuffix(next, cache, from);
      expect(result).toBe(cache);
      expect(result).toEqual(heikinAshi(next));
    }
    // A cache longer than the candles is truncated and stays exact (shrink / replay seek back).
    for (let from = 0; from <= 41; from++) expect(heikinAshiSuffix(old.slice(0, 20), heikinAshi(old), from)).toEqual(heikinAshi(old.slice(0, 20)));
    // Appending: the cache prefix is reused as is.
    const grown = [...old, ...walk(5, 9, old.at(-1)!.close).map((c, i) => ({ ...c, time: old.at(-1)!.time + 60 * (i + 1) }))];
    const cache = heikinAshi(old), kept = cache[10];
    expect(heikinAshiSuffix(grown, cache, old.length)).toEqual(heikinAshi(grown));
    expect(cache[10]).toBe(kept);
  });

  it("is causal: changing bars at or after k leaves HA bars and hollow colours before k unchanged", () => {
    const base = walk(60, 11);
    for (const k of [0, 1, 17, 59]) {
      const adversarial = base.map((c, i) => i >= k ? { ...c, open: c.open * 3, high: c.high * 4, low: c.low / 5, close: c.close * 2 } : c);
      expect(heikinAshi(adversarial).slice(0, k)).toEqual(heikinAshi(base).slice(0, k));
      const colours = (candles: ChartEngineCandle[]) => candles.map((c, i) => hollowPoint(c, i ? candles[i - 1]!.close : null));
      expect(colours(adversarial).slice(0, k)).toEqual(colours(base).slice(0, k));
    }
  });

  it("re-seeds after a deep-history prepend and converges geometrically", () => {
    const all = walk(150, 5), loaded = all.slice(50);
    const before = heikinAshi(loaded), after = heikinAshi(all).slice(50);
    const delta0 = Math.abs(after[0]!.open - before[0]!.open);
    expect(delta0).toBeGreaterThan(0);
    for (let j = 0; j < before.length; j++) {
      // open_n - open'_n = (open_{n-1} - open'_{n-1}) / 2: the closes match, so only the seed differs.
      expect(Math.abs(after[j]!.open - before[j]!.open)).toBeLessThanOrEqual(delta0 * 2 ** -j + 1e-12);
      expect(after[j]!.close).toBe(before[j]!.close);
    }
  });

  it("encodes hollow fill by close vs open and colour by close vs the previous close", () => {
    const up = { time: 1, open: 10, high: 12, low: 9, close: 11 };
    const down = { time: 2, open: 11, high: 12, low: 9, close: 10 };
    // First bar: no previous close, colour compares close with open.
    expect(hollowPoint(up, null)).toEqual({ ...up, color: "transparent", borderColor: HOLLOW_UP_COLOR, wickColor: HOLLOW_UP_COLOR });
    expect(hollowPoint(down, null)).toEqual({ ...down, color: HOLLOW_DOWN_COLOR, borderColor: HOLLOW_DOWN_COLOR, wickColor: HOLLOW_DOWN_COLOR });
    // Green hollow: close above open and previous close.
    expect(hollowPoint(up, 10.5).color).toBe("transparent");
    expect(hollowPoint(up, 10.5).borderColor).toBe(HOLLOW_UP_COLOR);
    // Red hollow: close above open but below previous close.
    expect(hollowPoint(up, 11.5)).toMatchObject({ color: "transparent", borderColor: HOLLOW_DOWN_COLOR, wickColor: HOLLOW_DOWN_COLOR });
    // Green filled: close below open but above previous close.
    expect(hollowPoint(down, 9.5)).toMatchObject({ color: HOLLOW_UP_COLOR, borderColor: HOLLOW_UP_COLOR });
    // Red filled: close below open and previous close.
    expect(hollowPoint(down, 10.5)).toMatchObject({ color: HOLLOW_DOWN_COLOR, borderColor: HOLLOW_DOWN_COLOR });
    // Equal prices: hollow and up (ARX convention).
    const flat = { time: 3, open: 10, high: 10, low: 10, close: 10 };
    expect(hollowPoint(flat, 10)).toMatchObject({ color: "transparent", borderColor: HOLLOW_UP_COLOR });
    // OHLC values are never altered.
    expect(hollowPoint(down, 10.5)).toMatchObject(down);
  });
});
