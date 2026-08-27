// Phase 6 — COMPLETE TIER 0 PRODUCT CERTIFICATE.
//
// The earlier tier0EndToEnd suite certified the decision CHAIN. This certifies
// the assembled PRODUCT: the real composition entry point, the real per-request
// dependency resolver, the real adapter, the real lineage writer, the real
// sweeper — with only the venue SOCKET faked.
//
// WHAT MAY BE FAKED, AND WHY IT IS ONLY THIS.
//   The socket: it cannot exist in a test, and faking it is the only way to
//   assert that NOTHING was written to it. The spy counts writes; any write at
//   Tier 0 fails the certificate.
//   Persistence and connection lookups: this environment has no Postgres. The
//   DB-bound halves — the atomic CAS, ownership scoping, expiry against the
//   database clock, the sweeper's UNKNOWN exclusion — are certified separately
//   against a live Postgres by approval-ticket-race-db (11/11).
//
// Everything that DECIDES is real: Constitution, ticket authorization, terms
// fingerprint, venue router, tier resolver, dependency resolver, adapter,
// lineage. There is deliberately no hook that can stub any of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dispatchGuidedTicketForRequest } from "../guidedDispatchEntry.js";
import {
  buildLineageRecord, reconstructAttempt, positionStateForEvent,
  type GuidedLineageRecord,
} from "../guidedLineage.js";
import { materialTermsFingerprint, type ApprovalTicket, type MaterialTradeTerms }
  from "@workspace/domain/safety-contracts/approvalTicket";
import type { ConstitutionObservedState, TradingConstitution }
  from "@workspace/domain/safety-contracts/tradingConstitution";

const USER = 7;
const NOW = () => new Date().toISOString();

const OBSERVED = (): ConstitutionObservedState => ({
  nowIso: NOW(), realisedDailyLossUsd: 0, realisedWeeklyLossUsd: 0,
  openPositionCount: 0, openExposureForSymbolUsd: 0, tradesTakenToday: 0,
  consecutiveLosses: 0, lastLossAtIso: null,
});

interface Spy { wireWrites: number; audits: string[]; claims: number; intents: number }

// Real fixtures. Only PERSISTENCE is substituted — the Constitution evaluator,
// ticket authorization, CAS semantics, venue router, tier resolver, dependency
// resolver and adapter are all the shipped modules.
const TERMS: MaterialTradeTerms = {
  userId: USER, broker: "deriv", accountRef: "VRTC1234", instrument: "R_100",
  side: "BUY", stakeUsd: 1, multiplier: 100, stopLossUsd: 0.5, takeProfitUsd: 2,
  intentId: "di_cert",
};

const TICKET = (): ApprovalTicket => ({
  ticketId: "tkt_cert", userId: USER, state: "APPROVED", terms: TERMS,
  approvedFingerprint: materialTermsFingerprint(TERMS), approvedByUserId: USER,
  createdAtIso: new Date(Date.now() - 60_000).toISOString(),
  expiresAtIso: new Date(Date.now() + 300_000).toISOString(),
  dispatchClaimedAtIso: null, constitutionVersion: 4,
  gateVerdictsPassed: true, disclosureWaivedByOperator: false,
});

const CONSTITUTION: TradingConstitution = {
  constitutionId: "con_cert", userId: USER, version: 4,
  allowedBrokers: ["deriv"], allowedAccountRefs: ["VRTC1234"],
  allowedInstruments: ["R_100"], allowedMarketCategories: ["synthetic_indices"],
  allowedSessionsUtc: [{ daysOfWeekUtc: [0, 1, 2, 3, 4, 5, 6], openMinuteUtc: 0, closeMinuteUtc: 1440 }],
  maxRiskPerTradeUsd: 5, maxDailyLossUsd: 20, maxWeeklyLossUsd: 50,
  maxSimultaneousPositions: 2, maxExposurePerSymbolUsd: 10, maxTradesPerDay: 3,
  requireStopLoss: true, requireTakeProfit: true,
  minStakeUsd: 1, maxStakeUsd: 5, minMultiplier: 100, maxMultiplier: 400,
  lossStreakCooldown: null, forbiddenInstruments: [], forbiddenConditions: [],
  rubyAuthority: "PREPARE_TICKET",
};

