// Self-Trade AI — operator report for one autonomous cycle (response body of
// POST /self-trade-ai/run-autonomous-cycle).
//
// Pure shaping of RunAutonomousCycleResult; no IO. Existing fields are passed
// through unchanged. Added for the operator surface:
//   - protective.commandRecordedOrUnknown  holds where a command was recorded
//                               or the outcome is not proven (OUTCOME_UNCERTAIN,
//                               REFUSED_WITH_COMMAND, DRAIN_FAILED), so the
//                               operator does not read them as "nothing sent"
//   - protective.held      considered − acted − commandRecordedOrUnknown
//   - protective.waitBudgetMs   the per-cycle wait for a fresh EA sweep
//   - managementHeldDetails     reason, count, kind and standalone plain-English
//                               text per hold reason (no per-position detail,
//                               no account data; that stays in the audit log)
//
// "acted" means handed to the EA through the gated pipeline. It is never a
// broker-confirmed close or stop move; those arrive via reconciliation.

import { summarizeManagementHold } from "@workspace/domain/self-trade";
import type { RunAutonomousCycleResult } from "./autonomousCycle.js";
import { PROTECTIVE_EVIDENCE_WAIT_MS } from "./protectiveActionPath.js";

export type ManagementHoldKind = "PROTECTIVE" | "OBSERVATION" | "PAUSE" | "OTHER";

export interface ManagementHoldDetail {
  reason: string;
  count: number;
  kind: ManagementHoldKind;
  text: string;
}

export interface RunCycleResponse extends Omit<RunAutonomousCycleResult, "protective"> {
  ok: true;
  protective: RunAutonomousCycleResult["protective"] & {
    held: number;
    commandRecordedOrUnknown: number;
    waitBudgetMs: number;
  };
  managementHeldDetails: ManagementHoldDetail[];
}

/** Protective outcomes where a command may exist: not plain "held, nothing sent". */
export const PROTECTIVE_COMMAND_RECORDED_OR_UNKNOWN: readonly string[] = [
  "PROTECTIVE_HOLD_OUTCOME_UNCERTAIN",
  "PROTECTIVE_HOLD_REFUSED_WITH_COMMAND",
  "PROTECTIVE_DRAIN_FAILED",
];

const KIND_ORDER: Record<ManagementHoldKind, number> = { PROTECTIVE: 0, PAUSE: 1, OBSERVATION: 2, OTHER: 3 };

function holdKind(reason: string): ManagementHoldKind {
  if (reason.startsWith("PROTECTIVE_")) return "PROTECTIVE";
  if (reason.startsWith("MANAGEMENT_OBSERVATION_")) return "OBSERVATION";
  if (reason === "MANAGEMENT_PAUSED_AACI_REVIEW") return "PAUSE";
  return "OTHER";
}

export function buildRunCycleResponse(result: RunAutonomousCycleResult): RunCycleResponse {
  const waitBudgetSec = PROTECTIVE_EVIDENCE_WAIT_MS / 1000;
  const managementHeldDetails = Object.entries(result.managementHeld)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([reason, count]) => ({
      reason,
      count,
      kind: holdKind(reason),
      text: summarizeManagementHold(reason, { waitBudgetSec }),
    }))
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.count - a.count || a.reason.localeCompare(b.reason),
    );
  const p = result.protective;
  const recordedOrUnknown = Math.min(
    Math.max(0, p.considered - p.acted),
    PROTECTIVE_COMMAND_RECORDED_OR_UNKNOWN.reduce((n, r) => n + (result.managementHeld[r] ?? 0), 0),
  );
  return {
    ok: true,
    ...result,
    protective: {
      ...p,
      held: Math.max(0, p.considered - p.acted - recordedOrUnknown),
      commandRecordedOrUnknown: recordedOrUnknown,
      waitBudgetMs: PROTECTIVE_EVIDENCE_WAIT_MS,
    },
    managementHeldDetails,
  };
}

export type SingleFlightResult<T> = { ran: true; value: T } | { ran: false; startedAt: number };

/**
 * One autonomous cycle at a time per API process. A second POST while one is
 * running (another tab, a re-click after a gateway timeout) is refused rather
 * than overlapped. Per process only: it does not coordinate several API
 * instances; the protective claim race remains the cross-process backstop.
 *
 * No ceiling: a cycle whose await never settles (for example a pg pool
 * checkout with no connection timeout, or a hung guardian call) keeps the slot
 * until the process restarts, and every later POST gets 409. The slot is never
 * released early, because the first cycle may still be dispatching; instead
 * describeCycleConflict says so past CYCLE_STUCK_AFTER_MS and the route logs
 * the refusal at error level.
 */
export function createCycleSingleFlight(now: () => number = Date.now) {
  let startedAt: number | null = null;
  return {
    inFlightSince: (): number | null => startedAt,
    async run<T>(fn: () => Promise<T>): Promise<SingleFlightResult<T>> {
      if (startedAt !== null) return { ran: false, startedAt };
      startedAt = now();
      try {
        return { ran: true, value: await fn() };
      } finally {
        startedAt = null;
      }
    },
  };
}

/** Past this, a still-running cycle is reported as probably stuck. */
export const CYCLE_STUCK_AFTER_MS = 10 * 60_000;

export interface CycleConflict {
  runningForSec: number;
  stuck: boolean;
  message: string;
}

/** Operator text for 409 CYCLE_ALREADY_RUNNING. */
export function describeCycleConflict(startedAt: number, now: number): CycleConflict {
  const runningMs = Math.max(0, now - startedAt);
  const runningForSec = Math.round(runningMs / 1000);
  const stuck = runningMs > CYCLE_STUCK_AFTER_MS;
  const base = `An autonomous cycle started ${runningForSec} s ago is still running on the server, so this run was not started.`;
  const message = stuck
    ? `${base} It has been running unusually long (over ${Math.round(CYCLE_STUCK_AFTER_MS / 60_000)} min) and may be stuck; until it finishes or the API server is restarted, every run is refused. Check the server logs, the execution feed and the audit log; a server restart may be required.`
    : `${base} Its result appears in the execution feed and audit log; try again once it finishes.`;
  return { runningForSec, stuck, message };
}
