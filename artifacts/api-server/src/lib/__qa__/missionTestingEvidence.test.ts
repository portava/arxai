import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, type BacktestSimTrade } from "@workspace/domain/backtest";
import { summarizeMissionTest, hasSufficientSample, type MissionTestMetrics } from "@workspace/domain/profit-mission";
import {
  GENERATED_PRICE_EVIDENCE, CLOSED_DRAFT_EVIDENCE, backtestToMissionMetrics,
  projectMissionTestResult, readMissionMetrics,
} from "../missionTestingEvidence.js";
import {
  summarizeRObservations, studentT975, STUDENT_T_975, detectMissionDrift, checkMissionCopyDeep,
} from "@workspace/domain/profit-mission";
import { backtestRObservations, buildRStatisticsRecord } from "../missionTestingEvidence.js";

const strong: MissionTestMetrics = {
  totalTrades: 40, winningTrades: 30, losingTrades: 10, winRate: .75,
  netProfitLoss: 100, maxDrawdownPct: 5, averageRr: 2, expectancyR: .4, profitFactor: 1.8,
};
const row = (metricsJson: unknown) => ({
  id: 1, missionId: 2, kind: "BACKTEST", strategyKey: "trendContinuation", symbol: "EURUSD",
  timeframe: "M15", metricsJson, createdAt: new Date("2026-01-01T00:00:00Z"),
  isVerified: true, label: "Verified historical performance", sampleSize: 999,
});

for (const [kind, evidence] of [["BACKTEST", GENERATED_PRICE_EVIDENCE], ["FORWARD", CLOSED_DRAFT_EVIDENCE]] as const) {
  test(`${evidence.source}: a large profitable sample does not establish validated evidence`, () => {
    const summary = summarizeMissionTest({ kind, strategyKey: "trend", symbol: "EURUSD", timeframe: "M15", metrics: strong, evidence });
    assert.equal(summary.sampleSufficient, true);
    assert.equal(summary.promotionEligible, false);
    assert.match(summary.notes.join(" "), /Excluded from promotion/);
    assert.match(summary.notes.join(" "), /does not establish statistical significance/);
  });
}

test("legacy eligible/verified flags and labels cannot promote a stored result", () => {
  const result = projectMissionTestResult(row({ metrics: strong, promotionEligible: true, headline: "Verified" }));
  assert.equal(result.isVerified, false);
  assert.equal(result.promotionEligible, false);
  assert.equal(result.sampleSize, 40);
  assert.match(result.label, /unverified/);
  assert.doesNotMatch(result.headline, /Verified/);
});

for (const evidence of [
  { version: 1, source: "market_history", validation: "verified" },
  { version: 2, source: "generated_prices", validation: "unverified" },
  CLOSED_DRAFT_EVIDENCE, "generated_prices", null,
]) test(`unsupported/mismatched provenance fails closed: ${JSON.stringify(evidence)}`, () => {
  const result = projectMissionTestResult(row({ metrics: strong, evidence, promotionEligible: true }));
  assert.equal(result.evidence.source, "unknown");
  assert.equal(result.isVerified, false);
  assert.equal(result.promotionEligible, false);
});

test("generated-price notes disclose excluded costs and non-currency units", () => {
  const result = projectMissionTestResult(row({ metrics: strong, evidence: GENERATED_PRICE_EVIDENCE }));
  assert.equal(result.label, "Generated-price simulation");
  assert.match(result.notes.join(" "), /not account currency/);
  assert.match(result.notes.join(" "), /Fees, spread and slippage are excluded/);
});

for (const invalid of [null, {}, { ...strong, totalTrades: 3.1 }, { ...strong, netProfitLoss: NaN },
  { ...strong, expectancyR: Infinity }, { ...strong, winRate: 2 }, { ...strong, winningTrades: 41 },
  { ...strong, maxDrawdownPct: -2 }, { ...strong, profitFactor: -1 }]) {
  test(`invalid stored metrics are quarantined: ${JSON.stringify(invalid)}`, () => {
    assert.equal(readMissionMetrics(invalid), null);
    const result = projectMissionTestResult(row({ metrics: invalid, promotionEligible: true }));
    assert.equal(result.isVerified, false);
    assert.equal(result.sampleSize, 0);
    assert.match(result.notes[0]!, /incomplete or invalid/);
  });
}

test("sample thresholds reject fractional/nonfinite counts and do not claim significance", () => {
  for (const sample of [Infinity, NaN, -1, 40.5]) assert.equal(hasSufficientSample("BACKTEST", sample), false);
});

