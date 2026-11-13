import { CAUSES, STRUCTURAL_VERSION, scenarioIndex, scenarioOf, type Mass, type Triple, type StructuralBar,
  type StructuralEvent, type DataOrigin, type StructuralForecast, type GhostPath } from "./contracts.js";
import { observeStructure, structuralFeatures, validateBars } from "./observer.js";
import { softmax, hazardsToMass, probabilities, brier, reallocateEarly, prebreakCandidate, horizonsFromMass } from "./math.js";

/** New, preregisterable implementation choices, not recovered V6.7 settings. */
export const MODEL_POLICY = Object.freeze({ stride: 15, purgeMinutes: 60, minTraining: 80,
  minGate: 30, iterations: 120, learningRate: .08, ridge: .01, oodZ: 6,
  blends: [0, .25, .5, .75, 1], minimumGain: .005, brakeWindow: 30,
  brakeExcess: .03, bootstrapReplicates: 400 });
export interface Episode { origin: number; history: StructuralBar[]; future: StructuralBar[];
  features: number[]; eligible: boolean; event: StructuralEvent | null }
export interface LinearHead { mean: number[]; scale: number[]; weights: number[][] }
export interface Gate { accepted: boolean; blend: number; selectedBlend: number; n: number; gain: number | null;
  lowerGain: number | null; reason: string }
export interface StructuralModel {
  version: string; modelId: string; origin: DataOrigin; trainedThrough: number;
  availableAt: number; baseline: Mass[]; geometry: LinearHead; confirmation: LinearHead;
  prebreak: LinearHead | null; geometryGate: Gate; confirmationGate: Gate; prebreakGate: Gate;
  training: Episode[]; partitions: Record<string, { n: number; first: number | null; last: number | null }>;
  holdout: Array<{ origin: number; eligible: boolean; baselineBrier: number; selectedBrier: number }>;
  dataQuality: { inputBars: number; acceptedEpisodes: number; rejectedWindows: number };
}

function standardize(head: LinearHead, x: number[]): number[] {
  if (x.length !== head.mean.length || x.some(v => !Number.isFinite(v))) throw new Error("INVALID_FEATURE_SCHEMA");
  return x.map((v, i) => (v - head.mean[i]!) / head.scale[i]!);
}
export function predictHead(head: LinearHead, x: number[]): number[] {
  const z = [1, ...standardize(head, x)];
  return softmax(head.weights.map(w => w.reduce((s, v, i) => s + v * z[i]!, 0)));
}
export function fitHead(rows: Array<{ x: number[]; y: number }>, classes: number): LinearHead {
  if (!rows.length) throw new Error("NO_TRAINING_ROWS");
  const n = rows.length, d = rows[0]!.x.length;
  if (rows.some(r => r.x.length !== d || !r.x.every(Number.isFinite) || !Number.isInteger(r.y) || r.y < 0 || r.y >= classes)) throw new Error("INVALID_TRAINING_ROWS");
  const mean = Array.from({ length: d }, (_, k) => rows.reduce((s, r) => s + r.x[k]!, 0) / n);
  const scale = mean.map((m, k) => Math.max(1e-6, Math.sqrt(rows.reduce((s, r) => s + (r.x[k]! - m) ** 2, 0) / n)));
  const head: LinearHead = { mean, scale, weights: Array.from({ length: classes }, () => Array(d + 1).fill(0)) };
  const data = rows.map(r => ({ x: [1, ...standardize(head, r.x)], y: r.y }));
  // Full-batch deterministic ridge multinomial regression: parameters are fitted.
  for (let iter = 0; iter < MODEL_POLICY.iterations; iter++) {
    const gradient = head.weights.map(w => w.map(() => 0));
    for (const row of data) {
      const p = softmax(head.weights.map(w => w.reduce((s, v, k) => s + v * row.x[k]!, 0)));
      for (let c = 0; c < classes; c++) {
        const error = p[c]! - Number(row.y === c);
        for (let k = 0; k <= d; k++) gradient[c]![k]! += error * row.x[k]!;
      }
    }
    for (let c = 0; c < classes; c++) for (let k = 0; k <= d; k++) {
      head.weights[c]![k]! -= MODEL_POLICY.learningRate * (gradient[c]![k]! / n + (k ? MODEL_POLICY.ridge * head.weights[c]![k]! : 0));
    }
  }
  return head;
}

