// Build TT — Live-trading state machine.
//
// SAFETY (inviolable):
// - Default row is FAIL-CLOSED: mode=READ_ONLY, armed=false,
//   killSwitchActive=true, emergencyStopActive=true.
// - arm() can ONLY transition into MICRO_LIVE if readiness passes AND the
//   exact confirmation phrase is provided. Even after arm(), no broker
//   execution is possible — placeLiveOrderGuarded() is a code-level stub.
// - kill switch, once engaged, requires explicit reset by ADMIN.
// - This module never sets canPlaceTrades. It never calls broker functions.

import { db } from "@workspace/db";
import { liveTradingStateTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { recordLiveAudit } from "./audit.js";
import { MICRO_LIVE_LIMITS } from "./limits.js";

export type LiveMode = "READ_ONLY" | "PAPER_ONLY" | "MICRO_LIVE_READY" | "MICRO_LIVE" | "LIVE_LOCKED";

export interface LiveTradingState {
  id: number;
  mode: LiveMode;
  armed: boolean;
  killSwitchActive: boolean;
  emergencyStopActive: boolean;
  armedAt: Date | null;
  armedBy: string | null;
  disarmedAt: Date | null;
  disarmedBy: string | null;
  killSwitchAt: Date | null;
  killSwitchReason: string | null;
  killSwitchBy: string | null;
  lastReadinessAt: Date | null;
  lastReadinessEligible: boolean;
  lastReadinessSnapshot: Record<string, unknown>;
  consecutiveLiveLosses: number;
  liveTradesToday: number;
  liveTradesSession: number;
  dailyLossPct: number;
  weeklyLossPct: number;
}

let initialized = false;

export async function ensureStateInitialized(): Promise<void> {
  if (initialized) return;
  try {
    const rows = await db.select().from(liveTradingStateTable).limit(1);
    if (rows.length === 0) {
      await db.insert(liveTradingStateTable).values({
        mode: "READ_ONLY", armed: false,
        killSwitchActive: true, emergencyStopActive: true,
      });
      await recordLiveAudit({
        eventType: "READINESS_CHECK", severity: "INFO",
        message: "Live-trading state initialized (FAIL-CLOSED defaults).",
        afterState: { mode: "READ_ONLY", armed: false, killSwitchActive: true, emergencyStopActive: true },
      });
    }
    initialized = true;
  } catch { /* leave uninitialized; getState will retry */ }
}

export async function getState(): Promise<LiveTradingState> {
  await ensureStateInitialized();
  const rows = await db.select().from(liveTradingStateTable).limit(1);
  if (rows.length === 0) {
    // Hard-coded fail-closed snapshot if DB unavailable.
    return {
      id: 0, mode: "READ_ONLY", armed: false,
      killSwitchActive: true, emergencyStopActive: true,
      armedAt: null, armedBy: null, disarmedAt: null, disarmedBy: null,
      killSwitchAt: null, killSwitchReason: "DB_UNAVAILABLE_FAIL_CLOSED", killSwitchBy: "system",
      lastReadinessAt: null, lastReadinessEligible: false, lastReadinessSnapshot: {},
      consecutiveLiveLosses: 0, liveTradesToday: 0, liveTradesSession: 0,
      dailyLossPct: 0, weeklyLossPct: 0,
    };
  }
  const r = rows[0];
  return {
    id: r.id,
    mode: r.mode as LiveMode,
    armed: r.armed,
    killSwitchActive: r.killSwitchActive,
    emergencyStopActive: r.emergencyStopActive,
    armedAt: r.armedAt, armedBy: r.armedBy,
    disarmedAt: r.disarmedAt, disarmedBy: r.disarmedBy,
    killSwitchAt: r.killSwitchAt, killSwitchReason: r.killSwitchReason, killSwitchBy: r.killSwitchBy,
    lastReadinessAt: r.lastReadinessAt,
    lastReadinessEligible: r.lastReadinessEligible,
    lastReadinessSnapshot: (r.lastReadinessSnapshot ?? {}) as Record<string, unknown>,
    consecutiveLiveLosses: r.consecutiveLiveLosses,
    liveTradesToday: r.liveTradesToday,
    liveTradesSession: r.liveTradesSession,
    dailyLossPct: r.dailyLossPct,
    weeklyLossPct: r.weeklyLossPct,
  };
}

async function updateState(patch: Partial<typeof liveTradingStateTable.$inferInsert>): Promise<void> {
  await ensureStateInitialized();
  await db.update(liveTradingStateTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(liveTradingStateTable.id, 1));
}

export interface ArmArgs {
  confirmationPhrase: string;
  mode: "MICRO_LIVE";
  actorRole: string;
  actorSession?: string;
  readinessSnapshot: Record<string, unknown>;
  readinessEligible: boolean;
}

export interface ArmResult {
  ok: boolean;
  reason: string;
  state: LiveTradingState;
}

export async function arm(args: ArmArgs): Promise<ArmResult> {
  const before = await getState();
  await recordLiveAudit({
    eventType: "ARM_ATTEMPT", severity: "WARNING", mode: before.mode,
    actorRole: args.actorRole, actorSession: args.actorSession,
    message: "Arm attempt received", beforeState: snapshot(before),
    metadata: { requestedMode: args.mode },
  });

  if (args.confirmationPhrase !== MICRO_LIVE_LIMITS.CONFIRMATION_PHRASE) {
    await recordLiveAudit({
      eventType: "ARM_FAILURE", severity: "HIGH", mode: before.mode,
      actorRole: args.actorRole, message: "Arm rejected — confirmation phrase mismatch",
    });
    return { ok: false, reason: "CONFIRMATION_PHRASE_MISMATCH", state: before };
  }
  if (args.mode !== "MICRO_LIVE") {
    return { ok: false, reason: "ONLY_MICRO_LIVE_ALLOWED", state: before };
  }
  if (!args.readinessEligible) {
    await recordLiveAudit({
      eventType: "ARM_FAILURE", severity: "HIGH", mode: before.mode,
      actorRole: args.actorRole, message: "Arm rejected — readiness gate not eligible",
      metadata: { readinessSnapshot: args.readinessSnapshot },
    });
    return { ok: false, reason: "READINESS_NOT_ELIGIBLE", state: before };
  }
  if (before.killSwitchActive || before.emergencyStopActive) {
    await recordLiveAudit({
      eventType: "ARM_FAILURE", severity: "HIGH", mode: before.mode,
      actorRole: args.actorRole, message: "Arm rejected — kill switch / emergency stop active",
    });
    return { ok: false, reason: "KILL_SWITCH_ACTIVE", state: before };
  }

  await updateState({
    mode: "MICRO_LIVE", armed: true,
    armedAt: new Date(), armedBy: args.actorRole,
    lastReadinessAt: new Date(),
    lastReadinessEligible: true,
    lastReadinessSnapshot: args.readinessSnapshot,
    liveTradesSession: 0,
  });
  const after = await getState();
  await recordLiveAudit({
    eventType: "ARM_SUCCESS", severity: "CRITICAL", mode: "MICRO_LIVE",
    actorRole: args.actorRole, actorSession: args.actorSession,
    message: "MICRO_LIVE armed (no broker execution layer exists in this build)",
    beforeState: snapshot(before), afterState: snapshot(after),
  });
  return { ok: true, reason: "ARMED", state: after };
}

export interface DisarmArgs { actorRole: string; actorSession?: string; reason?: string; }

export async function disarm(args: DisarmArgs): Promise<LiveTradingState> {
  const before = await getState();
  await updateState({
    mode: "PAPER_ONLY", armed: false,
    disarmedAt: new Date(), disarmedBy: args.actorRole,
  });
  const after = await getState();
  await recordLiveAudit({
    eventType: "DISARM", severity: "WARNING", mode: "PAPER_ONLY",
    actorRole: args.actorRole, actorSession: args.actorSession,
    message: `Disarmed to PAPER_ONLY: ${args.reason ?? "no reason"}`,
    beforeState: snapshot(before), afterState: snapshot(after),
  });
  return after;
}

export interface KillEngageArgs { actorRole: string; actorSession?: string; reason: string; }

export async function engageKill(args: KillEngageArgs): Promise<LiveTradingState> {
  const before = await getState();
  await updateState({
    killSwitchActive: true, emergencyStopActive: true,
    armed: false, mode: "LIVE_LOCKED",
    killSwitchAt: new Date(), killSwitchReason: args.reason, killSwitchBy: args.actorRole,
  });
  const after = await getState();
  await recordLiveAudit({
    eventType: "KILL_ENGAGE", severity: "CRITICAL", mode: "LIVE_LOCKED",
    actorRole: args.actorRole, actorSession: args.actorSession,
    message: `Emergency kill switch engaged: ${args.reason}`,
    beforeState: snapshot(before), afterState: snapshot(after),
  });
  return after;
}

export interface KillResetArgs {
  actorRole: string;
  actorSession?: string;
  reason: string;
  readinessEligible: boolean;
  unackCriticalCount: number;
}

export interface KillResetResult { ok: boolean; reason: string; state: LiveTradingState; }

export async function resetKill(args: KillResetArgs): Promise<KillResetResult> {
  const before = await getState();
  if (args.actorRole !== "ADMIN" && args.actorRole !== "OWNER") {
    return { ok: false, reason: "ADMIN_REQUIRED", state: before };
  }
  if (args.unackCriticalCount > 0) {
    return { ok: false, reason: "UNACK_CRITICAL_ALERTS_PRESENT", state: before };
  }
  if (!args.readinessEligible) {
    return { ok: false, reason: "READINESS_NOT_ELIGIBLE", state: before };
  }
  if (!args.reason || args.reason.trim().length < 8) {
    return { ok: false, reason: "REASON_REQUIRED_MIN_8_CHARS", state: before };
  }
  await updateState({
    killSwitchActive: false, emergencyStopActive: false,
    mode: "READ_ONLY", armed: false,
    killSwitchAt: null, killSwitchReason: null, killSwitchBy: null,
  });
  const after = await getState();
  await recordLiveAudit({
    eventType: "KILL_RESET", severity: "CRITICAL", mode: "READ_ONLY",
    actorRole: args.actorRole, actorSession: args.actorSession,
    message: `Kill switch reset: ${args.reason}`,
    beforeState: snapshot(before), afterState: snapshot(after),
  });
  return { ok: true, reason: "RESET", state: after };
}

function snapshot(s: LiveTradingState): Record<string, unknown> {
  return {
    mode: s.mode, armed: s.armed,
    killSwitchActive: s.killSwitchActive, emergencyStopActive: s.emergencyStopActive,
    liveTradesSession: s.liveTradesSession, liveTradesToday: s.liveTradesToday,
    consecutiveLiveLosses: s.consecutiveLiveLosses,
  };
}
