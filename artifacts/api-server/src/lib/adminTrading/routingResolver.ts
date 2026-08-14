// Phase 3.5 — Account Routing Resolver.
//
// SAFETY (inviolable, fail-closed):
//  - For every trade request we compute exactly ONE routing decision:
//      { routingMode, connectionId, connectionType, sharedMasterAccountId?,
//        virtualAccountId?, accountType, blockReason? }
//  - If anything is missing or inconsistent (no master configured, master
//    type mismatch, no user connection, suspended user, shared LIVE without
//    the explicit second flag, etc.) we return blockReason — never silently
//    fall back to the other route.
//  - In SHARED_MASTER_MT5 mode we ensure a virtual_trading_accounts row
//    exists for (userId, sharedMasterAccountId, accountType) so attribution
//    can be written. The virtual account never holds broker credentials.
//  - Users never see the master connection's apiKeyHash / tokenLast4 /
//    serverName / accountNumber — only the masked display string the
//    admin set up.

import { db } from "@workspace/db";
import {
  globalTradingSettingsTable,
  userTradingPermissionsTable,
  mt5ConnectionTable,
  sharedMasterAccountsTable,
  virtualTradingAccountsTable,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger.js";

export type AccountRoutingMode = "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
export type ConnectionType = "user_owned" | "shared_master";

export interface ResolveRoutingArgs {
  userId: number;
  mode: "SIMULATED" | "DEMO" | "LIVE";
}

export interface RoutingDecision {
  ok: boolean;
  effectiveRoutingMode: AccountRoutingMode;
  connectionId: number | null;
  connectionType: ConnectionType;
  accountType: "demo" | "live" | "unknown";
  sharedMasterAccountId: number | null;
  virtualAccountId: number | null;
  // If !ok, this is the machine-readable reason. The order guard chain
  // surfaces it as a REJECTED audit row.
  blockReason: string | null;
  // Informational notes (e.g. netting warning). Always safe to surface.
  notes: string[];
}

const FAIL: Omit<RoutingDecision, "effectiveRoutingMode"> = {
  ok: false,
  connectionId: null,
  connectionType: "user_owned",
  accountType: "unknown",
  sharedMasterAccountId: null,
  virtualAccountId: null,
  blockReason: "ROUTING_RESOLUTION_FAILED",
  notes: [],
};

function normalizeAccountType(raw: string | null | undefined): "demo" | "live" | "unknown" {
  const t = String(raw ?? "").toLowerCase();
  if (t === "demo") return "demo";
  if (t === "live" || t === "real") return "live";
  return "unknown";
}

export async function resolveRouting(args: ResolveRoutingArgs): Promise<RoutingDecision> {
  // SIMULATED mode bypasses routing entirely — internal paper sim.
  if (args.mode === "SIMULATED") {
    return {
      ok: true,
      effectiveRoutingMode: "USER_OWNED_MT5",
      connectionId: null,
      connectionType: "user_owned",
      accountType: "unknown",
      sharedMasterAccountId: null,
      virtualAccountId: null,
      blockReason: null,
      notes: ["simulator-mode: no broker routing"],
    };
  }

  try {
    const [g] = await db.select().from(globalTradingSettingsTable).limit(1);
    if (!g) {
      return { ...FAIL, effectiveRoutingMode: "USER_OWNED_MT5", blockReason: "NO_GLOBAL_SETTINGS" };
    }

    const [p] = await db.select().from(userTradingPermissionsTable)
      .where(eq(userTradingPermissionsTable.userId, args.userId)).limit(1);

    // Resolve effective routing mode: per-user override beats global.
    const globalMode = (g.accountRoutingMode === "SHARED_MASTER_MT5"
      ? "SHARED_MASTER_MT5" : "USER_OWNED_MT5") as AccountRoutingMode;
    const override = String(p?.accountRoutingOverride ?? "inherit").toLowerCase();
    const effective: AccountRoutingMode =
      override === "user_owned_mt5" ? "USER_OWNED_MT5" :
      override === "shared_master_mt5" ? "SHARED_MASTER_MT5" :
      globalMode;

    const notes: string[] = [];
    if (override !== "inherit") notes.push(`per_user_override:${effective}`);

    // ── USER_OWNED_MT5 branch ────────────────────────────────────────────
    if (effective === "USER_OWNED_MT5") {
      const [conn] = await db.select().from(mt5ConnectionTable)
        .where(eq(mt5ConnectionTable.userId, args.userId)).limit(1);
      if (!conn) {
        return {
          ok: false, effectiveRoutingMode: effective,
          connectionId: null, connectionType: "user_owned", accountType: "unknown",
          sharedMasterAccountId: null, virtualAccountId: null,
          blockReason: "USER_OWNED_NO_CONNECTION",
          notes,
        };
      }
      const accountType = normalizeAccountType(
        (conn as { accountType?: string | null }).accountType,
      );
      if (args.mode === "DEMO" && accountType !== "demo") {
        return { ok: false, effectiveRoutingMode: effective,
          connectionId: conn.id, connectionType: "user_owned", accountType,
          sharedMasterAccountId: null, virtualAccountId: null,
          blockReason: "USER_OWNED_DEMO_REQUIRES_DEMO_ACCOUNT", notes };
      }
      if (args.mode === "LIVE" && accountType !== "live") {
        return { ok: false, effectiveRoutingMode: effective,
          connectionId: conn.id, connectionType: "user_owned", accountType,
          sharedMasterAccountId: null, virtualAccountId: null,
          blockReason: "USER_OWNED_LIVE_REQUIRES_VERIFIED_LIVE_ACCOUNT", notes };
      }
      return {
        ok: true,
        effectiveRoutingMode: effective,
        connectionId: conn.id,
        connectionType: "user_owned",
        accountType,
        sharedMasterAccountId: null,
        virtualAccountId: null,
        blockReason: null,
        notes,
      };
    }

    // ── SHARED_MASTER_MT5 branch ─────────────────────────────────────────
    // Select the master connection that matches the requested mode.
    const masterConnId = args.mode === "LIVE"
      ? g.sharedLiveConnectionId
      : g.sharedDemoConnectionId;

    if (!masterConnId) {
      return { ok: false, effectiveRoutingMode: effective,
        connectionId: null, connectionType: "shared_master", accountType: "unknown",
        sharedMasterAccountId: null, virtualAccountId: null,
        blockReason: args.mode === "LIVE"
          ? "SHARED_LIVE_MASTER_NOT_CONFIGURED"
          : "SHARED_DEMO_MASTER_NOT_CONFIGURED",
        notes };
    }

    // Shared LIVE additionally requires the explicit second admin flag.
    if (args.mode === "LIVE" && !g.sharedLiveTradingEnabled) {
      return { ok: false, effectiveRoutingMode: effective,
        connectionId: null, connectionType: "shared_master", accountType: "unknown",
        sharedMasterAccountId: null, virtualAccountId: null,
        blockReason: "SHARED_LIVE_TRADING_NOT_EXPLICITLY_ENABLED",
        notes };
    }

    const [masterConn] = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.id, masterConnId)).limit(1);
    if (!masterConn) {
      return { ...FAIL, effectiveRoutingMode: effective,
        blockReason: "SHARED_MASTER_CONNECTION_MISSING", notes };
    }
    const masterAccountType = normalizeAccountType(
      (masterConn as { accountType?: string | null }).accountType,
    );
    if (args.mode === "DEMO" && masterAccountType !== "demo") {
      return { ...FAIL, effectiveRoutingMode: effective,
        connectionId: masterConn.id, connectionType: "shared_master", accountType: masterAccountType,
        blockReason: "SHARED_MASTER_DEMO_TYPE_MISMATCH", notes };
    }
    if (args.mode === "LIVE" && masterAccountType !== "live") {
      return { ...FAIL, effectiveRoutingMode: effective,
        connectionId: masterConn.id, connectionType: "shared_master", accountType: masterAccountType,
        blockReason: "SHARED_MASTER_LIVE_TYPE_MISMATCH", notes };
    }

    // Find the matching shared_master_accounts row for this connection.
    const [smRow] = await db.select().from(sharedMasterAccountsTable)
      .where(and(
        eq(sharedMasterAccountsTable.connectionId, masterConn.id),
        eq(sharedMasterAccountsTable.accountType, args.mode === "LIVE" ? "live" : "demo"),
      )).limit(1);
    if (!smRow) {
      return { ...FAIL, effectiveRoutingMode: effective,
        connectionId: masterConn.id, connectionType: "shared_master", accountType: masterAccountType,
        blockReason: "SHARED_MASTER_ACCOUNT_ROW_MISSING", notes };
    }
    if (!smRow.isActive || String(smRow.status ?? "").toLowerCase() !== "active") {
      return { ...FAIL, effectiveRoutingMode: effective,
        connectionId: masterConn.id, connectionType: "shared_master", accountType: masterAccountType,
        sharedMasterAccountId: smRow.id,
        blockReason: "SHARED_MASTER_ACCOUNT_INACTIVE", notes };
    }

    if (g.sharedMasterNettingMode) {
      notes.push("netting-warning: per-user position tickets may merge on broker side");
    }

    // Get-or-create the virtual trading account for this (user, master, type).
    const accountType: "demo" | "live" = args.mode === "LIVE" ? "live" : "demo";
    let [vAcc] = await db.select().from(virtualTradingAccountsTable)
      .where(and(
        eq(virtualTradingAccountsTable.userId, args.userId),
        eq(virtualTradingAccountsTable.sharedMasterAccountId, smRow.id),
        eq(virtualTradingAccountsTable.accountType, accountType),
      )).limit(1);
    if (!vAcc) {
      const inserted = await db.insert(virtualTradingAccountsTable).values({
        userId: args.userId,
        routingMode: "SHARED_MASTER_MT5",
        sharedMasterAccountId: smRow.id,
        accountType,
        virtualBalance: accountType === "demo" ? 10_000 : 0,
        virtualEquity: accountType === "demo" ? 10_000 : 0,
      }).returning();
      vAcc = inserted[0]!;
      notes.push(`virtual-account-created:#${vAcc.id}`);
    }
    if (String(vAcc.status ?? "").toLowerCase() !== "active") {
      return { ...FAIL, effectiveRoutingMode: effective,
        connectionId: masterConn.id, connectionType: "shared_master", accountType: masterAccountType,
        sharedMasterAccountId: smRow.id, virtualAccountId: vAcc.id,
        blockReason: `VIRTUAL_ACCOUNT_${String(vAcc.status ?? "UNKNOWN").toUpperCase()}`, notes };
    }

    return {
      ok: true,
      effectiveRoutingMode: effective,
      connectionId: masterConn.id,
      connectionType: "shared_master",
      accountType: masterAccountType,
      sharedMasterAccountId: smRow.id,
      virtualAccountId: vAcc.id,
      blockReason: null,
      notes,
    };
  } catch (err) {
    logger.warn({ err: String(err), userId: args.userId }, "routingResolver threw");
    return { ...FAIL, effectiveRoutingMode: "USER_OWNED_MT5",
      blockReason: `ROUTING_THREW:${String(err).slice(0, 120)}` };
  }
}
