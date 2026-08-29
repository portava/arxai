// Opportunity Spine (#17) — the OWNING per-setup lifecycle state machine.
//
// Prior art: lib/domain/src/signal-intelligence/lifecycleEngine.ts classifies
// where a setup is on EVERY READ (stateless, per-read). This module is the
// missing OWNING half: one persisted opportunity OBJECT per setup identity,
// advanced only through this pure transition function, with terminal
// EXECUTED / REJECTED / MISSED / EXPIRED / INVALIDATED states and an
// append-only event log (`opportunity_events`) that fully reconstructs the
// object (see replayOpportunity below — reconstruction is tested).
//
// HONESTY / SAFETY:
//  - PURE + deterministic. No IO, no clock reads — callers inject time.
//  - Terminal states ABSORB: no event may revive a terminal opportunity
//    (explicit no-revival-of-expired-evidence enforcement). A fresh sighting
//    of the same setup identity after termination is a NEW object.
//  - MISSED accounting lives on the SAME object: an opportunity whose entry
//    window was seen open but that terminates without a fill is MISSED, never
//    a bland EXPIRED — the miss is first-class, not a replay-lab afterthought.
//  - This module never places, blocks, or modifies an order. It OBSERVES the
//    existing decision/execution seams; the 18/23-gate live pipeline, kill
//    switches and governors are untouched.

// ── States ───────────────────────────────────────────────────────────────────

export const OPPORTUNITY_ACTIVE_STATES = [
  "WATCHING",
  "SETUP_FORMING",
  "ENTRY_APPROACHING",
  "ENTRY_WINDOW_OPEN",
  "LATE",
] as const;
export type OpportunityActiveState = (typeof OPPORTUNITY_ACTIVE_STATES)[number];

export const OPPORTUNITY_TERMINAL_STATES = [
  "EXECUTED", // a real broker fill was confirmed for this opportunity
  "REJECTED", // the pipeline/gates/broker definitively rejected the attempt
  "MISSED", // entry window was open, no fill ever happened, setup died
  "EXPIRED", // setup aged out before an entry window ever opened
  "INVALIDATED", // price broke the invalidation level before a window opened
] as const;
export type OpportunityTerminalState = (typeof OPPORTUNITY_TERMINAL_STATES)[number];

export type OpportunityState = OpportunityActiveState | OpportunityTerminalState;

export function isTerminalOpportunityState(s: OpportunityState): s is OpportunityTerminalState {
  return (OPPORTUNITY_TERMINAL_STATES as readonly string[]).includes(s);
}

// ── Events (the unified per-opportunity journal vocabulary) ──────────────────

export const OPPORTUNITY_EVENT_TYPES = [
  "OPENED", // object created on first sighting
  "STAGE_OBSERVED", // an active lifecycle stage was observed (change-only journaled)
  "DECISION_RECORDED", // a supervisor-resolved decision attached to this setup
  "DUPLICATE_MERGED", // #18: another agent's duplicate thesis merged into this object
  "CONFLICT_RESOLVED", // #19: a conflict verdict touching this setup
  "EXECUTION_DISPATCHED", // a gated execution attempt left for the bridge (NOT a fill)
  "EXECUTION_FILLED", // real broker fill confirmed → EXECUTED
  "EXECUTION_REJECTED", // pipeline/EA/broker rejected the entry → REJECTED
  "EXECUTION_BLOCKED", // gate refusal recorded for the attempt → REJECTED
  "INVALIDATED", // invalidation level broke → INVALIDATED (or MISSED if window seen)
  "EXPIRED", // aged out / stale-closed → EXPIRED (or MISSED if window seen)
] as const;
export type OpportunityEventType = (typeof OPPORTUNITY_EVENT_TYPES)[number];

export interface OpportunityEvent {
  type: OpportunityEventType;
  /** For STAGE_OBSERVED: the observed active stage. Ignored otherwise. */
  observedStage?: OpportunityActiveState;
  /** Factual one-liner; carried into the persisted journal row. */
  reason: string;
}

// ── Snapshot + transition ────────────────────────────────────────────────────

export interface OpportunitySnapshot {
  state: OpportunityState;
  /** True once ENTRY_WINDOW_OPEN was ever observed (drives MISSED accounting). */
  entryWindowSeen: boolean;
  /** True once a gated execution attempt was dispatched (context for audits). */
  executionAttempted: boolean;
  terminal: boolean;
  terminalReason: string | null;
}

export function initialOpportunitySnapshot(): OpportunitySnapshot {
  return {
    state: "WATCHING",
    entryWindowSeen: false,
    executionAttempted: false,
    terminal: false,
    terminalReason: null,
  };
}

export interface TransitionResult {
  snapshot: OpportunitySnapshot;
  accepted: boolean;
  /** Set when accepted=false — typed, honest refusal (never silent). */
  rejectedReason: "TERMINAL_NO_REVIVAL" | "EVENT_NOT_APPLICABLE" | null;
  fromState: OpportunityState;
  toState: OpportunityState;
}

