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
//     live-auto levels — the explicit live-auto opt-in. Downgrades (risk
//     reduction) are always allowed and disable the live-auto opt-in when
//     leaving live.
//   - THE EVIDENCE BAR (inversion fix). Stepping demo → LIVE additionally
//     requires the SAME evidence gates the promotion ladder makes mandatory at
//     demo-auto. Before this, demo→live required no performance evidence at all
//     while any auto level required the full checklist — so the easy road to
//     real money skipped the ladder, and the only road to autonomy was trading
//     real money at level 2. Both roads now require evidence, and unreadable
//     evidence fails CLOSED.
//   - Per-user / per-mission isolation: the row is loaded FOR UPDATE scoped by
//     (id, userId); every change is journalled + audited in one transaction.
import { and, eq, isNotNull } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionTradeDraftsTable,
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
import {
  resolveMissionLadderEvidenceBar,
  type PromotionContext,
} from "./missionPromotionService.js";
import { describeEvidenceBasis, PROMOTION_EVIDENCE_LEVEL } from "@workspace/domain/profit-mission";
import { accountingBasisForMode, type MissionAccountingBasis } from "./missionSimulatedFills.js";

type MissionRow = typeof profitMissionsTable.$inferSelect;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/**
 * The realised total for ONE accounting basis, read in the mode-change
 * transaction. The two series are read separately and NEVER summed — a
 * BROKER_RECONCILED read sees only `simulated = false` rows via their
 * broker-reconciled `pnl`/`closed_at`; a SIMULATED read sees only
 * `simulated = true` rows via their `sim_pnl`/`sim_closed_at`.
 */
