// One position-sizing formula: the domain engine (lotForRisk) and the API
// value models that call it. Pure: no DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcLotSize, clampLotToStep, lotForRisk } from "@workspace/domain/risk";
import { calculatePaperPositionSize, calculatePositionSize, PAPER_DEFAULTS } from "../positionSizer.js";

test("lotForRisk: budget / (stop × value per unit), floored to the step and clamped", () => {
  // $100 at a 0.0050 stop, $100,000 per unit per lot (EURUSD standard lot) → 0.2 lot.
  const r = lotForRisk({ riskAmount: 100, stopDistance: 0.005, valuePerUnitPerLot: 100_000 });
  assert.equal(r.lot, 0.2);
  assert.equal(r.invalid, null);
  assert.equal(lotForRisk({ riskAmount: 1, stopDistance: 1, valuePerUnitPerLot: 1000 }).lot, 0.01, "below min clamps to min");
  assert.equal(lotForRisk({ riskAmount: 1, stopDistance: 1, valuePerUnitPerLot: 1000 }).clampedToMin, true);
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
  assert.equal(tiny.suggestedLot, 0.01);
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
  assert.equal(noStop.capped_position_size, PAPER_DEFAULTS.minLotSize);
  assert.match(noStop.reason, /stop distance/);
});

test("the instrument-class calculator says which value model sized the lot, and that it is an estimate", () => {
  // Gold: 100 oz per lot ≈ $100 per 1.0 move per lot, so $10 at a 5.00 stop is 0.02 lots.
  // The class model treats XAUUSD as a forex pair (100,000 per 1.0 per lot) and clamps to 0.01.
  const gold = calculatePositionSize({ symbol: "XAUUSD", accountBalance: 1000, riskPercent: 1, entry: 2000, stopLoss: 1995 });
  assert.equal(gold.suggestedLot, 0.01, "the sized number itself is unchanged");
  assert.equal(gold.valueModel, "unknown_contract");
  assert.equal(gold.estimate, true);
  assert.equal(gold.valuePerUnitPerLot, 100_000);
  assert.match(gold.basis, /XAUUSD is not a currency pair this calculator knows/);
  assert.match(gold.basis, /not usable/);
  assert.equal(calculatePositionSize({ symbol: "BTCUSD", accountBalance: 1000, riskPercent: 1, entry: 60000, stopLoss: 59000 }).valueModel, "unknown_contract");

  const eurgbp = calculatePositionSize({ symbol: "EURGBP", accountBalance: 10_000, riskPercent: 1, entry: 0.85, stopLoss: 0.845 });
  assert.equal(eurgbp.valueModel, "forex_other_quote");
  assert.equal(eurgbp.estimate, true);
  assert.match(eurgbp.basis, /pip value is in GBP, not USD/);

  const eurusd = calculatePositionSize({ symbol: "EURUSD", accountBalance: 10_000, riskPercent: 1, entry: 1.1, stopLoss: 1.095 });
  assert.equal(eurusd.valueModel, "forex_usd_quote");
  assert.equal(eurusd.estimate, false);
  assert.equal(eurusd.finalLot, 0.2);

  const v75 = calculatePositionSize({ symbol: "Volatility 75 (1s) Index", accountBalance: 1_000, riskPercent: 2, entry: 1000, stopLoss: 990 });
  assert.equal(v75.valueModel, "synthetic_per_point");
  assert.equal(v75.estimate, true);
  assert.match(v75.basis, /\$2 per 1\.0 price move/, "the basis states the halved-lot value actually used");

  const us30 = calculatePositionSize({ symbol: "US30", accountBalance: 10_000, riskPercent: 1, entry: 40000, stopLoss: 39900 });
  assert.equal(us30.valueModel, "per_point");
  assert.equal(us30.estimate, true);

  const zero = calculatePositionSize({ symbol: "XAUUSD", accountBalance: 1000, riskPercent: 1, entry: 2000, stopLoss: 2000 });
  assert.equal(zero.valueModel, "unknown_contract", "a zero-stop result still carries the disclosure");
});
