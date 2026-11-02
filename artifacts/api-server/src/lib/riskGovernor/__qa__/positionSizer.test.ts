// One position-sizing formula: the domain engine (lotForRisk) and the API
// value models that call it. Pure: no DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runApprove } from "@workspace/domain/pipeline";
import type { PipelineContext } from "@workspace/domain/pipeline";
import { calcLotSize, clampLotToStep, lotForRisk } from "@workspace/domain/risk";
import { calculatePaperPositionSize, calculatePositionSize, PAPER_DEFAULTS } from "../positionSizer.js";

test("lotForRisk: budget / (stop × value per unit), floored to the step without exceeding the budget", () => {
  // $100 at a 0.0050 stop, $100,000 per unit per lot (EURUSD standard lot) → 0.2 lot.
  const r = lotForRisk({ riskAmount: 100, stopDistance: 0.005, valuePerUnitPerLot: 100_000 });
  assert.equal(r.lot, 0.2);
  assert.equal(r.invalid, null);
  assert.equal(lotForRisk({ riskAmount: 1, stopDistance: 1, valuePerUnitPerLot: 1000 }).lot, 0, "a broker minimum cannot enlarge the risk budget");
  assert.equal(lotForRisk({ riskAmount: 1, stopDistance: 1, valuePerUnitPerLot: 1000 }).invalid, "minimum lot exceeds risk budget");
  assert.equal(lotForRisk({ riskAmount: 1e6, stopDistance: 1, valuePerUnitPerLot: 1, maxLot: 5 }).lot, 5);
  for (const bad of [{ riskAmount: 0 }, { stopDistance: 0 }, { valuePerUnitPerLot: -1 }]) {
    const r2 = lotForRisk({ riskAmount: 10, stopDistance: 1, valuePerUnitPerLot: 1, ...bad });
    assert.equal(r2.lot, 0);
    assert.ok(r2.invalid);
  }
});

test("clampLotToStep floors without float drift and honours the step", () => {
  assert.equal(clampLotToStep(0.3, 0.01, 0.01, 100).lot, 0.3, "0.3 / 0.01 must not floor to 0.29");
  assert.equal(clampLotToStep(1.27, 0.1, 0.1, 100).lot, 1.2);
  assert.equal(clampLotToStep(1.26, 0.1, 0.1, 100, "nearest").lot, 1.3);
});

test("calcLotSize (pipeline approve stage) is the engine with a pip value model", () => {
  const r = calcLotSize({ accountBalance: 10_000, riskPct: 1, stopLossDistance: 0.005, pipSize: 0.0001, pipValuePerLot: 10 });
  assert.equal(r.recommendedLot, 0.2);
  assert.equal(r.stopLossPips, 50);
});

test("instrument-class calculator keeps its contract", () => {
  const fx = calculatePositionSize({ accountBalance: 10_000, riskPercent: 1, entry: 1.1, stopLoss: 1.095, symbol: "EURUSD" });
  assert.equal(fx.finalLot, 0.2);
  assert.equal(fx.warning, null);
  const jpy = calculatePositionSize({ accountBalance: 10_000, riskPercent: 1, entry: 150, stopLoss: 149.5, symbol: "USDJPY" });
  assert.equal(jpy.finalLot, 0.2);
  const syn = calculatePositionSize({ accountBalance: 1_000, riskPercent: 2, entry: 1000, stopLoss: 990, symbol: "Volatility 75 Index" });
  assert.equal(syn.finalLot, 2);
  const s1 = calculatePositionSize({ accountBalance: 1_000, riskPercent: 2, entry: 1000, stopLoss: 990, symbol: "Volatility 75 (1s) Index" });
  assert.equal(s1.finalLot, 1, "V75 (1s) halves the lot");
  assert.match(s1.warning ?? "", /halved/);
  const capped = calculatePositionSize({ accountBalance: 1e6, riskPercent: 5, entry: 1000, stopLoss: 999, symbol: "Boom 500", maxLotSize: 3 });
  assert.equal(capped.finalLot, 3);
  assert.match(capped.warning ?? "", /capped/);
  const tiny = calculatePositionSize({ accountBalance: 10, riskPercent: 1, entry: 1.1, stopLoss: 1.0, symbol: "EURUSD" });
  assert.equal(tiny.suggestedLot, 0);
  assert.match(tiny.warning ?? "", /minimum/);
  const zero = calculatePositionSize({ accountBalance: 10_000, riskPercent: 1, entry: 1.1, stopLoss: 1.1, symbol: "EURUSD" });
  assert.equal(zero.finalLot, 0);
  assert.match(zero.warning ?? "", /zero/);
});

