// Phase B QA — 15-gate truth table for evaluateLivePhaseBDispatchGate.
//
// Pure-function tests of the domain evaluator. No DB, no HTTP, no broker
// calls. Each test mutates one input from a "happy path" baseline so the
// FAIL row pinpoints exactly which gate caught it.
import {
  evaluateLivePhaseBDispatchGate,
  type LivePhaseBGateInput,
  type LivePhaseBGateKey,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";

type Row = { name: string; ok: boolean; got: string; want: string };
const results: Row[] = [];

function baseline(): LivePhaseBGateInput {
  return {
    liveBrokerExecutionEnabled: true,
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
}

function record(name: string, got: ReturnType<typeof evaluateLivePhaseBDispatchGate>,
                wantDecision: "PASS" | "BLOCKED", wantReason?: LivePhaseBGateKey) {
  const okDecision = got.decision === wantDecision;
  const okReason = wantReason ? got.blockReasons.includes(wantReason) : true;
  results.push({
    name, ok: okDecision && okReason,
    got: `${got.decision} [${got.blockReasons.join(",")}]`,
    want: `${wantDecision}${wantReason ? " containing " + wantReason : ""}`,
  });
}

// 00. Happy path → PASS.
record("00-happy-path-all-gates-pass", evaluateLivePhaseBDispatchGate(baseline()), "PASS");

const cases: Array<[string, (b: LivePhaseBGateInput) => void, LivePhaseBGateKey]> = [
  ["01-master-switch-off",         (b) => { b.liveBrokerExecutionEnabled = false; },        "LIVE_BROKER_EXECUTION_DISABLED"],
  ["02-user-not-armed",            (b) => { b.userArmed = false; },                          "USER_NOT_ARMED_FOR_LIVE"],
  ["03-user-not-approved",         (b) => { b.userLiveApproved = false; },                   "USER_NOT_LIVE_APPROVED"],
  ["04-global-live-disabled",      (b) => { b.globalLiveEnabled = false; },                  "GLOBAL_LIVE_DISABLED"],
  ["05-kill-switch-engaged",       (b) => { b.killSwitchEngaged = true; },                   "KILL_SWITCH_ENGAGED"],
  ["06-account-not-live",          (b) => { b.bridgeAccountType = "demo"; },                 "BRIDGE_NOT_LIVE_ACCOUNT"],
  ["07-heartbeat-stale",           (b) => { b.bridgeHeartbeatAgeSec = 30; },                 "EA_HEARTBEAT_STALE"],
  ["08-ea-version-too-old",        (b) => { b.bridgeEaVersion = "1.26"; },                   "EA_VERSION_TOO_OLD"],
  ["09-enable-live-execution-off", (b) => { b.bridgeEnableLiveExecution = false; },          "EA_ENABLE_LIVE_EXECUTION_FALSE"],
  ["10-read-only-mode-on",         (b) => { b.bridgeReadOnlyMode = true; },                  "EA_READ_ONLY_MODE_TRUE"],
  ["11-terminal-disconnected",     (b) => { b.bridgeTerminalConnected = false; },            "EA_TERMINAL_NOT_CONNECTED"],
  ["12-algo-trading-not-allowed",  (b) => { b.bridgeAlgoTradingAllowed = false; },           "EA_ALGO_TRADING_NOT_ALLOWED"],
  ["13-symbol-not-allowed",        (b) => { b.commandSymbol = "BTCUSD"; },                   "SYMBOL_NOT_ALLOWED"],
  ["14-volume-exceeds-max",        (b) => { b.commandVolume = 0.5; },                        "VOLUME_EXCEEDS_MAX_LIVE_LOT"],
  ["15-daily-loss-limit",          (b) => { b.realisedDailyLossUsd = 100; },                 "DAILY_LOSS_LIMIT_REACHED"],
  ["18-disclosure-not-accepted",   (b) => { b.disclosureAccepted = false; },                 "DISCLOSURE_NOT_ACCEPTED"],
  ["16-missing-stop-loss",         (b) => { b.commandHasStopLoss = false; },                 "MISSING_STOP_LOSS"],
  ["19-missing-take-profit",       (b) => { b.commandHasTakeProfit = false; },               "MISSING_TAKE_PROFIT"],
];

for (const [name, mutate, reason] of cases) {
  const b = baseline();
  mutate(b);
  record(name, evaluateLivePhaseBDispatchGate(b), "BLOCKED", reason);
}

// Bonus: master-switch off ALSO appends BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED.
{
  const b = baseline();
  b.liveBrokerExecutionEnabled = false;
  const r = evaluateLivePhaseBDispatchGate(b);
  results.push({
    name: "17-master-switch-off-appends-legacy-sentinel",
    ok: r.blockReasons.includes("BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"),
    got: `[${r.blockReasons.join(",")}]`,
    want: "contains BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
  });
}

let failed = 0;
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}  got=${r.got}  want=${r.want}`);
  if (!r.ok) failed++;
}
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed}/${results.length} live Phase B gate tests passed`);
process.exit(failed === 0 ? 0 : 1);
