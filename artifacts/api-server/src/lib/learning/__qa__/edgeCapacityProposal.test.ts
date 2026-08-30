// ═══════════════════════════════════════════════════════════════════════════
// HOLD 2 — CAPACITY ESTIMATES. Proposal / press / readout invariants.
//
// The four things this suite exists to make impossible:
//
//   1. A PROPOSAL NEVER WRITES. Not in behaviour (the pure builder mutates
//      nothing, not even its own input) and not in code (no evidence
//      collector and no proposal route may contain a write verb, ever).
//   2. INSUFFICIENT EVIDENCE YIELDS NO NUMBER. Not a zero, not a placeholder,
//      not a "provisional" figure a press could copy — null, with the exact
//      gaps named. And the USD ceiling is null even on a full PROPOSED
//      verdict, because no evidence in this system can produce it.
//   3. A RECORDED ESTIMATE FLIPS THE READOUT for that edge, and only for that
//      edge.
//   4. THE GATE STILL REFUSES an edge with no estimate — the deny-by-default
//      floor this whole surface sits on.
//
// IO-free and deterministic (the estimator is seeded). Offline `ci` lane.
// Run: pnpm --filter @workspace/api-server run test:edge-capacity-proposal
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const collectorSrc = readFileSync(path.join(here, "../edgeCapacityEvidence.ts"), "utf8");
const proposalRouteSrc = readFileSync(
  path.join(here, "../../../routes/adminEdgeCapacityProposals.ts"), "utf8");
const recordRouteSrc = readFileSync(
  path.join(here, "../../../routes/adminEdgeCapacity.ts"), "utf8");

const {
  buildEdgeCapacityProposal,
  CAPACITY_MIN_CLOSED_TRADES,
  CAPACITY_MIN_RESOLVED_DISPATCHES,
  CAPACITY_MIN_SLIPPAGE_SAMPLES,
} = await import("@workspace/domain/decision-intelligence");
const {
  readEdgeCapacityGate,
  summariseEdgeCapacityFleet,
  EDGE_CAPACITY_PROBE_CANDIDATE_USD,
} = await import("@workspace/domain/safety-contracts");

type Evidence = Parameters<typeof buildEdgeCapacityProposal>[0];

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Today's real state for every edge in this repository: an edge exists, and
 *  nothing has ever traded under it. */
function emptyEvidence(edgeId = 1): Evidence {
  return {
    edgeId,
    gatheredAt: "2026-08-29T00:00:00.000Z",
    realizedRMultiples: [],
    realizedReadFailure: null,
    closedPositionsAttributed: 0,
    closedPositionsDropped: [],
    dispatch: { filled: 0, rejected: 0, expired: 0, stillInFlight: 0 },
    dispatchReadFailure: null,
    partialFillMean01: null,
    partialFillSamples: 0,
    slippageRSamples: [],
    venueFailureObservations: { failures: 0, ofClosed: 0 },
    venueFailureSlipMultiplier: null,
  };
}

/** A hypothetical edge with enough recorded evidence to clear every floor.
 *  Deterministic, not random: 24 wins at +1.5R, 16 losses at −1R. */
function sufficientEvidence(edgeId = 2): Evidence {
  const rMultiples = [
    ...Array.from({ length: 24 }, () => 1.5),
    ...Array.from({ length: 16 }, () => -1),
  ];
  return {
    edgeId,
    gatheredAt: "2026-08-29T00:00:00.000Z",
    realizedRMultiples: rMultiples,
    realizedReadFailure: null,
    closedPositionsAttributed: 40,
    closedPositionsDropped: [],
    dispatch: { filled: 44, rejected: 3, expired: 1, stillInFlight: 2 },
    dispatchReadFailure: null,
    partialFillMean01: 0.98,
    partialFillSamples: 44,
    slippageRSamples: Array.from({ length: 25 }, () => 0.02),
    venueFailureObservations: { failures: 0, ofClosed: 40 },
    venueFailureSlipMultiplier: null,
  };
}

// ═══ 1. A PROPOSAL NEVER WRITES ════════════════════════════════════════════

