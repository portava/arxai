// Phase B QA — truth table for evaluateLivePhaseBDispatchGate (21 gates:
// the original 18 + foundation gates #19 PROVENANCE_UNPROVEN, #20
// STRATEGY_NOT_LIVE_PROMOTED, #21 CAPITAL_TIER_EXCEEDED).
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
    // Foundation gates #19–#21 — a fully-proven human entry: fresh
    // tradeable-origin provenance covered by the integrity hash, promotion
    // not required (USER actor), and a T1 tier with plenty of headroom.
    foundation: {
      isEntryCommand: true,
      provenance: {
        envelopePresent: true,
        source: "LIVE_TICK",
        ageMs: 1_000,
        maxAgeMs: 900_000,
        integrityCovered: true,
      },
      edgePromotion: {
        required: false,
        edgeRefPresent: false,
        edgeStatus: null,
        edgeLiveAllowed: false,
        edgeEvidenceValid: false,
      },
      capital: {
        tier: "T1",
        openExposureUsd: 1_000,
        candidateExposureUsd: 1_100,
        userMaxLot: null,
      },
    },
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
  // ── Foundation gate #19 PROVENANCE_UNPROVEN ──
  ["g19-provenance-envelope-missing", (b) => { b.foundation!.provenance.envelopePresent = false; }, "PROVENANCE_UNPROVEN"],
  ["g19-provenance-untradeable-source", (b) => { b.foundation!.provenance.source = "MODEL"; },      "PROVENANCE_UNPROVEN"],
  ["g19-provenance-stale",         (b) => { b.foundation!.provenance.ageMs = 900_001; },            "PROVENANCE_UNPROVEN"],
  ["g19-provenance-age-unknown",   (b) => { b.foundation!.provenance.ageMs = null; },               "PROVENANCE_UNPROVEN"],
  ["g19-provenance-tampered",      (b) => { b.foundation!.provenance.integrityCovered = false; },   "PROVENANCE_UNPROVEN"],
  // ── Foundation gate #20 STRATEGY_NOT_LIVE_PROMOTED ──
  ["g20-required-no-edge-ref",     (b) => { b.foundation!.edgePromotion.required = true; },         "STRATEGY_NOT_LIVE_PROMOTED"],
  ["g20-edge-not-live-candidate",  (b) => {
    b.foundation!.edgePromotion = { required: true, edgeRefPresent: true, edgeStatus: "SHADOW", edgeLiveAllowed: false, edgeEvidenceValid: true };
  }, "STRATEGY_NOT_LIVE_PROMOTED"],
  ["g20-owner-press-missing",      (b) => {
    b.foundation!.edgePromotion = { required: true, edgeRefPresent: true, edgeStatus: "LIVE_CANDIDATE", edgeLiveAllowed: false, edgeEvidenceValid: true };
  }, "STRATEGY_NOT_LIVE_PROMOTED"],
  ["g20-evidence-invalid",         (b) => {
    b.foundation!.edgePromotion = { required: true, edgeRefPresent: true, edgeStatus: "LIVE_CANDIDATE", edgeLiveAllowed: true, edgeEvidenceValid: false };
  }, "STRATEGY_NOT_LIVE_PROMOTED"],
  // ── Foundation gate #21 CAPITAL_TIER_EXCEEDED ──
  ["g21-unknown-tier-fails-closed", (b) => { b.foundation!.capital.tier = "PLATINUM"; },            "CAPITAL_TIER_EXCEEDED"],
  ["g21-tier-lot-cap-exceeded",    (b) => { b.foundation!.capital.tier = "T0"; b.commandVolume = 0.05; }, "CAPITAL_TIER_EXCEEDED"],
  ["g21-tier-exposure-exceeded",   (b) => { b.foundation!.capital.openExposureUsd = 30_000; },      "CAPITAL_TIER_EXCEEDED"],
  ["g21-exposure-unknown-fails-closed", (b) => { b.foundation!.capital.openExposureUsd = null; },   "CAPITAL_TIER_EXCEEDED"],
];

for (const [name, mutate, reason] of cases) {
  const b = baseline();
  mutate(b);
  record(name, evaluateLivePhaseBDispatchGate(b), "BLOCKED", reason);
}

// Foundation pass-paths: ops commands are exempt from all three foundation
// gates; a preview caller with no foundation block gets a loud
// "NOT EVALUATED" detail — passed, never silently absent from the readout.
{
  const b = baseline();
  b.foundation!.isEntryCommand = false;
  b.foundation!.provenance.envelopePresent = false;
  b.foundation!.edgePromotion.required = true;
  b.foundation!.capital.tier = "PLATINUM";
  record("g19-21-ops-command-exempt", evaluateLivePhaseBDispatchGate(b), "PASS");
}
{
  const b = baseline();
  delete (b as { foundation?: unknown }).foundation;
  const r = evaluateLivePhaseBDispatchGate(b);
  const foundationRows = r.gates.filter((g) =>
    g.key === "PROVENANCE_UNPROVEN" || g.key === "STRATEGY_NOT_LIVE_PROMOTED" || g.key === "CAPITAL_TIER_EXCEEDED");
  results.push({
    name: "g19-21-preview-caller-loud-not-evaluated",
    ok: r.decision === "PASS"
      && foundationRows.length === 3
      && foundationRows.every((g) => g.passed && (g.detail ?? "").includes("NOT EVALUATED")),
    got: `${r.decision} details=[${foundationRows.map((g) => g.detail ?? "null").join(" | ")}]`,
    want: "PASS with 3 foundation rows carrying a loud NOT EVALUATED detail",
  });
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
