import { isDeepStrictEqual } from "node:util";
import type { ArxLiveCommand, mt5CommandsTable } from "@workspace/db";
import { hasIntactCommandSignature } from "../security/commandIntegrity.js";
import { boundManagementTransportSymbol, isAgentManagementCommand, managementTargetFromCommand } from "../selfTrade/managementTarget.js";

type Mailbox = typeof mt5CommandsTable.$inferSelect;
/**
 * The legacy mirror stores SL/TP/lot as float4. For bound automation, derive
 * wire geometry from its intact authoritative float8 command instead. The
 * mirror's payload cannot assert this authority: owner, connection, signed
 * target and action must agree. No new command lock is acquired by callers.
 * null means leave the mailbox row pending; ordinary manual rows pass through.
 */
export function projectManagementMailbox(row: Mailbox, command?: ArxLiveCommand): Mailbox | null {
  const payload = row.payload as Record<string, unknown> | null;
  const attributed = !!payload && ["managementTargetV1", "agentOwnership", "selfTradeSymbolBinding"].some(key => Object.hasOwn(payload, key));
  if (!attributed && (!command || !isAgentManagementCommand(command))) return row;
  if (!command || !isAgentManagementCommand(command) || !hasIntactCommandSignature(command)) return null;
  const target = managementTargetFromCommand(command);
  const action = command.commandType === "CLOSE_LIVE_POSITION" ? "CLOSE_POSITION" : "MODIFY_POSITION";
  if (!target || command.status !== "SENT_TO_MT5_LIVE" || command.userId !== target.userId || command.userId !== row.requestedByUserId ||
      target.bridgeOwnerUserId !== row.userId ||
      command.bridgeConnectionId !== row.mt5ConnectionId || payload?.liveCommandId !== command.commandId ||
      payload.liveCommandOwnerUserId !== command.userId || payload.liveCommandType !== command.commandType ||
      payload.positionTicket !== target.brokerTicket || !isDeepStrictEqual(payload.managementTargetV1, target) ||
      row.action !== action || row.symbol !== target.symbol) return null;
  try {
    const symbol = boundManagementTransportSymbol(command);
    if (!symbol) return null;
    return { ...row, symbol, side: command.side, lot: command.requestedVolume,
      sl: command.stopLoss, tp: command.takeProfit };
  } catch { return null; }
}
