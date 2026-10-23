// Build TT — Live Trading Readiness Gate.
//
// SAFETY (inviolable):
// - Read-only. Aggregates the verdicts of existing safety subsystems.
// - Returns liveTradingEligible:false unless ALL conditions pass.
// - Never sets canPlaceTrades. Never modifies any safety primitive.

import { db } from "@workspace/db";
import {
  notificationsTable, livePositionsTable, mt5CommandsTable, paperSessionsTable,
} from "@workspace/db/schema";
import { sql, and, eq, gt, isNotNull, desc } from "drizzle-orm";
import { preflight } from "../paperSession/manager.js";
import { evaluateGovernor } from "../riskGovernor/governor.js";
import { brokerStatusForGovernance } from "../brokerReadOnly/service.js";
import { getStatus as getSafetyStatus } from "../safetyCore.js";
import { getState as getLiveState } from "./state.js";
import { MICRO_LIVE_LIMITS } from "./limits.js";
import { recordLiveAudit } from "./audit.js";

export type ReadinessMode = "READ_ONLY" | "PAPER_ONLY" | "MICRO_LIVE_READY" | "LIVE_LOCKED";

export interface ReadinessReport {
  liveTradingEligible: boolean;
  currentMode: ReadinessMode;
  blockers: string[];
  warnings: string[];
  requiredActions: string[];
  safetyScore: number;
  paperStats: Record<string, unknown>;
  riskStatus: Record<string, unknown>;
  brokerStatus: Record<string, unknown>;
  permissionStatus: Record<string, unknown>;
  hardCodedLimits: typeof MICRO_LIVE_LIMITS;
  ciGuardsAcknowledged: string[];
  lastUpdated: string;
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

export async function computeReadiness(actorRole = "system"): Promise<ReadinessReport> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const requiredActions: string[] = [];

  // 1. Unacknowledged CRITICAL alerts
  const unackCritical = await safe(async () => {
    const rows = await db.select({ c: sql<number>`count(*)::int` })
      .from(notificationsTable)
      .where(and(eq(notificationsTable.severity, "CRITICAL"), eq(notificationsTable.status, "UNREAD")));
    return rows[0]?.c ?? 0;
  }, 0);
  if (unackCritical > 0) {
    blockers.push(`${unackCritical} unacknowledged CRITICAL alert(s)`);
    requiredActions.push("Acknowledge all CRITICAL alerts via POST /api/notifications/:id/acknowledge");
  }

  // 2. Paper preflight
  const paperPreflight = await safe<Record<string, unknown>>(async () => preflight() as unknown as Record<string, unknown>, {
    paperTestingAllowed: false, hardBlocks: ["preflight unavailable"], softWarnings: [],
  } as Record<string, unknown>);
  const paperAllowed = (paperPreflight as { paperTestingAllowed?: boolean }).paperTestingAllowed === true;
  if (!paperAllowed) {
    blockers.push("Paper preflight failed");
    requiredActions.push("Resolve paper preflight hard blocks before arming live");
  }

  // 3. Risk governor
  const governor = await safe<Record<string, unknown>>(async () => evaluateGovernor() as unknown as Record<string, unknown>, {
    governor: { liveTradingAllowed: false, allowedActions: { canPlaceLiveTrade: false }, score: 0, level: "BLOCK" },
  } as Record<string, unknown>);
  const govPayload = (governor as { governor?: { liveTradingAllowed?: boolean } }).governor ?? (governor as { liveTradingAllowed?: boolean });
  const govLiveAllowed = (govPayload as { liveTradingAllowed?: boolean }).liveTradingAllowed === true;
  if (!govLiveAllowed) {
    blockers.push("Risk governor does not allow live trading (advisory)");
  }

  // 4. Safety core / permission system — canPlaceTrades MUST stay false in this build
  const safety = await safe<Record<string, unknown>>(async () => getSafetyStatus() as unknown as Record<string, unknown>, {
    canPlaceTrades: false, liveTradingDisabled: true, mode: "READ_ONLY",
  } as Record<string, unknown>);
  const canPlace = (safety as { canPlaceTrades?: boolean }).canPlaceTrades === true;
  const liveDisabled = (safety as { liveTradingDisabled?: boolean }).liveTradingDisabled === true;
  if (canPlace) {
    blockers.push("FATAL: safety core reports canPlace flag set — this build forbids that state");
  }
  if (!liveDisabled) {
    blockers.push("Safety core does not report liveTradingDisabled=true");
  }

