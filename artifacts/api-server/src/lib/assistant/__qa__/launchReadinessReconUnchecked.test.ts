// Truth regression: Ruby's admin launch-readiness verdict must not read a
// reconciliation pass whose detectors could not run as "0 critical issues /
// READY_FOR_MANUAL_LIVE_TEST". An unchecked critical check is a blocker, like a
// found one. Reporting only — no execution gate reads this verdict.
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
mock.module("../../safety/platformSwitches.js", {
  namedExports: {
    ...realSwitches,
    loadPlatformSettings: async () => ({
      switches: { liveBrokerExecution: { envEnabled: true }, platformMode: "LIVE" },
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

test("an unchecked lower-severity detector is a needs-action item, not 'all clear'", async () => {
  agg = aggOf({
    complete: false,
    uncheckedTypes: ["BLOCKED_REJECTED_COMMAND"],
    failedChecks: [{ check: "blocked_demo", type: "BLOCKED_REJECTED_COMMAND", severity: "low", error: "boom" }],
  });
  const r = (await summarizeLaunchReadinessForAdminTool(1)) as { verdict: string; needsAction: string[] };
  assert.ok(r.needsAction.includes("RECONCILIATION_UNCHECKED=BLOCKED_REJECTED_COMMAND"), JSON.stringify(r.needsAction));
});
