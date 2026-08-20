// ── Canonical execution-state vocabulary (R2 slice S0) ──────────────────────
// PURE, no IO, no DB, no clock. This slice changes NO behavior: it is a
// read-side mapping layer over the three existing free-text status columns.
// Consumers arrive in R2 S1+ (UNKNOWN semantics, event log, reconciler).
//
// The canonical list is the spec's 14-value `execution_order_state` enum
// (Master Blueprint §6/§7; audit-reports/audit-execution.md §1.1, C7, S0).
//
// Honesty invariants (binding):
//   - The three mapping functions are TOTAL: they never throw.
//   - UNRECOGNIZED input maps to { state: "unknown", lossy: true,
//     note: "UNMAPPED:<value>" } — never a guessed happy state.
//   - Matching is EXACT and case-sensitive: these are free-text columns, so
//     an unexpected casing is an unexpected writer and must surface as
//     unknown, not be silently normalized into a recognized state.
//   - `lossy: true` marks every mapping where the source literal carries
//     semantics the canonical state cannot represent (or where the current
//     writer is known to coerce ambiguity into that literal, per the audit).
//
// Mapping table — arx_live_commands.status (lib/db/src/schema/arxLiveExecution.ts:20-37):
//   LIVE_DRAFT                  → created                 lossless
//   LIVE_CONFIRMATION_REQUIRED  → awaiting_confirmation   lossless
//   LIVE_APPROVED               → authorized              lossless
//   SENT_TO_MT5_LIVE            → submitting              LOSSY (EA pickup lives in pickedByEaAt, not the status — "acknowledged" is unrepresentable from this column alone; audit G2)
//   LIVE_FILLED                 → filled                  lossless
//   LIVE_REJECTED               → rejected                lossless
//   LIVE_FAILED                 → rejected                LOSSY (conflates broker rejection with transport failure; success-without-ticket is coerced here today — audit G1b; S1 moves that to UNKNOWN)
//   LIVE_BLOCKED                → risk_rejected           LOSSY (covers every pre-dispatch gate refusal — integrity, cohort, market backstop — not only risk gates)
//   LIVE_CANCELLED              → cancelled               lossless
//   LIVE_CLOSED                 → filled                  LOSSY (position close is a position-level fact; the originating order did fill)
//   LIVE_EXPIRED                → expired                 LOSSY (conflates the server no-pickup TTL sweep with the EA's own stale refusal; since R2 S1 picked-up rows go to LIVE_UNKNOWN instead)
//   LIVE_UNKNOWN                → unknown                 lossless (R2 S1: picked-up-then-silent or success-without-ticket; reservation held)
//   LIVE_RECONCILIATION_REQUIRED→ reconciliation_required  lossless (R2 S1: unresolved UNKNOWN awaiting broker-truth reconciliation)
//
// Mapping table — mt5_demo_commands.status (lib/domain/src/safety-contracts/executionMode.ts DemoCommandStatus):
//   DRAFT                       → created                 lossless
//   USER_CONFIRMATION_REQUIRED  → awaiting_confirmation   lossless
//   DEMO_APPROVED               → authorized              lossless
//   SENT_TO_MT5_DEMO            → submitting              LOSSY (no acknowledged stage; EA pickup is not represented in the status)
//   FILLED_DEMO                 → filled                  lossless
//   REJECTED                    → rejected                lossless
//   BLOCKED                     → risk_rejected           LOSSY (covers every gate refusal, not only risk gates)
//   FAILED                      → rejected                LOSSY (conflates broker failure with the 2-minute no-pickup sweep — audit G1d)
//   DEMO_PARTIALLY_FILLED       → partially_filled        lossless (R2 S5 forward-declared: recognized by the read layer ahead of its adoption in the DemoCommandStatus writer vocabulary — see MT5_DEMO_STATUS_MAP note)
//
// Mapping table — mt5_commands.status, free text (lib/db/src/schema/mt5Commands.ts:21
// schema comment + observed writers: routes/mt5.ts, executionReconciler.ts,
// stuckCommandWatchdog.ts, meMt5Commands.ts, queueMt5CommandWithGate):
//   PENDING                     → authorized              LOSSY (queued in the EA mailbox; pickup has not begun)
//   DELIVERED                   → submitting              LOSSY (EA transport pickup, not a broker acknowledgement)
//   claimed                     → submitting              LOSSY (legacy variant of DELIVERED)
//   sent                        → submitting              LOSSY (EA reported non-terminal "pending"; executionReconciler mapCommandStatus)
//   completed                   → filled                  LOSSY (rows written before R2 S5 may conceal a partial fill: executionReconciler used to map partial→completed — audit G2; S5 stopped the coercion, historical rows remain)
//   executed                    → filled                  LOSSY (legacy variant of completed; same historical partial-fill concealment)
//   partial                     → partially_filled        lossless (EA-posted status stored verbatim by /mt5/command-result)
//   failed                      → rejected                LOSSY (conflates broker rejection, transport failure, and the 5-minute watchdog presumption — audit G1c)
//   rejected                    → rejected                lossless
//   expired                     → expired                 LOSSY (presumes non-execution without broker verification)
//   cancelled                   → cancelled               lossless
//   BLOCKED                     → risk_rejected           LOSSY (paper-only lock forces every gated enqueue to BLOCKED — queueMt5CommandWithGate)
//   blocked_demo_mode           → risk_rejected           LOSSY (legacy demo-mode block)

