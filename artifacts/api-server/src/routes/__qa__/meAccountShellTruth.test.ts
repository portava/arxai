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
//   * The trading-status badge said ACTIVE from the platform mode alone while
//     the user's own mode was DISABLED or their allocation was frozen.
//   * "My Equity" equalled My Balance for allocated users: floating P/L of
//     open positions was never included.
//   * The badge read ACTIVE, "the platform ... allow[s] trading", while the
//     platform emergency stop halted every new demo and live order.
//   * The ACTIVE reason said "your allocation allow[s] trading" when no
//     allocation was assigned (live shared-master entries are refused then)
//     and named an approval check for accounts where none runs. It also
//     named a revoked / denied / pending approval as passed, and called an
//     assigned allocation a pass when its headroom was never checked here.
//   * Available Capacity was the allocation less virtual_margin_used, a
//     column only ever seeded at 0, next to "Margin Used: Not measured".
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
type Stop = { engaged: boolean; reason: string | null; engagedAt: Date | null };
const RELEASED: Stop = { engaged: false, reason: null, engagedAt: null };
let emergencyStop: Stop = RELEASED;
let switchesReadable = true;
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
    loadPlatformSettings: async () => ({
      switches: { platformMode, emergencyStop, readable: switchesReadable },
      config: { accountRoutingMode },
    }),
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
  emergencyStop = RELEASED;
  switchesReadable = true;
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

test("the badge status is not ACTIVE when the user's own mode is DISABLED or the allocation is frozen", async () => {
  platformMode = "SIMULATED";
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "DISABLED" }];
  tables.user_slot_allocation = [{ allocatedFunds: "1000", allocationStatus: "active", tradingFrozen: true }];

  const shell = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  // The platform/approval status the mode resolver reads is unchanged.
  assert.equal(shell.tradingStatus, "ACTIVE");
  assert.notEqual(shell.accountTradingStatus, "ACTIVE");
  assert.equal(shell.accountTradingStatus, "RESTRICTED");
  assert.match(shell.accountTradingStatusReason, /operator has not enabled trading/);

  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "SIMULATED" }];
  const frozen = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(frozen.accountTradingStatus, "PAUSED");
  assert.match(frozen.accountTradingStatusReason, /temporarily paused/);

  tables.user_slot_allocation = [{ allocatedFunds: "1000", allocationStatus: "active", tradingFrozen: false }];
  const active = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(active.accountTradingStatus, "ACTIVE");
  assert.match(active.accountTradingStatusReason, /kill switch and risk limits are checked on every order/);
});

test("allocated user's equity is balance plus live floating P/L, or not shown — never the balance repeated", async () => {
  platformMode = "LIVE";
  accountRoutingMode = "SHARED_MASTER_MT5";
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "LIVE" }];
  tables.user_slot_allocation = [{ allocatedFunds: "1000", allocationStatus: "active" }];
  tables.virtual_trading_accounts = [{ virtualBalance: 1025, virtualEquity: 1025, virtualMarginUsed: 0, virtualPnl: 25, status: "active", sharedMasterAccountId: 3 }];
  investor = liveSnapshot({ floatingPnL: -40, openTradeCount: 2 });

  const shell = await computeAccountShell(USER);
  assert.equal(shell.allocation.currentBalance, 1025);
  assert.notEqual(shell.allocation.equity, shell.allocation.currentBalance);
  assert.equal(shell.allocation.equity, 985);
  assert.match(shell.allocation.equityNote, /plus the floating P\/L/);

  // Floating P/L not reported yet: equity is not shown, and the note says why.
  investor = liveSnapshot({ floatingPnL: null, openTradeCount: 2 });
  const pending = await computeAccountShell(USER);
  assert.equal(pending.allocation.equity, null);
  assert.match(pending.allocation.equityNote, /not reported floating P\/L/);

  // Not in live shared mode: floating P/L is not read, so equity is not marked to market.
  investor = liveSnapshot({ source: "demo" });
  const demo = await computeAccountShell(USER);
  assert.equal(demo.allocation.equity, null);
  assert.match(demo.allocation.equityNote, /Not marked to market/);
});

