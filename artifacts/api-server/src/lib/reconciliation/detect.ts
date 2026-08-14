// Reconciliation Center — pure detectors for 10 issue categories.
//
// READ-ONLY. Every detector is wrapped so a missing column or empty table
// returns [] (never throws). Issue IDs are deterministic SHA-256(type|naturalKey)
// so admin actions can target them without persisting issues to a new table.

import { createHash } from "node:crypto";
import { pool } from "@workspace/db";

export type IssueSeverity = "critical" | "high" | "medium" | "low";

export interface ReconciliationIssue {
  id: string;
  type: ReconciliationIssueType;
  severity: IssueSeverity;
  userId: number | null;
  bridgeConnectionId: number | null;
  commandId: string | null;
  brokerTicket: string | null;
  symbol: string | null;
  status: string;
  reason: string;
  recommendedAction: string;
  createdAt: string | null;
  updatedAt: string | null;
  metadata: Record<string, unknown>;
}

export type ReconciliationIssueType =
  | "BRIDGE_MISMATCH"
  | "ORPHAN_BROKER_POSITION"
  | "MISSING_ATTRIBUTION"
  | "COMMAND_RESULT_MISMATCH"
  | "USER_ALLOCATION_MISMATCH"
  | "STALE_HEARTBEAT"
  | "BLOCKED_REJECTED_COMMAND"
  | "MASTER_BRIDGE_EXPOSURE_WARNING"
  | "LIVE_DEMO_MODE_MISMATCH"
  | "USER_APPROVAL_RISK_LOCK_CONFLICT";

export const RECONCILIATION_ISSUE_TYPES: readonly ReconciliationIssueType[] = [
  "BRIDGE_MISMATCH",
  "ORPHAN_BROKER_POSITION",
  "MISSING_ATTRIBUTION",
  "COMMAND_RESULT_MISMATCH",
  "USER_ALLOCATION_MISMATCH",
  "STALE_HEARTBEAT",
  "BLOCKED_REJECTED_COMMAND",
  "MASTER_BRIDGE_EXPOSURE_WARNING",
  "LIVE_DEMO_MODE_MISMATCH",
  "USER_APPROVAL_RISK_LOCK_CONFLICT",
];

export function issueId(type: ReconciliationIssueType, naturalKey: string): string {
  return createHash("sha256").update(`${type}|${naturalKey}`).digest("hex").slice(0, 32);
}

async function safe<T>(label: string, fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    // Defensive: missing column / table / type → empty.
    return [];
  }
}

interface RawRow { [k: string]: unknown }

function s(v: unknown): string | null { return v == null ? null : String(v); }
function n(v: unknown): number | null { return v == null ? null : Number(v); }
function iso(v: unknown): string | null { return v instanceof Date ? v.toISOString() : (v == null ? null : String(v)); }

// 1. BRIDGE_MISMATCH — mt5_connection where reported mode/account_type disagrees.
async function detectBridgeMismatch(): Promise<ReconciliationIssue[]> {
  return safe("bridge_mismatch", async () => {
    const r = await pool.query<RawRow>(
      `SELECT id, user_id, status, mode, account_number, last_heartbeat, updated_at
         FROM mt5_connection
        WHERE status = 'ACTIVE'
          AND mode IN ('LIVE','REAL')
          AND (account_number IS NULL OR account_number = '')
        LIMIT 50`,
    );
    return r.rows.map((row) => {
      const cid = n(row.id);
      return {
        id: issueId("BRIDGE_MISMATCH", `conn:${cid}`),
        type: "BRIDGE_MISMATCH" as const,
        severity: "high" as IssueSeverity,
        userId: n(row.user_id),
        bridgeConnectionId: cid,
        commandId: null, brokerTicket: null, symbol: null,
        status: s(row.status) ?? "UNKNOWN",
        reason: "Bridge in LIVE/REAL mode without an account number.",
        recommendedAction: "Confirm broker account binding or rotate the EA bridge token.",
        createdAt: null, updatedAt: iso(row.updated_at),
        metadata: { mode: s(row.mode) },
      };
    });
  });
}

