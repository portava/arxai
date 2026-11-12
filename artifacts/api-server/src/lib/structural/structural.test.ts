import { test } from "node:test";
import assert from "node:assert/strict";
import { fitStructuralModel, forecastStructural, makeEpisodes, chronologicalPartitions,
  structuralFeatures, observeStructure, validateBars, hazardsToMass, reallocateEarly, probabilities,
  prebreakCandidate, softmax, evaluateForecast, performanceBrake, calibrationBins, predictHead, predictMass,
  type StructuralBar, type Mass, type DataOrigin, type StructuralModel } from "@workspace/domain/structural";
import { StructuralForecastService, type StoredForecast, type ForecastRepository } from "./service.js";
import type { CandleHistoryResult } from "../data/candleHistoryService.js";

export function fixture(n = 5000): StructuralBar[] {
  let seed = 123, price = 100;
  return Array.from({ length: n }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const open = price; price = Math.max(2, price + (seed / 2 ** 32 - .5) * .8);
    return { openTime: Date.UTC(2026, 0, 1) + i * 60_000, closeTime: Date.UTC(2026, 0, 1) + (i + 1) * 60_000,
      open, high: Math.max(open, price) + .15, low: Math.min(open, price) - .15, close: price, isFinal: true };
  });
}
const bars = fixture(), asOf = bars.at(-1)!.closeTime;
const origin: DataOrigin = { provider: "fixture", symbol: "V75", fetchedAt: new Date(asOf).toISOString(), kind: "SYNTHETIC_TEST", historicalArrivalTimesKnown: false };
let fitted: StructuralModel | undefined;
const model = () => fitted ??= fitStructuralModel(bars, origin);
const baseline = hazardsToMass(Array.from({ length: 60 }, () => [.01, .005, .012, .003, .97]));
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test("valid M1 history, OHLC, gaps, duplicates and finality are enforced", () => {
  validateBars(bars, asOf);
  for (const mutate of [(b: StructuralBar[]) => { b[10]!.close = b[10]!.high + 1; },
    (b: StructuralBar[]) => { b[10]!.isFinal = false; }, (b: StructuralBar[]) => { b.splice(10, 1); },
    (b: StructuralBar[]) => { b[10]!.openTime++; }, (b: StructuralBar[]) => { b[10] = b[9]!; }]) {
    const copy = structuredClone(bars); mutate(copy); assert.throws(() => validateBars(copy, asOf));
  }
  assert.throws(() => validateBars(bars, asOf - 1));
});
test("future mutation does not change a point-in-time feature snapshot", () => {
  const cutoff = bars[119]!.closeTime;
  const changed = structuredClone(bars); changed.slice(120).forEach(b => { b.close = 9999; b.high = 99999; });
  assert.deepEqual(structuralFeatures(bars, cutoff), structuralFeatures(changed, cutoff));
});
test("history adapter retains training depth, current corrections and source isolation", async () => {
  // Existing normalization imports the app's provider metadata, whose DB
  // module requires configuration at import. No database query runs here.
  process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:1/structural_unit_test";
  const { assembleForecastFeed } = await import("./feed.js");
  const { normalizeCandles } = await import("../data/chart/candleNormalization.js");
  const raw = bars.map(b => ({ time: new Date(b.openTime).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close }));
  const history = { candles: raw, source: "deriv", fetchedAt: new Date(asOf).toISOString(), ok: true } as CandleHistoryResult;
  const current = { ...normalizeCandles(raw.slice(-120), { symbol: "V75", displaySymbol: "V75", timeframe: "M1", source: "deriv", now: asOf }),
    source: "deriv", quality: "clean", aiUsable: true, warning: null };
  current.candles.at(-1)!.high += .01;
  const feed = assembleForecastFeed("V75", history, current, asOf);
  assert.equal(feed.ready, true); assert.equal(feed.bars.length, 5000);
  assert.equal(feed.bars.at(-1)!.high, current.candles.at(-1)!.high);
  assert.equal(assembleForecastFeed("V75", history, { ...current, source: "mt5_broker" }, asOf).ready, false);
  assert.equal(assembleForecastFeed("V75", history, { ...current, aiUsable: false }, asOf).ready, false);
});
test("damaged historical windows are excluded without fabricating bars", () => {
  const changed = structuredClone(bars); changed.splice(250, 1);
  const episodes = makeEpisodes(changed);
  assert.ok(episodes.length < makeEpisodes(bars).length);
  for (const e of episodes) validateBars([...e.history, ...e.future], e.future.at(-1)!.closeTime, 180);
});
test("observer is prefix causal and publishes confirmation at second close", () => {
  const all = observeStructure(bars.slice(0, 300));
  assert.ok(all.events.length > 0);
  for (let n = 25; n <= 300; n += 7) {
    const prefix = observeStructure(bars.slice(0, n));
    assert.deepEqual(prefix.events, all.events.filter(e => e.time <= bars[n - 1]!.closeTime));
  }
  for (const e of all.events) {
    assert.equal(e.time - e.precursorTime, 60_000);
    const direction = e.cause.endsWith("UP") ? 1 : -1;
    assert.ok(direction * (bars[e.index - 1]!.close - e.pivot) >= .35 * e.atr - 1e-10);
    assert.ok(direction * (bars[e.index]!.close - e.pivot) >= .15 * e.atr - 1e-10);
  }
});
test("eligible prebreak episodes cannot already have the first qualifying close", () => {
  const episodes = makeEpisodes(bars);
  assert.ok(episodes.some(e => !e.eligible));
  for (const e of episodes.filter(e => e.eligible && e.event)) assert.ok(e.event!.time - e.origin >= 120_000);
});
test("softmax is stable and rejects non-finite logits", () => {
  close(softmax([10000, 10000, -10000])[0]!, .5);
  assert.throws(() => softmax([NaN])); assert.throws(() => softmax([]));
});
test("one joint PMF conserves probability and monotone horizon incidence", () => {
  let previous = [0, 0, 1];
  for (let h = 1; h <= 60; h++) {
    const p = probabilities(baseline, h); close(p.reduce((a, b) => a + b, 0), 1);
    assert.ok(p[0] >= previous[0]! && p[1] >= previous[1]! && p[2] <= previous[2]!);
    previous = p;
  }
  assert.throws(() => hazardsToMass([[1, 0, 0, 0, 1]]));
  assert.throws(() => probabilities(baseline, 61));
});
test("early reallocation preserves all four terminal subtypes at every blend", () => {
  for (let i = 0; i <= 100; i++) {
    const candidate = prebreakCandidate(baseline, [i / 100, (1 - i / 100) / 2, (1 - i / 100) / 2]);
    const moved = reallocateEarly(baseline, candidate, i / 100);
    for (let k = 0; k < 4; k++) close(moved.reduce((s, r) => s + r[k]!, 0), baseline.reduce((s, r) => s + r[k]!, 0));
    probabilities(moved, 60).forEach((p, k) => close(p, probabilities(baseline, 60)[k]!));
  }
});
test("zero late mass falls back by subtype without division by zero", () => {
  const base = Array.from({ length: 60 }, (_, i) => [i === 0 ? .8 : 0, 0, 0, 0] as Mass);
  const empty = base.map(() => [0, 0, 0, 0] as Mass);
  assert.deepEqual(reallocateEarly(base, empty, 1), base);
  assert.throws(() => reallocateEarly(base, empty, NaN));
});
test("chronological fitting partitions purge overlapping outcome windows", () => {
  const p = chronologicalPartitions(makeEpisodes(bars));
  for (const [a, b] of [[p.train, p.selection], [p.selection, p.gate], [p.gate, p.holdout]]) {
    assert.ok(a!.at(-1)!.future.at(-1)!.closeTime < b![0]!.origin);
  }
});
test("fitted coefficients, gate samples and untouched holdout are present", () => {
  const m = model(); assert.ok(m.geometry.weights.flat().some(v => v !== 0));
  assert.ok(m.partitions.gate!.n >= 30 && m.holdout.length > 0);
  assert.ok(predictHead(m.prebreak!, structuralFeatures(bars.slice(-120), asOf).values).every(Number.isFinite));
});
test("prebreak probability respects the two-close minimum without changing later horizons", () => {
  const m = structuredClone(model()); m.geometryGate.accepted = false; m.confirmationGate.accepted = false; m.prebreakGate.accepted = false;
  const f = structuralFeatures(bars.slice(-120), asOf);
  const prediction = predictMass(m, f.values, true);
  assert.deepEqual(probabilities(prediction.mass, 1), [0, 0, 1]);
  for (const h of [3, 5, 15, 30, 60]) probabilities(prediction.mass, h).forEach((p, i) => close(p, probabilities(m.baseline, h)[i]!));
});
test("mutating reserved holdout does not change trained parameters or gates", () => {
  const original = model(), copy = structuredClone(bars), cutoff = original.partitions.holdout!.first!;
  for (const b of copy.filter(b => b.openTime >= cutoff)) {
    const shift = (b.openTime - cutoff) / 60_000 * .1;
    for (const field of ["open", "high", "low", "close"] as const) b[field] += shift;
  }
  const changed = fitStructuralModel(copy, origin);
  for (const key of ["baseline", "geometry", "confirmation", "prebreak", "geometryGate", "confirmationGate", "prebreakGate"] as const) assert.deepEqual(changed[key], original[key]);
});
test("ghosts use training-only OHLC and replay to their stated class", () => {
  const m = model(), f = forecastStructural(m, bars.slice(-120), origin);
  for (const path of f.paths) {
    if (!path.candles.length) { assert.ok(path.unavailableReason); continue; }
    assert.equal(path.candles.length, 60); assert.ok(path.sourceEnd! <= m.trainedThrough);
    validateBars(path.candles, asOf + 3_600_000, 60);
    const event = observeStructure([...f.history, ...path.candles]).events.find(e => e.time > asOf);
    assert.equal(event ? event.cause.endsWith("UP") ? "UP_FIRST" : "DOWN_FIRST" : "NEITHER", path.scenario);
  }
});
test("model provenance and availability prevent accidental backdated inference", () => {
  assert.throws(() => forecastStructural(model(), bars.slice(0, 120), origin), /TIME_MISMATCH/);
  assert.throws(() => forecastStructural(model(), bars.slice(-120), { ...origin, symbol: "V50" }), /MISMATCH/);
});
test("evaluation waits for closed horizons and preserves original issued probabilities", () => {
  const m = model(), index = 4800, history = bars.slice(index - 120, index);
  const f = forecastStructural(m, history, origin), before = JSON.stringify(f);
  const future = bars.slice(index, index + 60);
  assert.deepEqual(evaluateForecast(f, future, f.asOf + 59_999), []);
  assert.deepEqual(evaluateForecast(f, future, f.asOf + 180_000).map(s => s.horizon), [1, 3]);
  assert.equal(evaluateForecast(f, future, f.asOf + 3_600_000).length, 6);
  assert.equal(JSON.stringify(f), before);
  assert.throws(() => evaluateForecast(f, future.slice(1), f.asOf + 3_600_000), /GAP/);
});
test("brake ignores future/current outcomes and stays quarantined", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ asOf: i * 60_000, completedAt: i * 60_000 + 300_000, brier: 1, baselineBrier: .2 }));
  assert.equal(performanceBrake(false, rows, 120_000), false);
  assert.equal(performanceBrake(false, rows, 3_600_000), true);
  assert.equal(performanceBrake(true, [], 3_600_000), true);
});
test("calibration reports empty bins as unavailable", () => {
  assert.equal(calibrationBins([]).every(b => b.n === 0 && b.accuracy === null), true);
});