/**
 * Drive the REAL composition entry point.
 *
 * Persistence is unavailable here, so the repository calls it makes will throw
 * or return null. That is itself informative: the certificate asserts the
 * product REFUSES rather than proceeding, which is the correct behaviour when
 * it cannot read the state it needs.
 */
async function drive(over: {
  tier?: string | null;
  connectionOwner?: number;
  demoSource?: "VENUE_ACCOUNT_ATTRIBUTE" | "INFERRED_FROM_NAMING";
  isDemo?: boolean;
  killSwitch?: boolean;
  breakPersistence?: boolean;
} = {}): Promise<{ outcome: Awaited<ReturnType<typeof dispatchGuidedTicketForRequest>>; spy: Spy }> {
  const spy: Spy = { wireWrites: 0, audits: [], claims: 0, intents: 0 };
  const prev = process.env["ARX_EXECUTION_TIER"];
  if (over.tier === undefined) delete process.env["ARX_EXECUTION_TIER"];
  else if (over.tier === null) delete process.env["ARX_EXECUTION_TIER"];
  else process.env["ARX_EXECUTION_TIER"] = over.tier;

  try {
    const outcome = await dispatchGuidedTicketForRequest(
      { userId: USER, ticketId: "tkt_cert" },
      {
        // PERSISTENCE ONLY — see GuidedDispatchOverrides.
        loadOwnedTicket: async (id, uid) => {
          if (over.breakPersistence) throw new Error("database unreachable");
          return id === "tkt_cert" && uid === USER ? TICKET() : null;
        },
        loadActiveConstitution: async () => CONSTITUTION,
        deriveCurrentTerms: async (t) => t.terms,
        hasUnresolvedIntent: async () => false,
        claimForDispatch: async () => { spy.claims++; return { claimed: true }; },
        persistIntent: async () => { spy.intents++; return "di_cert"; },
        loadObservedState: async () => OBSERVED(),
        recordAudit: async (e) => { spy.audits.push(e.kind); },
        depSources: {
          loadConnection: async () => ({
            id: 11, ownerUserId: over.connectionOwner ?? USER,
            venue: "DERIV_DEMO", credentialHandle: "handle_server_side_only",
          }),
          loadAccount: async () => ({ accountRef: "VRTC1234", connectionId: 11 }),
          classifyAccount: async () => ({
            isDemo: over.isDemo ?? true,
            source: over.demoSource ?? "VENUE_ACCOUNT_ATTRIBUTE",
            evidence: "is_virtual=1",
          }),
          killSwitchEngaged: async () => over.killSwitch ?? false,
          hasUnresolvedIntent: async () => false,
        },
        // THE SPY. Any call is a wire write at a tier that forbids one.
        buyViaCertifiedTransport: async () => {
          spy.wireWrites++;
          return { replied: true, wireWritten: true, contractId: "MUST_NOT_EXIST", venueRejection: null, detail: "" };
        },
      },
    );
    return { outcome, spy };
  } finally {
    if (prev === undefined) delete process.env["ARX_EXECUTION_TIER"];
    else process.env["ARX_EXECUTION_TIER"] = prev;
  }
}

// ── L. THE HEADLINE: ZERO WIRE WRITES ─────────────────────────────────────
test("TIER 0 PRODUCT: the assembled path writes ZERO venue frames", async () => {
  const { outcome, spy } = await drive({ tier: "TIER_0_DRY_RUN" });
  assert.equal(spy.wireWrites, 0, "the product wrote a frame to the venue at TIER 0");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.venueContractRef, null, "a position was fabricated at TIER 0");
});

