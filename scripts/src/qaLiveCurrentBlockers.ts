import { evaluateLivePhaseBDispatchGate, type LivePhaseBGateInput } from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";

const ALLOWED = ["EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","NZDUSD","USDCHF","EURGBP","EURJPY","GBPJPY","XAUUSD","XAGUSD","US30","NAS100","SPX500","BTCUSD","ETHUSD","WTI","UKOIL"];

const realCurrentState: LivePhaseBGateInput = {
  liveBrokerExecutionEnabled: false,
  globalLiveEnabled: false,
  userLiveApproved: false,
  userArmed: false,
  killSwitchEngaged: true,
  bridgeAccountType: "live",
  bridgeHeartbeatAgeSec: 6,
  bridgeEaVersion: "1.27",
  bridgeEnableLiveExecution: null,
  bridgeReadOnlyMode: false,
  bridgeTerminalConnected: null,
  bridgeAlgoTradingAllowed: null,
  commandSymbol: "EURUSD",
  commandVolume: 0.01,
  commandHasStopLoss: false,
  allowedSymbols: ALLOWED,
  maxLotForSymbol: 0.01,
  dailyLossLimitUsd: 0,
  realisedDailyLossUsd: 0,
  requireStopLoss: true,
  adminAllowNoStopLoss: false,
  requireTakeProfit: true,
  adminAllowNoTakeProfit: false,
  commandHasTakeProfit: false,
  disclosureAccepted: true,
};

const onlyMasterSwitchOff: LivePhaseBGateInput = {
  liveBrokerExecutionEnabled: false,
  globalLiveEnabled: true,
  userLiveApproved: true,
  userArmed: true,
  killSwitchEngaged: false,
  bridgeAccountType: "live",
  bridgeHeartbeatAgeSec: 5,
  bridgeEaVersion: "1.27",
  bridgeEnableLiveExecution: true,
  bridgeReadOnlyMode: false,
  bridgeTerminalConnected: true,
  bridgeAlgoTradingAllowed: true,
  commandSymbol: "EURUSD",
  commandVolume: 0.01,
  commandHasStopLoss: true,
  allowedSymbols: ALLOWED,
  maxLotForSymbol: 0.01,
  dailyLossLimitUsd: 100,
  realisedDailyLossUsd: 0,
  requireStopLoss: true,
  adminAllowNoStopLoss: false,
  requireTakeProfit: true,
  adminAllowNoTakeProfit: false,
  commandHasTakeProfit: true,
  disclosureAccepted: true,
};

function show(label: string, r: ReturnType<typeof evaluateLivePhaseBDispatchGate>) {
  console.log(`\n── ${label} ──`);
  console.log(`decision: ${r.decision}`);
  console.log(`primaryReason: ${r.primaryReason ?? "(none — PASS)"}`);
  console.log(`blockReasons (${r.blockReasons.length}):`);
  for (const g of r.gates) {
    const mark = g.passed ? "PASS" : "FAIL";
    console.log(`  ${mark.padEnd(4)} ${g.key}${g.detail ? "  — " + g.detail : ""}`);
  }
}

show("A) Realistic CURRENT state (best bridge: user 4, conn 287)", evaluateLivePhaseBDispatchGate(realCurrentState));
show("B) If master switch were the ONLY remaining issue (all 15 others passing)", evaluateLivePhaseBDispatchGate(onlyMasterSwitchOff));
