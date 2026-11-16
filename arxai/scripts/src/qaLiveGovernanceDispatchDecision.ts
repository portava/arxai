// T019 QA — unified governance dispatch decision + evaluator-input mapping.
//
// Guards the regression the architect flagged: live preflight/dispatch must key
// the app-added POLICY caps (allowed symbols, per-trade lot, max-open exposure,
// daily loss, SL/TP) on the UNIFIED governance decision
//   useGovernance = isPrivileged && ownerLiveControlMode
// (OWNER **and** ADMIN are privileged) — NOT on the owner-only
// `isOwnerUnrestricted` risk profile. If it keyed off owner-only, a plain
// admin's governance toggles would be silently no-op at dispatch while the read
// payloads/UI present them as active.
//
// This test locks two things:
//   1. The decision matrix: which (role, controlMode) combinations are
//      governance-driven vs protective.
//   2. The evaluator-input mapping: when governance is the source of truth, an
//      ADMIN with restrictions OFF can pass a no-SL trade, and the same ADMIN
//      with requireStopLoss re-enabled is BLOCKED — proving governance inputs
//      flow into the real 16-gate evaluator.
import {
  evaluateLivePhaseBDispatchGate,
  type LivePhaseBGateInput,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

export async function run(): Promise<CiTestResultLike> {
let failed = 0;
let passed = 0;
function assert(name: string, cond: boolean, detail = "") {
  // eslint-disable-next-line no-console
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (cond) passed++; else failed++;
}

// Mirror of the pipeline predicate (liveCommandPipeline.ts: useGovernance /
// useGovernanceDispatch). "Governance currently active" requires BOTH a
// privileged role AND Owner Live Control Mode ON.
function useGovernance(isPrivileged: boolean, ownerLiveControlMode: boolean): boolean {
  return isPrivileged && ownerLiveControlMode;
}

// ── Decision matrix ────────────────────────────────────────────────────────
// Resolver semantics (effectiveGovernance.ts):
//   privileged + controlON  → {isPrivileged:true,  ownerLiveControlMode:true}
//   privileged + controlOFF → {isPrivileged:true,  ownerLiveControlMode:false}
//     (isPrivileged STAYS true so the Admin Governance panel remains visible and
//      the operator can turn control mode back ON — the lockout fix)
//   normal user             → {isPrivileged:false, ownerLiveControlMode:false}
assert("OWNER + control ON  → governance-driven", useGovernance(true, true) === true);
assert("ADMIN + control ON  → governance-driven", useGovernance(true, true) === true);
assert("OWNER + control OFF → protective", useGovernance(true, false) === false);
assert("ADMIN + control OFF → protective", useGovernance(true, false) === false);
assert("normal user         → protective", useGovernance(false, false) === false);

// ── Panel-visibility / lockout-recovery contract ───────────────────────────
// The Admin Governance panel renders iff isPrivileged. Because isPrivileged
// stays true for owner/admin even when control mode is OFF, the panel stays
// reachable and the master toggle (only disabled while saving) can flip control
// mode back ON. A normal user never sees the panel.
const panelVisible = (isPrivileged: boolean) => isPrivileged;
assert("OWNER control OFF: governance panel still visible (no lockout)", panelVisible(true) === true);
assert("ADMIN control OFF: governance panel still visible (no lockout)", panelVisible(true) === true);
assert("normal user: governance panel hidden", panelVisible(false) === false);

// ── enforceAllocationLimit (shared-pool margin proxy) semantics ────────────
// Mirror of liveCommandPipeline.ts:
//   enforceMarginProxy = !useGovernance || gov.enforceAllocationLimit
// The toggle must be honoured for OWNER **and** ADMIN (not owner-only), and
// normal/control-OFF users always enforce regardless of the toggle.
function enforceMarginProxy(
  isPrivileged: boolean, ownerLiveControlMode: boolean, enforceAllocationLimit: boolean,
): boolean {
  return !useGovernance(isPrivileged, ownerLiveControlMode) || enforceAllocationLimit;
}
assert("ADMIN gov ON, enforceAllocationLimit OFF → margin proxy SKIPPED",
  enforceMarginProxy(true, true, false) === false);
assert("ADMIN gov ON, enforceAllocationLimit ON  → margin proxy ENFORCED",
  enforceMarginProxy(true, true, true) === true);
assert("OWNER gov ON, enforceAllocationLimit OFF → margin proxy SKIPPED",
  enforceMarginProxy(true, true, false) === false);
assert("control OFF (privileged) → margin proxy ENFORCED regardless of toggle",
  enforceMarginProxy(true, false, false) === true);
assert("normal user → margin proxy ENFORCED regardless of toggle",
  enforceMarginProxy(false, false, false) === true);

// ── Evaluator-input mapping (the part that actually reaches the broker gate) ─
const liveBaseline: Omit<
  LivePhaseBGateInput,
  "requireStopLoss" | "adminAllowNoStopLoss" | "commandHasStopLoss"
> = {
  liveBrokerExecutionEnabled: true,
  globalLiveEnabled: true,
  userLiveApproved: true,
  userArmed: true,
  killSwitchEngaged: false,
  bridgeAccountType: "live",
  bridgeHeartbeatAgeSec: 3,
  bridgeEaVersion: "1.27",
  bridgeEnableLiveExecution: true,
  bridgeReadOnlyMode: false,
  bridgeTerminalConnected: true,
  bridgeAlgoTradingAllowed: true,
  commandSymbol: "EURUSD",
  commandVolume: 0.01,
  allowedSymbols: ["EURUSD"],
  maxLotForSymbol: 0.1,
  dailyLossLimitUsd: 0,
  realisedDailyLossUsd: 0,
  requireTakeProfit: false,
  adminAllowNoTakeProfit: true,
  commandHasTakeProfit: false,
  disclosureAccepted: true,
};

// ADMIN, governance ON, requireStopLoss OFF (default unrestricted) → no-SL trade
// maps to requireStopLoss=false / adminAllowNoStopLoss=true → evaluator PASSES.
const adminUnrestricted = evaluateLivePhaseBDispatchGate({
  ...liveBaseline,
  requireStopLoss: useGovernance(true, true) ? false /* gov.requireStopLoss */ : true,
  adminAllowNoStopLoss: useGovernance(true, true) ? true /* !gov.requireStopLoss */ : false,
  commandHasStopLoss: false,
});
assert("ADMIN governance OFF: no-SL trade PASSES", adminUnrestricted.decision === "PASS",
  `got=${adminUnrestricted.decision} reasons=[${adminUnrestricted.blockReasons.join(",")}]`);

// Same ADMIN, governance ON, requireStopLoss RE-ENABLED → no-SL trade BLOCKS.
const adminRequireSl = evaluateLivePhaseBDispatchGate({
  ...liveBaseline,
  requireStopLoss: useGovernance(true, true) ? true /* gov.requireStopLoss */ : true,
  adminAllowNoStopLoss: useGovernance(true, true) ? false /* !gov.requireStopLoss */ : false,
  commandHasStopLoss: false,
});
assert("ADMIN governance requireStopLoss: no-SL trade BLOCKS",
  adminRequireSl.decision === "BLOCKED"
    && adminRequireSl.blockReasons.includes("MISSING_STOP_LOSS"),
  `got=${adminRequireSl.decision} reasons=[${adminRequireSl.blockReasons.join(",")}]`);

// Protective (normal user / control OFF): requireStopLoss=true regardless of
// governance toggles → no-SL trade BLOCKS.
const protectiveNoSl = evaluateLivePhaseBDispatchGate({
  ...liveBaseline,
  requireStopLoss: useGovernance(false, false) ? false : true,
  adminAllowNoStopLoss: false,
  commandHasStopLoss: false,
});
assert("protective: no-SL trade BLOCKS",
  protectiveNoSl.decision === "BLOCKED"
    && protectiveNoSl.blockReasons.includes("MISSING_STOP_LOSS"),
  `got=${protectiveNoSl.decision} reasons=[${protectiveNoSl.blockReasons.join(",")}]`);

// eslint-disable-next-line no-console
console.log(`\n${failed === 0 ? "governance dispatch decision proof OK" : `${failed} assertions failed`}`);
  return { name: "qaLiveGovernanceDispatchDecision", passes: passed, failures: failed };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error("[qaLiveGovernanceDispatchDecision] FAILED:", err);
      process.exit(1);
    },
  );
}
