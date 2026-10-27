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
  if (payload?.bridged === "LIVE_PHASE_B" && payload.liveCommandType === "PLACE_LIVE_MARKET_ORDER") return projectBridgedEntryMailbox(row, command);
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

/**
 * A bridged market entry's mirror carries float4 lot/SL/TP: 0.02 is stored as
 * 0.0199999995529651641845703125. Terminal result evidence compares actual
 * broker volume with the authoritative float8 request, so the wire must carry
 * that exact value. Only an intact signed authoritative entry, still in the
 * dispatched state, for the same trader, bridge connection, side and mirrored
 * float4 volume may supply it; anything else is held pending, never delivered
 * with the rounded mirror. The bridge owner is already scoped by the poll.
 */
export function projectBridgedEntryMailbox(row: Mailbox, command?: ArxLiveCommand): Mailbox | null {
  const payload = row.payload as Record<string, unknown> | null;
  if (!command || !payload || command.commandType !== "PLACE_LIVE_MARKET_ORDER" || command.status !== "SENT_TO_MT5_LIVE" ||
      !hasIntactCommandSignature(command) || row.action !== "OPEN_MARKET" ||
      payload.liveCommandId !== command.commandId || payload.liveCommandOwnerUserId !== command.userId ||
      payload.liveCommandType !== command.commandType || row.requestedByUserId !== command.userId ||
      command.bridgeConnectionId !== row.mt5ConnectionId || row.side !== command.side) return null;
  const volume = command.requestedVolume;
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume <= 0 ||
      typeof row.lot !== "number" || Math.fround(row.lot) !== Math.fround(volume)) return null;
  return { ...row, lot: volume, sl: command.stopLoss ?? null, tp: command.takeProfit ?? null };
}
