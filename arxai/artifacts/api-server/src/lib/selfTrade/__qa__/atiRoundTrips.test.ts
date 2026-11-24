import assert from "node:assert/strict";
import { test } from "node:test";
import { atiRoundTrips, reportAtiEntryStrategies, type AtiPositionLeg } from "../atiRoundTrips.js";

const entry: AtiPositionLeg = { accountBinding: "account-one", brokerSymbol: "EURUSD", positionId: "42",
  leg: "ENTRY", side: "BUY", order: "501", deal: "601", volume: 0.3, fillPrice: 1.01,
  brokerFilledAtMs: 1000, commandId: "open", closedPositionDealTickets: null,
  charges: { currency: "USD", commission: 0, fee: -0.1, swap: null },
  benchmark: { source: "COMMAND_QUOTES", decisionSpreadPriceUnits: null, submissionSpreadPriceUnits: null,
    adverseMovementBeforeSubmissionPriceUnits: null, adverseSlippagePriceUnits: null, adverseFillVsDecisionMidPriceUnits: null } };
const partial: AtiPositionLeg = { ...entry, leg: "EXIT", side: "SELL", order: "502", deal: "602",
  volume: 0.1, brokerFilledAtMs: 1001, commandId: "close" };
const final: AtiPositionLeg = { ...partial, deal: "603", order: "503", volume: 0.2,
  commandId: null, brokerFilledAtMs: 1002, closedPositionDealTickets: ["601","602","603"] };
const rows = [entry, partial, final];
const assess = (...legs: AtiPositionLeg[]) => atiRoundTrips("LIVE", legs, 0).positions[0]!;

test("round trips match decimal lots exactly, preserve rebates and withhold unknown or mixed-currency charges", () => {
  const round = assess(final, entry, partial);
  assert.equal(round.state, "OBSERVED_BROKER_ROUND_TRIP");
  assert.deepEqual(round.deals.map(row => row.deal), ["601","602","603"]);
  assert.equal(round.charges?.commission, 0);
  assert.equal(round.charges?.swap, null);
  assert.equal(assess(entry, partial, { ...final, charges: { currency: "USD", commission: 0.5, fee: 0, swap: 0 } }).charges?.commission, 0.5);
  assert.equal(assess(entry, partial, { ...final, charges: { currency: "EUR", commission: 0, fee: 0, swap: 0 } }).charges, null);
  assert.deepEqual(assess(entry, partial, { ...final, volume: 0.20000000000000004 }).gaps, ["INVALID_POSITION_VOLUME_PATH", "ENTRY_EXIT_VOLUME_MISMATCH"]);
  assert.equal(assess({ ...entry, volume: 3e-8 }, { ...partial, volume: 1e-8 }, { ...final, volume: 2e-8 }).state, round.state);
});

test("equal tickets can belong to independent accounts and repeated claims on one account invalidate both positions", () => {
  assert.notEqual(atiRoundTrips("DEMO", rows, 0).positions[0]?.positionKey, assess(...rows).positionKey);
  const other = rows.map(row => ({ ...row, accountBinding: "account-two" }));
  assert.equal(atiRoundTrips("LIVE", [...rows, ...other], 1).reconciled, 2);
  const reused = { ...entry, positionId: "44", brokerSymbol: "GBPUSD" };
  const result = atiRoundTrips("LIVE", [...rows, reused], 1);
  assert.equal(result.reconciled, 0);
  assert.ok(result.positions.every(row => row.gaps.includes("DUPLICATE_DEAL_CLAIM")));
  assert.equal(result.dealsWithoutPositionId, 1);
  assert.equal(atiRoundTrips("LIVE", [entry, partial, { ...final, accountBinding: "account-two" }], 0).reconciled, 0);
});

