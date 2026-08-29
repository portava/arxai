// Foundation gates #22 TENANT_CONTEXT_VIOLATION + #23 EDGE_CAPACITY_EXCEEDED
// — deny-by-default, tamper fixtures, tighten-only property, source pins.
//
// Three layers under test (same shape as foundationGates.test.ts for #19-#21):
//   1. The pure domain verdicts (lib/domain safety-contracts/foundationGates)
//      — a PROVEN cross-tenant fact refuses EVERY command type, an
//      unresolvable tenant context or edge capacity refuses entries (fail
//      closed), ops commands are never trapped by an unreadable fact, and
//      the capacity ceiling is TIGHTEN-ONLY (effective ≤ every input cap).
//   2. The shared evaluator wiring — both keys exist in the 23-gate list,
//      the deriv-demo venue parity map covers them, and the evaluator
//      surfaces them as block reasons.
//   3. Source pins — the dispatch pipeline supplies the command row's OWN
//      userId (never an echo of the caller), stamps the arming/command-row
//      reads, logs all five foundation verdicts, and the input assembler
//      writes each tenant stamp beside its own scoped query. The admin
//      capacity route can never let the simulator set the USD ceiling
//      itself (flywheel invariant: learned outputs only refuse).
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineSrc = readFileSync(path.join(here, "../liveCommandPipeline.ts"), "utf8");
const inputsSrc = readFileSync(path.join(here, "../foundationGateInputs.ts"), "utf8");
const adminRouteSrc = readFileSync(
  path.join(here, "../../../routes/adminEdgeCapacity.ts"), "utf8");

const {
  evaluateTenantContextGate,
  evaluateEdgeCapacityGate,
  resolveEdgeCapacityCeilingUsd,
  EDGE_CAPACITY_STATUS_ESTIMATED,
} = await import("@workspace/domain/safety-contracts/foundationGates");
const {
  evaluateLivePhaseBDispatchGate,
} = await import("@workspace/domain/safety-contracts/livePhaseBDispatchGate");
const {
  LIVE_PHASE_B_GATE_KEYS,
  LIVE_PHASE_B_GATE_COUNT,
  assertVenueGateParity,
} = await import("@workspace/domain/safety-contracts/venueGateParity");
const {
  DERIV_DEMO_GATE_PARITY,
  DERIV_DEMO_VENUE,
} = await import("@workspace/domain/safety-contracts/derivDemoGateParity");

// ── #22 TENANT_CONTEXT_VIOLATION — pure verdicts ───────────────────────────

const tenantOk = () => ({
  commandOwnerUserId: 7 as number | null,
  dispatchUserId: 7 as number | null,
  facts: [
    { fact: "capital_access", scopedToUserId: 7 as number | null, rowOwnerUserIds: [7] },
    { fact: "open_positions", scopedToUserId: 7 as number | null, rowOwnerUserIds: [7] },
    { fact: "live_arming_kill_switch", scopedToUserId: 7 as number | null, rowOwnerUserIds: [7] },
  ],
});

test("#22 pass-path: every fact stamped for the command's own owner passes", () => {
  const v = evaluateTenantContextGate(true, tenantOk());
  assert.equal(v.passed, true);
  assert.equal(v.detail, null);
});

test("#22 tamper fixture: user A's command citing user B's caps refuses (rows owned by B)", () => {
  const t = tenantOk();
  t.facts[0]!.rowOwnerUserIds = [8]; // capital caps rows came back owned by user 8
  const v = evaluateTenantContextGate(true, t);
  assert.equal(v.passed, false);
  assert.match(v.detail ?? "", /leak/i);
});

test("#22 tamper fixture: a fact READ FOR user B while evaluating user A's command refuses", () => {
  const t = tenantOk();
  t.facts[1]!.scopedToUserId = 8;
  assert.equal(evaluateTenantContextGate(true, t).passed, false);
});

test("#22 cross-tenant dispatch (authenticated user != command owner) refuses", () => {
  assert.equal(evaluateTenantContextGate(true, { ...tenantOk(), dispatchUserId: 8 }).passed, false);
});

test("#22 PROVEN violations refuse EVERY command type — close/modify included", () => {
  const leak = tenantOk();
  leak.facts[0]!.rowOwnerUserIds = [7, 9];
  assert.equal(evaluateTenantContextGate(false, leak).passed, false,
    "a close evaluated inside another tenant's context must refuse");
  assert.equal(
    evaluateTenantContextGate(false, { ...tenantOk(), dispatchUserId: 8 }).passed,
    false,
    "a cross-tenant dispatch of a close must refuse",
  );
});