async function readRealisedForBasis(
  tx: Tx,
  args: { userId: number; missionId: number },
  basis: MissionAccountingBasis,
): Promise<{ profit: number; tradeCount: number }> {
  if (basis === "BROKER_RECONCILED") {
    const rows = await tx
      .select({ pnl: missionTradeDraftsTable.pnl })
      .from(missionTradeDraftsTable)
      .where(
        and(
          eq(missionTradeDraftsTable.missionId, args.missionId),
          eq(missionTradeDraftsTable.userId, args.userId),
          eq(missionTradeDraftsTable.status, "executed"),
          eq(missionTradeDraftsTable.simulated, false),
          isNotNull(missionTradeDraftsTable.closedAt),
        ),
      );
    let profit = 0;
    let tradeCount = 0;
    for (const r of rows) {
      if (!isNum(r.pnl)) continue;
      profit += r.pnl;
      tradeCount += 1;
    }
    return { profit: round2(profit), tradeCount };
  }
  const rows = await tx
    .select({ simPnl: missionTradeDraftsTable.simPnl })
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, args.missionId),
        eq(missionTradeDraftsTable.userId, args.userId),
        eq(missionTradeDraftsTable.simulated, true),
        isNotNull(missionTradeDraftsTable.simClosedAt),
      ),
    );
  let profit = 0;
  let tradeCount = 0;
  for (const r of rows) {
    if (!isNum(r.simPnl)) continue;
    profit += r.simPnl;
    tradeCount += 1;
  }
  return { profit: round2(profit), tradeCount };
}

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

  // ── INVERSION FIX: real money requires the ladder's EVIDENCE bar ──────────
  // This step used to require a certificate + the live master switch but NO
  // performance evidence, while earning ANY auto level required the full
  // promotion checklist. That made demo→live the easy road: skip the ladder,
  // reach real money, then be forced to trade real money at level 2 to earn any
  // autonomy at all. Stepping onto real money now clears exactly the evidence
  // gates the ladder demands at level 3 (backtest / forward / demo performance /
  // drawdown / agent reliability / risk rules / drift), read from the SAME
  // evidence — which a paper/demo mission can now actually produce, honestly
  // labelled as simulated. Read outside the transaction (it is a multi-table
  // read) and used ONLY to refuse. Unreadable evidence fails CLOSED.
  const evidenceBar =
    targetMode === "live" ? await resolveMissionLadderEvidenceBar({
      userId: args.userId,
      missionId: args.missionId,
      ctx: args.ctx,
    }) : null;

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
        // The ladder's evidence bar (see the note above `evidenceBar`). Real
        // money is never an easier road than autonomy.
        if (evidenceBar == null || !evidenceBar.passed) {
          const failed = evidenceBar?.failedGates ?? ["evidence_unreadable"];
          blockReasons.push(
            `PROMOTION_EVIDENCE_REQUIRED_FOR_LIVE (level ${PROMOTION_EVIDENCE_LEVEL} bar; failed: ${failed.join(", ")}; ${describeEvidenceBasis(evidenceBar?.demoEvidenceBasis ?? "UNSTATED")})`,
          );
        }
      }
    }

    if (blockReasons.length > 0) {
      await tx.insert(missionEventsTable).values({
        missionId: args.missionId,
        type: "execution_mode_blocked",
        message: `Execution-mode change ${currentMode} → ${targetMode} refused.${blockReasons[0] ? ` ${blockReasons[0]}` : ""}`,
        metadataJson: {
          from: currentMode,
          to: targetMode,
          blockReasons,
          ...(evidenceBar
            ? { evidenceBar: { passed: evidenceBar.passed, failedGates: evidenceBar.failedGates, demoEvidenceBasis: evidenceBar.demoEvidenceBasis } }
            : {}),
        },
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

    // ── BASIS REBASE: a mode change that crosses the accounting basis MUST
    // rebase the mission's money figure. `currentValue` is written by
    // refreshMissionProtection as startingAmount + the realised total OF THE
    // CURRENT BASIS, so a demo mission carries a SIMULATED currentValue. Left
    // alone across demo→live it would be read as the real account balance by
    // the very next draft (missionDrafts sizes from mission.currentValue) and
    // by the risk service's drawdown maths — a simulated figure reaching a real
    // money decision. Neither series is converted into the other: the target
    // basis is re-read from its own columns, and a fresh live mission therefore
    // correctly starts at startingAmount + 0 broker-reconciled profit.
    const priorBasis = accountingBasisForMode(currentMode);
    const nextBasis = accountingBasisForMode(targetMode);
    const rebase =
      nextBasis !== priorBasis
        ? await readRealisedForBasis(tx, { userId: args.userId, missionId: args.missionId }, nextBasis)
        : null;
    const rebasedProgress =
      rebase == null
        ? null
        : (() => {
            const priorProgress = asRecord(mission.progressJson);
            const priorAccounting = asRecord(priorProgress.accounting);
            return {
              ...priorProgress,
              accounting: {
                ...priorAccounting,
                basis: nextBasis,
                simulated: nextBasis === "SIMULATED",
                label:
                  nextBasis === "SIMULATED"
                    ? "SIMULATED — outcomes modelled from real quotes on a paper/demo mission. Not broker-reconciled money."
                    : "Broker-reconciled realised money.",
                // Only the target series is stated; the other is left to the
                // next refreshMissionProtection rather than guessed here.
                ...(nextBasis === "BROKER_RECONCILED"
                  ? { brokerReconciledProfit: rebase.profit, brokerReconciledTradeCount: rebase.tradeCount }
                  : { simulatedProfit: rebase.profit, simulatedTradeCount: rebase.tradeCount }),
                rebasedFromBasis: priorBasis,
                asOf: new Date().toISOString(),
              },
            };
          })();

    await tx
      .update(profitMissionsTable)
      .set({
        executionMode: targetMode,
        ...(leavingLive ? { liveAutoEnabled: false } : {}),
        ...(rebase != null
          ? {
              currentValue: round2(mission.startingAmount + rebase.profit),
              ...(rebasedProgress != null ? { progressJson: rebasedProgress } : {}),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)));

    const rebaseReason =
      rebase == null
        ? []
        : [
            `mission value rebased onto ${nextBasis} accounting (was ${priorBasis}): ${round2(mission.startingAmount + rebase.profit)} from ${rebase.tradeCount} closed ${nextBasis === "SIMULATED" ? "simulated" : "broker-reconciled"} trade(s)`,
          ];
    const reasons = upgrade
      ? [
          `gated upgrade ${currentMode} → ${targetMode} (explicitly confirmed)`,
          ...(evidenceBar
            ? [`ladder evidence bar cleared — ${describeEvidenceBasis(evidenceBar.demoEvidenceBasis)}`]
            : []),
          ...rebaseReason,
        ]
      : [
          `risk-reduction downgrade ${currentMode} → ${targetMode}${leavingLive ? " (live auto disabled)" : ""}`,
          ...rebaseReason,
        ];

    await tx.insert(missionEventsTable).values({
      missionId: args.missionId,
      type: "execution_mode_changed",
      message: `Execution mode changed ${currentMode} → ${targetMode}. ${reasons[0]}.`,
      metadataJson: {
        from: currentMode,
        to: targetMode,
        upgrade,
        liveAutoDisabled: leavingLive,
        ...(rebase != null
          ? {
              valueRebase: {
                fromBasis: priorBasis,
                toBasis: nextBasis,
                currentValue: round2(mission.startingAmount + rebase.profit),
                realisedProfit: rebase.profit,
                realisedTradeCount: rebase.tradeCount,
              },
            }
          : {}),
      },
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
