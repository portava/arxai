// ── Profit Mission F-build — executionMode lifecycle service (fail-closed) ────
//
// SAFETY / SCOPE:
//   - GOVERNANCE ONLY. This service applies a gated `paper → demo → live`
//     execution-mode transition to a mission. Changing the mode NEVER places a
//     trade and NEVER relaxes any gate. Precisely what each mode reaches:
//       * a LIVE-mode mission dispatches only through dispatchApprovedDraft →
//         executeInstant → the full per-user governor + the 23-gate live
//         dispatch + the env/db master switch;
//       * a PAPER/DEMO mission runs the same MISSION-LAYER chain inside
//         dispatchApprovedDraft (probation + mission gate + Phase 7 + the
//         single-flight claim) and then stops at the simulated recorder. It
//         never reaches executeInstant, so the governor, the master switch and
//         the 23 gates are NOT evaluated for it, and no broker is contacted.
//     Nothing is fabricated in either mode; the simulated leg records an intent
//     and produces no fill, no position and no realised result.
//     INTEGRATOR NOTE: the sibling branch `fix/demo-ladder` may change this
//     behaviour — this describes the code on `fix/honest-copy`.
//   - FAIL-CLOSED ladder: upgrades are stepwise (paper→demo, demo→live) and
//     each upgrade requires an explicit `confirm: true`. Stepping to LIVE
//     additionally requires the accepted Mission Risk Certificate, the platform
//     live gates (env AND db master switch) being enabled, an automation level
//     that is allowed to reach live (level 3 demo-auto is refused), and — for
//     live-auto levels — a passing promotion decision re-evaluated against the
//     prospective live account type. Downgrades (risk reduction) are always
//     allowed and disable the live-auto opt-in when leaving live.
//   - Per-user / per-mission isolation: the row is loaded FOR UPDATE scoped by
//     (id, userId); every change is journalled + audited in one transaction.
import { and, eq } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionEventsTable,
  oneClickAuditTable,
} from "@workspace/db";
import {
  isMissionExecutionMode,
  isMissionAutomationLevel,
  isTerminalStatus,
  isMissionStatus,
  metaForLevel,
  FIRST_LIVE_AUTO_LEVEL,
  resolveGuardrailCeiling,
  DEFAULT_MISSION_AUTOMATION_LEVEL,
  type MissionExecutionMode,
  type MissionAutomationLevel,
} from "@workspace/domain/profit-mission";
import { resolveLiveBrokerExecutionEnabledAsync } from "./live/phaseBConfig.js";
import type { PromotionContext } from "./missionPromotionService.js";

type MissionRow = typeof profitMissionsTable.$inferSelect;

/** Rank for the stepwise ladder. Upgrades move exactly one rung at a time. */
const MODE_RANK: Record<MissionExecutionMode, number> = { paper: 0, demo: 1, live: 2 };

export type ApplyExecutionModeResult =
  | { ok: true; applied: boolean; executionMode: MissionExecutionMode; reasons: string[] }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "invalid_mode" }
  | { ok: false; kind: "terminal" }
  | { ok: false; kind: "blocked"; blockReasons: string[] };

/**
 * Apply a gated execution-mode change. Fail-closed: the new mode is written
 * ONLY when every rule for the requested step passes; otherwise the honest
 * block reasons are returned and journaled, and nothing changes.
 */
