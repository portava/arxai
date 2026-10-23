// Phase 3 — Broker Placement Layer.
//
// SAFETY (CONSTITUTION CHANGE — owner-approved May 2026):
// This is the SINGLE path that may queue a real broker command. It is
// callable ONLY from placeOrder() in ./placeOrder.ts, which itself is
// callable only after runOrderGuards() returns APPROVED. There is no other
// caller. The MQL5 EA at attached_assets/ARX_AI_Bridge.mq5 is the only
// thing that consumes these queued commands, and it re-validates every
// gate on its side before calling OrderSend/trade.Buy/trade.Sell.
//
// Idempotency: every command carries a deterministic idempotencyKey derived
// from (userId, symbol, side, lotSize, mode, minute-bucket). Inserting a
// duplicate within the same minute bucket is rejected.
//
// Expiry: commands expire after 30s. EA refuses to execute expired ones.
//
// Audit: every placement attempt updates the corresponding row in
// trade_command_audit_log with the queued command id.

import { db } from "@workspace/db";
import {
  mt5CommandsTable, mt5ConnectionTable, tradeCommandAuditLogTable,
  sharedTradeAttributionTable,
} from "@workspace/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { RoutingDecision } from "./routingResolver.js";
import { logger } from "../logger.js";

export type PlacementMode = "SIMULATED" | "DEMO" | "LIVE";

export interface BrokerPlacementArgs {
  userId: number;
  mode: PlacementMode;
  symbol: string;
  side: "BUY" | "SELL";
  lotSize: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  auditLogId: number;            // row in trade_command_audit_log (status='APPROVED')
  requestedBy: "user" | "ai-assistant" | "system";
  ttlSeconds?: number;
  // Phase 3.5 — pre-resolved routing decision from the guard chain.
  // When provided, we honor it; otherwise we fall back to the user's own
  // MT5 connection (legacy USER_OWNED_MT5 behavior).
  routing?: RoutingDecision;
}

export interface BrokerPlacementResult {
  ok: boolean;
  mode: PlacementMode;
  commandId: number | null;
  status: "QUEUED" | "SIMULATED_FILL" | "DUPLICATE_BLOCKED" | "NO_CONNECTION" | "ERROR";
  idempotencyKey: string;
  expiresAt: string | null;
  detail?: string;
}

// Phase 3 sentinel — broker placement layer is now LIVE in code. The
// per-user envelope and runtime singleton (`global_trading_settings`)
// still govern whether it is actually exercised. Default platform mode
// is OFF; the singleton stays fail-closed unless an admin explicitly acts.
export const BROKER_PLACEMENT_LAYER_ENABLED = true as const;