for (const count of [0, 1, 40, 41, null]) test(`forward R coverage is explicit for ${count} observed values`, () => {
  const result = projectMissionTestResult({ ...row({
    metrics: strong, evidence: CLOSED_DRAFT_EVIDENCE,
    experiment: { version: 1, engine: "closed-draft-aggregate-v1", rObservedCount: count, closedDraftCount: 40 },
  }), kind: "FORWARD" });
  if (count === 1) {
    assert.match(result.headline, /observed-subset expectancy 0.40R \(1\/40 R observations\)/);
    assert.match(result.sampleWarning!, /R metrics are incomplete/);
  } else if (count === 40) {
    assert.match(result.notes.join(" "), /40 of 40 closed trades/);
    assert.equal(result.sampleWarning, null);
  } else {
    assert.match(result.headline, /R metrics unavailable/);
    assert.match(result.sampleWarning!, /R metrics are incomplete/);
  }
  assert.equal(result.promotionEligible, false);
});

test("an end-of-run positive exit earns actual partial R instead of the planned target R", () => {
  const trade: BacktestSimTrade = {
    symbol: "EURUSD", direction: "BUY", entryTime: "2026-01-01", exitTime: "2026-01-02",
    entryPrice: 100, stopLoss: 90, takeProfit: 130, exitPrice: 105, profitLoss: 5, rewardToRisk: 3, result: "WIN",
  };
  const metrics = backtestToMissionMetrics(computeMetrics([trade], 100, [100, 105]), [trade], 100);
  assert.equal(metrics.expectancyR, .5);
  assert.equal(metrics.averageRr, .5);
});

test("a partial loss is its realised loss rather than an invented full stop", () => {
  const trade: BacktestSimTrade = {
    symbol: "EURUSD", direction: "SELL", entryTime: "2026-01-01", exitTime: "2026-01-02",
    entryPrice: 100, stopLoss: 110, takeProfit: 70, exitPrice: 102, profitLoss: -2, rewardToRisk: 3, result: "LOSS",
  };
  const metrics = backtestToMissionMetrics(computeMetrics([trade], 100, [100, 98]), [trade], 100);
  assert.equal(metrics.expectancyR, -.2);
});

test("drawdown uses the peak at each loss, never starting balance or a later higher peak", () => {
  const raw = computeMetrics([], 100, [100, 200, 100, 1000, 700]);
  const metrics = backtestToMissionMetrics(raw, [], 100);
  assert.equal(metrics.maxDrawdownPct, 50);
});

// ── R-expectancy sample uncertainty (item 9) ─────────────────────────────────

const RX_INTERVAL = /R to .*R around/;
const RX_UNCERTAINTY = /R sample interval|R uncertainty unavailable/;
// The exact invalid-record note; several unavailable notes share the "R uncertainty unavailable" prefix.
const R_INVALID = "R uncertainty unavailable: no valid sample statistics are stored for this record; no interval is reported.";
const allNotes: string[] = [];
function uncertaintyNote(result: { notes: string[] }): string {
  const hits = result.notes.filter((n) => RX_UNCERTAINTY.test(n));
  assert.equal(hits.length, 1, JSON.stringify(result.notes));
  assert.doesNotMatch(hits[0]!, /-0\.0+R/);
  assert.doesNotMatch(hits[0]!, /confidence|breakeven/i);
  assert.doesNotMatch(hits[0]!, /\b1 values\b|\b1 trades\b|\b1 degrees\b/);
  allNotes.push(...result.notes);
  return hits[0]!;
}
const fiveTrades: MissionTestMetrics = {
  totalTrades: 5, winningTrades: 3, losingTrades: 2, winRate: .6,
  netProfitLoss: 2, maxDrawdownPct: 1, averageRr: 1.3333, expectancyR: .4, profitFactor: 2,
};
const backtestRow = (rStatistics: unknown, metrics: MissionTestMetrics = fiveTrades, experiment: Record<string, unknown> = {}) => row({
  metrics, evidence: GENERATED_PRICE_EVIDENCE,
  experiment: { version: 1, engine: "generated-price-diagnostic-v1", rStatistics, ...experiment },
});
const forwardRow = (rStatistics: unknown, metrics: MissionTestMetrics, experiment: Record<string, unknown>) => ({ ...row({
  metrics, evidence: CLOSED_DRAFT_EVIDENCE,
  experiment: { version: 1, engine: "closed-draft-aggregate-v1", rStatistics, ...experiment },
}), kind: "FORWARD" });
const trade = (entryPrice: number, stopLoss: number, profitLoss: number): BacktestSimTrade => ({
  symbol: "EURUSD", direction: "BUY", entryTime: "2026-01-01", exitTime: "2026-01-02",
  entryPrice, stopLoss, takeProfit: entryPrice + 30, exitPrice: entryPrice + profitLoss, profitLoss,
  rewardToRisk: 3, result: profitLoss > 0 ? "WIN" : "LOSS",
});

