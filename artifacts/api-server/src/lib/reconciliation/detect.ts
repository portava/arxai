// Reconciliation Center — pure detectors for 10 issue categories.
//
// READ-ONLY. Every detector is wrapped so a missing column, missing table or
// DB error never throws out of the aggregate (the pages that show it still
// render), but the failure is RECORDED: a check that could not run makes its
// issue type "unchecked" for that run, never "0 issues". Issue IDs are
// deterministic SHA-256(type|naturalKey) so admin actions can target them
// without persisting issues to a new table.

import { classifyHeartbeatAt, heartbeatIsOnline } from "../brokerHub/freshness.js";
import { readOrphanLivePositions } from "../positions/ledger.js";
import { listConnections } from "../brokerHub/connections.js";
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

/** A detector that threw: its issue type is unknown for that run, not zero. */
export interface ReconciliationCheckFailure {
  /** Detector label, e.g. "orphan_broker". */
  check: string;
  type: ReconciliationIssueType;
  /** Severity the detector would have reported its issues at. */
  severity: IssueSeverity;
  /** The error message, cut to 200 characters. */
  error: string;
}

/** A detector whose list hit its cap: its count is "at least", not the total. */
export interface ReconciliationCheckTruncation {
  check: string;
  type: ReconciliationIssueType;
  severity: IssueSeverity;
  /** Rows kept; more matched. */
  limit: number;
}

/** Rows each detector lists (per queue for blocked/rejected commands). */
const LIST_CAP = 50;
const BLOCKED_QUEUE_CAP = 25;

/** Per-aggregate record of what did not run and which lists were cut. */
interface DetectorRun {
  failures: ReconciliationCheckFailure[];
  truncations: ReconciliationCheckTruncation[];
}

/**
 * Keeps at most `limit` rows. Queries ask for limit + 1 rows so a longer
 * input proves more matched: that list is recorded as truncated.
 */
type Cap = <R>(rows: R[], limit: number) => R[];

async function safe<T>(
  run: DetectorRun,
  check: string,
  type: ReconciliationIssueType,
  severity: IssueSeverity,
  fn: (cap: Cap) => Promise<T[]>,
): Promise<T[]> {
  const cap: Cap = (rows, limit) => {
    if (rows.length > limit) run.truncations.push({ check, type, severity, limit });
    return rows.slice(0, limit);
  };
  try {
    return await fn(cap);
  } catch (e) {
    // Never throws (missing column / table / DB down), but the failure is
    // recorded so the result says this check did not run instead of "none".
    const message = e instanceof Error ? e.message : String(e);
    run.failures.push({ check, type, severity, error: message.slice(0, 200) });
    return [];
  }
}

interface RawRow { [k: string]: unknown }

function s(v: unknown): string | null { return v == null ? null : String(v); }
function n(v: unknown): number | null { return v == null ? null : Number(v); }
function iso(v: unknown): string | null { return v instanceof Date ? v.toISOString() : (v == null ? null : String(v)); }

// 1. BRIDGE_MISMATCH — mt5_connection where reported mode/account_type disagrees.
async function detectBridgeMismatch(run: DetectorRun): Promise<ReconciliationIssue[]> {
  return safe(run, "bridge_mismatch", "BRIDGE_MISMATCH", "high", async (cap) => {
    const rows = cap((await listConnections({ statuses: ["ACTIVE"], modes: ["LIVE", "REAL"], order: "oldest" }))
      .filter((c) => !c.accountNumber), LIST_CAP);
    return rows.map((c) => ({
      id: issueId("BRIDGE_MISMATCH", `conn:${c.id}`),
      type: "BRIDGE_MISMATCH" as const,
      severity: "high" as IssueSeverity,
      userId: c.userId,
      bridgeConnectionId: c.id,
      commandId: null, brokerTicket: null, symbol: null,
      status: c.status ?? "UNKNOWN",
      reason: "Bridge in LIVE/REAL mode without an account number.",
      recommendedAction: "Confirm broker account binding or rotate the EA bridge token.",
      createdAt: null, updatedAt: iso(c.updatedAt),
      metadata: { mode: c.mode },
    }));
  });
}

