// Regression: My Account (GET /me/account-shell → computeAccountShell) must
// only state figures it actually measured. Each test pins one finding:
//
//   * Closed P/L and today's trade counts were read from performance_daily, a
//     table nothing in the app writes, so every user saw $0 / 0 and "Daily
//     Loss Remaining" equal to the whole cap even after losing money today.
//   * A user with no allocation row and no virtual account (personal MT5,
//     demo, paper) saw My Balance / My Equity / Margin Used as $0.
//   * "Open P/L" was the lifetime realized P/L (virtualPnl) for shared-master
//     users and the sum of paper_trades.pnl (null until close, so $0) for
//     everyone else; "Open Exposure" was paper-journal lots for personal MT5.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });
const { createFakeDb } = await import("./_fakeRouteDb.js");

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const fake = createFakeDb(tables);
mock.module("@workspace/db", { namedExports: { ...database, db: fake.db } });

let platformMode = "SIMULATED";
let accountRoutingMode = "USER_OWNED_MT5";
let connections: Row[] = [];
let investor: Row | null = null;

const connectionsMod = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", {
  namedExports: { ...connectionsMod, listUserConnections: async () => connections },
});
const switchesMod = await import("../../lib/safety/platformSwitches.js");
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    ...switchesMod,
    loadPlatformSettings: async () => ({ switches: { platformMode }, config: { accountRoutingMode } }),
  },
});
const governanceMod = await import("../../lib/governance/effectiveGovernance.js");
mock.module("../../lib/governance/effectiveGovernance.js", {
  namedExports: {
    ...governanceMod,
    getEffectiveTradingGovernance: async () => ({ isPrivileged: false, ownerLiveControlMode: false }),
  },
});
const limitsMod = await import("../../lib/riskGovernor/limitSettings.js");
mock.module("../../lib/riskGovernor/limitSettings.js", {
  namedExports: { ...limitsMod, loadStoredLimitRows: async () => ({ userSettings: null, adminLimits: null }) },
});
// Not spread from the real module: it imports getUserModeScope, which imports
// meAccountShell, and that must first load after these mocks are in place.
mock.module("../../lib/live/investorLiveBalance.js", {
  namedExports: {
    buildInvestorLiveBalanceSnapshot: async () => investor,
    toInvestorLiveBalanceWire: () => null,
    fetchInvestorBalanceParts: async () => ({ allocatedBalance: 0, reservedRisk: 0, realizedPnL: 0, realizedPnLPendingCount: 0 }),
    composeInvestorBalance: () => investor,
    computeAvailableBalance: () => 0,
    REALIZED_PNL_PENDING_SIZING_NOTE: "",
  },
});

const { computeAccountShell } = await import("../meAccountShell.js");

const USER = 41;
const today = new Date();

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  platformMode = "SIMULATED";
  accountRoutingMode = "USER_OWNED_MT5";
  connections = [];
  investor = null;
});

function liveSnapshot(patch: Row = {}): Row {
  return {
    source: "live_shared", allocatedBalance: 0, realizedPnL: 0, floatingPnL: null, liveEquity: 0,
    marginUsed: 0, freeMargin: 0, availableBalance: 0, openTradeCount: 0,
    freshness: { status: "fresh", lastUpdatedAt: today.toISOString(), ageMs: 1000 }, ...patch,
  };
}

test("closed P/L and today's counts are not measured: null with a reason, never $0 / 0", async () => {
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "SIMULATED" }];
  tables.user_master_live_access = [{ dailyLossLimitUsd: "100", masterLiveStatus: "NOT_APPROVED" }];
  // The trader closed a losing trade today; no performance_daily row exists
  // because nothing writes that table.
  tables.paper_orders = [{ userId: USER, status: "closed", realizedPnl: -40, closedAt: today }];
  tables.performance_daily = [];
  investor = liveSnapshot({ source: "paper" });

  const shell = await computeAccountShell(USER);

  assert.equal(shell.pnl.closedPnlToday, null);
  assert.equal(shell.pnl.closedPnlWeek, null);
  assert.equal(shell.pnl.closedPnlTotal, null);
  assert.equal(shell.pnl.tradesToday, null);
  assert.equal(shell.pnl.winsToday, null);
  assert.equal(shell.pnl.lossesToday, null);
  assert.equal(shell.pnl.closedMeasured, false);
  assert.match(String(shell.pnl.closedNote), /not measured/i);

  assert.equal(shell.risk.maxDailyLossAmount, 100);
  assert.notEqual(shell.risk.dailyLossRemaining, 100, "the full cap is not what is left after a loss");
  assert.equal(shell.risk.dailyLossRemaining, null);
  assert.match(String(shell.risk.dailyLossRemainingNote), /not measured/i);
});

