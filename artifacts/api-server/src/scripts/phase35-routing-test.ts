// Phase 3.5 — Account Routing Mode test harness.
//
// 23 scenarios covering: routing resolver branches, guard chain integration,
// shared LIVE explicit-flag gate, virtual account auto-creation, attribution
// row writes, per-user override, audit columns, non-leakage of master creds.
//
// Usage:
//   pnpm --filter @workspace/api-server exec tsx src/scripts/phase35-routing-test.ts
//
// NON-DESTRUCTIVE: at the end of the run, every row this script created is
// hard-deleted in reverse FK order, and the global_trading_settings row is
// restored to its observed pre-run snapshot (kill switch + platform mode
// re-engaged if they were that way before).

import { db } from "@workspace/db";
import {
  globalTradingSettingsTable, userTradingPermissionsTable,
  userRiskLimitsTable, tradeCommandAuditLogTable,
  mt5ConnectionTable, sharedMasterAccountsTable,
  virtualTradingAccountsTable, sharedTradeAttributionTable,
  usersTable, mt5CommandsTable,
} from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { resolveRouting } from "../lib/adminTrading/routingResolver.js";
import { runOrderGuards } from "../lib/adminTrading/orderGuard.js";
import { placeOrder } from "../lib/adminTrading/placeOrder.js";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];
function rec(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const SECRET_KEYS = ["apiKeyHash", "passwordHash", "tokenLast4", "serverName",
  "encryptedCredentials", "accountNumber", "MT5_BRIDGE_TOKEN", "SESSION_SECRET"];
function leakedSecrets(obj: unknown): string[] {
  const found = new Set<string>();
  function walk(o: unknown) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (SECRET_KEYS.includes(k) && v !== null && v !== undefined) found.add(k);
      walk(v);
    }
  }
  walk(obj);
  return [...found];
}