test("fixed vector [1,-1,2,-1,1] reproduces the Student t(4) interval", () => {
  const s = summarizeRObservations([1, -1, 2, -1, 1]);
  // Reference only: the normal approximation (z 1.96) would give [-0.78, 1.58].
  assert.deepEqual(s, {
    status: "available", n: 5, mean: .4, sampleSd: 1.341641, standardError: .6,
    degreesOfFreedom: 4, quantile: 2.776445,
    interval95: { low: -1.265867, high: 2.065867, method: "student_t" }, includesZero: true,
  });
  const note = uncertaintyNote(projectMissionTestResult(backtestRow(buildRStatisticsRecord([1, -1, 2, -1, 1], 0))));
  assert.match(note, /-1\.27R to 2\.07R around a mean of 0\.40R over 5 observed R values \(standard error 0\.60R\)/);
  assert.match(note, /4 degrees of freedom/);
});

test("float-noise ties never produce a zero-width interval", () => {
  const s = summarizeRObservations([1, 1 + 2 ** -52, 1]);
  assert.deepEqual(s, { status: "unavailable", n: 3, reason: "interval_below_precision" });
  assert.equal("interval95" in s, false);
  const note = uncertaintyNote(projectMissionTestResult(backtestRow(buildRStatisticsRecord([1, 1 + 2 ** -52, 1], 2))));
  assert.match(note, /vary by less than the stored 6-decimal precision/);
  assert.doesNotMatch(note, RX_INTERVAL);
  // A standard deviation below the stored precision is also not reported as an interval.
  assert.deepEqual(summarizeRObservations([1e-8, -2e-8, 1e-8]), { status: "unavailable", n: 3, reason: "interval_below_precision" });
  // [0, 4.9e-7] isolates the "SD rounds to 0" rule: its rounded bounds differ
  // (-0.000003 / 0.000003), so only the stored SD of 0 makes it unavailable.
  const se = 4.9e-7 / Math.SQRT2 / Math.SQRT2;
  assert.notEqual(Math.round((2.45e-7 - 12.706205 * se) * 1e6), Math.round((2.45e-7 + 12.706205 * se) * 1e6));
  assert.equal(Math.round(4.9e-7 / Math.SQRT2 * 1e6), 0);
  assert.deepEqual(summarizeRObservations([0, 4.9e-7]), { status: "unavailable", n: 2, reason: "interval_below_precision" });
});

test("identical values whose float mean is off by an ulp still read as all equal", () => {
  // Precondition: the float mean differs from the common value, so ss is not exactly 0.
  assert.notEqual((.1 + .1 + .1) / 3, .1);
  assert.deepEqual(summarizeRObservations([.1, .1, .1]), { status: "unavailable", n: 3, reason: "no_variation", value: .1 });
  const metrics = { ...fiveTrades, totalTrades: 3, winningTrades: 3, losingTrades: 0, winRate: 1, expectancyR: .1 };
  const note = uncertaintyNote(projectMissionTestResult(backtestRow(buildRStatisticsRecord([.1, .1, .1], 0), metrics)));
  assert.equal(note, "R uncertainty unavailable: all 3 observed R values equal 0.10R; no interval is reported.");
});

test("boundary pins: equal rounded bounds, rounded no_variation value, a bound exactly at 0R", () => {
  // SD rounds to 1e-6 (> 0) but n = 400 makes q·SE ≈ 1e-7, so both bounds round to 0.000001.
  const narrow = Array.from({ length: 400 }, (_, i) => (i % 2 ? 2e-6 : 0));
  assert.equal(Math.round(Math.sqrt(400e-12 / 399) * 1e6), 1);
  assert.deepEqual(summarizeRObservations(narrow), { status: "unavailable", n: 400, reason: "interval_below_precision" });
  // The common value is stored at 6 decimals.
  assert.deepEqual(summarizeRObservations([.1234567, .1234567]), { status: "unavailable", n: 2, reason: "no_variation", value: .123457 });
  // mean 12.706205 and SE 1 with t(1) 12.706205: the low bound is exactly 0 and counts as including 0R.
  const touching = buildRStatisticsRecord([13.706205, 11.706205], 0);
  assert.equal(touching.status, "available"); if (touching.status !== "available") return;
  assert.equal(touching.interval95.low, 0);
  assert.equal(touching.includesZero, true);
  const metrics = { ...fiveTrades, totalTrades: 2, winningTrades: 2, losingTrades: 0, winRate: 1, expectancyR: 12.7062 };
  const note = uncertaintyNote(projectMissionTestResult(backtestRow(touching, metrics)));
  assert.match(note, /: 0\.00R to 25\.41R around/);
  assert.match(note, /The interval includes 0R, so this sample does not distinguish the sample mean from 0R \(gross, before costs\)\./);
});