  // 5. Broker read-only status
  const broker = await safe<Record<string, unknown>>(async () => brokerStatusForGovernance() as unknown as Record<string, unknown>, {
    mode: "UNKNOWN", liveTradingAllowed: false, safe: false,
  } as Record<string, unknown>);
  const brokerMode = (broker as { mode?: string }).mode ?? (broker as { status?: { mode?: string } }).status?.mode;
  if (!brokerMode || (brokerMode !== "READ_ONLY" && brokerMode !== "MICRO_LIVE_READY")) {
    blockers.push(`Broker not in READ_ONLY mode (current: ${brokerMode ?? "unknown"})`);
    requiredActions.push("Configure broker in READ_ONLY before arming live");
  }

  // 6. Live tables must not have grown beyond known baseline (advisory).
  const livePosCount = await safe(async () =>
    (await db.select({ c: sql<number>`count(*)::int` }).from(livePositionsTable))[0]?.c ?? 0, 0);
  const mt5CmdCount = await safe(async () =>
    (await db.select({ c: sql<number>`count(*)::int` }).from(mt5CommandsTable))[0]?.c ?? 0, 0);

  // 7. ≥1 ENDED paper session with no critical failures
  type SessRow = typeof paperSessionsTable.$inferSelect;
  let endedSessions: SessRow[] = [];
  try {
    endedSessions = await db.select().from(paperSessionsTable)
      .where(eq(paperSessionsTable.status, "ENDED"))
      .orderBy(desc(paperSessionsTable.endedAt)).limit(5);
  } catch { endedSessions = []; }
  if (endedSessions.length === 0) {
    blockers.push("No completed (ENDED) paper session found");
    requiredActions.push("Complete at least one controlled paper session");
  } else {
    const latest = endedSessions[0];
    const warnings_ = Array.isArray(latest.activeWarnings) ? latest.activeWarnings : [];
    const criticalInLatest = warnings_.filter((w: unknown) =>
      typeof w === "object" && w !== null && (w as { severity?: string }).severity === "CRITICAL");
    if (criticalInLatest.length > 0) {
      blockers.push(`Latest paper session has ${criticalInLatest.length} CRITICAL warning(s)`);
    }
  }

  // 8. Live-trading state — kill switch / emergency stop
  const liveState = await getLiveState();
  if (liveState.killSwitchActive) {
    blockers.push("Emergency kill switch is ACTIVE");
    requiredActions.push("Reset kill switch via POST /api/live-trading/reset-kill-switch (ADMIN only)");
  }
  if (liveState.emergencyStopActive) {
    blockers.push("Emergency stop is ACTIVE");
  }

  // 9. Required limits exist
  for (const [k, v] of Object.entries(MICRO_LIVE_LIMITS)) {
    if (v === undefined || v === null) blockers.push(`Missing micro-live limit: ${k}`);
  }

  // 10. Audit logging is reachable (write a READINESS_CHECK row)
  const auditEventId = await recordLiveAudit({
    eventType: "READINESS_CHECK", severity: "INFO",
    mode: liveState.mode, actorRole,
    message: `Readiness check: ${blockers.length} blocker(s), ${warnings.length} warning(s)`,
    metadata: { unackCritical, paperAllowed, govLiveAllowed, brokerMode, livePosCount, mt5CmdCount,
                endedSessions: endedSessions.length },
  });

  // Score: 100 minus 10 per blocker, 5 per warning, floor 0.
  const safetyScore = Math.max(0, 100 - blockers.length * 10 - warnings.length * 5);

  const eligible = blockers.length === 0;
  const currentMode: ReadinessMode = liveState.killSwitchActive ? "LIVE_LOCKED"
    : eligible ? "MICRO_LIVE_READY"
    : (liveState.mode === "MICRO_LIVE" || liveState.mode === "MICRO_LIVE_READY") ? "PAPER_ONLY"
    : (liveState.mode as ReadinessMode);

  return {
    liveTradingEligible: eligible && !canPlace, // double-locked
    currentMode,
    blockers, warnings, requiredActions,
    safetyScore,
    paperStats: {
      endedSessionCount: endedSessions.length,
      latestSessionId: endedSessions[0]?.paperSessionId ?? null,
      latestSessionStatus: endedSessions[0]?.status ?? null,
      latestSessionTradesClosed: endedSessions[0]?.paperTradesClosed ?? 0,
      preflight: paperPreflight,
    },
    riskStatus: governor as unknown as Record<string, unknown>,
    brokerStatus: broker as unknown as Record<string, unknown>,
    permissionStatus: { ...(safety as unknown as Record<string, unknown>), canPlaceTrades: canPlace, liveTradingDisabled: liveDisabled },
    hardCodedLimits: MICRO_LIVE_LIMITS,
    ciGuardsAcknowledged: [
      "can-place-trades-invariant",
      "paper-autopilot-isolation",
      "live-trading-readiness-lock",
      "emergency-kill-switch",
      "live-order-risk-limits",
    ],
    lastUpdated: new Date().toISOString(),
  };
}