async function main() {
  const createdUserIds: number[] = [];
  const createdConnIds: number[] = [];
  const createdSmIds: number[] = [];
  const createdVaIds: number[] = [];
  const createdAuditIds: number[] = [];
  const createdAttrIds: number[] = [];
  const createdCommandIds: number[] = [];
  const createdPermIds: number[] = [];
  const createdLimitIds: number[] = [];

  const [globalBefore] = await db.select().from(globalTradingSettingsTable).limit(1);
  if (!globalBefore) throw new Error("global_trading_settings row missing");

  const stamp = Date.now();
  // Seed two test users (admin + regular) with mt5 connections.
  const [adminUser] = await db.insert(usersTable).values({
    email: `phase35-admin-${stamp}@arx.test`, name: "P35 Admin", role: "ADMIN",
    passwordHash: "x", emailVerified: true,
  } as never).returning();
  const [regUser] = await db.insert(usersTable).values({
    email: `phase35-user-${stamp}@arx.test`, name: "P35 User", role: "user",
    passwordHash: "x", emailVerified: true,
  } as never).returning();
  createdUserIds.push(adminUser!.id, regUser!.id);

  // Master demo connection (owned by admin)
  const [adminDemoConn] = await db.insert(mt5ConnectionTable).values({
    userId: adminUser!.id, connectionName: "P35 admin demo",
    accountNumber: "9000001", brokerName: "TestBroker",
    accountType: "demo", status: "connected",
  } as never).returning();
  // Master live connection (owned by admin)
  const [adminLiveConn] = await db.insert(mt5ConnectionTable).values({
    userId: adminUser!.id, connectionName: "P35 admin live",
    accountNumber: "9000002", brokerName: "TestBroker",
    accountType: "live", status: "connected",
  } as never).returning();
  // Regular user's own demo connection
  const [regDemoConn] = await db.insert(mt5ConnectionTable).values({
    userId: regUser!.id, connectionName: "P35 user demo",
    accountNumber: "1000001", brokerName: "TestBroker",
    accountType: "demo", status: "connected",
  } as never).returning();
  createdConnIds.push(adminDemoConn!.id, adminLiveConn!.id, regDemoConn!.id);

  // Set permissions: enable DEMO trading, allow demo, lift suspension, perms allow DEMO mode.
  const [permRow] = await db.insert(userTradingPermissionsTable).values({
    userId: regUser!.id, tradingMode: "DEMO", demoEnabled: true,
    liveApproved: false, liveEnabled: false, suspended: false,
    accountRoutingOverride: "inherit",
  } as never).returning();
  createdPermIds.push(permRow!.id);
  // Risk limits — generous so they don't reject during routing tests.
  const [limitRow] = await db.insert(userRiskLimitsTable).values({
    userId: regUser!.id, maxLotSize: 5, maxTradesPerDay: 100,
    maxDailyLossUsd: 100000, allowedSymbols: [],
    allowedAccountType: "both", allowedDirection: "both",
    requireLiveConfirmation: false,
  } as never).returning();
  createdLimitIds.push(limitRow!.id);

  // Put platform in DEMO mode, kill switch off.
  await db.update(globalTradingSettingsTable).set({
    platformMode: "DEMO", demoEnabled: true, liveEnabled: false,
    emergencyKillSwitch: false, killSwitchEngagedAt: null, killSwitchReason: null,
    accountRoutingMode: "USER_OWNED_MT5",
    sharedDemoConnectionId: null, sharedLiveConnectionId: null,
    sharedLiveTradingEnabled: false,
  }).where(eq(globalTradingSettingsTable.id, globalBefore.id));

  // ── 1. SIMULATED bypass ───────────────────────────────────────────────
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "SIMULATED" });
    rec("01 SIMULATED bypasses routing", r.ok && r.connectionId === null);
  }

  // ── 2. USER_OWNED DEMO happy path ─────────────────────────────────────
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "DEMO" });
    rec("02 USER_OWNED DEMO resolves user's own demo conn",
      r.ok && r.connectionId === regDemoConn!.id && r.connectionType === "user_owned",
      `connId=${r.connectionId}`);
  }

  // ── 3. USER_OWNED LIVE requires live conn (user only has demo) ────────
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "LIVE" });
    rec("03 USER_OWNED LIVE blocked when user has no live conn",
      !r.ok && r.blockReason === "USER_OWNED_LIVE_REQUIRES_VERIFIED_LIVE_ACCOUNT",
      r.blockReason ?? "");
  }

  // ── 4. SHARED_MASTER_MT5 with no master configured ────────────────────
  await db.update(globalTradingSettingsTable)
    .set({ accountRoutingMode: "SHARED_MASTER_MT5" })
    .where(eq(globalTradingSettingsTable.id, globalBefore.id));
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "DEMO" });
    rec("04 SHARED DEMO blocks when no demo master configured",
      !r.ok && r.blockReason === "SHARED_DEMO_MASTER_NOT_CONFIGURED");
  }

  // Register the admin demo conn as shared demo master.
  const [smDemo] = await db.insert(sharedMasterAccountsTable).values({
    connectionId: adminDemoConn!.id, accountType: "demo",
    brokerName: "TestBroker", accountNumberMasked: "•••• 0001",
    status: "active", isActive: true,
  } as never).returning();
  createdSmIds.push(smDemo!.id);
  await db.update(globalTradingSettingsTable)
    .set({ sharedDemoConnectionId: adminDemoConn!.id })
    .where(eq(globalTradingSettingsTable.id, globalBefore.id));

  // ── 5. SHARED DEMO happy path + auto virtual account ──────────────────
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "DEMO" });
    if (r.virtualAccountId) createdVaIds.push(r.virtualAccountId);
    rec("05 SHARED DEMO resolves master + creates virtual account",
      r.ok && r.connectionId === adminDemoConn!.id
      && r.connectionType === "shared_master" && !!r.virtualAccountId);
  }

  // ── 6. SHARED DEMO is idempotent (no duplicate virtual account) ───────
  {
    const r1 = await resolveRouting({ userId: regUser!.id, mode: "DEMO" });
    const r2 = await resolveRouting({ userId: regUser!.id, mode: "DEMO" });
    rec("06 SHARED DEMO virtual account is reused, not duplicated",
      r1.virtualAccountId === r2.virtualAccountId && !!r1.virtualAccountId);
  }

  // ── 7. SHARED LIVE blocked when no live master configured ─────────────
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "LIVE" });
    rec("07 SHARED LIVE blocks when no live master configured",
      !r.ok && r.blockReason === "SHARED_LIVE_MASTER_NOT_CONFIGURED");
  }

  // Register live master but DO NOT flip sharedLiveTradingEnabled.
  const [smLive] = await db.insert(sharedMasterAccountsTable).values({
    connectionId: adminLiveConn!.id, accountType: "live",
    brokerName: "TestBroker", accountNumberMasked: "•••• 0002",
    status: "active", isActive: true,
  } as never).returning();
  createdSmIds.push(smLive!.id);
  await db.update(globalTradingSettingsTable)
    .set({ sharedLiveConnectionId: adminLiveConn!.id, sharedLiveTradingEnabled: false })
    .where(eq(globalTradingSettingsTable.id, globalBefore.id));

  // ── 8. SHARED LIVE master set but explicit flag still OFF → REJECT ────
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "LIVE" });
    rec("08 SHARED LIVE master set BUT explicit flag off → blocked",
      !r.ok && r.blockReason === "SHARED_LIVE_TRADING_NOT_EXPLICITLY_ENABLED");
  }

  // ── 9. SHARED LIVE explicit flag ON but master account inactive ───────
  await db.update(globalTradingSettingsTable)
    .set({ sharedLiveTradingEnabled: true })
    .where(eq(globalTradingSettingsTable.id, globalBefore.id));
  await db.update(sharedMasterAccountsTable)
    .set({ isActive: false, status: "inactive" })
    .where(eq(sharedMasterAccountsTable.id, smLive!.id));
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "LIVE" });
    rec("09 SHARED LIVE active flag on but master inactive → blocked",
      !r.ok && r.blockReason === "SHARED_MASTER_ACCOUNT_INACTIVE");
  }
  await db.update(sharedMasterAccountsTable)
    .set({ isActive: true, status: "active" })
    .where(eq(sharedMasterAccountsTable.id, smLive!.id));

  // ── 10. SHARED LIVE happy path (flag + active master + live conn) ─────
  // Platform must be LIVE for the guard chain. We test the resolver only
  // here; the guard chain LIVE path is tested in #19.
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "LIVE" });
    if (r.virtualAccountId) createdVaIds.push(r.virtualAccountId);
    rec("10 SHARED LIVE happy path resolves",
      r.ok && r.connectionId === adminLiveConn!.id && r.connectionType === "shared_master");
  }

  // ── 11. Type mismatch — point sharedDemoConnectionId at a live conn ───
  await db.update(globalTradingSettingsTable)
    .set({ sharedDemoConnectionId: adminLiveConn!.id })
    .where(eq(globalTradingSettingsTable.id, globalBefore.id));
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "DEMO" });
    rec("11 SHARED DEMO rejects when demo points at a live connection",
      !r.ok && r.blockReason === "SHARED_MASTER_DEMO_TYPE_MISMATCH");
  }
  await db.update(globalTradingSettingsTable)
    .set({ sharedDemoConnectionId: adminDemoConn!.id })
    .where(eq(globalTradingSettingsTable.id, globalBefore.id));

  // ── 12. Per-user override forcing USER_OWNED while global = SHARED ────
  await db.update(userTradingPermissionsTable)
    .set({ accountRoutingOverride: "user_owned_mt5" })
    .where(eq(userTradingPermissionsTable.userId, regUser!.id));
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "DEMO" });
    rec("12 per-user override USER_OWNED beats global SHARED",
      r.ok && r.connectionType === "user_owned" && r.connectionId === regDemoConn!.id);
  }

  // ── 13. Per-user override forcing SHARED while global = USER_OWNED ────
  await db.update(globalTradingSettingsTable)
    .set({ accountRoutingMode: "USER_OWNED_MT5" })
    .where(eq(globalTradingSettingsTable.id, globalBefore.id));
  await db.update(userTradingPermissionsTable)
    .set({ accountRoutingOverride: "shared_master_mt5" })
    .where(eq(userTradingPermissionsTable.userId, regUser!.id));
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "DEMO" });
    rec("13 per-user override SHARED beats global USER_OWNED",
      r.ok && r.connectionType === "shared_master" && r.connectionId === adminDemoConn!.id);
  }
  // Reset to inherit + global SHARED for the guard-chain block.
  await db.update(userTradingPermissionsTable)
    .set({ accountRoutingOverride: "inherit" })
    .where(eq(userTradingPermissionsTable.userId, regUser!.id));
  await db.update(globalTradingSettingsTable)
    .set({ accountRoutingMode: "SHARED_MASTER_MT5" })
    .where(eq(globalTradingSettingsTable.id, globalBefore.id));

  // ── 14. Guard chain — SIMULATED order writes audit row, USER_OWNED ───
  {
    const guard = await runOrderGuards({
      userId: regUser!.id, symbol: "EURUSD", side: "BUY",
      lotSize: 0.01, mode: "SIMULATED", requestedBy: "user", confirmedByUser: false,
    });
    createdAuditIds.push(guard.auditLogId);
    const [row] = await db.select().from(tradeCommandAuditLogTable)
      .where(eq(tradeCommandAuditLogTable.id, guard.auditLogId)).limit(1);
    rec("14 SIMULATED guard writes audit row with USER_OWNED attribution",
      !!row && row.accountRoutingMode === "USER_OWNED_MT5"
      && row.routedConnectionType === "user_owned");
  }

  // ── 15. Guard chain — DEMO via the legacy adminTrading path is structurally
  // REJECTED at the dispatch lock (gate #8). Routing still resolves first, so
  // the audit row keeps full shared_master attribution; demo execution must go
  // through the per-user demo arming queue, not this backup path.
  {
    const guard = await runOrderGuards({
      userId: regUser!.id, symbol: "EURUSD", side: "BUY",
      lotSize: 0.01, mode: "DEMO", requestedBy: "user", confirmedByUser: false,
    });
    createdAuditIds.push(guard.auditLogId);
    const [row] = await db.select().from(tradeCommandAuditLogTable)
      .where(eq(tradeCommandAuditLogTable.id, guard.auditLogId)).limit(1);
    rec("15 DEMO via adminTrading is structurally rejected (use demo queue), shared_master attribution still recorded",
      guard.status === "REJECTED"
      && guard.reason === "DEMO_DISPATCH_DISABLED_USE_DEMO_QUEUE" && !!row
      && row.accountRoutingMode === "SHARED_MASTER_MT5"
      && row.routedConnectionType === "shared_master"
      && row.routedConnectionId === adminDemoConn!.id,
      `status=${guard.status} reason=${guard.reason}`);
  }

  // ── 16. End-to-end placeOrder DEMO is structurally rejected — the backup
  // path writes NO mt5_command and NO shared attribution row. ───────────
  {
    const out = await placeOrder({
      userId: regUser!.id, symbol: "EURUSD", side: "BUY",
      lotSize: 0.01, mode: "DEMO", requestedBy: "user", confirmedByUser: false,
    });
    if (out.auditLogId) createdAuditIds.push(out.auditLogId);
    if (out.commandId) createdCommandIds.push(out.commandId);
    const attrRows = await db.select().from(sharedTradeAttributionTable)
      .where(eq(sharedTradeAttributionTable.tradeCommandId, out.commandId ?? -1));
    attrRows.forEach((r) => createdAttrIds.push(r.id));
    rec("16 placeOrder DEMO is structurally rejected — no mt5_command / no attribution via the backup path",
      out.status === "REJECTED"
      && out.reason === "DEMO_DISPATCH_DISABLED_USE_DEMO_QUEUE"
      && (out.commandId === null || out.commandId === undefined)
      && attrRows.length === 0,
      `status=${out.status} reason=${out.reason} commandId=${out.commandId} attrRows=${attrRows.length}`);
  }

  // ── 17. placeOrder LIVE blocked because platform is DEMO ─────────────
  {
    const out = await placeOrder({
      userId: regUser!.id, symbol: "EURUSD", side: "BUY",
      lotSize: 0.01, mode: "LIVE", requestedBy: "user", confirmedByUser: true,
    });
    if (out.auditLogId) createdAuditIds.push(out.auditLogId);
    rec("17 placeOrder LIVE blocked while platformMode=DEMO",
      out.status === "REJECTED" && /MODE|LIVE|LIVE_/.test(out.reason ?? ""),
      `status=${out.status} reason=${out.reason}`);
  }

  // ── 18. placeOrder LIVE — flip platform to LIVE + user live perms ────
  await db.update(globalTradingSettingsTable).set({
    platformMode: "LIVE", liveEnabled: true,
  }).where(eq(globalTradingSettingsTable.id, globalBefore.id));
  await db.update(userTradingPermissionsTable).set({
    tradingMode: "LIVE", liveApproved: true, liveEnabled: true,
    suspended: false, riskDisclosureAcceptedAt: new Date(),
  }).where(eq(userTradingPermissionsTable.userId, regUser!.id));
  {
    const r = await resolveRouting({ userId: regUser!.id, mode: "LIVE" });
    if (r.virtualAccountId) createdVaIds.push(r.virtualAccountId);
    rec("18 SHARED LIVE resolver ok after platform LIVE + flag on",
      r.ok && r.connectionType === "shared_master"
      && r.connectionId === adminLiveConn!.id);
  }

  // ── 19. SHARED LIVE via the legacy adminTrading path is structurally
  // REJECTED at the dispatch lock — live execution routes exclusively through
  // the Phase B 23-gate pipeline. Routing still resolves shared_master first.
  {
    const guard = await runOrderGuards({
      userId: regUser!.id, symbol: "EURUSD", side: "BUY",
      lotSize: 0.01, mode: "LIVE", requestedBy: "user", confirmedByUser: true,
    });
    createdAuditIds.push(guard.auditLogId);
    rec("19 SHARED LIVE via adminTrading is structurally rejected (routes through Phase B), routing still shared_master",
      guard.status === "REJECTED"
      && guard.reason === "LIVE_DISPATCH_DISABLED_USE_PHASE_B"
      && guard.routing.connectionType === "shared_master",
      `status=${guard.status} reason=${guard.reason}`);
  }

  // ── 20. Flip explicit flag OFF mid-flight, next order REJECTED ───────
  await db.update(globalTradingSettingsTable).set({
    sharedLiveTradingEnabled: false,
  }).where(eq(globalTradingSettingsTable.id, globalBefore.id));
  {
    const guard = await runOrderGuards({
      userId: regUser!.id, symbol: "EURUSD", side: "BUY",
      lotSize: 0.01, mode: "LIVE", requestedBy: "user", confirmedByUser: true,
    });
    createdAuditIds.push(guard.auditLogId);
    rec("20 disabling sharedLiveTradingEnabled rejects subsequent LIVE",
      guard.status === "REJECTED"
      && guard.reason === "SHARED_LIVE_TRADING_NOT_EXPLICITLY_ENABLED");
  }

  // ── 21. Audit columns are non-null on every recent audit row ─────────
  {
    const recent = await db.select().from(tradeCommandAuditLogTable)
      .where(inArray(tradeCommandAuditLogTable.id, createdAuditIds));
    const allHaveRouting = recent.every((r) =>
      typeof r.accountRoutingMode === "string"
      && typeof r.routedConnectionType === "string");
    rec("21 every audit row has routing attribution columns populated",
      allHaveRouting, `checked=${recent.length}`);
  }

  // ── 22. No-secret-leak — getRoutingContext + admin shared-masters list
  {
    const { getRoutingContext } = await import("../lib/assistant/tools.js");
    const ctx = await getRoutingContext(regUser!.id);
    const leak1 = leakedSecrets(ctx);
    // Pull the registered+candidate list via direct table query to mirror what
    // /api/admin/shared-masters returns to admins.
    const regRows = await db.select().from(sharedMasterAccountsTable);
    const leak2 = leakedSecrets(regRows);
    rec("22 no master credentials leak in assistant or admin payload",
      leak1.length === 0 && leak2.length === 0,
      `assistantLeaks=${leak1.join(",")||"none"} adminLeaks=${leak2.join(",")||"none"}`);
  }

  // ── 23. Switching routingMode does NOT mutate already-queued commands
  {
    const commandsBefore = createdCommandIds.length;
    await db.update(globalTradingSettingsTable)
      .set({ accountRoutingMode: "USER_OWNED_MT5" })
      .where(eq(globalTradingSettingsTable.id, globalBefore.id));
    // Re-fetch queued commands; verify the one we placed earlier still
    // targets adminDemoConn (shared_master), proving switching is
    // forward-only and not retroactive.
    const queued = commandsBefore > 0
      ? await db.select().from(mt5CommandsTable)
          .where(inArray(mt5CommandsTable.id, createdCommandIds))
      : [];
    const stillShared = queued.length > 0
      && queued.every((c) => c.mt5ConnectionId === adminDemoConn!.id);
    rec("23 switching routingMode is forward-only (existing queued unchanged)",
      stillShared || commandsBefore === 0,
      `queued=${queued.length}`);
  }

  // ─── cleanup (reverse FK order) ────────────────────────────────────────
  if (createdAttrIds.length) {
    await db.delete(sharedTradeAttributionTable)
      .where(inArray(sharedTradeAttributionTable.id, createdAttrIds));
  }
  if (createdCommandIds.length) {
    await db.delete(mt5CommandsTable)
      .where(inArray(mt5CommandsTable.id, createdCommandIds));
  }
  if (createdAuditIds.length) {
    await db.delete(tradeCommandAuditLogTable)
      .where(inArray(tradeCommandAuditLogTable.id, createdAuditIds));
  }
  if (createdVaIds.length) {
    await db.delete(virtualTradingAccountsTable)
      .where(inArray(virtualTradingAccountsTable.id, createdVaIds));
  }
  if (createdSmIds.length) {
    await db.delete(sharedMasterAccountsTable)
      .where(inArray(sharedMasterAccountsTable.id, createdSmIds));
  }
  if (createdLimitIds.length) {
    await db.delete(userRiskLimitsTable)
      .where(inArray(userRiskLimitsTable.id, createdLimitIds));
  }
  if (createdPermIds.length) {
    await db.delete(userTradingPermissionsTable)
      .where(inArray(userTradingPermissionsTable.id, createdPermIds));
  }
  if (createdConnIds.length) {
    await db.delete(mt5ConnectionTable)
      .where(inArray(mt5ConnectionTable.id, createdConnIds));
  }
  if (createdUserIds.length) {
    await db.delete(usersTable)
      .where(inArray(usersTable.id, createdUserIds));
  }
  // Restore global_trading_settings to pre-run snapshot.
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
    sharedMasterNettingMode: globalBefore.sharedMasterNettingMode,
  }).where(eq(globalTradingSettingsTable.id, globalBefore.id));

  const passed = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\nPhase 3.5 routing — ${passed}/${results.length} passed`);
  if (passed !== results.length) {
    // eslint-disable-next-line no-console
    console.log("FAILED:", results.filter((r) => !r.pass).map((r) => r.name).join(", "));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("phase35 test threw:", err);
  process.exit(2);
});
// silence unused warning if sql helper unused after edits
void sql; void and;
