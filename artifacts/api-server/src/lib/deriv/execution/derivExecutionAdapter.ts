// Phase 6 - DerivExecutionAdapter.
//
// The venue implementation of the ExecutionAdapter seam, built ON TOP OF the
// certified Phase 5 transport. It deliberately owns no Deriv protocol knowledge
// of its own: every wire shape, normalizer and evidence rule stays in
// lib/deriv/newApi/*, which is frozen and certified. A parallel Deriv execution
// stack is exactly what this file exists to avoid.
//
// The adapter's whole job is to answer one question honestly:
//
//     did a frame reach the venue, and if so what happened?
//
// with three outcomes rather than two:
//
//   RESOLVED           - the venue replied. A contract exists; return its handle.
//   REJECT (throw)     - PROVABLY nothing was transmitted. Fail closed.
//   INDETERMINATE      - a frame may have been written and we have no reply.
//                        Throw IndeterminateDeliveryError so the pipeline holds
//                        the command as LIVE_UNKNOWN with its exposure
//                        reservation intact.
//
// The third outcome is the reason this adapter can exist at all. Under the old
// binary seam, every timeout would have been recorded as a definite failure.

import {
  IndeterminateDeliveryError,
  MT5_EA_BRIDGE_VENUE,
  type ExecutionAdapter,
  type ExecutionDeliveryCommand,
  type DeliveryResult,
} from "../../live/executionAdapter.js";
import {
  tierPermitsVenueSend,
  type ExecutionTier,
} from "@workspace/domain/safety-contracts/executionTier";

export const DERIV_DEMO_VENUE_LITERAL = "deriv_demo" as const;

/** Deriv's reply carries a contract id; that is the venue-scoped handle. */
export interface DerivDeliveryResult extends DeliveryResult {
  contractId: string;
  /** The durable intent this delivery belongs to, for reconciliation. */
  intentId: string;
}

/**
 * Everything the adapter needs, injected. Nothing is read from module state or
 * the environment: an adapter that reaches for ambient config is an adapter
 * whose behaviour cannot be pinned by a test.
 */
export interface DerivExecutionDeps {
  /** Server-resolved. TIER_0 refuses before any frame is written. */
  tier: ExecutionTier;
  /**
   * Proven-demo assertion from the Phase 5 allow-list. The adapter never
   * decides this itself - it is the certified refusal in newApi/otp.ts.
   */
  accountIsProvenDemo: boolean;
  /** Records the intent durably BEFORE any write, returning its id. */
  persistIntent: (cmd: ExecutionDeliveryCommand) => Promise<string>;
  /**
   * Performs the buy against the certified transport.
   *
   * MUST distinguish the two failure shapes, because the whole safety property
   * rests on it:
   *   - `wireWritten === false` -> nothing was transmitted (safe to fail closed)
   *   - `wireWritten === true` with no reply -> INDETERMINATE
   */
  buyViaCertifiedTransport: (args: { intentId: string; cmd: ExecutionDeliveryCommand }) => Promise<{
    replied: boolean;
    wireWritten: boolean;
    contractId: string | null;
    /** Venue-adjudicated rejection: the venue replied and said no. */
    venueRejection: string | null;
    detail: string;
  }>;
}

export const DERIV_REFUSALS = {
  TIER_FORBIDS_SEND: "DERIV_TIER_FORBIDS_SEND",
  ACCOUNT_NOT_PROVEN_DEMO: "DERIV_ACCOUNT_NOT_PROVEN_DEMO",
  INTENT_NOT_PERSISTED: "DERIV_INTENT_NOT_PERSISTED",
  VENUE_REJECTED: "DERIV_VENUE_REJECTED",
} as const;

export class DerivExecutionAdapter implements ExecutionAdapter<DerivDeliveryResult> {
  readonly venue: typeof DERIV_DEMO_VENUE_LITERAL = DERIV_DEMO_VENUE_LITERAL;

  constructor(private readonly deps: DerivExecutionDeps) {
    // A Deriv adapter must never be mistakable for the EA bridge: the pipeline's
    // fail-closed handling is calibrated to a local mailbox INSERT, and this
    // venue's failures are nothing like that.
    if ((this.venue as string) === MT5_EA_BRIDGE_VENUE) {
      throw new Error("DerivExecutionAdapter must not claim the MT5 EA bridge venue");
    }
  }