// Spec §7 `execution_order_state` enum, verbatim, in spec order.
export const CANONICAL_EXECUTION_STATES = [
  "created",
  "risk_rejected",
  "awaiting_confirmation",
  "authorized",
  "submitting",
  "acknowledged",
  "partially_filled",
  "filled",
  "cancel_pending",
  "cancelled",
  "rejected",
  "expired",
  "unknown",
  "reconciliation_required",
] as const;

export type CanonicalExecutionState = (typeof CANONICAL_EXECUTION_STATES)[number];

/** Result of mapping one source-vocabulary literal into the canonical enum.
 *  `lossy` marks semantics the canonical state cannot fully represent;
 *  `note` states what was lost, or `UNMAPPED:<value>` for unrecognized input. */
export interface CanonicalStateMapping {
  state: CanonicalExecutionState;
  lossy: boolean;
  note?: string;
}

type MappingTable = Readonly<Record<string, CanonicalStateMapping>>;

// Total lookup: unrecognized input degrades to unknown with the raw value
// preserved in the note. Never throws, never guesses a happy state.
function mapWith(table: MappingTable, s: string): CanonicalStateMapping {
  const hit = Object.prototype.hasOwnProperty.call(table, s) ? table[s] : undefined;
  if (hit) return { ...hit };
  return { state: "unknown", lossy: true, note: `UNMAPPED:${s}` };
}

// ── arx_live_commands.status ────────────────────────────────────────────────
export const ARX_LIVE_STATUS_MAP: MappingTable = Object.freeze({
  LIVE_DRAFT: { state: "created", lossy: false },
  LIVE_CONFIRMATION_REQUIRED: { state: "awaiting_confirmation", lossy: false },
  LIVE_APPROVED: { state: "authorized", lossy: false },
  SENT_TO_MT5_LIVE: {
    state: "submitting",
    lossy: true,
    note: "EA pickup lives in pickedByEaAt, not the status; acknowledged is unrepresentable from this column alone",
  },
  LIVE_FILLED: { state: "filled", lossy: false },
  LIVE_REJECTED: { state: "rejected", lossy: false },
  LIVE_FAILED: {
    state: "rejected",
    lossy: true,
    note: "conflates broker rejection with transport failure; success-without-ticket is coerced here today (audit G1b)",
  },
  LIVE_BLOCKED: {
    state: "risk_rejected",
    lossy: true,
    note: "covers every pre-dispatch gate refusal, not only risk gates",
  },
  LIVE_CANCELLED: { state: "cancelled", lossy: false },
  LIVE_CLOSED: {
    state: "filled",
    lossy: true,
    note: "position close is a position-level fact; the originating order did fill",
  },
  LIVE_EXPIRED: {
    state: "expired",
    lossy: true,
    note: "conflates the server no-pickup TTL sweep with the EA's own STALE_COMMAND_REJECTED refusal (since R2 S1, picked-up rows go to LIVE_UNKNOWN instead)",
  },
  // R2 S1 — epistemic states land losslessly on their canonical namesakes.
  LIVE_UNKNOWN: { state: "unknown", lossy: false },
  LIVE_RECONCILIATION_REQUIRED: { state: "reconciliation_required", lossy: false },
} satisfies Record<string, CanonicalStateMapping>);

