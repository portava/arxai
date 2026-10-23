// ── Profit Mission Phase 2 — transactional journaling service ───────────────
//
// SAFETY / SCOPE:
//   - The journal is the accountability backbone. Every lifecycle state change
//     and every settings override is written to the append-only mission_events
//     table INSIDE THE SAME db.transaction as the mutation, so a state change can
//     never land without its journal row (fail-closed: an event-insert throw
//     rolls the whole transaction back). A progress mission_snapshots row is
//     captured in the same transaction.
//   - Strictly per-user: the mission row is loaded `FOR UPDATE` scoped by
//     (id, userId); a mission that does not belong to the caller is reported as
//     not_found and nothing is written.
//   - The mission state machine (@workspace/domain) is the SINGLE SOURCE OF
//     TRUTH for legality; illegal transitions are rejected and nothing is
//     written.
//   - OBSERVATION ONLY. Nothing here touches a trade, the EA, a broker, or any
//     execution gate. PLANNING + DISPLAY ONLY.
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionEventsTable,
  missionSnapshotsTable,
} from "@workspace/db";
import {
  evaluateTransition,
  isTerminalStatus,
  isMissionStatus,
  type MissionStatus,
  type MissionEventType,
} from "@workspace/domain/profit-mission";

type MissionRow = typeof profitMissionsTable.$inferSelect;
type MissionEventRow = typeof missionEventsTable.$inferSelect;

export interface TransitionRequest {
  userId: number;
  missionId: number;
  toStatus: MissionStatus;
  eventType: MissionEventType;
  /** Human-readable journal line; banned-vocabulary-safe copy. */
  message: string;
  /** Optional structured metadata for the event (no secrets). */
  metadata?: Record<string, unknown> | null;
  /** Progress snapshot payload captured at this transition. */
  snapshot?: Record<string, unknown> | null;
}

export interface SettingsUpdateRequest {
  userId: number;
  missionId: number;
  settings: Record<string, unknown>;
  message: string;
  snapshot?: Record<string, unknown> | null;
}

export type JournalFailure =
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "illegal_transition"; from: MissionStatus; to: MissionStatus; reason: string }
  | { ok: false; kind: "terminal"; from: MissionStatus }
  | { ok: false; kind: "unknown_state"; from: string };

export type TransitionResult = { ok: true; row: MissionRow } | JournalFailure;

/**
 * Apply a validated mission status transition + write its journal event and a
 * progress snapshot, all in one transaction. Fail-closed at every step.
 */
export async function applyMissionTransition(req: TransitionRequest): Promise<TransitionResult> {
  return db.transaction(async (tx): Promise<TransitionResult> => {
    const rows = await tx
      .select()
      .from(profitMissionsTable)
      .where(and(eq(profitMissionsTable.id, req.missionId), eq(profitMissionsTable.userId, req.userId)))
      .for("update")
      .limit(1);
    const current = rows[0];
    if (!current) return { ok: false, kind: "not_found" };

    if (!isMissionStatus(current.status)) {
      return { ok: false, kind: "unknown_state", from: String(current.status) };
    }
    const from = current.status;
    const verdict = evaluateTransition(from, req.toStatus);
    if (!verdict.ok) {
      return {
        ok: false,
        kind: "illegal_transition",
        from,
        to: req.toStatus,
        reason: verdict.error ?? "ILLEGAL_TRANSITION",
      };
    }

    const now = new Date();
    const terminal = isTerminalStatus(req.toStatus);
    const updated = await tx
      .update(profitMissionsTable)
      .set({
        status: req.toStatus,
        updatedAt: now,
        ...(terminal ? { completedAt: now } : {}),
      })
      .where(and(eq(profitMissionsTable.id, req.missionId), eq(profitMissionsTable.userId, req.userId)))
      .returning();

    // Append-only journal row — same transaction, so a throw rolls back the move.
    await tx.insert(missionEventsTable).values({
      missionId: req.missionId,
      type: req.eventType,
      message: req.message,
      metadataJson: { from, to: req.toStatus, ...(req.metadata ?? {}) },
    });

    await tx.insert(missionSnapshotsTable).values({
      missionId: req.missionId,
      snapshotJson: req.snapshot ?? {},
    });

    return { ok: true, row: updated[0]! };
  });
}

/**
 * Update a mission's free-form settings and record an override event + snapshot
 * in the same transaction. Rejected (without writing) if the mission is terminal.
 */
export async function applyMissionSettingsUpdate(
  req: SettingsUpdateRequest,
): Promise<TransitionResult> {
  return db.transaction(async (tx): Promise<TransitionResult> => {
    const rows = await tx
      .select()
      .from(profitMissionsTable)
      .where(and(eq(profitMissionsTable.id, req.missionId), eq(profitMissionsTable.userId, req.userId)))
      .for("update")
      .limit(1);
    const current = rows[0];
    if (!current) return { ok: false, kind: "not_found" };

    if (!isMissionStatus(current.status)) {
      return { ok: false, kind: "unknown_state", from: String(current.status) };
    }
    const from = current.status;
    if (isTerminalStatus(from)) return { ok: false, kind: "terminal", from };

    const now = new Date();
    const updated = await tx
      .update(profitMissionsTable)
      .set({ settingsJson: req.settings, updatedAt: now })
      .where(and(eq(profitMissionsTable.id, req.missionId), eq(profitMissionsTable.userId, req.userId)))
      .returning();

    await tx.insert(missionEventsTable).values({
      missionId: req.missionId,
      type: "settings_updated",
      message: req.message,
      metadataJson: { settings: req.settings },
    });

    await tx.insert(missionSnapshotsTable).values({
      missionId: req.missionId,
      snapshotJson: req.snapshot ?? {},
    });

    return { ok: true, row: updated[0]! };
  });
}

export interface MissionEventDto {
  id: number;
  missionId: number;
  type: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

function projectEvent(row: MissionEventRow): MissionEventDto {
  return {
    id: row.id,
    missionId: row.missionId,
    type: row.type,
    message: row.message ?? null,
    metadata: (row.metadataJson as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * List a mission's journal events, newest first, paginated. The CALLER must have
 * already verified the mission belongs to the requesting user (ownMission gate);
 * events carry no secret material and are projected through an allowlist DTO.
 */
export async function listMissionEvents(
  missionId: number,
  opts: { limit: number; offset: number },
): Promise<MissionEventDto[]> {
  const rows = await db
    .select()
    .from(missionEventsTable)
    .where(eq(missionEventsTable.missionId, missionId))
    .orderBy(desc(missionEventsTable.createdAt), desc(missionEventsTable.id))
    .limit(opts.limit)
    .offset(opts.offset);
  return rows.map(projectEvent);
}
