// Change-point detection (#9) — CUSUM + Page–Hinkley benchmarks + the
// driver's pure quarantine-feed policy.
//
// Locked here:
//   * BENCHMARK (known break): over seeded synthetic fixtures with a +1.5σ
//     mean shift after a 150-sample in-control run, CUSUM detects ≥ 95% of
//     breaks with post-break delay ≤ 25 samples (mean ≤ 15); Page–Hinkley
//     detects ≥ 95% with delay ≤ 60.
//   * BENCHMARK (no break): over seeded in-control fixtures (300 samples),
//     each detector false-alarms on ≤ 10% of runs.
//   * ARL tuning: cusumThresholdForArl inverts Siegmund's approximation
//     (round-trips), and a larger target ARL yields a larger threshold.
//   * HONESTY: a series too short for a baseline is INSUFFICIENT_SERIES with
//     alarm=false — the detector is silent when it cannot see, it never
//     fabricates a break. Non-finite samples are ignored, not scored.
//   * SAFETY: the driver's quarantine feed can only WORSEN or HOLD authority
//     (recovery evidence is pinned to 0) — auto-quarantine reduces authority,
//     automatic recovery/promotion is impossible from this path.
//
// IO-free, deterministic (seeded RNG). Offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:change-point

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHANGE_POINT_DEFAULT_BASELINE_COUNT,
  cusumArl0,
  cusumDetect,
  cusumThresholdForArl,
  detectSeriesBreak,
  pageHinkleyDetect,
} from "@workspace/domain/change-point";
import {
  changePointDriverEnabled,
  changePointSymbols,
  planQuarantineFeed,
} from "../changePointDriverPolicy.js";
import type { QuarantineState } from "@workspace/domain/continuous-validation";

// ── Seeded RNG (mulberry32) + Box–Muller gaussian — deterministic fixtures ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const BREAK_AT = 150;
const POST_BREAK = 80;
const SHIFT = 1.5;
const RUNS = 60;

function knownBreakSeries(seed: number): number[] {
  const rng = mulberry32(seed * 7919);
  const series: number[] = [];
  for (let i = 0; i < BREAK_AT; i++) series.push(gauss(rng));
  for (let i = 0; i < POST_BREAK; i++) series.push(SHIFT + gauss(rng));
  return series;
}
function noBreakSeries(seed: number): number[] {
  const rng = mulberry32(seed * 104729 + 17);
  const series: number[] = [];
  for (let i = 0; i < 300; i++) series.push(gauss(rng));
  return series;
}

// ── ARL tuning knob ─────────────────────────────────────────────────────────

test("ARL: threshold-for-ARL round-trips Siegmund's approximation and is monotone", () => {
  for (const target of [500, 5000, 50_000]) {
    const h = cusumThresholdForArl(target, 0.5);
    assert.ok(h > 0);
    assert.ok(cusumArl0(h, 0.5) >= target * 0.99, `ARL(${h}) must reach ~${target}`);
  }
  assert.ok(cusumThresholdForArl(50_000, 0.5) > cusumThresholdForArl(500, 0.5));
});

// ── Known-break benchmark: detection rate + delay bounds ────────────────────

test("BENCHMARK known break: CUSUM detects ≥95% with delay ≤25 (mean ≤15)", () => {
  let detected = 0;
  const delays: number[] = [];
  for (let seed = 1; seed <= RUNS; seed++) {
    const r = cusumDetect(knownBreakSeries(seed));
    if (r.alarm && r.alarmIndex! >= BREAK_AT) {
      detected++;
      delays.push(r.alarmIndex! - BREAK_AT);
    }
  }
  assert.ok(detected >= RUNS * 0.95, `detected ${detected}/${RUNS}`);
  const maxDelay = Math.max(...delays);
  const meanDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
  assert.ok(maxDelay <= 25, `max detection delay ${maxDelay} > 25`);
  assert.ok(meanDelay <= 15, `mean detection delay ${meanDelay.toFixed(1)} > 15`);
});

test("BENCHMARK known break: Page–Hinkley detects ≥95% with delay ≤60", () => {
  let detected = 0;
  const delays: number[] = [];
  for (let seed = 1; seed <= RUNS; seed++) {
    const r = pageHinkleyDetect(knownBreakSeries(seed));
    if (r.alarm && r.alarmIndex! >= BREAK_AT) {
      detected++;
      delays.push(r.alarmIndex! - BREAK_AT);
    }
  }
  assert.ok(detected >= RUNS * 0.95, `detected ${detected}/${RUNS}`);
  assert.ok(Math.max(...delays) <= 60, `max detection delay ${Math.max(...delays)} > 60`);
});

test("BENCHMARK known break: detection direction is reported (UP for a positive shift)", () => {
  const r = cusumDetect(knownBreakSeries(3));
  assert.equal(r.alarm, true);
  assert.equal(r.direction, "UP");
  const down = cusumDetect(knownBreakSeries(3).map((x) => -x));
  assert.equal(down.alarm, true);
  assert.equal(down.direction, "DOWN");
});