test("the platform emergency stop is not hidden behind ACTIVE: demo and live users read PAUSED, paper users are told it does not halt them", async () => {
  platformMode = "LIVE";
  emergencyStop = { engaged: true, reason: "broker outage", engagedAt: new Date("2026-11-03T09:00:00.000Z") };

  for (const mode of ["DEMO", "LIVE"]) {
    tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: mode }];
    const shell = await computeAccountShell(USER, { skipInvestorSnapshot: true });
    // The platform/approval status the mode resolver reads is unchanged.
    assert.equal(shell.tradingStatus, "ACTIVE");
    assert.equal(shell.accountTradingStatus, "PAUSED", `${mode}: new ${mode.toLowerCase()} orders are halted by the stop`);
    assert.match(shell.accountTradingStatusReason, /platform emergency stop is engaged/);
    assert.match(shell.accountTradingStatusReason, /broker outage/);
    assert.match(shell.accountTradingStatusReason, /2026-11-03T09:00:00\.000Z/);
    assert.match(shell.accountTradingStatusReason, /new demo and live orders are halted/);
    assert.doesNotMatch(shell.accountTradingStatusReason, /allow trading/);
  }

  // The stop does not halt the paper simulator (platformStopForVenue), so a
  // paper user is not shown PAUSED — but the reason names the stop.
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "SIMULATED" }];
  const paper = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(paper.accountTradingStatus, "ACTIVE");
  assert.match(paper.accountTradingStatusReason, /platform emergency stop is engaged/);
  assert.match(paper.accountTradingStatusReason, /not paper \(simulated\) trades/);

  // Released: the reason says the stop was checked and is released.
  emergencyStop = RELEASED;
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "DEMO" }];
  const released = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(released.accountTradingStatus, "ACTIVE");
  assert.match(released.accountTradingStatusReason, /platform emergency stop and the safety-core kill switch are released/);
});

test("unreadable platform settings are reported as not read, not as trading switched off by an operator", async () => {
  platformMode = "OFF";
  switchesReadable = false;
  emergencyStop = { engaged: true, reason: "state unreadable", engagedAt: null };
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "DEMO" }];
  const shell = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(shell.accountTradingStatus, "RESTRICTED");
  assert.match(shell.accountTradingStatusReason, /could not be read/);
  assert.doesNotMatch(shell.accountTradingStatusReason, /switched off for the whole platform/);
});

