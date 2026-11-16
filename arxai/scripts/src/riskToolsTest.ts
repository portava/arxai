// Test: the pre-trade risk tools (lib/risk tradeGates.ts), the trade geometry of
// every strategy on real bars, and the measured risk-tool results.
//
// Claims:
//   1. The tools can only refuse or shrink. Cost is measured in R; an entry at
//      its stop, a NaN cost, a missing forecast all REFUSE rather than pass.
//   2. Every actionable call from every strategy on real H1 bars has its stop
//      and target on the correct sides of the entry (Break of Structure used to
//      emit 98 impossible BUYs/SELLs).
//   3. docs/RISK_TOOLS_RESULTS.md is exactly what the code measures, and the
//      honest shape holds: the gates reduce the loss, and no gate turns the
//      strategies' net expectancy positive.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  roundTripCostR, costGate, quietGate, sigmaExpectedFromVariance, quantile, volTargetBaseFrac, DEFAULT_MAX_COST_R,
} from "@workspace/risk";
import { REPLAYABLE_STRATEGIES, REPLAY_WINDOW } from "../../artifacts/api-server/src/lib/calibration/strategyReplay.js";
import { loadVerifiedMarketsFixture } from "./research/marketsHistoryFixture.js";
import { runRiskToolsResearch, renderRiskToolsMarkdown } from "./research/riskToolsResearch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = join(HERE, "..", "..", "docs", "RISK_TOOLS_RESULTS.md");
/** Pinned from the one research run on the pinned fixture. Change only on purpose. */
const PINNED_RESULT_HASH = "e349d78feede24dcd59dc6d653d24b4139ea91efed8382b5010f71bae68e68ab";

let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log(`ok - ${name}`); };

t("cost in R: a 1-pip round trip on a 3-pip stop is a third of the risk", () => {
  // EURUSD 1.1000, half-spread 0.5 pip = 0.00005 absolute = 0.00005/1.1 fraction; stop 3 pips away.
  const half = 0.00005 / 1.1;
  const c = roundTripCostR(1.1, 1.1 - 0.0003, half);
  assert.ok(Math.abs(c - 1 / 3) < 1e-9, `got ${c}`);
  assert.equal(roundTripCostR(1.1, 1.1, half), Number.POSITIVE_INFINITY);
  assert.equal(roundTripCostR(0, 1, half), Number.POSITIVE_INFINITY);
});

t("cost gate refuses expensive, infinite and NaN cost; passes cheap", () => {
  assert.equal(costGate(0.05).allow, true);
  assert.equal(costGate(DEFAULT_MAX_COST_R).allow, true);
  assert.equal(costGate(0.11).reason, "COST_TOO_HIGH");
  assert.equal(costGate(Number.POSITIVE_INFINITY).reason, "NO_RISK_DISTANCE");
  assert.equal(costGate(Number.NaN).allow, false);
});

t("quiet gate refuses below the threshold and when there is no forecast", () => {
  assert.equal(quietGate(2, 1).allow, true);
  assert.equal(quietGate(0.5, 1).reason, "QUIET_MARKET");
  assert.equal(quietGate(Number.NaN, 1).reason, "NO_FORECAST");
  assert.equal(quietGate(1, Number.NaN).reason, "NO_FORECAST");
  assert.equal(quietGate(0, 1).allow, false);
});

t("invalid numerical inputs cannot turn risk research gates into approvals", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(roundTripCostR(1, bad, 0.01), Infinity);
    assert.equal(roundTripCostR(bad, 0.9, 0.01), Infinity);
    assert.equal(roundTripCostR(1, 0.9, bad), Infinity);
    assert.equal(costGate(1, bad).allow, false);
    assert.equal(quietGate(bad, 1).allow, false);
    assert.equal(quietGate(1, bad).allow, false);
  }
  assert.equal(roundTripCostR(1, 0.9, -0.01), Infinity);
  assert.equal(roundTripCostR(1e308, -1e308, 0.01), Infinity);
  assert.equal(costGate(-1).reason, "INVALID_COST");
  assert.equal(costGate(0, -1).allow, false);
  // A measured zero spread and a zero cost allowance are valid boundaries.
  assert.equal(roundTripCostR(1, 0.9, 0), 0);
  assert.equal(costGate(0, 0).allow, true);
  assert.equal(quietGate(1, 1).allow, true);
});

t("sigma from a variance feeds volTargetBaseFrac; a bad variance sizes to exactly 0", () => {
  assert.equal(sigmaExpectedFromVariance(4e-6), 2e-3);
  assert.equal(volTargetBaseFrac({ targetRiskFrac: 0.01, sigmaTarget: 1e-3, sigmaExpected: sigmaExpectedFromVariance(Number.NaN) }).baseFrac, 0);
  assert.equal(volTargetBaseFrac({ targetRiskFrac: 0.01, sigmaTarget: 1e-3, sigmaExpected: sigmaExpectedFromVariance(4e-6) }).baseFrac, 0.005);
  assert.equal(quantile([3, 1, 2, 4, 5], 0.5), 3);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

t("every actionable call from every strategy on real H1 bars has a valid stop/target geometry", () => {
  const { instruments } = loadVerifiedMarketsFixture(join(HERE, "..", "fixtures"));
  let checked = 0;
  for (const inst of instruments.filter((i) => i.spec.timeframe === "H1")) {
    const c = inst.bars.map((b, k) => ({ time: inst.dates[k]!, open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 }));
    for (let i = REPLAY_WINDOW; i < c.length; i++) {
      for (const s of REPLAYABLE_STRATEGIES) {
        const g = s.fn(c.slice(i - REPLAY_WINDOW + 1, i + 1), inst.spec.symbol);
        if (g.direction !== "BUY" && g.direction !== "SELL") continue;
        checked++;
        const ok = g.direction === "BUY"
          ? g.stopLoss < g.entryPrice && g.entryPrice < g.takeProfit
          : g.takeProfit < g.entryPrice && g.entryPrice < g.stopLoss;
        assert.ok(ok, `${s.name} ${g.direction} on ${inst.spec.symbol} H1 @${inst.dates[i]}: entry ${g.entryPrice} stop ${g.stopLoss} target ${g.takeProfit}`);
      }
    }
  }
  assert.ok(checked > 10000, `only ${checked} calls checked`);
});

const r = runRiskToolsResearch();

t("risk-tool results reproduce the pinned run", () => {
  assert.equal(r.resultHash, PINNED_RESULT_HASH);
});

t("honest shape: gates reduce the loss; nothing turns net expectancy positive", () => {
  const all = r.variants.find((v) => v.key === "all trades")!;
  const both = r.variants.find((v) => v.key === "both gates")!;
  assert.ok(both.kept.mean > all.kept.mean, "both gates should lose less per trade than no gate");
  for (const v of r.variants) assert.ok(v.kept.hi95 < 0, `${v.key}: the 95% CI reaches ${v.kept.hi95}; the doc says it is negative`);
  for (const s of r.strategies) assert.ok(s.all.mean < 0, `${s.strategy}: net expectancy ${s.all.mean} is not negative; the doc says it is`);
});

t("the results doc is exactly what the code measures", () => {
  assert.equal(readFileSync(DOC, "utf8").split("\n## Reading these results")[0]!.trimEnd(), renderRiskToolsMarkdown(r).trimEnd());
});

console.log(`\n${passed} passed`);