test("the (2+q)e-6 bound tolerance admits real producer records with rounding error above 2e-6", () => {
  // Deterministic LCG; n = 2..5 observed R values at 7-decimal precision.
  let seed = 20261028;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let aboveFlat = 0;
  for (let i = 0; i < 400; i += 1) {
    const n = 2 + (i % 4);
    const values = Array.from({ length: n }, () => Math.round((rnd() * 6 - 2) * 1e7) / 1e7);
    const rec = buildRStatisticsRecord(values, 0);
    assert.equal(rec.status, "available", JSON.stringify(values)); if (rec.status !== "available") return;
    const { mean, standardError: se, quantile: q, interval95: { low, high } } = rec;
    const deviation = Math.max(Math.abs(low - (mean - q * se)), Math.abs(high - (mean + q * se)));
    assert.ok(deviation <= (2 + q) * 1e-6, `deviation ${deviation}`);
    if (deviation <= 2e-6) continue;
    aboveFlat += 1;
    const wins = values.filter((v) => v > 0).length;
    const losses = values.filter((v) => v < 0).length;
    const expectancyR = Math.round(values.reduce((a, b) => a + b, 0) / n * 1e4) / 1e4;
    const metrics = { ...fiveTrades, totalTrades: n, winningTrades: wins, losingTrades: losses, winRate: Math.round(wins / n * 1e4) / 1e4, expectancyR };
    const stored = JSON.parse(JSON.stringify(rec));
    for (const r of [backtestRow(stored, metrics), forwardRow(stored, metrics, { rObservedCount: n, closedDraftCount: n })]) {
      assert.match(uncertaintyNote(projectMissionTestResult(r)), /^R sample interval/, JSON.stringify(values));
    }
  }
  // Anti-vacuity: a flat 2e-6 tolerance would reject these valid rows.
  assert.ok(aboveFlat >= 50, `only ${aboveFlat} records exceed a flat 2e-6`);
});

test("identical R values are unavailable with the common value, never an interval", () => {
  assert.deepEqual(summarizeRObservations([1, 1, 1]), { status: "unavailable", n: 3, reason: "no_variation", value: 1 });
  const metrics = { ...fiveTrades, totalTrades: 3, winningTrades: 3, losingTrades: 0, winRate: 1, expectancyR: 1 };
  const note = uncertaintyNote(projectMissionTestResult(backtestRow(buildRStatisticsRecord([1, 1, 1], 0), metrics)));
  assert.match(note, /all 3 observed R values equal 1\.00R; no interval is reported/);
  assert.doesNotMatch(note, RX_INTERVAL);
});

test("a narrow real interval falls back to more decimals so printed bounds differ", () => {
  const values = Array.from({ length: 400 }, (_, i) => (i % 2 ? .501 : .499));
  const rec = buildRStatisticsRecord(values, 0);
  assert.equal(rec.status, "available");
  const metrics = { ...fiveTrades, totalTrades: 400, winningTrades: 400, losingTrades: 0, winRate: 1, expectancyR: .5 };
  const note = uncertaintyNote(projectMissionTestResult(backtestRow(rec, metrics)));
  const m = note.match(/: (-?[\d.]+)R to (-?[\d.]+)R around/);
  assert.ok(m, note);
  assert.notEqual(m[1], m[2]);
  assert.equal(m[1]!.split(".")[1]!.length, 4);
  assert.match(note, /199 degrees|399 degrees/);
});

test("negative-zero means print as 0.00R", () => {
  const tiny = summarizeRObservations([-1e-7, 1, -1]);
  assert.equal(tiny.status, "available");
  if (tiny.status === "available") assert.equal(Object.is(tiny.mean, -0), false);
  const metrics = { ...fiveTrades, totalTrades: 3, winningTrades: 1, losingTrades: 2, expectancyR: 0 };
  const near = buildRStatisticsRecord([-.003, 1, -1], 0);
  assert.equal(near.status === "available" && near.mean, -.001);
  for (const rec of [buildRStatisticsRecord([-1e-7, 1, -1], 0), near]) {
    const note = uncertaintyNote(projectMissionTestResult(backtestRow(rec, { ...metrics, expectancyR: rec.status === "available" ? Math.round(rec.mean * 1e4) / 1e4 : 0 })));
    assert.match(note, /around a mean of 0\.00R/);
  }
});

