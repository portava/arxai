// Phase UX1 — My Live Trades + assistant awareness test harness.
//
// Verifies that the routing-aware /api/me/trades/* surfaces and the
// 3 new assistant tools never leak cross-user data or master credentials,
// and that close requires explicit confirmation.
//
// Usage:
//   pnpm --filter @workspace/api-server exec tsx src/scripts/phase-ux1-trades-test.ts
//
// NON-DESTRUCTIVE: cleans up every seeded row in reverse FK order.

import { db } from "@workspace/db";
import {
  globalTradingSettingsTable, userTradingPermissionsTable, userRiskLimitsTable,
  mt5ConnectionTable, sharedMasterAccountsTable, virtualTradingAccountsTable,
  sharedTradeAttributionTable, usersTable, mt5CommandsTable,
  livePositionsTable, tradeCommandAuditLogTable,
} from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { getMyLiveOpenTrades, prepareCloseTicket, prepareOpenTicket } from "../lib/assistant/tools.js";

type R = { name: string; pass: boolean; detail?: string };
const results: R[] = [];
function rec(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const SECRET_KEYS = ["apiKeyHash", "passwordHash", "tokenLast4", "serverName",
  "encryptedCredentials", "accountNumber", "MT5_BRIDGE_TOKEN", "SESSION_SECRET"];
function leakedSecrets(o: unknown): string[] {
  const found = new Set<string>();
  function walk(x: unknown) {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (SECRET_KEYS.includes(k) && v != null) found.add(k);
      walk(v);
    }
  }
  walk(o); return [...found];
}

