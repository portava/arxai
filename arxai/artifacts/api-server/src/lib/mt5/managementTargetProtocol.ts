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