test("fewer than two observations are unavailable with correct counts", () => {
  assert.deepEqual(summarizeRObservations([]), { status: "unavailable", n: 0, reason: "insufficient_observations" });
  assert.deepEqual(summarizeRObservations([.5]), { status: "unavailable", n: 1, reason: "insufficient_observations" });
  const zero = { ...fiveTrades, totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, expectancyR: 0 };
  assert.match(uncertaintyNote(projectMissionTestResult(backtestRow(buildRStatisticsRecord([], 0), zero))), /no observed R values; at least 2 are needed/);
  const one = { ...zero, totalTrades: 1, winningTrades: 1, winRate: 1, expectancyR: .5 };
  const note = uncertaintyNote(projectMissionTestResult(backtestRow(buildRStatisticsRecord([.5], 0), one)));
  assert.match(note, /only 1 observed R value; at least 2 are needed; no interval is reported/);
});

test("non-finite inputs are rejected, never coerced", () => {
  for (const values of [[1, NaN], [1, Infinity], [1, -Infinity], [NaN, NaN]]) {
    const s = summarizeRObservations(values);
    assert.deepEqual(s, { status: "unavailable", n: values.length, reason: "non_finite_input" });
    assert.equal("mean" in s, false);
  }
  assert.deepEqual(summarizeRObservations([1e308, -1e308, 1e308]), { status: "unavailable", n: 3, reason: "non_finite_result" });
});

test("a negative-mean sample is not relabelled and excludes 0R", () => {
  const values = [-1, -1.2, -.8, -1, -1.1];
  const s = summarizeRObservations(values);
  assert.equal(s.status, "available"); if (s.status !== "available") return;
  assert.equal(s.mean, -1.02); assert.ok(s.interval95.high < 0); assert.equal(s.includesZero, false);
  const metrics = { ...fiveTrades, winningTrades: 0, losingTrades: 5, winRate: 0, expectancyR: -1.02, profitFactor: 0 };
  const note = uncertaintyNote(projectMissionTestResult(backtestRow(buildRStatisticsRecord(values, 0), metrics)));
  assert.match(note, /-1\.02R/);
  assert.match(note, /excludes 0R \(gross, before costs\), which does not validate an edge/);
  assert.doesNotMatch(note, /includes 0R/);
});

test("summarizeRObservations is deterministic and does not mutate its input", () => {
  const input = Object.freeze([.3, -1, 2.5, -1, .7]);
  const a = summarizeRObservations(input); const b = summarizeRObservations(input);
  assert.deepEqual(a, b);
  assert.deepEqual(input, [.3, -1, 2.5, -1, .7]);
});

test("studentT975 table values, monotonicity and conservative step-down", () => {
  assert.equal(studentT975(1), 12.706205); assert.equal(studentT975(4), 2.776445);
  assert.equal(studentT975(30), 2.042272); assert.equal(studentT975(120), 1.97993);
  assert.equal(studentT975(35), studentT975(30));
  assert.equal(studentT975(5000), studentT975(1000));
  for (let i = 1; i < STUDENT_T_975.length; i += 1) {
    assert.ok(STUDENT_T_975[i]![0] > STUDENT_T_975[i - 1]![0]);
    assert.ok(STUDENT_T_975[i]![1] <= STUDENT_T_975[i - 1]![1]);
  }
  for (const [, q] of STUDENT_T_975) assert.ok(q > 1.959964);
  assert.throws(() => studentT975(0)); assert.throws(() => studentT975(2.5));
});

test("backtest observations exclude non-positive stops and non-finite P/L; headline unchanged", () => {
  const trades = [trade(100, 100, 5), trade(100, 90, NaN), trade(100, Infinity, 5), trade(100, 90, 10), trade(100, 90, -5)];
  const robs = backtestRObservations(trades);
  assert.deepEqual(robs, { values: [1, -.5], excludedCount: 3 });
  const metrics = backtestToMissionMetrics(computeMetrics(trades, 100, [100]), trades, 100);
  assert.equal(metrics.expectancyR, Math.round((1 - .5) / 5 * 1e4) / 1e4);
});

