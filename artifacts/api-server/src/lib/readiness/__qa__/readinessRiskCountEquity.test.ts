// Execution safety (round-3 safety review, s-exec): trader readiness shows
// the daily loss cap the Risk Governor enforces and blocks when it is hit.
// It valued the percent cap on the paper risk-count equity (the booked
// equity lowered by the paper risk count), but:
//   - when that equity was at or below 0, dailyLossCapAmount dropped the
//     percent cap as if it were not set, so readiness showed no daily limit
//     (or only the amount cap) and no block, while the governor refuses every
//     new trade on a percent of an equity at or below 0;
//   - it left open positions at their stored (sized) floating P/L, while the
//     governor counts each at the lower of its sized and ×100 value;
//   - the closes were read inside the limits try, so a failed paper read was
//     reported as "user_risk_settings" and dropped the loaded amount cap.
// Readiness now values the equity like the governor (paperOpenRisk.ts), treats
// the percent cap as used up at or below 0, adds a hard block naming the risk
// count and the booked equity, and reads the paper account in its own try
// (a failure reports "paper_orders" and keeps the loaded limits).
//
// The real evaluateReadiness runs; the paper book read side, the trader's
// limits and the broker contract specs are stubbed. Every other read fails
// against the unreachable test DATABASE_URL and is reported missing. Nothing
// is persisted.
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/readiness/__qa__/readinessRiskCountEquity.test.ts
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const SPECS: Record<string, { contractSize: number; profitCurrency: string }> = { US30: { contractSize: 1, profitCurrency: "USD" } };
const realContract = await import("../../mt5/contractSize.js");
mock.module("../../mt5/contractSize.js", {
  namedExports: {
    ...realContract,
    resolveContractSize: async (_userId: number, symbol: string) => realContract.decideContractSize({
      symbol, brokerContractSize: SPECS[symbol]?.contractSize ?? null, brokerProfitCurrency: SPECS[symbol]?.profitCurrency ?? null,
    }),
  },
});

const { resolveEffectiveLimits } = await import("../../riskGovernor/preTrade.js");
const LIMITS = {
  ...resolveEffectiveLimits({ userSettings: null, adminLimits: null }),
  maxDailyLossPercent: 5 as number | null, maxDailyLossAmount: null as number | null,
};
const realLimitSettings = await import("../../riskGovernor/limitSettings.js");
mock.module("../../riskGovernor/limitSettings.js", {
  namedExports: { ...realLimitSettings, loadEffectiveLimits: async () => LIMITS },
});

type Row = Record<string, unknown>;
const state: { account: Row | null; closes: Row[]; open: Row[]; failAccountRead: boolean } = {
  account: null, closes: [], open: [], failAccountRead: false,
};
const realBook = await import("../../tradeEngine/paperBookReader.js");
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: {
    ...realBook,
    sumPaperRealizedSince: async () => 0,
    readPaperOrders: async () => [],
    readActivePaperAccount: async () => state.account,
    readOpenPaperOrders: async (scope: { account?: number }) => {
      if (scope.account != null && state.failAccountRead) throw new Error("paper_orders read failed");
      return state.open;
    },
    readPaperCloses: async (scope: { account?: number }) => {
      if (scope.account != null && state.failAccountRead) throw new Error("paper_orders read failed");
      return state.closes.map((o) => ({ ...o, pnl: realBook.realizedOf(o as never) }));
    },
  },
});

const { evaluateReadiness } = await import("../traderReadiness.js");
const quiet = { info() {}, warn() {}, error() {} };
const evaluate = () => evaluateReadiness({ persist: false, userId: 7, log: quiet as never });

const account = (equity: number, balance = equity) => ({
  id: 3, userId: 7, accountName: "Practice", startingBalance: 10_000, currentBalance: balance, equity, marginUsed: 0, isActive: 1,
});
// A US30 BUY 0.01 lot at 1 unit per lot that lost 500 points: booked −5
// (contract-sized), −500 on the paper risk model. The risk count takes −500.
const US30_LOSS = {
  id: 11, userId: 7, paperAccountId: 3, symbol: "US30", direction: "BUY", lotSize: 0.01, entryPrice: 39_500, exitPrice: 39_000,
  profitLoss: -5, status: "CLOSED_SL", closedAt: new Date(Date.now() - 3_600_000), decisionId: null, strategyId: null,
};