test("no tier value reachable through the environment produces a wire write", async () => {
  // The env var is the ONLY input a deployment controls. Every value it could
  // hold — including a lowercase valid tier and the two forbidden tiers — must
  // leave the wire untouched.
  for (const t of [undefined, null, "", "   ", "1", "true", "TIER_1", "tier_1_demo_guided",
                   "TIER_0_DRY_RUN", "TIER_3_LIVE_GUIDED", "TIER_4_AUTONOMOUS"] as (string | null | undefined)[]) {
    const { spy } = await drive({ tier: t as string | null });
    assert.equal(spy.wireWrites, 0, `ARX_EXECUTION_TIER=${JSON.stringify(t)} produced a wire write`);
  }
});

// ── the per-request dependency wall, through the PRODUCT path ─────────────
test("a connection owned by ANOTHER user never reaches the venue", async () => {
  const { outcome, spy } = await drive({ tier: "TIER_1_DEMO_GUIDED", connectionOwner: 999 });
  assert.equal(spy.wireWrites, 0, "request A consumed request B's connection and reached the venue");
  assert.equal(outcome.ok, false);
  // Assert WHY. Without this the test passes even when the dependency wall is
  // removed entirely — the call then fails on a TypeError instead, which also
  // writes nothing. "It refused" is not the same claim as "the ownership check
  // refused it", and only the second one is what this test is named after.
  assert.match(outcome.detail, /DERIV_DEPS_REFUSED:CONNECTION_NOT_OWNED_BY_USER/,
    `refused for the wrong reason: ${outcome.detail}`);
});

test("DEMO inferred from naming never reaches the venue, even at TIER 1", async () => {
  const { outcome, spy } = await drive({ tier: "TIER_1_DEMO_GUIDED", demoSource: "INFERRED_FROM_NAMING" });
  assert.equal(spy.wireWrites, 0, "a naming-based demo inference was allowed to trade");
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /ACCOUNT_DEMO_STATUS_UNPROVEN/, `refused for the wrong reason: ${outcome.detail}`);
});

test("a venue-classified LIVE account never reaches the venue", async () => {
  const { outcome, spy } = await drive({ tier: "TIER_1_DEMO_GUIDED", isDemo: false });
  assert.equal(spy.wireWrites, 0, "a real-money account reached the venue");
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /ACCOUNT_IS_LIVE_MONEY/, `refused for the wrong reason: ${outcome.detail}`);
});

test("the kill switch stops the product path", async () => {
  const { outcome, spy } = await drive({ tier: "TIER_1_DEMO_GUIDED", killSwitch: true });
  assert.equal(spy.wireWrites, 0);
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /KILL_SWITCH_ENGAGED/, `refused for the wrong reason: ${outcome.detail}`);
});

test("THE WALLS ARE REACHED, not merely bypassed by an earlier failure", async () => {
  // Guards against the trap this certificate fell into once: with no database
  // the ticket load threw first, so every "X never reaches the venue" test was
  // true because NOTHING reached the venue. Persistence is now substituted, so
  // the dispatch genuinely runs to the adapter and the walls actually fire.
  const { spy } = await drive({ tier: "TIER_1_DEMO_GUIDED" });
  assert.equal(spy.claims, 1,
    "the CAS claim never ran — the dispatch stopped before the walls under test");
});

test("the product REFUSES when it cannot read the state it needs", async () => {
  // Real infrastructure failure: the repository throws. Refusing is correct;
  // proceeding on unreadable state is how a blown account keeps trading. This
  // region is pre-transmission by construction, so a definite refusal is honest.
  const { outcome, spy } = await drive({
    tier: "TIER_1_DEMO_GUIDED",
    breakPersistence: true,
  });
  assert.equal(outcome.ok, false, "the product proceeded without being able to read its own state");
  assert.equal(spy.wireWrites, 0);
});

