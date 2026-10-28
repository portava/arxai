// Risk Governor audit trail (user_risk_events) and the trader's settings row.
//
// Every pre-trade decision, trader override and post-close discipline event is
// written here, scoped to its trader. Secrets never reach the details column.

import { db, userRiskSettingsTable, userRiskEventsTable, vaultEventsTable } from "@workspace/db";
import { appendAuditInTransaction } from "../auditVault.js";
import { readTraderRiskSettings } from "./limitSettings.js";
import { DEFAULT_USER_RISK_SETTINGS } from "./journalActivity.js";

export async function getOrCreateRiskSettings(userId: number) {
  const existing = await readTraderRiskSettings(userId);
  if (existing) return existing;
  const ins = await db.insert(userRiskSettingsTable).values({ userId, ...DEFAULT_USER_RISK_SETTINGS }).returning();
  return ins[0]!;
}

export async function logRiskEvent(args: {
  userId: number; eventType: string; severity: "info" | "warning" | "critical"; decision: "pass" | "warning" | "block";
  reason: string; details?: Record<string, unknown>;
  paperTradeId?: number | null; tradingSessionId?: number | null; mt5ConnectionId?: number | null;
}) {
  // Defensive: never persist anything resembling a bridge token
  const safeDetails = scrubSecrets(args.details ?? {});
  const ins = await db.transaction(async tx => {
    const rows = await tx.insert(userRiskEventsTable).values({
      userId: args.userId, eventType: args.eventType, severity: args.severity, decision: args.decision,
      reason: args.reason, details: safeDetails,
      paperTradeId: args.paperTradeId ?? null,
      tradingSessionId: args.tradingSessionId ?? null,
      mt5ConnectionId: args.mt5ConnectionId ?? null,
    }).returning();
    if (safeDetails.source === "pre_trade_risk_governor") {
      const intent = safeDetails.intent as { symbol?: string; venue?: string; action?: string } | undefined;
      const linkedDecisionId = `risk:${rows[0]!.id}`;
      const blockers = Array.isArray(safeDetails.blockedBy) ? safeDetails.blockedBy : [];
      const kind = args.decision === "block" ? "GOVERNED_TRADE_BLOCKED" : "GOVERNED_TRADE_DECISION";
      const payload = { userId: args.userId, linkedDecisionId, symbol: intent?.symbol ?? null, venue: intent?.venue, action: intent?.action, decision: args.decision, reason: args.reason, blockers };
      await tx.insert(vaultEventsTable).values({ kind, severity: args.decision === "block" ? "WARN" : "INFO",
        source: "RISK_GOVERNOR", truthDomain: "DECISION", summary: args.reason, payload, reasons: [args.reason], blockers,
        symbol: intent?.symbol ?? null, linkedDecisionId, generatedAtIso: new Date().toISOString() });
      await appendAuditInTransaction(tx, { eventType: kind, source: "RISK_GOVERNOR", severity: args.decision === "block" ? "WARN" : "INFO",
        systemMode: null, globalState: null, payload });
    }
    return rows;
  });
  // Phase 10F — emit notification + activity for warning/block events.
  if (args.decision !== "pass") {
    try {
      const { fireNotify } = await import("../notificationService.js");
      const sev = args.decision === "block" ? "critical" : "warning";
      const notifType = args.decision === "block" ? "risk_block" : "risk_warning";
      fireNotify(args.userId,
        { notificationType: notifType, severity: sev, title: args.decision === "block" ? "Risk Governor blocked a trade" : "Risk warning", message: args.reason, source: "risk", entityType: "paper_trade", entityId: args.paperTradeId ?? null, actionLabel: "View risk events", actionTarget: "/risk-settings" },
        { eventType: args.decision === "block" ? "risk_trade_blocked" : "risk_check_completed", title: args.decision === "block" ? "Risk Governor blocked a trade" : "Risk warning issued", description: args.reason, source: "risk", entityType: "paper_trade", entityId: args.paperTradeId ?? null }
      );
    } catch { /* never break risk path */ }
  }
  return ins;
}

const SECRET_KEY_RE = /token|secret|password|bridge|api[_-]?key|authorization|cookie|x-mt5/i;
const SECRET_VAL_RE = /MT5_BRIDGE_TOKEN|X-MT5-Bridge-Token/i;
function scrubValue(v: unknown, depth = 0): unknown {
  if (v == null) return v;
  if (depth > 8) return "[REDACTED_DEPTH_LIMIT]"; // fail-closed beyond depth bound
  if (typeof v === "string") return SECRET_VAL_RE.test(v) ? "[REDACTED]" : v;
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) out[k] = "[REDACTED]";
      else out[k] = scrubValue(val, depth + 1);
    }
    return out;
  }
  return v;
}
function scrubSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  return scrubValue(obj) as Record<string, unknown>;
}
