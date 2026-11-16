// Demo bridge wire contract — pure (no I/O), shared by the EA-facing routes
// (routes/mt5DemoBridge.ts) and the reconciler, and tested offline.
//
//   poll    — SENT_TO_MT5_DEMO rows are served oldest-sent first, each with
//             `secondsUntilExpiry` / `expiresAtEpoch`. A row past its TTL is
//             not served (the sweep expires it). v1.32 refuses a command whose
//             TTL elapsed before it got to it (FAILED EXPIRED_BEFORE_EXECUTION).
//   result  — the reporting bridge must be the one the command was sent to.
//             Late successes for a row the sweep expired are recorded and
//             flagged instead of being refused.

import {
  demoResultStatusFitsCommand,
  isLateDemoResultAcceptable,
  isValidDemoCommandTransition,
  type DemoBrokerResultStatus,
  type DemoCommandStatus,
} from "@workspace/domain/safety-contracts/executionMode";

export interface PollableRow {
  commandId: string;
  commandType: string;
  payload: unknown;
  sentAt: Date | null;
  eaVersionAtDispatch: string | null;
}

/** Backward-compat: ensure both `volume` and `lot` are present (mirrored) on
 *  outgoing demo-command payloads so any EA build — old (reads `lot`) or new
 *  (reads `volume` with `lot` fallback) — sees the same numeric size. Does
 *  NOT mutate the stored row; only the JSON we hand the EA. */
export function mirrorVolumeLot(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  const volNum = typeof p.volume === "number" && Number.isFinite(p.volume) ? p.volume : null;
  const lotNum = typeof p.lot === "number" && Number.isFinite(p.lot) ? p.lot : null;
  const v = volNum ?? lotNum;
  if (v == null) return payload;
  return { ...p, volume: v, lot: v };
}

export interface DemoPollCommand {
  commandId: string;
  commandType: string;
  payload: unknown;
  sentAt: string | null;
  eaVersionAtDispatch: string | null;
  /** Whole seconds the EA may still START this command (>= 1). */
  secondsUntilExpiry: number;
  /** UTC epoch seconds after which the command must not be started. */
  expiresAtEpoch: number;
}

/**
 * Oldest-sent first; rows already past `ttlMs` (or never sent) are left out.
 * The EA executes in the order served, so an earlier entry never runs after a
 * later close/modify on the same ticket.
 */
export function buildDemoPollCommands(rows: readonly PollableRow[], now: Date, ttlMs: number): DemoPollCommand[] {
  const nowMs = now.getTime();
  return rows
    .filter((r) => r.sentAt != null)
    .slice()
    .sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime() || a.commandId.localeCompare(b.commandId))
    .map((r) => {
      const expiresMs = r.sentAt!.getTime() + ttlMs;
      return {
        commandId: r.commandId,
        commandType: r.commandType,
        payload: mirrorVolumeLot(r.payload),
        sentAt: r.sentAt!.toISOString(),
        eaVersionAtDispatch: r.eaVersionAtDispatch,
        secondsUntilExpiry: Math.floor((expiresMs - nowMs) / 1000),
        expiresAtEpoch: Math.floor(expiresMs / 1000),
      };
    })
    .filter((c) => c.secondsUntilExpiry >= 1);
}

/** Expiry sweep: rows the sweep may expire — still SENT, no EA report recorded, older than the cutoff. */
export function selectExpirableSentRows<T extends {
  status: string; sentAt: Date | null; terminalAt: Date | null; filledAt: Date | null; brokerTicket: string | null;
}>(rows: readonly T[], cutoff: Date): T[] {
  return rows.filter((r) =>
    r.status === "SENT_TO_MT5_DEMO"
    && r.sentAt != null && new Date(r.sentAt).getTime() < cutoff.getTime()
    && r.terminalAt == null && r.filledAt == null && !r.brokerTicket);
}

export interface ReconcilableRow {
  status: string;
  reason: string | null;
  commandType: string;
  bridgeConnectionId: number;
}

export type ReconcileDecision =
  | { kind: "NOT_FOUND" }
  | { kind: "IDEMPOTENT" }
  | { kind: "APPLY"; expectedStatus: DemoCommandStatus; lateAfterExpiry: boolean }
  | { kind: "REFUSE"; reason: string };

/**
 * What an EA result may do to a row.
 *  - another bridge's report never reaches the row (NOT_FOUND, like another user's);
 *  - a re-delivery of the same status is a no-op;
 *  - the status must fit the command type (PLACED only for a pending entry,
 *    CANCELLED only for a cancel, FILLED for the rest);
 *  - SENT_TO_MT5_DEMO moves on; a row the expiry sweep FAILED still accepts a
 *    broker success (the EA had already executed), flagged late;
 *  - anything else is refused.
 */
export function decideDemoReconcile(
  row: ReconcilableRow | null,
  reported: DemoBrokerResultStatus,
  reportingBridgeConnectionId: number | null,
): ReconcileDecision {
  if (!row) return { kind: "NOT_FOUND" };
  if (reportingBridgeConnectionId != null && row.bridgeConnectionId !== reportingBridgeConnectionId) {
    return { kind: "NOT_FOUND" };
  }
  if (row.status === reported) return { kind: "IDEMPOTENT" };
  if (!demoResultStatusFitsCommand(row.commandType, reported)) {
    return { kind: "REFUSE", reason: `STATUS_NOT_VALID_FOR_COMMAND:${reported}:${row.commandType}` };
  }
  if (row.status === "SENT_TO_MT5_DEMO" && isValidDemoCommandTransition("SENT_TO_MT5_DEMO", reported)) {
    return { kind: "APPLY", expectedStatus: "SENT_TO_MT5_DEMO", lateAfterExpiry: false };
  }
  if (isLateDemoResultAcceptable(row, reported)) {
    return { kind: "APPLY", expectedStatus: "FAILED", lateAfterExpiry: true };
  }
  return { kind: "REFUSE", reason: `WRONG_STATE:${row.status}` };
}

/** Guardian scheduling: only a market entry that FILLED opens a position.
 *  A placed pending order (an order ticket, not a position) never does. */
export function guardianTicketForResult(args: {
  status: string; commandType: string; brokerTicket: string | null; payload: unknown;
}): string | null {
  if (args.status !== "FILLED_DEMO") return null;
  if (args.commandType === "PLACE_MARKET_ORDER") return args.brokerTicket || null;
  if (args.commandType === "CLOSE_POSITION") {
    const p = (args.payload ?? {}) as Record<string, unknown>;
    const t = p["ticket"] ?? p["positionTicket"];
    return t != null && String(t) ? String(t) : null;
  }
  return null;
}