// ── No-break benchmark: false-alarm rate ────────────────────────────────────

test("BENCHMARK no break: each detector false-alarms on ≤10% of in-control runs", () => {
  const FRUNS = 100;
  let cusumFa = 0;
  let phFa = 0;
  for (let seed = 1; seed <= FRUNS; seed++) {
    const series = noBreakSeries(seed);
    if (cusumDetect(series).alarm) cusumFa++;
    if (pageHinkleyDetect(series).alarm) phFa++;
  }
  assert.ok(cusumFa <= FRUNS * 0.1, `CUSUM false alarms ${cusumFa}/${FRUNS}`);
  assert.ok(phFa <= FRUNS * 0.1, `Page–Hinkley false alarms ${phFa}/${FRUNS}`);
});

// ── Honesty: silent when blind ──────────────────────────────────────────────

test("honesty: too-short series is INSUFFICIENT_SERIES with no alarm, never a fabricated break", () => {
  const short = Array.from({ length: CHANGE_POINT_DEFAULT_BASELINE_COUNT - 1 }, () => 100);
  for (const r of [cusumDetect(short), pageHinkleyDetect(short)]) {
    assert.equal(r.alarm, false);
    assert.equal(r.reason, "INSUFFICIENT_SERIES");
    assert.equal(r.alarmIndex, null);
    assert.equal(r.baseline, null);
  }
  const combined = detectSeriesBreak(short);
  assert.equal(combined.anyAlarm, false);
});

test("honesty: non-finite samples are ignored, not scored", () => {
  const series = knownBreakSeries(9);
  const polluted = [...series];
  polluted.splice(10, 0, NaN, Infinity, -Infinity);
  const clean = cusumDetect(series);
  const dirty = cusumDetect(polluted);
  assert.equal(dirty.alarm, clean.alarm);
  assert.equal(dirty.alarmIndex, clean.alarmIndex);
});

test("honesty: a supplied baseline is honored (no estimation from the series head)", () => {
  // Flat series at 5 vs supplied baseline mean 0/std 1 → immediate upward alarm.
  const series = Array.from({ length: 20 }, () => 5);
  const r = cusumDetect(series, { baselineMean: 0, baselineStd: 1, arl0: 5000 });
  assert.equal(r.alarm, true);
  assert.equal(r.direction, "UP");
});

// ── Driver policy: env opt-out + authority-reduction-only feed ──────────────

test("driver policy: env opt-out parsing (absent = enabled, disable values off)", () => {
  assert.equal(changePointDriverEnabled(undefined), true);
  assert.equal(changePointDriverEnabled("1"), true);
  assert.equal(changePointDriverEnabled("true"), true);
  for (const v of ["0", "false", "off", "no", " FALSE ", "Off"]) {
    assert.equal(changePointDriverEnabled(v), false, `"${v}" must disable`);
  }
  assert.deepEqual(changePointSymbols(undefined), ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"]);
  assert.deepEqual(changePointSymbols("eurusd, xauusd ,eurusd"), ["EURUSD", "XAUUSD"]);
});

test("SAFETY: the quarantine feed can only WORSEN or HOLD — never IMPROVE, from any input", () => {
  const states: QuarantineState[] = ["NONE", "SHADOW", "RESTRICTED", "RETIRED"];
  const order = { NONE: 0, SHADOW: 1, RESTRICTED: 2, RETIRED: 3 } as const;
  for (const currentState of states) {
    for (const trust of [0, 0.2, 0.5, 0.75, 0.9, 1]) {
      for (const detections of [0, 1, 2, 5, 100]) {
        const r = planQuarantineFeed({
          seriesKey: "outcome:strategy:test:0",
          currentState,
          trustScore01: trust,
          detectionCount: detections,
        });
        assert.notEqual(r.direction, "IMPROVE", JSON.stringify({ currentState, trust, detections, r }));
        assert.ok(
          order[r.nextState] >= order[currentState],
          `authority increased: ${currentState} → ${r.nextState}`,
        );
      }
    }
  }
});

test("quarantine feed: repeated detections shadow a healthy entity; permissions tighten", () => {
  // One detection on a trusted entity holds; two detections count as repeated
  // moderate concerns and move NONE → SHADOW (no new entries, shadow-only).
  const one = planQuarantineFeed({ seriesKey: "s", currentState: "NONE", trustScore01: 0.8, detectionCount: 1 });
  assert.equal(one.nextState, "NONE");
  const two = planQuarantineFeed({ seriesKey: "s", currentState: "NONE", trustScore01: 0.8, detectionCount: 2 });
  assert.equal(two.nextState, "SHADOW");
  assert.equal(two.permissions.canEnterTrades, false);
  assert.equal(two.permissions.visibleOnlyToShadow, true);
});