test("a proposal never writes: the pure builder mutates nothing, not even its input", () => {
  const ev = sufficientEvidence();
  const before = JSON.stringify(ev);
  const a = buildEdgeCapacityProposal(ev);
  const b = buildEdgeCapacityProposal(ev);
  assert.equal(JSON.stringify(ev), before, "the evidence snapshot must come back untouched");
  assert.deepEqual(a, b, "same evidence must give the same proposal — no hidden state");
});

test("a proposal never writes: a deeply frozen evidence snapshot is accepted", () => {
  const ev = Object.freeze({
    ...sufficientEvidence(),
    realizedRMultiples: Object.freeze(sufficientEvidence().realizedRMultiples!.slice()),
    dispatch: Object.freeze(sufficientEvidence().dispatch!),
    slippageRSamples: Object.freeze(sufficientEvidence().slippageRSamples!.slice()),
  }) as Evidence;
  // Would throw in strict mode on any attempted mutation.
  const p = buildEdgeCapacityProposal(ev);
  assert.equal(p.verdict, "PROPOSED");
});

test("SOURCE PIN: the evidence collector contains no write verb, in any form", () => {
  for (const verb of ["db.update(", "db.insert(", "db.delete(", ".returning(", "execute("]) {
    assert.ok(!collectorSrc.includes(verb),
      `the capacity evidence collector must never contain ${verb} — a proposal that can write is not a proposal`);
  }
});

test("SOURCE PIN: the proposals route contains no write verb and never reads the promotion ladder", () => {
  for (const verb of ["db.update(", "db.insert(", "db.delete(", ".returning("]) {
    assert.ok(!proposalRouteSrc.includes(verb),
      `the proposals route must never contain ${verb}`);
  }
  const codeOnly = proposalRouteSrc.split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  for (const ladder of [
    "productionEdgesTable.status", "productionEdgesTable.liveAllowed",
    "productionEdgesTable.adminApproved", "productionEdgesTable.shadowValidated",
    "productionEdgesTable.reportHash", "productionEdgesTable.validationReportJson",
  ]) {
    assert.ok(!codeOnly.includes(ladder),
      `the capacity proposals surface must not read the promotion column ${ladder} — capacity and promotion are different gates`);
  }
  assert.ok(proposalRouteSrc.includes("router.get("), "the proposals surface is a GET");
  assert.ok(!proposalRouteSrc.includes("router.post("), "the proposals surface has no POST");
});

test("SOURCE PIN: the recording route stamps ADMIN authorship on what it writes", () => {
  assert.ok(recordRouteSrc.includes(`authoredBy: "ADMIN"`),
    "a recorded estimate must say, in the row itself, that an admin authored it");
  assert.ok(recordRouteSrc.includes("pressedByAdminId: admin.id"),
    "the recorded evidence must name WHO pressed");
  assert.ok(recordRouteSrc.includes("capacityRecordedByAdminId: admin.id"),
    "the dedicated provenance column must carry the presser's id");
  // The proposal is context, never authority: no branch may read it.
  assert.ok(!recordRouteSrc.includes("proposalAtPress.") && !recordRouteSrc.includes("proposalAtPress?"),
    "the press must never branch on what the proposal said");
});

// ═══ 2. INSUFFICIENT EVIDENCE YIELDS NO NUMBER ═════════════════════════════

