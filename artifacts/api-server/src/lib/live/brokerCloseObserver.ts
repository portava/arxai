// Broker-side close OBSERVER — records outcomes the broker already produced.
//
// THE DEFECT THIS CLOSES
//   `recordMissionTradeClose` had exactly ONE runtime entrance: an ARX-issued
//   CLOSE_LIVE_POSITION command reaching LIVE_FILLED. Take-profit, trailing and
//   protective exits all route through ARX and were recorded. A position closed
//   by its own STOP-LOSS at the broker never comes back through that path, so
//   its loss was never recorded. Wins in, stop-losses out — every realised
//   figure downstream (mission "Realised profit", "Peak realised", the
//   target-locked badge, compounding) was biased UPWARD.
//
// OBSERVATION, NOT ACTION
//   Everything here is a read of a close the BROKER already made. It sends no
//   broker command, opens nothing, modifies no stop, and (in the absence path)
//   writes no position state. That is why it is NOT behind
//   BROKER_ABSENCE_AUTO_RECONCILE_ENABLED: that flag gates ARX *acting* on the
//   broker's book. Recording history is not acting. It does, however, use the
//   IDENTICAL evidence bar as the action path (N consecutive reliable COMPLETE
//   sweeps + a minimum first-absence age), so a flapping or partial snapshot can
//   never manufacture a close.
//
// NEVER FABRICATES
//   A P/L is recorded only when the BROKER reported one. When the broker tells
//   us a position is gone but gives us no numbers, the recorded outcome is
//   closed + pnl null + a typed UNRECONCILED reason. Nothing is inferred from
//   the stop-loss level, the take-profit level, or the last floating P/L.

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  mt5ConnectionTable,
} from "@workspace/db";
import { logger } from "../logger.js";
import { isSnapshotReliable } from "./positionFreshness.js";
import {
  brokerCloseObservationPolicy,
  type BrokerAbsenceReconcilePolicy,
} from "./brokerAbsencePolicy.js";
import { findBrokerAbsentGhostPositionIds } from "./brokerAbsenceReconcile.js";
import {
  planBrokerCloseRecordings,
  type BrokerCloseReport,
} from "./brokerCloseOutcome.js";

// Non-terminal ARX CLOSE statuses — a position with one of these in flight is
// about to be closed BY ARX, and the ARX close-fill path will record it. The
// observer must not race that.
const PENDING_CLOSE_STATUSES = [
  "LIVE_DRAFT",
  "LIVE_CONFIRMATION_REQUIRED",
  "LIVE_APPROVED",
  "SENT_TO_MT5_LIVE",
] as const;

export interface ObserveBrokerSideClosesResult {
  scope: { userId: number; bridgeConnectionId: number | null };
  snapshotReliable: boolean;
  plannedCount: number;
  recordedCount: number;
  reconciledCount: number;
  unreconciledCount: number;
  /** Tickets that were planned but were not mission trades (the common case). */
  notMissionTradeCount: number;
}

/**
 * Observe this user's broker-side closes and record their mission-trade
 * outcomes. Per-user / per-bridge isolated; every read is scoped by userId.
 *
 * Runs regardless of the auto-reconcile ACTION flag (see the policy module for
 * why). It writes only through the shared mission recorder and never touches
 * `arx_live_positions` state on the absence path.
 */
