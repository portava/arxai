import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreStrategyEdge, type ConfidenceGateContext, type StrategyEdgeStats } from "@workspace/domain/confidence-gate";

const NOW = new Date("2026-01-31T12:00:00.000Z");
const valid: StrategyEdgeStats = {
  strategyName: "offline fixture", backtestWinRate: 0.65,
  backtestProfitFactor: 2.5, backtestSampleSize: 200,
  backtestExpectancyR: 0.5, lastBacktestAt: NOW.toISOString(),
  recentLiveWinRate: null, recentLiveSampleSize: 0,
};
function score(patch: Partial<StrategyEdgeStats> = {}, now: Date = NOW) {
  // This isolated scorer reads only strategyStats and the evaluation clock.
  return scoreStrategyEdge({ strategyStats: { ...valid, ...patch }, now } as ConfidenceGateContext);
}

test("fresh evidence is evaluated against the supplied clock", () => {
  const report = score();
  assert.equal(report.score, 100);
  assert.equal(report.evidence.backtestAgeDays, 0);
  assert.deepEqual(report.blockers, []);
});
test("omitted evaluation clock uses the current time", (t) => {
  t.mock.method(Date, "now", () => NOW.getTime());
  const report = scoreStrategyEdge({ strategyStats: valid } as ConfidenceGateContext);
  assert.equal(report.score, 100);
  assert.equal(report.evidence.backtestAgeDays, 0);
});
test("equivalent explicitly zoned timestamps give identical evidence", () => {
  assert.deepEqual(score({ lastBacktestAt: "2026-01-31T07:00:00-05:00" }), score());
});
test("recency uses the existing linear rule and stale warning", () => {
  assert.equal(score({ lastBacktestAt: "2026-01-01T12:00:00Z" }).score, 95);
  const old = score({ lastBacktestAt: "2025-11-01T12:00:00Z" });
  assert.equal(old.score, 90);
  assert.equal(old.blockers.length, 0);
  assert.equal(old.warnings.length, 1);
});
test("existing sample and net-loss blockers remain", () => {
  const report = score({ backtestSampleSize: 29, backtestProfitFactor: 0.9, backtestExpectancyR: -0.1 });
  assert.equal(report.blockers.length, 3);
});

const invalid: [string, Partial<StrategyEdgeStats>][] = [
  ...[NaN, Infinity, -Infinity, -0.1, 1.1].map(value => [`win rate ${value}`, { backtestWinRate: value }] as [string, Partial<StrategyEdgeStats>]),
  ...[NaN, Infinity, -Infinity, -1].map(value => [`profit factor ${value}`, { backtestProfitFactor: value }] as [string, Partial<StrategyEdgeStats>]),
  ...[NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(value => [`sample ${value}`, { backtestSampleSize: value }] as [string, Partial<StrategyEdgeStats>]),
  ...[NaN, Infinity, -Infinity].map(value => [`expectancy ${value}`, { backtestExpectancyR: value }] as [string, Partial<StrategyEdgeStats>]),
  ...["invalid", "", "2026-01-31T12:00:00", "2025-02-30T00:00:00Z", "2027-01-31T12:00:00Z", "2026-01-31T12:00:00.001Z"].map(value => [`time ${value}`, { lastBacktestAt: value }] as [string, Partial<StrategyEdgeStats>]),
];
for (const [label, patch] of invalid) {
  test(`invalid evidence is withheld: ${label}`, () => {
    const report = score(patch);
    assert.equal(report.score, 0);
    assert.ok(report.blockers.some(blocker => blocker.severity === "DATA"));
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report, "no nonfinite evidence lost during JSON serialization");
  });
}
test("invalid evaluation clock cannot manufacture a score", () => {
  const report = score({}, new Date(NaN));
  assert.equal(report.score, 0);
  assert.ok(report.blockers.some(blocker => blocker.severity === "DATA"));
});
test("valid numeric boundaries stay finite and bounded", () => {
  for (const winRate of [0, 0.45, 0.65, 1]) {
    for (const count of [0, 29, 30, 200, Number.MAX_SAFE_INTEGER]) {
      const report = score({ backtestWinRate: winRate, backtestSampleSize: count, backtestProfitFactor: Number.MAX_VALUE });
      assert.ok(Number.isFinite(report.score) && report.score >= 0 && report.score <= 100);
    }
  }
});
