// Owner decision 8: status views show the limit the Risk Governor enforces
// (loadEffectiveLimits: strictest of trader, operator and platform), with the
// trader's saved preference shown separately and the reason an override
// applies. Settings endpoints keep editing the preference.
//
// Covers: effectiveLimitViews / dailyLossCapAmount (pure), the portfolio-risk
// engine's enforced inputs, /me/risk/status + /me/risk/daily-status,
// PATCH /me/risk-settings (still edits the preference), the portfolio-risk
// snapshot (no 2 / 2 / 0.5 display defaults), trader readiness, the
// NEAR_DAILY_LOSS_LIMIT alert and the account shell's risk view.
//
// Run: pnpm --filter @workspace/api-server run test:risk-governor-effective-views
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  alertsTable,
  paperAccountsTable,
  performanceDailyTable,
  portfolioRiskSnapshotsTable,
  userRiskEventsTable,
  userRiskLimitsTable,
  userRiskSettingsTable,
  userAlertsTable,
  usersTable,
  vaultEventsTable,
} from "@workspace/db";
import { computePortfolioRisk } from "@workspace/domain/portfolio-risk";
import { dailyLossCapAmount, resolveEffectiveLimits } from "../preTrade.js";
import { effectiveLimitViews } from "../limitLayers.js";
import { loadEffectiveLimitsMany } from "../limitSettings.js";
import { evaluateReadiness } from "../../readiness/traderReadiness.js";
import { evaluateAndGenerate } from "../../alerts/ruleEngine.js";
import meRiskGovernorRouter from "../../../routes/meRiskGovernor.js";
import portfolioRiskRouter from "../../../routes/portfolioRisk.js";
import meAccountShellRouter from "../../../routes/meAccountShell.js";
import meDashboardRouter from "../../../routes/meDashboard.js";

const P = process.pid;
const u = { op: 0, noRow: 0, off: 0 };
let server: Server;
let base = "";

before(async () => {
  for (const k of Object.keys(u) as Array<keyof typeof u>) {
    const [row] = await db.insert(usersTable)
      .values({ email: `qa+eff-views-${k}-${P}@arx.test`, name: k, role: "USER", isSystemUser: true }).returning();
    u[k] = row!.id;
  }
  // op: saved 10 trades/day, 500 USD daily loss, 4 open; the operator is stricter on both caps.
  await db.insert(userRiskSettingsTable).values([
    { userId: u.op, maxTradesPerDay: 10, maxDailyLossAmount: 500, maxOpenTrades: 4, maxDailyLossPercent: 3 },
    { userId: u.off, blockAfterDailyLossHit: false, maxDailyLossPercent: 2 },
  ]);
  await db.insert(userRiskLimitsTable).values({ userId: u.op, maxLotSize: 5, maxTradesPerDay: 2, maxDailyLossUsd: 100, allowedAccountType: "both" });
  await db.insert(paperAccountsTable).values([
    { userId: u.op, equity: 10_000, currentBalance: 10_000 },
    { userId: u.off, equity: 10_000, currentBalance: 10_000 },
  ]);

  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    const id = Number(req.header("x-test-user"));
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    const r = req as unknown as { authUser: unknown; log: unknown };
    r.authUser = user;
    r.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  app.use(meRiskGovernorRouter);
  app.use(portfolioRiskRouter);
  app.use(meAccountShellRouter);
  app.use(meDashboardRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  const ids = Object.values(u).filter(Boolean);
  if (!ids.length) return;
  await db.delete(alertsTable).where(inArray(alertsTable.userId, ids));
  await db.delete(userAlertsTable).where(inArray(userAlertsTable.userId, ids));
  await db.delete(performanceDailyTable).where(inArray(performanceDailyTable.userId, ids));
  await db.delete(portfolioRiskSnapshotsTable).where(inArray(portfolioRiskSnapshotsTable.userId, ids));
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.userId, ids));
  await db.delete(userRiskLimitsTable).where(inArray(userRiskLimitsTable.userId, ids));
  await db.delete(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
  void vaultEventsTable; void and;
});