export async function observeBrokerSideCloses(args: {
  userId: number;
  bridgeConnectionId?: number | null;
  /** Explicit broker close reports (from the EA close-report ingest). */
  reports?: BrokerCloseReport[];
  policy?: BrokerAbsenceReconcilePolicy;
  now?: Date;
}): Promise<ObserveBrokerSideClosesResult> {
  const policy = args.policy ?? brokerCloseObservationPolicy;
  const now = args.now ?? new Date();
  const bridgeConnectionId = args.bridgeConnectionId ?? null;

  // Snapshot reliability — identical rule to the action path. Without a recent
  // COMPLETE sweep marker we have no current broker truth, so absence proves
  // nothing and every absence candidate is blocked by the evaluator.
  const connRows = await db
    .select({
      id: mt5ConnectionTable.id,
      lastPositionsSnapshotAt: mt5ConnectionTable.lastPositionsSnapshotAt,
    })
    .from(mt5ConnectionTable)
    .where(
      bridgeConnectionId != null
        ? and(eq(mt5ConnectionTable.userId, args.userId), eq(mt5ConnectionTable.id, bridgeConnectionId))
        : eq(mt5ConnectionTable.userId, args.userId),
    );
  let markerMs: number | null = null;
  for (const c of connRows) {
    const t = c.lastPositionsSnapshotAt ? c.lastPositionsSnapshotAt.getTime() : null;
    if (t != null && (markerMs == null || t > markerMs)) markerMs = t;
  }
  const snapshotReliable = isSnapshotReliable(markerMs, policy.snapshotReliabilityWindowMs, now.getTime());

  const openRows = await db
    .select()
    .from(arxLivePositionsTable)
    .where(
      and(
        eq(arxLivePositionsTable.userId, args.userId),
        isNull(arxLivePositionsTable.closedAt),
        isNull(arxLivePositionsTable.reconcileState),
        ...(bridgeConnectionId != null
          ? [eq(arxLivePositionsTable.bridgeConnectionId, bridgeConnectionId)]
          : []),
      ),
    );

  const pendingCloseTickets = new Set<string>();
  if (openRows.length > 0) {
    const pending = await db
      .select({ brokerTicket: arxLiveCommandsTable.brokerTicket })
      .from(arxLiveCommandsTable)
      .where(
        and(
          eq(arxLiveCommandsTable.userId, args.userId),
          eq(arxLiveCommandsTable.commandType, "CLOSE_LIVE_POSITION"),
          inArray(arxLiveCommandsTable.status, [...PENDING_CLOSE_STATUSES]),
        ),
      );
    for (const p of pending) if (p.brokerTicket) pendingCloseTickets.add(p.brokerTicket);
  }

  const absenceCandidates = findBrokerAbsentGhostPositionIds(
    openRows.map((r) => ({
      positionId: r.id,
      userId: r.userId,
      bridgeConnectionId: r.bridgeConnectionId,
      brokerTicket: r.brokerTicket,
      symbol: r.symbol,
      closedAt: r.closedAt,
      reconcileState: r.reconcileState,
      brokerAbsentSnapshotCount: r.brokerAbsentSnapshotCount ?? 0,
      firstBrokerAbsentAt: r.firstBrokerAbsentAt,
      lastBrokerAbsentAt: r.lastBrokerAbsentAt,
      lastReliableSnapshotAt: r.lastReliableSnapshotAt,
      sourceCommandId: r.sourceCommandId,
    })),
    {
      now: now.getTime(),
      policy,
      scope: { userId: args.userId, bridgeConnectionId },
      pendingCloseTickets,
      snapshotReliable,
      snapshotComplete: true, // EA pushes the COMPLETE open-position list per sweep
    },
  );

  const plan = planBrokerCloseRecordings({
    reports: args.reports,
    absenceCandidates,
  });

  let recordedCount = 0;
  let reconciledCount = 0;
  let unreconciledCount = 0;
  let notMissionTradeCount = 0;

  if (plan.length > 0) {
    // Imported lazily to keep this module free of the mission service at load
    // time (mirrors the live pipeline's own lazy import of the recorder).
    const { recordMissionTradeCloseByBrokerTicket } = await import("../missionExitManager.js");
    for (const p of plan) {
      try {
        const res = await recordMissionTradeCloseByBrokerTicket({
          userId: args.userId,
          brokerTicket: p.brokerTicket,
          realisedPnl: p.realisedPnl,
          exitReason: p.exitReason,
          outcomeSource: p.outcomeSource,
          outcomeStatus: p.outcomeStatus,
          unreconciledReason: p.unreconciledReason,
          brokerClosePrice: p.brokerClosePrice,
          nowMs: now.getTime(),
        });
        if (res.ok) {
          recordedCount += 1;
          if (p.outcomeStatus === "RECONCILED") reconciledCount += 1;
          else unreconciledCount += 1;
        } else {
          notMissionTradeCount += 1;
        }
      } catch (err) {
        logger.error(
          {
            event: "BROKER_SIDE_CLOSE_OBSERVE_FAILED",
            userId: args.userId,
            brokerTicket: p.brokerTicket,
            error: err instanceof Error ? err.message : String(err),
          },
          "broker-side close observation failed to record (advisory) — non-fatal",
        );
      }
    }
  }

  return {
    scope: { userId: args.userId, bridgeConnectionId },
    snapshotReliable,
    plannedCount: plan.length,
    recordedCount,
    reconciledCount,
    unreconciledCount,
    notMissionTradeCount,
  };
}