test("#22 missing tenant context fails closed for ENTRIES", () => {
  assert.equal(evaluateTenantContextGate(true, { ...tenantOk(), commandOwnerUserId: null }).passed, false);
  assert.equal(evaluateTenantContextGate(true, { ...tenantOk(), dispatchUserId: null }).passed, false);
  assert.equal(evaluateTenantContextGate(true, { ...tenantOk(), facts: [] }).passed, false);
  const unscoped = tenantOk();
  unscoped.facts[2]!.scopedToUserId = null;
  assert.equal(evaluateTenantContextGate(true, unscoped).passed, false);
});

test("#22 UNRESOLVABLE context passes ops with a loud advisory (never trap a close on an unreadable fact)", () => {
  const v = evaluateTenantContextGate(false, { ...tenantOk(), facts: [] });
  assert.equal(v.passed, true);
  assert.match(v.detail ?? "", /ADVISORY/);
});

test("#22 invalid owner ids (0, negative, non-integer) are treated as missing, never as a matching tenant", () => {
  for (const bad of [0, -3, 1.5, NaN]) {
    const v = evaluateTenantContextGate(true, {
      ...tenantOk(), commandOwnerUserId: bad, dispatchUserId: bad,
    });
    assert.equal(v.passed, false, `owner id ${bad} must fail closed`);
  }
});

// ── #23 EDGE_CAPACITY_EXCEEDED — pure verdicts ─────────────────────────────

const capacityOk = () => ({
  required: true,
  edgeRefPresent: true,
  capacityStatus: EDGE_CAPACITY_STATUS_ESTIMATED as string | null,
  capacityDeployableUsd: 50_000 as number | null,
  capacityCapOverrideUsd: null as number | null,
  deployedUsd: 10_000 as number | null,
  candidateUsd: 1_500 as number | null,
});

test("#23 pass-path: ESTIMATED capacity with headroom admits the entry", () => {
  const v = evaluateEdgeCapacityGate(true, capacityOk());
  assert.equal(v.passed, true);
  assert.equal(v.detail, null);
});

test("#23 not required: human command with no edge reference passes with a reason", () => {
  const v = evaluateEdgeCapacityGate(true, {
    ...capacityOk(), required: false, edgeRefPresent: false,
    capacityStatus: null, capacityDeployableUsd: null, deployedUsd: null, candidateUsd: null,
  });
  assert.equal(v.passed, true);
  assert.match(v.detail ?? "", /Not required/);
});

test("#23 deny-by-default: an edge with NO capacity estimate refuses LIVE", () => {
  const v = evaluateEdgeCapacityGate(true, { ...capacityOk(), capacityStatus: null });
  assert.equal(v.passed, false);
  assert.match(v.detail ?? "", /NO capacity estimate/);
});

test("#23 non-ESTIMATED statuses refuse: NO_SAFE_CAPACITY, DEGENERATE_INPUT, unknown literal (allow-list)", () => {
  for (const s of ["NO_SAFE_CAPACITY", "DEGENERATE_INPUT", "FUTURE_STATUS", ""]) {
    assert.equal(evaluateEdgeCapacityGate(true, { ...capacityOk(), capacityStatus: s }).passed, false,
      `status ${JSON.stringify(s)} must refuse`);
  }
});

test("#23 an ESTIMATED verdict without a pressed USD ceiling admits nothing", () => {
  for (const c of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      evaluateEdgeCapacityGate(true, { ...capacityOk(), capacityDeployableUsd: c as number | null }).passed,
      false, `ceiling ${String(c)} must refuse`);
  }
});

test("#23 unresolvable deployed/candidate size fails closed (never estimate)", () => {
  assert.equal(evaluateEdgeCapacityGate(true, { ...capacityOk(), deployedUsd: null }).passed, false);
  assert.equal(evaluateEdgeCapacityGate(true, { ...capacityOk(), candidateUsd: null }).passed, false);
  assert.equal(evaluateEdgeCapacityGate(true, { ...capacityOk(), deployedUsd: Number.NaN }).passed, false);
});

