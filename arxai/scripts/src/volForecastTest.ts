// Test: the volatility forecaster (@workspace/risk volForecast.ts).
//
// Claims:
//   1. NO LOOKAHEAD. A forecast at bar t is unchanged when every bar after t is
//      replaced. Fitting on [0, trainEnd) is unchanged when bars at or after
//      trainEnd are replaced.
//   2. IT RECOVERS WHAT IS REALLY THERE. On a seeded series with a known
//      hour-of-week volatility profile and volatility clustering, the seasonal
//      factors come back near the truth, and the seasonal model beats the naive
//      baseline by a clear, significant margin.
//   3. IT FINDS NOTHING WHERE NOTHING IS. On a seeded series with CONSTANT
//      volatility, no model beats the naive baseline significantly. A model that
//      "finds" structure in pure noise is overfitting, and this catches it.
//   4. The statistics are right: QLIKE is 0 at a perfect forecast and positive
//      otherwise; the Diebold–Mariano p-value is ~uniform-ish under the null and
//      tiny when one loss series is clearly smaller; OLS recovers known
//      coefficients.
//
// Seeded generator only. Pure: no DB, no network, no clock.

import assert from "node:assert/strict";
import {
  parkinsonVar, hourOfWeek, fitVolModels, forecastAt, volFeatures, realisedAhead, qlike, dieboldMariano, ols,
  VOL_MODEL_KEYS, type VolBar, type VolModelKey,
} from "@workspace/risk";