const get = async (path: string, user: number) => {
  const r = await fetch(base + path, { headers: { "x-test-user": String(user) } });
  return { status: r.status, body: await r.json() as any };
};
const send = async (method: string, path: string, user: number, body: unknown) => {
  const r = await fetch(base + path, { method, headers: { "x-test-user": String(user), "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};

// ── Pure ───────────────────────────────────────────────────────────────────

test("effectiveLimitViews: operator override, default, switched off", () => {
  const settings = { maxTradesPerDay: 10, maxDailyLossAmount: 500, maxOpenTrades: 4, blockAfterDailyLossHit: true } as never;
  const op = effectiveLimitViews({ userSettings: settings, adminLimits: { maxTradesPerDay: 2, maxDailyLossUsd: 100 } as never });
  assert.equal(op.views["maxTradesPerDay"]!.effective, 2);
  assert.equal(op.views["maxTradesPerDay"]!.preference, 10);
  assert.equal(op.views["maxTradesPerDay"]!.overriddenBy, "account");
  assert.match(op.views["maxTradesPerDay"]!.reason!, /operator/);
  assert.equal(op.views["maxDailyLossAmount"]!.effective, 100);
  assert.equal(op.views["maxDailyLossAmount"]!.overriddenBy, "account");
  assert.equal(op.views["maxOpenTrades"]!.effective, 4);
  assert.equal(op.views["maxOpenTrades"]!.overriddenBy, null, "the saved preference is what is enforced");

  const none = effectiveLimitViews({});
  assert.equal(none.views["maxOpenTrades"]!.effective, 3);
  assert.equal(none.views["maxOpenTrades"]!.overriddenBy, "default");
  assert.equal(none.views["maxDailyLossPercent"]!.effective, 3);
  assert.equal(none.views["maxRiskPerTradePercent"]!.effective, 1);

  const off = effectiveLimitViews({ userSettings: { blockAfterDailyLossHit: false, maxDailyLossPercent: 2 } as never });
  assert.equal(off.views["maxDailyLossPercent"]!.effective, null);
  assert.equal(off.views["maxDailyLossPercent"]!.overriddenBy, "disabled");
});

test("dailyLossCapAmount: stricter of amount and percent of equity; null when nothing applies", () => {
  assert.equal(dailyLossCapAmount({ maxDailyLossPercent: 3, maxDailyLossAmount: 100 }, 10_000), 100);
  assert.equal(dailyLossCapAmount({ maxDailyLossPercent: 3, maxDailyLossAmount: 500 }, 10_000), 300);
  assert.equal(dailyLossCapAmount({ maxDailyLossPercent: 3, maxDailyLossAmount: null }, null), null, "percent only, equity unknown");
  assert.equal(dailyLossCapAmount({ maxDailyLossPercent: 3, maxDailyLossAmount: 80 }, null), 80);
  assert.equal(dailyLossCapAmount({ maxDailyLossPercent: null, maxDailyLossAmount: null }, 10_000), null);
});

test("portfolio-risk engine: enforced open-risk cap and money daily cap; null cap = no daily rule", () => {
  const positions = [{ symbol: "EURUSD", direction: "BUY" as const, lotSize: 1, unrealizedPnl: -900, riskAmount: 0 }];
  const base = { accountBalance: 10_000, accountEquity: 9_100, positions, maxOpenTrades: 3, maxDailyLossPct: 3, riskPerTradePct: 1 };
  const derived = computePortfolioRisk(base);
  assert.ok(derived.blockers.some((b) => /daily loss cap \(300\.00\)/.test(b)), "derived cap = 3% of balance");
  const enforced = computePortfolioRisk({ ...base, dailyLossCapAmount: 100 });
  assert.ok(enforced.blockers.some((b) => /daily loss cap \(100\.00\)/.test(b)));
  const none = computePortfolioRisk({ ...base, maxDailyLossPct: Number.POSITIVE_INFINITY, dailyLossCapAmount: null });
  assert.ok(!none.blockers.some((b) => /daily loss cap/.test(b)), "no enforced daily cap → no daily rule");
  const risky = [{ symbol: "EURUSD", direction: "BUY" as const, lotSize: 1, unrealizedPnl: 0, riskAmount: 250 }];
  const capped = computePortfolioRisk({ ...base, positions: risky, maxOpenRiskPct: 2 });
  assert.ok(capped.warnings.some((w) => /2\.00% cap/.test(w)), "open-risk cap is the enforced portfolio percent");
});

// ── Status endpoints ──────────────────────────────────────────────────────

test("/me/risk/status and /daily-status show the enforced limit, the preference and the reason", async () => {
  const st = await get("/me/risk/status", u.op);
  assert.equal(st.status, 200);
  assert.equal(st.body.settings.maxTradesPerDay, 10, "settings stays the saved row");
  assert.equal(st.body.effective.maxTradesPerDay.effective, 2);
  assert.equal(st.body.effective.maxTradesPerDay.preference, 10);
  assert.equal(st.body.effective.maxTradesPerDay.overriddenBy, "account");
  assert.equal(st.body.effective.maxDailyLossAmount.effective, 100);

  const ds = await get("/me/risk/daily-status", u.op);
  assert.equal(ds.body.maxTradesPerDay, 2, "enforced value");
  assert.equal(ds.body.preference.maxTradesPerDay, 10, "saved preference shown separately");
  assert.equal(ds.body.effective.maxTradesPerDay.overriddenBy, "account");
  assert.equal(ds.body.tradingDay, "UTC");

  const off = await get("/me/risk/daily-status", u.off);
  assert.equal(off.body.maxDailyLossPercent, null, "switched off → no daily-loss limit enforced");
  assert.equal(off.body.preference.maxDailyLossPercent, 2);
});

test("PATCH /me/risk-settings still edits the preference, never the enforced value", async () => {
  const r = await send("PATCH", "/me/risk-settings", u.op, { maxTradesPerDay: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.body.maxTradesPerDay, 7);
  const ds = await get("/me/risk/daily-status", u.op);
  assert.equal(ds.body.preference.maxTradesPerDay, 7);
  assert.equal(ds.body.maxTradesPerDay, 2, "the operator's 2 is still enforced");
  const [lim] = await db.select().from(userRiskLimitsTable).where(eq(userRiskLimitsTable.userId, u.op));
  assert.equal(lim!.maxTradesPerDay, 2, "operator row untouched");
});

test("dashboard cards and intelligence show the enforced caps; the saved value stays the preference", async () => {
  const cards = await get("/me/dashboard/cards", u.op);
  assert.equal(cards.status, 200);
  assert.equal(cards.body.cards.risk.maxTradesPerDay, 2, "operator's cap, not the saved 7");
  const intel = await get("/me/dashboard/intelligence", u.op);
  assert.equal(intel.body.risk.settings.maxTradesPerDay, 7, "saved preference");
  assert.equal(intel.body.risk.effective.maxTradesPerDay.effective, 2);
  assert.equal(intel.body.risk.effective.maxTradesPerDay.overriddenBy, "account");
  const offCards = await get("/me/dashboard/cards", u.off);
  assert.equal(offCards.body.cards.risk.maxTradesPerDay, 5, "saved 5 (column default) is enforced");
});

test("portfolio-risk snapshot uses the enforced limits, not 2 / 2 / 0.5", async () => {
  const none = await send("POST", "/portfolio-risk/snapshot", u.noRow, {});
  assert.equal(none.status, 200);
  const s0 = none.body.inputsSnapshot.settings;
  assert.equal(s0.maxOpenTrades, 3);
  assert.equal(s0.maxDailyLossPct, 3);
  assert.equal(s0.riskPerTradePct, 1);
  const op = await send("POST", "/portfolio-risk/snapshot", u.op, {});
  const s1 = op.body.inputsSnapshot.settings;
  assert.equal(s1.maxOpenTrades, 4);
  assert.equal(s1.maxDailyLossAmount, 100, "operator USD cap is part of the inputs");
  assert.equal(s1.sources.maxDailyLossAmount, "user_risk_limits.max_daily_loss_usd");
});

test("trader readiness: enforced max open and the governor's daily-loss cap; off → no daily-loss block", async () => {
  const op = await evaluateReadiness({ persist: false, userId: u.op });
  assert.equal(op.metrics.maxOpenPaperTrades, 4);
  assert.equal(op.metrics.dailyLossLimit, 100, "min(operator 100 USD, 3% of 10 000 paper equity)");
  const off = await evaluateReadiness({ persist: false, userId: u.off, simulate: { forceDailyPnl: -5_000 } });
  assert.equal(off.metrics.dailyLossLimit, null);
  assert.ok(!off.hardBlocks.some((b) => b.code === "DAILY_LOSS_LIMIT_EXCEEDED"), "no daily-loss limit is enforced");
});

test("NEAR_DAILY_LOSS_LIMIT alert uses the enforced cap (operator USD cap counts; off switch respected)", async () => {
  const dayKey = new Date().toISOString().slice(0, 10);
  await db.insert(performanceDailyTable).values([
    { userId: u.op, date: dayKey, pnl: -90, endBalance: 10_000 },
    { userId: u.off, date: dayKey, pnl: -2_000, endBalance: 10_000 },
  ]);
  const m = await loadEffectiveLimitsMany([u.op, u.off, u.op]);
  assert.equal(m.size, 2);
  assert.equal(m.get(u.op)!.maxDailyLossAmount, 100);
  await evaluateAndGenerate();
  const opAlerts = await db.select().from(alertsTable).where(and(eq(alertsTable.userId, u.op), eq(alertsTable.type, "RISK_LOCK")));
  assert.equal(opAlerts.length, 1, "90 of the enforced 100 cap → alert (the 3% figure alone would be 300)");
  assert.match(opAlerts[0]!.message, /of the 100\.00 max-loss budget/);
  const offAlerts = await db.select().from(alertsTable).where(and(eq(alertsTable.userId, u.off), eq(alertsTable.type, "RISK_LOCK")));
  assert.equal(offAlerts.length, 0, "the trader switched daily-loss blocking off and no operator cap applies");
});

test("account shell risk view: limits in force, preference separate, override reason", async () => {
  const r = await get("/me/account-shell", u.op);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const risk = r.body.risk;
  const L = resolveEffectiveLimits({
    userSettings: (await db.select().from(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, u.op)))[0]!,
    adminLimits: (await db.select().from(userRiskLimitsTable).where(eq(userRiskLimitsTable.userId, u.op)))[0]!,
  });
  assert.equal(risk.maxLotSize, L.maxLotSize);
  assert.equal(risk.maxOpenTrades, 4);
  assert.equal(risk.maxDailyLossAmount, 100, "operator's cap is enforced, not the saved 500");
  assert.equal(risk.preference.maxDailyLossAmount, 500);
  assert.equal(risk.limits.maxDailyLossAmount.overriddenBy, "account");
  assert.equal(risk.requireStopLoss, true);
});
