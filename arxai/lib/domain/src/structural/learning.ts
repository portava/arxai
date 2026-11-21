import { STRUCTURAL_VERSION, type CalibrationRecord, type ForecastGrade, type StructuralBar, type StructuralForecast,
  scenarioOf, type ForecastRoute, type Trajectory, type TrajectoryKind, type Triple } from "./contracts.js";
import { brier } from "./math.js";
import { lowerMeanGain, type Episode, type StructuralModel } from "./model.js";

export type RangeEngine = "HISTORY" | "VOLATILITY";
/** Which engine draws a market's range, and the out-of-sample evidence for the choice. */
export interface RangeEngineChoice {
  engine: RangeEngine; reason: "HISTORY_RELIABLY_BETTER" | "HISTORY_NOT_RELIABLY_BETTER" | "TOO_FEW_TEST_SETUPS";
  /** Setups scored: fitted-on data excluded; each one's past analogs closed before it. */
  tested: number;
  /** Share of outcomes inside each engine's 25%-75% range (ideal 0.5), across 15/30/60 bars ahead. */
  historyInside: number | null; volatilityInside: number | null;
  /** Up/down call from the analogs: Brier (coin flip = 0.25) and whether it reliably beat a coin flip. */
  directionBrier: number | null; directionEdge: boolean;
}
export const RANGE_ENGINE_POLICY = Object.freeze({ minTested: 40, checkpoints: [15, 30, 60] as const });

/**
 * Choose, per market, the engine that drew the better range on setups the
 * model was not fitted on (its selection and gate partitions). Each range is
 * judged by the 50% interval score (width plus 4x any miss: lower is better),
 * which rewards a range that is both narrow and holds half the outcomes.
 * History is chosen only when its advantage holds at the bootstrap lower
 * bound; otherwise the simpler volatility range is kept. The same setups
 * decide whether the analogs' up/down share beats a coin flip.
 */
export function chooseRangeEngine(model: StructuralModel, tests: readonly Episode[],
  volBandAt?: (e: Episode) => VolBand | null): RangeEngineChoice {
  const gains: number[] = [], directionGains: number[] = [];
  let hIn = 0, vIn = 0, checks = 0, dirBrier = 0;
  for (const e of tests) {
    if (e.future.length < 60) continue;
    const hist = analogTrajectories(model, e.history, e.features, 60, "HISTORY");
    const vol = analogTrajectories(model, e.history, e.features, 60, "VOLATILITY", volBandAt?.(e) ?? null);
    if (hist.length !== 3 || vol.length !== 3) continue;
    const start = e.history.at(-1)!.close;
    let gain = 0;
    for (const j of RANGE_ENGINE_POLICY.checkpoints) {
      const y = e.future[j - 1]!.close / start - 1;
      const score = (t: Trajectory[]) => {
        const hi = t[0]!.candles[j - 1]!.close / start - 1, lo = t[2]!.candles[j - 1]!.close / start - 1;
        return { s: (hi - lo) + 4 * Math.max(0, lo - y) + 4 * Math.max(0, y - hi), inside: y >= lo && y <= hi };
      };
      const h = score(hist), v = score(vol);
      gain += v.s - h.s; hIn += +h.inside; vIn += +v.inside; checks++;
    }
    gains.push(gain);
    const up = +(e.future[59]!.close > start), b = (hist[0]!.share - up) ** 2;
    dirBrier += b; directionGains.push(.25 - b);
  }
  const tested = gains.length;
  if (tested < RANGE_ENGINE_POLICY.minTested) return { engine: "VOLATILITY", reason: "TOO_FEW_TEST_SETUPS", tested,
    historyInside: checks ? hIn / checks : null, volatilityInside: checks ? vIn / checks : null, directionBrier: tested ? dirBrier / tested : null, directionEdge: false };
  const historyWins = lowerMeanGain(gains) > 0;
  return { engine: historyWins ? "HISTORY" : "VOLATILITY", reason: historyWins ? "HISTORY_RELIABLY_BETTER" : "HISTORY_NOT_RELIABLY_BETTER", tested,
    historyInside: hIn / checks, volatilityInside: vIn / checks, directionBrier: dirBrier / tested, directionEdge: lowerMeanGain(directionGains) > 0 };
}