test("a risk-count equity at or below 0 uses up the percent daily cap and adds a hard block naming both figures", async () => {
  state.failAccountRead = false;
  state.account = account(395); // booked equity 395; the risk count takes 495 more loss: −100
  state.closes = [US30_LOSS];
  state.open = [];
  const e = await evaluate();
  assert.equal(e.metrics.paperRiskCountEquity, -100);
  assert.equal(e.metrics.paperBookedEquity, 395);
  assert.equal(e.metrics.dailyLossLimit, 0, "the 5% cap is used up, not dropped (was null: no limit shown)");
  const block = e.hardBlocks.find((b) => b.code === "PAPER_RISK_COUNT_EQUITY_EXHAUSTED");
  assert.ok(block, `hard blocks: ${e.hardBlocks.map((b) => b.code).join(", ") || "none"}`);
  assert.equal(block.severity, "BLOCK");
  assert.match(block.message, /^The paper risk count puts the paper account's equity at -100, at or below zero \(the paper account shows 395 booked;/);
  assert.match(block.message, /the lower of the booked total and the price move × lots × 100 total of the closed paper trades/);
  assert.match(block.message, /per-trade limit leaves no risk for a new trade and the 5% daily loss cap is used up\. New paper trades are blocked; closing is allowed\.$/);
  assert.doesNotMatch(block.message, /unknown/);
  assert.ok(!e.hardBlocks.some((b) => b.code === "DAILY_LOSS_LIMIT_EXCEEDED"), "no 'exceeds loss limit -0' block next to it");
  assert.ok(!e.softWarnings.some((w) => w.code === "DAILY_LOSS_NEAR_LIMIT"));
  assert.equal(e.overallStatus, "WATCH_ONLY");
  assert.equal(e.allowedActions.canOpenPaperTrade, false);
  assert.equal(e.allowedActions.canManualClosePaperTrade, true);
  assert.ok(e.dataSourcesRead.includes("paper_orders") && e.dataSourcesRead.includes("user_risk_settings"));
});

test("open positions count like the governor: an open US30 position at its stop takes the equity below 0, and the block says so", async () => {
  state.failAccountRead = false;
  // A market-priced (Build EE) US30 BUY 0.01 lot; no market quote is read
  // here, so it is counted at its stop 300 points below entry (−300 on the
  // ×100 model). The account stores its sized floating −2.
  state.account = account(200, 202);
  state.closes = [];
  state.open = [{
    id: 12, userId: 7, paperAccountId: 3, symbol: "US30", direction: "BUY", lotSize: 0.01, entryPrice: 39_500, stopLoss: 39_200,
    takeProfit: 40_000, status: "OPEN", strategyId: "build_ee_paper_execution", exitPrice: null, profitLoss: 0, closedAt: null,
  }];
  const e = await evaluate();
  assert.equal(e.metrics.paperRiskCountEquity, 200 + (-300 - -2), "was the booked 200: open positions at their stored floating");
  assert.deepEqual(e.metrics.paperOpenValuedAtStop, ["US30"]);
  const block = e.hardBlocks.find((b) => b.code === "PAPER_RISK_COUNT_EQUITY_EXHAUSTED");
  assert.ok(block);
  assert.match(block.message, /equity at -98, at or below zero \(the paper account shows 200 booked;/);
  assert.match(block.message, /the open US30 position is counted at its stop because no market quote for it was read for this check/);
  assert.match(block.message, /New paper trades are blocked \(an order on US30 is checked with its own quote, which can value that position differently\); closing is allowed\.$/);
});

test("a positive risk-count equity values the percent cap on it, with no block", async () => {
  state.failAccountRead = false;
  state.account = account(10_000);
  state.closes = [US30_LOSS];
  state.open = [];
  const e = await evaluate();
  assert.equal(e.metrics.paperRiskCountEquity, 9_505);
  assert.equal(e.metrics.paperBookedEquity, 10_000);
  assert.equal(e.metrics.dailyLossLimit, 9_505 * 0.05);
  assert.ok(!e.hardBlocks.some((b) => b.code === "PAPER_RISK_COUNT_EQUITY_EXHAUSTED"));
});

test("a failed paper account read is reported as paper_orders and keeps the loaded limits", async () => {
  LIMITS.maxDailyLossAmount = 250;
  try {
    state.failAccountRead = true;
    state.account = account(10_000);
    state.closes = [];
    state.open = [];
    const e = await evaluate();
    assert.ok(e.missingDataSources.includes("paper_orders"), `missing: ${e.missingDataSources.join(", ")}`);
    assert.ok(!e.dataSourcesRead.includes("paper_orders"), "not also listed as read");
    assert.ok(!e.missingDataSources.includes("user_risk_settings"), "the limits were read; was reported missing with them");
    assert.ok(e.dataSourcesRead.includes("user_risk_settings"));
    assert.equal(e.metrics.dailyLossLimit, 250, "the amount cap stays (was null)");
    assert.equal(e.metrics.maxOpenPaperTrades, LIMITS.discipline.maxOpenTrades);
    assert.equal(e.metrics.paperRiskCountEquity, null, "not read, so not shown");
    assert.equal(e.metrics.paperBookedEquity, null);
  } finally {
    LIMITS.maxDailyLossAmount = null;
    state.failAccountRead = false;
  }
});

test("a booked equity at or below 0 that the risk count does not lower is named once, as booked", async () => {
  state.failAccountRead = false;
  state.account = account(-50);
  state.closes = [];
  state.open = [];
  const e = await evaluate();
  assert.equal(e.metrics.paperRiskCountEquity, -50);
  assert.equal(e.metrics.paperBookedEquity, -50);
  const block = e.hardBlocks.find((b) => b.code === "PAPER_RISK_COUNT_EQUITY_EXHAUSTED");
  assert.ok(block);
  assert.match(block.message, /^The paper account's equity is -50, at or below zero \(booked; the paper risk count gives the same figure\), so your \d+(\.\d+)?% per-trade limit leaves no risk for a new trade and the 5% daily loss cap is used up\./);
});