function buildIdempotencyKey(args: BrokerPlacementArgs): string {
  const bucket = Math.floor(Date.now() / 60_000); // 1-minute window
  const raw = `${args.userId}|${args.mode}|${args.symbol}|${args.side}|${args.lotSize}|${bucket}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export async function dispatchToBroker(args: BrokerPlacementArgs): Promise<BrokerPlacementResult> {
  const idempotencyKey = buildIdempotencyKey(args);
  const ttl = Math.max(5, Math.min(args.ttlSeconds ?? 30, 120));
  const expiresAt = new Date(Date.now() + ttl * 1000);

  // ── SIMULATED mode — never touches MT5, fills instantly internally. ────
  if (args.mode === "SIMULATED") {
    return {
      ok: true,
      mode: "SIMULATED",
      commandId: null,
      status: "SIMULATED_FILL",
      idempotencyKey,
      expiresAt: null,
      detail: "Simulator fill — no broker routing.",
    };
  }

  // ── DEMO / LIVE — write to mt5_commands queue for the EA to pick up. ───
  // Resolve the target connection: prefer the routing decision from the
  // guard chain (which already validated user-owned vs shared-master), and
  // only fall back to the user's own connection if no routing was supplied
  // (legacy callers). This is the SOLE place that picks the queued
  // mt5_connection_id, so attribution is consistent.
  let conn: typeof mt5ConnectionTable.$inferSelect | undefined;
  if (args.routing?.connectionId) {
    const r = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.id, args.routing.connectionId)).limit(1);
    conn = r[0];
  } else {
    const r = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, args.userId)).limit(1);
    conn = r[0];
  }
  if (!conn) {
    return { ok: false, mode: args.mode, commandId: null, status: "NO_CONNECTION", idempotencyKey, expiresAt: null,
      detail: "No MT5 connection on file." };
  }

  // Duplicate detection: any non-failed/expired command for this user with
  // the same idempotencyKey in the last 2 minutes is a duplicate.
  const sinceWindow = new Date(Date.now() - 2 * 60 * 1000);
  const dupes = await db.select({ id: mt5CommandsTable.id }).from(mt5CommandsTable)
    .where(and(
      eq(mt5CommandsTable.userId, args.userId),
      gte(mt5CommandsTable.createdAt, sinceWindow),
      sql`(${mt5CommandsTable.payload}->>'idempotencyKey') = ${idempotencyKey}`,
    )).limit(1);
  if (dupes.length > 0) {
    return { ok: false, mode: args.mode, commandId: null, status: "DUPLICATE_BLOCKED", idempotencyKey, expiresAt: null,
      detail: "Identical order queued within the last minute." };
  }

  try {
    const inserted = await db.insert(mt5CommandsTable).values({
      userId: args.userId,
      mt5ConnectionId: conn.id,
      requestedByUserId: args.userId,
      action: "OPEN",
      symbol: args.symbol,
      side: args.side,
      lot: args.lotSize,
      sl: args.stopLoss ?? null,
      tp: args.takeProfit ?? null,
      status: "PENDING",
      expiresAt,
      // safetyMode stays at 'paper_only' default for the column; the actual
      // mode the EA must execute against lives in payload.mode so it is
      // explicit and validated EA-side.
      payload: {
        idempotencyKey,
        mode: args.mode,
        auditLogId: args.auditLogId,
        requestedBy: args.requestedBy,
        ttlSeconds: ttl,
        // The EA reads requiredAccountType and refuses if its login does
        // not match.
        requiredAccountType: args.mode === "LIVE" ? "live" : "demo",
        // Phase 3.5 routing attribution — surfaced so the EA + result
        // handler can write back tickets to the correct shared
        // attribution row when in SHARED_MASTER_MT5 mode.
        routingMode: args.routing?.effectiveRoutingMode ?? "USER_OWNED_MT5",
        connectionType: args.routing?.connectionType ?? "user_owned",
        virtualAccountId: args.routing?.virtualAccountId ?? null,
        sharedMasterAccountId: args.routing?.sharedMasterAccountId ?? null,
        // The original requesting user (NOT the master connection's
        // owning admin). This is the only safe link back for attribution
        // in shared mode; the broker only sees the master credentials.
        originatingUserId: args.userId,
      },
    }).returning({ id: mt5CommandsTable.id });

    // Link the queued command back to the audit row.
    const commandId = inserted[0]?.id ?? null;
    if (commandId) {
      await db.update(tradeCommandAuditLogTable)
        .set({
          guardSnapshot: sql`coalesce(${tradeCommandAuditLogTable.guardSnapshot}, '{}'::jsonb)
            || ${JSON.stringify({ brokerCommandId: commandId, idempotencyKey, expiresAt: expiresAt.toISOString() })}::jsonb`,
        })
        .where(eq(tradeCommandAuditLogTable.id, args.auditLogId));

      // Phase 3.5 — write a shared_trade_attribution row when this command
      // was routed through a shared master account. EA will fill in
      // mt5OrderTicket / mt5PositionTicket / closedAt / pnl later via
      // /api/mt5/command-result.
      if (
        args.routing?.connectionType === "shared_master" &&
        args.routing.sharedMasterAccountId &&
        args.routing.virtualAccountId
      ) {
        try {
          await db.insert(sharedTradeAttributionTable).values({
            userId: args.userId,
            virtualAccountId: args.routing.virtualAccountId,
            sharedMasterAccountId: args.routing.sharedMasterAccountId,
            masterConnectionId: conn.id,
            tradeCommandId: commandId,
            auditLogId: args.auditLogId,
            symbol: args.symbol,
            side: args.side,
            lotSize: args.lotSize,
            stopLoss: args.stopLoss ?? null,
            takeProfit: args.takeProfit ?? null,
            status: "pending",
          });
        } catch (err) {
          logger.warn({ err: String(err), commandId },
            "shared_trade_attribution insert failed; command remains queued");
        }
      }
    }

    return {
      ok: true,
      mode: args.mode,
      commandId,
      status: "QUEUED",
      idempotencyKey,
      expiresAt: expiresAt.toISOString(),
      detail: `Queued for EA pickup; expires ${expiresAt.toISOString()}.`,
    };
  } catch (err) {
    logger.warn({ err: String(err), userId: args.userId, mode: args.mode }, "brokerPlacement insert failed");
    return { ok: false, mode: args.mode, commandId: null, status: "ERROR", idempotencyKey, expiresAt: null,
      detail: "Failed to queue broker command." };
  }
}