test("producer agreement: headline expectancy matches the observed-R mean", () => {
  const pnl = [12, -10, 7.5, -10, 30, -4, 18, -10, 3.3, -10, 22, -6.1];
  const clean = pnl.map((p, i) => trade(100, 90 - (i % 3), p));
  const a = backtestToMissionMetrics(computeMetrics(clean, 100, [100]), clean, 100);
  const ra = buildRStatisticsRecord(backtestRObservations(clean).values, 0);
  assert.equal(ra.status, "available"); if (ra.status !== "available") return;
  assert.ok(Math.abs(a.expectancyR - ra.mean) <= 5e-5);
  const mixed = [...clean, trade(100, 100, 4), trade(100, 90, NaN)];
  const b = backtestToMissionMetrics(computeMetrics(mixed, 100, [100]), mixed, 100);
  const robs = backtestRObservations(mixed);
  const rb = buildRStatisticsRecord(robs.values, robs.excludedCount);
  assert.equal(rb.status, "available"); if (rb.status !== "available") return;
  assert.equal(rb.excludedCount, 2);
  assert.ok(Math.abs(rb.mean * rb.n / mixed.length - b.expectancyR) <= 1e-4);
  assert.equal(uncertaintyNote(projectMissionTestResult(backtestRow(rb, b))).startsWith("R sample interval"), true);
});

test("available backtest projection: one note with n, iid wording and gross qualifier", () => {
  const result = projectMissionTestResult(backtestRow(buildRStatisticsRecord([1, -1, 2, -1, 1], 0)));
  assert.equal(result.notes.filter((n) => /R sample interval/.test(n)).length, 1);
  const note = uncertaintyNote(result);
  assert.match(note, /over 5 observed R values/);
  assert.match(note, /assumes independent, identically distributed trade outcomes; a sample interval, not a forecast/i);
  assert.match(note, /does not distinguish the sample mean from 0R \(gross, before costs\)/i);
  assert.equal(result.promotionEligible, false);
});

test("backtest exclusions are disclosed with correct plurals", () => {
  const rec = buildRStatisticsRecord([1, -1, 2], 2);
  const metrics = { ...fiveTrades, expectancyR: Math.round(2 / 5 * 1e4) / 1e4 };
  const note = uncertaintyNote(projectMissionTestResult(backtestRow(rec, metrics)));
  assert.match(note, /mean over 3 observed trades; 2 trades without positive stop distance excluded/i);
  assert.match(note, /The headline expectancy counts those trades as 0R, so it can differ from this mean/);
  const one = buildRStatisticsRecord([1, -1, 2, .5], 1);
  const note1 = uncertaintyNote(projectMissionTestResult(backtestRow(one, { ...fiveTrades, expectancyR: .5 })));
  assert.match(note1, /; 1 trade without positive stop distance excluded/);
});

test("an unavailable backtest record still discloses excluded trades", () => {
  const metrics = { ...fiveTrades, totalTrades: 3, winningTrades: 1, losingTrades: 2, winRate: .3333, expectancyR: .1667 };
  const note = uncertaintyNote(projectMissionTestResult(backtestRow(buildRStatisticsRecord([.5], 2), metrics)));
  assert.match(note, /only 1 observed R value; at least 2 are needed; no interval is reported\. 2 trades without positive stop distance excluded/);
  assert.match(note, /the headline expectancy counts those trades as 0R\.$/);
});

test("forward uncertainty note only appears when it agrees with the coverage note", () => {
  const forty = { ...strong };
  const rec = buildRStatisticsRecord([1, -.2], 38);
  for (const experiment of [
    { rObservedCount: 2, closedDraftCount: 39 },
    { rObservedCount: 2, closedDraftCount: 40, version: 2 },
  ]) {
    const result = projectMissionTestResult(forwardRow(rec, { ...forty, expectancyR: .4 }, experiment));
    assert.match(uncertaintyNote(result), /uncertainty unavailable/);
    if (experiment.closedDraftCount === 39) assert.ok(result.notes.includes("Realised R coverage is unknown."));
  }
  const three = { ...fiveTrades, totalTrades: 3, winningTrades: 2, losingTrades: 1, expectancyR: .25 };
  const ok = projectMissionTestResult(forwardRow(buildRStatisticsRecord([1, -.5], 1), three, { rObservedCount: 2, closedDraftCount: 3 }));
  assert.match(ok.notes.join(" "), /2 of 3 closed trades/);
  const note = uncertaintyNote(ok);
  assert.match(note, /over 2 observed R values/);
  assert.match(note, /1 degree of freedom/);
  assert.match(note, /\(costs unverified\)/);
  assert.match(note, /^R sample interval/);
  // A forward count that disagrees with rStatistics.n is unavailable.
  const off = projectMissionTestResult(forwardRow(buildRStatisticsRecord([1, -.5], 1), three, { rObservedCount: 1, closedDraftCount: 3 }));
  assert.equal(uncertaintyNote(off), R_INVALID);
});