/**
 * The VOLATILITY engine's range: the 25%-75% band of a random walk at the
 * volatility of the forecast's own recent bars, +-0.6745 sigma sqrt(bars
 * ahead) in logs, sigma the RMS of the close-to-close log returns in
 * `history`. Symmetric, so it carries no direction. Exported so research can
 * score exactly what the product draws (docs/STRUCTURAL_VOL_RANGE_RESULTS.md).
 */
export type VolBand = { bull: number[]; bear: number[] };
export function volatilityBand(history: readonly StructuralBar[], horizonBars: number): VolBand {
  const returns = history.slice(1).map((b, j) => Math.log(b.close / history[j]!.close)).filter(Number.isFinite);
  const sigma = returns.length ? Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length) : 0;
  const edge = (sign: 1 | -1) => Array.from({ length: horizonBars }, (_, j) => Math.exp(sign * .6745 * sigma * Math.sqrt(j + 1)) - 1);
  return { bull: edge(1), bear: edge(-1) };
}

export function historicalNeighbors(model: StructuralModel, features: readonly number[], horizonBars: number, asOf: number): Episode[] {
  const eligible = model.training.filter(e => e.future.length >= horizonBars
    && e.future.at(-1)!.closeTime <= model.trainedThrough && e.future.at(-1)!.closeTime < asOf
    && e.features.length === features.length && e.features.every(Number.isFinite));
  if (!eligible.length || !features.every(Number.isFinite)) return [];
  const d = features.length;
  const mean = Array.from({ length: d }, (_, k) => eligible.reduce((s, e) => s + e.features[k]!, 0) / eligible.length);
  const scale = mean.map((m, k) => Math.max(1e-6, Math.sqrt(eligible.reduce((s, e) => s + (e.features[k]! - m) ** 2, 0) / eligible.length)));
  const distance = (x: readonly number[]) => Math.sqrt(x.reduce((s, v, k) => s + ((v - features[k]!) / scale[k]!) ** 2, 0));
  const nearest = eligible.map(e => ({ e, d: distance(e.features) })).sort((a, b) => a.d - b.d);
  const k = Math.min(nearest.length, Math.max(30, Math.round(nearest.length * .25)));
  return nearest.slice(0, k).map(({ e }) => e);
}

/** Estimate each future close from the median relative close of similar episodes
 * with the same first-break outcome. All neighbors have finished before issuance. */
export function forecastRoutes(neighbors: readonly Episode[], anchor: StructuralBar, horizonBars: number, step: number): ForecastRoute[] {
  return (["UP_FIRST", "DOWN_FIRST", "NEITHER"] as const).map(scenario => {
    const matches = neighbors.filter(e => scenarioOf(e.event && e.event.time <= e.origin + horizonBars * step ? e.event : null) === scenario);
    const candles: StructuralBar[] = [];
    // One or two episodes would just trace individual historical examples.
    if (matches.length >= 3) {
      for (let j = 0; j < horizonBars; j++) {
        const ratios = matches.map(e => e.future[j]!.close / e.history.at(-1)!.close).sort((a, b) => a - b);
        const mid = Math.floor(ratios.length / 2);
        const ratio = ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
        const close = anchor.close * ratio, open = candles.at(-1)?.close ?? anchor.close;
        candles.push({ openTime: anchor.closeTime + j * step, closeTime: anchor.closeTime + (j + 1) * step,
          open, close, high: Math.max(open, close), low: Math.min(open, close), isFinal: false });
      }
    }
    return { scenario, matches: matches.length, candles };
  });
}

/**
 * Projected paths from the most similar past setups. Similarity is distance in
 * the model's own structural features, standardized over the training set. Only
 * episodes whose whole future closed before the forecast are eligible, so no
 * path can contain anything that happened after it was issued.
 */