export function makeEpisodes(bars: StructuralBar[]): Episode[] {
  if (bars.length < 180) throw new Error("INSUFFICIENT_CLOSED_HISTORY");
  const episodes: Episode[] = [];
  for (let i = 120; i + 60 <= bars.length; i += MODEL_POLICY.stride) {
    // Do not bridge missing/session bars, invent timestamps or infer tick order.
    // A damaged training window is excluded and counted in the model manifest.
    try { validateBars(bars.slice(i - 120, i + 60), bars[i + 59]!.closeTime, 180); }
    catch { continue; }
    const history = bars.slice(i - 120, i), future = bars.slice(i, i + 60), origin = history.at(-1)!.closeTime;
    const f = structuralFeatures(history, origin);
    const event = observeStructure([...history, ...future]).events.find(e => e.time > origin) ?? null;
    episodes.push({ origin, history, future, features: f.values, eligible: f.eligible, event });
  }
  return episodes;
}
export function chronologicalPartitions(episodes: Episode[]): Record<"train" | "selection" | "gate" | "holdout", Episode[]> {
  const n = episodes.length;
  if (!n) return { train: [], selection: [], gate: [], holdout: [] };
  const cuts = [0, Math.floor(n * .55), Math.floor(n * .70), Math.floor(n * .85), n];
  const groups = ["train", "selection", "gate", "holdout"] as const;
  const result = {} as Record<typeof groups[number], Episode[]>;
  for (let p = 0; p < 4; p++) {
    const end = p < 3 ? episodes[cuts[p + 1]!]!.origin : Infinity;
    result[groups[p]!] = episodes.slice(cuts[p], cuts[p + 1]).filter(e => e.origin + 60 * 60_000 < end);
  }
  return result;
}
function geometryFeatures(x: number[]): number[] { return [x[0]!, x[1]!, x[11]!, x[16]!, x[17]!]; }
function timeFeatures(x: number[], minute: number): number[] { return [...x, minute / 60, (minute / 60) ** 2]; }
function hazardRows(episodes: Episode[], geometry: boolean): Array<{ x: number[]; y: number }> {
  const rows: Array<{ x: number[]; y: number }> = [];
  for (const e of episodes) {
    const minute = e.event ? (e.event.time - e.origin) / 60_000 : 61;
    for (let j = 1; j <= Math.min(60, minute); j++) rows.push({
      x: timeFeatures(geometry ? geometryFeatures(e.features) : e.features, j),
      y: j === minute ? CAUSES.indexOf(e.event!.cause) : 4,
    });
  }
  return rows;
}
function empiricalBaseline(episodes: Episode[]): Mass[] {
  return hazardsToMass(Array.from({ length: 60 }, (_, j) => {
    const risk = episodes.filter(e => !e.event || e.event.time > e.origin + j * 60_000);
    if (!risk.length) return [0, 0, 0, 0, 1];
    const counts = [.5, .5, .5, .5, .5]; // explicit Jeffreys pseudocount policy
    for (const e of risk) counts[e.event?.time === e.origin + (j + 1) * 60_000 ? CAUSES.indexOf(e.event.cause) : 4]!++;
    return counts.map(v => v / (risk.length + 2.5));
  }));
}
function hazardPrediction(head: LinearHead, features: number[], geometry: boolean): Mass[] {
  const x = geometry ? geometryFeatures(features) : features;
  return hazardsToMass(Array.from({ length: 60 }, (_, j) => predictHead(head, timeFeatures(x, j + 1))));
}
const truth = (e: Episode, h: number) => scenarioIndex(scenarioOf(e.event && e.event.time <= e.origin + h * 60_000 ? e.event : null));
const rejected = (reason: string): Gate => ({ accepted: false, blend: 0, selectedBlend: 0, n: 0, gain: null, lowerGain: null, reason });

/** Deterministic moving-block bootstrap accounts for overlapping 60m labels.
 * It is an evidence screen, not a guarantee of market edge. */
