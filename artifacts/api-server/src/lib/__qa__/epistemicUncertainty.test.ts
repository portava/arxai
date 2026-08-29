// Epistemic layer — uncertainty channels (#2) + value-of-information (#6).
//
// Locked here:
//   * The three measured uncertainty channels (lowSampleHistory,
//     spreadInstability, staleLearning) are REAL functions of their inputs —
//     no longer hard-coded 0 — and FAIL CLOSED: a missing/unreadable input
//     yields the channel's FULL penalty, never a fabricated 0.
//   * UNCERTAINTY_CONFIDENCE remains a 0–1 multiplier that only ever REDUCES
//     the master score: full evidence gives the ceiling; missing evidence
//     gives strictly less; nothing pushes it above the no-penalty ceiling.
//   * buildScoreBreakdown threads the evidence through (per-channel cases).
//   * VOI: resolution rates come ONLY from recorded observation pairs; thin
//     history is an honest INSUFFICIENT_HISTORY, never a made-up rate; the
//     WAIT_FOR_EVIDENCE advisory fires exactly when the expected uncertainty
//     reduction exceeds the measured entry-decay cost of waiting.
//   * The in-process recorders refuse degenerate quotes and report null /
//     zero pairs before they have real history (fail-closed upstream).
//
// IO-free: pure domain + the in-process recorders. Offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:epistemic-uncertainty

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AACI_LEARNING_STALE_MS,
  AACI_SPREAD_MIN_SAMPLES,
  AACI_UNCERTAINTY_CHANNEL_WEIGHTS,
  AACI_UNCERTAINTY_FULL_SAMPLE_COUNT,
  buildScoreBreakdown,
  computeFreshness,
  computeMasterScore,
  computeUncertaintyChannels,
  computeUncertaintyConfidence,
  computeWaitAdvisory,
  detectConflictsAndCohesion,
  estimateChannelResolutionRates,
  lowSampleHistoryPenalty,
  spreadInstabilityPenalty,
  staleLearningPenalty,
  type AaciChannelResolutionPair,
  type AaciSharedTruthSnapshot,
  type AaciUncertaintyChannels,
  type AaciUncertaintyEvidence,
} from "@workspace/domain/aaci";
import {
  clearSpreadHistory,
  getSpreadRelHistory,
  recordSpreadSample,
} from "../aaci/spreadHistoryRecorder.js";
import {
  clearResolutionRecorder,
  getResolutionPairs,
  recordUncertaintyObservation,
} from "../aaci/uncertaintyResolutionRecorder.js";

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

function makeSnapshot(over: Partial<AaciSharedTruthSnapshot> = {}): AaciSharedTruthSnapshot {
  return {
    snapshotId: "snap-1",
    timestamp: new Date(NOW).toISOString(),
    user: { userId: "u1", role: "user" },
    symbolContext: {},
    account: { mode: "demo", lastUpdated: new Date(NOW).toISOString() },
    bridge: { status: "connected" },
    positions: { openCount: 0, lastUpdated: new Date(NOW).toISOString() },
    ...over,
  };
}

const FULL_EVIDENCE: AaciUncertaintyEvidence = {
  outcomeSampleCount: AACI_UNCERTAINTY_FULL_SAMPLE_COUNT,
  spreadRelHistory: [0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001],
  learningAgeMs: 0,
};

// ── #2 per-channel cases ────────────────────────────────────────────────────

test("lowSampleHistory: fail-closed on missing, linear down to 0 at full count", () => {
  assert.equal(lowSampleHistoryPenalty(null), 1);
  assert.equal(lowSampleHistoryPenalty(undefined), 1);
  assert.equal(lowSampleHistoryPenalty(Number.NaN), 1);
  assert.equal(lowSampleHistoryPenalty(-1), 1);
  assert.equal(lowSampleHistoryPenalty(0), 1);
  assert.equal(lowSampleHistoryPenalty(AACI_UNCERTAINTY_FULL_SAMPLE_COUNT / 2), 0.5);
  assert.equal(lowSampleHistoryPenalty(AACI_UNCERTAINTY_FULL_SAMPLE_COUNT), 0);
  assert.equal(lowSampleHistoryPenalty(AACI_UNCERTAINTY_FULL_SAMPLE_COUNT * 10), 0);
});