test("a stray performance_daily row is not presented as today's P/L", async () => {
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "SIMULATED" }];
  tables.performance_daily = [{ date: today.toISOString().slice(0, 10), pnl: 12, trades: 3, wins: 2, losses: 1 }];
  const shell = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(shell.pnl.closedPnlToday, null);
  assert.equal(shell.pnl.tradesToday, null);
});

test("no allocation and no virtual account: balance, equity and margin are not available, not $0", async () => {
  platformMode = "DEMO";
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "DEMO" }];
  tables.virtual_trading_accounts = [];
  tables.user_slot_allocation = [];
  investor = liveSnapshot({ source: "demo" });

  const shell = await computeAccountShell(USER);

  assert.equal(shell.accountMode, "DEMO");
  assert.equal(shell.allocation.currentBalance, null);
  assert.equal(shell.allocation.equity, null);
  assert.equal(shell.allocation.marginUsed, null);
  assert.equal(shell.allocation.balanceSource, null);
  assert.match(shell.allocation.balanceNote, /no shared-account allocation or virtual account/);
  assert.equal(shell.risk.availableRiskAmount, null, "no capital is invented for the risk amount");
});

test("an allocated user's balance names its source; margin is never reported as a measured $0", async () => {
  accountRoutingMode = "SHARED_MASTER_MT5";
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "LIVE" }];
  tables.user_slot_allocation = [{ allocatedFunds: "1000", manualAllocatedFunds: "0", aiAllocatedFunds: "0", allocationStatus: "active" }];
  tables.virtual_trading_accounts = [{ virtualBalance: 1000, virtualEquity: 1000, virtualMarginUsed: 0, virtualPnl: 25, status: "active", sharedMasterAccountId: 3 }];

  const shell = await computeAccountShell(USER, { skipInvestorSnapshot: true });

  assert.equal(shell.allocation.balanceSource, "user_slot_allocation");
  assert.equal(shell.allocation.currentBalance, 1025);
  assert.match(shell.allocation.balanceNote, /allocation your operator assigned/);
  assert.equal(shell.allocation.marginUsed, null);
  assert.match(shell.allocation.marginNote, /not measured/i);
});

test("shared master: Open P/L is the live floating P/L, not the realized virtualPnl", async () => {
  platformMode = "LIVE";
  accountRoutingMode = "SHARED_MASTER_MT5";
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "LIVE" }];
  tables.virtual_trading_accounts = [{ virtualBalance: 1250, virtualEquity: 1250, virtualMarginUsed: 0, virtualPnl: 250, status: "active", sharedMasterAccountId: 3 }];
  tables.shared_trade_attribution = [{ lotSize: 0.2 }];
  investor = liveSnapshot({ floatingPnL: -12.5, openTradeCount: 1 });

  const shell = await computeAccountShell(USER);

  assert.notEqual(shell.pnl.openPnl, 250, "realized P/L is not open P/L");
  assert.equal(shell.pnl.openPnl, -12.5);
  assert.equal(shell.pnl.openPnlSource, "live_shared_positions");
  assert.equal(shell.risk.openExposureLots, 0.2);
  assert.equal(shell.risk.openExposureSource, "shared_trade_attribution");

  // Same user, live feed stale: not shown as current.
  investor = liveSnapshot({ floatingPnL: -12.5, openTradeCount: 1, freshness: { status: "stale", lastUpdatedAt: null, ageMs: null } });
  const stale = await computeAccountShell(USER);
  assert.equal(stale.pnl.openPnl, null);
  assert.match(stale.pnl.openPnlNote, /not fresh/);
});

test("demo / personal MT5: Open P/L is not measured (never a $0 journal sum); personal exposure is not read", async () => {
  platformMode = "DEMO";
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "DEMO" }];
  tables.paper_trades = [{ lotSize: 0.3, pnl: null, status: "open" }];
  investor = liveSnapshot({ source: "demo" });

  const demo = await computeAccountShell(USER);
  assert.equal(demo.pnl.openPnl, null);
  assert.equal(demo.pnl.openPnlSource, null);
  assert.match(demo.pnl.openPnlNote, /not measured/i);
  assert.equal(demo.risk.openExposureLots, 0.3);
  assert.equal(demo.risk.openExposureSource, "paper_trades");
  assert.match(demo.risk.openExposureNote, /trade journal/);

  platformMode = "LIVE";
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "LIVE" }];
  connections = [{ accountType: "live" }];
  const personal = await computeAccountShell(USER);
  assert.equal(personal.accountMode, "PERSONAL_MT5");
  assert.equal(personal.pnl.openPnl, null);
  assert.equal(personal.risk.openExposureLots, null, "paper-journal lots are not a live account's exposure");
  assert.equal(personal.risk.openExposureSource, null);
});
