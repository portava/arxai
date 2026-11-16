import { sql } from "drizzle-orm";
import { arxLiveCommandsTable as commands, mt5CommandsTable as mailbox } from "@workspace/db";

export const MANAGEMENT_TARGET_HEADER = "x-arx-management-target";
export function supportsManagementTarget(caps: unknown): boolean {
  return !!caps && typeof caps === "object" && !Array.isArray(caps) &&
    (caps as Record<string, unknown>).supportsManagementTargetV1 === true;
}
export function managementTargetPollSupported(caps: unknown, header: unknown): boolean {
  // A stored heartbeat alone cannot distinguish a downgraded/concurrent old EA.
  return supportsManagementTarget(caps) && header === "1";
}

// Mirrors isAgentManagementCommand conservatively (including null JSON keys).
// Apply during both SELECT and CAS so withheld automation cannot starve a
// later manual protective command or become DELIVERED without being returned.
export function boundManagementSql() {
  return sql`(${commands.commandType} IN ('CLOSE_LIVE_POSITION','MODIFY_LIVE_SLTP') AND (
    ${commands.source} = 'INSTANT_SELF_TRADE_MANAGEMENT' OR
    ${commands.sourcePage} IN ('INSTANT_SELF_TRADE_MANAGEMENT','INSTANT_MODIFY_SELF_TRADE') OR
    ${commands.actorType} = 'SELF_TRADE_AGENT' OR ${commands.selfTradeAgentId} IS NOT NULL OR
    ${commands.selfTradeDecisionId} IS NOT NULL OR
    COALESCE(${commands.payload} ?| ARRAY['managementTargetV1','agentOwnership','selfTradeSymbolBinding'],false)))`;
}
export function liveManagementPickupPredicate(supported: boolean) {
  return sql`(NOT COALESCE(${boundManagementSql()},false) OR
    (${supported} AND jsonb_typeof(${commands.payload}->'managementTargetV1') = 'object'))`;
}
export function legacyManagementPickupPredicate(supported: boolean) {
  return sql`(NOT (COALESCE(${mailbox.payload} ?| ARRAY['managementTargetV1','agentOwnership','selfTradeSymbolBinding'],false)
    OR EXISTS (SELECT 1 FROM ${commands} WHERE ${commands.commandId} = ${mailbox.payload}->>'liveCommandId'
      AND ${boundManagementSql()})) OR
    (${supported} AND jsonb_typeof(${mailbox.payload}->'managementTargetV1') = 'object'))`;
}

/**
 * Legacy Replit bridge EAs (v1.2x/v1.3x, e.g. v1.31) poll /mt5/commands only to
 * ACKNOWLEDGE (EA_READ_ONLY_MODE_ACTIVE / EA_EXECUTION_NOT_IMPLEMENTED) and
 * execute live commands through /mt5/live-commands-poll instead. If their
 * mailbox poll claimed a live mirror, the claim would stamp pickedByEaAt and
 * live-commands-poll would never serve the command. Unknown versions keep the
 * mailbox behaviour (fail toward today's delivery).
 */
export function isAckOnlyMailboxEa(eaVersion: string | null | undefined): boolean {
  const m = /^\s*v?(\d+)\.(\d+)/i.exec(eaVersion ?? "");
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  return major === 1 && minor < 40;
}
/** Mailbox SELECT/CAS predicate: withhold Phase B live mirrors from an
 *  acknowledgement-only legacy EA. */
export function liveMirrorMailboxPickupPredicate(eaVersion: string | null | undefined) {
  return isAckOnlyMailboxEa(eaVersion)
    ? sql`COALESCE(${mailbox.payload}->>'bridged','') <> 'LIVE_PHASE_B'`
    : sql`TRUE`;
}