test("forward n === coverage and excludedCount === total - coverage are each enforced", () => {
  const three = { ...fiveTrades, totalTrades: 3, winningTrades: 2, losingTrades: 1, expectancyR: .25 };
  // excludedCount (1) === 3 - coverage (2), mean agrees with the headline, but n is 3, not 2.
  const nOff = buildRStatisticsRecord([1, -.5, .25], 1);
  assert.equal(nOff.status === "available" && nOff.mean, .25);
  const a = projectMissionTestResult(forwardRow(nOff, three, { rObservedCount: 2, closedDraftCount: 3 }));
  assert.match(a.notes.join(" "), /2 of 3 closed trades/);
  assert.equal(uncertaintyNote(a), R_INVALID);
  // n === coverage (2), but excludedCount 0 is not 3 - 2.
  const exclOff = projectMissionTestResult(forwardRow(buildRStatisticsRecord([1, -.5], 0), three, { rObservedCount: 2, closedDraftCount: 3 }));
  assert.equal(uncertaintyNote(exclOff), R_INVALID);
  // Control: the same values with the right counts are available.
  assert.match(uncertaintyNote(projectMissionTestResult(forwardRow(buildRStatisticsRecord([1, -.5], 1), three, { rObservedCount: 2, closedDraftCount: 3 }))), /^R sample interval/);
});

test("incoherent or edited records read as unavailable", () => {
  const base = buildRStatisticsRecord([1, -1, 2, -1, 1], 0) as Record<string, any>;
  assert.match(uncertaintyNote(projectMissionTestResult(backtestRow(base))), /^R sample interval/);
  const clone = () => structuredClone(base);
  const edits: Array<[string, () => ReturnType<typeof backtestRow>]> = [
    ["includesZero false", () => backtestRow({ ...clone(), includesZero: false })],
    ["quantile 1.96", () => backtestRow({ ...clone(), quantile: 1.96 })],
    ["SE off by 1e-4", () => backtestRow({ ...clone(), standardError: .6001 })],
    ["low shifted", () => { const r = clone(); r.interval95.low -= .001; r.interval95.low = Math.round(r.interval95.low * 1e6) / 1e6; return backtestRow(r); }],
    ["mean vs expectancyR", () => backtestRow(clone(), { ...fiveTrades, expectancyR: .41 })],
    ["n + excluded", () => backtestRow({ ...clone(), excludedCount: 1 })],
    ["low > high", () => { const r = clone(); [r.interval95.low, r.interval95.high] = [r.interval95.high, r.interval95.low]; return backtestRow(r); }],
    ["numbers as strings", () => backtestRow({ ...clone(), mean: "0.4" })],
    ["rStatistics.version 2", () => backtestRow({ ...clone(), version: 2 })],
    ["method z", () => { const r = clone(); r.interval95.method = "z"; return backtestRow(r); }],
    ["wrong engine", () => backtestRow(clone(), fiveTrades, { engine: "closed-draft-aggregate-v1" })],
    ["experiment.version 2", () => backtestRow(clone(), fiveTrades, { version: 2 })],
    ["no_variation disagreeing", () => backtestRow({ version: 1, excludedCount: 0, status: "unavailable", n: 5, reason: "no_variation", value: 1 })],
    ["unknown reason", () => backtestRow({ version: 1, excludedCount: 0, status: "unavailable", n: 5, reason: "other" })],
    ["insufficient with n 5", () => backtestRow({ version: 1, excludedCount: 0, status: "unavailable", n: 5, reason: "insufficient_observations" })],
    ["degrees of freedom", () => backtestRow({ ...clone(), degreesOfFreedom: 5 })],
    ["interval_below_precision with n 1", () => backtestRow({ version: 1, excludedCount: 4, status: "unavailable", n: 1, reason: "interval_below_precision" })],
    ["non_finite_result with n 1", () => backtestRow({ version: 1, excludedCount: 4, status: "unavailable", n: 1, reason: "non_finite_result" })],
    // Each stored statistic must already be 6-decimal rounded; each edit is otherwise coherent.
    ["unrounded mean", () => backtestRow({ ...clone(), mean: .4000001 })],
    ["unrounded sampleSd", () => backtestRow({ ...clone(), sampleSd: 1.3416408 })],
    ["unrounded standardError", () => backtestRow({ ...clone(), standardError: .6000001 })],
    ["unrounded low", () => { const r = clone(); r.interval95.low = -1.2658671; return backtestRow(r); }],
    ["unrounded high", () => { const r = clone(); r.interval95.high = 2.0658671; return backtestRow(r); }],
    // SE and bounds agree with each other, but SE is not sampleSd/sqrt(n) (1.5/sqrt(5) = 0.67).
    ["SE vs sampleSd/sqrt(n)", () => backtestRow({ ...clone(), sampleSd: 1.5 })],
    // Bounds within the (2+q)e-6 tolerance of mean ± q·SE, but the mean lies below the low bound.
    ["mean outside bounds", () => backtestRow({
      version: 1, excludedCount: 0, status: "available", n: 2, mean: 0, sampleSd: 1e-6, standardError: 1e-6,
      degreesOfFreedom: 1, quantile: 12.706205, interval95: { low: 1e-6, high: 2e-6, method: "student_t" }, includesZero: false,
    }, { ...fiveTrades, totalTrades: 2, winningTrades: 1, losingTrades: 1, winRate: .5, expectancyR: 0 })],
  ];
  for (const [label, make] of edits) {
    const note = uncertaintyNote(projectMissionTestResult(make()));
    // The exact invalid note: the no_variation and insufficient notes share its prefix.
    assert.equal(note, R_INVALID, label);
  }
});

