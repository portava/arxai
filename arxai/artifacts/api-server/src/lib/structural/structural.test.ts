import { test } from "node:test";
import assert from "node:assert/strict";
import { fitStructuralModel, forecastStructural, makeEpisodes, chronologicalPartitions,
  structuralFeatures, observeStructure, validateBars, hazardsToMass, reallocateEarly, probabilities,
  prebreakCandidate, softmax, evaluateForecast, performanceBrake, calibrationBins, predictHead, predictMass,
  fitWindowCount, MIN_FIT_WINDOWS, favoredScenario, forecastRoutes, estimatePrice, scoreClosePath, scoreForecastRoute, FORECAST_HORIZONS, forecastHorizon, walkForwardAccuracy, calibrate, gradeForecast, independentForecasts, analogTrajectories, regradeAgainstBaseline, seasonalBandAt,
  type StructuralBar, type Mass, type DataOrigin, type StructuralModel } from "@workspace/domain/structural";
import { StructuralForecastService, ForecastRefusal, MIN_FIT_BARS, type StoredForecast, type ForecastRepository } from "./service.js";
import type { CandleHistoryResult } from "../data/candleHistoryService.js";

export function fixture(n = 5000, step = 60_000): StructuralBar[] {
  let seed = 123, price = 100;
  return Array.from({ length: n }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const open = price; price = Math.max(2, price + (seed / 2 ** 32 - .5) * .8);
    return { openTime: Date.UTC(2026, 0, 1) + i * step, closeTime: Date.UTC(2026, 0, 1) + (i + 1) * step,
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
  const missingLiveFeed = assembleForecastFeed("V75", history, { ...current, candles: [], source: null, quality: "unavailable", aiUsable: false }, asOf);
  assert.equal(missingLiveFeed.ready, false);
  assert.equal(missingLiveFeed.reason, "LIVE_CHART_UNAVAILABLE");
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
  // The one retry re-reads the same old bar, so the refusal stands.
  await assert.rejects(service.issue(1, "V75"), /LAST_CLOSED_BAR_OLDER_THAN_ONE_MINUTE|FIRST_HORIZON_ALREADY_CLOSED/);
  assert.equal(repository.writes, 0);
});
test("a request that crosses the minute boundary re-reads once and issues on the newer closed bar", async () => {
  const older = bars.slice(0, -1), olderAsOf = older.at(-1)!.closeTime;
  let reads = 0; const repository = memory();
  const service = new StructuralForecastService({ repository, now: () => asOf + 1000,
    // First read still ends on the previous bar (61s old); the re-read has the new one.
    readFeed: async () => ({ bars: reads++ === 0 ? older : bars, origin: { ...origin, kind: "BROKER_HISTORY" }, ready: true, reason: null }),
    fit: () => structuredClone(model()) });
  assert.equal(asOf + 1000 - olderAsOf, 61_000);
  const row = await service.issue(1, "V75");
  assert.equal(reads, 2); assert.equal(row.forecast.asOf, asOf); assert.equal(repository.writes, 1);
});
test("the minimum unbroken history matches what the model accepts, and a shorter run is refused before fitting", async () => {
  assert.throws(() => fitStructuralModel(fixture(MIN_FIT_BARS - 1), origin), /INSUFFICIENT_TRAINING_HISTORY/);
  fitStructuralModel(fixture(MIN_FIT_BARS), origin);
  // The window count is the real limit: the minimum run yields exactly the minimum windows.
  assert.equal(fitWindowCount(fixture(MIN_FIT_BARS)), MIN_FIT_WINDOWS);
  assert.equal(fitWindowCount(fixture(MIN_FIT_BARS - 1)), MIN_FIT_WINDOWS - 1);
  const short = fixture(MIN_FIT_BARS - 1), shortAsOf = short.at(-1)!.closeTime; let fits = 0;
  const service = new StructuralForecastService({ repository: memory(), now: () => shortAsOf + 1000,
    readFeed: async () => ({ bars: short, origin: { ...origin, kind: "BROKER_HISTORY" }, ready: true, reason: null,
      diagnostics: { historySource: "mt5_broker", historyBars: 5000, chartSource: "mt5_broker", chartQuality: "clean", chartAiUsable: true, closedBars: short.length, barsBeforeLastGap: 5000 - short.length, lastCloseAgeSeconds: null } }),
    fit: () => { fits++; return structuredClone(model()); } });
  await assert.rejects(service.issue(1, "V75"), (error: unknown) => {
    assert.ok(error instanceof ForecastRefusal); assert.equal(error.code, "UNBROKEN_HISTORY_TOO_SHORT");
    assert.equal(error.detail?.closedBars, MIN_FIT_BARS - 1); assert.equal(error.detail?.lastCloseAgeSeconds, 1);
    assert.equal(error.detail?.trainingWindows, MIN_FIT_WINDOWS - 1); assert.equal(error.detail?.trainingWindowsNeeded, MIN_FIT_WINDOWS); return true;
  });
  assert.equal(fits, 0);
});
test("a refusal states a stable code and what the feed looked like", async () => {
  const diagnostics = { historySource: "deriv_public", historyBars: 5000, chartSource: "deriv_public", chartQuality: "delayed", chartAiUsable: false, closedBars: 5000, lastCloseAgeSeconds: 130 };
  const service = new StructuralForecastService({ repository: memory(), now: () => asOf + 1000,
    readFeed: async () => ({ bars, origin: { ...origin, kind: "BROKER_HISTORY" }, ready: false, reason: "LIVE_CHART_DELAYED", diagnostics }), fit: () => structuredClone(model()) });
  await assert.rejects(service.issue(1, "V75"), (error: unknown) => {
    assert.ok(error instanceof ForecastRefusal); assert.equal(error.code, "LIVE_CHART_DELAYED");
    assert.deepEqual(error.detail, { ...diagnostics, timeframe: "M1", lastCloseAgeSeconds: 1 }); return true;
  });
  // The feed assembler names the failing check instead of passing free text.
  // It reaches the data layer, so this part runs where a database is configured.
  if (!process.env.DATABASE_URL) return;
  const { assembleForecastFeed } = await import("./feed.js");
  const history = { ok: true, source: "deriv_public", candles: [], fetchedAt: new Date(asOf).toISOString() } as unknown as CandleHistoryResult;
  const feedFor = (quality: string, aiUsable: boolean, source = "deriv_public") => assembleForecastFeed("V75", history,
    { candles: [], source, aiUsable, quality, warning: "free text that must not become the reason" }, asOf);
  assert.equal(feedFor("clean", true, "mt5_broker").reason, "HISTORY_SOURCE_MISMATCH");
  assert.equal(feedFor("clean", true).reason, "UNKNOWN_DATA_PROVENANCE"); // no closed bars to vouch for
  assert.deepEqual(feedFor("delayed", false).diagnostics, { historySource: "deriv_public", historyBars: 0, chartSource: "deriv_public", chartQuality: "delayed", chartAiUsable: false, closedBars: 0, barsBeforeLastGap: 0, lastCloseAgeSeconds: null });
  // A hole in stored history: bars on both sides are kept (training windows
  // that cross it are skipped by the model), and the newest run is reported.
  const minute = (i: number) => new Date(asOf - (400 - i) * 60_000).toISOString();
  const stored = Array.from({ length: 400 }, (_, i) => i).filter(i => i < 100 || i >= 150)
    .map(i => ({ time: minute(i), open: 10, high: 11, low: 9, close: 10.5, volume: 1 }));
  const holed = assembleForecastFeed("V75", { ok: true, source: "deriv_public", candles: stored, fetchedAt: new Date(asOf).toISOString() } as unknown as CandleHistoryResult,
    { candles: [], source: "deriv_public", aiUsable: true, quality: "clean", warning: null }, asOf);
  assert.equal(holed.bars.length, 350); assert.equal(holed.diagnostics?.closedBars, 250); assert.equal(holed.diagnostics?.barsBeforeLastGap, 100);
  assert.equal(holed.bars[100]!.openTime, Date.parse(minute(150)));
  assert.equal(holed.bars[100]!.openTime - holed.bars[99]!.openTime, 51 * 60_000);
});

test("every forecast window fits inside the model's 60 bars, from 15 minutes to one week", () => {
  assert.deepEqual(FORECAST_HORIZONS.map(h => h.id), ["15m", "30m", "1h", "4h", "8h", "12h", "24h", "2d", "1w"]);
  for (const h of FORECAST_HORIZONS) {
    assert.ok(Number.isInteger(h.bars) && h.bars >= 1 && h.bars <= 60, h.id);
    assert.equal(h.bars * h.stepMs, h.minutes * 60_000);
  }
  assert.equal(forecastHorizon("1w")?.minutes, 7 * 24 * 60);
  assert.equal(forecastHorizon("3h"), null);
});
test("a five-minute model forecasts four hours: 48 bars, five-minute ghost candles, scored in its own bars", () => {
  const step = 300_000, m5 = fixture(5000, step), m5AsOf = m5.at(-1)!.closeTime;
  const m5Model = fitStructuralModel(m5, origin);
  assert.equal(m5Model.stepMs, step);
  const f = forecastStructural(m5Model, m5.slice(-120), origin, false, 48, "4h");
  assert.equal(f.stepMs, step); assert.equal(f.horizonBars, 48); assert.equal(f.horizonId, "4h");
  const at4h = f.horizons.find(h => h.bars === 48)!;
  assert.equal(at4h.minutes, 240);
  for (const path of f.paths) {
    close(path.probability, at4h.probabilities[["UP_FIRST", "DOWN_FIRST", "NEITHER"].indexOf(path.scenario)]!);
    if (!path.candles.length) continue;
    assert.equal(path.candles.length, 48);
    assert.equal(path.candles[0]!.openTime, m5AsOf);
    assert.equal(path.candles.at(-1)!.closeTime, m5AsOf + 48 * step);
  }
  // A one-minute history cannot be read by a five-minute model.
  assert.throws(() => forecastStructural(m5Model, bars.slice(-120), origin, false, 48), /MODEL_PROVENANCE_OR_TIME_MISMATCH|INVALID|NON_FINAL/);
  // Outcomes are scored at bar counts of five minutes each, including the requested 48.
  const future = Array.from({ length: 60 }, (_, i) => ({ ...m5.at(-1)!, openTime: m5AsOf + i * step, closeTime: m5AsOf + (i + 1) * step }));
  const scores = evaluateForecast(f, future, m5AsOf + 60 * step);
  const s48 = scores.find(s => s.horizon === 48)!;
  assert.equal(s48.minutes, 240); assert.equal(s48.observedThrough, m5AsOf + 48 * step);
});
test("a requested window reads its own bar length and an unknown window is refused", async () => {
  const seen: string[] = [];
  const service = new StructuralForecastService({ repository: memory(), now: () => asOf + 1000,
    readFeed: async (_symbol, horizon) => { seen.push(horizon?.timeframe ?? "none"); return { bars, origin: { ...origin, kind: "BROKER_HISTORY" }, ready: true, reason: null }; },
    fit: () => structuredClone(model()) });
  const row = await service.issue(1, "V75", "15m");
  assert.equal(row.forecast.horizonId, "15m"); assert.equal(row.forecast.horizonBars, 15);
  assert.ok(row.forecast.horizons.some(h => h.minutes === 15));
  assert.deepEqual(seen, ["M1"]);
  await assert.rejects(service.issue(1, "V75", "3h"), (e: unknown) => e instanceof ForecastRefusal && e.code === "INVALID_HORIZON");
  // An eight-hour window asks for 15-minute bars and refuses a feed of any other length.
  await assert.rejects(service.issue(1, "V75", "8h"), (e: unknown) => e instanceof ForecastRefusal && e.code === "FEED_BAR_LENGTH_MISMATCH");
  assert.equal(seen.at(-1), "M15");
});

test("walk-forward accuracy fits only on bars before each cutoff and finds no edge in a random walk", () => {
  const walk = fixture(9000), seen: number[] = [];
  const result = walkForwardAccuracy(walk, origin, [5, 15, 60], { folds: 3, fit: (b, o) => { seen.push(b.at(-1)!.closeTime); return fitStructuralModel(b, o); } });
  assert.equal(result.folds.length, 3);
  // Every scored forecast was issued after the end of the data its model saw.
  for (const [k, fold] of result.folds.entries()) { assert.equal(fold.trainedThrough <= seen[k]!, true); assert.ok(fold.tested > 0); }
  for (const h of result.horizons) {
    assert.equal(h.forecasts, result.folds.reduce((s, f) => s + f.tested, 0));
    assert.equal(h.outcomes.up + h.outcomes.down + h.outcomes.neither, h.forecasts);
    // The fixture is a seeded random walk: there is nothing to learn, and the measurement must not claim otherwise.
    assert.ok(!(h.gainLowerBound > MODEL_POLICY_MIN_GAIN), `horizon ${h.horizonBars}: lower bound ${h.gainLowerBound}`);
  }
});
const MODEL_POLICY_MIN_GAIN = .005;

test("three projected paths: bull above middle above bear, from similar past setups that closed before the forecast", () => {
  const m = model(), index = 4800, history = bars.slice(index - 120, index);
  const f = forecastStructural(m, history, origin, false, 30);
  const t = f.trajectories!;
  assert.deepEqual(t.map(x => x.kind), ["BULL", "MIDDLE", "BEAR"]);
  assert.ok(t[0]!.endChange >= t[1]!.endChange && t[1]!.endChange >= t[2]!.endChange);
  for (const path of t) {
    assert.equal(path.candles.length, 30);
    path.candles.forEach((c, j) => { assert.equal(c.openTime, f.asOf + j * 60_000); assert.equal(c.closeTime - c.openTime, 60_000); });
    assert.ok(path.sourceEnd! < f.asOf && path.sourceEnd! <= m.trainedThrough);
    assert.ok(path.analogs >= 30 && path.share >= 0 && path.share <= 1);
    close(path.candles.at(-1)!.close / history.at(-1)!.close - 1, path.endChange);
  }
});
test("projected paths drop the training period's drift and are smooth band edges, not one past path", () => {
  const m = structuredClone(model()), index = 4800, history = bars.slice(index - 120, index);
  // Give every past setup the same strong upward drift: +0.03% a bar.
  for (const e of m.training) e.future = e.future.map((b, j) => ({ ...b, close: b.close * (1 + .0003 * (j + 1)) }));
  const t = analogTrajectories(m, history, structuralFeatures(history, history.at(-1)!.closeTime).values, 30);
  const [bull, middle, bear] = t;
  // The drift alone would put the middle 0.9% up; with it removed the middle stays near flat.
  assert.ok(Math.abs(middle!.endChange) < .0009, `middle ${middle!.endChange}`);
  assert.ok(bull!.endChange > 0 && bear!.endChange < 0);
  // Bar-by-bar percentiles: the bull edge never dips below the middle, the middle never below the bear.
  for (let j = 0; j < 30; j++) assert.ok(bull!.candles[j]!.close >= middle!.candles[j]!.close && middle!.candles[j]!.close >= bear!.candles[j]!.close);
  // Each drawn bar opens where the previous one closed.
  for (const p of t) for (let j = 1; j < 30; j++) close(p.candles[j]!.open, p.candles[j - 1]!.close);
});
test("each market gets the range engine that tested better on its own untested setups", () => {
  // A random walk: past setups say nothing, so the simpler volatility range stays and no direction is claimed.
  const walk = model();
  assert.equal(walk.rangeEngine!.engine, "VOLATILITY"); assert.equal(walk.rangeEngine!.directionEdge, false);
  assert.ok(walk.rangeEngine!.tested >= 40);
  const f = forecastStructural(walk, bars.slice(4680, 4800), origin, false, 30);
  assert.equal(f.range!.engine, "VOLATILITY"); assert.equal(f.directionEdge, false);
  assert.equal(f.trajectories![0]!.label, "VOLATILITY_BAND_EDGE");
  // A repeating cycle: similar past setups predict what follows, so history wins and its up/down share is trusted.
  let seed = 11; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 - .5; };
  const cycle: StructuralBar[] = Array.from({ length: 6000 }, (_, i) => {
    const c = (k: number) => 100 + 2 * Math.sin(2 * Math.PI * k / 240), open = c(i), close = c(i + 1) + rnd() * .01;
    return { openTime: i * 60_000, closeTime: (i + 1) * 60_000, open, high: Math.max(open, close) + .02, low: Math.min(open, close) - .02, close, isFinal: true };
  });
  const cyc = fitStructuralModel(cycle, { ...origin, symbol: "CYCLE" });
  assert.equal(cyc.rangeEngine!.engine, "HISTORY"); assert.equal(cyc.rangeEngine!.reason, "HISTORY_RELIABLY_BETTER");
  assert.equal(cyc.rangeEngine!.directionEdge, true);
  const g = forecastStructural(cyc, cycle.slice(5880, 6000), { ...origin, symbol: "CYCLE" }, false, 30);
  assert.equal(g.range!.engine, "HISTORY"); assert.equal(g.directionEdge, true);
  assert.ok(g.trajectories!.every(t => t.label === "ANALOG_PERCENTILE_PATH"));
});
test("a finished forecast is graded on its whole window, against the probabilities it showed", () => {
  const m = model(), index = 4800, history = bars.slice(index - 120, index);
  const f = forecastStructural(m, history, origin, false, 15);
  const future = bars.slice(index, index + 60);
  assert.equal(evaluateForecast(f, future, f.asOf + 14 * 60_000).some(s => s.grade), false);
  const window = evaluateForecast(f, future, f.asOf + 3_600_000).find(s => s.horizon === 15)!;
  const g = window.grade!;
  assert.ok(["A", "B", "C", "D", "F"].includes(g.letter));
  // Skill is measured against the baseline odds, not a three-way coin toss.
  close(g.skill, Math.max(-1, 1 - window.shownBrier! / window.baselineBrier));
  close(g.skillVsUniform!, 1 - window.shownBrier! / (2 / 3));
  close(g.actualEndChange, bars[index + 14]!.close / history.at(-1)!.close - 1);
  assert.ok(["BULL", "MIDDLE", "BEAR"].includes(g.nearestPath!));
  const base: [number, number, number] = [.45, .45, .1];
  // A confident correct call earns an A; a confident wrong one an F.
  assert.equal(gradeForecast(f, future.slice(0, 15), [.9, .05, .05], 0, base).letter, "A");
  assert.equal(gradeForecast(f, future.slice(0, 15), [.9, .05, .05], 1, base).letter, "F");
  // Showing the baseline's own odds is a C, however well that beats a coin toss among three.
  const same = gradeForecast(f, future.slice(0, 15), base, 0, base);
  assert.equal(same.letter, "C"); close(same.skill, 0); assert.ok(same.skillVsUniform! > .1);
});
test("older coin-toss grades are re-derived against the baseline on read, without changing the stored score", () => {
  const stored = { horizon: 60, outcome: "UP_FIRST", brier: .5, baselineBrier: .5, shownBrier: .5,
    grade: { gradeVersion: "v:grade-1", letter: "B", skill: .25, probabilityOfOutcome: .5, actualEndChange: .001, nearestPath: null, insideRange: null, middlePathError: null } } as never as Parameters<typeof regradeAgainstBaseline>[0];
  const frozen = structuredClone(stored);
  const read = regradeAgainstBaseline(stored);
  assert.equal(read.grade!.letter, "C"); close(read.grade!.skill, 0);
  assert.equal(read.grade!.skillVsUniform, .25); assert.equal(read.grade!.rederived, true);
  assert.deepEqual(stored, frozen);
  // New grades and scores without the Briers pass through unchanged.
  const fresh = { ...stored, grade: { ...stored.grade!, gradeVersion: "v:grade-2" } };
  assert.equal(regradeAgainstBaseline(fresh), fresh);
  const noBrier = { ...stored, shownBrier: undefined };
  assert.equal(regradeAgainstBaseline(noBrier), noBrier);
});
test("calibration learns only from forecasts graded before this one and keeps a change only if it helps unseen forecasts", () => {
  const raw: [number, number, number] = [.45, .45, .1];
  const rows = (n: number, outcome: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ p: raw, outcome: outcome(i), completedAt: 1000 + i }));
  assert.equal(calibrate(raw, rows(29, () => 2), 5000).record.applied, false);
  const learned = calibrate(raw, rows(60, () => 2), 5000);
  assert.equal(learned.record.applied, true);
  assert.ok(learned.record.holdoutGain! > 0 && learned.shown[2] > raw[2]);
  close(learned.shown.reduce((a, b) => a + b, 0), 1);
  // Outcomes graded after the forecast cannot teach it anything.
  assert.equal(calibrate(raw, rows(60, () => 2), 1010).record.applied, false);
  // When the model already matches reality, nothing is changed.
  const matched = calibrate([1 / 3, 1 / 3, 1 / 3], rows(90, i => i % 3).map(r => ({ ...r, p: [1 / 3, 1 / 3, 1 / 3] as [number, number, number] })), 5000);
  assert.equal(matched.record.applied, false);
  assert.deepEqual(matched.shown, [1 / 3, 1 / 3, 1 / 3]);
});
test("a window scored before grades existed gets its grade appended once, beside the original score", async () => {
  const repository = memory(), index = 4800;
  const f = { ...forecastStructural(model(), bars.slice(index - 120, index), origin, false, 15), origin: { ...origin, kind: "BROKER_HISTORY" as const } };
  // Scored by the old scorer: every horizon through 60, no letter on the window.
  const legacy = evaluateForecast(f, bars.slice(index, index + 60), f.asOf + 3_600_000).map(({ grade, shownBrier, ...s }) => ({ ...s, evaluationVersion: "old:scoring-1" }));
  assert.ok(legacy.some(s => s.horizon === 60) && legacy.every(s => !("grade" in s)));
  repository.rows.set("1:legacy", { id: "legacy", issuedAt: f.asOf, forecast: f, scores: structuredClone(legacy) });
  const service = new StructuralForecastService({ repository, now: () => f.asOf + 7_200_000,
    readFeed: async () => ({ bars, origin: { ...origin, kind: "BROKER_HISTORY" }, ready: true, reason: null }), fit: () => structuredClone(model()) });
  const read = (await service.history(1, "V75")).find(r => r.id === "legacy")!;
  const window = read.scores.filter(s => s.horizon === 15);
  assert.equal(window.length, 1); assert.ok(window[0]!.grade); assert.equal(window[0]!.lateGrade, true);
  // Same bars, same outcome as the original score.
  assert.equal(window[0]!.outcome, legacy.find(s => s.horizon === 15)!.outcome);
  const stored = repository.rows.get("1:legacy")!.scores;
  assert.equal(stored.length, legacy.length + 1);
  assert.ok(stored.some(s => s.horizon === 15 && !s.grade), "the original score is kept");
  await service.history(1, "V75");
  assert.equal(repository.rows.get("1:legacy")!.scores.length, legacy.length + 1, "graded only once");
});
test("the service shows learned probabilities for a window once enough of its forecasts are graded", async () => {
  const repository = memory();
  const template = forecastStructural(model(), bars.slice(-120), origin, false, 60, "1h");
  for (let i = 0; i < 60; i++) {
    // Earlier issuances whose whole hour closed before the new forecast.
    const old = { ...template, asOf: template.asOf - (i + 2) * 3_600_000, origin: { ...template.origin, kind: "BROKER_HISTORY" as const } };
    repository.rows.set(`1:old-${i}`, { id: `old-${i}`, issuedAt: old.asOf, forecast: { ...old, calibration: undefined },
      scores: [{ evaluationVersion: "t", horizon: 60, observedThrough: old.asOf + 3_600_000, outcome: "NEITHER", event: null, brier: 0, baselineBrier: 0, logLoss: 0 }] });
  }
  const service = new StructuralForecastService({ repository, now: () => asOf + 1000,
    readFeed: async () => ({ bars, origin: { ...origin, kind: "BROKER_HISTORY" }, ready: true, reason: null }), fit: () => structuredClone(model()) });
  const row = await service.issue(1, "V75", "1h");
  const c = row.forecast.calibration!;
  assert.equal(c.graded, 60);
  const shown = row.forecast.horizons.find(h => h.bars === 60)!.probabilities;
  if (c.applied) assert.ok(shown[2] > c.raw[2]); else assert.deepEqual(shown, c.raw);
  assert.deepEqual(c.raw, probabilities(row.forecast.mass, 60));
});
test("learning counts one forecast per window: updates and forecasts overlapping an earlier one are left out", () => {
  const kept = independentForecasts([{ asOf: 0 }, { asOf: 10 }, { asOf: 60 }, { asOf: 61 }, { asOf: 70, update: true }, { asOf: 130 }], 60);
  assert.deepEqual(kept.map(r => r.asOf), [0, 60, 130]);
  const raw: [number, number, number] = [.45, .45, .1];
  // Sixty forecasts a minute apart on a one-hour window are one bet, not sixty.
  const overlapping = Array.from({ length: 60 }, (_, i) => ({ p: raw, outcome: 2, completedAt: 1000 + i, asOf: i * 60_000 }));
  const r = calibrate(raw, overlapping, 5000, 3_600_000).record;
  assert.equal(r.applied, false);
  assert.equal(r.graded, 1);
  assert.equal(r.skippedOverlapping, 59);
});
test("a forecast issued while an earlier one of the window is open is saved as an update of it", async () => {
  const fresh = async (anchorAgoMs: number) => {
    const repository = memory();
    const template = forecastStructural(model(), bars.slice(-120), origin, false, 60, "1h");
    const anchor = { ...template, asOf: template.asOf - anchorAgoMs, origin: { ...template.origin, kind: "BROKER_HISTORY" as const } };
    repository.rows.set("1:anchor", { id: "anchor", issuedAt: anchor.asOf, forecast: anchor, scores: [] });
    const service = new StructuralForecastService({ repository, now: () => asOf + 1000,
      readFeed: async () => ({ bars, origin: { ...origin, kind: "BROKER_HISTORY" }, ready: true, reason: null }), fit: () => structuredClone(model()) });
    return (await service.issue(1, "V75", "1h")).forecast;
  };
  assert.deepEqual((await fresh(10 * 60_000)).update, { of: "anchor", anchorAsOf: asOf - 10 * 60_000, barsIntoWindow: 10 });
  assert.equal((await fresh(60 * 60_000)).update, undefined);
});

