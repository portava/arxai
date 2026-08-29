// Phase 6 — the guided execution service.
//
// The one path from a proposal to a venue, and the only place the Phase 6
// pieces are composed:
//
//   propose  -> Constitution (1st evaluation) -> approval ticket (PENDING)
//   approve  -> explicit human act -> terms fingerprint bound to the ticket
//   dispatch -> Constitution (2nd evaluation) -> pure authorization
//            -> atomic CAS claim -> venue router -> certified adapter
//
// THE CONSTITUTION IS EVALUATED TWICE, and that is not belt-and-braces
// duplication. Between approval and dispatch the governing policy can change:
// the owner may tighten a limit, or the day's realised loss may cross a cap the
// user was under when they clicked. Evaluating only at proposal time would let
// a stale approval execute under rules nobody agreed to. Evaluating only at
// dispatch would let the inbox show tickets that could never execute.
//
// A newer Constitution that refuses does NOT silently rewrite the ticket. The
// ticket is refused and a new one is required — rewriting approved terms would
// mean executing something the user never saw.

import {
  evaluateConstitution,
  type ConstitutionObservedState,
  type ConstitutionProposal,
  type ConstitutionVerdict,
  type TradingConstitution,
} from "@workspace/domain/safety-contracts/tradingConstitution";
import {
  authorizeDispatch, materialTermsFingerprint,
  type ApprovalTicket, type MaterialTradeTerms,
} from "@workspace/domain/safety-contracts/approvalTicket";
import {
  resolveExecutionTier, tierPermitsVenueSend, type ExecutionTier,
} from "@workspace/domain/safety-contracts/executionTier";
import {
  brokerCertificationDispatchRefusals, type CodedCertification,
} from "@workspace/domain/safety-contracts/certificationExpiry";
import { routeExecutionVenue, type ExecutionVenue } from "@workspace/domain/safety-contracts/executionVenue";

export const GUIDED_REFUSALS = [
  "CONSTITUTION_REFUSED",
  "CONSTITUTION_CHANGED_SINCE_APPROVAL",
  "TICKET_AUTHORIZATION_REFUSED",
  "DISPATCH_CLAIM_LOST",
  "VENUE_UNROUTABLE",
  "TIER_FORBIDS_SEND",
  "UNRESOLVED_INTENT_OUTSTANDING",
  "ADAPTER_REFUSED",
  "DELIVERY_INDETERMINATE",
  // #56 Continuous certification — a venue-permitting dispatch is refused
  // while any BROKER certification in the coded register is past its review
  // period. Reduce-only: TIER_0 dry-run keeps working (it is the floor).
  "BROKER_CERTIFICATION_LAPSED",
] as const;
export type GuidedRefusal = (typeof GUIDED_REFUSALS)[number];

export interface GuidedDispatchOutcome {
  ok: boolean;
  /**
   * True ONLY when THIS request won the CAS claim. Settlement keys off it:
   * without it, a claim-race LOSER's "definite refusal" settlement matched the
   * WINNER's in-flight DISPATCHING row and marked a ticket REJECTED ("no order
   * exists") while the winner's frame was at the venue — the falsely-certain
   * catastrophe, introduced by the settlement fix itself and caught by audit.
   */
  claimed: boolean;
  refusal: GuidedRefusal | null;
  detail: string;
  /** Set only when the venue proved a contract exists. */
  venueContractRef: string | null;
  /**
   * True when the outcome is genuinely unknown. A caller must NOT render this
   * as "no trade" or "failed" — an order may exist at the venue.
   */
  indeterminate: boolean;
  /** The lineage handle: one id linking ticket -> intent -> command -> journal. */
  intentId: string | null;
}

/**
 * Row-shaped inputs, injected. The service performs no I/O of its own so the
 * whole decision chain is testable without a database — the DB-bound parts are
 * proven separately by approvalTicketRaceDb.
 */
