// ── Profit Mission Phase 5 — Trade Draft lifecycle (pure state machine) ─────
//
// PLANNING / APPROVAL ONLY. A TradeDraft is the reviewable, approvable artifact
// the best-debated proposal becomes. APPROVING A DRAFT IN THIS PHASE CREATES AN
// `approved` RECORD AND A JOURNAL ENTRY — IT NEVER PLACES AN ORDER. Execution
// wiring (the `executed` transition) is reserved for later phases (6–9); the
// state is defined here but no Phase 5 code path drives it.
//
// PURE + DETERMINISTIC + IO-FREE: the only clock is the caller-supplied `nowMs`.

/** Draft lifecycle states. `executed` is reserved for later phases. */
export type TradeDraftStatus =
  | "proposed" // freshly minted from a selected proposal, not yet reviewed
  | "waiting_confirmation" // surfaced for the user to approve / reject / watch
  | "approved" // user approved — an approved record ONLY, no order placed
  | "rejected" // user rejected
  | "expired" // entry went stale / window passed before approval
  | "executed" // reserved — handed to the gated pipeline in a later phase
  | "cancelled"; // user (or system) cancelled before execution

/** User actions (`submit`/`expire`/`execute` are system/internal transitions). */
export type TradeDraftAction =
  | "submit" // proposed → waiting_confirmation
  | "approve"
  | "reject"
  | "watch" // keep monitoring; stays reviewable
  | "cancel"
  | "expire"
  | "execute"; // reserved for later phases

const TERMINAL: ReadonlySet<TradeDraftStatus> = new Set<TradeDraftStatus>([
  "rejected",
  "expired",
  "executed",
  "cancelled",
]);

/** Legal transitions: from-status → action → to-status. */
const TRANSITIONS: Record<TradeDraftStatus, Partial<Record<TradeDraftAction, TradeDraftStatus>>> = {
  proposed: {
    submit: "waiting_confirmation",
    watch: "waiting_confirmation",
    approve: "approved",
    reject: "rejected",
    cancel: "cancelled",
    expire: "expired",
  },
  waiting_confirmation: {
    watch: "waiting_confirmation",
    approve: "approved",
    reject: "rejected",
    cancel: "cancelled",
    expire: "expired",
  },
  approved: {
    cancel: "cancelled",
    expire: "expired",
    execute: "executed", // reserved — no Phase 5 path drives this
  },
  rejected: {},
  expired: {},
  executed: {},
  cancelled: {},
};

export type DraftActionResolution =
  | { ok: true; to: TradeDraftStatus }
  | { ok: false; reason: string };

/** Is this a terminal (no further transitions) draft state? */
export function isTerminalDraftStatus(status: TradeDraftStatus): boolean {
  return TERMINAL.has(status);
}

/** Resolve a draft action against the state machine. Pure. */
export function resolveDraftAction(
  from: TradeDraftStatus,
  action: TradeDraftAction,
): DraftActionResolution {
  const to = TRANSITIONS[from]?.[action];
  if (!to) {
    return { ok: false, reason: `Cannot ${action} a draft in state '${from}'.` };
  }
  return { ok: true, to };
}

/**
 * Has the draft passed its expiry? A null expiry never expires (caller decides
 * separately). Pure — uses only the supplied clock.
 */
export function isDraftExpired(
  expiresAtMs: number | null | undefined,
  nowMs: number,
): boolean {
  if (expiresAtMs == null || !Number.isFinite(expiresAtMs)) return false;
  return nowMs >= expiresAtMs;
}

/**
 * Resolve the effective status of a draft at `nowMs`: a non-terminal draft past
 * its expiry reads as `expired` (enforced on every read). Pure.
 */
export function resolveEffectiveDraftStatus(
  status: TradeDraftStatus,
  expiresAtMs: number | null | undefined,
  nowMs: number,
): TradeDraftStatus {
  if (isTerminalDraftStatus(status)) return status;
  if (isDraftExpired(expiresAtMs, nowMs)) return "expired";
  return status;
}