export function fromArxLiveStatus(s: string): CanonicalStateMapping {
  return mapWith(ARX_LIVE_STATUS_MAP, s);
}

// ── mt5_demo_commands.status ────────────────────────────────────────────────
export const MT5_DEMO_STATUS_MAP: MappingTable = Object.freeze({
  DRAFT: { state: "created", lossy: false },
  USER_CONFIRMATION_REQUIRED: { state: "awaiting_confirmation", lossy: false },
  DEMO_APPROVED: { state: "authorized", lossy: false },
  SENT_TO_MT5_DEMO: {
    state: "submitting",
    lossy: true,
    note: "no acknowledged stage; EA pickup is not represented in the status",
  },
  FILLED_DEMO: { state: "filled", lossy: false },
  REJECTED: { state: "rejected", lossy: false },
  BLOCKED: {
    state: "risk_rejected",
    lossy: true,
    note: "covers every gate refusal, not only risk gates",
  },
  FAILED: {
    state: "rejected",
    lossy: true,
    note: "conflates broker failure with the 2-minute no-pickup sweep (audit G1d)",
  },
  // R2 S5 (audit G2) — FORWARD-DECLARED partial-fill literal. The demo path's
  // status vocabulary has no partial state today; this mapping recognizes the
  // literal ahead of its adoption in executionMode.ts DemoCommandStatus /
  // DEMO_COMMAND_TRANSITIONS (out of this slice's scope — reported to the
  // coordinator) so the read layer stays total on the day the writer lands.
  // mt5_demo_commands.status is a free-text column, so no migration is
  // needed; until the writer adopts it this entry simply never matches.
  DEMO_PARTIALLY_FILLED: { state: "partially_filled", lossy: false },
} satisfies Record<string, CanonicalStateMapping>);

export function fromMt5DemoStatus(s: string): CanonicalStateMapping {
  return mapWith(MT5_DEMO_STATUS_MAP, s);
}

// ── mt5_commands.status (legacy free-text mailbox) ──────────────────────────
export const MT5_COMMAND_STATUS_MAP: MappingTable = Object.freeze({
  PENDING: {
    state: "authorized",
    lossy: true,
    note: "queued in the EA mailbox; pickup has not begun",
  },
  DELIVERED: {
    state: "submitting",
    lossy: true,
    note: "EA transport pickup, not a broker acknowledgement",
  },
  claimed: {
    state: "submitting",
    lossy: true,
    note: "legacy variant of DELIVERED; EA transport pickup, not a broker acknowledgement",
  },
  sent: {
    state: "submitting",
    lossy: true,
    note: "EA reported non-terminal 'pending' (executionReconciler mapCommandStatus)",
  },
  completed: {
    state: "filled",
    lossy: true,
    note: "rows written before R2 S5 may conceal a partial fill: executionReconciler used to map partial to completed (audit G2)",
  },
  executed: {
    state: "filled",
    lossy: true,
    note: "legacy variant of completed; same historical partial-fill concealment (audit G2)",
  },
  partial: { state: "partially_filled", lossy: false },
  failed: {
    state: "rejected",
    lossy: true,
    note: "conflates broker rejection, transport failure, and the 5-minute watchdog presumption (audit G1c)",
  },
  rejected: { state: "rejected", lossy: false },
  expired: {
    state: "expired",
    lossy: true,
    note: "presumes non-execution without broker verification",
  },
  cancelled: { state: "cancelled", lossy: false },
  BLOCKED: {
    state: "risk_rejected",
    lossy: true,
    note: "paper-only lock forces every gated enqueue to BLOCKED (queueMt5CommandWithGate)",
  },
  blocked_demo_mode: {
    state: "risk_rejected",
    lossy: true,
    note: "legacy demo-mode block",
  },
} satisfies Record<string, CanonicalStateMapping>);

export function fromMt5CommandStatus(s: string): CanonicalStateMapping {
  return mapWith(MT5_COMMAND_STATUS_MAP, s);
}