test("on M15 the volatility range is the hour-of-week band fitted on training bars; M1 keeps the 120-bar band", () => {
  // M1: the bar size was not measured (docs/STRUCTURAL_VOL_RANGE_RESULTS.md), so no profile.
  const m1 = model();
  assert.equal(m1.volRange, undefined);
  assert.equal(forecastStructural(m1, bars.slice(-120), origin, false, 60, undefined, bars).range?.volatility, "RECENT_120_BARS");
  const m15 = fixture(5000, 900_000), m15Origin = { ...origin, symbol: "EURUSD" };
  const fittedM15 = fitStructuralModel(m15, m15Origin);
  const profile = fittedM15.volRange!;
  assert.ok(profile, "M15 model carries a profile");
  assert.equal(profile.stepMs, 900_000);
  assert.equal(profile.halfLifeBars, 96);
  assert.ok(profile.fittedThrough <= fittedM15.trainedThrough, "profile fitted on training bars only");
  const f = forecastStructural(fittedM15, m15.slice(-120), m15Origin, false, 48, "12h", m15);
  assert.equal(f.range?.volatility, "HOUR_OF_WEEK");
  if (f.range?.engine === "VOLATILITY") {
    const band = seasonalBandAt(m15, profile, 48)!;
    close(f.trajectories!.find(t => t.kind === "BULL")!.endChange, band.bull[47]!);
    close(f.trajectories!.find(t => t.kind === "BEAR")!.endChange, band.bear[47]!);
  }
  // Without the feed (or a feed ending at another bar) it falls back to the 120-bar band.
  assert.equal(forecastStructural(fittedM15, m15.slice(-120), m15Origin, false, 48).range?.volatility, "RECENT_120_BARS");
  assert.equal(forecastStructural(fittedM15, m15.slice(-120), m15Origin, false, 48, undefined, m15.slice(0, -1)).range?.volatility, "RECENT_120_BARS");
  // Symmetric in logs whichever band is drawn: no direction.
  const vol = analogTrajectories(fittedM15, m15.slice(-120), f.features, 48, "VOLATILITY", seasonalBandAt(m15, profile, 48));
  close(vol[0]!.endChange, seasonalBandAt(m15, profile, 48)!.bull[47]!);
  close((1 + vol[0]!.endChange) * (1 + vol[2]!.endChange), 1);
});