test("legacy, unknown-provenance and invalid-metrics rows read uncertainty unavailable", () => {
  const rec = buildRStatisticsRecord([1, -1, 2, -1, 1], 0);
  const legacy = uncertaintyNote(projectMissionTestResult(row({ metrics: strong, promotionEligible: true })));
  assert.match(legacy, /uncertainty unavailable/);
  for (const evidence of [
    { version: 1, source: "market_history", validation: "verified" },
    { version: 2, source: "generated_prices", validation: "unverified" },
    CLOSED_DRAFT_EVIDENCE, "generated_prices", null,
  ]) {
    const result = projectMissionTestResult(row({ metrics: fiveTrades, evidence, experiment: { version: 1, engine: "generated-price-diagnostic-v1", rStatistics: rec } }));
    const note = uncertaintyNote(result);
    assert.match(note, /uncertainty unavailable/); assert.doesNotMatch(note, RX_INTERVAL);
  }
  for (const invalid of [null, {}, { ...fiveTrades, totalTrades: 3.1 }, { ...fiveTrades, netProfitLoss: NaN },
    { ...fiveTrades, expectancyR: Infinity }, { ...fiveTrades, winRate: 2 }, { ...fiveTrades, winningTrades: 41 },
    { ...fiveTrades, maxDrawdownPct: -2 }, { ...fiveTrades, profitFactor: -1 }]) {
    const result = projectMissionTestResult(backtestRow(rec, invalid as MissionTestMetrics));
    assert.match(result.notes[0]!, /incomplete or invalid/);
    const note = uncertaintyNote(result);
    assert.match(note, /uncertainty unavailable/); assert.doesNotMatch(note, RX_INTERVAL);
  }
});

test("projection keys and every non-notes field are unchanged by rStatistics", () => {
  const keys = ["id", "missionId", "kind", "strategyKey", "symbol", "timeframe", "label", "sampleSize", "sampleWarning",
    "isVerified", "metrics", "headline", "notes", "promotionEligible", "evidence", "createdAt"];
  const strip = ({ notes: _n, ...rest }: { notes: string[] } & Record<string, unknown>) => rest;
  const three = { ...fiveTrades, totalTrades: 3, winningTrades: 2, losingTrades: 1, expectancyR: .25 };
  const pairs = [
    [backtestRow(buildRStatisticsRecord([1, -1, 2, -1, 1], 0)), backtestRow(undefined)],
    [forwardRow(buildRStatisticsRecord([1, -.5], 1), three, { rObservedCount: 2, closedDraftCount: 3 }),
      forwardRow(undefined, three, { rObservedCount: 2, closedDraftCount: 3 })],
  ] as const;
  for (const [withStats, without] of pairs) {
    const a = projectMissionTestResult(withStats); const b = projectMissionTestResult(without);
    assert.deepEqual(Object.keys(a), keys);
    assert.deepEqual(strip(a), strip(b));
    assert.equal(a.promotionEligible, false);
    assert.deepEqual(a.notes.filter((n) => !RX_UNCERTAINTY.test(n)), b.notes.filter((n) => !RX_UNCERTAINTY.test(n)));
  }
  const [[bt, btPlain], [fw, fwPlain]] = pairs;
  assert.deepEqual(
    detectMissionDrift({ historical: projectMissionTestResult(bt).metrics, forward: projectMissionTestResult(fw).metrics }),
    detectMissionDrift({ historical: projectMissionTestResult(btPlain).metrics, forward: projectMissionTestResult(fwPlain).metrics }),
  );
});

test("every new uncertainty note passes the banned-vocabulary scan", () => {
  assert.ok(allNotes.length > 20);
  assert.equal(checkMissionCopyDeep(allNotes).ok, true, JSON.stringify(checkMissionCopyDeep(allNotes).violations));
});
