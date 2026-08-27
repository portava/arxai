// Phase 6 — TIER 0 end-to-end certification.
//
// Drives the whole guided chain with the REAL modules — real Constitution
// evaluator, real ticket authorization, real venue router, real
// DerivExecutionAdapter, real tier resolver — and proves the property that
// gates everything downstream:
//
//     at TIER 0, no frame can reach the venue,
//     and everything upstream of the send still runs for real.
//
// A dry run that skipped the gates would prove nothing. The point is that the
// Constitution, the approval binding, the CAS claim, the venue router and the
// adapter mapping all execute exactly as they would at Tier 1, and only the
// send is refused.
//
// The transport is a spy that RECORDS any send and fails the test if called.
// It is not a stand-in for the adapter: the adapter under test is the shipped
// DerivExecutionAdapter, and the seam boundary being faked is the socket, which
// is the only thing that cannot exist in a test.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchGuidedTicket, isDryRunRefusal,
  type GuidedDispatchDeps,
} from "../guidedExecutionService.js";
import { DerivExecutionAdapter } from "../../deriv/execution/derivExecutionAdapter.js";
import { isIndeterminateDelivery } from "../../live/executionAdapter.js";
import { materialTermsFingerprint, type ApprovalTicket, type MaterialTradeTerms }
  from "@workspace/domain/safety-contracts/approvalTicket";
import type { TradingConstitution, ConstitutionObservedState }
  from "@workspace/domain/safety-contracts/tradingConstitution";

const NOW = "2026-08-26T12:00:00.000Z";
const USER = 7;

const TERMS: MaterialTradeTerms = {
  userId: USER, broker: "deriv", accountRef: "VRTC1234", instrument: "R_100",
  side: "BUY", stakeUsd: 1, multiplier: 100,
  stopLossUsd: 0.5, takeProfitUsd: 2, intentId: "intent_e2e",
};

const CONSTITUTION: TradingConstitution = {
  constitutionId: "con_e2e", userId: USER, version: 4,
  allowedBrokers: ["deriv"], allowedAccountRefs: ["VRTC1234"],
  allowedInstruments: ["R_100"], allowedMarketCategories: ["synthetic_indices"],
  allowedSessionsUtc: [{ daysOfWeekUtc: [0, 1, 2, 3, 4, 5, 6], openMinuteUtc: 0, closeMinuteUtc: 1440 }],
  maxRiskPerTradeUsd: 5, maxDailyLossUsd: 20, maxWeeklyLossUsd: 50,
  maxSimultaneousPositions: 2, maxExposurePerSymbolUsd: 10, maxTradesPerDay: 3,
  requireStopLoss: true, requireTakeProfit: true,
  minStakeUsd: 1, maxStakeUsd: 5, minMultiplier: 100, maxMultiplier: 400,
  lossStreakCooldown: null, forbiddenInstruments: [], forbiddenConditions: ["HIGH_IMPACT_NEWS_WINDOW"],
  rubyAuthority: "PREPARE_TICKET",
};

const OBSERVED: ConstitutionObservedState = {
  nowIso: NOW, realisedDailyLossUsd: 0, realisedWeeklyLossUsd: 0,
  openPositionCount: 0, openExposureForSymbolUsd: 0, tradesTakenToday: 0,
  consecutiveLosses: 0, lastLossAtIso: null,
};

const TICKET: ApprovalTicket = {
  ticketId: "tkt_e2e", userId: USER, state: "APPROVED", terms: TERMS,
  approvedFingerprint: materialTermsFingerprint(TERMS), approvedByUserId: USER,
  createdAtIso: "2026-08-26T11:58:00.000Z", expiresAtIso: "2026-08-26T12:05:00.000Z",
  dispatchClaimedAtIso: null, constitutionVersion: 4,
  gateVerdictsPassed: true, disclosureWaivedByOperator: false,
};

interface Spy { sends: number; intents: number; claims: number; audits: string[] }

