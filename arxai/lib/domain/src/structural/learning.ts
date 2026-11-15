import { STRUCTURAL_VERSION, type CalibrationRecord, type ForecastGrade, type StructuralBar, type StructuralForecast,
  type Trajectory, type TrajectoryKind, type Triple } from "./contracts.js";
import { brier } from "./math.js";
import type { StructuralModel } from "./model.js";

/**
 * Projected paths from the most similar past setups. Similarity is distance in
 * the model's own structural features, standardized over the training set. Only
 * episodes whose whole future closed before the forecast are eligible, so no
 * path can contain anything that happened after it was issued.
 */
export function analogTrajectories(model: StructuralModel, history: readonly StructuralBar[], features: readonly number[], horizonBars = 60): Trajectory[] {
  const last = history.at(-1);
  if (!last) return [];
  const asOf = last.closeTime, start = last.close, step = model.stepMs ?? 60_000;
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
  const analogs = nearest.slice(0, k).map(({ e }) => {
    const ratio = start / e.history.at(-1)!.close;
    const candles = e.future.slice(0, horizonBars).map((b, j) => ({ ...b, openTime: asOf + j * step, closeTime: asOf + (j + 1) * step,
      open: b.open * ratio, high: b.high * ratio, low: b.low * ratio, close: b.close * ratio }));
    return { candles, end: e.future.at(-1)!.closeTime, change: candles.at(-1)!.close / start - 1 };
  }).sort((a, b) => a.change - b.change);
  const at = (q: number) => analogs[Math.round(q * (analogs.length - 1))]!;
  const bear = at(.25), middle = at(.5), bull = at(.75), n = analogs.length;
  const share: Record<TrajectoryKind, number> = {
    BULL: analogs.filter(a => a.change > 0).length / n,
    BEAR: analogs.filter(a => a.change < 0).length / n,
    MIDDLE: analogs.filter(a => a.change >= bear.change && a.change <= bull.change).length / n,
  };
  const make = (kind: TrajectoryKind, percentile: 75 | 50 | 25, a: typeof bull): Trajectory =>
    ({ kind, percentile, label: "ANALOG_PERCENTILE_PATH", candles: a.candles, endChange: a.change, share: share[kind], analogs: n, sourceEnd: a.end });
  return [make("BULL", 75, bull), make("MIDDLE", 50, middle), make("BEAR", 25, bear)];
}

const UNIFORM_BRIER = 2 / 3;
const letter = (skill: number): ForecastGrade["letter"] =>
  skill >= .5 ? "A" : skill >= .25 ? "B" : skill >= 0 ? "C" : skill >= -.25 ? "D" : "F";

/** Judge a finished forecast against the bars of its whole window. */
export function gradeForecast(f: StructuralForecast, windowBars: readonly StructuralBar[], shown: Triple, outcome: number): ForecastGrade {
  const start = f.history.at(-1)!.close, end = windowBars.at(-1)!.close;
  const actualEndChange = end / start - 1, shownBrier = brier(shown, outcome), skill = 1 - shownBrier / UNIFORM_BRIER;
  const paths = f.trajectories ?? [];
  const nearest = paths.length ? paths.reduce((a, b) => Math.abs(b.endChange - actualEndChange) < Math.abs(a.endChange - actualEndChange) ? b : a) : null;
  const bull = paths.find(p => p.kind === "BULL"), bear = paths.find(p => p.kind === "BEAR"), middle = paths.find(p => p.kind === "MIDDLE");
  const n = middle ? Math.min(middle.candles.length, windowBars.length) : 0;
  return { gradeVersion: `${STRUCTURAL_VERSION}:grade-1`, letter: letter(skill), skill, probabilityOfOutcome: shown[outcome]!,
    actualEndChange, nearestPath: nearest?.kind ?? null,
    insideRange: bull && bear ? actualEndChange >= bear.endChange && actualEndChange <= bull.endChange : null,
    middlePathError: n ? Array.from({ length: n }, (_, j) => Math.abs(middle!.candles[j]!.close - windowBars[j]!.close) / start).reduce((s, x) => s + x, 0) / n : null };
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