test("paper calculator keeps its contract", () => {
  const ok = calculatePaperPositionSize({ accountEquity: 10_000, entryPrice: 100, stopLoss: 99 });
  assert.equal(ok.capped_position_size, 1, "1% of 10k over a 1.0 stop at 100 per point");
  assert.equal(ok.reason, "ok");
  const cap = calculatePaperPositionSize({ accountEquity: 1e6, entryPrice: 100, stopLoss: 99.9 });
  assert.equal(cap.capped_position_size, PAPER_DEFAULTS.maxLotSize);
  assert.match(cap.reason, /capped/);
  const noStop = calculatePaperPositionSize({ accountEquity: 10_000, entryPrice: 100, stopLoss: 100 });
  assert.equal(noStop.capped_position_size, 0);
  assert.match(noStop.reason, /stop distance/);
});


test("pipeline sizing preserves three-decimal broker volume without rounding risk up", () => {
  const r = calcLotSize({ accountBalance: 156, riskPct: 1, stopLossDistance: 1, pipSize: 1, pipValuePerLot: 100, minLot: 0.001, lotStep: 0.001 });
  assert.equal(r.recommendedLot, 0.015);
  assert.ok(r.recommendedLot * 100 <= r.riskAmount);
});

test("risk sizing never rounds a nearest step above the supplied budget", () => {
  const r = lotForRisk({ riskAmount: 1.26, stopDistance: 1, valuePerUnitPerLot: 1, minLot: 0.1, lotStep: 0.1, rounding: "nearest" });
  assert.equal(r.lot, 1.2);
  assert.equal(r.invalid, null);
});

for (const [name, patch] of Object.entries({
  nanMin: { minLot: NaN }, infiniteMax: { maxLot: Infinity }, nanMax: { maxLot: NaN }, negativeMax: { maxLot: -1 },
  reversedBounds: { minLot: 2, maxLot: 1 }, zeroStep: { lotStep: 0 }, nanStep: { lotStep: NaN },
  infiniteStep: { lotStep: Infinity }, tinyStep: { lotStep: 1e-101 },
  overflowCost: { stopDistance: 1e308, valuePerUnitPerLot: 1e308 },
  underflowCost: { stopDistance: 1e-308, valuePerUnitPerLot: 1e-308 },
})) {
  test(`invalid sizing metadata or arithmetic is withheld: ${name}`, () => {
    const r = lotForRisk({ riskAmount: 100, stopDistance: 1, valuePerUnitPerLot: 100, ...patch });
    assert.equal(r.lot, 0);
    assert.ok(r.invalid);
    assert.ok(Number.isFinite(r.rawLot));
  });
}

test("pip sizing never returns non-finite money or distance as a valid result", () => {
  for (const key of ["accountBalance", "riskPct", "stopLossDistance", "pipSize", "pipValuePerLot"]) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const r = calcLotSize({ accountBalance: 10_000, riskPct: 1, stopLossDistance: 1, pipSize: 1, pipValuePerLot: 100, [key]: value });
      assert.equal(r.recommendedLot, 0, `${key}=${value}`);
      assert.ok([r.riskAmount, r.stopLossPips].every(Number.isFinite));
      assert.ok(r.notes.length > 0);
    }
  }
});

test("API models never replace invalid or unaffordable size with a minimum order", () => {
  for (const value of [0, -1, NaN, Infinity]) {
    const paper = calculatePaperPositionSize({ accountEquity: value, entryPrice: 100, stopLoss: 99 });
    assert.equal(paper.capped_position_size, 0, `paper equity ${value}`);
    assert.notEqual(paper.reason, "ok");
    const instrument = calculatePositionSize({ accountBalance: value, riskPercent: 1, entry: 100, stopLoss: 99, symbol: "Boom 500" });
    assert.equal(instrument.finalLot, 0, `instrument balance ${value}`);
    assert.ok(instrument.warning);
  }
  const paper = calculatePaperPositionSize({ accountEquity: 10, entryPrice: 100, stopLoss: 99 });
  assert.equal(paper.capped_position_size, 0);
  assert.match(paper.reason, /minimum|budget/);
});

test("the instrument cap stays on the volume grid and below the cap", () => {
  const r = calculatePositionSize({ accountBalance: 1000, riskPercent: 1, entry: 100, stopLoss: 99, symbol: "Boom 500", maxLotSize: 0.015 });
  assert.equal(r.finalLot, 0.01);
});