test("#23 a command that would exceed the edge's capacity refuses", () => {
  assert.equal(evaluateEdgeCapacityGate(true, { ...capacityOk(), deployedUsd: 49_000 }).passed, false);
  // exactly at the ceiling is admitted (exceed means strictly over)
  assert.equal(evaluateEdgeCapacityGate(true, { ...capacityOk(), deployedUsd: 48_500 }).passed, true);
});

test("#23 required-but-no-edge-ref refuses (an autonomous entry cannot dodge capacity by dropping the ref)", () => {
  assert.equal(evaluateEdgeCapacityGate(true, { ...capacityOk(), edgeRefPresent: false }).passed, false);
});

test("#23 ops exemption: close/modify never blocks here even with no estimate", () => {
  const v = evaluateEdgeCapacityGate(false, {
    ...capacityOk(), capacityStatus: null, deployedUsd: null, candidateUsd: null,
  });
  assert.equal(v.passed, true);
});

test("#23 tighten-only property: the effective ceiling never exceeds ANY input cap", () => {
  let seed = 424243;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let i = 0; i < 500; i++) {
    const base = rand() * 100_000 + 1;
    const override = rand() < 0.3 ? null : rand() * 100_000 + 1;
    const eff = resolveEdgeCapacityCeilingUsd(base, override);
    assert.ok(eff != null && eff <= base + 1e-9, "effective ceiling must never exceed the recorded ceiling");
    if (override != null) {
      assert.ok(eff <= override + 1e-9, "effective ceiling must never exceed the owner override");
      assert.equal(eff, Math.min(base, override));
    }
  }
  // An override can never RAISE a missing/invalid base ceiling into existence.
  assert.equal(resolveEdgeCapacityCeilingUsd(null, 5_000), null);
  assert.equal(resolveEdgeCapacityCeilingUsd(0, 5_000), null);
});

// ── Evaluator + venue parity wiring ────────────────────────────────────────

test("the 23-gate list carries both new keys and the count is 23", () => {
  assert.equal(LIVE_PHASE_B_GATE_COUNT, 23);
  assert.equal(LIVE_PHASE_B_GATE_KEYS.length, 23);
  assert.ok((LIVE_PHASE_B_GATE_KEYS as readonly string[]).includes("TENANT_CONTEXT_VIOLATION"));
  assert.ok((LIVE_PHASE_B_GATE_KEYS as readonly string[]).includes("EDGE_CAPACITY_EXCEEDED"));
});

test("deriv-demo venue parity covers all 23 gates with informative dispositions", () => {
  const verdict = assertVenueGateParity(DERIV_DEMO_VENUE, DERIV_DEMO_GATE_PARITY);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
});

test("the shared evaluator surfaces both keys as block reasons", () => {
  const baseline = {
    liveBrokerExecutionEnabled: true, globalLiveEnabled: true, userLiveApproved: true,
    userArmed: true, killSwitchEngaged: false, bridgeAccountType: "live",
    bridgeHeartbeatAgeSec: 5, bridgeEaVersion: "1.27", bridgeEnableLiveExecution: true,
    bridgeReadOnlyMode: false, bridgeTerminalConnected: true, bridgeAlgoTradingAllowed: true,
    commandSymbol: "EURUSD", commandVolume: 0.01, commandHasStopLoss: true,
    allowedSymbols: ["EURUSD"], maxLotForSymbol: 0.1, dailyLossLimitUsd: 0,
    realisedDailyLossUsd: 0, requireStopLoss: false, adminAllowNoStopLoss: true,
    requireTakeProfit: false, adminAllowNoTakeProfit: true, commandHasTakeProfit: true,
    disclosureAccepted: true,
    foundation: {
      isEntryCommand: true,
      provenance: { envelopePresent: true, source: "LIVE_TICK", ageMs: 1_000, maxAgeMs: 900_000, integrityCovered: true },
      edgePromotion: { required: false, edgeRefPresent: false, edgeStatus: null, edgeLiveAllowed: false, edgeEvidenceValid: false },
      capital: { tier: "T1", openExposureUsd: 0, candidateExposureUsd: 100, userMaxLot: null },
      tenantContext: tenantOk(),
      edgeCapacity: { ...capacityOk(), required: false, edgeRefPresent: false },
    },
  };
  assert.equal(evaluateLivePhaseBDispatchGate(baseline).decision, "PASS");

  const leak = structuredClone(baseline);
  leak.foundation.tenantContext.facts[0]!.rowOwnerUserIds = [8];
  const r22 = evaluateLivePhaseBDispatchGate(leak);
  assert.equal(r22.decision, "BLOCKED");
  assert.ok(r22.blockReasons.includes("TENANT_CONTEXT_VIOLATION"));

  const overCap = structuredClone(baseline);
  overCap.foundation.edgeCapacity = { ...capacityOk(), deployedUsd: 49_999 };
  const r23 = evaluateLivePhaseBDispatchGate(overCap);
  assert.equal(r23.decision, "BLOCKED");
  assert.ok(r23.blockReasons.includes("EDGE_CAPACITY_EXCEEDED"));
});

