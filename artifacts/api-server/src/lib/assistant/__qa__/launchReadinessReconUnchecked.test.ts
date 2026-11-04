// Truth regression: Ruby's admin launch-readiness verdict must not read a
// reconciliation pass whose detectors could not run as "0 critical issues /
// READY_FOR_MANUAL_LIVE_TEST". An unchecked critical check is a blocker, like a
// found one. Nor may it report the env flag alone as the master switch: dispatch
// gate 1 reads env AND the operator arm. Reporting only — no execution gate
// reads this verdict.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// Every drizzle chain resolves to one row that answers both the role lookup
// (ADMIN) and the COUNT(*) queries (0).
function chain(): unknown {
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown[]) => void) => resolve([{ role: "ADMIN", n: 0 }]);
      return () => proxy;
    },
  });
  return proxy;
}
const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, db: { select: () => chain() } } });

mock.module("../../mt5/currentConnectedBridgeDetector.js", {
  namedExports: { detectCurrentConnectedBridge: async () => ({ ok: true, primaryReason: null }) },
});
const realSwitches = await import("../../safety/platformSwitches.js");
// The master switch as platformSwitches reports it: enabled = env AND operator arm.
const ARMED = { envEnabled: true, operatorArmed: true, enabled: true };
let liveBrokerExecution: { envEnabled: boolean; operatorArmed: boolean; enabled: boolean } = ARMED;
let switchesReadable = true;
mock.module("../../safety/platformSwitches.js", {
  namedExports: {
    ...realSwitches,
    loadPlatformSettings: async () => ({
      switches: { liveBrokerExecution, platformMode: "LIVE", readable: switchesReadable },
      config: { sharedLiveTradingEnabled: true },
    }),
    platformStopWith: async () => ({ engaged: false, sources: [], reason: null }),
  },
});

type Agg = Awaited<ReturnType<typeof import("../../reconciliation/detect.js").aggregateReconciliationIssues>>;
const ZERO = { critical: 0, high: 0, medium: 0, low: 0 };
let agg: Agg;
const realDetect = await import("../../reconciliation/detect.js");
mock.module("../../reconciliation/detect.js", {
  namedExports: { ...realDetect, aggregateReconciliationIssues: async () => agg },
});

const { summarizeLaunchReadinessForAdminTool } = await import("../tools.js");

function aggOf(over: Partial<Agg>): Agg {
  return {
    issues: [], countsByType: {} as Agg["countsByType"], countsBySeverity: ZERO, total: 0,
    computedAt: new Date().toISOString(), complete: true, failedChecks: [], uncheckedTypes: [],
    truncated: false, truncatedChecks: [], truncatedTypes: [], truncatedSeverities: [],
    ...over,
  } as Agg;
}

test("control: every check ran and found nothing → ready", async () => {
  agg = aggOf({});
  const r = (await summarizeLaunchReadinessForAdminTool(1)) as { verdict: string; blockers: string[] };
  assert.equal(r.verdict, "READY_FOR_MANUAL_LIVE_TEST", JSON.stringify(r.blockers));
});

test("an unchecked critical detector blocks the verdict instead of reading as 0 critical", async () => {
  agg = aggOf({
    complete: false,
    uncheckedTypes: ["ORPHAN_BROKER_POSITION"],
    failedChecks: [{ check: "orphan_broker", type: "ORPHAN_BROKER_POSITION", severity: "critical", error: "ECONNREFUSED" }],
  });
  const r = (await summarizeLaunchReadinessForAdminTool(1)) as {
    verdict: string; blockers: string[]; safeToManuallyTest: boolean;
    counts: { reconciliationChecksComplete: boolean; reconciliationUncheckedTypes: string[] };
  };
  assert.notEqual(r.verdict, "READY_FOR_MANUAL_LIVE_TEST");
  assert.equal(r.safeToManuallyTest, false);
  assert.ok(r.blockers.includes("RECONCILIATION_UNCHECKED=ORPHAN_BROKER_POSITION"), JSON.stringify(r.blockers));
  assert.equal(r.counts.reconciliationChecksComplete, false);
  assert.deepEqual(r.counts.reconciliationUncheckedTypes, ["ORPHAN_BROKER_POSITION"]);
});

test("capped reconciliation lists are reported as lower-bound counts", async () => {
  agg = aggOf({
    total: 50, countsBySeverity: { ...ZERO, high: 50 },
    truncated: true, truncatedTypes: ["MISSING_ATTRIBUTION"], truncatedSeverities: ["high"],
    truncatedChecks: [{ check: "missing_attribution", type: "MISSING_ATTRIBUTION", severity: "high", limit: 50 }],
  });
  const r = (await summarizeLaunchReadinessForAdminTool(1)) as {
    counts: { reconciliationHigh: number; reconciliationCountsAreLowerBounds: boolean; reconciliationTruncatedTypes: string[] };
  };
  assert.equal(r.counts.reconciliationHigh, 50);
  assert.equal(r.counts.reconciliationCountsAreLowerBounds, true);
  assert.deepEqual(r.counts.reconciliationTruncatedTypes, ["MISSING_ATTRIBUTION"]);
});

