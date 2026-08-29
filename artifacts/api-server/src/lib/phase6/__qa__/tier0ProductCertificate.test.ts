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
import {
  dispatchGuidedTicketForRequest, applyLiveSettlement, serializeGuidedDispatch,
  type SettlementRepos,
} from "../guidedDispatchEntry.js";
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

interface Spy {
  wireWrites: number; audits: string[]; claims: number; intents: number;
  settlements: Array<{ outcome: string; ref: string | null; indeterminate: boolean }>;
}

// Real fixtures. Only PERSISTENCE is substituted — the Constitution evaluator,
// ticket authorization, CAS semantics, venue router, tier resolver, dependency
// resolver and adapter are all the shipped modules.
// REALISTIC ids, deliberately. The last round of short fixture ids ("di_cert")
// hid a production break: real prefixed-UUID ids tripped the opaque-token
// heuristic and every inbox response threw. Fixtures now match production shape.
const TKT = "tkt_3ce69bcf-da83-419b-859a-d963ec1ee7ce";
const INTENT = `di_${TKT}`;

const TERMS: MaterialTradeTerms = {
  userId: USER, broker: "deriv", accountRef: "VRTC1234", instrument: "R_100",
  side: "BUY", stakeUsd: 1, multiplier: 100, stopLossUsd: 0.5, takeProfitUsd: 2,
  intentId: INTENT,
};