// ── Source pins — the dispatch path and assembler cannot regress silently ──

test("dispatch supplies the command row's OWN userId as the tenant owner (never an echo of args)", () => {
  assert.ok(pipelineSrc.includes("ownerUserId: row.userId ?? null"),
    "the owner must come from the loaded row itself");
  assert.ok(pipelineSrc.includes("extraTenantStamps: ["),
    "dispatch must stamp the tenant-scoped facts it read itself");
  assert.ok(pipelineSrc.includes(`fact: "live_command_row"`));
  assert.ok(pipelineSrc.includes(`fact: "live_arming_kill_switch"`));
});

test("all five foundation verdicts are logged on every dispatch (PASS included)", () => {
  assert.ok(pipelineSrc.includes(`event: "FOUNDATION_GATES_EVALUATED"`));
  assert.ok(pipelineSrc.includes(`g.key === "TENANT_CONTEXT_VIOLATION"`));
  assert.ok(pipelineSrc.includes(`g.key === "EDGE_CAPACITY_EXCEEDED"`));
});

test("the assembler stamps each tenant-scoped read beside its own query", () => {
  for (const fact of ["capital_access", "open_positions", "in_flight_commands", "symbol_specs"]) {
    assert.ok(inputsSrc.includes(`fact: "${fact}"`), `missing tenant stamp for ${fact}`);
  }
  assert.ok(inputsSrc.includes("scopedToUserId: args.userId"),
    "stamps must record the userId the WHERE clause used");
});

test("the assembler reads the edge's recorded capacity columns and the platform-wide deployed size", () => {
  assert.ok(inputsSrc.includes("capacityStatus: productionEdgesTable.capacityStatus"));
  assert.ok(inputsSrc.includes("capacityMaxDeployedUsd: productionEdgesTable.capacityMaxDeployedUsd"));
  assert.ok(inputsSrc.includes("computeEdgeDeployedUsd"));
});

test("FLYWHEEL INVARIANT: the simulator can never write the USD ceiling — only an admin press can", () => {
  // The recording route stores the pressed ceiling ONLY behind an ESTIMATED
  // verdict, and stores null otherwise; the estimate object itself carries
  // no USD number that reaches capacity_max_deployed_usd.
  assert.ok(adminRouteSrc.includes(`const ceiling = estimate.status === "ESTIMATED"`));
  assert.ok(adminRouteSrc.includes("? (parsed.data.maxDeployedUsd ?? null)"));
  assert.ok(adminRouteSrc.includes(": null;"));
  assert.ok(!adminRouteSrc.includes("capacityMaxDeployedUsd: estimate"),
    "the simulator result must never be assigned as the USD ceiling");
});

test("the capacity router can never touch the promotion ladder (write scope = capacity_* only)", () => {
  // The recording route lives in its own router precisely so the
  // adminLearningVersions read-only pin for production_edges keeps holding;
  // in exchange, THIS pin proves the new router's write scope: no promotion
  // column may ever appear in CODE here (comments may name them to explain
  // exactly this contract, so they are stripped before scanning).
  const codeOnly = adminRouteSrc
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  for (const forbidden of [
    "status:", "liveAllowed", "adminApproved", "shadowValidated",
    "reportHash", "validationReportJson", "promotedAt", "retiredAt",
  ]) {
    assert.ok(!codeOnly.includes(forbidden),
      `capacity router must never reference promotion-ladder field ${forbidden}`);
  }
  // Exactly one update call, and it is on production_edges' capacity columns.
  assert.equal(adminRouteSrc.split("db.update(").length - 1, 1);
  assert.ok(adminRouteSrc.includes("capacityStatus: estimate.status"));
});