test("spreadInstability: fail-closed on missing/thin/degenerate history", () => {
  assert.equal(spreadInstabilityPenalty(null), 1);
  assert.equal(spreadInstabilityPenalty(undefined), 1);
  assert.equal(spreadInstabilityPenalty([]), 1);
  // Below the minimum sample count → fail closed.
  assert.equal(spreadInstabilityPenalty(Array(AACI_SPREAD_MIN_SAMPLES - 1).fill(0.0001)), 1);
  // Non-finite garbage does not count as samples.
  assert.equal(spreadInstabilityPenalty([NaN, Infinity, -1, 0.0001, 0.0001]), 1);
  // All-zero spread series is not credible market evidence.
  assert.equal(spreadInstabilityPenalty([0, 0, 0, 0, 0, 0]), 1);
});

test("spreadInstability: stable spreads → ~0 penalty; wild spreads → high penalty", () => {
  const stable = spreadInstabilityPenalty([0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001]);
  assert.equal(stable, 0);
  const wild = spreadInstabilityPenalty([0.0001, 0.0009, 0.0001, 0.001, 0.00005, 0.0012]);
  assert.ok(wild > 0.5, `wild spread history should carry a heavy penalty, got ${wild}`);
  assert.ok(wild <= 1);
  // Monotone sanity: the wild series is strictly worse than the stable one.
  assert.ok(wild > stable);
});

test("staleLearning: fail-closed on missing, fresh → 0, saturates at the stale horizon", () => {
  assert.equal(staleLearningPenalty(null), 1);
  assert.equal(staleLearningPenalty(undefined), 1);
  assert.equal(staleLearningPenalty(Number.NaN), 1);
  assert.equal(staleLearningPenalty(0), 0);
  assert.equal(staleLearningPenalty(-5_000), 0); // clock skew treated as fresh
  assert.equal(staleLearningPenalty(AACI_LEARNING_STALE_MS / 2), 0.5);
  assert.equal(staleLearningPenalty(AACI_LEARNING_STALE_MS), 1);
  assert.equal(staleLearningPenalty(AACI_LEARNING_STALE_MS * 3), 1);
});

// ── #2 composition: fail-closed + only-ever-reduces ─────────────────────────

test("uncertaintyConfidence: missing evidence is strictly WORSE than full evidence (fail-closed)", () => {
  const snapshot = makeSnapshot();
  const cohesion = detectConflictsAndCohesion(snapshot);
  const withFull = computeUncertaintyConfidence(snapshot, cohesion, FULL_EVIDENCE);
  const withNone = computeUncertaintyConfidence(snapshot, cohesion); // no evidence at all
  const w = AACI_UNCERTAINTY_CHANNEL_WEIGHTS;
  assert.equal(withFull, 1); // clean snapshot + full evidence = no penalty
  // All three measured channels at full penalty:
  const expected = 1 - (w.lowSampleHistory + w.spreadInstability + w.staleLearning);
  assert.ok(Math.abs(withNone - expected) < 1e-12, `expected ${expected}, got ${withNone}`);
  assert.ok(withNone < withFull);
});

test("uncertaintyConfidence: evidence can only reduce, never exceed the no-penalty ceiling", () => {
  const snapshot = makeSnapshot({ news: { riskLevel: "critical" } });
  const cohesion = detectConflictsAndCohesion(snapshot);
  const ceiling = computeUncertaintyConfidence(makeSnapshot(), detectConflictsAndCohesion(makeSnapshot()), FULL_EVIDENCE);
  for (const evidence of [
    FULL_EVIDENCE,
    undefined,
    { outcomeSampleCount: 1e9, spreadRelHistory: Array(50).fill(0.0001), learningAgeMs: -1e9 } as AaciUncertaintyEvidence,
  ]) {
    const v = computeUncertaintyConfidence(snapshot, cohesion, evidence);
    assert.ok(v >= 0 && v <= 1);
    assert.ok(v <= ceiling, "no evidence shape may push confidence above the clean ceiling");
  }
});