// 2. ORPHAN_BROKER_POSITION — arx_live_positions open with no matching command.
async function detectOrphanBrokerPositions(): Promise<ReconciliationIssue[]> {
  return safe("orphan_broker", async () => {
    const r = await pool.query<RawRow>(
      `SELECT p.id, p.user_id, p.bridge_connection_id, p.broker_ticket, p.symbol,
              p.source_command_id, p.opened_at,
              p.broker_absent_snapshot_count, p.first_broker_absent_at,
              p.last_broker_absent_at, p.last_reliable_snapshot_at
         FROM arx_live_positions p
        WHERE p.closed_at IS NULL
          AND p.reconcile_state IS NULL
          AND (p.source_command_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM arx_live_commands c
                               WHERE c.command_id = p.source_command_id))
        LIMIT 50`,
    );
    return r.rows.map((row) => ({
      id: issueId("ORPHAN_BROKER_POSITION", `pos:${n(row.id)}`),
      type: "ORPHAN_BROKER_POSITION" as const,
      severity: "critical" as IssueSeverity,
      userId: n(row.user_id),
      bridgeConnectionId: n(row.bridge_connection_id),
      commandId: s(row.source_command_id),
      brokerTicket: s(row.broker_ticket),
      symbol: s(row.symbol),
      status: "OPEN_AT_BROKER",
      reason: "Open broker position has no matching arx_live_commands row.",
      recommendedAction: "Link to an existing command or resolve manually after operator review.",
      createdAt: iso(row.opened_at), updatedAt: null,
      // Broker-absence evidence (read-only): lets the reconciliation center see
      // how close this orphan is to a broker-confirmed-absent reconcile. This is
      // VISIBILITY only — it never stamps closed_at (that is the guardrail runner).
      metadata: {
        brokerAbsentSnapshotCount: n(row.broker_absent_snapshot_count) ?? 0,
        firstBrokerAbsentAt: iso(row.first_broker_absent_at),
        lastBrokerAbsentAt: iso(row.last_broker_absent_at),
        lastReliableSnapshotAt: iso(row.last_reliable_snapshot_at),
      },
    }));
  });
}

// 3. MISSING_ATTRIBUTION — shared_trade_attribution open without mt5_position_ticket.
async function detectMissingAttribution(): Promise<ReconciliationIssue[]> {
  return safe("missing_attribution", async () => {
    const r = await pool.query<RawRow>(
      `SELECT id, user_id, symbol, side, lot_size, mt5_position_ticket, close_price
         FROM shared_trade_attribution
        WHERE mt5_position_ticket IS NULL
          AND close_price IS NULL
        LIMIT 50`,
    );
    return r.rows.map((row) => ({
      id: issueId("MISSING_ATTRIBUTION", `att:${n(row.id)}`),
      type: "MISSING_ATTRIBUTION" as const,
      severity: "high" as IssueSeverity,
      userId: n(row.user_id),
      bridgeConnectionId: null, commandId: null,
      brokerTicket: null,
      symbol: s(row.symbol),
      status: "ATTRIBUTION_INCOMPLETE",
      reason: "Open shared-master attribution row has no broker position ticket.",
      recommendedAction: "Link attribution to a confirmed broker ticket.",
      createdAt: null, updatedAt: null,
      metadata: { side: s(row.side), lotSize: n(row.lot_size) },
    }));
  });
}

