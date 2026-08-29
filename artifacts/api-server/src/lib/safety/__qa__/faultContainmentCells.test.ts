// Capability #33 — Fault-Containment Cells test suite (blast radius).
//
// Proves, offline and deterministically:
//   1. CONTRACT SHAPE: the five cell dimensions are declared, each with a
//      named existing mechanism; the shared-dependency register only admits
//      widening-proof dependencies (REFUSES_MORE / OBSERVES_ONLY).
//   2. CELL KEYS are deterministic and injective over dimension values.
//   3. THE CONTAINMENT CHECKER: cross-cell writes are violations; untagged
//      writes are violations (never presumed harmless); declared fan-outs
//      pass only on their declared dimensions.
//   4. BLAST RADIUS on real pure engines: a poisoned cell (failing strategy,
//      data-starved symbol) changes ONLY its own cell's output — the
//      co-resident cells' outputs are byte-identical to a run without the
//      poison. This is the property the containment contract exists to keep.
//
// Run: pnpm --filter @workspace/api-server run test:fault-containment

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CELL_DIMENSIONS,
  CELL_MECHANISMS,
  SHARED_DEPENDENCIES,
  checkWriteContainment,
  faultCellKey,
  isDeclaredSharedDependency,
} from "@workspace/domain/safety-contracts/faultContainmentCells";
import { evolveStrategyQuarantine, type StrategyQuarantineInput } from "@workspace/domain/continuous-validation";
import { chooseExecutionPolicy, type ExecutionPolicyInput } from "@workspace/domain/execution-policy";

// ── 1. Contract shape ───────────────────────────────────────────────────────

test("the five partition dimensions are declared, each backed by a named existing mechanism", () => {
  assert.deepEqual([...CELL_DIMENSIONS], ["broker", "connection", "account", "symbol", "strategy"]);
  for (const d of CELL_DIMENSIONS) {
    const m = CELL_MECHANISMS.find((x) => x.dimension === d);
    assert.ok(m, `dimension ${d} has no declared mechanism`);
    assert.ok(m.location.length > 10, `dimension ${d} mechanism must name its location`);
  }
});

test("every shared dependency is widening-proof and platform-scoped, with an honest blast radius", () => {
  assert.ok(SHARED_DEPENDENCIES.length >= 4, "the register must name the real shared dependencies (db, kill switch, process, ...)");
  for (const dep of SHARED_DEPENDENCIES) {
    assert.equal(dep.scope, "platform");
    assert.ok(dep.failureDirection === "REFUSES_MORE" || dep.failureDirection === "OBSERVES_ONLY",
      `${dep.name}: a shared dependency whose failure could GRANT authority is not allowed on the register`);
    assert.ok(dep.blastRadiusOnFailure.length > 20, `${dep.name}: blast radius must be described honestly`);
  }
  // The single point of failure is named, not hidden.
  assert.ok(isDeclaredSharedDependency("postgres"));
  assert.ok(isDeclaredSharedDependency("global_kill_switch"));
  assert.ok(isDeclaredSharedDependency("api_server_process"));
  assert.ok(!isDeclaredSharedDependency("some_undeclared_backchannel"));
});

// ── 2. Cell keys ────────────────────────────────────────────────────────────

test("faultCellKey is deterministic, order-stable, and distinguishes cells on every dimension", () => {
  const a = faultCellKey({ broker: "mt5", connection: "c1", account: "u7", symbol: "EURUSD", strategy: "trend" });
  assert.equal(a, faultCellKey({ strategy: "trend", symbol: "EURUSD", account: "u7", connection: "c1", broker: "mt5" }));
  for (const d of CELL_DIMENSIONS) {
    const b = faultCellKey({ broker: "mt5", connection: "c1", account: "u7", symbol: "EURUSD", strategy: "trend", [d]: "OTHER" });
    assert.notEqual(a, b, `changing ${d} must change the cell key`);
  }
  // Unscoped dimensions are explicit wildcards, not silently equal to a value.
  assert.notEqual(faultCellKey({ broker: "mt5" }), faultCellKey({ broker: "mt5", account: "u7" }));
  assert.ok(faultCellKey({}).includes("broker=*"));
});

// ── 3. Containment checker ──────────────────────────────────────────────────

const CELL_A = { broker: "mt5", connection: "c1", account: "u7", symbol: "EURUSD", strategy: "trend" };
const CELL_B = { broker: "mt5", connection: "c2", account: "u9", symbol: "XAUUSD", strategy: "meanrev" };

