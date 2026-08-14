// ═══════════════════════════════════════════════════════════════════════════
// Snapshot builder — collapses an ordered audit-event stream into a
// reconstructable system-state snapshot. Used to validate that the vault
// can rebuild operational state without consulting the live DB.
// ═══════════════════════════════════════════════════════════════════════════

import type { AuditEvent } from "./eventSchema.types.js";

export interface AuditSnapshot {
  asOfEventId: string | null;
  asOfTimestamp: string | null;
  totalEvents: number;
  systemMode: string | null;
  globalState: string | null;
  killSwitchEngaged: boolean;
  killSwitchReason: string | null;
  countsByType: Record<string, number>;
  countsBySeverity: Record<string, number>;
  countsBySource: Record<string, number>;
  lastApprovedTradeAt: string | null;
  lastBlockedTradeAt: string | null;
  lastUserOverrideAt: string | null;
}

export function buildSnapshot(events: ReadonlyArray<AuditEvent>): AuditSnapshot {
  const snap: AuditSnapshot = {
    asOfEventId: null,
    asOfTimestamp: null,
    totalEvents: events.length,
    systemMode: null,
    globalState: null,
    killSwitchEngaged: false,
    killSwitchReason: null,
    countsByType: {},
    countsBySeverity: {},
    countsBySource: {},
    lastApprovedTradeAt: null,
    lastBlockedTradeAt: null,
    lastUserOverrideAt: null,
  };

  for (const e of events) {
    snap.countsByType[e.eventType] = (snap.countsByType[e.eventType] ?? 0) + 1;
    snap.countsBySeverity[e.severity] = (snap.countsBySeverity[e.severity] ?? 0) + 1;
    snap.countsBySource[e.source] = (snap.countsBySource[e.source] ?? 0) + 1;
    if (e.systemMode) snap.systemMode = e.systemMode;
    if (e.globalState) snap.globalState = e.globalState;

    // Accept both event-sourced canonical names AND legacy Phase 1 kinds so
    // snapshot reflects real-world emitted categories.
    switch (e.eventType) {
      case "KILL_SWITCH":              // Phase 1 emit() name
      case "KILL_SWITCH_ENGAGED": {    // event-sourced canonical name
        snap.killSwitchEngaged = true;
        const reason = (e.payload as { reason?: string } | undefined)?.reason;
        snap.killSwitchReason = typeof reason === "string" ? reason : snap.killSwitchReason;
        break;
      }
      case "KILL_SWITCH_RESET":
        snap.killSwitchEngaged = false;
        snap.killSwitchReason = null;
        break;
      case "APPROVED_TRADE":           // Phase 2 vaultLogger name
      case "TRADE_APPROVED":
        snap.lastApprovedTradeAt = e.timestamp;
        break;
      case "BLOCKED_TRADE":            // Phase 2 vaultLogger name
      case "TRADE_BLOCKED":
        snap.lastBlockedTradeAt = e.timestamp;
        break;
      case "USER_OVERRIDE":
        snap.lastUserOverrideAt = e.timestamp;
        break;
    }
    snap.asOfEventId = e.eventId;
    snap.asOfTimestamp = e.timestamp;
  }
  return snap;
}