export interface GuidedDispatchDeps {
  /** The tier value the SERVER resolved. Never client-supplied. */
  configuredTier: string | null;
  /**
   * #56 clock/registry injection for certification-lapse drills. Production
   * omits both: the CODED register is consulted at the wall clock, so a lapsed
   * broker certification reduces authority without anyone remembering to.
   */
  certificationNowMs?: number;
  certificationRegistry?: readonly CodedCertification[];
  loadActiveConstitution: (userId: number) => Promise<TradingConstitution | null>;
  /** `instrument` scopes the per-symbol exposure figure to the proposal's own symbol. */
  loadObservedState: (userId: number, instrument?: string) => Promise<ConstitutionObservedState>;
  loadOwnedTicket: (ticketId: string, userId: number) => Promise<ApprovalTicket | null>;
  /** Re-derived from LIVE state, never echoed back from the ticket. */
  deriveCurrentTerms: (ticket: ApprovalTicket) => Promise<MaterialTradeTerms>;
  hasUnresolvedIntent: (userId: number) => Promise<boolean>;
  /** The atomic CAS. Returns null when a concurrent dispatcher won. */
  claimForDispatch: (args: { ticketId: string; userId: number; liveCommandId: string }) => Promise<unknown | null>;
  /** The venue the SERVER persisted on the command row. */
  venueForTicket: (ticket: ApprovalTicket) => Promise<string | null>;
  /** Invokes the certified adapter. Throws on refusal or indeterminacy. */
  deliverViaAdapter: (args: {
    ticket: ApprovalTicket; venue: ExecutionVenue; tier: ExecutionTier; liveCommandId: string;
  }) => Promise<{ venueContractRef: string; intentId: string }>;
  isIndeterminate: (e: unknown) => boolean;
  newLiveCommandId: () => string;
  recordAudit: (event: {
    kind: string; userId: number; ticketId: string; detail: string;
    /** Venue-proven only. Present on EXECUTED; never fabricated elsewhere. */
    venueContractRef?: string;
    /** The lineage spine, when the adapter produced one. */
    intentId?: string;
  }) => Promise<void>;
}

const refuse = (
  refusal: GuidedRefusal, detail: string,
  extra: Partial<GuidedDispatchOutcome> = {},
): GuidedDispatchOutcome => ({
  ok: false, refusal, detail, venueContractRef: null, indeterminate: false,
  intentId: null, claimed: false, ...extra,
});

/** Build the venue-neutral proposal the Constitution judges from a ticket. */
export function proposalFromTerms(terms: MaterialTradeTerms, marketCategory: string, conditions: string[]): ConstitutionProposal {
  return {
    userId: terms.userId,
    broker: terms.broker,
    accountRef: terms.accountRef,
    instrument: terms.instrument,
    marketCategory,
    side: terms.side,
    stakeUsd: terms.stakeUsd,
    multiplier: terms.multiplier,
    riskUsd: terms.stakeUsd,
    hasStopLoss: terms.stopLossUsd !== null,
    hasTakeProfit: terms.takeProfitUsd !== null,
    conditions,
  };
}

/**
 * Dispatch an approved guided ticket, or refuse.
 *
 * Ordering is deliberate and each step is a wall, not a formality:
 *
 *   1. outstanding unresolved intent -> STOP. The owner's Tier 1 rule: once an
 *      execution state is UNKNOWN, no new order may rely on that uncertain
 *      exposure being absent.
 *   2. Constitution, re-evaluated NOW against the CURRENT policy and the
 *      CURRENT observed state.
 *   3. pure authorization: approval, expiry, scope, terms fingerprint.
 *   4. the atomic CAS claim. Everything before this is advisory; this is what
 *      makes at-most-one true.
 *   5. venue routing, fail-closed.
 *   6. the certified adapter.
 *
 * Note that the CAS comes AFTER the checks and BEFORE the adapter. Claiming
 * earlier would burn a ticket on a refusal; claiming later would leave a window
 * where two dispatchers both reach the venue.
 */