test("bounded risk holds across step sizes, budgets and caps", () => {
  for (const step of [0.001, 0.01, 0.1, 0.25, 1]) {
    for (const budget of [0.001, 0.1, 1, 1.26, 15.6, 100, 1000]) {
      for (const maxLot of [0.005, 0.015, 0.5, 1.25, 100]) {
        for (const rounding of ["floor", "nearest"] as const) {
          const r = lotForRisk({ riskAmount: budget, stopDistance: 2, valuePerUnitPerLot: 5, minLot: step, maxLot, lotStep: step, rounding });
          assert.ok(Number.isFinite(r.lot));
          if (r.invalid) { assert.equal(r.lot, 0); continue; }
          assert.ok(r.lot >= step && r.lot <= maxLot, JSON.stringify({step,budget,maxLot,r}));
          assert.ok(r.lot * 10 <= budget + Number.EPSILON * Math.max(1,budget) * 16);
          assert.ok(Math.abs(r.lot / step - Math.round(r.lot / step)) < 1e-8);
        }
      }
    }
  }
});


test("approval composition cannot authorize a sub-minimum risk budget", () => {
  // Only the fields read by this pure sizing stage are populated; no execution port exists.
  const ctx = {
    signal: { entry: 100, stopLoss: 99, takeProfit: 102 },
    account: { account: { balance: 1 } },
    riskProfile: { limits: { riskPerTradePct: 1, minConfidenceScore: 50, maxOpenTrades: 5 } },
    openTrades: [], drawdown: null, source: "offline-sizing-test",
  } as unknown as PipelineContext;
  const decision = { verdict: "APPROVE" as const, confidence: 90, reasoning: "fixture", factors: [], blockers: [], cautions: [] };
  const rejected = runApprove(ctx, { decision, pipSize: 1, pipValuePerLot: 100 });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.output, null);
  assert.match(rejected.reasons.join(" "), /minimum.*budget/);
  ctx.account.account!.balance = 156;
  const approved = runApprove(ctx, { decision, pipSize: 1, pipValuePerLot: 100, minLot: 0.001, lotStep: 0.001 });
  assert.equal(approved.status, "PASSED");
  assert.equal(approved.output!.approvedLotSize, 0.015);
  assert.match(approved.reasons.join(" "), /risk budget/);
});

test("API sizing models and domain math agree for equivalent money-per-unit inputs", () => {
  for (const budget of [0.001, 0.1, 1.265, 15.6, 100]) {
    const domain = lotForRisk({ riskAmount: budget, stopDistance: 1, valuePerUnitPerLot: 100, maxLot: 5 });
    const paper = calculatePaperPositionSize({ accountEquity: budget * 100, entryPrice: 100, stopLoss: 99 });
    const pip = calcLotSize({ accountBalance: budget * 100, riskPct: 1, stopLossDistance: 1, pipSize: 1, pipValuePerLot: 100, maxLot: 5 });
    // Instrument-class synthetic model is 1 per unit, so a 100-unit stop is equivalent.
    const instrument = calculatePositionSize({ accountBalance: budget * 100, riskPercent: 1, entry: 200, stopLoss: 100, symbol: "Boom 500", maxLotSize: 5 });
    assert.equal(paper.capped_position_size, domain.lot);
    assert.equal(pip.recommendedLot, domain.lot);
    assert.equal(instrument.finalLot, domain.lot);
  }
});

test("risk multiplication overflow cannot authorize an infinite loss", () => {
  const r = lotForRisk({ riskAmount: Number.MAX_VALUE, stopDistance: 1e308, valuePerUnitPerLot: 1, minLot: 1, maxLot: 10, lotStep: 1, rounding: "nearest" });
  assert.equal(r.lot, 1);
  assert.equal(r.invalid, null);
  assert.ok(Number.isFinite(r.lot * 1e308));
});

test("minimum affordability uses the same roundoff bound as the final risk check", () => {
  const r = lotForRisk({ riskAmount: 0.3, stopDistance: 0.1, valuePerUnitPerLot: 3, minLot: 1, maxLot: 10, lotStep: 1 });
  assert.equal(r.lot, 1);
  assert.equal(r.invalid, null);
});


test("a bounded instrument size never contradicts its no-size warning", () => {
  const r = calculatePositionSize({ accountBalance: 1e17, riskPercent: 1, entry: 100, stopLoss: 99, symbol: "Boom 500", maxLotSize: 10 });
  assert.equal(r.finalLot, 10);
  assert.equal(r.suggestedLot, 10);
  assert.doesNotMatch(r.warning ?? "", /No size/);
  assert.match(r.warning ?? "", /bounded|cap/i);
});
