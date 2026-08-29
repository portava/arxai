// Capability #6 — VoI advisory live wiring: recorder coverage extension.
//
// Locked here:
//   * The per-channel recorder seam pairs each channel independently: a
//     channel with no snapshot NEVER produces a pair (partial observation is
//     honest), and the min/max pairing gaps hold per channel.
//   * The full-decomposition path (decision service) is unchanged: one full
//     observation followed by another in-window records a pair per channel.
//   * The coverage worker records ONLY the channel it genuinely measures
//     (spreadInstability) — no placeholder penalties for unmeasured channels
//     ever enter the resolution history.
//   * Coverage accelerates history: two worker passes one interval apart
//     yield real spreadInstability pairs for the active feed symbols, which
//     the estimator then measures (toward WAIT_FOR_EVIDENCE) while OTHER
//     channels honestly stay INSUFFICIENT_HISTORY.
//   * Worker env opt-out parsing (default ON; disable values respected).
//
// Run: pnpm --filter @workspace/api-server run test:voi-coverage

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  estimateChannelResolutionRates,
  VOI_DEFAULT_MIN_SAMPLES,
  type AaciUncertaintyChannels,
} from "@workspace/domain/aaci";
import {
  RESOLUTION_PAIR_MAX_GAP_MS,
  RESOLUTION_PAIR_MIN_GAP_MS,
  clearResolutionRecorder,
  getResolutionPairs,
  recordChannelObservation,
  recordUncertaintyObservation,
} from "../aaci/uncertaintyResolutionRecorder.js";
import { clearSpreadHistory } from "../aaci/spreadHistoryRecorder.js";
import {
  coverageSymbols,
  runUncertaintyCoveragePass,
  uncertaintyCoverageEnabled,
  UNCERTAINTY_COVERAGE_INTERVAL_MS,
} from "../aaci/uncertaintyCoverageWorker.js";

const T0 = Date.UTC(2026, 7, 29, 12, 0, 0);

function fullChannels(v: number): AaciUncertaintyChannels {
  return {
    missingData: v, conflictingSignals: v, lowSampleHistory: v, newsChaos: v,
    spreadInstability: v, modelDisagreement: v, staleLearning: v,
  };
}

beforeEach(() => {
  clearResolutionRecorder();
  clearSpreadHistory();
});

// ── Per-channel recorder seam ───────────────────────────────────────────────

test("per-channel pairing: first obs no pair; in-window second obs pairs; gaps enforced", () => {
  assert.equal(recordChannelObservation(0, "EURUSD", "spreadInstability", 0.8, T0), 0);
  // Too close — same evaluation, not new evidence.
  assert.equal(
    recordChannelObservation(0, "EURUSD", "spreadInstability", 0.5, T0 + RESOLUTION_PAIR_MIN_GAP_MS - 1),
    0,
  );
  // In-window — one pair, from the most recent snapshot.
  assert.equal(
    recordChannelObservation(0, "EURUSD", "spreadInstability", 0.4, T0 + 60_000),
    1,
  );
  const pairs = getResolutionPairs();
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.channel, "spreadInstability");
  // Too old — not "one more bar of waiting".
  assert.equal(
    recordChannelObservation(0, "EURUSD", "spreadInstability", 0.2, T0 + 60_000 + RESOLUTION_PAIR_MAX_GAP_MS + 1),
    0,
  );
});

test("a channel with no snapshot never produces a pair (partial observation is honest)", () => {
  recordChannelObservation(0, "EURUSD", "spreadInstability", 0.8, T0);
  recordChannelObservation(0, "EURUSD", "spreadInstability", 0.4, T0 + 30_000);
  // Only spreadInstability was ever observed → only spreadInstability pairs.
  const pairs = getResolutionPairs();
  assert.ok(pairs.length > 0);
  assert.ok(pairs.every((p) => p.channel === "spreadInstability"));
});

test("full-decomposition path still pairs every channel (decision-service seam)", () => {
  recordUncertaintyObservation(1, "XAUUSD", fullChannels(0.6), T0);
  const recorded = recordUncertaintyObservation(1, "XAUUSD", fullChannels(0.3), T0 + 30_000);
  assert.equal(recorded, 7);
  assert.equal(getResolutionPairs().length, 7);
});

test("contexts are isolated: user/symbol pairs never cross", () => {
  recordChannelObservation(1, "EURUSD", "spreadInstability", 0.8, T0);
  assert.equal(recordChannelObservation(2, "EURUSD", "spreadInstability", 0.4, T0 + 30_000), 0);
  assert.equal(recordChannelObservation(1, "GBPUSD", "spreadInstability", 0.4, T0 + 30_000), 0);
});

// ── Worker behavior ─────────────────────────────────────────────────────────

test("env opt-out parsing: default ON, disable values respected", () => {
  assert.equal(uncertaintyCoverageEnabled(undefined), true);
  assert.equal(uncertaintyCoverageEnabled("1"), true);
  assert.equal(uncertaintyCoverageEnabled("0"), false);
  assert.equal(uncertaintyCoverageEnabled("false"), false);
  assert.equal(uncertaintyCoverageEnabled("off"), false);
});

test("coverage worker records ONLY genuinely measured channels, and pairs accrue across passes", () => {
  const symbols = coverageSymbols();
  assert.ok(symbols.length > 0, "active feed must expose symbols to cover");

  const first = runUncertaintyCoveragePass(T0);
  assert.equal(first.errors, 0);
  assert.ok(first.observations > 0);
  assert.equal(first.pairsRecorded, 0); // first observation has nothing to pair

  const second = runUncertaintyCoveragePass(T0 + UNCERTAINTY_COVERAGE_INTERVAL_MS);
  assert.equal(second.errors, 0);
  assert.ok(second.pairsRecorded > 0, "second pass one interval later must record pairs");

  const pairs = getResolutionPairs();
  assert.ok(pairs.length > 0);
  // THE honesty core: the worker never fabricates observations for channels
  // it cannot measure — every recorded pair is spreadInstability.
  assert.ok(
    pairs.every((p) => p.channel === "spreadInstability"),
    `unexpected channels: ${[...new Set(pairs.map((p) => p.channel))].join(",")}`,
  );
});

test("worker-accrued history feeds the estimator; unmeasured channels stay INSUFFICIENT_HISTORY", () => {
  // Enough passes to cross the estimator's minimum sample count.
  const symbols = coverageSymbols();
  const passesNeeded = Math.ceil(VOI_DEFAULT_MIN_SAMPLES / Math.max(1, symbols.length)) + 1;
  for (let i = 0; i <= passesNeeded; i++) {
    runUncertaintyCoveragePass(T0 + i * UNCERTAINTY_COVERAGE_INTERVAL_MS);
  }
  const rates = estimateChannelResolutionRates(getResolutionPairs());
  assert.equal(rates.spreadInstability.status, "OK", JSON.stringify(rates.spreadInstability));
  // Channels the worker cannot measure accumulated NOTHING — honest.
  assert.equal(rates.missingData.status, "INSUFFICIENT_HISTORY");
  assert.equal(rates.newsChaos.status, "INSUFFICIENT_HISTORY");
  assert.equal(rates.staleLearning.status, "INSUFFICIENT_HISTORY");
});