test("missing or extra deals, conflicting closure lists, reversals and ambiguous chronology remain unresolved", () => {
  const examples: [AtiPositionLeg[], string][] = [
    [[entry, partial], "NO_CLOSED_POSITION_HISTORY"],
    [[entry, { ...final, volume: 0.3 }], "POSITION_HISTORY_AND_RECEIPTS_DIFFER"],
    [[entry, partial, { ...final, closedPositionDealTickets: ["602","603"] }], "POSITION_HISTORY_AND_RECEIPTS_DIFFER"],
    [[entry, { ...partial, closedPositionDealTickets: ["601","602"] }, final], "POSITION_HISTORY_AND_RECEIPTS_DIFFER"],
    [[entry, { ...partial, closedPositionDealTickets: final.closedPositionDealTickets }, { ...final, closedPositionDealTickets: null }], "CLOSING_DEAL_UNCONFIRMED"],
    [[entry, partial, { ...final, side: "BUY" }], "POSITION_SIDE_MISMATCH"],
    [[entry, { ...partial, brokerFilledAtMs: 1000 }, final], "SAME_TIME_LEG_ORDER_UNVERIFIED"],
    [[entry, { ...partial, brokerFilledAtMs: 999 }, final], "INVALID_POSITION_VOLUME_PATH"],
    [[entry, partial, { ...final, brokerSymbol: "EURUSD.pro" }], "POSITION_SYMBOL_MISMATCH"],
  ];
  for (const [legs, expected] of examples) {
    const result = assess(...legs);
    assert.equal(result.state, "UNRESOLVED");
    assert.ok(result.gaps.includes(expected), expected);
    assert.equal(result.charges, null);
  }
});


const strategy = { engine: "SELF_TRADE_FLEET_DECISION", revision: "a".repeat(40), agentId: 3, agentKey: "atlas",
  symbol: "EURUSD", timeframe: "M5", setup: "TREND_CONTINUATION", decisionSettingsHash: "0".repeat(64) } as const;
const witness = { strategy, cohortKey: "1".repeat(64), decisionId: 9, executionId: 10, admissionHash: "2".repeat(64) };

test("every opening fill must identify the same fleet strategy before any position costs enter its cohort", () => {
  const first = { ...entry, volume: 0.1, entryStrategy: witness };
  const increased = { ...entry, deal: "604", order: "504", brokerFilledAtMs: 1001, volume: 0.2,
    entryStrategy: { ...witness, decisionId: 19, executionId: 20 } };
  const close = { ...final, volume: 0.3, closedPositionDealTickets: ["601","603","604"] };
  function report(another: AtiPositionLeg) {
    return reportAtiEntryStrategies(atiRoundTrips("LIVE", [first, another, close], 0).positions);
  }
  const shared = report(increased);
  assert.equal(shared.positions[0]?.attribution, "VERIFIED_ENTRY_STRATEGY");
  assert.equal(shared.byEntryStrategy[0]?.closedPositions, 1);
  assert.deepEqual(shared.byEntryStrategy[0]?.decisionToFill, { coveredFills: 0, totalFills: 2, coveredLots: 0, eligibleLots: 0.3, volumeWeightedMeanPriceUnits: null });
  assert.equal(report({ ...increased, entryStrategy: { ...witness, cohortKey: "3".repeat(64),
    strategy: { ...strategy, setup: "REVERSAL" } } }).positions[0]?.attribution, "MULTIPLE_ENTRY_STRATEGIES");
  assert.deepEqual(report({ ...increased, entryStrategy: null }).byEntryStrategy, []);
  assert.deepEqual(reportAtiEntryStrategies(atiRoundTrips("LIVE", [first], 0).positions).byEntryStrategy, []);
});