const TICKET = (): ApprovalTicket => ({
  ticketId: TKT, userId: USER, state: "APPROVED", terms: TERMS,
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
  disclosure?: "accepted" | "waived" | "none";
  loseClaim?: boolean;
  /** #34 probation read (persistence substitute). Default: no active probation. */
  probation?: import("../../recoveryProbation.js").EffectiveProbation;
} = {}): Promise<{ outcome: Awaited<ReturnType<typeof dispatchGuidedTicketForRequest>>; spy: Spy }> {
  const spy: Spy = { wireWrites: 0, audits: [], claims: 0, intents: 0, settlements: [] };
  const prev = process.env["ARX_EXECUTION_TIER"];
  if (over.tier === undefined) delete process.env["ARX_EXECUTION_TIER"];
  else if (over.tier === null) delete process.env["ARX_EXECUTION_TIER"];
  else process.env["ARX_EXECUTION_TIER"] = over.tier;

  try {
    const outcome = await dispatchGuidedTicketForRequest(
      { userId: USER, ticketId: TKT },
      {
        // PERSISTENCE ONLY — see GuidedDispatchOverrides.
        loadOwnedTicket: async (id, uid) => {
          if (over.breakPersistence) throw new Error("database unreachable");
          return id === TKT && uid === USER ? TICKET() : null;
        },
        loadActiveConstitution: async () => CONSTITUTION,
        deriveCurrentTerms: async (t) => t.terms,
        hasUnresolvedIntent: async () => false,
        claimForDispatch: async () => {
          spy.claims++;
          return over.loseClaim ? null : { claimed: true };
        },
        persistIntent: async () => { spy.intents++; return INTENT; },
        loadObservedState: async () => OBSERVED(),
        disclosureStatus: async () => ({
          accepted: (over.disclosure ?? "accepted") === "accepted",
          waivedByOperator: over.disclosure === "waived",
        }),
        serializeDispatch: async <T,>(_uid: number, fn: () => Promise<T>) => ({ acquired: true, value: await fn() }),
        resolveProbation: async () => over.probation ?? { kind: "none" as const },
        recordAudit: async (e) => { spy.audits.push(e.kind); },
        applySettlement: async (o) => {
          spy.settlements.push({
            outcome: o.ok ? "EXECUTED" : o.indeterminate ? "UNRESOLVED" : "REJECTED",
            ref: o.venueContractRef, indeterminate: o.indeterminate,
          });
        },
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
    intentId: "di_cert", ticketId: TKT, userId: USER, liveCommandId: "gc_cert",
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
test("with NO transport override, the LIVE path runs and still fabricates nothing", async () => {
  // The default is no longer a stub — it is the real guidedBuy over the
  // certified Phase 5 transport. In an environment with no Deriv config that
  // resolves to a DEFINITE refusal (wireWritten false, nothing constructed),
  // which is the property that matters: no contract id is invented, and a
  // provable non-transmission is NOT held open as UNKNOWN.
  const prev = process.env["ARX_EXECUTION_TIER"];
  process.env["ARX_EXECUTION_TIER"] = "TIER_1_DEMO_GUIDED";
  try {
    const outcome = await dispatchGuidedTicketForRequest(
      { userId: USER, ticketId: TKT },
      {
        loadOwnedTicket: async () => TICKET(),
        loadActiveConstitution: async () => CONSTITUTION,
        deriveCurrentTerms: async (t) => t.terms,
        hasUnresolvedIntent: async () => false,
        claimForDispatch: async () => ({ claimed: true }),
        persistIntent: async () => INTENT,
        loadObservedState: async () => OBSERVED(),
        disclosureStatus: async () => ({ accepted: true, waivedByOperator: false }),
        serializeDispatch: async <T,>(_uid: number, fn: () => Promise<T>) => ({ acquired: true, value: await fn() }),
        resolveProbation: async () => ({ kind: "none" as const }),
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
    assert.equal(outcome.ok, false, "the live path produced a successful trade with no Deriv config");
    assert.equal(outcome.venueContractRef, null, "a contract reference was fabricated");
    // DEFINITE, not indeterminate: nothing was sent and we know it, so holding
    // an exposure reservation for this would strand it for no reason.
    assert.equal(outcome.indeterminate, false,
      "a known-unwired transport was recorded as possibly-sent, stranding exposure");
  } finally {
    if (prev === undefined) delete process.env["ARX_EXECUTION_TIER"];
    else process.env["ARX_EXECUTION_TIER"] = prev;
  }
});

test("with NO observed state wired, the product still refuses — never trades blind", async () => {
  // The default is now the LIVE guided-ledger loader. In an environment where
  // that read fails (no database here), the pre-transmission wrapper turns the
  // throw into a DEFINITE refusal. The property under certification is
  // unchanged: unreadable account state must refuse, never read as zero loss —
  // only the refusal now arrives via the infra wrapper instead of a NaN
  // sentinel, because production needs the real loader to dispatch at all.
  const prev = process.env["ARX_EXECUTION_TIER"];
  process.env["ARX_EXECUTION_TIER"] = "TIER_1_DEMO_GUIDED";
  try {
    const outcome = await dispatchGuidedTicketForRequest(
      { userId: USER, ticketId: TKT },
      {
        loadOwnedTicket: async () => TICKET(),
        loadActiveConstitution: async () => CONSTITUTION,
        deriveCurrentTerms: async (t) => t.terms,
        hasUnresolvedIntent: async () => false,
        claimForDispatch: async () => ({ claimed: true }),
        disclosureStatus: async () => ({ accepted: true, waivedByOperator: false }),
        serializeDispatch: async <T,>(_uid: number, fn: () => Promise<T>) => ({ acquired: true, value: await fn() }),
        resolveProbation: async () => ({ kind: "none" as const }),
        recordAudit: async () => {},
        buyViaCertifiedTransport: async () => {
          throw new Error("THE TRANSPORT MUST NOT BE REACHED ON UNREADABLE STATE");
        },
        // NO loadObservedState — the default must be unusable.
      },
    );
    assert.equal(outcome.ok, false, "the product traded on unreadable account state");
    assert.equal(outcome.indeterminate, false,
      "an unreadable PRE-transmission state was reported as possibly-sent");
    // Two legitimate pre-transmission refusal families exist, and which one
    // fires is environmental: with no readable database the default
    // observed-state loader fails (the original path this test certified);
    // on a live environment the cold-platform doorway's ENGAGED kill switch
    // refuses even earlier. Both are DEFINITE refusals in which the transport
    // stub above was provably never reached — the certified property.
    assert.match(outcome.detail,
      /nothing was sent|could not establish dispatch preconditions|KILL_SWITCH_ENGAGED/,
      `the refusal is not a recognized pre-transmission refusal: ${outcome.detail}`);
  } finally {
    if (prev === undefined) delete process.env["ARX_EXECUTION_TIER"];
    else process.env["ARX_EXECUTION_TIER"] = prev;
  }
});

// ── settlement: the ticket must leave DISPATCHING on every outcome ────────
test("a SUCCESSFUL dispatch settles EXECUTED with the venue's reference", async () => {
  // Before settlement existed, nothing moved a ticket out of DISPATCHING or an
  // intent out of NOT_ATTEMPTED even on success: the ticket held its
  // active-instrument slot forever, and the real exposure was INVISIBLE to
  // hasUnresolvedIntent — the very order that must block the next one did not.
  const prev = process.env["ARX_EXECUTION_TIER"];
  process.env["ARX_EXECUTION_TIER"] = "TIER_1_DEMO_GUIDED";
  try {
    const spy: Spy = { wireWrites: 0, audits: [], claims: 0, intents: 0, settlements: [] };
    let executedEvent: { venueContractRef?: string; intentId?: string } | undefined;
    const outcome = await dispatchGuidedTicketForRequest(
      { userId: USER, ticketId: TKT },
      {
        loadOwnedTicket: async () => TICKET(),
        loadActiveConstitution: async () => CONSTITUTION,
        deriveCurrentTerms: async (t) => t.terms,
        hasUnresolvedIntent: async () => false,
        claimForDispatch: async () => ({ claimed: true }),
        persistIntent: async () => INTENT,
        loadObservedState: async () => OBSERVED(),
        disclosureStatus: async () => ({ accepted: true, waivedByOperator: false }),
        serializeDispatch: async <T,>(_uid: number, fn: () => Promise<T>) => ({ acquired: true, value: await fn() }),
        resolveProbation: async () => ({ kind: "none" as const }),
        recordAudit: async (e) => {
          spy.audits.push(e.kind);
          if (e.kind === "GUIDED_DISPATCH_EXECUTED") executedEvent = e;
        },
        applySettlement: async (o) => {
          spy.settlements.push({
            outcome: o.ok ? "EXECUTED" : o.indeterminate ? "UNRESOLVED" : "REJECTED",
            ref: o.venueContractRef, indeterminate: o.indeterminate,
          });
        },
        depSources: {
          loadConnection: async () => ({ id: 11, ownerUserId: USER, venue: "DERIV_DEMO", credentialHandle: "h" }),
          loadAccount: async () => ({ accountRef: "VRTC1234", connectionId: 11 }),
          classifyAccount: async () => ({ isDemo: true, source: "VENUE_ACCOUNT_ATTRIBUTE", evidence: "account_type=demo" }),
          killSwitchEngaged: async () => false,
          hasUnresolvedIntent: async () => false,
        },
        buyViaCertifiedTransport: async () => ({
          replied: true, wireWritten: true, contractId: "10548672559", venueRejection: null, detail: "bought",
        }),
      },
    );
    assert.equal(outcome.ok, true, `success path refused: ${outcome.detail}`);
    assert.equal(outcome.venueContractRef, "10548672559");
    assert.deepEqual(spy.settlements, [{ outcome: "EXECUTED", ref: "10548672559", indeterminate: false }],
      "the ticket was left DISPATCHING after a successful venue order");
    // And the EXECUTED audit event carried the venue facts, so the real ledger
    // writer's honesty check accepts the row rather than rejecting the success.
    assert.ok(spy.audits.includes("GUIDED_DISPATCH_EXECUTED"));
    assert.equal(executedEvent?.venueContractRef, "10548672559",
      "the EXECUTED audit event lost the venue reference — the real ledger writer would refuse the row");
    assert.equal(executedEvent?.intentId, INTENT,
      "the EXECUTED audit event lost the intent id — lineage would fall back to a derived id");
  } finally {
    if (prev === undefined) delete process.env["ARX_EXECUTION_TIER"];
    else process.env["ARX_EXECUTION_TIER"] = prev;
  }
});

test("a DRY RUN settles the ticket too — it must not hold the instrument slot forever", async () => {
  const { outcome, spy } = await drive({ tier: "TIER_0_DRY_RUN" });
  assert.equal(outcome.ok, false);
  assert.deepEqual(spy.settlements, [{ outcome: "REJECTED", ref: null, indeterminate: false }],
    "a dry-run ticket was left DISPATCHING, blocking the instrument until manual repair");
});

test("the REAL ledger writer accepts a successful trade's own audit row", () => {
  // The exact row the success path produces: EXECUTED + realistic ids + venue
  // ref. This threw twice over before: venueContractRef was hard-coded null
  // (honesty check refused EXECUTED), and the realistic intent id tripped the
  // secret heuristic.
  assert.doesNotThrow(() => buildLineageRecord({
    intentId: INTENT, ticketId: TKT, userId: USER, liveCommandId: `gc_${TKT}`,
    event: "EXECUTED", occurredAtIso: NOW(), constitutionVersion: 4,
    venueContractRef: "10548672559", detail: "venue contract 10548672559",
    scannerSignalId: "tier1-certification", rubyExplanation: null,
  }), "the ledger honesty check rejects the success path's own record");
});

// ── the LIVE settlement mapping, exercised as real code ───────────────────
function settlementSpies() {
  const calls: string[] = [];
  const repos: SettlementRepos = {
    settleDispatchedTicket: async (a) => { calls.push(`settle:${a.outcome}:${a.venueContractRef ?? a.rejectionSource ?? ""}`); return {}; },
    markUnrecorded: async (i) => { calls.push(`unrecorded:${i}`); return {}; },
    resolveWithVenueContract: async (a) => { calls.push(`resolveVenue:${a.venueContractRef}`); return {}; },
    resolveAsVenueRejected: async (i) => { calls.push(`venueRejected:${i}`); return {}; },
    markRefusedPreTransmission: async (i) => { calls.push(`preTransmission:${i}`); return {}; },
  };
  return { calls, repos };
}
const OUT = (over: Partial<Parameters<typeof applyLiveSettlement>[0]> = {}) => ({
  ok: false, refusal: null, detail: "", venueContractRef: null, indeterminate: false,
  intentId: INTENT, claimed: true, ...over,
} as Parameters<typeof applyLiveSettlement>[0]);

test("LIVE settlement: success -> EXECUTED with ref, intent venue-resolved", async () => {
  // The certificate's spy replaced the inline version of this mapping, so a
  // mutation gutting the success branch survived. This drives the REAL one.
  const { calls, repos } = settlementSpies();
  await applyLiveSettlement(OUT({ ok: true, venueContractRef: "10548672559" }), TKT, repos);
  assert.deepEqual(calls, [
    "settle:EXECUTED:10548672559", `unrecorded:${INTENT}`, "resolveVenue:10548672559",
  ]);
});

test("LIVE settlement: indeterminate -> UNRESOLVED, intent left blocking", async () => {
  const { calls, repos } = settlementSpies();
  await applyLiveSettlement(OUT({ indeterminate: true }), TKT, repos);
  assert.deepEqual(calls, ["settle:UNRESOLVED:", `unrecorded:${INTENT}`]);
  assert.ok(!calls.some((c) => c.startsWith("resolveVenue") || c.startsWith("venueRejected") || c.startsWith("preTransmission")),
    "an indeterminate outcome RESOLVED the intent — nothing would block the next order");
});

test("LIVE settlement: venue rejection -> REJECTED/SYSTEM_GATE, intent venue-adjudicated", async () => {
  const { calls, repos } = settlementSpies();
  await applyLiveSettlement(OUT({ detail: "DERIV_VENUE_REJECTED: InsufficientBalance" }), TKT, repos);
  assert.deepEqual(calls, ["settle:REJECTED:SYSTEM_GATE", `venueRejected:${INTENT}`]);
});

test("LIVE settlement: pre-transmission refusal -> REJECTED, intent refused-pre-transmission", async () => {
  const { calls, repos } = settlementSpies();
  await applyLiveSettlement(OUT({ detail: "DERIV_DEPS_REFUSED:KILL_SWITCH_ENGAGED: engaged" }), TKT, repos);
  assert.deepEqual(calls, ["settle:REJECTED:SYSTEM_PRE_TRANSMISSION", `preTransmission:${INTENT}`]);
});

test("LIVE settlement: no intent id settles the ticket only — never a phantom intent", async () => {
  const { calls, repos } = settlementSpies();
  await applyLiveSettlement(OUT({ ok: true, venueContractRef: "c1", intentId: null }), TKT, repos);
  assert.deepEqual(calls, ["settle:EXECUTED:c1"]);
});

test("GATE 18: no disclosure and no waiver refuses BEFORE the claim", async () => {
  const { outcome, spy } = await drive({ tier: "TIER_1_DEMO_GUIDED", disclosure: "none" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /DISCLOSURE_NOT_ACCEPTED/, `wrong refusal: ${outcome.detail}`);
  assert.equal(spy.claims, 0, "an unconsented dispatch claimed the ticket");
  assert.equal(spy.wireWrites, 0, "an unconsented dispatch reached the venue");
  // Pre-claim by design: the ticket stays APPROVED, so accepting the
  // disclosure later lets the SAME ticket dispatch.
  assert.deepEqual(spy.settlements, [], "a pre-claim refusal settled the ticket");
});

test("GATE 18: an operator waiver permits dispatch but is not the user's consent", async () => {
  const { spy } = await drive({ tier: "TIER_0_DRY_RUN", disclosure: "waived" });
  assert.equal(spy.claims, 1, "an operator-waived dispatch was refused at the disclosure wall");
});

test("the LIVE kill-switch wiring consults the real switch and fails CLOSED", () => {
  // The audit found `killSwitchEngaged: async () => false` hard-stubbed in the
  // live wiring while the parity map claimed gate 5 was enforced. Certificate
  // spies shadow the live default, so this is pinned on stripped source: the
  // default must call liveKillSwitchEngaged, and that function's read-failure
  // path must return true — not being able to read the stop button is not
  // permission to trade.
  const entry = readFileSync(new URL("../guidedDispatchEntry.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/killSwitchEngaged:\s*async\s*\(\)\s*=>\s*false/.test(entry),
    "the live kill switch is hard-stubbed to disengaged");
  assert.match(entry, /killSwitchEngaged:\s*\(uid: number\) => liveKillSwitchEngaged\(uid\)/,
    "the live wiring does not consult the real kill switch");
  const fnAt = entry.indexOf("async function liveKillSwitchEngaged");
  const fn = entry.slice(fnAt, entry.indexOf("\n}", fnAt));
  assert.match(fn, /arxLiveArmingTable/, "the per-user switch is not read");
  assert.match(fn, /globalTradingSettingsTable/, "the global emergency switch is not read");
  assert.match(fn, /!== false/, "the emergency polarity is not fail-closed (absent must count as ENGAGED)");
  const catchAt = fn.indexOf("catch");
  assert.ok(catchAt > 0 && /return true/.test(fn.slice(catchAt)),
    "a read failure does not count as ENGAGED — an unreadable stop button permitted trading");
});

test("A CLAIM-LOSER'S OUTCOME SETTLES NOTHING — the winner owns the ticket", async () => {
  // Audit C2/C3/C4/C7: request A wins the CAS and is mid venue round-trip;
  // request B loses, and B's "definite refusal" settlement matched A's
  // DISPATCHING row — marking a real in-flight order REJECTED, "no order
  // exists". claimed:false must be an absolute bar on touching the ticket.
  const { calls, repos } = settlementSpies();
  await applyLiveSettlement(OUT({ claimed: false, refusal: "DISPATCH_CLAIM_LOST",
    detail: "another dispatcher already claimed this ticket" }), TKT, repos);
  assert.deepEqual(calls, [], "a claim-race loser settled the winner's in-flight ticket");
});

test("a LOST claim reaches no settlement at all — even a spy's", async () => {
  // The gate must bind at the call site: an injected settlement (this spy)
  // replaces applyLiveSettlement wholesale, so a gate inside that function
  // protects nothing here.
  const { outcome, spy } = await drive({ tier: "TIER_1_DEMO_GUIDED", loseClaim: true });
  assert.equal(outcome.refusal, "DISPATCH_CLAIM_LOST");
  assert.equal(outcome.claimed, false, "a lost claim reported claimed:true — settlement re-armed");
  assert.deepEqual(spy.settlements, [],
    "a claim-race loser's outcome reached settlement — the winner's ticket is at risk");
});

test("the SUCCESS outcome carries claimed:true, or nothing would ever settle", async () => {
  const { outcome, spy } = await drive({ tier: "TIER_0_DRY_RUN" });
  assert.equal(outcome.claimed, true, "a post-claim outcome lost its claimed flag");
  assert.equal(spy.settlements.length, 1);
});

test("the intent row is born UNRECORDED — the crash window has no gap", () => {
  // Only reachable live (the certificate injects persistIntent), so pinned on
  // stripped source: a NOT_ATTEMPTED birth means a crash between frame and
  // reply leaves no unresolved footprint, and nothing blocks the next order
  // while a real one may be open (audit C5).
  const entry = readFileSync(new URL("../guidedDispatchEntry.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const at = entry.indexOf("await derivOrderIntentsRepo.createIntent(");
  assert.ok(at > 0, "the live intent write is gone");
  const block = entry.slice(at, at + 700);
  assert.match(block, /writeDisposition: "UNRECORDED"/,
    "the intent is not born UNRECORDED — a crash mid-flight leaves no footprint");
  assert.ok(!/writeDisposition: "NOT_ATTEMPTED"/.test(block),
    "the intent is born NOT_ATTEMPTED — invisible to hasUnresolvedIntent");
});

// ── the LIVE serialization rule, driven as real code ──────────────────────
test("A CAPTURED OUTCOME WINS when the lock's COMMIT fails after the work ran", async () => {
  // Venue confirmed, settlement committed — then the lock client's COMMIT
  // throws (connection reaped during the venue round-trip). Reporting
  // "nothing was sent" here is a falsely-certain claim about a real order.
  const r = await serializeGuidedDispatch(1, async () => "THE-REAL-OUTCOME",
    async (_ns, _key, body) => { await body(); throw new Error("COMMIT failed: connection reset"); });
  assert.deepEqual(r, { acquired: true, value: "THE-REAL-OUTCOME" },
    "a completed dispatch was reported as not-run because the lock plumbing failed afterwards");
});

test("a lock failure BEFORE the work ran refuses — unserialized dispatch is untrusted", async () => {
  const r = await serializeGuidedDispatch(1, async () => "NEVER-RUNS",
    async () => { throw new Error("could not BEGIN"); });
  assert.deepEqual(r, { acquired: false });
});

test("a lost lock without running the work refuses", async () => {
  const r = await serializeGuidedDispatch(1, async () => "NEVER-RUNS",
    async () => ({ acquired: false }));
  assert.deepEqual(r, { acquired: false });
});

// ── #34 recovery probation pre-claim wall ─────────────────────────────────
test("PROBATION BLOCK_ALL refuses PRE-CLAIM: no claim, no intent, no wire write", async () => {
  const { outcome, spy } = await drive({ probation: { kind: "active", stage: "BLOCK_ALL" } });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.refusal, "TICKET_AUTHORIZATION_REFUSED");
  assert.match(outcome.detail, /RECOVERY_PROBATION_BLOCK/);
  assert.equal(outcome.claimed, false, "a probation refusal must never claim the ticket");
  assert.equal(spy.claims, 0);
  assert.equal(spy.intents, 0);
  assert.equal(spy.wireWrites, 0);
});

test("PROBATION UNREADABLE fails CLOSED pre-claim (a deployed layer that errors never silently passes)", async () => {
  const { outcome, spy } = await drive({ probation: { kind: "unreadable", reason: "probe failed" } });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.detail, /RECOVERY_PROBATION_UNREADABLE/);
  assert.equal(spy.claims, 0);
  assert.equal(spy.wireWrites, 0);
});

test("PROBATION at any non-BLOCK stage never adds a refusal to the guided path", async () => {
  // The dispatch proceeds past the probation wall into the ordinary chain —
  // whatever that chain decides, the probation layer contributed nothing.
  // (Full-success plumbing is certified by the existing tier cases.)
  for (const stage of ["PAPER_ONLY", "A_PLUS_ONLY", "REDUCED_SIZE"] as const) {
    const noProbation = await drive();
    const withProbation = await drive({ probation: { kind: "active", stage } });
    assert.equal(withProbation.outcome.ok, noProbation.outcome.ok, stage);
    if (!withProbation.outcome.ok) {
      assert.ok(!/RECOVERY_PROBATION/.test(withProbation.outcome.detail),
        `${stage} must not be the refusal reason on the proven-demo guided path`);
    }
  }
});
