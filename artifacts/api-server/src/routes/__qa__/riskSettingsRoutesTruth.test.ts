// Regression: the older Risk Control Center (/risk-settings) routes.
//
// GET /risk/audit — the "Live Risk Audit" sized loss % against a hard-coded
// $1,000 balance and read the retired legacy trades table (every account's
// rows, closed to new trades, and its closed rows never match the "CLOSED"
// filter, so loss and streak always read 0). The response said only
// balanceSource, which the RiskAudit schema did not carry. It now states
// what the audit read so the page can say it is not the trader's account.
//
// The route runs for real; requireUser, computeRiskAudit and the settings
// reader are mocked. No database, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/riskSettingsRoutesTruth.test.ts

import { after, before, test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

const SETTINGS = {
  id: 1, riskMode: "Balanced", riskPerTradePct: 0.5, maxDailyLossPct: 2, maxWeeklyLossPct: 5, maxOpenTrades: 2,
  maxTradesPerDay: 5, maxLotSize: 5, stopAfterLosingStreak: 3, cooldownAfterLossMinutes: 30, minConfidenceScore: 75,
  disableDuringAbnormalVolatility: true, liveLocked: true, vol75ExtraConfidence: true, vol75SmallLot: true,
  us30BlockNews: true, stocksBlockEarnings: true, forexBlockEvents: true,
};
const auditBalances: number[] = [];

mock.module("../../lib/auth/middleware.js", {
  namedExports: {
    requireUser: (req: { authUser?: unknown }, _res: unknown, next: () => void) => {
      req.authUser = { id: 7, role: "USER" };
      next();
    },
  },
});
mock.module("../../lib/auditVault.js", { namedExports: { shadowCapture: async () => undefined } });
mock.module("../../lib/risk/userRiskSettings.js", {
  namedExports: {
    getOrCreateUserRiskSettings: async () => ({ ...SETTINGS }),
    updateUserRiskSettings: async (_u: number, patch: Record<string, unknown>) => ({ ...SETTINGS, ...patch }),
  },
});
// The limits in force (strictest of trader, operator and platform), as the
// Risk Governor resolves them. Default: the operator capped the lot at 0.5.
const effective: { maxLotSize: number; symbolLimits: Record<string, { maxLots: number | null; blocked: boolean }> } = {
  maxLotSize: 0.5, symbolLimits: {},
};
mock.module("../../lib/riskGovernor/limitSettings.js", {
  namedExports: { loadEffectiveLimits: async () => ({ ...effective, sources: { maxLotSize: "user_risk_limits.max_lot_size" } }) },
});
const realAudit = await import("../../lib/riskAudit.js");
mock.module("../../lib/riskAudit.js", {
  namedExports: {
    ...realAudit,
    computeRiskAudit: async (balance: number) => {
      auditBalances.push(balance);
      return {
        passed: true, reasonsBlocked: [], warnings: [], riskPercent: 0.5, projectedLoss: 5, riskReward: 2,
        dailyLossUsed: 0, weeklyLossUsed: 0, tradesRemaining: 5, openTradesCount: 0, losingStreak: 0, cooldownActive: false,
      };
    },
  },
});

const { default: router } = await import("../risk.js");

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { log: unknown }).log = { error() {}, warn() {}, info() {} }; next(); });
  app.use(router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

test("GET /risk/audit says it used a $1,000 placeholder and the legacy trades log", async () => {
  const r = await fetch(`${base}/risk/audit`);
  assert.equal(r.status, 200);
  const body = await r.json() as Record<string, unknown>;
  assert.equal(body["balanceSource"], "PLACEHOLDER_1000");
  assert.equal(body["accountBalanceUsed"], auditBalances.at(-1), "the balance reported is the one the audit was sized against");
  assert.equal(body["accountBalanceUsed"], 1000);
  assert.equal(body["tradeSource"], "LEGACY_TRADES_TABLE");
  assert.equal(body["tradeScope"], "ALL_ACCOUNTS", "the legacy read has no user filter");
  assert.deepEqual(
    [...(body["notMeasured"] as string[])].sort(),
    ["cooldownActive", "dailyLossUsed", "losingStreak", "weeklyLossUsed"],
    "loss and streak figures count no legacy close, so they are not measurements",
  );
  assert.ok(!Number.isNaN(Date.parse(String(body["evaluatedAt"]))), "the audit says when it ran");
  // The audit result itself is passed through unchanged.
  assert.equal(body["passed"], true);
  assert.equal(body["tradesRemaining"], 5);
});

// POST /risk/lock-live writes risk_settings.liveLocked, a preference no live
// dispatch gate reads (only the permission status / checklists list it). The
// reply said "Manual unlock required before going live" and "lock removed"
// as if it gated live trading; it now says what the toggle does and does not do.
test("POST /risk/lock-live says the lock is a preference orders are not checked against", async () => {
  const post = async (locked: boolean) => {
    const r = await fetch(`${base}/risk/lock-live`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locked }),
    });
    assert.equal(r.status, 200);
    return r.json() as Promise<{ locked: boolean; message: string }>;
  };
  const on = await post(true);
  assert.equal(on.locked, true);
  assert.doesNotMatch(on.message, /required before going live/);
  assert.match(on.message, /preference/);
  assert.match(on.message, /orders are not checked against it/);
  const off = await post(false);
  assert.equal(off.locked, false);
  assert.match(off.message, /does not enable live trading/);
});

// GET /risk/position-size capped the lot at the trader's own saved cap (or
// the platform 5) and ignored the operator's account limit, so "Max Allowed
// Lot 5.00 / Final Lot Size 2.00" showed for an order the governor refuses.
// It now uses the lot cap in force: strictest of trader, operator, platform,
// and the trader's per-symbol cap.
async function size(symbol: string) {
  const q = new URLSearchParams({ symbol, accountBalance: "100000", riskPercent: "2", entry: "1.1", stopLoss: "1.09" });
  const r = await fetch(`${base}/risk/position-size?${q}`);
  assert.equal(r.status, 200);
  return r.json() as Promise<{ maxLotAllowed: number; finalLot: number; suggestedLot: number }>;
}

test("GET /risk/position-size caps the lot at the operator's limit, not the saved 5", async () => {
  effective.maxLotSize = 0.5; effective.symbolLimits = {};
  const r = await size("EURUSD");
  assert.equal(r.suggestedLot, 2, "the risk budget alone would size 2.00 lots");
  assert.equal(r.maxLotAllowed, 0.5);
  assert.equal(r.finalLot, 0.5);
});

test("GET /risk/position-size applies a stricter per-symbol cap", async () => {
  effective.maxLotSize = 0.5; effective.symbolLimits = { EURUSD: { maxLots: 0.2, blocked: false } };
  const r = await size("eurusd");
  assert.equal(r.maxLotAllowed, 0.2);
  assert.equal(r.finalLot, 0.2);
  effective.symbolLimits = {};
});