// ── the composition point is singular ─────────────────────────────────────
test("there is exactly ONE composition point for a guided dispatch", () => {
  // A second one would be a second dispatch path, and a second path is a bypass.
  const routes = readFileSync(new URL("../../../routes/meApprovalInbox.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(routes, /dispatchGuidedTicketForRequest/,
    "the dispatch route does not delegate to the composition point");
  assert.ok(!/DerivExecutionAdapter/.test(routes),
    "the route constructs an adapter directly, bypassing dependency resolution");
  assert.ok(!/claimTicketForDispatch/.test(routes),
    "the route performs its own CAS claim, creating a second dispatch path");
});

test("the route never exposes a credential handle or token", () => {
  const routes = readFileSync(new URL("../../../routes/meApprovalInbox.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["credentialHandle", "DERIV_API_TOKEN", "authorization"]) {
    assert.ok(!new RegExp(forbidden, "i").test(routes),
      `the approval-inbox route references ${forbidden}`);
  }
  // And the wire shape is an allow-list, not a spread.
  assert.ok(!/\.\.\.t\b/.test(routes), "the wire shape spreads the row instead of naming fields");
});

// ── lineage completeness for a dry run ────────────────────────────────────
test("a TIER 0 attempt produces a complete, honest lineage", () => {
  const base = {
    intentId: "di_cert", ticketId: "tkt_cert", userId: USER, liveCommandId: "gc_cert",
    occurredAtIso: NOW(), constitutionVersion: 4, venueContractRef: null,
    scannerSignalId: "sig_1", rubyExplanation: "trend continuation",
  };
  const records: GuidedLineageRecord[] = [
    buildLineageRecord({ ...base, event: "PROPOSAL_CREATED", detail: "scanner setup" }),
    buildLineageRecord({ ...base, event: "USER_APPROVED", detail: "approved by owner" }),
    buildLineageRecord({ ...base, event: "DISPATCH_CLAIMED", detail: "CAS won" }),
    buildLineageRecord({ ...base, event: "DRY_RUN_REFUSED", detail: "tier forbids send" }),
  ];
  const r = reconstructAttempt(records);
  assert.equal(r.intentId, "di_cert", "the attempt cannot be reconstructed from one id");
  assert.equal(r.complete, true);
  assert.equal(r.venueContractRef, null, "a dry run produced a contract reference");
  assert.equal(r.state, "CLOSED");
  assert.deepEqual(r.events,
    ["PROPOSAL_CREATED", "USER_APPROVED", "DISPATCH_CLAIMED", "DRY_RUN_REFUSED"]);
});

test("an UNKNOWN attempt reads honestly end to end", () => {
  const base = {
    intentId: "di_unk", ticketId: "tkt_unk", userId: USER, liveCommandId: "gc_unk",
    occurredAtIso: NOW(), constitutionVersion: 4, venueContractRef: null,
    scannerSignalId: null, rubyExplanation: null,
  };
  const r = reconstructAttempt([
    buildLineageRecord({ ...base, event: "DISPATCH_CLAIMED", detail: "claimed" }),
    buildLineageRecord({ ...base, event: "EXECUTION_UNKNOWN", detail: "frame written, no reply" }),
  ]);
  assert.equal(r.state, "UNRESOLVED");
  assert.equal(r.complete, false, "an unknown attempt was reported complete");
  assert.equal(positionStateForEvent("EXECUTION_UNKNOWN"), "UNRESOLVED");
});

// ── the guards that make the above durable ────────────────────────────────
test("the guard set covering these surfaces is registered in the runner", () => {
  const runner = readFileSync(new URL("../../../../../../scripts/src/ci/run-all.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const g of ["checkVaultMutations", "checkExecutionVenueExplicit", "checkPhase6ExecutionSafety"]) {
    assert.match(runner, new RegExp(`\\b${g}\\b[\\s\\S]*\\b${g}\\b`),
      `${g} is imported but not registered in the guard list (or vice versa)`);
  }
});

// ── the DEFAULTS, exercised without an override shadowing them ────────────
test("with NO transport wired, the product refuses rather than fabricating a position", async () => {
  // The certificate normally injects a spy transport, which shadows the default.
  // The default itself must refuse: a stub returning success would invent a
  // contract id and the whole lineage would record a trade that never happened.
  const prev = process.env["ARX_EXECUTION_TIER"];
  process.env["ARX_EXECUTION_TIER"] = "TIER_1_DEMO_GUIDED";
  try {
    const outcome = await dispatchGuidedTicketForRequest(
      { userId: USER, ticketId: "tkt_cert" },
      {
        loadOwnedTicket: async () => TICKET(),
        loadActiveConstitution: async () => CONSTITUTION,
        deriveCurrentTerms: async (t) => t.terms,
        hasUnresolvedIntent: async () => false,
        claimForDispatch: async () => ({ claimed: true }),
        persistIntent: async () => "di_cert",
        loadObservedState: async () => OBSERVED(),
        recordAudit: async () => {},
        depSources: {
          loadConnection: async () => ({ id: 11, ownerUserId: USER, venue: "DERIV_DEMO", credentialHandle: "h" }),
          loadAccount: async () => ({ accountRef: "VRTC1234", connectionId: 11 }),
          classifyAccount: async () => ({ isDemo: true, source: "VENUE_ACCOUNT_ATTRIBUTE", evidence: "is_virtual=1" }),
          killSwitchEngaged: async () => false,
          hasUnresolvedIntent: async () => false,
        },
        // NO buyViaCertifiedTransport — the default must refuse.
      },
    );
    assert.equal(outcome.ok, false, "an unwired transport produced a successful trade");
    assert.equal(outcome.venueContractRef, null, "an unwired transport fabricated a contract reference");
    assert.match(outcome.detail, /DERIV_TRANSPORT_NOT_WIRED/, `wrong refusal: ${outcome.detail}`);
    // DEFINITE, not indeterminate: nothing was sent and we know it, so holding
    // an exposure reservation for this would strand it for no reason.
    assert.equal(outcome.indeterminate, false,
      "a known-unwired transport was recorded as possibly-sent, stranding exposure");
  } finally {
    if (prev === undefined) delete process.env["ARX_EXECUTION_TIER"];
    else process.env["ARX_EXECUTION_TIER"] = prev;
  }
});

test("with NO observed state wired, the Constitution refuses on unreadable inputs", async () => {
  // The default must read as UNUSABLE, not as zero loss. Defaulting to zero
  // would let a blown account keep trading, which is the inversion the whole
  // default-deny posture exists to prevent.
  const prev = process.env["ARX_EXECUTION_TIER"];
  process.env["ARX_EXECUTION_TIER"] = "TIER_1_DEMO_GUIDED";
  try {
    const outcome = await dispatchGuidedTicketForRequest(
      { userId: USER, ticketId: "tkt_cert" },
      {
        loadOwnedTicket: async () => TICKET(),
        loadActiveConstitution: async () => CONSTITUTION,
        deriveCurrentTerms: async (t) => t.terms,
        hasUnresolvedIntent: async () => false,
        claimForDispatch: async () => ({ claimed: true }),
        recordAudit: async () => {},
        buyViaCertifiedTransport: async () => {
          throw new Error("THE TRANSPORT MUST NOT BE REACHED ON UNREADABLE STATE");
        },
        // NO loadObservedState — the default must be unusable.
      },
    );
    assert.equal(outcome.ok, false, "the product traded on unreadable account state");
    assert.equal(outcome.refusal, "CONSTITUTION_REFUSED",
      `expected a Constitution refusal on unreadable state, got ${outcome.refusal}: ${outcome.detail}`);
    assert.match(outcome.detail, /CONSTITUTION_MALFORMED/, `wrong refusal: ${outcome.detail}`);
  } finally {
    if (prev === undefined) delete process.env["ARX_EXECUTION_TIER"];
    else process.env["ARX_EXECUTION_TIER"] = prev;
  }
});
