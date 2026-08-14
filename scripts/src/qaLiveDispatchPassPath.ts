// Phase B QA — PASS-path proof.
//
// Walks the happy-path baseline through evaluateLivePhaseBDispatchGate
// and asserts decision === "PASS" with zero blocking reasons. This is the
// pre-condition for `dispatchLiveCommand` writing SENT_TO_MT5_LIVE.
//
// We do not actually insert a DB row here (integration coverage lives in
// the pipeline tests); the contract this test enforces is:
//   "if and only if the 15-gate evaluator returns PASS, the server may
//    write SENT_TO_MT5_LIVE".
import {
  evaluateLivePhaseBDispatchGate,
  type LivePhaseBGateInput,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";

const baseline: LivePhaseBGateInput = {
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
  commandHasStopLoss: true,
  allowedSymbols: ["EURUSD"],
  maxLotForSymbol: 0.1,
  dailyLossLimitUsd: 50,
  realisedDailyLossUsd: 0,
  requireStopLoss: true,
  adminAllowNoStopLoss: false,
  requireTakeProfit: true,
  adminAllowNoTakeProfit: false,
  commandHasTakeProfit: true,
  disclosureAccepted: true,
};

const result = evaluateLivePhaseBDispatchGate(baseline);

let failed = 0;
function assert(name: string, cond: boolean, detail = "") {
  // eslint-disable-next-line no-console
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
}

assert("decision is PASS", result.decision === "PASS",
  `got=${result.decision} reasons=[${result.blockReasons.join(",")}]`);
assert("no blocking reasons", result.blockReasons.length === 0,
  `reasons=[${result.blockReasons.join(",")}]`);
assert("primaryReason is null", result.primaryReason === null,
  `primaryReason=${String(result.primaryReason)}`);
assert("all 16 gates pass individually", result.gates.every((g) => g.passed),
  `failing=[${result.gates.filter((g) => !g.passed).map((g) => g.key).join(",")}]`);

// Negative control: flip master switch → must BLOCK with that exact reason
// AND append BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED for grep/audit.
const blocked = evaluateLivePhaseBDispatchGate({ ...baseline, liveBrokerExecutionEnabled: false });
assert("master-switch=false flips to BLOCKED", blocked.decision === "BLOCKED");
assert("master-switch=false reason is LIVE_BROKER_EXECUTION_DISABLED",
  blocked.blockReasons.includes("LIVE_BROKER_EXECUTION_DISABLED"));
assert("master-switch=false appends BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
  blocked.blockReasons.includes("BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"));

// eslint-disable-next-line no-console
console.log(`\n${failed === 0 ? "PASS-path proof OK" : `${failed} assertions failed`}`);
process.exit(failed === 0 ? 0 : 1);