test("route estimates condition each future close on the first break within the issued horizon", () => {
  const anchor = bars[119]!;
  const episode = (first: number, second: number, eventBar: number) => ({
    origin: anchor.closeTime, history: [anchor], features: [], eligible: true, step: 60_000,
    future: [first, second].map((ratio, i) => ({ ...bars[120 + i]!, close: anchor.close * ratio })),
    event: { ...model().training.find(e => e.event)!.event!, cause: "BOS_UP", time: anchor.closeTime + eventBar * 60_000 } as const,
  });
  const examples = [episode(1.01, .98, 1), episode(1.03, 1.02, 2), episode(1.02, 1.01, 1), episode(2, 3, 3)];
  const point = estimatePrice({ method: "ANALOG_MEDIAN", tested: 50 }, examples, anchor, 2, 60_000);
  close(point.candles[0]!.close, anchor.close * 1.025);
  const fallback = estimatePrice(undefined, examples, anchor, 2, 60_000);
  const flat = scoreClosePath(fallback, examples[0]!.future)!;
  assert.equal(fallback.method, "FLAT");
  assert.equal(flat.matched, 2);
  assert.equal(flat.mae, flat.flatMae);
  const [up, down, neither] = forecastRoutes(examples, anchor, 2, 60_000);
  assert.equal(up!.matches, 3);
  close(up!.candles[0]!.close, anchor.close * 1.02);
  close(up!.candles[1]!.close, anchor.close * 1.01);
  assert.equal(up!.candles[0]!.openTime, anchor.closeTime);
  assert.equal(up!.candles[1]!.closeTime, anchor.closeTime + 120_000);
  assert.equal(neither!.matches, 1);
  assert.deepEqual(neither!.candles, []);
  assert.equal(down!.matches, 0);
  assert.equal(favoredScenario([.455, .545, 0]), "DOWN_FIRST");
  assert.equal(favoredScenario([.5001, .4999, 0]), null);
  const projected = up!.candles[1]!;
  const score = scoreForecastRoute(up!, [{ ...projected, close: anchor.close * 1.015 }, { ...up!.candles[0]!, closeTime: 0 }])!;
  assert.equal(score.matched, 1);
  close(score.mae, anchor.close * .005);
  close(score.flatMae, anchor.close * .015);
});