test("combined charges cover only positions with all three charges on every deal in one currency", () => {
  type Charges = NonNullable<AtiPositionLeg["charges"]>;
  const zero: Charges = { currency: "USD", commission: 0, fee: 0, swap: 0 };
  function pair(positionId: string, opening: Charges, closing: Charges): AtiPositionLeg[] {
    const tickets = [positionId + "1", positionId + "2"];
    return [{ ...entry, deal: tickets[0]!, positionId, entryStrategy: witness, charges: opening },
      { ...final, deal: tickets[1]!, positionId, volume: entry.volume, closedPositionDealTickets: tickets, charges: closing }];
  }
  function cohort(legs: AtiPositionLeg[]) {
    return reportAtiEntryStrategies(atiRoundTrips("DEMO", legs, 0).positions).byEntryStrategy[0]!;
  }
  const partials = [...pair("1", zero, { ...zero, fee: null, commission: 1 }),
    ...pair("2", { ...zero, commission: null, fee: -0.3 }, { ...zero, swap: -2 })];
  const first = cohort(partials).signedDealCharges[0]!;
  assert.deepEqual(first.commission, { coveredPositions: 1, signedCashOnCoveredPositions: 1 });
  assert.deepEqual(first.fee, { coveredPositions: 1, signedCashOnCoveredPositions: -0.3 });
  assert.deepEqual(first.swap, { coveredPositions: 2, signedCashOnCoveredPositions: -2 });
  assert.deepEqual(first.combinedDealCharges, { coveredPositions: 0, signedCashOnCoveredPositions: null });
  const eur = { ...zero, currency: "EUR" };
  const measured = cohort([...partials, ...pair("3", { ...zero, fee: -0.1 },
    { ...zero, commission: -0.2, swap: 0.00000001 }), ...pair("4", eur, eur), ...pair("5", zero, eur)]);
  assert.equal(measured.closedPositions, 5);
  assert.equal(measured.positionsWithoutSingleChargeCurrency, 1);
  const [euros, dollars] = measured.signedDealCharges;
  assert.equal(euros?.currency, "EUR");
  assert.deepEqual(euros?.combinedDealCharges, { coveredPositions: 1, signedCashOnCoveredPositions: 0 });
  assert.equal(dollars?.positionsInCurrency, 3);
  assert.deepEqual(dollars?.combinedDealCharges, { coveredPositions: 1, signedCashOnCoveredPositions: -0.29999999 });
});

test("cost benchmark coverage reflects lot size and trade leg for each position and strategy", () => {
  const command = entry.benchmark;
  assert.equal(command.source, "COMMAND_QUOTES");
  const legs: AtiPositionLeg[] = [
    { ...entry, volume: 0.01, entryStrategy: witness, benchmark: { ...command, adverseSlippagePriceUnits: 0 } },
    { ...entry, deal: "604", order: "504", volume: 0.29, entryStrategy: witness },
    { ...partial, benchmark: { ...command, adverseSlippagePriceUnits: 0.22 } },
    { ...final, closedPositionDealTickets: ["601","604","602","603"],
      benchmark: { source: "BROKER_TRIGGER", triggerPrice: null, adverseMovementFromTriggerPriceUnits: null } },
  ];
  const report = reportAtiEntryStrategies(atiRoundTrips("LIVE", legs, 0).positions);
  const benchmarks = report.positions[0]?.priceBenchmarks;
  assert.ok(benchmarks);
  const slippage = benchmarks.commandSlippage;
  assert.equal(slippage.coveredFills, 2);
  assert.equal(slippage.totalFills, 3);
  assert.equal(slippage.coveredLots, 0.11);
  assert.equal(slippage.eligibleLots, 0.4);
  assert.ok(Math.abs(slippage.volumeWeightedMeanPriceUnits! - 0.2) < 1e-12);
  assert.deepEqual(report.byEntryStrategy[0]?.commandSlippage, slippage);
  assert.deepEqual(benchmarks.triggerMovement, { coveredFills: 0, totalFills: 1, coveredLots: 0, eligibleLots: 0.2,
    volumeWeightedMeanPriceUnits: null });
  assert.equal(reportAtiEntryStrategies(atiRoundTrips("LIVE", legs.slice(0, 1), 0).positions).positions[0]?.priceBenchmarks, null);
});