// 2. ORPHAN_BROKER_POSITION — arx_live_positions open with no matching command.
async function detectOrphanBrokerPositions(run: DetectorRun): Promise<ReconciliationIssue[]> {
  return safe(run, "orphan_broker", "ORPHAN_BROKER_POSITION", "critical", async (cap) => {
    const r = await readOrphanLivePositions(LIST_CAP + 1);
    return cap(r.rows, LIST_CAP).map((row) => ({
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
async function detectMissingAttribution(run: DetectorRun): Promise<ReconciliationIssue[]> {
  return safe(run, "missing_attribution", "MISSING_ATTRIBUTION", "high", async (cap) => {
    const r = await pool.query<RawRow>(
      `SELECT id, user_id, symbol, side, lot_size, mt5_position_ticket, close_price
         FROM shared_trade_attribution
        WHERE mt5_position_ticket IS NULL
          AND close_price IS NULL
        LIMIT ${LIST_CAP + 1}`,
    );
    return cap(r.rows, LIST_CAP).map((row) => ({
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
async function detectCommandResultMismatch(run: DetectorRun): Promise<ReconciliationIssue[]> {
  return safe(run, "cmd_result_mismatch", "COMMAND_RESULT_MISMATCH", "critical", async (cap) => {
    const r = await pool.query<RawRow>(
      `SELECT id, command_id, user_id, bridge_connection_id, symbol, status,
              broker_ticket, sent_to_mt5_at
         FROM arx_live_commands
        WHERE status = 'SENT_TO_MT5_LIVE'
          AND broker_ticket IS NULL
          AND sent_to_mt5_at IS NOT NULL
          AND sent_to_mt5_at < NOW() - INTERVAL '5 minutes'
        LIMIT ${LIST_CAP + 1}`,
    );
    return cap(r.rows, LIST_CAP).map((row) => ({
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
async function detectUserAllocationMismatch(run: DetectorRun): Promise<ReconciliationIssue[]> {
  return safe(run, "alloc_mismatch", "USER_ALLOCATION_MISMATCH", "high", async (cap) => {
    const r = await pool.query<RawRow>(
      `SELECT id, user_id, routing_mode, shared_master_account_id, account_type, status
         FROM virtual_trading_accounts
        WHERE routing_mode = 'SHARED_MASTER'
          AND shared_master_account_id IS NULL
          AND status = 'active'
        LIMIT ${LIST_CAP + 1}`,
    );
    return cap(r.rows, LIST_CAP).map((row) => ({
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
async function detectStaleHeartbeat(run: DetectorRun): Promise<ReconciliationIssue[]> {
  return safe(run, "stale_heartbeat", "STALE_HEARTBEAT", "medium", async (cap) => {
    // Shared heartbeat policy: stale = not online (offline >= 60 s, missing
    // or future-dated). Was a 90 s cutoff.
    const nowMs = Date.now();
    const rows = cap((await listConnections({ statuses: ["ACTIVE"], order: "oldest" }))
      .filter((c) => !heartbeatIsOnline(classifyHeartbeatAt(c.lastHeartbeat, nowMs))), LIST_CAP);
    return rows.map((c) => ({
      id: issueId("STALE_HEARTBEAT", `conn:${c.id}`),
      type: "STALE_HEARTBEAT" as const,
      severity: "medium" as IssueSeverity,
      userId: c.userId,
      bridgeConnectionId: c.id,
      commandId: null, brokerTicket: null, symbol: null,
      status: c.status ?? "ACTIVE",
      reason: "Bridge marked ACTIVE but heartbeat is stale (>=60s or missing).",
      recommendedAction: "Have user restart EA or mark bridge offline.",
      createdAt: null, updatedAt: iso(c.lastHeartbeat),
      metadata: { mode: c.mode },
    }));
  });
}

// 7. BLOCKED_REJECTED_COMMAND — recent BLOCKED/REJECTED across live + demo queues.
async function detectBlockedRejected(run: DetectorRun): Promise<ReconciliationIssue[]> {
  const out: ReconciliationIssue[] = [];
  const live = await safe<RawRow>(run, "blocked_live", "BLOCKED_REJECTED_COMMAND", "medium", async (cap) => {
    const r = await pool.query<RawRow>(
      `SELECT id, command_id, user_id, bridge_connection_id, symbol, status,
              rejected_at, created_at
         FROM arx_live_commands
        WHERE status IN ('BLOCKED','REJECTED','LIVE_BLOCKED')
          AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY id DESC
        LIMIT ${BLOCKED_QUEUE_CAP + 1}`,
    );
    return cap(r.rows, BLOCKED_QUEUE_CAP);
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
  const demo = await safe<RawRow>(run, "blocked_demo", "BLOCKED_REJECTED_COMMAND", "low", async (cap) => {
    const r = await pool.query<RawRow>(
      `SELECT id, command_id, user_id, bridge_connection_id, status, reason, created_at, updated_at
         FROM mt5_demo_commands
        WHERE status IN ('REJECTED','DEMO_BLOCKED')
          AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY id DESC
        LIMIT ${BLOCKED_QUEUE_CAP + 1}`,
    );
    return cap(r.rows, BLOCKED_QUEUE_CAP);
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
async function detectMasterBridgeExposure(run: DetectorRun): Promise<ReconciliationIssue[]> {
  return safe(run, "master_exposure", "MASTER_BRIDGE_EXPOSURE_WARNING", "high", async (cap) => {
    const r = await pool.query<RawRow>(
      `SELECT id, status, is_active, broker_name, account_number_masked, account_type
         FROM shared_master_accounts
        WHERE is_active = true
          AND status != 'active'
        LIMIT ${LIST_CAP + 1}`,
    );
    return cap(r.rows, LIST_CAP).map((row) => ({
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
async function detectLiveDemoModeMismatch(run: DetectorRun): Promise<ReconciliationIssue[]> {
  return safe(run, "mode_mismatch", "LIVE_DEMO_MODE_MISMATCH", "critical", async (cap) => {
    const r = await pool.query<RawRow>(
      `SELECT c.id, c.command_id, c.user_id, c.bridge_connection_id, c.symbol, c.status, c.created_at
         FROM arx_live_commands c
        WHERE c.bridge_connection_id IS NOT NULL
          AND c.status NOT IN ('LIVE_DRAFT','REJECTED','BLOCKED','LIVE_BLOCKED')
          AND c.created_at > NOW() - INTERVAL '7 days'`,
    );
    const ids = [...new Set(r.rows.map((row) => n(row.bridge_connection_id)).filter((x): x is number => x != null))];
    const nonLive = new Map((await listConnections({ connectionIds: ids, modes: ["MOCK", "DEMO", "PAPER"] })).map((c) => [c.id, c.mode]));
    const flagged = cap(r.rows
      .filter((row) => nonLive.has(n(row.bridge_connection_id)!))
      .map((row): RawRow => ({ ...row, bridge_mode: nonLive.get(n(row.bridge_connection_id)!) })), LIST_CAP);
    return flagged.map((row) => ({
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
async function detectApprovalRiskLockConflict(run: DetectorRun): Promise<ReconciliationIssue[]> {
  return safe(run, "approval_conflict", "USER_APPROVAL_RISK_LOCK_CONFLICT", "critical", async (cap) => {
    const r = await pool.query<RawRow>(
      `SELECT id, user_id, master_live_status, master_live_trading_enabled,
              master_live_disabled_at, master_live_approved_at
         FROM user_master_live_access
        WHERE (master_live_disabled_at IS NOT NULL AND master_live_trading_enabled = true)
           OR (master_live_status = 'APPROVED' AND master_live_approved_at IS NULL)
        LIMIT ${LIST_CAP + 1}`,
    );
    return cap(r.rows, LIST_CAP).map((row) => ({
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
  /**
   * True only when every detector ran. When false, the counts cover only the
   * checks that ran: an unchecked type is unknown, never "0 issues".
   */
  complete: boolean;
  /** Detectors that threw this run, with the error. */
  failedChecks: ReconciliationCheckFailure[];
  /** Issue types with at least one detector that could not run. */
  uncheckedTypes: ReconciliationIssueType[];
  /**
   * True when any detector's list hit its cap: the counts for the types and
   * severities below are "at least", and the true numbers are higher.
   */
  truncated: boolean;
  truncatedChecks: ReconciliationCheckTruncation[];
  truncatedTypes: ReconciliationIssueType[];
  /** Severities whose count is a lower bound because a list was cut. */
  truncatedSeverities: IssueSeverity[];
}

export async function aggregateReconciliationIssues(): Promise<ReconciliationAggregateResult> {
  const run: DetectorRun = { failures: [], truncations: [] };
  const all = (await Promise.all([
    detectBridgeMismatch(run),
    detectOrphanBrokerPositions(run),
    detectMissingAttribution(run),
    detectCommandResultMismatch(run),
    detectUserAllocationMismatch(run),
    detectStaleHeartbeat(run),
    detectBlockedRejected(run),
    detectMasterBridgeExposure(run),
    detectLiveDemoModeMismatch(run),
    detectApprovalRiskLockConflict(run),
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
  const uncheckedTypes = RECONCILIATION_ISSUE_TYPES.filter((t) => run.failures.some((f) => f.type === t));
  return {
    issues: all, countsByType, countsBySeverity, total: all.length, computedAt: new Date().toISOString(),
    complete: run.failures.length === 0,
    failedChecks: run.failures,
    uncheckedTypes,
    truncated: run.truncations.length > 0,
    truncatedChecks: run.truncations,
    truncatedTypes: RECONCILIATION_ISSUE_TYPES.filter((t) => run.truncations.some((x) => x.type === t)),
    truncatedSeverities: (["critical", "high", "medium", "low"] as const).filter((sv) => run.truncations.some((x) => x.severity === sv)),
  };
}