export async function dispatchGuidedTicket(
  args: { userId: number; ticketId: string; marketCategory: string; conditions: string[] },
  deps: GuidedDispatchDeps,
): Promise<GuidedDispatchOutcome> {
  const tierResolution = resolveExecutionTier(deps.configuredTier);
  const tier = tierResolution.tier;

  // ── #56 Continuous certification — the BROKER seam ────────────────────────
  // A tier that would let a frame reach the venue is only as good as the
  // broker evidence behind it, and evidence expires (Article IV). While any
  // BROKER certification in the coded register is past its review period, a
  // venue-permitting dispatch is refused BEFORE the ticket is loaded or
  // claimed — nothing is burned, nothing is sent. TIER_0 is deliberately NOT
  // gated here: the dry-run floor is exactly what a lapse reduces you to, and
  // it must keep working so the recertification harness itself can run.
  if (tierPermitsVenueSend(tier)) {
    const certNow = new Date(deps.certificationNowMs ?? Date.now());
    const certRefusals = brokerCertificationDispatchRefusals(certNow, deps.certificationRegistry);
    if (certRefusals.length > 0) {
      await deps.recordAudit({
        kind: "GUIDED_DISPATCH_REFUSED", userId: args.userId, ticketId: args.ticketId,
        detail: `broker certification lapsed: ${certRefusals.join("; ").slice(0, 500)}`,
      });
      return refuse("BROKER_CERTIFICATION_LAPSED", certRefusals.join("; "));
    }
  }

  // Everything from here to the adapter is PRE-TRANSMISSION by construction:
  // no adapter has been constructed, so no frame can have been written. An
  // infrastructure failure in this region — an unreachable database, a
  // malformed row — is therefore a DEFINITE refusal, and converting it to one
  // is honest.
  //
  // The same wrapper around the ADAPTER would NOT be safe: an exception there
  // may arrive after a frame reached the wire, and calling that a definite
  // refusal is exactly the falsely-certain claim this phase exists to prevent.
  // That is why the try below ends before deliverViaAdapter, which has its own
  // indeterminate-aware handling.
  let ticket: ApprovalTicket | null | undefined;
  let currentTerms: MaterialTradeTerms;
  let observed: ConstitutionObservedState;
  let verdict: ConstitutionVerdict;
  try {
    ticket = await deps.loadOwnedTicket(args.ticketId, args.userId);
    if (!ticket) return refuse("TICKET_AUTHORIZATION_REFUSED", "ticket not found for this user");

    // 1 — an unresolved intent blocks every new order for this user.
    if (await deps.hasUnresolvedIntent(args.userId)) {
    await deps.recordAudit({
      kind: "GUIDED_DISPATCH_BLOCKED_UNRESOLVED", userId: args.userId, ticketId: args.ticketId,
      detail: "an earlier intent is unresolved; no new order may assume its exposure is absent",
    });
    return refuse("UNRESOLVED_INTENT_OUTSTANDING",
      "an earlier execution is unresolved — resolve it before placing another order");
  }

    currentTerms = await deps.deriveCurrentTerms(ticket);

  // 2 — the SECOND Constitution evaluation, against current policy and state.
    const constitution = await deps.loadActiveConstitution(args.userId);
    observed = await deps.loadObservedState(args.userId, currentTerms.instrument);
    verdict = evaluateConstitution(
    constitution,
      proposalFromTerms(currentTerms, args.marketCategory, args.conditions),
      observed,
    );
  } catch (infraErr) {
    const detail = infraErr instanceof Error ? infraErr.message : String(infraErr);
    return refuse("TICKET_AUTHORIZATION_REFUSED",
      `could not establish dispatch preconditions (nothing was sent): ${detail.slice(0, 300)}`);
  }
  if (verdict.decision !== "PERMIT") {
    await deps.recordAudit({
      kind: "GUIDED_DISPATCH_BLOCKED_CONSTITUTION", userId: args.userId, ticketId: args.ticketId,
      detail: `constitution v${verdict.constitutionVersion ?? "?"} refused: ${verdict.refusals.join(",")}`,
    });
    return refuse("CONSTITUTION_REFUSED", `refused by constitution: ${verdict.refusals.join(", ")}`);
  }
  // A policy CHANGE since approval invalidates the approval. The ticket is not
  // rewritten to match the new policy — the user approved specific terms under
  // a specific version, and silently re-basing that would execute something
  // they never saw.
  if (verdict.constitutionVersion !== ticket.constitutionVersion) {
    await deps.recordAudit({
      kind: "GUIDED_DISPATCH_BLOCKED_POLICY_CHANGE", userId: args.userId, ticketId: args.ticketId,
      detail: `ticket pinned v${ticket.constitutionVersion}, active is v${verdict.constitutionVersion}`,
    });
    return refuse("CONSTITUTION_CHANGED_SINCE_APPROVAL",
      `the governing policy changed since approval (v${ticket.constitutionVersion} -> v${verdict.constitutionVersion}); a new ticket is required`);
  }

  // 3 — pure authorization.
  const auth = authorizeDispatch({
    ticket, actorUserId: args.userId, currentTerms, nowIso: observed.nowIso,
  });
  if (!auth.authorized) {
    return refuse("TICKET_AUTHORIZATION_REFUSED", `refused: ${auth.refusals.join(", ")}`);
  }

  // 4 — the atomic claim. At most one dispatcher proceeds past this line.
  const liveCommandId = deps.newLiveCommandId();
  let claimed: unknown;
  try {
    claimed = await deps.claimForDispatch({
      ticketId: ticket.ticketId, userId: args.userId, liveCommandId,
    });
  } catch (claimErr) {
    // The claim UPDATE may have COMMITTED before the connection died, so this
    // is not a clean loss: the ticket may now be DISPATCHING with no dispatcher.
    // Nothing has been SENT (the claim is not a send), so saying so is honest —
    // but the ticket state must be checked, and --verify reports a stranded
    // DISPATCHING row as a LEDGER GAP rather than non-dispatch (critic finding).
    const msg = claimErr instanceof Error ? claimErr.message : String(claimErr);
    return refuse("DISPATCH_CLAIM_LOST",
      `the dispatch claim's outcome is unknown (${msg.slice(0, 160)}) — nothing was sent; ` +
      "check the ticket state before retrying");
  }
  if (!claimed) {
    return refuse("DISPATCH_CLAIM_LOST",
      "another dispatcher already claimed this ticket — exactly one order may result from one approval");
  }

  // 5 — venue routing, fail-closed. No default.
  const venueRaw = await deps.venueForTicket(ticket);
  const route = routeExecutionVenue(venueRaw);
  if (!route.ok) {
    await deps.recordAudit({
      kind: "GUIDED_DISPATCH_UNROUTABLE", userId: args.userId, ticketId: args.ticketId,
      detail: `${route.refusal}: ${route.detail}`,
    });
    return refuse("VENUE_UNROUTABLE", `${route.refusal}: ${route.detail}`, { claimed: true });
  }

  // 6 — the certified adapter. TIER 0 refuses inside it, BEFORE any frame.
  try {
    const delivered = await deps.deliverViaAdapter({
      ticket, venue: route.venue, tier, liveCommandId,
    });
    await deps.recordAudit({
      kind: "GUIDED_DISPATCH_EXECUTED", userId: args.userId, ticketId: args.ticketId,
      detail: `venue contract ${delivered.venueContractRef}`,
      venueContractRef: delivered.venueContractRef,
      intentId: delivered.intentId,
    });
    return {
      ok: true, refusal: null, detail: "venue confirmed the order",
      venueContractRef: delivered.venueContractRef, indeterminate: false,
      intentId: delivered.intentId, claimed: true,
    };
  } catch (e) {
    // The distinction the whole phase rests on. An indeterminate delivery is
    // NOT a failure: a frame may have reached the venue, so nothing may report
    // "no trade", and the exposure stays held for reconciliation.
    if (deps.isIndeterminate(e)) {
      const intentRef = (e as { intentRef?: string | null }).intentRef ?? null;
      await deps.recordAudit({
        kind: "GUIDED_DISPATCH_INDETERMINATE", userId: args.userId, ticketId: args.ticketId,
        detail: "an order MAY exist at the venue — see the attached intent id",
        ...(intentRef ? { intentId: intentRef } : {}),
      });
      return {
        ok: false, refusal: "DELIVERY_INDETERMINATE",
        detail: "the outcome is unknown — an order may exist at the venue and must be reconciled",
        venueContractRef: null, indeterminate: true, intentId: intentRef, claimed: true,
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    // A tier refusal is the expected Tier 0 outcome: everything upstream ran
    // for real, and only the send was refused.
    const isTierRefusal = msg.includes("TIER_FORBIDS_SEND");
    // A venue ADJUDICATION is not a gate refusal (critic finding): GATE_REFUSED
    // reads as "nothing reached the venue", which is false here — the venue
    // received the order and said no. The distinct kind keeps the ledger's
    // vocabulary meaning what it says.
    const isVenueAdjudicated = !isTierRefusal && msg.includes("DERIV_VENUE_REJECTED");
    await deps.recordAudit({
      kind: isTierRefusal ? "GUIDED_DISPATCH_DRY_RUN"
        : isVenueAdjudicated ? "GUIDED_DISPATCH_VENUE_REJECTED"
          : "GUIDED_DISPATCH_REFUSED",
      userId: args.userId, ticketId: args.ticketId, detail: msg.slice(0, 400),
    });
    return refuse(isTierRefusal ? "TIER_FORBIDS_SEND" : "ADAPTER_REFUSED", msg.slice(0, 400), { claimed: true });
  }
}

/** Convenience for callers rendering a dry run honestly. */
export function isDryRunRefusal(o: GuidedDispatchOutcome): boolean {
  return o.refusal === "TIER_FORBIDS_SEND";
}

export { tierPermitsVenueSend, materialTermsFingerprint };