test("buildScoreBreakdown threads uncertaintyEvidence through to the master score", () => {
  const snapshot = makeSnapshot();
  const freshness = computeFreshness(snapshot, NOW);
  const cohesion = detectConflictsAndCohesion(snapshot);
  const base = { snapshot, freshness, cohesion, latencyRecords: [], speedValidity: 1 };
  const withFull = buildScoreBreakdown({ ...base, uncertaintyEvidence: FULL_EVIDENCE });
  const withNone = buildScoreBreakdown(base);
  assert.ok(withNone.uncertaintyConfidence < withFull.uncertaintyConfidence);
  // The reduction propagates multiplicatively into the master score.
  const scoreFull = computeMasterScore(withFull, 1);
  const scoreNone = computeMasterScore(withNone, 1);
  assert.ok(scoreNone < scoreFull, "missing evidence must reduce the final score");
});

// ── #6 VOI: honest rates + wait-vs-act ──────────────────────────────────────

function pairsFor(channel: AaciChannelResolutionPair["channel"], n: number, resolvedFraction: number): AaciChannelResolutionPair[] {
  const out: AaciChannelResolutionPair[] = [];
  const resolved = Math.round(n * resolvedFraction);
  for (let i = 0; i < n; i++) {
    out.push({ channel, penaltyBefore: 0.8, penaltyAfter: i < resolved ? 0.1 : 0.8 });
  }
  return out;
}

function channelsWith(over: Partial<AaciUncertaintyChannels>): AaciUncertaintyChannels {
  return {
    missingData: 0,
    conflictingSignals: 0,
    lowSampleHistory: 0,
    newsChaos: 0,
    spreadInstability: 0,
    modelDisagreement: 0,
    staleLearning: 0,
    ...over,
  };
}

test("resolution rates: thin history is INSUFFICIENT_HISTORY, never a made-up number", () => {
  const rates = estimateChannelResolutionRates(pairsFor("spreadInstability", 5, 1));
  assert.equal(rates.spreadInstability.status, "INSUFFICIENT_HISTORY");
  assert.equal((rates.spreadInstability as { samples: number }).samples, 5);
  // A channel with zero history is also insufficient.
  assert.equal(rates.staleLearning.status, "INSUFFICIENT_HISTORY");
});

test("resolution rates: enough recorded pairs yield the measured fraction", () => {
  const rates = estimateChannelResolutionRates(pairsFor("spreadInstability", 40, 0.5));
  assert.equal(rates.spreadInstability.status, "OK");
  const ok = rates.spreadInstability as { rate: number; samples: number };
  assert.equal(ok.samples, 40);
  assert.ok(Math.abs(ok.rate - 0.5) < 1e-9);
});

test("VOI: a penalized channel without measured history makes the WHOLE advisory INSUFFICIENT_HISTORY", () => {
  const advisory = computeWaitAdvisory({
    channels: channelsWith({ spreadInstability: 0.8 }),
    resolutionRates: estimateChannelResolutionRates([]),
    halfLifeMs: 5 * 60_000,
    waitMs: 60_000,
  });
  assert.equal(advisory.status, "INSUFFICIENT_HISTORY");
  assert.equal(advisory.advisory, "NONE");
  assert.ok(
    advisory.status === "INSUFFICIENT_HISTORY" &&
      advisory.insufficientChannels.includes("spreadInstability"),
  );
});