test("no allocation assigned: the reason never says the allocation allows trading, and live shared-master users read PAUSED", async () => {
  platformMode = "LIVE";
  accountRoutingMode = "SHARED_MASTER_MT5";
  tables.user_master_live_access = [{ masterLiveStatus: "APPROVED" }];
  // Attached to the shared master, no allocation row: allocationPending.
  tables.virtual_trading_accounts = [{ virtualBalance: 0, virtualEquity: 0, virtualMarginUsed: 0, virtualPnl: 0, status: "active", sharedMasterAccountId: 3 }];
  tables.user_slot_allocation = [];

  // LIVE: the live pipeline refuses every entry (USER_ALLOCATION_NOT_ASSIGNED).
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "LIVE" }];
  const live = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(live.allocation.allocationPending, true);
  assert.equal(live.tradingStatus, "ACTIVE", "the mode resolver's input is unchanged");
  assert.equal(live.accountTradingStatus, "PAUSED");
  assert.match(live.accountTradingStatusReason, /No allocation is assigned to you yet/);
  assert.match(live.accountTradingStatusReason, /live orders on the shared master account are refused/);
  assert.doesNotMatch(live.accountTradingStatusReason, /allocation allow/);

  // An allocation row of 0 is not an assignment either.
  tables.user_slot_allocation = [{ allocatedFunds: "0", allocationStatus: "active" }];
  const zero = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(zero.accountTradingStatus, "PAUSED");

  // DEMO: no allocation gate on demo orders, so not PAUSED — but no claim that
  // an allocation was checked, and the reason says live orders need one.
  tables.user_slot_allocation = [];
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "DEMO" }];
  const demo = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(demo.accountTradingStatus, "ACTIVE");
  assert.doesNotMatch(demo.accountTradingStatusReason, /your allocation/);
  assert.match(demo.accountTradingStatusReason, /No allocation is assigned to you yet/);

  // A demo user with no shared-master routing: no allocation applies, none is claimed.
  accountRoutingMode = "USER_OWNED_MT5";
  tables.virtual_trading_accounts = [];
  const plain = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(plain.accountTradingStatus, "ACTIVE");
  assert.doesNotMatch(plain.accountTradingStatusReason, /allocation/);
  assert.doesNotMatch(plain.accountTradingStatusReason, /approval/, "no approval check runs for a demo account");

  // Allocated and approved shared-master user: both are named as checked.
  accountRoutingMode = "SHARED_MASTER_MT5";
  tables.user_slot_allocation = [{ allocatedFunds: "1000", allocationStatus: "active" }];
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "LIVE" }];
  const allocated = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(allocated.accountTradingStatus, "ACTIVE");
  assert.match(allocated.accountTradingStatusReason, /your shared-master approval allow trading/);
  assert.match(allocated.accountTradingStatusReason, /An allocation is assigned to you and is not frozen/);
});

test("an assigned allocation is not claimed to allow trading: its headroom is checked per live order, not by this status", async () => {
  platformMode = "LIVE";
  accountRoutingMode = "SHARED_MASTER_MT5";
  tables.user_master_live_access = [{ masterLiveStatus: "APPROVED" }];
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "LIVE" }];
  // $1,000 assigned; reserved risk plus open floating loss may have used all
  // of it, in which case the live allocation gate refuses every entry
  // (USER_ALLOCATION_EXHAUSTED). This status only sees that one is assigned.
  tables.user_slot_allocation = [{ allocatedFunds: "1000", allocationStatus: "active" }];
  tables.virtual_trading_accounts = [{ virtualBalance: 1000, virtualEquity: 1000, virtualMarginUsed: 0, virtualPnl: 0, status: "active", sharedMasterAccountId: 3 }];
  investor = liveSnapshot({ allocatedBalance: 1000, availableBalance: 0, floatingPnL: -1000, openTradeCount: 3 });

  const shell = await computeAccountShell(USER);
  assert.doesNotMatch(shell.accountTradingStatusReason, /allocation allow/, "an assigned allocation is not a passed headroom check");
  assert.match(shell.accountTradingStatusReason, /An allocation is assigned to you and is not frozen/);
  assert.match(shell.accountTradingStatusReason, /reserved risk and open losses/);
  assert.match(shell.accountTradingStatusReason, /checked on each live order and is not part of this status/);
});

test("available capacity is not the allocation with an unmeasured margin of 0 subtracted", async () => {
  accountRoutingMode = "SHARED_MASTER_MT5";
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "LIVE" }];
  tables.user_slot_allocation = [{ allocatedFunds: "1000", allocationStatus: "active" }];
  // virtual_margin_used is only ever seeded at 0 (no writer measures it).
  tables.virtual_trading_accounts = [{ virtualBalance: 1000, virtualEquity: 1000, virtualMarginUsed: 0, virtualPnl: 0, status: "active", sharedMasterAccountId: 3 }];

  const shell = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(shell.allocation.marginUsed, null);
  assert.notEqual(shell.allocation.availableCapacity, 1000, "the allocation is not capacity left after margin");
  assert.equal(shell.allocation.availableCapacity, null);
  assert.match(String(shell.allocation.availableCapacityNote), /not measured/i);
  assert.match(String(shell.allocation.availableCapacityNote), /margin/);

  // No allocation: nothing to report, and the note says so.
  tables.user_slot_allocation = [];
  tables.virtual_trading_accounts = [];
  const none = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(none.allocation.availableCapacity, null);
  assert.match(String(none.allocation.availableCapacityNote), /no allocation/i);
});

