// Truth regression: the scanner's FVG pullback read (fvgRead) may only signal
// from CLOSED, CURRENT bars that come from ONE source across H4/H1/M5.
// Before: decorateOpportunitiesWithFvgRead fed raw router bars (forming bar
// included) straight into the engine, detected staleness only from a router
// attempt reason containing "STALE", and never compared sources across the
// three timeframes — so a 40-minute-old MT5 series, a still-forming M5 bar,
// or H4 from one provider and M5 from another could all produce
// canSignal: true with an entry zone.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../data/types.js";

const M5 = 5 * 60_000;
const H1 = 60 * 60_000;
const H4 = 4 * H1;
const r5 = (x: number) => Number(x.toFixed(5));

type Bar = { open: number; high: number; low: number; close: number };

function htfBars(n: number, start: number, step: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = start + step * i + (i % 2 ? 0.0003 : 0);
    const o = c - step * 0.5;
    out.push({ open: r5(o), high: r5(Math.max(o, c) + 0.0004), low: r5(Math.min(o, c) - 0.0004), close: r5(c) });
  }
  return out;
}

/** 95 M5 bars: uptrend, pullback under SMA50, reclaim impulse, and a bar that completes a fresh bullish FVG. */
function m5Bars(lastBarClose = 0.0001): Bar[] {
  const out: Bar[] = [];
  let p = 1.08;
  const push = (o: number, c: number, wick = 0.00005) =>
    out.push({ open: r5(o), high: r5(Math.max(o, c) + wick), low: r5(Math.min(o, c) - wick), close: r5(c) });
  for (let i = 0; i < 70; i++) { const o = p; p += 0.0002; push(o, p); }
  for (let i = 0; i < 22; i++) { const o = p; p -= 0.0004; push(o, p); }
  { const o = p; p += 0.0003; push(o, p); }
  { const o = p; p += 0.006; push(o, p); }
  { const o = p + 0.0001; p = o + lastBarClose; push(o, p); }
  return out;
}

/** Stamp bars with open times so the newest bar opens `newestOpenAgo` ms before the current bucket start. */
function stamp(bars: Bar[], intervalMs: number, now: number, newestOffsetIntervals: number): Candle[] {
  const bucket = Math.floor(now / intervalMs) * intervalMs;
  const newestOpen = bucket - newestOffsetIntervals * intervalMs;
  return bars.map((b, i) => ({
    time: new Date(newestOpen - (bars.length - 1 - i) * intervalMs).toISOString(),
    ...b,
    volume: 0,
  }));
}

type Series = { provider: string; candles: Candle[] };
let series: Record<"H4" | "H1" | "M5", Series> = {} as Record<"H4" | "H1" | "M5", Series>;

function freshSeries(now: number, m5Override?: Candle[]): typeof series {
  return {
    H4: { provider: "mt5_broker", candles: stamp(htfBars(220, 1.0, 0.0004), H4, now, 1) },
    H1: { provider: "mt5_broker", candles: stamp(htfBars(220, 1.03, 0.0002), H1, now, 1) },
    M5: { provider: "mt5_broker", candles: m5Override ?? stamp(m5Bars(), M5, now, 1) },
  };
}

const router = await import("../data/marketDataRouter.js");
mock.module("../data/marketDataRouter.js", { namedExports: { ...router,
  routeCandles: async (symbol: string, tf: string) => {
    const s = series[tf as "H4" | "H1" | "M5"];
    return {
      ok: true, symbol, assetClass: "forex", candles: s.candles, primaryProvider: s.provider,
      attempts: [{ provider: s.provider, ok: true, reason: null }],
      userMessage: "", adminDetail: "",
    };
  },
} });

const { decorateOpportunitiesWithFvgRead } = await import("../marketScanner.js");
type Opp = Parameters<typeof decorateOpportunitiesWithFvgRead>[0][number];
const opp = (tf: string) => ({ symbol: "EURUSD", timeframe: tf }) as unknown as Opp;

async function read() {
  const [o] = await decorateOpportunitiesWithFvgRead([opp("M5")]);
  return o!.fvgRead;
}

test("control: closed, current, single-source bars can signal", async () => {
  series = freshSeries(Date.now());
  const f = await read();
  assert.ok(f, "fvgRead must be attached");
  assert.equal(f!.canSignal, true, `fixture must produce a signal: ${f!.headline}`);
  assert.equal(f!.entryTimeframe, "M5");
  assert.ok(f!.asOf && Number.isFinite(Date.parse(f!.asOf)), "asOf must be the newest closed M5 bar time");
});

test("M5 series 8 intervals old with no STALE attempt cannot signal", async () => {
  const now = Date.now();
  series = freshSeries(now, stamp(m5Bars(), M5, now, 8));
  const f = await read();
  assert.ok(f);
  assert.equal(f!.canSignal, false);
  assert.equal(f!.activeFvg, null);
});

test("a still-forming M5 bar is excluded: changing its OHLC does not change the read", async () => {
  const now = Date.now();
  // Newest bar opens in the current bucket ⇒ still forming.
  series = freshSeries(now, stamp(m5Bars(0.0001), M5, now, 0));
  const a = await read();
  series = freshSeries(now, stamp(m5Bars(0.0040), M5, now, 0));
  const b = await read();
  assert.ok(a && b);
  assert.deepEqual(a!.activeFvg, b!.activeFvg);
  assert.equal(a!.canSignal, false, "the gap completed only by the forming bar must not signal");
});

test("H4 from a different provider than M5 cannot signal", async () => {
  const now = Date.now();
  series = freshSeries(now);
  series.H4 = { ...series.H4, provider: "deriv" };
  const f = await read();
  assert.ok(f);
  assert.equal(f!.canSignal, false);
  assert.match(f!.headline + " " + f!.explanation, /different sources/i);
});
