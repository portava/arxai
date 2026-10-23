// Phase UX9 — Stuck command watchdog.
//
// SAFETY:
//   * Read-only with respect to broker state — only updates OUR rows.
//   * Never resends commands; only marks them as failed/stale.
//   * Never auto-opens/closes trades; only transitions linked action
//     requests to a terminal state so the UI stops claiming "pending".
//   * Idempotent: any command already terminal is skipped.
//   * R2 S1 (audit G1c): a stale mt5_commands row that MIRRORS a Phase B
//     live command is never stamped 'failed' — no broker verification exists,
//     so a fabricated failure could contradict a real position. Those rows
//     go to 'unknown' and the authoritative arx_live_commands row carries the
//     LIVE_UNKNOWN epistemology (its own 60s sweep + reservation hold).

import { db, mt5CommandsTable, tradeActionRequestsTable, notificationsTable } from "@workspace/db";
import { and, eq, inArray, lt, isNull, sql, or } from "drizzle-orm";
import { logger } from "../logger.js";
import { writeActionTimeline } from "../tradeAction/timeline.js";
import type { ActionType } from "../tradeAction/types.js";

const STUCK_TIMEOUT_MS = 5 * 60 * 1000;           // 5 minutes
const SWEEP_INTERVAL_MS = 30 * 1000;              // every 30s
const NON_TERMINAL_STATUSES = ["PENDING", "DELIVERED", "claimed", "sent"] as const;

/**
 * PURE — is this mt5_commands row the transport mirror of a Phase B live
 * command? The mirror payload is stamped {bridged:"LIVE_PHASE_B",
 * liveCommandId} by enqueueBridgedMt5Command; anything else (including an
 * unreadable payload) is NOT treated as a live mirror, so legacy rows keep
 * the existing watchdog behavior unchanged.
 */
export function isLiveBridgeMirrorPayload(payload: unknown): boolean {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return p["bridged"] === "LIVE_PHASE_B" && typeof p["liveCommandId"] === "string";
}

// Watchdog verdict for a live-mirror row: 'unknown', never 'failed'.
// WHY 'unknown' (a status write) instead of leaving the row non-terminal:
//   * the EA claim query serves only status='PENDING' rows, so 'unknown'
//     removes a minutes-old live order from the servable mailbox (defense in
//     depth next to the EA's own stale rejection);
//   * staleAt + a non-scanned status stop the 30s sweep from re-marking it;
//   * POST /mt5/command-result applies the EA result with NO status guard and
//     the live-bridge forward branch runs regardless of mirror status, so a
//     late real broker result still lands and still reaches
//     recordLiveCommandResult (where it is retained as evidence).
export const LIVE_MIRROR_UNKNOWN_STATUS = "unknown" as const;

export interface WatchdogSweepResult {
  scanned: number;
  marked: number;
  /** R2 S1 — live-mirror rows routed to 'unknown' instead of 'failed'. */
  markedUnknown: number;
  errors: number;
}