  async deliver(command: ExecutionDeliveryCommand): Promise<DerivDeliveryResult> {
    const { tier, accountIsProvenDemo } = this.deps;

    // ── Refusals that happen BEFORE any frame can be written ───────────────
    // Each of these throws a plain Error, NOT IndeterminateDeliveryError,
    // because at this point nothing has been transmitted and we can prove it.
    // Fail-closed here is honest; it would not be one line later.

    if (!tierPermitsVenueSend(tier)) {
      // TIER_0 lands here. The entire guided flow above has already run for
      // real - gates, constitution, approval, adapter mapping - and only the
      // send is refused. That is what makes a dry run worth certifying.
      throw new Error(`${DERIV_REFUSALS.TIER_FORBIDS_SEND}: tier ${tier} does not permit a venue send`);
    }

    if (accountIsProvenDemo !== true) {
      // Not `!== false`: an undefined or unresolved account state must refuse.
      // This is the allow-list posture - an unrecognised account is refused,
      // never admitted.
      throw new Error(`${DERIV_REFUSALS.ACCOUNT_NOT_PROVEN_DEMO}: account is not proven demo`);
    }

    // ── Durable intent BEFORE the write ───────────────────────────────────
    // If the process dies between write and reply, this row is the only thing
    // that can correlate a late reply back to this command. req_id is per
    // transport instance and restarts at 0, so it cannot survive a restart.
    let intentId: string;
    try {
      intentId = await this.deps.persistIntent(command);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`${DERIV_REFUSALS.INTENT_NOT_PERSISTED}: ${detail}`);
    }
    if (typeof intentId !== "string" || intentId.trim() === "") {
      throw new Error(`${DERIV_REFUSALS.INTENT_NOT_PERSISTED}: no intent id returned`);
    }

    // ── The write ─────────────────────────────────────────────────────────
    let outcome: Awaited<ReturnType<DerivExecutionDeps["buyViaCertifiedTransport"]>>;
    try {
      outcome = await this.deps.buyViaCertifiedTransport({ intentId, cmd: command });
    } catch (e) {
      // A THROW from the transport tells us nothing about transmission. The
      // conservative reading is that a frame may have gone out, so this is
      // indeterminate - not a failure.
      const detail = e instanceof Error ? e.message : String(e);
      throw new IndeterminateDeliveryError(this.venue, `transport threw: ${detail}`, intentId);
    }

    // A venue reply is proof of transmission, including a rejection: Deriv
    // cannot reject an order it never received. So an adjudicated rejection is
    // a DEFINITE failure and may fail closed.
    if (outcome.venueRejection !== null && outcome.venueRejection !== "") {
      throw new Error(`${DERIV_REFUSALS.VENUE_REJECTED}: ${outcome.venueRejection}`);
    }

    if (outcome.replied === true) {
      const contractId = outcome.contractId;
      if (typeof contractId === "string" && contractId.trim() !== "") {
        return {
          transportRef: contractId,
          action: "BUY_MULTIPLIER",
          contractId,
          intentId,
        };
      }
      // Replied, no rejection, and no contract id. We cannot say a contract
      // exists and we cannot say it does not. Do not guess.
      throw new IndeterminateDeliveryError(
        this.venue,
        `venue replied without a contract id or a rejection: ${outcome.detail}`,
        intentId,
      );
    }

    // No reply. The ONLY thing that decides failure vs indeterminate is whether
    // the frame reached the wire.
    if (outcome.wireWritten === false) {
      // Proven pre-transmission: the frame never left. Safe to fail closed.
      throw new Error(`${DERIV_REFUSALS.VENUE_REJECTED}: not transmitted - ${outcome.detail}`);
    }

    // wireWritten true (or unknown, which we treat as true): a frame may be at
    // the venue and no reply came back. This is the case the whole third
    // outcome exists for.
    throw new IndeterminateDeliveryError(
      this.venue,
      `frame written, no reply: ${outcome.detail}`,
      intentId,
    );
  }
}
