import { test } from "node:test";
import assert from "node:assert/strict";
import { runCausalResearch, ResearchInputError, MAX_RESEARCH_BARS } from "@workspace/domain/backtest/research";
import { simulateBacktest } from "@workspace/domain/backtest";
import { input, config, researchBars, workload, workloadConfig, STEP } from "./causalResearch.fixture.js";
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const clone = <T>(value: T): T => structuredClone(value);

test("decisions observe closed prices and execute only at next observed open", () => {
  const source = input(), out = runCausalResearch(source, config()), phase = out.partitions[0]!;
  assert.equal(phase.decisions[0]!.signalIndex, 1);
  assert.equal(phase.decisions[0]!.knownThroughMs, 2 * STEP);
  assert.equal(phase.openPosition?.entryIndex, 2);
  assert.equal(phase.openPosition?.entryPrice, 102);
  assert.equal(phase.openPosition?.exitScheduledForNextOpen, true);
  assert.equal(phase.trades.length, 0); // end of partition is not an exit tick
});
test("fixed partitions never carry pending signals or open positions forward", () => {
  const out = runCausalResearch(input(), config());
  assert.equal(out.partitions[0]!.openPosition?.entryIndex, 2);
  assert.equal(out.partitions[1]!.decisions[0]!.signalIndex, 4);
  assert.equal(out.partitions[1]!.openPosition?.entryIndex, 5);
  assert.equal(out.partitions[2]!.decisions[0]!.signalIndex, 6);
  for (const phase of out.partitions) for (const trade of phase.trades) {
    assert.ok(trade.signalIndex >= phase.fromInclusive);
    assert.ok(trade.entryIndex > trade.signalIndex && trade.exitIndex < phase.toExclusive);
  }
});
test("mutating every validation/holdout price cannot change the training trace", () => {
  const source = workload(100), cfg = workloadConfig(100), before = runCausalResearch(source, cfg);
  const changed = clone(source);
  changed.bars = changed.bars.map((b, i) => i < 60 ? b : { ...b, open: 1000, high: 1001, low: 999, close: 1000 });
  const after = runCausalResearch(changed, cfg);
  assert.deepEqual(after.partitions[0], before.partitions[0]);
  assert.notEqual(after.fingerprints.input, before.fingerprints.input);
  assert.equal(after.fingerprints.configuration, before.fingerprints.configuration);
});
test("holdout mutation cannot change training or validation outputs", () => {
  const source = workload(200), cfg = workloadConfig(200), before = runCausalResearch(source, cfg);
  const changed = clone(source);
  changed.bars = changed.bars.map((b, i) => i < 160 ? b : { ...b, open: 3, high: 4, low: 2, close: 3 });
  const after = runCausalResearch(changed, cfg);
  assert.deepEqual(after.partitions.slice(0, 2), before.partitions.slice(0, 2));
});
test("future changes leave earlier decisions and completed observations unchanged", () => {
  const source = workload(300), cfg = workloadConfig(300), before = runCausalResearch(source, cfg);
  const changed = clone(source);
  changed.bars = changed.bars.map((b, i) => i < 90 ? b : { ...b, open: b.open + 20, high: b.high + 20, low: b.low + 20, close: b.close + 20 });
  const after = runCausalResearch(changed, cfg);
  assert.deepEqual(after.partitions[0]!.decisions.filter(d => d.signalIndex < 89), before.partitions[0]!.decisions.filter(d => d.signalIndex < 89));
  assert.deepEqual(after.partitions[0]!.markedCurve.filter(p => p.index < 90), before.partitions[0]!.markedCurve.filter(p => p.index < 90));
  assert.deepEqual(after.partitions[0]!.trades.filter(t => t.exitIndex < 90), before.partitions[0]!.trades.filter(t => t.exitIndex < 90));
});
test("long entry cannot profit from the signal bar's earlier high", () => {
  const bars = researchBars([100, 101, 102, 103, 104, 105, 106, 107, 108]);
  bars[1]!.high = 500;
  const out = runCausalResearch(input(bars), config());
  assert.equal(out.partitions[0]!.trades.length, 0);
  assert.equal(out.partitions[0]!.openPosition?.entryPrice, 102);
});
test("BUY and SELL charge spread/slippage exactly once through side prices", () => {
  for (const side of [1, -1]) {
    const bars = researchBars([100, 100 + side, 100 + 2 * side, 100 + 2 * side, 100 + 2 * side, 100 + 2 * side, 100, 100, 100, 100]);
    const cfg = config({ splits: { trainEndExclusive: 6, validationEndExclusive: 8 },
      costs: { fullSpreadPriceUnits: .2, adverseSlippagePerFillPriceUnits: .05, feePerFillPriceUnits: .03 } });
    cfg.strategy.maxHoldingBars = 1;
    const trade = runCausalResearch(input(bars), cfg).partitions[0]!.trades[0]!;
    assert.equal(trade.reason, "max_hold_next_open");
    near(trade.entryPrice, bars[2]!.open + side * .15);
    near(trade.exitPrice, bars[3]!.open - side * .15);
    near(trade.netPriceUnits, -.36);
    near(trade.grossPriceUnits - trade.spreadCostPriceUnits - trade.slippageCostPriceUnits - trade.feeCostPriceUnits, trade.netPriceUnits);
  }
});
test("cost-aware open observation remains unresolved and is not a completed zero", () => {
  const bars = researchBars([100, 101, 102, 102, 102, 102, 102, 102, 102]);
  const cfg = config({ costs: { fullSpreadPriceUnits: .2, adverseSlippagePerFillPriceUnits: .05, feePerFillPriceUnits: .03 } });
  const phase = runCausalResearch(input(bars), cfg).partitions[0]!;
  assert.equal(phase.status, "open_outcome"); assert.equal(phase.metrics.completedTrades, 0);
  assert.equal(phase.metrics.winRate, null); assert.equal(phase.metrics.profitFactor, null);
  near(phase.openPosition!.netIfLiquidatedPriceUnits, -.36);
  near(phase.metrics.lastMarkedNetPriceUnits, -.36); near(phase.metrics.maxMarkedDrawdownPriceUnits, .36);
  assert.equal(phase.openPosition!.outcome, "unresolved");
});
test("dual stop/target touch chooses stop and records unknown intrabar time", () => {
  for (const side of [1, -1]) {
    const bars = researchBars([100, 100 + side, 100 + 2 * side, 100, 100, 100, 100, 100, 100]);
    bars[2]!.high = 110; bars[2]!.low = 90;
    const trade = runCausalResearch(input(bars), config()).partitions[0]!.trades[0]!;
    assert.equal(trade.reason, "stop"); assert.equal(trade.ambiguousStopAndTarget, true);
    assert.equal(trade.exitTime.precision, "bar_interval"); assert.deepEqual(trade.exitTime, { earliestMs: 2 * STEP, latestMs: 3 * STEP, precision: "bar_interval" });
    near(trade.netPriceUnits, -3);
  }
});
test("adverse stop gap fills at the worse open, not the unavailable stop price", () => {
  const bars = researchBars([100, 101, 102, 90, 90, 90, 90, 90, 90]);
  const trade = runCausalResearch(input(bars), config()).partitions[0]!.trades[0]!;
  assert.equal(trade.reason, "stop_gap"); assert.equal(trade.exitPrice, 90); assert.equal(trade.netPriceUnits, -12);
  assert.equal(trade.exitTime.precision, "open");
});
test("favorable target gaps cap improvement and do not infer a stop-first path after an opening exit", () => {
  const bars = researchBars([100, 101, 102, 120, 120, 120, 120, 120, 120]);
  bars[3]!.low = 80;
  const trade = runCausalResearch(input(bars), config()).partitions[0]!.trades[0]!;
  assert.equal(trade.reason, "target_gap_capped"); assert.equal(trade.exitPrice, 105);
  assert.equal(trade.ambiguousStopAndTarget, false);
});
test("opening protection takes precedence over a scheduled time exit; time exit cannot see later extrema", () => {
  for (const [open, expectedReason, expectedPrice] of [[120, "target_gap_capped", 105], [90, "stop_gap", 90], [103, "max_hold_next_open", 103]] as const) {
    const bars = researchBars([100, 101, 102, open, 100, 100, 100, 100, 100]);
    bars[3]!.high = 150; bars[3]!.low = 50;
    const cfg = config(); cfg.strategy.maxHoldingBars = 1;
    const trade = runCausalResearch(input(bars), cfg).partitions[0]!.trades[0]!;
    assert.equal(trade.reason, expectedReason); assert.equal(trade.exitPrice, expectedPrice);
    assert.equal(trade.exitTime.precision, "open"); assert.equal(trade.ambiguousStopAndTarget, false);
  }
});
test("reported drawdown is explicitly bar-close-based and does not assert an unobserved intrabar path", () => {
  const bars = researchBars([100, 101, 102, 103, 104, 105, 106, 107, 108]);
  bars[2]!.low = 100;
  const out = runCausalResearch(input(bars), config());
  assert.equal(out.partitions[0]!.metrics.maxMarkedDrawdownPriceUnits, 0);
  assert.match(out.limitations.join(" "), /not intrabar or entry-price excursions/);
});
test("legacy same-bar fill/gap assumptions are demonstrated, not silently upgraded", () => {
  const bars = researchBars(Array.from({ length: 60 }, (_, i) => i < 51 ? 100 : i === 51 ? 110 : 90));
  const cfg = config({ splits: { trainEndExclusive: 55, validationEndExclusive: 57 } });
  cfg.strategy.lookbackBars = 50; cfg.strategy.maxHoldingBars = 10;
  const legacy = simulateBacktest("TEST", bars.map(b => ({ ...b, time: new Date(b.openTimeMs).toISOString() })),
    (window, i) => ({ direction: i === 51 ? "BUY" : "WAIT", entryPrice: window.at(-1)!.close, stopLoss: 107, takeProfit: 113, confidence: 1, strategy: "fixture" }), 0);
  const current = runCausalResearch(input(bars), cfg);
  assert.equal(legacy.trades[0]!.entryPrice, 110); assert.equal(legacy.trades[0]!.exitPrice, 107);
  assert.equal(current.partitions[0]!.openPosition?.entryPrice, 90);
  assert.notEqual(current.partitions[0]!.openPosition?.entryTimeMs, Date.parse(legacy.trades[0]!.entryTime));
});
test("modeled liquidation-side quote, not midpoint alone, triggers protection", () => {
  const bars = researchBars([100, 101, 102, 102, 102, 102, 102, 102, 102]);
  bars[2]!.low = 101.6;
  const cfg = config({ costs: { fullSpreadPriceUnits: .4, adverseSlippagePerFillPriceUnits: 0, feePerFillPriceUnits: 0 } });
  cfg.strategy.stopDistancePriceUnits = .7; // entry ask102.2; stop bid101.5; MID low101.6 => bid101.4 touches
  const trade = runCausalResearch(input(bars), cfg).partitions[0]!.trades[0]!;
  assert.equal(trade.reason, "stop"); near(trade.exitPrice, 101.5); near(trade.netPriceUnits, -.7);
});
test("gap expiry refuses stale entry; an explicitly allowed gap uses its observed open", () => {
  const bars = researchBars([100, 101, 110, 111, 112, 113, 114, 115, 116]).map((b, i) => ({ ...b, openTimeMs: b.openTimeMs + (i >= 2 ? 5 * STEP : 0) }));
  const expired = runCausalResearch(input(bars), config());
  assert.equal(expired.gapCount, 1); assert.equal(expired.partitions[0]!.decisions[0]!.disposition, "gap_expired");
  const accepted = runCausalResearch(input(bars), config({ maxEntryGapMs: 5 * STEP }));
  assert.equal(accepted.partitions[0]!.openPosition!.entryPrice, 110);
});
test("flat, pending-only, completed and unresolved outcomes remain distinct", () => {
  const flat = runCausalResearch(input(researchBars(Array(9).fill(100))), config()).partitions[0]!;
  assert.equal(flat.status, "no_signals"); assert.equal(flat.metrics.winRate, null);
  const cfg = config(); cfg.strategy.lookbackBars = 3;
  const pending = runCausalResearch(input(), cfg).partitions[0]!;
  assert.equal(pending.status, "no_completed_trades"); assert.equal(pending.decisions[0]!.disposition, "partition_ended");
  assert.equal(pending.openPosition, null);
  const closedCfg = config(); closedCfg.strategy.maxHoldingBars = 1;
  const completed = runCausalResearch(input(), closedCfg).partitions[0]!;
  assert.equal(completed.status, "completed"); assert.equal(completed.trades.length, 1);
});
test("snapshots are independent, recursively frozen and reproducibly hashed", () => {
  const source = input(), cfg = config(), out = runCausalResearch(source, cfg);
  assert.deepEqual(runCausalResearch(clone(source), clone(cfg)), out);
  assert.equal(Object.isFrozen(out.inputSnapshot.bars[0]), true); assert.equal(Object.isFrozen(out.partitions[0]!.decisions[0]), true);
  assert.throws(() => { (out.inputSnapshot.bars[0] as any).close = 999; }, TypeError);
  source.bars[0]!.close = 100.005; cfg.costs.feePerFillPriceUnits = 1;
  assert.equal(out.inputSnapshot.bars[0]!.close, 100); assert.equal(out.configSnapshot.costs.feePerFillPriceUnits, 0);
  assert.match(out.fingerprints.result, /^[a-f0-9]{64}$/);
});
test("source/config/result fingerprints change independently and ignore caller key order", () => {
  const source = input(), cfg = config(), out = runCausalResearch(source, cfg);
  const reordered = Object.fromEntries(Object.entries(source).reverse()) as unknown as typeof source;
  assert.deepEqual(runCausalResearch(reordered, cfg).fingerprints, out.fingerprints);
  const costChange = config(); costChange.costs.feePerFillPriceUnits = .1;
  const costOut = runCausalResearch(source, costChange);
  assert.equal(costOut.fingerprints.input, out.fingerprints.input); assert.equal(costOut.fingerprints.strategy, out.fingerprints.strategy);
  assert.notEqual(costOut.fingerprints.configuration, out.fingerprints.configuration); assert.notEqual(costOut.fingerprints.result, out.fingerprints.result);
  const changedSource = clone(source); changedSource.source.kind = "historical_unattested";
  assert.notEqual(runCausalResearch(changedSource, cfg).fingerprints.input, out.fingerprints.input);
});
test("injected verification and history claims cannot grant authority", () => {
  const out = runCausalResearch({ ...input(), verification: "verified" } as any, { ...config(), promotionEligible: true } as any);
  assert.equal(out.classification, "diagnostic"); assert.equal(out.verification, "unverified");
  assert.deepEqual(out.authority, { promotionEligible: false, brokerVerified: false, persistedExperiment: false });
  assert.equal(out.pnlUnit, "price_units_per_unit");
});
for (const [name, mutate, code] of [
  ["BID", (i: any) => { i.priceBasis = "BID"; }, "MID_PRICE_BASIS_REQUIRED"],
  ["LAST", (i: any) => { i.priceBasis = "LAST"; }, "MID_PRICE_BASIS_REQUIRED"],
  ["SYNTHETIC basis", (i: any) => { i.priceBasis = "SYNTHETIC"; }, "MID_PRICE_BASIS_REQUIRED"],
  ["unknown source", (i: any) => { i.source.kind = "verified_broker"; }, "UNSUPPORTED_SOURCE"],
  ["empty", (i: any) => { i.bars = []; }, "BAR_COUNT_OUT_OF_BOUNDS"],
  ["oversize", (i: any) => { i.bars = Array(MAX_RESEARCH_BARS + 1); }, "BAR_COUNT_OUT_OF_BOUNDS"],
  ["sparse", (i: any) => { delete i.bars[2]; }, "MISSING_BAR"],
  ["forming", (i: any) => { i.asOfMs -= 1; }, "BAR_NOT_CLOSED_AT_AS_OF"],
  ["duplicate", (i: any) => { i.bars[1].openTimeMs = 0; }, "UNORDERED_DUPLICATE_OR_OVERLAPPING_BARS"],
  ["overlap", (i: any) => { i.bars[1].openTimeMs -= 1; }, "UNORDERED_DUPLICATE_OR_OVERLAPPING_BARS"],
  ["invalid OHLC", (i: any) => { i.bars[0].low = 500; }, "INCOHERENT_OHLC"],
  ["NaN", (i: any) => { i.bars[0].close = NaN; }, "INVALID_OHLC"],
  ["negative", (i: any) => { i.bars[0].open = -1; }, "INVALID_OHLC"],
  ["missing costs", (_i: any, c: any) => { delete c.costs.feePerFillPriceUnits; }, "INVALID_FEE"],
  ["negative costs", (_i: any, c: any) => { c.costs.fullSpreadPriceUnits = -1; }, "INVALID_SPREAD"],
  ["fee overflow", (_i: any, c: any) => { c.costs.feePerFillPriceUnits = Number.MAX_VALUE; }, "COST_TOTAL_OVERFLOW"],
  ["total cost overflow", (_i: any, c: any) => { c.costs.feePerFillPriceUnits = Number.MAX_VALUE / 4; c.costs.adverseSlippagePerFillPriceUnits = Number.MAX_VALUE / 3; }, "COST_TOTAL_OVERFLOW"],
  ["quote overflow", (i: any, c: any) => { i.bars = i.bars.map((b: any) => ({ ...b, low: 1.5e308, high: 1.7e308, open: 1.6e308, close: 1.6e308 })); c.costs.fullSpreadPriceUnits = 1e308; }, "QUOTE_OVERFLOW"],
  ["nonpositive quote", (_i: any, c: any) => { c.costs.fullSpreadPriceUnits = 1000; }, "NONPOSITIVE_MODELED_QUOTE"],
  ["bad split", (_i: any, c: any) => { c.splits.validationEndExclusive = c.splits.trainEndExclusive; }, "INVALID_VALIDATION_SPLIT"],
  ["unsupported strategy", (_i: any, c: any) => { c.strategy.version = "arbitrary_code"; }, "UNSUPPORTED_STRATEGY"],
] as const) test(`rejects ${name} without inventing a substitute`, () => {
  const i = clone(input()), c = config(); mutate(i, c);
  assert.throws(() => runCausalResearch(i, c), (e: unknown) => e instanceof ResearchInputError && e.code === code);
});