export async function sweepStuckCommands(now: Date = new Date()): Promise<WatchdogSweepResult> {
  const cutoff = new Date(now.getTime() - STUCK_TIMEOUT_MS);
  let marked = 0;
  let markedUnknown = 0;
  let errors = 0;

  const stuck = await db.select().from(mt5CommandsTable)
    .where(and(
      inArray(mt5CommandsTable.status, NON_TERMINAL_STATUSES as unknown as string[]),
      lt(mt5CommandsTable.createdAt, cutoff),
      isNull(mt5CommandsTable.staleAt),
    ))
    .limit(200);

  for (const command of stuck) {
    try {
      // R2 S1 — the mirror of a LIVE command gets NO fabricated failure: no
      // broker callback means the outcome is UNVERIFIED, and a real position
      // may exist. Stamp 'unknown' + staleAt (skipped next sweep, no longer
      // servable) and stop — no failure timestamp, no fabricated error code,
      // no action-request cascade, no user notification. The authoritative
      // arx_live_commands row raises LIVE_UNKNOWN with its own audit trail.
      if (isLiveBridgeMirrorPayload(command.payload)) {
        await db.update(mt5CommandsTable).set({
          status: LIVE_MIRROR_UNKNOWN_STATUS,
          staleAt: now,
          errorMessage: command.errorMessage ?? "watchdog_no_broker_callback_outcome_unverified",
          brokerMessage: command.brokerMessage ?? "No execution result received within timeout; outcome unverified — awaiting reconciliation.",
          updatedAt: now,
        }).where(and(
          eq(mt5CommandsTable.id, command.id),
          // CAS: a racing EA result write wins — never downgrade it.
          inArray(mt5CommandsTable.status, NON_TERMINAL_STATUSES as unknown as string[]),
        ));
        logger.warn({
          commandId: command.id,
          liveCommandId: (command.payload as Record<string, unknown>)["liveCommandId"],
        }, "watchdog_live_mirror_outcome_unknown");
        markedUnknown += 1;
        continue;
      }

      // Mark the command as failed + stamp staleAt so it's skipped next sweep.
      await db.update(mt5CommandsTable).set({
        status: "failed",
        staleAt: now,
        failedAt: now,
        errorMessage: command.errorMessage ?? "watchdog_marked_stale_command_no_broker_callback",
        brokerMessage: command.brokerMessage ?? "No execution result received within timeout.",
        errorCode: command.errorCode ?? "WATCHDOG_STALE",
        updatedAt: now,
      }).where(eq(mt5CommandsTable.id, command.id));

      // Cascade to any linked trade_action_request that's still mid-flight.
      const [linkedAction] = await db.select().from(tradeActionRequestsTable)
        .where(and(
          eq(tradeActionRequestsTable.tradeCommandId, command.id),
          inArray(tradeActionRequestsTable.status, [
            "confirmed", "guard_checking", "queued", "sent_to_mt5",
          ]),
        )).limit(1);

      if (linkedAction) {
        await db.update(tradeActionRequestsTable).set({
          status: "failed",
          staleAt: now,
          rejectionReason: "Command became stale — no broker callback within timeout.",
          brokerMessage: "Stuck command marked stale by watchdog.",
          errorCode: "WATCHDOG_STALE",
          updatedAt: now,
        }).where(eq(tradeActionRequestsTable.id, linkedAction.id));

        await writeActionTimeline({
          userId: linkedAction.userId,
          tradeKey: linkedAction.tradeKey,
          actionId: linkedAction.id,
          actionType: linkedAction.actionType as ActionType,
          eventType: "action_failed",
          severity: "warning",
          title: "Action marked stale by watchdog",
          message: "The command sat in a non-terminal state past the broker callback window.",
          source: "system",
          context: { commandId: command.id, reason: "WATCHDOG_STALE" },
        });

        // Inline notification — kept short, no secrets, dedupe by command.
        try {
          await db.insert(notificationsTable).values({
            userId: linkedAction.userId,
            notificationId: `tac_stale_${command.id}_${now.getTime()}`,
            type: "TRADE",
            severity: "WARNING",
            title: "Trade action timed out",
            message: "ARX did not receive a broker confirmation in time. Open the Action Center to review.",
            sourceBuild: "UX9",
            sourceEventId: String(linkedAction.id),
            symbol: linkedAction.symbol,
            actionUrl: `/action-center?focus=${linkedAction.id}`,
            actionRequired: true,
            recommendedAction: "Open the Action Center and re-draft if you still want this change.",
            dedupeKey: `tac_stale:${linkedAction.userId}:${command.id}`,
            metadata: { actionId: linkedAction.id, commandId: command.id, kind: "stale" },
          }).onConflictDoNothing();
        } catch (e) {
          logger.warn({ err: e, actionId: linkedAction.id }, "watchdog_notify_failed");
        }
      }
      marked += 1;
    } catch (e) {
      errors += 1;
      logger.warn({ err: e, commandId: command.id }, "watchdog_command_mark_failed");
    }
  }

  return { scanned: stuck.length, marked, markedUnknown, errors };
}

let watchdogTimer: NodeJS.Timeout | null = null;
let running = false;

export function startStuckCommandWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (running) return;
    running = true;
    sweepStuckCommands()
      .then((r) => {
        if (r.marked > 0 || r.markedUnknown > 0 || r.errors > 0) {
          logger.info(r, "stuck_command_watchdog_swept");
        }
      })
      .catch((err) => logger.warn({ err }, "stuck_command_watchdog_sweep_failed"))
      .finally(() => { running = false; });
  }, SWEEP_INTERVAL_MS).unref();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS, timeoutMs: STUCK_TIMEOUT_MS }, "stuck_command_watchdog_started");
}

export function stopStuckCommandWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// Touch unused imports to satisfy noUnusedLocals when sweep grows.
void or;
void sql;