test("today's real state (an edge with no trades) proposes NO number and names what is missing", () => {
  const p = buildEdgeCapacityProposal(emptyEvidence(7));
  assert.equal(p.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(p.confidence, "NONE");
  assert.equal(p.proposedCapacityRiskR, null, "no capacity_risk_r may be proposed");
  assert.equal(p.proposedCapacityStatus, null, "no capacity_status may be proposed");
  assert.equal(p.proposedMaxDeployedUsd, null);
  assert.equal(p.simulatorInput, null, "the simulator must not have run at all");
  assert.equal(p.estimate, null);
  assert.ok(p.gaps.length >= 3, "every missing leg must be named separately");
  const codes = p.gaps.map((g) => g.code);
  assert.ok(codes.includes("NO_CLOSED_TRADES_ATTRIBUTED"));
  assert.ok(codes.includes("NO_RESOLVED_DISPATCHES"));
  assert.ok(codes.includes("SLIPPAGE_NOT_MEASURED"));
  for (const g of p.gaps) {
    assert.ok(g.missing.length > 20, `gap ${g.code} must say what is missing`);
    assert.ok(g.wouldBeSettledBy.length > 20, `gap ${g.code} must say what would settle it`);
  }
});

test("no number leaks through ANY single missing leg", () => {
  const cases: Array<[string, Evidence]> = [
    ["one trade short of the floor", {
      ...sufficientEvidence(),
      realizedRMultiples: sufficientEvidence().realizedRMultiples!.slice(0, CAPACITY_MIN_CLOSED_TRADES - 1),
      closedPositionsAttributed: CAPACITY_MIN_CLOSED_TRADES - 1,
    }],
    ["one dispatch short of the floor", {
      ...sufficientEvidence(),
      dispatch: { filled: CAPACITY_MIN_RESOLVED_DISPATCHES - 2, rejected: 1, expired: 0, stillInFlight: 0 },
    }],
    ["one slippage sample short of the floor", {
      ...sufficientEvidence(),
      slippageRSamples: Array.from({ length: CAPACITY_MIN_SLIPPAGE_SAMPLES - 1 }, () => 0.02),
    }],
    ["all trades won — no measurable loss", {
      ...sufficientEvidence(),
      realizedRMultiples: Array.from({ length: 40 }, () => 1.2),
    }],
    ["all trades lost — no measurable win", {
      ...sufficientEvidence(),
      realizedRMultiples: Array.from({ length: 40 }, () => -1),
    }],
    ["realized read failed outright", {
      ...sufficientEvidence(),
      realizedRMultiples: null,
      realizedReadFailure: "connection terminated",
    }],
    ["dispatch read failed outright", {
      ...sufficientEvidence(),
      dispatch: null,
      dispatchReadFailure: "connection terminated",
    }],
    ["venue failures observed but their magnitude was never measured", {
      ...sufficientEvidence(),
      venueFailureObservations: { failures: 3, ofClosed: 40 },
      venueFailureSlipMultiplier: null,
    }],
  ];
  for (const [label, ev] of cases) {
    const p = buildEdgeCapacityProposal(ev);
    assert.equal(p.verdict, "INSUFFICIENT_EVIDENCE", `${label}: must not propose`);
    assert.equal(p.proposedCapacityRiskR, null, `${label}: must carry no number`);
    assert.equal(p.proposedCapacityStatus, null, `${label}: must carry no status`);
    assert.equal(p.simulatorInput, null, `${label}: the simulator must not run`);
    assert.ok(p.gaps.length > 0, `${label}: must name the gap`);
  }
});

test("an insufficient proposal never degrades a missing leg into a confident zero", () => {
  const p = buildEdgeCapacityProposal(emptyEvidence());
  const serialised = JSON.stringify(p);
  assert.ok(!serialised.includes(`"proposedCapacityRiskR":0`),
    "a missing capacity must be null, never 0 — 0R is a claim, not an absence");
  assert.equal(p.sampleSizes.rResolvableClosedTrades, 0,
    "sample sizes are counts and are honestly zero; the ESTIMATE is what must be null");
});

test("the USD deployable ceiling is NEVER proposed, even on a full PROPOSED verdict", () => {
  const proposed = buildEdgeCapacityProposal(sufficientEvidence());
  assert.equal(proposed.verdict, "PROPOSED");
  assert.equal(proposed.proposedMaxDeployedUsd, null,
    "a learned output may never set a size — the USD ceiling is the owner's press");
  assert.match(proposed.maxDeployedUsdReason, /owner|press/i);
  const insufficient = buildEdgeCapacityProposal(emptyEvidence());
  assert.equal(insufficient.proposedMaxDeployedUsd, null);
});

test("a sufficient evidence base DOES propose a number, and discloses where it is optimistic", () => {
  const p = buildEdgeCapacityProposal(sufficientEvidence());
  assert.equal(p.verdict, "PROPOSED");
  assert.notEqual(p.simulatorInput, null);
  assert.equal(p.simulatorInput!.winRate01, 24 / 40);
  assert.equal(p.simulatorInput!.avgWinR, 1.5);
  assert.equal(p.simulatorInput!.avgLossR, -1);
  assert.equal(p.simulatorInput!.liquidity!.fillProbability01, 44 / 48);
  assert.ok(p.simulatorInput!.liquidity!.slippageR > 0,
    "measured slippage must reach the simulator; a silent zero would overstate capacity");
  assert.ok(p.optimisticAssumptions.length > 0,
    "an observed zero venue-failure rate is a lower bound and must be disclosed as optimism");
  assert.notEqual(p.confidence, "HIGH" as unknown as typeof p.confidence);
  assert.ok(p.reasons.some((r) => /PROPOSAL ONLY/.test(r)),
    "the proposal must say of itself that it has not been recorded");
});

test("a proposal is deterministic — the same evidence twice gives the identical number", () => {
  const a = buildEdgeCapacityProposal(sufficientEvidence());
  const b = buildEdgeCapacityProposal(sufficientEvidence());
  assert.equal(a.proposedCapacityRiskR, b.proposedCapacityRiskR);
});

// ═══ 3. THE READOUT, AND 4. THE DENY-BY-DEFAULT FLOOR ══════════════════════

const NO_ESTIMATE = {
  edgeId: 11,
  capacityStatus: null,
  capacityMaxDeployedUsd: null,
  capacityDeployCapOverrideUsd: null,
  capacityRecordedByAdminId: null,
  capacityEstimatedAt: null,
  deployedUsd: 0,
  deployedUsdUnknownReason: null,
};

test("gate #23 still refuses an edge with NO estimate, and the readout says exactly why", () => {
  const r = readEdgeCapacityGate(NO_ESTIMATE);
  assert.equal(r.wouldAdmitAnEntry, false);
  assert.equal(r.blocker, "NO_ESTIMATE_RECORDED");
  assert.equal(r.awaitingOwnerPress, true, "this refusal is waiting on a press, not on data");
  assert.match(r.gateDetail ?? "", /NO capacity estimate/);
  assert.match(r.remedy ?? "", /admin must record|cannot record itself/i);
  assert.equal(r.effectiveCeilingUsd, null);
  assert.equal(r.headroomUsd, null);
  assert.equal(r.probeCandidateUsd, EDGE_CAPACITY_PROBE_CANDIDATE_USD);
});

test("a RECORDED estimate flips the readout for that edge — and only that edge", () => {
  const before = readEdgeCapacityGate(NO_ESTIMATE);
  assert.equal(before.wouldAdmitAnEntry, false);

  // The press: an ESTIMATED verdict AND an admin-pressed USD ceiling.
  const after = readEdgeCapacityGate({
    ...NO_ESTIMATE,
    capacityStatus: "ESTIMATED",
    capacityMaxDeployedUsd: 50_000,
    capacityRecordedByAdminId: 3,
    capacityEstimatedAt: "2026-08-29T00:00:00.000Z",
    deployedUsd: 10_000,
  });
  assert.equal(after.wouldAdmitAnEntry, true, "the recorded estimate must flip the gate");
  assert.equal(after.blocker, null);
  assert.equal(after.remedy, null);
  assert.equal(after.effectiveCeilingUsd, 50_000);
  assert.equal(after.headroomUsd, 40_000);
  assert.equal(after.awaitingOwnerPress, false);

  // A sibling edge that was NOT pressed is completely unaffected.
  const sibling = readEdgeCapacityGate({ ...NO_ESTIMATE, edgeId: 12 });
  assert.equal(sibling.wouldAdmitAnEntry, false);
  assert.equal(sibling.blocker, "NO_ESTIMATE_RECORDED");
});

test("an ESTIMATED verdict WITHOUT a pressed ceiling still refuses — an estimate is not permission", () => {
  const r = readEdgeCapacityGate({ ...NO_ESTIMATE, capacityStatus: "ESTIMATED" });
  assert.equal(r.wouldAdmitAnEntry, false);
  assert.equal(r.blocker, "NO_PRESSED_USD_CEILING");
  assert.equal(r.awaitingOwnerPress, true);
});

test("a non-ESTIMATED recorded status refuses and is NOT reported as awaiting a press", () => {
  for (const s of ["NO_SAFE_CAPACITY", "DEGENERATE_INPUT", "SOMETHING_NEW"]) {
    const r = readEdgeCapacityGate({
      ...NO_ESTIMATE, capacityStatus: s, capacityMaxDeployedUsd: 50_000,
    });
    assert.equal(r.wouldAdmitAnEntry, false, `${s} must refuse`);
    assert.equal(r.blocker, "STATUS_NOT_ESTIMATED");
    assert.equal(r.awaitingOwnerPress, false,
      `${s} is the simulator refusing, not a missing press — telling an operator to press would be a lie`);
  }
});

test("an unknown deployed size refuses with its own reason, never a zero", () => {
  const r = readEdgeCapacityGate({
    ...NO_ESTIMATE,
    capacityStatus: "ESTIMATED",
    capacityMaxDeployedUsd: 50_000,
    deployedUsd: null,
    deployedUsdUnknownReason: "one open position has no resolvable USD notional",
  });
  assert.equal(r.wouldAdmitAnEntry, false);
  assert.equal(r.blocker, "DEPLOYED_SIZE_UNKNOWN");
  assert.equal(r.headroomUsd, null, "headroom against an unknown deployed size must be null");
  assert.match(r.remedy ?? "", /no resolvable USD notional/);
});

test("the tighten-only override lowers the readout's ceiling and can never raise it", () => {
  const tightened = readEdgeCapacityGate({
    ...NO_ESTIMATE,
    capacityStatus: "ESTIMATED",
    capacityMaxDeployedUsd: 50_000,
    capacityDeployCapOverrideUsd: 5_000,
    deployedUsd: 4_000,
  });
  assert.equal(tightened.effectiveCeilingUsd, 5_000);
  assert.equal(tightened.headroomUsd, 1_000);
  const cannotRaise = readEdgeCapacityGate({
    ...NO_ESTIMATE,
    capacityStatus: "ESTIMATED",
    capacityMaxDeployedUsd: 5_000,
    capacityDeployCapOverrideUsd: 500_000,
    deployedUsd: 0,
  });
  assert.equal(cannotRaise.effectiveCeilingUsd, 5_000);
});

test("the fleet summary makes an all-refuse state legible instead of silent", () => {
  const all = summariseEdgeCapacityFleet([
    readEdgeCapacityGate(NO_ESTIMATE),
    readEdgeCapacityGate({ ...NO_ESTIMATE, edgeId: 12 }),
    readEdgeCapacityGate({ ...NO_ESTIMATE, edgeId: 13 }),
  ]);
  assert.equal(all.edges, 3);
  assert.equal(all.admitting, 0);
  assert.equal(all.refusing, 3);
  assert.equal(all.awaitingOwnerPress, 3);
  assert.equal(all.byBlocker["NO_ESTIMATE_RECORDED"], 3);
  assert.match(all.headline, /refuses .* ALL 3 edge/);

  const empty = summariseEdgeCapacityFleet([]);
  assert.match(empty.headline, /No edges exist/,
    "an empty library must read as empty, never as 'everything is fine'");

  const mixed = summariseEdgeCapacityFleet([
    readEdgeCapacityGate(NO_ESTIMATE),
    readEdgeCapacityGate({
      ...NO_ESTIMATE, edgeId: 12, capacityStatus: "ESTIMATED",
      capacityMaxDeployedUsd: 1_000, deployedUsd: 0,
    }),
  ]);
  assert.equal(mixed.admitting, 1);
  assert.equal(mixed.refusing, 1);
});

// ═══ The seam between the two halves ═══════════════════════════════════════

test("a PROPOSED number does not, by itself, move the gate one inch", () => {
  const p = buildEdgeCapacityProposal(sufficientEvidence(11));
  assert.equal(p.verdict, "PROPOSED");
  assert.notEqual(p.proposedCapacityRiskR, null);
  // The edge row is untouched by the proposal, so the readout is unchanged.
  const r = readEdgeCapacityGate(NO_ESTIMATE);
  assert.equal(r.wouldAdmitAnEntry, false);
  assert.equal(r.blocker, "NO_ESTIMATE_RECORDED");
});