export function lowerMeanGain(gains: number[]): number {
  if (!gains.length) return -Infinity;
  let seed = 672026;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const means: number[] = [];
  const block = Math.ceil(60 / MODEL_POLICY.stride);
  for (let b = 0; b < MODEL_POLICY.bootstrapReplicates; b++) {
    let total = 0, count = 0;
    while (count < gains.length) {
      const start = Math.floor(random() * gains.length);
      for (let j = 0; j < block && count < gains.length; j++, count++) total += gains[(start + j) % gains.length]!;
    }
    means.push(total / gains.length);
  }
  means.sort((a, b) => a - b);
  return means[Math.floor(means.length * .025)]!;
}
function mixMass(a: Mass[], b: Mass[], w: number, terminalPreserving: boolean): Mass[] {
  return terminalPreserving ? reallocateEarly(a, b, w) : a.map((r, j) => r.map((v, k) => (1 - w) * v + w * b[j]![k]!) as Mass);
}
function chooseBlend(selection: Episode[], base: (e: Episode) => Mass[], candidate: (e: Episode) => Mass[], horizon: number, terminalPreserving: boolean): number {
  if (selection.length < MODEL_POLICY.minGate) return 0;
  const candidates = selection.map(e => ({ e, a: base(e), b: candidate(e) }));
  let blend = 0, best = Infinity;
  for (const w of MODEL_POLICY.blends) {
    const loss = candidates.reduce((s, { e, a, b }) => s + brier(probabilities(mixMass(a, b, w, terminalPreserving), horizon), truth(e, horizon)), 0) / candidates.length;
    if (loss < best - 1e-12) { best = loss; blend = w; }
  }
  return blend;
}
function chooseGate(gate: Episode[], base: (e: Episode) => Mass[], candidate: (e: Episode) => Mass[], horizon: number, terminalPreserving: boolean, blend: number): Gate {
  if (gate.length < MODEL_POLICY.minGate) return { ...rejected("INSUFFICIENT_INDEPENDENT_GATE_SAMPLES"), selectedBlend: blend };
  if (!blend) return { ...rejected("SELECTION_RETAINED_BASELINE"), n: gate.length };
  const gains = gate.map(e => {
    const a = base(e), b = candidate(e), y = truth(e, horizon);
    return brier(probabilities(a, horizon), y) - brier(probabilities(mixMass(a, b, blend, terminalPreserving), horizon), y);
  });
  const gain = gains.reduce((a, b) => a + b, 0) / gains.length, lowerGain = lowerMeanGain(gains);
  const accepted = lowerGain > MODEL_POLICY.minimumGain;
  return { accepted, blend: accepted ? blend : 0, selectedBlend: blend, n: gains.length, gain, lowerGain,
    reason: accepted ? "INDEPENDENT_GATE_ACCEPTED" : "INDEPENDENT_GATE_REJECTED" };
}
function baseFor(model: StructuralModel, features: number[]): Mass[] {
  if (!model.geometryGate.accepted) return model.baseline.map(r => [...r] as Mass);
  const candidate = hazardPrediction(model.geometry, features, true), w = model.geometryGate.blend;
  return model.baseline.map((r, j) => r.map((v, k) => (1 - w) * v + w * candidate[j]![k]!) as Mass);
}
function outOfDistribution(head: LinearHead, features: number[]): boolean {
  return standardize(head, features).some(x => Math.abs(x) > MODEL_POLICY.oodZ);
}
function predictUnconstrainedMass(model: StructuralModel, features: number[], eligible: boolean, quarantined = false): { mass: Mass[]; baseline: Mass[]; mode: StructuralForecast["mode"]; reason: string } {
  const empirical = model.baseline.map(r => [...r] as Mass);
  if (quarantined) return { mass: empirical, baseline: empirical, mode: "BASELINE", reason: "PERFORMANCE_QUARANTINE" };
  // Screen against training transform; time coordinates are within training support.
  if (outOfDistribution(model.confirmation, timeFeatures(features, 1))) return { mass: empirical, baseline: empirical, mode: "BASELINE", reason: "OUT_OF_DISTRIBUTION" };
  const base = baseFor(model, features);
  const confirmation = model.confirmationGate.accepted
    ? reallocateEarly(base, hazardPrediction(model.confirmation, features, false), model.confirmationGate.blend) : base;
  if (!eligible) return { mass: confirmation, baseline: empirical, mode: model.confirmationGate.accepted ? "POST_PRECURSOR" : "BASELINE", reason: "OBSERVED_FIRST_CLOSE_PRECURSOR" };
  if (model.prebreak && model.prebreakGate.accepted && !outOfDistribution(model.prebreak, features)) {
    return { mass: reallocateEarly(confirmation, prebreakCandidate(confirmation, predictHead(model.prebreak, features) as Triple), model.prebreakGate.blend),
      baseline: empirical, mode: "PREBREAK", reason: model.prebreakGate.reason };
  }
  return { mass: confirmation, baseline: empirical, mode: "BASELINE", reason: model.prebreakGate.reason };
}

