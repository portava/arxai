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

/** What a successful delivery reports back to the pipeline. */
export interface DeliveryResult {
  /** The transport-mirror row id (mt5_commands PK for the EA bridge). */
  mt5CommandId: number;
  /** The venue-level action the command was mapped to (e.g. OPEN_MARKET). */
  action: string;
}

/** Minimal venue seam. deliver() either resolves with the transport handle
 *  or REJECTS — it never swallows a failure into a fake success, because the
 *  pipeline's fail-closed mark-failed handling depends on the rejection. */
export interface ExecutionAdapter {
  readonly venue: string;
  deliver(command: ExecutionDeliveryCommand): Promise<DeliveryResult>;
}

export const MT5_EA_BRIDGE_VENUE = "mt5_ea_bridge" as const;

/**
 * The sole wave-5 implementation: wraps the pipeline's existing
 * enqueueBridgedMt5Command (injected — the function itself is unchanged and
 * stays private to liveCommandPipeline.ts). Pure pass-through: no retries,
 * no error mapping, no added semantics.
 */
export class Mt5EaBridgeAdapter implements ExecutionAdapter {
  readonly venue: typeof MT5_EA_BRIDGE_VENUE = MT5_EA_BRIDGE_VENUE;

  constructor(
    private readonly enqueue: (opts: ExecutionDeliveryCommand) => Promise<DeliveryResult>,
  ) {}

  deliver(command: ExecutionDeliveryCommand): Promise<DeliveryResult> {
    return this.enqueue(command);
  }
}