function terminate(
  snap: OpportunitySnapshot,
  state: OpportunityTerminalState,
  reason: string,
): OpportunitySnapshot {
  return { ...snap, state, terminal: true, terminalReason: reason };
}

/**
 * Apply one event to a snapshot. PURE. Terminal states absorb everything with
 * an explicit TERMINAL_NO_REVIVAL refusal — expired/terminated evidence can
 * never be revived onto the same object.
 */
export function applyOpportunityEvent(
  snap: OpportunitySnapshot,
  event: OpportunityEvent,
): TransitionResult {
  const fromState = snap.state;
  const refuse = (why: TransitionResult["rejectedReason"]): TransitionResult => ({
    snapshot: snap,
    accepted: false,
    rejectedReason: why,
    fromState,
    toState: fromState,
  });

  if (snap.terminal) return refuse("TERMINAL_NO_REVIVAL");

  const accept = (next: OpportunitySnapshot): TransitionResult => ({
    snapshot: next,
    accepted: true,
    rejectedReason: null,
    fromState,
    toState: next.state,
  });

  switch (event.type) {
    case "OPENED":
      // Only meaningful as the very first event; re-opening is not a transition.
      return accept({ ...snap });
    case "STAGE_OBSERVED": {
      if (!event.observedStage) return refuse("EVENT_NOT_APPLICABLE");
      const entryWindowSeen = snap.entryWindowSeen || event.observedStage === "ENTRY_WINDOW_OPEN";
      return accept({ ...snap, state: event.observedStage, entryWindowSeen });
    }
    case "DECISION_RECORDED":
    case "DUPLICATE_MERGED":
    case "CONFLICT_RESOLVED":
      // Journal-only events: recorded, no state movement.
      return accept({ ...snap });
    case "EXECUTION_DISPATCHED":
      return accept({ ...snap, executionAttempted: true });
    case "EXECUTION_FILLED":
      return accept(terminate({ ...snap, executionAttempted: true }, "EXECUTED", event.reason));
    case "EXECUTION_REJECTED":
    case "EXECUTION_BLOCKED":
      return accept(terminate({ ...snap, executionAttempted: true }, "REJECTED", event.reason));
    case "INVALIDATED":
      // Missed-state accounting: a window we saw open and never filled is MISSED.
      return accept(
        snap.entryWindowSeen
          ? terminate(snap, "MISSED", `Entry window opened but was never executed; ${event.reason}`)
          : terminate(snap, "INVALIDATED", event.reason),
      );
    case "EXPIRED":
      return accept(
        snap.entryWindowSeen
          ? terminate(snap, "MISSED", `Entry window opened but was never executed; ${event.reason}`)
          : terminate(snap, "EXPIRED", event.reason),
      );
    default:
      return refuse("EVENT_NOT_APPLICABLE");
  }
}

/**
 * Full reconstruction from the append-only event log. The persisted
 * `opportunities` row is a cache; THIS is the source of truth semantics —
 * folding the journal must land on the same snapshot the row holds.
 */
export function replayOpportunity(events: OpportunityEvent[]): OpportunitySnapshot {
  let snap = initialOpportunitySnapshot();
  for (const e of events) {
    const r = applyOpportunityEvent(snap, e);
    if (r.accepted) snap = r.snapshot;
    // Refused events (post-terminal noise) are journal-visible but never mutate.
  }
  return snap;
}

// ── Setup identity (opportunity key) + horizon classes ───────────────────────

export const HORIZON_CLASSES = ["SCALP", "INTRADAY", "SWING", "POSITION", "UNKNOWN"] as const;
export type HorizonClass = (typeof HORIZON_CLASSES)[number];

/** Timeframe → coarse time-horizon class. Unknown stays honestly UNKNOWN. */
export function timeframeHorizonClass(timeframe: string): HorizonClass {
  const tf = timeframe.trim().toUpperCase();
  if (tf === "M1" || tf === "M2" || tf === "M3" || tf === "M5") return "SCALP";
  if (tf === "M10" || tf === "M15" || tf === "M30" || tf === "H1") return "INTRADAY";
  if (tf === "H2" || tf === "H4" || tf === "H8" || tf === "D1") return "SWING";
  if (tf === "W1" || tf === "MN" || tf === "MN1") return "POSITION";
  return "UNKNOWN";
}

export interface OpportunityIdentity {
  symbol: string;
  timeframe: string;
  side: "BUY" | "SELL";
  setup: string;
}

/** Key from pre-resolved parts (horizon class already known). */
export function opportunityKeyFromParts(parts: {
  symbol: string;
  horizonClass: HorizonClass | string;
  side: "BUY" | "SELL";
  setup: string;
}): string {
  const sym = parts.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${sym}|${parts.horizonClass}|${parts.side}|${parts.setup}`;
}

/**
 * Stable setup identity. One OPEN opportunity object exists per key (enforced
 * by a partial unique index); terminal objects free the key for a NEW object.
 */
export function buildOpportunityKey(id: OpportunityIdentity): string {
  return opportunityKeyFromParts({
    symbol: id.symbol,
    horizonClass: timeframeHorizonClass(id.timeframe),
    side: id.side,
    setup: id.setup,
  });
}