export function predictMass(model: StructuralModel, features: number[], eligible: boolean, quarantined = false) {
  const prediction = predictUnconstrainedMass(model, features, eligible, quarantined);
  if (!eligible) return prediction;
  // Without an observed first-close precursor, a two-close confirmation cannot
  // occur at +1. Move that mass to the earliest feasible +2 bar. This retains
  // every subtype marginal and all reported horizons from 3m onward.
  const support = (mass: Mass[]) => mass.map((row, j) => row.map((v, k) =>
    j === 0 ? 0 : j === 1 ? v + mass[0]![k]! : v) as Mass);
  return { ...prediction, mass: support(prediction.mass), baseline: support(prediction.baseline) };
}

export function fitStructuralModel(bars: StructuralBar[], origin: DataOrigin): StructuralModel {
  const episodes = makeEpisodes(bars), parts = chronologicalPartitions(episodes);
  if (parts.train.length < MODEL_POLICY.minTraining) throw new Error("INSUFFICIENT_TRAINING_HISTORY");
  const trainedThrough = parts.train.at(-1)!.future.at(-1)!.closeTime;
  const model: StructuralModel = {
    version: STRUCTURAL_VERSION, modelId: `${STRUCTURAL_VERSION}:${origin.provider}:${origin.symbol}:${trainedThrough}`,
    origin, trainedThrough, availableAt: parts.gate.at(-1)?.future.at(-1)?.closeTime ?? trainedThrough,
    baseline: empiricalBaseline(parts.train), geometry: fitHead(hazardRows(parts.train, true), 5),
    confirmation: fitHead(hazardRows(parts.train, false), 5), prebreak: null,
    geometryGate: rejected("NOT_EVALUATED"), confirmationGate: rejected("NOT_EVALUATED"), prebreakGate: rejected("NOT_EVALUATED"),
    training: parts.train, partitions: {}, holdout: [],
    dataQuality: { inputBars: bars.length, acceptedEpisodes: episodes.length,
      rejectedWindows: Math.max(0, Math.floor((bars.length - 180) / MODEL_POLICY.stride) + 1 - episodes.length) },
  };
  for (const [name, eps] of Object.entries(parts)) model.partitions[name] = { n: eps.length, first: eps[0]?.origin ?? null, last: eps.at(-1)?.origin ?? null };
  // Freeze EVERY blend from selection before consulting ANY acceptance labels.
  // This prevents an earlier head's acceptance result leaking into selection of
  // a later head. These provisional flags never leave this fitting function.
  const geometryBlend = chooseBlend(parts.selection, () => model.baseline, e => hazardPrediction(model.geometry, e.features, true), 60, false);
  model.geometryGate = { ...rejected("SELECTION_ONLY"), accepted: geometryBlend > 0, blend: geometryBlend };
  const confirmationBlend = chooseBlend(parts.selection, e => baseFor(model, e.features), e => hazardPrediction(model.confirmation, e.features, false), 5, true);
  model.confirmationGate = { ...rejected("SELECTION_ONLY"), accepted: confirmationBlend > 0, blend: confirmationBlend };
  const confirmationBase = (e: Episode) => {
    const b = baseFor(model, e.features);
    return model.confirmationGate.accepted ? reallocateEarly(b, hazardPrediction(model.confirmation, e.features, false), model.confirmationGate.blend) : b;
  };
  let prebreakBlend = 0;
  const eligible = parts.train.filter(e => e.eligible);
  if (eligible.length >= MODEL_POLICY.minTraining) {
    model.prebreak = fitHead(eligible.map(e => ({ x: e.features, y: truth(e, 5) })), 3);
    prebreakBlend = chooseBlend(parts.selection.filter(e => e.eligible), confirmationBase,
      e => prebreakCandidate(confirmationBase(e), predictHead(model.prebreak!, e.features) as Triple), 5, true);
  } else model.prebreakGate = rejected("INSUFFICIENT_PREBREAK_TRAINING");
  model.geometryGate = chooseGate(parts.gate, () => model.baseline, e => hazardPrediction(model.geometry, e.features, true), 60, false, geometryBlend);
  model.confirmationGate = chooseGate(parts.gate, e => baseFor(model, e.features), e => hazardPrediction(model.confirmation, e.features, false), 5, true, confirmationBlend);
  if (model.prebreak) model.prebreakGate = chooseGate(parts.gate.filter(e => e.eligible), confirmationBase,
    e => prebreakCandidate(confirmationBase(e), predictHead(model.prebreak!, e.features) as Triple), 5, true, prebreakBlend);
  // Untouched holdout is diagnostic only. No model/threshold writes below here.
  model.holdout = parts.holdout.map(e => {
    const p = predictMass(model, e.features, e.eligible), y = truth(e, 5);
    return { origin: e.origin, eligible: e.eligible, baselineBrier: brier(probabilities(p.baseline, 5), y), selectedBrier: brier(probabilities(p.mass, 5), y) };
  });
  return model;
}

