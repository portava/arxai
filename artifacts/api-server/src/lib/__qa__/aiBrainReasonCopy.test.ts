// Truth regression: the scanner's reason text must describe what the rules
// actually found. "spread ok" was hard-coded even when spread_acceptable
// failed, reasonToAvoid listed raw snake_case rule codes, and a constant
// reward-to-risk (TP placed at exactly 2× the stop) was reported as a passed
// "min_risk_reward_1.5" check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMarketFromCandles, type AnalysisCandle } from "../aiBrain.js";

function uptrend(n = 30, start = 1.08, step = 0.0004): AnalysisCandle[] {
  const out: AnalysisCandle[] = [];
  for (let i = 0; i < n; i++) {
    const c = start + step * i;
    out.push({ o: c - step * 0.5, h: c + 0.0002, l: c - step * 0.5 - 0.0002, c });
  }
  return out;
}

test("wide spread: reasonForTrade does not say 'spread ok' when spread_acceptable failed", () => {
  const candles = uptrend();
  const mid = candles[candles.length - 1]!.c;
  // spreadPenalty = spread / mid * 100000 → 0.0005 / 1.09 * 1e5 ≈ 46 ≥ 30.
  const a = analyzeMarketFromCandles("EURUSD", "M5", candles, { mid, spread: 0.0005 }, "LIVE_FEED", "mt5_broker");
  assert.ok(a.rulesFailed.includes("spread_acceptable"), `expected spread rule to fail: ${a.rulesFailed}`);
  assert.doesNotMatch(a.reasonForTrade, /spread ok/i);
  assert.match(a.reasonForTrade, /spread/i);
});

test("reasonToAvoid is plain English, not raw rule codes", () => {
  const candles = uptrend(30, 1.08, 0.00001);
  const mid = candles[candles.length - 1]!.c;
  const a = analyzeMarketFromCandles("EURUSD", "M5", candles, { mid, spread: 0.0005 }, "LIVE_FEED", "mt5_broker");
  assert.ok(a.rulesFailed.length > 0);
  assert.notEqual(a.reasonToAvoid, "");
  assert.doesNotMatch(a.reasonToAvoid, /[a-z]+_[a-z0-9_>=.]+/, `raw code leaked: ${a.reasonToAvoid}`);
  assert.doesNotMatch(a.reasonToAvoid, /Failed rules:/);
});

test("constant reward-to-risk is not reported as a passed check", () => {
  const candles = uptrend();
  const mid = candles[candles.length - 1]!.c;
  const a = analyzeMarketFromCandles("EURUSD", "M5", candles, { mid, spread: 0.00001 }, "LIVE_FEED", "mt5_broker");
  assert.ok(!a.rulesPassed.includes("min_risk_reward_1.5"), `tautological RR rule listed: ${a.rulesPassed}`);
  assert.doesNotMatch(a.reasonForTrade, /spread ok/i);
  assert.match(a.reasonForTrade, /spread acceptable|spread within/i);
  assert.match(a.reasonForTrade, /2× the stop|twice the stop/i);
});