test("VOI: WAIT_FOR_EVIDENCE exactly when expected reduction beats the entry-decay cost", () => {
  const rates = estimateChannelResolutionRates([
    ...pairsFor("missingData", 40, 0.9),
    ...pairsFor("conflictingSignals", 40, 0.9),
  ]);
  const channels = channelsWith({ missingData: 1, conflictingSignals: 1 });
  // Long half-life → tiny decay cost → waiting wins.
  const wait = computeWaitAdvisory({ channels, resolutionRates: rates, halfLifeMs: 75 * 60_000, waitMs: 60_000 });
  assert.equal(wait.status, "OK");
  assert.equal(wait.advisory, "WAIT_FOR_EVIDENCE");
  assert.ok(wait.status === "OK" && wait.expectedUncertaintyReduction > wait.entryDecayCost);
  assert.ok(wait.status === "OK" && Math.abs(wait.netValue - (wait.expectedUncertaintyReduction - wait.entryDecayCost)) < 1e-12);
  // Very short half-life → waiting burns the whole edge → no wait edge.
  const act = computeWaitAdvisory({ channels, resolutionRates: rates, halfLifeMs: 8_000, waitMs: 60_000 });
  assert.equal(act.status, "OK");
  assert.equal(act.advisory, "NO_WAIT_EDGE");
});

test("VOI: nothing to resolve → OK / NO_WAIT_EDGE with zero expected reduction", () => {
  const advisory = computeWaitAdvisory({
    channels: channelsWith({}),
    resolutionRates: estimateChannelResolutionRates([]),
    halfLifeMs: 5 * 60_000,
    waitMs: 60_000,
  });
  assert.equal(advisory.status, "OK");
  assert.equal(advisory.advisory, "NO_WAIT_EDGE");
  assert.ok(advisory.status === "OK" && advisory.expectedUncertaintyReduction === 0);
});

// ── Recorders (the honest evidence base) ────────────────────────────────────

test("spread recorder: refuses degenerate quotes; null until enough fresh samples", () => {
  clearSpreadHistory();
  assert.equal(recordSpreadSample("EURUSD", -0.1, 1.1, NOW), false);
  assert.equal(recordSpreadSample("EURUSD", 0.0001, 0, NOW), false);
  assert.equal(recordSpreadSample("EURUSD", NaN, 1.1, NOW), false);
  assert.equal(getSpreadRelHistory("EURUSD", { nowMs: NOW }), null);
  for (let i = 0; i < 6; i++) {
    assert.equal(recordSpreadSample("EURUSD", 0.00011, 1.1, NOW + i * 1000), true);
  }
  const history = getSpreadRelHistory("EURUSD", { nowMs: NOW + 10_000 });
  assert.ok(history && history.length === 6);
  assert.ok(history!.every((s) => Math.abs(s - 0.0001) < 1e-9));
  // Stale samples age out of the read window (honest null again).
  assert.equal(getSpreadRelHistory("EURUSD", { nowMs: NOW + 2 * 60 * 60 * 1000 }), null);
  clearSpreadHistory();
});

test("resolution recorder: first observation yields no pairs; qualifying gaps pair up; huge gaps do not", () => {
  clearResolutionRecorder();
  const c1 = channelsWith({ spreadInstability: 0.9 });
  const c2 = channelsWith({ spreadInstability: 0.2 });
  assert.equal(recordUncertaintyObservation(1, "EURUSD", c1, NOW), 0);
  const paired = recordUncertaintyObservation(1, "EURUSD", c2, NOW + 60_000);
  assert.ok(paired > 0, "a one-minute follow-up must produce pairs");
  const pairs = getResolutionPairs().filter((p) => p.channel === "spreadInstability");
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.penaltyBefore, 0.9);
  assert.equal(pairs[0]!.penaltyAfter, 0.2);
  // A gap far beyond one bar of waiting is NOT wait-resolution evidence.
  assert.equal(recordUncertaintyObservation(1, "EURUSD", c1, NOW + 10 * 60 * 60 * 1000), 0);
  clearResolutionRecorder();
});
