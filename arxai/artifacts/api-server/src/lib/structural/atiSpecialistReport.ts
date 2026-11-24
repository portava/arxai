import {
  ATI_SPECIALIST_VERSION, ATI_STRUCTURAL_VALIDATION, MODEL_POLICY, brier, calibrationBins,
  forecastHorizonBars, forecastHorizonId, forecastStepMs, hasAtiStructuralScope, independentForecasts,
  scenarioIndex, specialistIds, specialistPool, type SpecialistReceipt, type Triple,
} from "@workspace/domain/structural";
import { STRUCTURAL_HISTORY_LIMIT, type StoredForecast } from "./service.js";

const minute = 60_000;
const windowBars = 15;
export type SpecialistSample = { row: StoredForecast; specialist: SpecialistReceipt; incumbent: Triple; outcome: number; pool: Triple };

function probability(value: unknown): value is Triple {
  return Array.isArray(value) && value.length === 3 &&
    value.every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
    Math.abs(value[0] + value[1] + value[2] - 1) < 1e-8;
}

function receiptValid(row: StoredForecast, s: SpecialistReceipt): boolean {
  const f = row.forecast;
  return s.version === ATI_SPECIALIST_VERSION && s.target === "FIRST_STRUCTURAL_BREAK_15_M1" &&
    s.modelId === f.modelId && s.symbol === f.origin.symbol && s.provider === f.origin.provider &&
    s.asOf === f.asOf && Number.isFinite(s.trainedThrough) && s.trainedThrough <= f.trainedThrough &&
    f.trainedThrough < f.asOf && Number.isInteger(s.trainedWindows) && s.trainedWindows >= MODEL_POLICY.minTraining &&
    ["UP", "DOWN", "UNESTABLISHED"].includes(s.trend) && probability(s.frequency) &&
    specialistIds.every(id => probability(s.probabilities?.[id]));
}

function mean(samples: SpecialistSample[], value: (sample: SpecialistSample) => number) {
  if (!samples.length) return null;
  return samples.reduce((sum, sample) => sum + value(sample), 0) / samples.length;
}

function summarize(samples: SpecialistSample[]) {
  const loss = (get: (s: SpecialistSample) => Triple) => mean(samples, s => brier(get(s), s.outcome));
  const gain = (baseline: (s: SpecialistSample) => Triple) =>
    mean(samples, s => brier(baseline(s), s.outcome) - brier(s.pool, s.outcome));
  return {
    windows: samples.length,
    poolBrier: loss(s => s.pool), incumbentBrier: loss(s => s.incumbent), frequencyBrier: loss(s => s.specialist.frequency),
    gainOverIncumbent: gain(s => s.incumbent), gainOverFrequency: gain(s => s.specialist.frequency),
    specialists: specialistIds.map(id => ({
      id, standaloneBrier: loss(s => s.specialist.probabilities[id]),
      standaloneGainOverFrequency: mean(samples, s => brier(s.specialist.frequency, s.outcome) - brier(s.specialist.probabilities[id], s.outcome)),
      poolWithoutBrier: loss(s => specialistPool(s.specialist, id)), gainFromIncluding: gain(s => specialistPool(s.specialist, id)),
    })),
  };
}

function cohort(rows: StoredForecast[]) {
  const first = rows[0]!.forecast;
  // Reserve entire windows before inspecting the receipt or outcome, even for legacy anchors.
  const anchors = independentForecasts([...rows].sort((a, b) => a.id.localeCompare(b.id)).map(row => ({
    row, asOf: row.forecast.asOf, update: Boolean(row.forecast.update),
  })), windowBars * minute);
  let missingSpecialists = 0, invalidEvidence = 0, unresolved = 0;
  const samples: SpecialistSample[] = [];
  for (const { row, asOf } of anchors) {
    const s = row.forecast.atiSpecialists;
    if (!s) { missingSpecialists++; continue; }
    const incumbent = row.forecast.horizons.find(h => h.bars === windowBars)?.probabilities;
    if (!receiptValid(row, s) || !probability(incumbent) || row.recordedAt == null || row.recordedAt < row.issuedAt ||
        ![row.issuedAt, row.recordedAt].every(t => Number.isFinite(t) && t >= asOf && t < asOf + minute)) {
      invalidEvidence++;
      continue;
    }
    const score = row.scores.find(v => v.horizon === windowBars);
    if (!score) { unresolved++; continue; }
    if (score.observedThrough !== asOf + windowBars * minute || score.atiValidation?.version !== ATI_STRUCTURAL_VALIDATION ||
        !["UP_FIRST", "DOWN_FIRST", "NEITHER"].includes(score.outcome)) { invalidEvidence++; continue; }
    samples.push({ row, specialist: s, incumbent, outcome: scenarioIndex(score.outcome), pool: specialistPool(s) });
  }
  return {
    symbol: first.origin.symbol, provider: first.origin.provider, sourceKind: first.origin.kind, forecastVersion: first.version,
    featureVersion: first.featureVersion, eventDefinitionVersion: first.eventDefinitionVersion,
    receipts: rows.length, anchors: anchors.length, overlappingOrUpdates: rows.length - anchors.length,
    missingSpecialists, invalidEvidence, unresolved, samples,
  };
}

function render(group: ReturnType<typeof cohort>) {
  const { samples, ...coverage } = group;
  return {
    ...coverage, paired: summarize(samples),
    specialistReliability: specialistIds.map(id => ({ id,
      bins: calibrationBins(samples.map(s => ({ p: s.specialist.probabilities[id], outcome: s.outcome }))),
    })),
    poolReliability: calibrationBins(samples.map(s => ({ p: s.pool, outcome: s.outcome }))),
    byTrend: (["UP", "DOWN", "UNESTABLISHED"] as const).map(trend => ({
      trend, ...summarize(samples.filter(s => s.specialist.trend === trend)),
    })),
  };
}

export function selectAtiSpecialists(rows: readonly StoredForecast[]) {
  const groups = new Map<string, StoredForecast[]>();
  let outsideScope = 0, invalidOriginTime = 0;
  for (const row of rows) {
    const f = row.forecast;
    if (!hasAtiStructuralScope(f) || forecastHorizonId(f) !== "15m" || forecastStepMs(f) !== minute ||
        forecastHorizonBars(f) !== windowBars) { outsideScope++; continue; }
    if (!Number.isFinite(f.asOf)) { invalidOriginTime++; continue; }
    const key = JSON.stringify([f.origin.symbol, f.origin.provider, f.origin.kind, f.version, f.featureVersion, f.eventDefinitionVersion]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return {
    version: ATI_SPECIALIST_VERSION, target: "FIRST_STRUCTURAL_BREAK_15_M1", executionAuthority: "NONE",
    historyLimit: STRUCTURAL_HISTORY_LIMIT, receiptsRead: rows.length, atHistoryLimit: rows.length >= STRUCTURAL_HISTORY_LIMIT,
    outsideScope, invalidOriginTime, cohorts: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, values]) => cohort(values)),
  };
}

export function reportAtiSpecialists(rows: readonly StoredForecast[]) {
  const selected = selectAtiSpecialists(rows);
  return { ...selected, cohorts: selected.cohorts.map(render) };
}
