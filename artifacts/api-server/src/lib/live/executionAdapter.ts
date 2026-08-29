// R2-S7 — Execution-adapter seam.
//
// The live pipeline's ONLY broker-delivery side effect is the EA-mailbox
// mirror (enqueueBridgedMt5Command in liveCommandPipeline.ts: an INSERT into
// the legacy mt5_commands mailbox the v1.50 EA polls). This module extracts
// that delivery behind a minimal interface so R5's Deriv adapter can
// implement the SAME seam later without touching the pipeline's gate walls.
//
// CONSTRAINTS (behavior is byte-equivalent by construction):
//   - Mt5EaBridgeAdapter does NOT reimplement delivery — it wraps the
//     EXISTING enqueueBridgedMt5Command function unchanged (injected by the
//     pipeline, which keeps sole ownership of the mailbox INSERT and its
//     silent-close-failure guard). One delivery law, zero drift.
//   - The pipeline's mirror-failure semantics are unchanged: a deliver()
//     rejection still fails the command CLOSED (LIVE_FAILED +
//     BRIDGE_ENQUEUE_FAILED / BRIDGE_UNMAPPED_COMMAND_TYPE) and releases the
//     exposure reservation — that handling lives at the pipeline call site,
//     NOT in the adapter, so every future adapter inherits it.
//   - No safety gate moves: all pre-gates + the 23-gate evaluator + the
//     double-send CAS run BEFORE deliver() is ever called.
//
// A future venue (R5 Deriv) implements ExecutionAdapter with its own venue
// literal; the pipeline consumes only the interface.

import type { ArxLiveCommand } from "@workspace/db";

/** The command handed to a venue adapter for delivery. Shape mirrors the
 *  existing enqueueBridgedMt5Command options exactly (seam extraction only —
 *  widening this shape is an R5 decision, not a wave-5 one). */
export interface ExecutionDeliveryCommand {
  /** The authoritative arx_live_commands row, already SENT_TO_MT5_LIVE. */
  liveRow: ArxLiveCommand;
  /** The bridge owner the EA authenticates as (mailbox scoping). */
  bridgeUserId: number;
  /** The exact bridge connection the command is bound to. */
  bridgeConnectionId: number;
}

/**
 * What a successful delivery reports back to the pipeline.
 *
 * `transportRef` is the venue-neutral handle: an opaque reference to WHERE the
 * command now lives in that venue's transport. This is what `mt5CommandId`
 * always meant — the generalization names the concept rather than inventing
 * one, so a second venue does not have to pretend to have an mt5_commands row.
 */
export interface DeliveryResult {
  /** Opaque, venue-scoped. EA bridge: the mt5_commands PK as a string. */
  transportRef: string;
  /** The venue-level action the command was mapped to (e.g. OPEN_MARKET). */
  action: string;
}

/**
 * The EA bridge's result. Keeps the numeric mailbox id as a first-class field
 * because the pipeline's audit and logging rows are typed on it; a stringly
 * -typed transportRef alone would silently widen those.
 */
export interface Mt5DeliveryResult extends DeliveryResult {
  /** The transport-mirror row id (mt5_commands PK). */
  mt5CommandId: number;
}

/** Minimal venue seam. deliver() either resolves with the transport handle
 *  or REJECTS — it never swallows a failure into a fake success, because the
 *  pipeline's fail-closed mark-failed handling depends on the rejection. */
export interface ExecutionAdapter<R extends DeliveryResult = DeliveryResult> {
  readonly venue: string;
  deliver(command: ExecutionDeliveryCommand): Promise<R>;
}

/**
 * The THIRD delivery outcome: the frame may have reached the venue, and nothing
 * downstream may claim otherwise.
 *
 * `deliver()` was binary by design, and for the EA bridge that is exactly right:
 * delivery there is an INSERT into a local mailbox table, so a failure is
 * provably pre-transmission and failing the command CLOSED (LIVE_FAILED, release
 * the exposure reservation) is the honest reading.
 *
 * A network venue breaks that assumption. Writing a frame to a socket and then
 * receiving no reply does NOT mean the order was not placed. Rejecting would
 * mark LIVE_FAILED, release the exposure reservation for a position that may be
 * open, and report "no trade" to the user about an order that may be live —
 * conservative-looking, but falsely certain in the one direction that costs
 * real money.
 *
 * So an adapter that cannot prove non-transmission throws THIS instead. The
 * pipeline maps it to LIVE_UNKNOWN, HOLDS the reservation, and hands the command
 * to reconciliation. `Mt5EaBridgeAdapter` never throws it, so the EA path's
 * behaviour is unchanged.
 */