function memory(failSave = false): ForecastRepository & { rows: Map<string, StoredForecast>; writes: number } {
  return { rows: new Map(), writes: 0,
    async list(userId, symbol) { return [...this.rows.entries()].filter(([k, r]) => k.startsWith(`${userId}:`) && r.forecast.origin.symbol === symbol).map(([, r]) => structuredClone(r)); },
    async save(userId, row) { if (failSave) throw new Error("SAVE_FAILED"); this.writes++; this.rows.set(`${userId}:${row.id}`, structuredClone(row)); return structuredClone(row); },
    async appendScores(userId, id, scores) { this.rows.get(`${userId}:${id}`)!.scores.push(...structuredClone(scores)); },
  };
}
test("service awaits persistence, deduplicates a bar and isolates users", async () => {
  const repository = memory(); let fits = 0;
  const service = new StructuralForecastService({ repository, now: () => asOf + 1000,
    readFeed: async () => ({ bars, origin: { ...origin, kind: "BROKER_HISTORY" }, ready: true, reason: null }),
    fit: () => { fits++; return structuredClone(model()); } });
  const [a, b] = await Promise.all([service.issue(1, "V75"), service.issue(1, "V75")]);
  assert.equal(a.id, b.id); assert.equal(repository.writes, 1); assert.equal(fits, 1);
  await service.issue(1, "V75"); assert.equal(repository.writes, 1);
  const c = await service.issue(2, "V75"); assert.notEqual(c.id, a.id);
});
test("service fails closed on persistence failure, stale feed and simulated inputs", async () => {
  for (const mode of ["save", "stale", "simulation"]) {
    const service = new StructuralForecastService({ repository: memory(mode === "save"), now: () => asOf + (mode === "stale" ? 120_000 : 1000),
      readFeed: async () => ({ bars, origin: { ...origin, kind: mode === "simulation" ? "SYNTHETIC_TEST" : "BROKER_HISTORY" }, ready: true, reason: null }), fit: () => structuredClone(model()) });
    await assert.rejects(service.issue(1, "V75"));
  }
});
test("fitting that crosses the first deadline cannot issue a backdated forecast", async () => {
  let now = asOf + 1000; const repository = memory();
  const service = new StructuralForecastService({ repository, now: () => now,
    readFeed: async () => ({ bars, origin: { ...origin, kind: "BROKER_HISTORY" }, ready: true, reason: null }),
    fit: () => { now = asOf + 60_000; return structuredClone(model()); } });
  await assert.rejects(service.issue(1, "V75"), /FIRST_HORIZON_ALREADY_CLOSED/);
  assert.equal(repository.writes, 0);
});