export function analogTrajectories(model: StructuralModel, history: readonly StructuralBar[], features: readonly number[], horizonBars = 60,
  engine: RangeEngine = model.rangeEngine?.engine ?? "VOLATILITY",
  /** The hour-of-week band (volRange.ts) when the model has one; otherwise the 120-bar band. */
  seasonalBand: VolBand | null = null, neighbors?: readonly Episode[]): Trajectory[] {
  const last = history.at(-1);
  if (!last) return [];
  const asOf = last.closeTime, start = last.close, step = model.stepMs ?? 60_000;
  const used = neighbors ?? historicalNeighbors(model, features, horizonBars, asOf);
  if (!used.length) return [];
  const n = used.length, sourceEnd = Math.max(...used.map(e => e.future.at(-1)!.closeTime));
  // Each analog as change from its own start, bar by bar.
  const rel = used.map(e => e.future.slice(0, horizonBars).map(b => b.close / e.history.at(-1)!.close - 1));
  // Remove the analog set's average drift. Walk-forward on 41k real bars per
  // market: the drift came from the training period, pushed the range up
  // (more outcomes fell below it than above) and made the middle path 17-19%
  // worse than a flat line; without it the middle path matches a flat line.
  const drift = Array.from({ length: horizonBars }, (_, j) => rel.reduce((s, r) => s + r[j]!, 0) / n);
  const adj = rel.map(r => r.map((x, j) => x - drift[j]!));
  // Percentiles are taken bar by bar, so each path is a smooth band edge
  // rather than one noisy past path (a single path adds its own noise).
  const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.round(q * (s.length - 1))]!; };
  const band = (q: number) => Array.from({ length: horizonBars }, (_, j) => quantile(adj.map(r => r[j]!), q));
  const candlesOf = (path: number[]) => path.map((c, j) => {
    const open = start * (1 + (j ? path[j - 1]! : 0)), close = start * (1 + c);
    return { openTime: asOf + j * step, closeTime: asOf + (j + 1) * step, open, high: Math.max(open, close), low: Math.min(open, close), close, isFinal: false };
  });
  // Bull and bear come from the engine chosen for this market when the model
  // was fitted (see chooseRangeEngine):
  // VOLATILITY: the 25%-75% range of a random walk, +-0.6745 sqrt(variance
  //   ahead) in logs. On M15/H1 the variance is the hour-of-week forecast
  //   (volRange.ts); elsewhere it is the forecast's own recent 120 bars.
  // HISTORY: the analogs' own drift-free 25th/75th percentiles, bar by bar.
  const vol = engine === "HISTORY" ? null
    : seasonalBand && seasonalBand.bull.length >= horizonBars ? { bull: seasonalBand.bull.slice(0, horizonBars), bear: seasonalBand.bear.slice(0, horizonBars) }
    : volatilityBand(history, horizonBars);
  const bullPath = vol ? vol.bull : band(.75), bearPath = vol ? vol.bear : band(.25);
  // The middle stays the analogs' drift-free median, kept inside the range.
  const middlePath = band(.5).map((x, j) => Math.min(bullPath[j]!, Math.max(bearPath[j]!, x)));
  const ends = adj.map(r => r.at(-1)!), bullEnd = bullPath.at(-1)!, bearEnd = bearPath.at(-1)!;
  const share: Record<TrajectoryKind, number> = {
    BULL: ends.filter(c => c > 0).length / n,
    BEAR: ends.filter(c => c < 0).length / n,
    MIDDLE: ends.filter(c => c >= bearEnd && c <= bullEnd).length / n,
  };
  const make = (kind: TrajectoryKind, percentile: 75 | 50 | 25, path: number[]): Trajectory =>
    ({ kind, percentile, label: kind === "MIDDLE" || engine === "HISTORY" ? "ANALOG_PERCENTILE_PATH" : "VOLATILITY_BAND_EDGE", candles: candlesOf(path), endChange: path.at(-1)!, share: share[kind], analogs: n, sourceEnd });
  return [make("BULL", 75, bullPath), make("MIDDLE", 50, middlePath), make("BEAR", 25, bearPath)];
}

const UNIFORM_BRIER = 2 / 3;
/**
 * Letters judge the shown odds against the baseline, not against a coin toss
 * among three outcomes. On long windows one outcome ("neither") almost never
 * happens, so beating the three-way coin toss took no skill: a walk-forward on
 * real V75/V25 bars scored ~0.25 that way (a B/C) while calling direction
 * 50% of the time. C means about as good as the baseline.
 */