function harness(over: Partial<GuidedDispatchDeps> = {}, ticketOver: Partial<ApprovalTicket> = {}) {
  const spy: Spy = { sends: 0, intents: 0, claims: 0, audits: [] };
  const ticket: ApprovalTicket = { ...TICKET, ...ticketOver };

  const deps: GuidedDispatchDeps = {
    configuredTier: "TIER_0_DRY_RUN",
    loadActiveConstitution: async () => CONSTITUTION,
    loadObservedState: async () => OBSERVED,
    loadOwnedTicket: async (id, uid) => (id === ticket.ticketId && uid === ticket.userId ? ticket : null),
    deriveCurrentTerms: async (t) => t.terms,
    hasUnresolvedIntent: async () => false,
    claimForDispatch: async () => { spy.claims++; return { claimed: true }; },
    venueForTicket: async () => "DERIV_DEMO",
    isIndeterminate: isIndeterminateDelivery,
    newLiveCommandId: () => "cmd_e2e",
    recordAudit: async (e) => { spy.audits.push(e.kind); },
    // The REAL adapter. Only the socket is faked.
    deliverViaAdapter: async ({ tier }) => {
      const adapter = new DerivExecutionAdapter({
        tier,
        accountIsProvenDemo: true,
        persistIntent: async () => { spy.intents++; return "intent_e2e"; },
        buyViaCertifiedTransport: async () => {
          spy.sends++;   // <- if this ever runs at Tier 0, the dry run is a lie
          return { replied: true, wireWritten: true, contractId: "c_should_not_exist", venueRejection: null, detail: "" };
        },
      });
      const r = await adapter.deliver({ liveRow: {} as never, bridgeUserId: USER, bridgeConnectionId: 1 });
      return { venueContractRef: r.transportRef, intentId: (r as { intentId: string }).intentId };
    },
    ...over,
  };
  return { deps, spy, ticket };
}

