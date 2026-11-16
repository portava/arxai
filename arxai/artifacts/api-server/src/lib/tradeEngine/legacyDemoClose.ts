// Internal legacy DEMO close transport. Only the Trade Engine may call it.
// Legacy mirrored positions can predate the governed DEMO queue. Preserve their
// risk-reducing close path, but own identity, risk and atomic mailbox dedup here.
import { db, mt5CommandsTable, sharedTradeAttributionTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { demoPositionLedger, demoPositionColumns } from "../positions/ledger.js";
import { getConnection, listUserConnections } from "../brokerHub/connections.js";
import { getEnvelope } from "../adminTrading/safetyEnvelope.js";
import { platformStop, preCheckStopRefusal } from "../safety/platformSwitches.js";
import { enforcePreTradeRisk } from "../riskGovernor/enforce.js";

export async function queueLegacyDemoClose(args: { userId: number; cardId: string }): Promise<
  { ok: true; command: typeof mt5CommandsTable.$inferSelect } | { ok: false; reason: string; commandId?: number }
> {
  const { userId, cardId } = args;
  const env = await getEnvelope(userId);
  if (env.tradingMode !== "DEMO") return { ok: false, reason: "DEMO_CLOSE_MODE_REQUIRED" };
  if (preCheckStopRefusal(await platformStop(), { own: "platform_emergency_stop", opensNewRisk: false, venue: "DEMO" }).engaged) {
    return { ok: false, reason: "EMERGENCY_KILL_SWITCH_ACTIVE" };
  }
  const match = /^(lp|att)_(\d+)$/.exec(cardId);
  if (!match) return { ok: false, reason: "INVALID_CARD_ID" };
  let symbol: string, side: string, lotSize: number, ticketText: string | null;
  let connectionId: number | null, virtualAccountId: number | null = null;
  if (match[1] === "lp") {
    const [position] = await demoPositionLedger.read({ where: and(
      eq(demoPositionColumns.id, Number(match[2])), eq(demoPositionColumns.userId, userId)), limit: 1 });
    if (!position || position.status !== "OPEN") return { ok: false, reason: "POSITION_NOT_FOUND" };
    symbol = position.symbol; side = position.direction; lotSize = position.lotSize;
    ticketText = position.brokerPositionId;
    // This legacy mirror has no connection id. Never guess which account
    // owns a ticket when the trader has registered more than one connection.
    const connections = await listUserConnections(userId);
    if (connections.length > 1) return { ok: false, reason: "AMBIGUOUS_LEGACY_POSITION_ACCOUNT" };
    connectionId = connections[0]?.id ?? null;
  } else {
    const [position] = await db.select().from(sharedTradeAttributionTable).where(and(
      eq(sharedTradeAttributionTable.id, Number(match[2])), eq(sharedTradeAttributionTable.userId, userId))).limit(1);
    if (!position || position.status !== "open") return { ok: false, reason: "ATTRIBUTION_NOT_FOUND" };
    symbol = position.symbol; side = position.side; lotSize = position.lotSize;
    ticketText = position.mt5PositionTicket; connectionId = position.masterConnectionId;
    virtualAccountId = position.virtualAccountId;
  }
  const ticket = Number(ticketText);
  if (!ticketText || !Number.isSafeInteger(ticket) || ticket <= 0) return { ok: false, reason: "POSITION_MISSING_BROKER_TICKET" };
  if (connectionId == null) return { ok: false, reason: "NO_USER_BROKER_CONNECTION" };
  const connection = await getConnection(connectionId);
  if (!connection || connection.accountType?.toLowerCase() !== "demo") return { ok: false, reason: "DEMO_ACCOUNT_REQUIRED" };
  const risk = await enforcePreTradeRisk({
    userId, venue: "DEMO", origin: "manual", action: "CLOSE",
    symbol, side: side === "BUY" || side === "SELL" ? side : null, lots: lotSize,
    intentRef: `me_trades_close:${cardId}`,
  }, { connectionId, virtualAccountId, auditContext: { caller: "tradeEngine.legacyDemoClose", cardId } });
  if (!risk.allowed) return { ok: false, reason: `RISK_GOVERNOR_BLOCK:${risk.blockedBy.join(",")}` };

  return db.transaction(async tx => {
    // Same owner/connection/ticket requests serialize across server processes.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`demo-close:${userId}:${connectionId}:${ticket}`}, 0))`);
    const [prior] = await tx.select().from(mt5CommandsTable).where(and(
      eq(mt5CommandsTable.userId, userId), eq(mt5CommandsTable.mt5ConnectionId, connectionId),
      eq(mt5CommandsTable.ticket, ticket), eq(mt5CommandsTable.action, "CLOSE"), eq(mt5CommandsTable.status, "PENDING"),
    )).limit(1);
    if (prior) return { ok: false as const, reason: "CLOSE_ALREADY_QUEUED", commandId: prior.id };
    const [command] = await tx.insert(mt5CommandsTable).values({
      userId, mt5ConnectionId: connectionId, requestedByUserId: userId,
      action: "CLOSE", symbol, side, lot: lotSize, ticket, status: "PENDING", safetyMode: "paper_only",
      payload: { source: match[1] === "lp" ? "user_owned_mt5" : "shared_master_attribution", cardId },
    }).returning();
    return { ok: true as const, command: command! };
  });
}