export function ghostPaths(model: StructuralModel, history: StructuralBar[], mass: Mass[]): GhostPath[] {
  const asOf = history.at(-1)!.closeTime, start = history.at(-1)!.close;
  const buckets: StructuralBar[][][] = [[], [], []];
  const ends: number[][] = [[], [], []];
  for (const e of model.training) {
    if (e.future.at(-1)!.closeTime > model.trainedThrough || e.future.at(-1)!.closeTime >= asOf) continue;
    const ratio = start / e.history.at(-1)!.close;
    const path = e.future.map((b, j) => ({ ...b, openTime: asOf + j * 60_000, closeTime: asOf + (j + 1) * 60_000,
      open: b.open * ratio, high: b.high * ratio, low: b.low * ratio, close: b.close * ratio }));
    const event = observeStructure([...history, ...path]).events.find(x => x.time > asOf);
    const index = scenarioIndex(scenarioOf(event));
    buckets[index]!.push(path); ends[index]!.push(e.future.at(-1)!.closeTime);
  }
  const p = probabilities(mass, 60);
  return (["UP_FIRST", "DOWN_FIRST", "NEITHER"] as const).map((scenario, i) => {
    const ranked = buckets[i]!.map((path, k) => ({ path, end: ends[i]![k]!, close: path.at(-1)!.close }))
      .sort((a, b) => a.close - b.close);
    const selected = ranked[Math.floor(ranked.length / 2)];
    return { scenario, probability: p[i]!, label: "ILLUSTRATIVE_TRAINING_PATH", sourceEnd: selected?.end ?? null,
      candles: selected?.path ?? [], unavailableReason: selected ? null : "NO_CLASS_MATCHING_TRAINING_PATH" };
  });
}
export function forecastStructural(model: StructuralModel, history: StructuralBar[], origin: DataOrigin, quarantined = false): StructuralForecast {
  const asOf = history.at(-1)?.closeTime ?? NaN;
  validateBars(history, asOf);
  if (asOf < model.availableAt || origin.symbol !== model.origin.symbol || origin.provider !== model.origin.provider) throw new Error("MODEL_PROVENANCE_OR_TIME_MISMATCH");
  const h = history.slice(-120), features = structuralFeatures(h, asOf);
  const prediction = predictMass(model, features.values, features.eligible, quarantined);
  return { version: model.version, modelId: model.modelId, asOf, origin, trainedThrough: model.trainedThrough,
    featureVersion: `${model.version}:features-1`, eventDefinitionVersion: `${model.version}:events-1`,
    features: features.values, preBreakEligible: features.eligible, mode: prediction.mode, gateReason: prediction.reason,
    validation: "NOT_YET_VALIDATED", mass: prediction.mass, baselineMass: prediction.baseline,
    horizons: horizonsFromMass(prediction.mass), paths: ghostPaths(model, h, prediction.mass), history: h,
    executionAuthority: "NONE" };
}