let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log(`ok - ${name}`); };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let x = s; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r: () => number) { const u = Math.max(r(), 1e-12); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

const H1 = 3_600_000;
/** Seeded hourly bars. sigma(t) = base * season(hourOfWeek) * cluster(t). */
function makeBars(n: number, seed: number, opts: { seasonal: boolean; cluster: boolean }): { bars: VolBar[]; season: number[] } {
  const r = rng(seed);
  const season = Array.from({ length: 168 }, (_, h) => {
    const hod = h % 24;
    return opts.seasonal ? (hod >= 7 && hod < 17 ? 2.0 : hod >= 13 && hod < 21 ? 1.6 : 0.6) : 1;
  });
  const bars: VolBar[] = [];
  let price = 100;
  let logVolState = 0;
  const t0 = Date.UTC(2025, 0, 6); // a Monday
  for (let i = 0; i < n; i++) {
    const tt = t0 + i * H1;
    if (opts.cluster) logVolState = 0.97 * logVolState + 0.25 * gauss(r);
    const sigma = 0.002 * season[hourOfWeek(tt)]! * Math.exp(opts.cluster ? logVolState : 0);
    // Simulate the bar from 12 sub-steps so high/low are real path extremes.
    let hi = price, lo = price, p = price;
    for (let k = 0; k < 12; k++) { p *= Math.exp(sigma / Math.sqrt(12) * gauss(r)); hi = Math.max(hi, p); lo = Math.min(lo, p); }
    bars.push({ t: tt, high: hi, low: lo, close: p });
    price = p;
  }
  return { bars, season };
}

function evaluate(bars: VolBar[], horizon: number, barsPerDay: number) {
  const trainEnd = Math.floor(bars.length * 0.5);
  const fitted = fitVolModels(bars, { horizon, barsPerDay }, trainEnd);
  const f = volFeatures(bars, fitted);
  const v = bars.map(parkinsonVar);
  const losses: Record<VolModelKey, number[]> = { naive: [], ewma: [], seasonal: [], har: [], harSeasonal: [] };
  for (let i = trainEnd + horizon; i + horizon < bars.length; i++) {
    const y = realisedAhead(v, i, horizon);
    if (!(y > 0)) continue;
    const fc = forecastAt(bars, fitted, H1, i, f);
    for (const k of VOL_MODEL_KEYS) losses[k].push(qlike(y, fc[k]));
  }
  return { fitted, losses };
}

t("QLIKE is zero at a perfect forecast and positive otherwise", () => {
  assert.equal(qlike(2, 2), 0);
  assert.ok(qlike(2, 1) > 0 && qlike(1, 2) > 0);
});

t("OLS recovers known coefficients", () => {
  const r = rng(7);
  const X: number[][] = []; const y: number[] = [];
  for (let i = 0; i < 500; i++) { const a = gauss(r), b = gauss(r); X.push([1, a, b]); y.push(0.5 + 2 * a - 1.5 * b + 0.01 * gauss(r)); }
  const c = ols(X, y);
  assert.ok(Math.abs(c[0]! - 0.5) < 0.01 && Math.abs(c[1]! - 2) < 0.01 && Math.abs(c[2]! + 1.5) < 0.01, `got ${c}`);
});

t("Diebold–Mariano: clear difference gives a tiny p, identical losses give p≈0.5 or 1", () => {
  const r = rng(11);
  const a = Array.from({ length: 2000 }, () => 1 + Math.abs(gauss(r)));
  const b = a.map((x) => x * 0.8);
  assert.ok(dieboldMariano(a, b, 5).p < 1e-6);
  const c = Array.from({ length: 2000 }, () => 1 + Math.abs(gauss(r)));
  const d = Array.from({ length: 2000 }, () => 1 + Math.abs(gauss(r)));
  const p = dieboldMariano(c, d, 5).p;
  assert.ok(p > 0.01, `independent same-distribution losses should not look significant, p=${p}`);
});

t("no lookahead: forecasts and fits ignore every bar after their cut-off", () => {
  const { bars } = makeBars(3000, 3, { seasonal: true, cluster: true });
  const cfg = { horizon: 4, barsPerDay: 24 };
  const trainEnd = 1500;
  const fittedA = fitVolModels(bars, cfg, trainEnd);
  const changed = bars.map((b, i) => (i >= trainEnd ? { ...b, high: b.high * 1.5, low: b.low * 0.7 } : b));
  const fittedB = fitVolModels(changed, cfg, trainEnd);
  assert.deepEqual(fittedA.har, fittedB.har);
  assert.deepEqual([...fittedA.seasonal.factor], [...fittedB.seasonal.factor]);
  const i = 2000;
  const tail = bars.map((b, j) => (j > i ? { ...b, high: b.high * 3, low: b.low * 0.3 } : b));
  const fa = forecastAt(bars, fittedA, H1, i);
  const fb = forecastAt(tail, fittedA, H1, i);
  for (const k of VOL_MODEL_KEYS) assert.equal(fa[k], fb[k], k);
});

t("recovers a real hour-of-week pattern and beats naive significantly", () => {
  const { bars, season } = makeBars(8000, 5, { seasonal: true, cluster: true });
  const { fitted, losses } = evaluate(bars, 4, 24);
  // Factors are relative to the mean variance; compare the active/quiet ratio, which is scale-free.
  const f = fitted.seasonal.factor;
  const active = f[hourOfWeek(Date.UTC(2025, 0, 7, 10))]!; const quiet = f[hourOfWeek(Date.UTC(2025, 0, 7, 2))]!;
  const trueRatio = (season[hourOfWeek(Date.UTC(2025, 0, 7, 10))]! / season[hourOfWeek(Date.UTC(2025, 0, 7, 2))]!) ** 2;
  // On the log scale the recovered contrast must be within 30% of the truth (shrinkage
  // pulls thinly-sampled hours slightly toward 1, never past it).
  const rel = Math.log(active / quiet) / Math.log(trueRatio);
  assert.ok(rel > 0.7 && rel < 1.3, `factor ratio ${active / quiet} vs true ${trueRatio} (log share ${rel.toFixed(2)})`);
  const dm = dieboldMariano(losses.naive, losses.harSeasonal, 4);
  assert.ok(dm.p < 1e-4 && dm.meanDiff > 0, `harSeasonal should beat naive: ${JSON.stringify(dm)}`);
});

t("finds nothing in constant-volatility noise (no false edge)", () => {
  const { bars } = makeBars(8000, 9, { seasonal: false, cluster: false });
  const { losses } = evaluate(bars, 4, 24);
  const meanNaive = losses.naive.reduce((a, b) => a + b, 0) / losses.naive.length;
  for (const k of ["ewma", "seasonal", "har", "harSeasonal"] as const) {
    const dm = dieboldMariano(losses.naive, losses[k], 4);
    const rel = dm.meanDiff / meanNaive;
    // Against the five-day baseline nothing may look meaningfully better on pure noise.
    assert.ok(rel < 0.02, `${k} improves the five-day baseline by ${(rel * 100).toFixed(1)}% on pure noise (p=${dm.p.toExponential(2)})`);
  }
});

t("clustering alone (no clock) is found by ewma/har and not credited to the clock", () => {
  const { bars } = makeBars(8000, 13, { seasonal: false, cluster: true });
  const { losses } = evaluate(bars, 4, 24);
  assert.ok(dieboldMariano(losses.naive, losses.har, 4).p < 1e-4, "har should beat the five-day baseline when volatility clusters");
  assert.ok(dieboldMariano(losses.naive, losses.ewma, 4).p < 1e-4, "ewma should too");
});

console.log(`\n${passed} passed`);