test("an unchecked lower-severity detector is a needs-action item, not 'all clear'", async () => {
  agg = aggOf({
    complete: false,
    uncheckedTypes: ["BLOCKED_REJECTED_COMMAND"],
    failedChecks: [{ check: "blocked_demo", type: "BLOCKED_REJECTED_COMMAND", severity: "low", error: "boom" }],
  });
  const r = (await summarizeLaunchReadinessForAdminTool(1)) as { verdict: string; needsAction: string[] };
  assert.ok(r.needsAction.includes("RECONCILIATION_UNCHECKED=BLOCKED_REJECTED_COMMAND"), JSON.stringify(r.needsAction));
});

test("env flag on but no operator arm: the master switch is reported off, as gate 1 reads it", async () => {
  agg = aggOf({});
  liveBrokerExecution = { envEnabled: true, operatorArmed: false, enabled: false };
  try {
    const r = (await summarizeLaunchReadinessForAdminTool(1)) as {
      verdict: string; blockers: string[]; safeToManuallyTest: boolean;
      tradingMode: { liveBrokerExecutionEnabled: boolean; liveBrokerExecutionEnvFlag: boolean; liveBrokerExecutionOperatorArmed: boolean };
    };
    assert.equal(r.tradingMode.liveBrokerExecutionEnabled, false, "not enabled while no operator has armed it");
    assert.equal(r.tradingMode.liveBrokerExecutionEnvFlag, true);
    assert.equal(r.tradingMode.liveBrokerExecutionOperatorArmed, false);
    assert.notEqual(r.verdict, "READY_FOR_MANUAL_LIVE_TEST");
    assert.equal(r.safeToManuallyTest, false);
    assert.ok(r.blockers.some((b) => b.startsWith("LIVE_BROKER_EXECUTION_NOT_ARMED")), JSON.stringify(r.blockers));
    assert.ok(!r.blockers.some((b) => b.startsWith("ARX_LIVE_BROKER_EXECUTION_ENABLED=false")), "the env flag is set; the arm is what is missing");

    // Settings unreadable: the switch is unknown and treated as off, not "not armed".
    switchesReadable = false;
    const u = (await summarizeLaunchReadinessForAdminTool(1)) as { blockers: string[] };
    assert.ok(u.blockers.some((b) => b.startsWith("LIVE_BROKER_EXECUTION_UNKNOWN")), JSON.stringify(u.blockers));
    assert.ok(!u.blockers.some((b) => b.startsWith("LIVE_BROKER_EXECUTION_NOT_ARMED")));
  } finally {
    liveBrokerExecution = ARMED;
    switchesReadable = true;
  }
});

test("env flag off: the existing master-switch blocker names the env flag", async () => {
  agg = aggOf({});
  liveBrokerExecution = { envEnabled: false, operatorArmed: true, enabled: false };
  try {
    const r = (await summarizeLaunchReadinessForAdminTool(1)) as { blockers: string[]; tradingMode: { liveBrokerExecutionEnabled: boolean } };
    assert.equal(r.tradingMode.liveBrokerExecutionEnabled, false);
    assert.ok(r.blockers.includes("ARX_LIVE_BROKER_EXECUTION_ENABLED=false (server master switch off)"), JSON.stringify(r.blockers));
  } finally {
    liveBrokerExecution = ARMED;
  }
});

// global_trading_settings could not be read: loadPlatformSettings fails closed
// with operatorArmed false. The tool reported liveBrokerExecutionOperatorArmed
// as a definite false ("observed: not armed") for an arm nobody read — worst
// with the env flag off, where the blockers name only the env flag.
test("settings that could not be read: the operator arm is reported unknown (null), never an observed false", async () => {
  agg = aggOf({});
  switchesReadable = false;
  try {
    for (const envEnabled of [true, false]) {
      liveBrokerExecution = { envEnabled, operatorArmed: false, enabled: false };
      const r = (await summarizeLaunchReadinessForAdminTool(1)) as {
        tradingMode: { liveBrokerExecutionEnabled: boolean; liveBrokerExecutionEnvFlag: boolean; liveBrokerExecutionOperatorArmed: boolean | null };
      };
      assert.equal(r.tradingMode.liveBrokerExecutionOperatorArmed, null, `env ${envEnabled}: the arm was not read`);
      assert.equal(r.tradingMode.liveBrokerExecutionEnabled, false, "still treated as off (fail closed)");
      assert.equal(r.tradingMode.liveBrokerExecutionEnvFlag, envEnabled);
    }
  } finally {
    liveBrokerExecution = ARMED;
    switchesReadable = true;
  }

  // Read: a real false stays false.
  liveBrokerExecution = { envEnabled: true, operatorArmed: false, enabled: false };
  try {
    const r = (await summarizeLaunchReadinessForAdminTool(1)) as { tradingMode: { liveBrokerExecutionOperatorArmed: boolean | null } };
    assert.equal(r.tradingMode.liveBrokerExecutionOperatorArmed, false);
  } finally {
    liveBrokerExecution = ARMED;
  }
});

test("Ruby is told that a null operator arm means it could not be read", async () => {
  const { TOOL_DEFINITIONS } = await import("../tools.js");
  const d = String((TOOL_DEFINITIONS as unknown as Array<{ name: string; description: string }>)
    .find((t) => t.name === "summarizeLaunchReadinessForAdmin")?.description);
  assert.match(d, /liveBrokerExecutionOperatorArmed is null when the platform settings could not be read/);
});
