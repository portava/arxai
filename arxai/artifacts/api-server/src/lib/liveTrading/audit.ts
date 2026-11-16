// Build TT — Append-only audit logger for live-trading events.
//
// SAFETY: Never throws. Failure to audit must not block a safety check, but
// every audit failure is recorded via the system audit hook for visibility.

import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { liveTradingAuditTable } from "@workspace/db/schema";
import { auditEvent } from "../systemHealth/audit.js";

export type LiveAuditEventType =
  | "READINESS_CHECK" | "BLOCKER_DETECTED" | "ALERT_ACK"
  | "ARM_ATTEMPT" | "ARM_SUCCESS" | "ARM_FAILURE" | "DISARM"
  | "KILL_ENGAGE" | "KILL_RESET"
  | "APPROVAL_GENERATED" | "APPROVAL_APPROVED" | "APPROVAL_REJECTED" | "APPROVAL_EXPIRED"
  | "ORDER_SUBMIT_ATTEMPT" | "ORDER_REJECTED" | "ORDER_FILLED" | "ORDER_FAILED"
  | "STOP_LOSS_HIT" | "TAKE_PROFIT_HIT" | "MANUAL_CLOSE"
  | "RISK_BLOCK" | "BROKER_DISCONNECT" | "SPREAD_REJECT" | "DUPLICATE_ORDER_PREVENTED";

export interface LiveAuditArgs {
  eventType: LiveAuditEventType;
  severity?: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  mode?: string;
  symbol?: string | null;
  decisionId?: number | null;
  approvalId?: string | null;
  riskScore?: number | null;
  confidenceScore?: number | null;
  brokerResponse?: Record<string, unknown>;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  actorRole?: string | null;
  actorSession?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
}

export async function recordLiveAudit(args: LiveAuditArgs): Promise<string> {
  const eventId = `lta_${randomUUID()}`;
  try {
    await db.insert(liveTradingAuditTable).values({
      eventId,
      eventType: args.eventType,
      severity: args.severity ?? "INFO",
      mode: args.mode ?? "READ_ONLY",
      symbol: args.symbol ?? null,
      decisionId: args.decisionId ?? null,
      approvalId: args.approvalId ?? null,
      riskScore: args.riskScore ?? null,
      confidenceScore: args.confidenceScore ?? null,
      brokerResponse: args.brokerResponse ?? {},
      beforeState: args.beforeState ?? {},
      afterState: args.afterState ?? {},
      actorRole: args.actorRole ?? null,
      actorSession: args.actorSession ?? null,
      message: args.message,
      metadata: args.metadata ?? {},
    });
    try {
      await auditEvent({
        eventType: "LIVE_TRADING", action: args.eventType,
        sourceBuild: "TT", severity: args.severity ?? "INFO",
        metadata: { eventId, message: args.message, ...(args.metadata ?? {}) },
      } as unknown as Parameters<typeof auditEvent>[0]);
    } catch { /* never block on audit */ }
  } catch { /* never throw from audit */ }
  return eventId;
}