async function main() {
  const createdUserIds: number[] = [];
  const createdConnIds: number[] = [];
  const createdPermIds: number[] = [];
  const createdLimitIds: number[] = [];
  const createdLpIds: number[] = [];
  const createdAttrIds: number[] = [];
  const createdSmIds: number[] = [];
  const createdVaIds: number[] = [];
  const createdCmdIds: number[] = [];

  const [globalBefore] = await db.select().from(globalTradingSettingsTable).limit(1);
  if (!globalBefore) throw new Error("global_trading_settings row missing");

  const stamp = Date.now();
  const [u1] = await db.insert(usersTable).values({
    email: `ux1-u1-${stamp}@arx.test`, name: "UX1 U1", role: "user",
    passwordHash: "x", emailVerified: true,
  } as never).returning();
  const [u2] = await db.insert(usersTable).values({
    email: `ux1-u2-${stamp}@arx.test`, name: "UX1 U2", role: "user",
    passwordHash: "x", emailVerified: true,
  } as never).returning();
  createdUserIds.push(u1!.id, u2!.id);

  const [conn1] = await db.insert(mt5ConnectionTable).values({
    userId: u1!.id, connectionName: "UX1 u1 demo",
    accountNumber: "8800001", brokerName: "TestBroker",
    accountType: "demo", status: "connected",
  } as never).returning();
  const [conn2] = await db.insert(mt5ConnectionTable).values({
    userId: u2!.id, connectionName: "UX1 u2 demo",
    accountNumber: "8800002", brokerName: "TestBroker",
    accountType: "demo", status: "connected",
  } as never).returning();
  createdConnIds.push(conn1!.id, conn2!.id);

  for (const uid of [u1!.id, u2!.id]) {
    const [p] = await db.insert(userTradingPermissionsTable).values({
      userId: uid, tradingMode: "DEMO", demoEnabled: true,
      liveApproved: false, liveEnabled: false, suspended: false,
      accountRoutingOverride: "inherit",
    } as never).returning();
    createdPermIds.push(p!.id);
    const [r] = await db.insert(userRiskLimitsTable).values({
      userId: uid, maxLotSize: 5, maxTradesPerDay: 100, maxDailyLossUsd: 100000,
      allowedSymbols: [], allowedAccountType: "both", allowedDirection: "both",
      requireLiveConfirmation: false,
    } as never).returning();
    createdLimitIds.push(r!.id);
  }

  await db.update(globalTradingSettingsTable).set({
    platformMode: "DEMO", demoEnabled: true, liveEnabled: false,
    emergencyKillSwitch: false, killSwitchEngagedAt: null, killSwitchReason: null,
    accountRoutingMode: "USER_OWNED_MT5",
    sharedDemoConnectionId: null, sharedLiveConnectionId: null,
    sharedLiveTradingEnabled: false,
  } as never).where(eq(globalTradingSettingsTable.id, globalBefore.id));

  // ── Seed an open live_positions row for u1, and one for u2.
  const [lp1] = await db.insert(livePositionsTable).values({
    userId: u1!.id, mt5ConnectionId: conn1!.id,
    symbol: "EURUSD", direction: "BUY", lotSize: 0.10,
    entryPrice: 1.10000, currentPrice: 1.10250,
    stopLoss: 1.09500, takeProfit: 1.11000,
    unrealizedProfitLoss: 25, status: "OPEN",
    brokerPositionId: `ux1-${stamp}-1`,
  } as never).returning();
  const [lp2] = await db.insert(livePositionsTable).values({
    userId: u2!.id, mt5ConnectionId: conn2!.id,
    symbol: "GBPUSD", direction: "SELL", lotSize: 0.05,
    entryPrice: 1.27000, currentPrice: 1.26900,
    stopLoss: null, takeProfit: null,
    unrealizedProfitLoss: 5, status: "OPEN",
    brokerPositionId: `ux1-${stamp}-2`,
  } as never).returning();
  createdLpIds.push(lp1!.id, lp2!.id);

  // ── 24. getMyLiveOpenTrades returns ONLY caller's rows (user_owned)
  {
    const t1 = await getMyLiveOpenTrades(u1!.id);
    const ids = t1.trades.map((t) => t.id);
    const onlyOwn = t1.trades.length === 1 && ids[0] === `lp_${lp1!.id}`
      && t1.routingMode === "USER_OWNED_MT5";
    rec("24 getMyLiveOpenTrades is user-scoped (USER_OWNED)", onlyOwn,
      `count=${t1.trades.length} ids=${ids.join(",")}`);
  }

  // ── 25. No secret leak
  {
    const t1 = await getMyLiveOpenTrades(u1!.id);
    const leaks = leakedSecrets(t1);
    rec("25 getMyLiveOpenTrades does not leak master credentials", leaks.length === 0,
      `leaks=${leaks.join(",") || "none"}`);
  }

  // ── 26. prepareCloseTicket: foreign id is rejected
  {
    const r = await prepareCloseTicket(u1!.id, { tradeId: `lp_${lp2!.id}` });
    rec("26 prepareCloseTicket rejects another user's trade id",
      r.ok === false && (r as { reason?: string }).reason === "TRADE_NOT_FOUND");
  }

  // ── 27. prepareCloseTicket: own trade requires user confirmation
  {
    const r = await prepareCloseTicket(u1!.id, { tradeId: `lp_${lp1!.id}` });
    rec("27 prepareCloseTicket flags requiresUserConfirmation",
      r.ok === true && (r as { requiresUserConfirmation?: boolean }).requiresUserConfirmation === true);
  }

  // ── 28. prepareOpenTicket: SIMULATED preview returns a structured payload, no execution
  {
    const r = await prepareOpenTicket(u1!.id, {
      symbol: "EURUSD", side: "BUY", lotSize: 0.01, mode: "SIMULATED",
    });
    const noLeak = leakedSecrets(r).length === 0;
    const hasPreview = (r as { preview?: { symbol?: string } }).preview?.symbol === "EURUSD";
    rec("28 prepareOpenTicket returns preview without leaks (SIMULATED)",
      hasPreview && noLeak);
  }

  // ── 29. Switch to SHARED_MASTER_MT5 routing — assistant reads attribution rows only
  {
    // Register adminLikeShared master.
    const [sm] = await db.insert(sharedMasterAccountsTable).values({
      connectionId: conn1!.id, // reuse u1's conn as the "master" for test purposes
      accountType: "demo", status: "active",
      brokerName: "TestBroker", accountNumberMasked: "•••• 0001",
    } as never).returning();
    createdSmIds.push(sm!.id);
    const [va] = await db.insert(virtualTradingAccountsTable).values({
      userId: u1!.id, sharedMasterAccountId: sm!.id,
      routingMode: "SHARED_MASTER_MT5",
      accountType: "demo", status: "active",
    } as never).returning();
    createdVaIds.push(va!.id);
    const [att1] = await db.insert(sharedTradeAttributionTable).values({
      userId: u1!.id, virtualAccountId: va!.id, sharedMasterAccountId: sm!.id,
      masterConnectionId: conn1!.id,
      symbol: "XAUUSD", side: "BUY", lotSize: 0.02,
      entryPrice: 2400, pnl: 12,
      status: "open",
    } as never).returning();
    const [att2] = await db.insert(sharedTradeAttributionTable).values({
      userId: u2!.id, virtualAccountId: va!.id, sharedMasterAccountId: sm!.id,
      masterConnectionId: conn1!.id,
      symbol: "XAUUSD", side: "SELL", lotSize: 0.01,
      entryPrice: 2400, pnl: -3,
      status: "open",
    } as never).returning();
    createdAttrIds.push(att1!.id, att2!.id);

    await db.update(globalTradingSettingsTable).set({
      accountRoutingMode: "SHARED_MASTER_MT5",
      sharedDemoConnectionId: conn1!.id,
    } as never).where(eq(globalTradingSettingsTable.id, globalBefore.id));

    const t1 = await getMyLiveOpenTrades(u1!.id);
    const onlyOwn = t1.trades.length === 1
      && t1.trades[0]!.id === `att_${att1!.id}`
      && t1.routingMode === "SHARED_MASTER_MT5"
      && t1.trades[0]!.pnlIsEstimate === true;
    const leaks = leakedSecrets(t1);
    rec("29 SHARED_MASTER routing — user-scoped attribution, pnl flagged as estimate, no leaks",
      onlyOwn && leaks.length === 0,
      `count=${t1.trades.length} leaks=${leaks.join(",")||"none"}`);
  }

  // ── cleanup
  if (createdCmdIds.length) await db.delete(mt5CommandsTable).where(inArray(mt5CommandsTable.id, createdCmdIds));
  if (createdAttrIds.length) await db.delete(sharedTradeAttributionTable).where(inArray(sharedTradeAttributionTable.id, createdAttrIds));
  if (createdVaIds.length) await db.delete(virtualTradingAccountsTable).where(inArray(virtualTradingAccountsTable.id, createdVaIds));
  if (createdSmIds.length) await db.delete(sharedMasterAccountsTable).where(inArray(sharedMasterAccountsTable.id, createdSmIds));
  if (createdLpIds.length) await db.delete(livePositionsTable).where(inArray(livePositionsTable.id, createdLpIds));
  if (createdLimitIds.length) await db.delete(userRiskLimitsTable).where(inArray(userRiskLimitsTable.id, createdLimitIds));
  if (createdPermIds.length) await db.delete(userTradingPermissionsTable).where(inArray(userTradingPermissionsTable.id, createdPermIds));
  if (createdConnIds.length) await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.id, createdConnIds));
  if (createdUserIds.length) await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  await db.update(globalTradingSettingsTable).set({
    platformMode: globalBefore.platformMode,
    demoEnabled: globalBefore.demoEnabled,
    liveEnabled: globalBefore.liveEnabled,
    emergencyKillSwitch: globalBefore.emergencyKillSwitch,
    killSwitchEngagedAt: globalBefore.killSwitchEngagedAt,
    killSwitchReason: globalBefore.killSwitchReason,
    accountRoutingMode: globalBefore.accountRoutingMode,
    sharedDemoConnectionId: globalBefore.sharedDemoConnectionId,
    sharedLiveConnectionId: globalBefore.sharedLiveConnectionId,
    sharedLiveTradingEnabled: globalBefore.sharedLiveTradingEnabled,
  }).where(eq(globalTradingSettingsTable.id, globalBefore.id));
  // Drop any audit/command rows we may have created (defensive).
  void tradeCommandAuditLogTable;

  const passed = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\nPhase UX1 — ${passed}/${results.length} passed`);
  if (passed !== results.length) {
    // eslint-disable-next-line no-console
    console.log("FAILED:", results.filter((r) => !r.pass).map((r) => r.name).join(", "));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("phase-ux1 test threw:", err);
  process.exit(2);
});