// 4. COMMAND_RESULT_MISMATCH — live commands sent to broker without a result.
async function detectCommandResultMismatch(): Promise<ReconciliationIssue[]> {
  return safe("cmd_result_mismatch", async () => {
    const r = await pool.query<RawRow>(
      `SELECT id, command_id, user_id, bridge_connection_id, symbol, status,
              broker_ticket, sent_to_mt5_at
         FROM arx_live_commands
        WHERE status = 'SENT_TO_MT5_LIVE'
          AND broker_ticket IS NULL
          AND sent_to_mt5_at IS NOT NULL
          AND sent_to_mt5_at < NOW() - INTERVAL '5 minutes'
        LIMIT 50`,
    );
    return r.rows.map((row) => ({
      id: issueId("COMMAND_RESULT_MISMATCH", `cmd:${s(row.command_id)}`),
      type: "COMMAND_RESULT_MISMATCH" as const,
      severity: "critical" as IssueSeverity,
      userId: n(row.user_id),
      bridgeConnectionId: n(row.bridge_connection_id),
      commandId: s(row.command_id),
      brokerTicket: null,
      symbol: s(row.symbol),
      status: s(row.status) ?? "UNKNOWN",
      reason: "Command sent to MT5 >5 minutes ago without a broker result.",
      recommendedAction: "Review EA logs and reconcile or resolve manually.",
      createdAt: null, updatedAt: iso(row.sent_to_mt5_at),
      metadata: {},
    }));
  });
}

// 5. USER_ALLOCATION_MISMATCH — virtual_trading_accounts shared-master but unlinked.
async function detectUserAllocationMismatch(): Promise<ReconciliationIssue[]> {
  return safe("alloc_mismatch", async () => {
    const r = await pool.query<RawRow>(
      `SELECT id, user_id, routing_mode, shared_master_account_id, account_type, status
         FROM virtual_trading_accounts
        WHERE routing_mode = 'SHARED_MASTER'
          AND shared_master_account_id IS NULL
          AND status = 'active'
        LIMIT 50`,
    );
    return r.rows.map((row) => ({
      id: issueId("USER_ALLOCATION_MISMATCH", `vac:${n(row.id)}`),
      type: "USER_ALLOCATION_MISMATCH" as const,
      severity: "high" as IssueSeverity,
      userId: n(row.user_id),
      bridgeConnectionId: null, commandId: null, brokerTicket: null, symbol: null,
      status: s(row.status) ?? "active",
      reason: "User routed to SHARED_MASTER but no master account is linked.",
      recommendedAction: "Bind a shared master account or change routing mode.",
      createdAt: null, updatedAt: null,
      metadata: { routingMode: s(row.routing_mode), accountType: s(row.account_type) },
    }));
  });
}

// 6. STALE_HEARTBEAT — active connections without a recent heartbeat.
async function detectStaleHeartbeat(): Promise<ReconciliationIssue[]> {
  return safe("stale_heartbeat", async () => {
    const r = await pool.query<RawRow>(
      `SELECT id, user_id, status, mode, last_heartbeat, account_number
         FROM mt5_connection
        WHERE status = 'ACTIVE'
          AND (last_heartbeat IS NULL OR last_heartbeat < NOW() - INTERVAL '90 seconds')
        LIMIT 50`,
    );
    return r.rows.map((row) => ({
      id: issueId("STALE_HEARTBEAT", `conn:${n(row.id)}`),
      type: "STALE_HEARTBEAT" as const,
      severity: "medium" as IssueSeverity,
      userId: n(row.user_id),
      bridgeConnectionId: n(row.id),
      commandId: null, brokerTicket: null, symbol: null,
      status: s(row.status) ?? "ACTIVE",
      reason: "Bridge marked ACTIVE but heartbeat is stale (>90s).",
      recommendedAction: "Have user restart EA or mark bridge offline.",
      createdAt: null, updatedAt: iso(row.last_heartbeat),
      metadata: { mode: s(row.mode) },
    }));
  });
}