// ── the headline property ─────────────────────────────────────────────────
test("TIER 0: the full chain runs and NO frame reaches the venue", async () => {
  const { deps, spy } = harness();
  const out = await dispatchGuidedTicket(
    { userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);

  assert.equal(spy.sends, 0, "a frame was written to the venue during a DRY RUN");
  assert.equal(out.ok, false);
  assert.equal(isDryRunRefusal(out), true, `expected a tier refusal, got ${out.refusal}: ${out.detail}`);

  // Everything upstream of the send really ran.
  assert.equal(spy.claims, 1, "the atomic dispatch claim did not run — the dry run skipped the wall");
  assert.ok(spy.audits.includes("GUIDED_DISPATCH_DRY_RUN"), "the dry run was not recorded in the audit trail");

  // And no position is fabricated.
  assert.equal(out.venueContractRef, null, "a dry run produced a venue contract reference");
  assert.equal(out.indeterminate, false, "a pre-transmission refusal was reported as possibly-sent");
});

test("TIER 0 never persists an intent it cannot use", async () => {
  const { deps, spy } = harness();
  await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
  assert.equal(spy.intents, 0, "an order intent was persisted for an order that can never be sent");
});

// ── the gates all still bite ──────────────────────────────────────────────
test("an unresolved earlier intent blocks dispatch entirely", async () => {
  const { deps, spy } = harness({ hasUnresolvedIntent: async () => true });
  const out = await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
  assert.equal(out.refusal, "UNRESOLVED_INTENT_OUTSTANDING");
  assert.equal(spy.claims, 0, "a ticket was claimed while an earlier execution was unresolved");
  assert.equal(spy.sends, 0);
});

test("the Constitution is re-evaluated at DISPATCH, not just at proposal", async () => {
  // The day's loss crossed the cap after approval. Approval-time evaluation
  // alone would let this through.
  const { deps, spy } = harness({
    loadObservedState: async () => ({ ...OBSERVED, realisedDailyLossUsd: 20 }),
  });
  const out = await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
  assert.equal(out.refusal, "CONSTITUTION_REFUSED");
  assert.match(out.detail, /DAILY_LOSS_LIMIT_REACHED/);
  assert.equal(spy.claims, 0);
  assert.equal(spy.sends, 0);
});

test("a Constitution version change since approval refuses, and does NOT rewrite the ticket", async () => {
  const { deps, ticket, spy } = harness({
    loadActiveConstitution: async () => ({ ...CONSTITUTION, version: 5 }),
  });
  const out = await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
  assert.equal(out.refusal, "CONSTITUTION_CHANGED_SINCE_APPROVAL");
  assert.equal(ticket.constitutionVersion, 4, "the approved ticket was re-based onto the new policy");
  assert.equal(spy.claims, 0);
  assert.equal(spy.sends, 0);
});

test("a forbidden condition at dispatch time refuses", async () => {
  const { deps, spy } = harness();
  const out = await dispatchGuidedTicket(
    { userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: ["HIGH_IMPACT_NEWS_WINDOW"] }, deps);
  assert.equal(out.refusal, "CONSTITUTION_REFUSED");
  assert.equal(spy.sends, 0);
});

test("altered material terms between approval and dispatch refuse", async () => {
  const { deps, spy } = harness({
    deriveCurrentTerms: async (t) => ({ ...t.terms, stakeUsd: 4 }),   // approved at 1
  });
  const out = await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
  assert.equal(out.refusal, "TICKET_AUTHORIZATION_REFUSED");
  assert.match(out.detail, /TERMS_CHANGED_SINCE_APPROVAL/);
  assert.equal(spy.claims, 0);
  assert.equal(spy.sends, 0);
});

test("an unapproved, rejected or expired ticket cannot dispatch", async () => {
  for (const state of ["PENDING", "REJECTED", "EXPIRED", "CANCELLED", "DISPATCHING", "EXECUTED", "UNRESOLVED"] as const) {
    const { deps, spy } = harness({}, { state });
    const out = await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
    assert.equal(out.ok, false, `a ${state} ticket dispatched`);
    assert.equal(spy.sends, 0, `a ${state} ticket reached the venue`);
    assert.equal(spy.claims, 0, `a ${state} ticket was claimed`);
  }
});

test("another user cannot dispatch this ticket", async () => {
  const { deps, spy } = harness();
  const out = await dispatchGuidedTicket({ userId: 8, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
  assert.equal(out.ok, false);
  assert.equal(spy.sends, 0);
});

test("losing the dispatch claim refuses BEFORE the adapter", async () => {
  const { deps, spy } = harness({ claimForDispatch: async () => { spy.claims++; return null; } });
  const out = await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
  assert.equal(out.refusal, "DISPATCH_CLAIM_LOST");
  assert.equal(spy.sends, 0, "a dispatcher that lost the race still reached the venue");
});

// ── venue routing, fail-closed ────────────────────────────────────────────
test("an unknown, absent or malformed venue refuses and never reaches an adapter", async () => {
  for (const bad of [null, undefined, "", "deriv", "DERIV_REAL", "MT5", 42] as unknown[]) {
    const { deps, spy } = harness({ venueForTicket: async () => bad as string | null });
    const out = await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
    assert.equal(out.refusal, "VENUE_UNROUTABLE", `venue ${String(bad)} routed somewhere`);
    assert.equal(spy.sends, 0);
  }
});

// ── UNKNOWN handling survives the whole chain ─────────────────────────────
test("an INDETERMINATE delivery is never reported as no-trade or failed", async () => {
  const { deps } = harness({
    deliverViaAdapter: async ({ tier }) => {
      const adapter = new DerivExecutionAdapter({
        tier: "TIER_1_DEMO_GUIDED",       // force past the tier wall for this case
        accountIsProvenDemo: true,
        persistIntent: async () => "intent_e2e",
        buyViaCertifiedTransport: async () => ({
          replied: false, wireWritten: true, contractId: null, venueRejection: null,
          detail: "no reply in 15000ms",
        }),
      });
      void tier;
      const r = await adapter.deliver({ liveRow: {} as never, bridgeUserId: USER, bridgeConnectionId: 1 });
      return { venueContractRef: r.transportRef, intentId: (r as { intentId: string }).intentId };
    },
  });
  const out = await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);

  assert.equal(out.indeterminate, true, "a written-then-silent frame was resolved to a verdict");
  assert.equal(out.refusal, "DELIVERY_INDETERMINATE");
  assert.equal(out.venueContractRef, null, "an unknown outcome produced a contract reference");
  assert.equal(out.intentId, "intent_e2e", "the lineage id was lost, so reconciliation cannot find the order");
  // The wording a caller renders must not claim absence.
  assert.ok(!/no trade|did not|failed/i.test(out.detail), `detail claims absence: ${out.detail}`);
});

test("a provably NOT-transmitted frame is a definite refusal, not indeterminate", async () => {
  const { deps } = harness({
    deliverViaAdapter: async () => {
      const adapter = new DerivExecutionAdapter({
        tier: "TIER_1_DEMO_GUIDED",
        accountIsProvenDemo: true,
        persistIntent: async () => "intent_e2e",
        buyViaCertifiedTransport: async () => ({
          replied: false, wireWritten: false, contractId: null, venueRejection: null,
          detail: "socket closed before write",
        }),
      });
      const r = await adapter.deliver({ liveRow: {} as never, bridgeUserId: USER, bridgeConnectionId: 1 });
      return { venueContractRef: r.transportRef, intentId: (r as { intentId: string }).intentId };
    },
  });
  const out = await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
  assert.equal(out.indeterminate, false, "a provably-unsent frame stranded exposure as UNKNOWN");
  assert.equal(out.refusal, "ADAPTER_REFUSED");
});

// ── tier escalation cannot happen by accident ─────────────────────────────
test("no configured tier value can escalate the dry run into a send", async () => {
  for (const raw of [null, undefined, "", "1", "true", "TIER_1", "tier_1_demo_guided",
                     "TIER_3_LIVE_GUIDED", "TIER_4_AUTONOMOUS"]) {
    const { deps, spy } = harness({ configuredTier: raw as string | null });
    const out = await dispatchGuidedTicket({ userId: USER, ticketId: "tkt_e2e", marketCategory: "synthetic_indices", conditions: [] }, deps);
    assert.equal(spy.sends, 0, `configured tier ${JSON.stringify(raw)} reached the venue`);
    assert.equal(isDryRunRefusal(out), true, `configured tier ${JSON.stringify(raw)} did not resolve to a dry run`);
  }
});
