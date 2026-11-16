// Centralized close-evidence validator for live trades.
//
// SAFETY (inviolable honesty rule — see task #401 and the
// bridge-v2 CLOSE positionTicket memory):
// - A broker "success" retcode (e.g. 10009 = TRADE_RETCODE_DONE) is NOT
//   proof that a position actually closed. The EA can return 10009 while
//   the close did nothing — e.g. POSITION_NOT_FOUND when the close command
//   reached the bridge with positionTicket 0. Treating the retcode as proof
//   risks telling a user their position is closed while it is still live.
// - A close is only "done" when BOTH are true, INDEPENDENT of retcode value:
//     1. the position row's `closedAt` is stamped (the single authoritative
//        closed signal), AND
//     2. the bridge close command reached a terminal CLOSED/FILLED state
//        carrying NO error reason (no rejectionReason, no errorCode, no
//        errorMessage).
// - Never infer a close from the retcode alone, never from `closedAt` alone
//   while the command still carries an error reason, and never from a
//   terminal-success status while the position is still open.
//
// Pure: never throws, never logs, no IO. Mirrors the realizedPnl.ts contract
// so the rule is a single, testable source of truth.

/**
 * The set of bridge close-command statuses that represent a terminal,
 * broker-confirmed success. Compared case-insensitively. `LIVE_FILLED` is
 * the arx_live_commands terminal-success state; `LIVE_CLOSED` / `CLOSED` /
 * `COMPLETED` / `FILLED` cover the mt5_commands and lifecycle vocabularies.
 */
export const CLOSE_TERMINAL_SUCCESS_STATUSES = [
  "LIVE_FILLED",
  "LIVE_CLOSED",
  "CLOSED",
  "COMPLETED",
  "FILLED",
] as const;

export type CloseConfirmationReason =
  | "CONFIRMED"
  | "POSITION_NOT_CLOSED"
  | "COMMAND_NOT_TERMINAL_SUCCESS"
  | "COMMAND_HAS_ERROR_REASON";

export interface CloseEvidence {
  /** arx_live_positions.closedAt — the authoritative closed signal. */
  positionClosedAt: Date | string | null | undefined;
  /** The bridge close command's terminal status. */
  commandStatus: string | null | undefined;
  /** Any structured rejection reason (e.g. POSITION_NOT_FOUND). */
  rejectionReason?: string | null;
  /** Any structured error code. */
  errorCode?: string | null;
  /** Any free-form error message. */
  errorMessage?: string | null;
  /**
   * The raw MT5 return code. DELIBERATELY IGNORED by the verdict — present
   * only so callers can pass the full row without it leaking into the
   * decision. A close is never "done" on the strength of a retcode.
   */
  mt5Retcode?: number | null;
}

export interface CloseConfirmationResult {
  /** True ONLY when the close is proven by real evidence. */
  closeConfirmed: boolean;
  reason: CloseConfirmationReason;
}

function isBlank(s: unknown): boolean {
  return s == null || String(s).trim() === "";
}

/** True when the value is a real, non-blank closed-at signal. */
export function isPositionClosed(closedAt: Date | string | null | undefined): boolean {
  if (closedAt == null) return false;
  if (closedAt instanceof Date) return !Number.isNaN(closedAt.getTime());
  return String(closedAt).trim() !== "";
}

/** True when the command status is a recognized terminal success. */
export function isTerminalSuccessStatus(status: string | null | undefined): boolean {
  if (isBlank(status)) return false;
  const norm = String(status).trim().toUpperCase();
  return (CLOSE_TERMINAL_SUCCESS_STATUSES as readonly string[]).includes(norm);
}

/** True when ANY error-reason field carries content. */
export function hasCloseErrorReason(ev: Pick<CloseEvidence, "rejectionReason" | "errorCode" | "errorMessage">): boolean {
  return !isBlank(ev.rejectionReason) || !isBlank(ev.errorCode) || !isBlank(ev.errorMessage);
}

/**
 * Resolve whether a live close is genuinely "done" from real evidence.
 *
 * The verdict ignores `mt5Retcode` entirely. A close is CONFIRMED only when
 * the position's `closedAt` is stamped AND the command reached a terminal
 * success status AND no error reason is attached.
 */
export function resolveLiveCloseConfirmation(ev: CloseEvidence): CloseConfirmationResult {
  if (!isPositionClosed(ev.positionClosedAt)) {
    return { closeConfirmed: false, reason: "POSITION_NOT_CLOSED" };
  }
  if (!isTerminalSuccessStatus(ev.commandStatus)) {
    return { closeConfirmed: false, reason: "COMMAND_NOT_TERMINAL_SUCCESS" };
  }
  if (hasCloseErrorReason(ev)) {
    return { closeConfirmed: false, reason: "COMMAND_HAS_ERROR_REASON" };
  }
  return { closeConfirmed: true, reason: "CONFIRMED" };
}

/** Convenience boolean wrapper. */
export function isLiveCloseConfirmed(ev: CloseEvidence): boolean {
  return resolveLiveCloseConfirmation(ev).closeConfirmed;
}