// 7. BLOCKED_REJECTED_COMMAND — recent BLOCKED/REJECTED across live + demo queues.
async function detectBlockedRejected(): Promise<ReconciliationIssue[]> {
  const out: ReconciliationIssue[] = [];
  const live = await safe<RawRow>("blocked_live", async () => {
    const r = await pool.query<RawRow>(
      `SELECT id, command_id, user_id, bridge_connection_id, symbol, status,
              rejected_at, created_at
         FROM arx_live_commands
        WHERE status IN ('BLOCKED','REJECTED','LIVE_BLOCKED')
          AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY id DESC
        LIMIT 25`,
    );
    return r.rows;
  });
  for (const row of live) {
    out.push({
      id: issueId("BLOCKED_REJECTED_COMMAND", `live:${s(row.command_id)}`),
      type: "BLOCKED_REJECTED_COMMAND",
      severity: "medium",
      userId: n(row.user_id),
      bridgeConnectionId: n(row.bridge_connection_id),
      commandId: s(row.command_id),
      brokerTicket: null,
      symbol: s(row.symbol),
      status: s(row.status) ?? "UNKNOWN",
      reason: "Live command was blocked or rejected and needs review.",
      recommendedAction: "Review block reason; mark reviewed or dismiss with justification.",
      createdAt: iso(row.created_at), updatedAt: iso(row.rejected_at),
      metadata: { queue: "live" },
    });
  }
  const demo = await safe<RawRow>("blocked_demo", async () => {
    const r = await pool.query<RawRow>(
      `SELECT id, command_id, user_id, bridge_connection_id, status, reason, created_at, updated_at
         FROM mt5_demo_commands
        WHERE status IN ('REJECTED','DEMO_BLOCKED')
          AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY id DESC
        LIMIT 25`,
    );
    return r.rows;
  });
  for (const row of demo) {
    out.push({
      id: issueId("BLOCKED_REJECTED_COMMAND", `demo:${s(row.command_id)}`),
      type: "BLOCKED_REJECTED_COMMAND",
      severity: "low",
      userId: n(row.user_id),
      bridgeConnectionId: n(row.bridge_connection_id),
      commandId: s(row.command_id),
      brokerTicket: null, symbol: null,
      status: s(row.status) ?? "UNKNOWN",
      reason: s(row.reason) ?? "Demo command was rejected and needs review.",
      recommendedAction: "Review reason; mark reviewed or dismiss with justification.",
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      metadata: { queue: "demo" },
    });
  }
  return out;
}

// 8. MASTER_BRIDGE_EXPOSURE_WARNING — shared_master_accounts marked active but status != active.
async function detectMasterBridgeExposure(): Promise<ReconciliationIssue[]> {
  return safe("master_exposure", async () => {
    const r = await pool.query<RawRow>(
      `SELECT id, status, is_active, broker_name, account_number_masked, account_type
         FROM shared_master_accounts
        WHERE is_active = true
          AND status != 'active'
        LIMIT 50`,
    );
    return r.rows.map((row) => ({
      id: issueId("MASTER_BRIDGE_EXPOSURE_WARNING", `sma:${n(row.id)}`),
      type: "MASTER_BRIDGE_EXPOSURE_WARNING" as const,
      severity: "high" as IssueSeverity,
      userId: null, bridgeConnectionId: null, commandId: null, brokerTicket: null, symbol: null,
      status: s(row.status) ?? "unknown",
      reason: "Master bridge flagged is_active=true but lifecycle status is not 'active'.",
      recommendedAction: "Reconcile lifecycle status with operator intent.",
      createdAt: null, updatedAt: null,
      metadata: { accountType: s(row.account_type), broker: s(row.broker_name) },
    }));
  });
}

// 9. LIVE_DEMO_MODE_MISMATCH — live command bound to a non-live bridge.
async function detectLiveDemoModeMismatch(): Promise<ReconciliationIssue[]> {
  return safe("mode_mismatch", async () => {
    const r = await pool.query<RawRow>(
      `SELECT c.id, c.command_id, c.user_id, c.bridge_connection_id, c.symbol, c.status,
              c.created_at, m.mode AS bridge_mode
         FROM arx_live_commands c
         JOIN mt5_connection m ON m.id = c.bridge_connection_id
        WHERE c.status NOT IN ('LIVE_DRAFT','REJECTED','BLOCKED','LIVE_BLOCKED')
          AND m.mode IN ('MOCK','DEMO','PAPER')
          AND c.created_at > NOW() - INTERVAL '7 days'
        LIMIT 50`,
    );
    return r.rows.map((row) => ({
      id: issueId("LIVE_DEMO_MODE_MISMATCH", `cmd:${s(row.command_id)}`),
      type: "LIVE_DEMO_MODE_MISMATCH" as const,
      severity: "critical" as IssueSeverity,
      userId: n(row.user_id),
      bridgeConnectionId: n(row.bridge_connection_id),
      commandId: s(row.command_id),
      brokerTicket: null,
      symbol: s(row.symbol),
      status: s(row.status) ?? "UNKNOWN",
      reason: "Live command was dispatched against a non-live bridge.",
      recommendedAction: "Halt user; verify bridge mode; resolve manually after audit.",
      createdAt: iso(row.created_at), updatedAt: null,
      metadata: { bridgeMode: s(row.bridge_mode) },
    }));
  });
}

