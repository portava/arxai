// ── Profit Mission Phase 9 — Strategy-drift service (fail-safe) ───────────────
//
// SAFETY / SCOPE:
//   - COMPOSES the pure drift detector with the mission's latest BACKTEST vs
//     FORWARD test results. On SEVERE drift it FAILS SAFE: it demotes the mission
//     to approval mode (Level 2), disables any explicit live-auto enablement,
//     records a risk-reduction flag, and PAUSES promotion — all journalled +
//     audited inside one transaction. Insufficient evidence yields an honest
//     UNKNOWN and changes nothing.
//   - This NEVER places a trade, contacts the EA/broker, or relaxes a live gate.
//     Drift can only TIGHTEN automation, never raise it.
//   - Per-user / per-mission isolation: the mission row is loaded FOR UPDATE
//     scoped by (id, userId).
import { and, eq } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionEventsTable,
  oneClickAuditTable,
} from "@workspace/db";
import {
  detectMissionDrift,
  driftBlocksPromotion,
  DEFAULT_MISSION_AUTOMATION_LEVEL,
  type DriftDecision,
  type MissionTestMetrics,
} from "@workspace/domain/profit-mission";
import { latestMissionTestResults } from "./missionTestingLabService.js";

type MissionRow = typeof profitMissionsTable.$inferSelect;

export type DriftServiceResult =
  | { ok: true; drift: DriftDecision; demoted: boolean; promotionPaused: boolean }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "insufficient_evidence"; drift: DriftDecision };

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Evaluate strategy drift for a mission and, on a blocking severity, demote it.
 * Composes the latest persisted backtest (historical baseline) and forward (real
 * realised) metrics. Fail-safe: SEVERE ⇒ demote + reduce risk + pause promotion.
 */
export async function evaluateAndApplyDrift(args: {
  userId: number;
  missionId: number;
  ip?: string | null;
  ua?: string | null;
}): Promise<DriftServiceResult> {
  const latest = await latestMissionTestResults(args.userId, args.missionId);

  // Honest UNKNOWN when we lack either side of the comparison.
  if (!latest.backtest || !latest.forward) {
    const drift = detectMissionDrift({
      historical: latest.backtest?.metrics ?? emptyMetrics(),
      forward: latest.forward?.metrics ?? emptyMetrics(),
    });
    // Confirm the mission exists / is owned before reporting.
    const owned = await db
      .select({ id: profitMissionsTable.id })
      .from(profitMissionsTable)
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)))
      .limit(1);
    if (!owned[0]) return { ok: false, kind: "not_found" };
    return { ok: false, kind: "insufficient_evidence", drift };
  }

  const drift = detectMissionDrift({
    historical: latest.backtest.metrics,
    forward: latest.forward.metrics,
  });
  const blocking = driftBlocksPromotion(drift.severity);
  const severe = drift.severity === "SEVERE";

  return db.transaction(async (tx): Promise<DriftServiceResult> => {
    const rows = await tx
      .select()
      .from(profitMissionsTable)
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)))
      .for("update")
      .limit(1);
    const mission = rows[0];
    if (!mission) return { ok: false, kind: "not_found" };

    const prevPromotion = asRecord(mission.promotionJson);
    const promotionJson: Record<string, unknown> = {
      ...prevPromotion,
      drift: {
        severity: drift.severity,
        score: drift.score,
        reasons: drift.reasons,
        evaluatedAt: new Date().toISOString(),
      },
      driftSeverity: drift.severity,
      promotionPaused: blocking || prevPromotion.promotionPaused === true,
      pausedReason: blocking
        ? `strategy drift ${drift.severity}`
        : (prevPromotion.pausedReason ?? null),
    };

    // Fail-safe demotion on SEVERE drift: drop to approval, kill live-auto opt-in,
    // and flag a risk reduction. Never RAISES anything.
    let demoted = false;
    const set: Partial<MissionRow> = { promotionJson, updatedAt: new Date() };
    if (severe && drift.recommendDemote) {
      if (mission.automationLevel > DEFAULT_MISSION_AUTOMATION_LEVEL) {
        set.automationLevel = DEFAULT_MISSION_AUTOMATION_LEVEL;
        demoted = true;
      }
      if (mission.liveAutoEnabled) set.liveAutoEnabled = false;
      promotionJson.riskReducedByDrift = true;
    }

    await tx
      .update(profitMissionsTable)
      .set(set)
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)));

    // Append-only journal + audit (same transaction for the demotion path).
    await tx.insert(missionEventsTable).values({
      missionId: args.missionId,
      type: severe ? "mission_drift_demote" : "mission_drift_check",
      message: severe
        ? `Strategy drift ${drift.severity}: automation reduced to approval, risk reduced, promotion paused.`
        : `Strategy drift evaluated: ${drift.severity}.`,
      metadataJson: { severity: drift.severity, score: drift.score, demoted },
    });
    await tx.insert(oneClickAuditTable).values({
      userId: args.userId,
      action: severe ? "MISSION_DRIFT_DEMOTE" : "MISSION_DRIFT_CHECK",
      ip: args.ip ?? null,
      userAgent: args.ua ?? null,
      metadata: JSON.stringify({ missionId: args.missionId, severity: drift.severity, demoted }),
    });

    return { ok: true, drift, demoted, promotionPaused: blocking };
  });
}

function emptyMetrics(): MissionTestMetrics {
  return {
    totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, netProfitLoss: 0,
    maxDrawdownPct: 0, averageRr: 0, expectancyR: 0, profitFactor: 0,
  };
}
