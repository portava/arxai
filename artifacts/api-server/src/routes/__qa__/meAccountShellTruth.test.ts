// Regression: My Account (GET /me/account-shell → computeAccountShell) must
// only state figures it actually measured. Each test pins one finding:
//
//   * Closed P/L and today's trade counts were read from performance_daily, a
//     table nothing in the app writes, so every user saw $0 / 0 and "Daily
//     Loss Remaining" equal to the whole cap even after losing money today.
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