export const GRADE_POLICY = Object.freeze({ A: .25, B: .1, C: -.1, D: -.25 });
const letter = (skill: number): ForecastGrade["letter"] =>
  skill >= GRADE_POLICY.A ? "A" : skill >= GRADE_POLICY.B ? "B" : skill >= GRADE_POLICY.C ? "C" : skill >= GRADE_POLICY.D ? "D" : "F";
/** 1 − shown Brier / baseline Brier, floored at −1. */
export function skillOverBaseline(shownBrier: number, baselineBrier: number): number {
  if (baselineBrier <= 1e-12) return shownBrier <= 1e-12 ? 0 : -1;
  return Math.max(-1, 1 - shownBrier / baselineBrier);
}

/** Select a favorite using the same tenth-of-a-percent precision displayed on the chart. */
export function favoredScenario(weights: Triple) {
  const scenarios = ["UP_FIRST", "DOWN_FIRST", "NEITHER"] as const;
  const ranked = scenarios.map((scenario, i) => ({ scenario, weight: weights[i]! })).sort((a, b) => b.weight - a.weight);
  return (ranked[0]!.weight * 100).toFixed(1) === (ranked[1]!.weight * 100).toFixed(1) ? null : ranked[0]!.scenario;
}

export function scoreForecastRoute(route: ForecastRoute, actual: readonly Pick<StructuralBar, "openTime" | "closeTime" | "close">[]) {
  const observations = new Map(actual.map(b => [b.openTime, b]));
  const anchor = route.candles[0]?.open;
  let matched = 0, error = 0, flatError = 0;
  for (const p of route.candles) {
    const bar = observations.get(p.openTime);
    if (anchor === undefined || !bar || bar.closeTime !== p.closeTime || !Number.isFinite(bar.close)) continue;
    matched++;
    error += Math.abs(p.close - bar.close);
    flatError += Math.abs(anchor - bar.close);
  }
  return matched ? { scenario: route.scenario, matched, mae: error / matched, flatMae: flatError / matched } : null;
}

/** Judge a finished forecast against the bars of its whole window. */
export function gradeForecast(f: StructuralForecast, windowBars: readonly StructuralBar[], shown: Triple, outcome: number, baseline: Triple): ForecastGrade {
  const start = f.history.at(-1)!.close, end = windowBars.at(-1)!.close;
  const actualEndChange = end / start - 1, shownBrier = brier(shown, outcome), skill = skillOverBaseline(shownBrier, brier(baseline, outcome));
  const paths = f.trajectories ?? [];
  const nearest = paths.length ? paths.reduce((a, b) => Math.abs(b.endChange - actualEndChange) < Math.abs(a.endChange - actualEndChange) ? b : a) : null;
  const bull = paths.find(p => p.kind === "BULL"), bear = paths.find(p => p.kind === "BEAR"), middle = paths.find(p => p.kind === "MIDDLE");
  const n = middle ? Math.min(middle.candles.length, windowBars.length) : 0;
  const route = f.routes?.find(r => r.scenario === favoredScenario(shown));
  const routeScore = route && scoreForecastRoute(route, windowBars);
  return { ...(routeScore ? { routeScore } : {}), gradeVersion: `${STRUCTURAL_VERSION}:grade-2`, letter: letter(skill), skill, skillVsUniform: 1 - shownBrier / UNIFORM_BRIER, probabilityOfOutcome: shown[outcome]!,
    actualEndChange, nearestPath: nearest?.kind ?? null,
    insideRange: bull && bear ? actualEndChange >= bear.endChange && actualEndChange <= bull.endChange : null,
    middlePathError: n ? Array.from({ length: n }, (_, j) => Math.abs(middle!.candles[j]!.close - windowBars[j]!.close) / start).reduce((s, x) => s + x, 0) / n : null };
}

/**
 * Older grades (grade-1) measured skill against a three-way coin toss. Their
 * stored record stays as it is; on read, the baseline-relative grade is
 * re-derived from the Briers saved with the same score.
 */
export function regradeAgainstBaseline<S extends { grade?: ForecastGrade; shownBrier?: number; baselineBrier: number }>(score: S): S {
  const g = score.grade;
  if (!g || !g.gradeVersion.endsWith(":grade-1") || score.shownBrier == null || !Number.isFinite(score.baselineBrier)) return score;
  const skill = skillOverBaseline(score.shownBrier, score.baselineBrier);
  return { ...score, grade: { ...g, skill, letter: letter(skill), skillVsUniform: g.skill, rederived: true } };
}

