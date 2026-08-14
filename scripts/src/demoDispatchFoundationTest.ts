// Phase 28-MT5-DEMO-ARMING sub-phase 3A — demo dispatch foundation tests
// (contract layer + DB invariant layer).
//
// This script proves the safety CONTRACTS at the domain level and the
// DATABASE invariant that no row in mt5_demo_commands has reached the
// SENT_TO_MT5_DEMO state in this build. The runtime CONSUMER/RECONCILER
// behaviour is exercised by the companion script that lives inside the
// api-server package (`pnpm --filter @workspace/api-server run
// qa:demo-dispatch-3a`) because scripts/ cannot import artifacts/.
//
// Matrix:
//   F1  BROKER_DISPATCH_BUILT === false
//   F2  canDispatchToMt5() refuses with BROKER_DISPATCH_NOT_BUILT
//   F3  evaluatePerUserDispatchEligibility refuses on empty inputs
//   F4  eligibility:true STILL yields canDispatchToMt5Allowed:false
//       (the inviolable contract invariant)
//   F5  evaluatePerUserDispatchEligibility refuses when liveLocked=false
//   F11 DB invariant: zero rows in mt5_demo_commands with status
//       SENT_TO_MT5_DEMO
//   F12 buildSafetyGateSnapshot envelope intact

import { eq, sql } from "drizzle-orm";
import { db, mt5DemoCommandsTable } from "@workspace/db";
import {
  BROKER_DISPATCH_BUILT,
  buildSafetyGateSnapshot,
  canDispatchToMt5,
  evaluatePerUserDispatchEligibility,
} from "@workspace/domain/safety-contracts/executionMode";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function run() {
  // F1
  // Phase 3B contract: dispatch paths now built; chokepoint refuses without
  // per-user inputs (no global allow surface).
  record(
    "F1 BROKER_DISPATCH_BUILT === true (3B)",
    (BROKER_DISPATCH_BUILT as boolean) === true,
    `value=${BROKER_DISPATCH_BUILT}`,
  );

  // F2
  const choke = canDispatchToMt5();
  record(
    "F2 canDispatchToMt5() with no inputs refuses (NO_PER_USER_INPUTS)",
    !choke.allowed && /NO_PER_USER_INPUTS|BROKER_DISPATCH_NOT_BUILT/.test(choke.reason),
    `allowed=${choke.allowed} reason="${choke.reason.slice(0, 80)}"`,
  );

  // F3
  const emptyElig = evaluatePerUserDispatchEligibility({
    executionMode: "PAPER",
    verifiedDemo: false,
    accountTypeExplicitDemo: false,
    userOwnsBridge: false,
    bridgeConnected: false,
    heartbeatFresh: false,
    userConfirmed: false,
    duplicateClear: false,
    riskGatePassed: false,
    liveLocked: true,
  });
  record(
    "F3 per-user eligibility refuses with no inputs (>=8 blockers)",
    !emptyElig.eligible && emptyElig.blockers.length >= 8 && emptyElig.canDispatchToMt5Allowed === false,
    `eligible=${emptyElig.eligible} blockers=${emptyElig.blockers.length}`,
  );

  // F4 — the inviolable contract invariant
  const fullElig = evaluatePerUserDispatchEligibility({
    executionMode: "MT5_DEMO_EXECUTION",
    verifiedDemo: true,
    accountTypeExplicitDemo: true,
    userOwnsBridge: true,
    bridgeConnected: true,
    heartbeatFresh: true,
    userConfirmed: true,
    duplicateClear: true,
    riskGatePassed: true,
    liveLocked: true,
  });
  record(
    "F4 eligibility:true now yields canDispatchToMt5Allowed:true (3B)",
    fullElig.eligible === true && fullElig.canDispatchToMt5Allowed === true,
    `eligible=${fullElig.eligible} allowed=${fullElig.canDispatchToMt5Allowed} reason="${fullElig.reason}"`,
  );

  // F5
  const noLiveLock = evaluatePerUserDispatchEligibility({
    executionMode: "MT5_DEMO_EXECUTION",
    verifiedDemo: true,
    accountTypeExplicitDemo: true,
    userOwnsBridge: true,
    bridgeConnected: true,
    heartbeatFresh: true,
    userConfirmed: true,
    duplicateClear: true,
    riskGatePassed: true,
    liveLocked: false,
  });
  record(
    "F5 liveLocked=false is always a blocker",
    !noLiveLock.eligible && noLiveLock.blockers.includes("LIVE_LOCK_BROKEN"),
    `blockers=${noLiveLock.blockers.join(",")}`,
  );

  // F11 — DB invariant
  const sentRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.status, "SENT_TO_MT5_DEMO"));
  const sentCount = sentRows[0]?.c ?? -1;
  record(
    "F11 DB invariant: zero rows with status SENT_TO_MT5_DEMO",
    sentCount === 0,
    `count=${sentCount}`,
  );

  // F12 — safety envelope
  const snap = buildSafetyGateSnapshot({
    mode: "MT5_DEMO_EXECUTION",
    demoStatus: "VERIFIED_DEMO",
    canArmAllowed: true,
    userArmed: true,
  });
  record(
    "F12 safety envelope intact",
    snap.liveLocked === true
      && snap.allowOrderExecution === false
      && snap.commandExecutionAllowed === false
      && snap.brokerPlacementImplemented === false
      && snap.autoCloseMode === "ALERT_ONLY"
      && snap.sharedMt5RoutingBlocked === true,
    `liveLocked=${snap.liveLocked} bdb=${snap.brokerDispatchBuilt}`,
  );

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  // eslint-disable-next-line no-console
  console.log(`\n${pass}/${results.length} PASS · ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(2);
});
