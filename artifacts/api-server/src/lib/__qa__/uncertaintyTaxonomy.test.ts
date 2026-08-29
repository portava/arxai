// Capability #2 — explicit uncertainty taxonomy + calibration curves.
//
// Locked here:
//   * Every one of the seven UNCERTAINTY_CONFIDENCE channels maps to exactly
//     one taxonomy class (data/model/regime/execution/portfolio/operational);
//     `portfolio` — which no channel measures today — reports a typed
//     NO_CHANNEL_EVIDENCE, never a fabricated 0.
//   * The taxonomy is a pure re-grouping: the class-weighted penalty total is
//     IDENTICAL to the master formula's penalty budget, so the taxonomy can
//     never disagree with UNCERTAINTY_CONFIDENCE.
//   * Calibration curves come ONLY from resolution records: below the minimum
//     the result is an honest INSUFFICIENT_HISTORY; thin bins report
//     empiricalRate null and are excluded from the ECE; junk records are
//     dropped, never clamped into evidence.
//
// Run: pnpm --filter @workspace/api-server run test:uncertainty-taxonomy

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AACI_CHANNEL_TAXONOMY,
  AACI_UNCERTAINTY_CHANNEL_WEIGHTS,
  CALIBRATION_MIN_BIN_SAMPLES,
  CALIBRATION_MIN_TOTAL_SAMPLES,
  UNCERTAINTY_TAXONOMY_CLASSES,
  computeCalibrationCurve,
  decomposeUncertaintyTaxonomy,
  uncertaintyConfidenceFromChannels,
  type AaciUncertaintyChannelName,
  type AaciUncertaintyChannels,
  type CalibrationRecord,
} from "@workspace/domain/aaci";

const CHANNELS = Object.keys(
  AACI_UNCERTAINTY_CHANNEL_WEIGHTS,
) as AaciUncertaintyChannelName[];

function channels(over: Partial<AaciUncertaintyChannels> = {}): AaciUncertaintyChannels {
  const base = {} as AaciUncertaintyChannels;
  for (const c of CHANNELS) base[c] = 0;
  return { ...base, ...over };
}

// ── Taxonomy mapping ────────────────────────────────────────────────────────

test("every channel maps to exactly one of the six taxonomy classes", () => {
  for (const c of CHANNELS) {
    const cls = AACI_CHANNEL_TAXONOMY[c];
    assert.ok(UNCERTAINTY_TAXONOMY_CLASSES.includes(cls), `${c} → ${cls}`);
  }
  // The canonical assignments (spot-pinned so a silent remap fails the build).
  assert.equal(AACI_CHANNEL_TAXONOMY.missingData, "data");
  assert.equal(AACI_CHANNEL_TAXONOMY.lowSampleHistory, "data");
  assert.equal(AACI_CHANNEL_TAXONOMY.modelDisagreement, "model");
  assert.equal(AACI_CHANNEL_TAXONOMY.conflictingSignals, "model");
  assert.equal(AACI_CHANNEL_TAXONOMY.newsChaos, "regime");
  assert.equal(AACI_CHANNEL_TAXONOMY.spreadInstability, "execution");
  assert.equal(AACI_CHANNEL_TAXONOMY.staleLearning, "operational");
});

test("portfolio class reports NO_CHANNEL_EVIDENCE, never a fabricated zero", () => {
  const d = decomposeUncertaintyTaxonomy(channels());
  assert.equal(d.portfolio.status, "NO_CHANNEL_EVIDENCE");
  assert.equal(d.portfolio.severity01, null);
  assert.equal(d.portfolio.channels.length, 0);
});

test("decomposition preserves the master penalty budget exactly", () => {
  const ch = channels({
    missingData: 0.4,
    conflictingSignals: 0.7,
    lowSampleHistory: 1,
    newsChaos: 0.6,
    spreadInstability: 0.3,
    modelDisagreement: 0.7,
    staleLearning: 0.9,
  });
  const d = decomposeUncertaintyTaxonomy(ch);
  let classBudget = 0;
  for (const cls of UNCERTAINTY_TAXONOMY_CLASSES) {
    const r = d[cls];
    if (r.status === "MEASURED") classBudget += r.weight * r.severity01;
  }
  const masterBudget = 1 - uncertaintyConfidenceFromChannels(ch);
  assert.ok(Math.abs(classBudget - masterBudget) < 1e-12,
    `class budget ${classBudget} != master ${masterBudget}`);
});