export interface GradedObservation {
  p: Triple; outcome: number; completedAt: number;
  /** When the forecast was issued, and whether it updated an open forecast. */
  asOf?: number; update?: boolean;
}
/**
 * One forecast per window: drop updates, then keep forecasts in issue order
 * only when each starts after the previous kept one's window has ended.
 * Overlapping forecasts mostly repeat one bet, so counting them all would
 * make the learning look more certain than the evidence is.
 */
export function independentForecasts<T extends { asOf?: number; update?: boolean }>(rows: readonly T[], windowMs: number): T[] {
  const kept: T[] = [];
  let openUntil = Number.NEGATIVE_INFINITY;
  for (const r of [...rows].filter(r => !r.update).sort((a, b) => (a.asOf ?? 0) - (b.asOf ?? 0))) {
    if (r.asOf == null) { kept.push(r); continue; }
    if (r.asOf < openUntil) continue;
    kept.push(r); openUntil = r.asOf + windowMs;
  }
  return kept;
}
export const CALIBRATION_POLICY = Object.freeze({ minGraded: 30, holdoutShare: .3, weights: [0, .25, .5, .75, 1] });
const mix = (p: Triple, q: Triple, w: number): Triple => [0, 1, 2].map(i => (1 - w) * p[i]! + w * q[i]!) as Triple;
const frequencies = (rows: readonly GradedObservation[]): Triple =>
  [0, 1, 2].map(i => (rows.filter(r => r.outcome === i).length + 1) / (rows.length + 3)) as Triple;
const meanBrier = (rows: readonly GradedObservation[], f: (p: Triple) => Triple) =>
  rows.reduce((s, r) => s + brier(f(r.p), r.outcome), 0) / Math.max(1, rows.length);

/**
 * Learn from graded forecasts: blend the model's probabilities toward how often
 * each outcome actually happened. The blend weight is chosen on the older 70% of
 * graded forecasts and kept only if it also scores better on the newest 30%,
 * which it never saw. Otherwise the raw model is shown unchanged.
 */
export function calibrate(raw: Triple, graded: readonly GradedObservation[], completedBefore: number, windowMs?: number): { shown: Triple; record: CalibrationRecord } {
  const done = graded.filter(r => r.completedAt <= completedBefore && r.p.every(Number.isFinite));
  const rows = (windowMs ? independentForecasts(done, windowMs) : done).sort((a, b) => a.completedAt - b.completedAt);
  const skippedOverlapping = done.length - rows.length;
  const none = (reason: string, extra: Partial<CalibrationRecord> = {}) =>
    ({ shown: raw, record: { applied: false, reason, graded: rows.length, heldOut: 0, weight: 0, frequencies: null, holdoutGain: null, raw, skippedOverlapping, ...extra } });
  if (rows.length < CALIBRATION_POLICY.minGraded) return none(`FEWER_THAN_${CALIBRATION_POLICY.minGraded}_GRADED`);
  const cut = Math.floor(rows.length * (1 - CALIBRATION_POLICY.holdoutShare));
  const train = rows.slice(0, cut), test = rows.slice(cut), q = frequencies(train);
  const weight = CALIBRATION_POLICY.weights.reduce((best, w) => meanBrier(train, p => mix(p, q, w)) < meanBrier(train, p => mix(p, q, best)) ? w : best, 0);
  const holdoutGain = meanBrier(test, p => p) - meanBrier(test, p => mix(p, q, weight));
  if (weight === 0) return none("RAW_MODEL_SCORED_BEST", { heldOut: test.length, holdoutGain: 0 });
  if (!(holdoutGain > 0)) return none("DID_NOT_IMPROVE_ON_HELD_OUT_FORECASTS", { heldOut: test.length, weight, holdoutGain });
  const all = frequencies(rows);
  return { shown: mix(raw, all, weight), record: { applied: true, reason: "IMPROVED_ON_HELD_OUT_FORECASTS", graded: rows.length,
    heldOut: test.length, weight, frequencies: all, holdoutGain, raw, skippedOverlapping } };
}