test("a write inside its own cell is contained; a cross-cell write is a violation", () => {
  assert.equal(checkWriteContainment({ originCell: CELL_A, targetCell: CELL_A }).contained, true);
  const v = checkWriteContainment({ originCell: CELL_A, targetCell: CELL_B });
  assert.equal(v.contained, false);
  assert.ok(v.violations.some((x) => x.includes("account")), "the violated dimensions are named");
});

test("an UNTAGGED write against a scoped target is a violation — never presumed harmless", () => {
  const v = checkWriteContainment({ originCell: { broker: "mt5" }, targetCell: CELL_A });
  assert.equal(v.contained, false);
  assert.ok(v.violations.some((x) => x.includes("UNKNOWN")));
});

test("a declared fan-out passes only on its declared dimensions", () => {
  // A platform watchdog may fan out across connections/accounts...
  const ok = checkWriteContainment({
    originCell: { broker: "mt5" },
    targetCell: CELL_A,
    originMayFanOut: ["connection", "account", "symbol", "strategy"],
  });
  assert.equal(ok.contained, true);
  // ...but a fan-out declaration on 'connection' alone does not cover 'account'.
  const partial = checkWriteContainment({
    originCell: { broker: "mt5" },
    targetCell: CELL_A,
    originMayFanOut: ["connection"],
  });
  assert.equal(partial.contained, false);
});

// ── 4. Blast radius on real pure engines ────────────────────────────────────

function quarantineInput(candidateId: string, overrides: Partial<StrategyQuarantineInput> = {}): StrategyQuarantineInput {
  return {
    candidateId,
    currentState: "NONE",
    trustScore01: 0.9,
    severeBreachCount: 0,
    moderateConcernCount: 0,
    recoveryEvidenceScore01: 0,
    ...overrides,
  };
}

test("strategy cell blast radius: retiring strategy A leaves strategy B's verdict byte-identical", () => {
  const healthyB = quarantineInput("strategy-B");
  const baselineB = evolveStrategyQuarantine(healthyB);

  // Poison cell A: catastrophic breach → RETIRED.
  const poisonedA = evolveStrategyQuarantine(quarantineInput("strategy-A", { severeBreachCount: 3, trustScore01: 0.1 }));
  assert.equal(poisonedA.nextState, "RETIRED");

  // B evaluated in the same pass, after A's failure: identical to baseline.
  const bAfterA = evolveStrategyQuarantine(healthyB);
  assert.deepEqual(bAfterA, baselineB, "strategy B's verdict must not change because strategy A failed");
  assert.equal(bAfterA.nextState, "NONE");
  assert.equal(bAfterA.permissions.canEnterTrades, true);
});

function policyInput(overrides: Partial<ExecutionPolicyInput> = {}): ExecutionPolicyInput {
  return {
    spread: { currentSpread: 0.0002, typicalSpread: 0.0002 },
    urgency: "NORMAL",
    size: { orderSize: 1, recentVolume: 100 },
    fillQuality: [],
    currentDefaultShape: "IMMEDIATE_MARKET",
    ...overrides,
  };
}

test("symbol cell blast radius: a data-starved symbol degrades ONLY itself; the healthy symbol's recommendation is unchanged", () => {
  const healthy = policyInput();
  const baseline = chooseExecutionPolicy(healthy);

  // Poison one symbol's cell: every signal unreadable.
  const poisoned = chooseExecutionPolicy(policyInput({
    spread: { currentSpread: null, typicalSpread: null },
    size: { orderSize: 1, recentVolume: null },
  }));
  assert.equal(poisoned.confidence, 0, "the poisoned cell degrades honestly to the default with zero confidence");

  const healthyAfter = chooseExecutionPolicy(healthy);
  assert.deepEqual(healthyAfter, baseline, "the healthy symbol's recommendation must not change because another symbol's data failed");
});

test("engines carry no cross-cell channel: repeated interleaved evaluations are order-independent", () => {
  // Interleave 3 cells in two different orders; every cell's outputs match.
  const inputs = [
    quarantineInput("s1", { trustScore01: 0.2 }),
    quarantineInput("s2"),
    quarantineInput("s3", { moderateConcernCount: 5, trustScore01: 0.45 }),
  ];
  const order1 = inputs.map((i) => evolveStrategyQuarantine(i));
  const order2 = [...inputs].reverse().map((i) => evolveStrategyQuarantine(i)).reverse();
  assert.deepEqual(order1, order2, "evaluation order must not leak state between strategy cells");
});