test("class severity is the weight-weighted mean of its channels", () => {
  const d = decomposeUncertaintyTaxonomy(channels({ missingData: 1, lowSampleHistory: 0 }));
  // data = {missingData w=0.25 p=1, lowSampleHistory w=0.15 p=0}
  const expected = (0.25 * 1 + 0.15 * 0) / (0.25 + 0.15);
  assert.equal(d.data.status, "MEASURED");
  if (d.data.status === "MEASURED") {
    assert.ok(Math.abs(d.data.severity01 - expected) < 1e-12);
    assert.equal(d.data.channels.length, 2);
  }
});

// ── Calibration curves ──────────────────────────────────────────────────────

function records(n: number, conf: number, goodRate: number): CalibrationRecord[] {
  const out: CalibrationRecord[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ statedConfidence01: conf, outcomeGood: i / n < goodRate });
  }
  return out;
}

test("below the record minimum the curve is an honest INSUFFICIENT_HISTORY", () => {
  const curve = computeCalibrationCurve(records(CALIBRATION_MIN_TOTAL_SAMPLES - 1, 0.7, 0.7));
  assert.equal(curve.status, "INSUFFICIENT_HISTORY");
  if (curve.status === "INSUFFICIENT_HISTORY") {
    assert.equal(curve.samples, CALIBRATION_MIN_TOTAL_SAMPLES - 1);
    assert.equal(curve.requiredSamples, CALIBRATION_MIN_TOTAL_SAMPLES);
  }
});

test("a well-calibrated record set yields OK with a small ECE", () => {
  const recs = [
    ...records(60, 0.75, 0.75),
    ...records(60, 0.25, 0.25),
  ];
  const curve = computeCalibrationCurve(recs);
  assert.equal(curve.status, "OK");
  if (curve.status === "OK") {
    assert.ok(curve.expectedCalibrationError < 0.02, `ECE ${curve.expectedCalibrationError}`);
    assert.equal(curve.samples, 120);
    assert.equal(curve.qualifyingBins, 2);
  }
});

test("a miscalibrated record set is reported with a large ECE, not smoothed", () => {
  // States 0.9 confidence, delivers 0.3.
  const curve = computeCalibrationCurve(records(100, 0.9, 0.3));
  assert.equal(curve.status, "OK");
  if (curve.status === "OK") {
    assert.ok(curve.expectedCalibrationError > 0.5, `ECE ${curve.expectedCalibrationError}`);
  }
});

test("thin bins report empiricalRate null and are excluded from the ECE", () => {
  const recs = [
    ...records(80, 0.85, 0.85),
    ...records(CALIBRATION_MIN_BIN_SAMPLES - 1, 0.15, 1), // wildly off, but thin
  ];
  const curve = computeCalibrationCurve(recs);
  assert.equal(curve.status, "OK");
  if (curve.status === "OK") {
    const thinBin = curve.bins.find((b) => b.lo === 0.1);
    assert.ok(thinBin);
    assert.equal(thinBin!.samples, CALIBRATION_MIN_BIN_SAMPLES - 1);
    assert.equal(thinBin!.empiricalRate, null);
    // The thin, miscalibrated bin must not drag the ECE.
    assert.ok(curve.expectedCalibrationError < 0.02);
  }
});

test("records spread too thin for ANY bin → INSUFFICIENT_HISTORY with reason", () => {
  // 60 records spread evenly across 10 bins → 6 per bin < minBinSamples(10).
  const recs: CalibrationRecord[] = [];
  for (let bin = 0; bin < 10; bin++) {
    for (let i = 0; i < 6; i++) {
      recs.push({ statedConfidence01: bin / 10 + 0.05, outcomeGood: i % 2 === 0 });
    }
  }
  const curve = computeCalibrationCurve(recs);
  assert.equal(curve.status, "INSUFFICIENT_HISTORY");
  if (curve.status === "INSUFFICIENT_HISTORY") {
    assert.match(curve.reason, /no bin reaches/);
  }
});

test("junk records (NaN / out-of-range confidence) are dropped, not clamped", () => {
  const junk: CalibrationRecord[] = [
    { statedConfidence01: Number.NaN, outcomeGood: true },
    { statedConfidence01: 1.5, outcomeGood: true },
    { statedConfidence01: -0.1, outcomeGood: true },
  ];
  const curve = computeCalibrationCurve([...records(30, 0.7, 0.7), ...junk]);
  assert.equal(curve.status, "INSUFFICIENT_HISTORY");
  if (curve.status === "INSUFFICIENT_HISTORY") {
    assert.equal(curve.samples, 30); // junk never counted as evidence
  }
});