export class IndeterminateDeliveryError extends Error {
  /**
   * Brand rather than `instanceof`. A duplicated module instance (two copies of
   * this file in a bundle, a test double, a re-exported build) breaks
   * `instanceof` silently, and the failure mode would be an indeterminate
   * delivery falling through to the generic catch and being recorded as a
   * definite failure. A property check cannot break that way.
   */
  readonly arxIndeterminateDelivery = true as const;

  constructor(
    readonly venue: string,
    /** Human-readable, no secrets: this reaches logs and the audit trail. */
    readonly detail: string,
    /**
     * The durable intent reference reconciliation will need to correlate a late
     * reply back to this command. Null only when the adapter could not persist
     * one, which is itself worth surfacing.
     */
    readonly intentRef: string | null,
  ) {
    super(`INDETERMINATE_DELIVERY[${venue}]: ${detail}`);
    this.name = "IndeterminateDeliveryError";
  }
}

/**
 * Structural check for the third outcome. Deliberately NOT `instanceof` — see
 * the brand comment above.
 */
export function isIndeterminateDelivery(e: unknown): e is IndeterminateDeliveryError {
  return typeof e === "object" && e !== null
    && (e as { arxIndeterminateDelivery?: unknown }).arxIndeterminateDelivery === true;
}

/**
 * How a delivery failure must be recorded.
 *
 * Extracted as a pure function rather than left as an inline `if` in the
 * pipeline so the routing decision itself is testable with the real code. An
 * inline branch can only be asserted by scanning source text, and a source scan
 * cannot tell a live branch from a disabled one — `if (false && ...)` keeps
 * every string in place while silently routing every indeterminate delivery
 * into the definite-failure path. That mutation survived a position-based test,
 * which is why this exists.
 */
export type DeliveryFailureRouting =
  | { kind: "INDETERMINATE"; venue: string; detail: string; intentRef: string | null }
  | { kind: "DEFINITE_FAILURE" };

/**
 * Total and default-conservative: anything NOT provably indeterminate routes to
 * DEFINITE_FAILURE, which is the correct reading for the EA bridge's local
 * mailbox INSERT and the pre-existing behaviour for every other error.
 */
export function routeDeliveryFailure(err: unknown): DeliveryFailureRouting {
  if (isIndeterminateDelivery(err)) {
    return {
      kind: "INDETERMINATE",
      venue: err.venue,
      detail: err.detail,
      intentRef: err.intentRef,
    };
  }
  return { kind: "DEFINITE_FAILURE" };
}

export const MT5_EA_BRIDGE_VENUE = "mt5_ea_bridge" as const;

/**
 * The sole wave-5 implementation: wraps the pipeline's existing
 * enqueueBridgedMt5Command (injected — the function itself is unchanged and
 * stays private to liveCommandPipeline.ts). Pure pass-through: no retries,
 * no error mapping, no added semantics.
 */
export class Mt5EaBridgeAdapter implements ExecutionAdapter<Mt5DeliveryResult> {
  readonly venue: typeof MT5_EA_BRIDGE_VENUE = MT5_EA_BRIDGE_VENUE;

  constructor(
    private readonly enqueue: (opts: ExecutionDeliveryCommand) => Promise<Mt5DeliveryResult>,
  ) {}

  deliver(command: ExecutionDeliveryCommand): Promise<Mt5DeliveryResult> {
    return this.enqueue(command);
  }
}

// NOT generalized yet, deliberately: ExecutionDeliveryCommand still carries an
// ArxLiveCommand whose volume is expressed in MT5 lots. A Deriv multiplier
// contract has no lot concept (stake x multiplier), so the INPUT side needs a
// venue-neutral notional — but shaping that before a certified Deriv round-trip
// would be guessing at the most safety-critical boundary in the system. It
// lands with the Deriv adapter, informed by a real response.