test("the safety-core kill switch halts every venue, paper included: the badge reads PAUSED and names it", async () => {
  platformMode = "LIVE";
  // safety_core row as readSafetyCoreSwitch() selects it.
  tables.safety_core = [{ on: true, why: "drill", at: new Date("2026-11-03T08:00:00.000Z"), mode: null, state: null }];
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "SIMULATED" }];
  const paper = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(paper.tradingStatus, "ACTIVE", "the mode resolver's input is unchanged");
  assert.equal(paper.accountTradingStatus, "PAUSED");
  assert.match(paper.accountTradingStatusReason, /safety-core kill switch is engaged \(drill\) since 2026-11-03T08:00:00\.000Z/);
  assert.match(paper.accountTradingStatusReason, /paper included/);

  // Released: both stops are named as checked.
  tables.safety_core = [{ on: false, why: null, at: null, mode: null, state: null }];
  const released = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(released.accountTradingStatus, "ACTIVE");
  assert.match(released.accountTradingStatusReason, /platform emergency stop and the safety-core kill switch are released/);
});

test("a revoked, denied or pending shared-master approval is never named as allowing trading; live users are not shown ACTIVE", async () => {
  platformMode = "LIVE";
  accountRoutingMode = "SHARED_MASTER_MT5";
  tables.user_slot_allocation = [{ allocatedFunds: "1000", allocationStatus: "active" }];
  tables.virtual_trading_accounts = [{ virtualBalance: 1000, virtualEquity: 1000, virtualMarginUsed: 0, virtualPnl: 0, status: "active", sharedMasterAccountId: 3 }];

  const cases: Array<[string, RegExp, string]> = [
    ["REVOKED", /shared-master live access was revoked/, "PAUSED"],
    ["DENIED", /shared-master live access was denied/, "PAUSED"],
    ["PENDING_REQUEST", /waiting for operator review/, "WAITING_APPROVAL"],
  ];
  for (const [status, line, liveBadge] of cases) {
    tables.user_master_live_access = [{ masterLiveStatus: status }];

    // LIVE: the master-live access gate refuses every live order for these statuses.
    tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "LIVE" }];
    const live = await computeAccountShell(USER, { skipInvestorSnapshot: true });
    assert.equal(live.approvalStatus, status);
    assert.equal(live.tradingStatus, "ACTIVE", "the mode resolver's input is unchanged");
    assert.equal(live.accountTradingStatus, liveBadge, `${status}: a live shared-master user is not shown ACTIVE`);
    assert.doesNotMatch(live.accountTradingStatusReason, /approval allow/, `${status}: a failed approval is not named as passed`);
    assert.match(live.accountTradingStatusReason, line);
    assert.match(live.accountTradingStatusReason, /live orders on the shared master account are refused/);

    // DEMO: no master-live gate on demo orders, so the badge may stay ACTIVE —
    // but the reason still never names the approval as passed.
    tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "DEMO" }];
    const demo = await computeAccountShell(USER, { skipInvestorSnapshot: true });
    assert.equal(demo.accountTradingStatus, "ACTIVE");
    assert.doesNotMatch(demo.accountTradingStatusReason, /approval allow/);
    assert.match(demo.accountTradingStatusReason, line);
  }

  // APPROVED: the approval is named as checked.
  tables.user_master_live_access = [{ masterLiveStatus: "APPROVED" }];
  tables.user_trading_permissions = [{ accountRoutingOverride: "inherit", tradingMode: "LIVE" }];
  const approved = await computeAccountShell(USER, { skipInvestorSnapshot: true });
  assert.equal(approved.accountTradingStatus, "ACTIVE");
  assert.match(approved.accountTradingStatusReason, /your shared-master approval/);
  assert.doesNotMatch(approved.accountTradingStatusReason, /refused/);
});
