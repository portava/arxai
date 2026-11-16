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
//   - No safety gate moves: all pre-gates + the 18-gate evaluator + the
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