export async function applyMissionExecutionMode(args: {
  userId: number;
  missionId: number;
  targetMode: unknown;
  /** Explicit confirmation, required for every upgrade. */
  confirm?: boolean;
  ctx: PromotionContext;
  ip?: string | null;
  ua?: string | null;
}): Promise<ApplyExecutionModeResult> {
  if (!isMissionExecutionMode(args.targetMode)) return { ok: false, kind: "invalid_mode" };
  const targetMode = args.targetMode;

  // The platform live master switch is read OUTSIDE the row transaction (it is
  // a global read) and only ever used to REFUSE — never to grant anything.
  const liveGatesEnabled =
    targetMode === "live"
      ? await resolveLiveBrokerExecutionEnabledAsync().catch(() => false)
      : false;

  return db.transaction(async (tx): Promise<ApplyExecutionModeResult> => {
    const rows = await tx
      .select()
      .from(profitMissionsTable)
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)))
      .for("update")
      .limit(1);
    const mission = rows[0] as MissionRow | undefined;
    if (!mission) return { ok: false, kind: "not_found" };

    if (isMissionStatus(mission.status) && isTerminalStatus(mission.status)) {
      return { ok: false, kind: "terminal" };
    }

    const currentMode: MissionExecutionMode = isMissionExecutionMode(mission.executionMode)
      ? mission.executionMode
      : "paper";
    if (currentMode === targetMode) {
      return { ok: true, applied: false, executionMode: currentMode, reasons: ["already in this mode"] };
    }

    const level: MissionAutomationLevel = isMissionAutomationLevel(mission.automationLevel)
      ? mission.automationLevel
      : DEFAULT_MISSION_AUTOMATION_LEVEL;
    const upgrade = MODE_RANK[targetMode] > MODE_RANK[currentMode];
    const blockReasons: string[] = [];

    if (upgrade) {
      // Stepwise only: paper→demo, demo→live. Never paper→live in one press.
      if (MODE_RANK[targetMode] !== MODE_RANK[currentMode] + 1) {
        blockReasons.push(`EXECUTION_MODE_STEP_SKIPPED (${currentMode} → ${targetMode})`);
      }
      if (args.confirm !== true) blockReasons.push("EXPLICIT_CONFIRM_REQUIRED");

      if (targetMode === "live") {
        if (mission.certificateAcceptedAt == null) blockReasons.push("CERTIFICATE_NOT_ACCEPTED");
        if (!liveGatesEnabled) blockReasons.push("LIVE_GATES_DISABLED");
        // Level 3 (demo auto) can never drive a live-mode mission.
        if (level >= 3 && !metaForLevel(level).reachesLive) {
          blockReasons.push("AUTOMATION_LEVEL_CANNOT_REACH_LIVE");
        }
        // The user's guardrail ceiling, evaluated against the prospective LIVE
        // account type, must still permit the mission's current level.
        const guardrail = resolveGuardrailCeiling({
          role: args.ctx.role,
          accountType: "live",
          isNewUser: args.ctx.isNewUser,
        });
        if (level > guardrail.maxLevel) {
          blockReasons.push(`AUTOMATION_LEVEL_EXCEEDS_GUARDRAIL_CEILING (${level} > ${guardrail.maxLevel})`);
        }
        // A mission already sitting at a live-auto level additionally needs the
        // explicit live-auto opt-in before it may be pointed at real money.
        // (In practice live-auto levels are only reachable AFTER the mode is
        // live — the promotion gate clamps demo accounts to level 3 — so this
        // covers the defensive corner, fail-closed.)
        if (level >= FIRST_LIVE_AUTO_LEVEL && !mission.liveAutoEnabled) {
          blockReasons.push("LIVE_AUTO_NOT_ENABLED_FOR_LIVE_AUTO_LEVEL");
        }
      }
    }

    if (blockReasons.length > 0) {
      await tx.insert(missionEventsTable).values({
        missionId: args.missionId,
        type: "execution_mode_blocked",
        message: `Execution-mode change ${currentMode} → ${targetMode} refused.${blockReasons[0] ? ` ${blockReasons[0]}` : ""}`,
        metadataJson: { from: currentMode, to: targetMode, blockReasons },
      });
      await tx.insert(oneClickAuditTable).values({
        userId: args.userId,
        action: "MISSION_EXECUTION_MODE_BLOCKED",
        ip: args.ip ?? null,
        userAgent: args.ua ?? null,
        metadata: JSON.stringify({ missionId: args.missionId, from: currentMode, to: targetMode, blockReasons }),
      });
      return { ok: false, kind: "blocked", blockReasons };
    }

    // Downgrading out of live always disables the live-auto opt-in (stricter).
    const leavingLive = currentMode === "live" && targetMode !== "live";
    await tx
      .update(profitMissionsTable)
      .set({
        executionMode: targetMode,
        ...(leavingLive ? { liveAutoEnabled: false } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)));

    const reasons = upgrade
      ? [`gated upgrade ${currentMode} → ${targetMode} (explicitly confirmed)`]
      : [`risk-reduction downgrade ${currentMode} → ${targetMode}${leavingLive ? " (live auto disabled)" : ""}`];

    await tx.insert(missionEventsTable).values({
      missionId: args.missionId,
      type: "execution_mode_changed",
      message: `Execution mode changed ${currentMode} → ${targetMode}. ${reasons[0]}.`,
      metadataJson: { from: currentMode, to: targetMode, upgrade, liveAutoDisabled: leavingLive },
    });
    await tx.insert(oneClickAuditTable).values({
      userId: args.userId,
      action: "MISSION_EXECUTION_MODE_CHANGE",
      ip: args.ip ?? null,
      userAgent: args.ua ?? null,
      metadata: JSON.stringify({ missionId: args.missionId, from: currentMode, to: targetMode, upgrade }),
    });

    return { ok: true, applied: true, executionMode: targetMode, reasons };
  });
}