// 10. USER_APPROVAL_RISK_LOCK_CONFLICT — approval+disable inconsistencies.
async function detectApprovalRiskLockConflict(): Promise<ReconciliationIssue[]> {
  return safe("approval_conflict", async () => {
    const r = await pool.query<RawRow>(
      `SELECT id, user_id, master_live_status, master_live_trading_enabled,
              master_live_disabled_at, master_live_approved_at
         FROM user_master_live_access
        WHERE (master_live_disabled_at IS NOT NULL AND master_live_trading_enabled = true)
           OR (master_live_status = 'APPROVED' AND master_live_approved_at IS NULL)
        LIMIT 50`,
    );
    return r.rows.map((row) => ({
      id: issueId("USER_APPROVAL_RISK_LOCK_CONFLICT", `umla:${n(row.id)}`),
      type: "USER_APPROVAL_RISK_LOCK_CONFLICT" as const,
      severity: "critical" as IssueSeverity,
      userId: n(row.user_id),
      bridgeConnectionId: null, commandId: null, brokerTicket: null, symbol: null,
      status: s(row.master_live_status) ?? "UNKNOWN",
      reason: "Master-live approval and disable/enable flags are inconsistent.",
      recommendedAction: "Re-run approval workflow or disable the user's master-live access.",
      createdAt: null, updatedAt: null,
      metadata: {
        tradingEnabled: !!row.master_live_trading_enabled,
        disabledAt: iso(row.master_live_disabled_at),
        approvedAt: iso(row.master_live_approved_at),
      },
    }));
  });
}

export interface ReconciliationAggregateResult {
  issues: ReconciliationIssue[];
  countsByType: Record<ReconciliationIssueType, number>;
  countsBySeverity: Record<IssueSeverity, number>;
  total: number;
  computedAt: string;
}

export async function aggregateReconciliationIssues(): Promise<ReconciliationAggregateResult> {
  const all = (await Promise.all([
    detectBridgeMismatch(),
    detectOrphanBrokerPositions(),
    detectMissingAttribution(),
    detectCommandResultMismatch(),
    detectUserAllocationMismatch(),
    detectStaleHeartbeat(),
    detectBlockedRejected(),
    detectMasterBridgeExposure(),
    detectLiveDemoModeMismatch(),
    detectApprovalRiskLockConflict(),
  ])).flat();

  const countsByType: Record<ReconciliationIssueType, number> = {
    BRIDGE_MISMATCH: 0,
    ORPHAN_BROKER_POSITION: 0,
    MISSING_ATTRIBUTION: 0,
    COMMAND_RESULT_MISMATCH: 0,
    USER_ALLOCATION_MISMATCH: 0,
    STALE_HEARTBEAT: 0,
    BLOCKED_REJECTED_COMMAND: 0,
    MASTER_BRIDGE_EXPOSURE_WARNING: 0,
    LIVE_DEMO_MODE_MISMATCH: 0,
    USER_APPROVAL_RISK_LOCK_CONFLICT: 0,
  };
  const countsBySeverity: Record<IssueSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of all) {
    countsByType[i.type] += 1;
    countsBySeverity[i.severity] += 1;
  }
  return { issues: all, countsByType, countsBySeverity, total: all.length, computedAt: new Date().toISOString() };
}
