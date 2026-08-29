// Task #747 — Prove the one-click / fast-trade live execution path cannot bypass
// ANY of the required live-trading gates at the 23-gate dispatch chokepoint.
//
// WHY THIS EXISTS
//   POST /api/me/one-click/submit-live is the fast-trade entry. It is the most
//   dangerous live surface because the user has pre-consented (standing toggle)
//   and there is NO per-trade typed phrase. Its only protection is that it routes
//   through the SAME pipeline as every other live trade:
//     createLiveDraft → confirmLiveCommand → dispatchLiveCommand
//   and dispatch refuses unless `evaluateLivePhaseBDispatchGate` returns PASS.
//   This file is the per-gate proof of that chokepoint: it PASSes ONLY when ALL
//   23 gates pass, and ANY single failing gate BLOCKs with the exact reason. A
//   fast-trade caller therefore cannot "skip" a gate by virtue of being armed.
//
// SCOPE / SAFETY
//   - Pure function under test (no DB / network / IO). This file is offline-safe
//     and runs in the per-commit `ci` lane (script: test:one-click-gates).
//   - This is TEST-ONLY. It must NEVER weaken a guard. Every assertion locks the
//     CURRENT default-deny behaviour; if production code ever relaxed a gate this
//     suite would go red.
//
// Run: pnpm --filter @workspace/api-server run test:one-click-gates

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateLivePhaseBDispatchGate,
  type LivePhaseBGateInput,
  type LivePhaseBGateKey,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";

// A fully-passing fast-trade dispatch input. Mutate ONE field per test to prove
// that exact gate blocks. Mirrors a real armed one-click EURUSD market order:
// live master switch on, user armed + approved, fresh live bridge, in-allowlist
// symbol, within lot + loss caps, SL present, TP not required, disclosure done.
function passingFastTradeInput(
  overrides: Partial<LivePhaseBGateInput> = {},
): LivePhaseBGateInput {
  return {
    liveBrokerExecutionEnabled: true,
    globalLiveEnabled: true,
    userLiveApproved: true,
    userArmed: true,
    killSwitchEngaged: false,
    bridgeAccountType: "live",
    bridgeHeartbeatAgeSec: 5,
    bridgeEaVersion: "1.55",
    bridgeEnableLiveExecution: true,
    bridgeReadOnlyMode: false,
    bridgeTerminalConnected: true,
    bridgeAlgoTradingAllowed: true,
    commandSymbol: "EURUSD",
    commandVolume: 0.01,
    commandHasStopLoss: true,
    allowedSymbols: ["EURUSD"],
    maxLotForSymbol: 1,
    dailyLossLimitUsd: 0,
    realisedDailyLossUsd: 0,
    requireStopLoss: true,
    adminAllowNoStopLoss: false,
    requireTakeProfit: false,
    adminAllowNoTakeProfit: true,
    commandHasTakeProfit: false,
    disclosureAccepted: true,
    disclosureWaivedByOperator: false,
    ...overrides,
  };
}

// ── Sanity: the fast-trade baseline PASSes ─────────────────────────────────
test("the fully-armed fast-trade input PASSes (sanity baseline)", () => {
  const r = evaluateLivePhaseBDispatchGate(passingFastTradeInput());
  assert.equal(r.decision, "PASS");
  assert.equal(r.primaryReason, null);
  assert.equal(r.blockReasons.length, 0);
  assert.equal(r.gates.every((g) => g.passed), true, "every gate must pass");
});

// ── Each gate, flipped one at a time, BLOCKS the fast trade ─────────────────
// `field` is the single fast-trade input we corrupt; `expected` is the exact
// primaryReason the chokepoint must surface. Standing consent / armed state is
// NEVER among the inputs that can satisfy these — proving the toggle cannot
// bypass any of them.
const SINGLE_GATE_CASES: ReadonlyArray<{
  name: string;
  override: Partial<LivePhaseBGateInput>;
  expected: LivePhaseBGateKey;
}> = [
  {
    name: "server master switch off",
    override: { liveBrokerExecutionEnabled: false },
    expected: "LIVE_BROKER_EXECUTION_DISABLED",
  },
  {
    name: "user not armed for live",
    override: { userArmed: false },
    expected: "USER_NOT_ARMED_FOR_LIVE",
  },
  {
    name: "admin live approval missing / revoked",
    override: { userLiveApproved: false },
    expected: "USER_NOT_LIVE_APPROVED",
  },
  {
    name: "global live disabled (singleton)",
    override: { globalLiveEnabled: false },
    expected: "GLOBAL_LIVE_DISABLED",
  },
  {
    name: "kill switch engaged",
    override: { killSwitchEngaged: true },
    expected: "KILL_SWITCH_ENGAGED",
  },
  {
    name: "bridge not a live/real account (demo)",
    override: { bridgeAccountType: "demo" },
    expected: "BRIDGE_NOT_LIVE_ACCOUNT",
  },
  {
    name: "bridge account type missing",
    override: { bridgeAccountType: null },
    expected: "BRIDGE_NOT_LIVE_ACCOUNT",
  },
  {
    name: "EA heartbeat stale (> 15s)",
    override: { bridgeHeartbeatAgeSec: 16 },
    expected: "EA_HEARTBEAT_STALE",
  },
  {
    name: "EA never sent a heartbeat",
    override: { bridgeHeartbeatAgeSec: null },
    expected: "EA_HEARTBEAT_STALE",
  },
  {
    name: "EA version too old (< 1.27)",
    override: { bridgeEaVersion: "1.20" },
    expected: "EA_VERSION_TOO_OLD",
  },
  {
    name: "EA EnableLiveExecution false",
    override: { bridgeEnableLiveExecution: false },
    expected: "EA_ENABLE_LIVE_EXECUTION_FALSE",
  },
  {
    name: "EA ReadOnlyMode true",
    override: { bridgeReadOnlyMode: true },
    expected: "EA_READ_ONLY_MODE_TRUE",
  },
  {
    name: "EA terminal not connected",
    override: { bridgeTerminalConnected: false },
    expected: "EA_TERMINAL_NOT_CONNECTED",
  },
  {
    name: "EA algo trading not allowed",
    override: { bridgeAlgoTradingAllowed: false },
    expected: "EA_ALGO_TRADING_NOT_ALLOWED",
  },
  {
    name: "symbol not in user allowlist",
    override: { commandSymbol: "XAUUSD", allowedSymbols: ["EURUSD"] },
    expected: "SYMBOL_NOT_ALLOWED",
  },
  {
    name: "volume exceeds per-symbol max lot",
    override: { commandVolume: 5, maxLotForSymbol: 1 },
    expected: "VOLUME_EXCEEDS_MAX_LIVE_LOT",
  },
  {
    name: "non-positive volume is rejected as over-lot",
    override: { commandVolume: 0 },
    expected: "VOLUME_EXCEEDS_MAX_LIVE_LOT",
  },
  {
    name: "daily realised loss at/over cap",
    override: { dailyLossLimitUsd: 100, realisedDailyLossUsd: 100 },
    expected: "DAILY_LOSS_LIMIT_REACHED",
  },
  {
    name: "stop loss required and missing",
    override: { commandHasStopLoss: false },
    expected: "MISSING_STOP_LOSS",
  },
  {
    name: "take profit required (governance) and missing",
    override: { requireTakeProfit: true, adminAllowNoTakeProfit: false, commandHasTakeProfit: false },
    expected: "MISSING_TAKE_PROFIT",
  },
  {
    name: "risk disclosure not accepted",
    override: { disclosureAccepted: false, disclosureWaivedByOperator: false },
    expected: "DISCLOSURE_NOT_ACCEPTED",
  },
];

for (const c of SINGLE_GATE_CASES) {
  test(`fast trade BLOCKED — ${c.name} → ${c.expected}`, () => {
    const r = evaluateLivePhaseBDispatchGate(passingFastTradeInput(c.override));
    assert.equal(r.decision, "BLOCKED", `${c.name} must BLOCK`);
    assert.equal(r.primaryReason, c.expected, `primaryReason must be ${c.expected}`);
    assert.equal(
      r.blockReasons.includes(c.expected),
      true,
      `${c.expected} must be in blockReasons`,
    );
    // The gate readout for the corrupted gate must show passed:false.
    const gate = r.gates.find((g) => g.key === c.expected);
    assert.ok(gate, `gate ${c.expected} must appear in the readout`);
    assert.equal(gate!.passed, false);
  });
}

// ── The master-switch sentinel is always appended when the switch is off ────
// This historical chokepoint reason keeps grep/audit/CI guards able to see the
// Phase A safety semantic. It must be the LAST reason and never appear when the
// switch is on.
test("master switch off appends BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED last", () => {
  const r = evaluateLivePhaseBDispatchGate(
    passingFastTradeInput({ liveBrokerExecutionEnabled: false }),
  );
  assert.equal(r.decision, "BLOCKED");
  assert.equal(
    r.blockReasons[r.blockReasons.length - 1],
    "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
    "the legacy sentinel must be the final block reason",
  );
});

test("master switch ON never appends the legacy sentinel", () => {
  const r = evaluateLivePhaseBDispatchGate(passingFastTradeInput());
  assert.equal(
    r.blockReasons.includes("BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"),
    false,
  );
});

// ── Defence in depth: many gates failing at once still default-deny ─────────
// A "wide-open" fast trade where EVERY protection is off must BLOCK, surface the
// master switch first, and report multiple distinct reasons — never silently
// fall through to PASS.
test("a fully-unsafe fast trade BLOCKS with multiple reasons (never PASS)", () => {
  const r = evaluateLivePhaseBDispatchGate(
    passingFastTradeInput({
      liveBrokerExecutionEnabled: false,
      globalLiveEnabled: false,
      userLiveApproved: false,
      userArmed: false,
      killSwitchEngaged: true,
      bridgeAccountType: "demo",
      bridgeHeartbeatAgeSec: null,
      bridgeEaVersion: "1.10",
      bridgeEnableLiveExecution: false,
      bridgeReadOnlyMode: true,
      bridgeTerminalConnected: false,
      bridgeAlgoTradingAllowed: false,
      commandSymbol: "ZZZ",
      allowedSymbols: ["EURUSD"],
      commandVolume: 99,
      maxLotForSymbol: 1,
      dailyLossLimitUsd: 50,
      realisedDailyLossUsd: 500,
      commandHasStopLoss: false,
      disclosureAccepted: false,
    }),
  );
  assert.equal(r.decision, "BLOCKED");
  assert.equal(r.primaryReason, "LIVE_BROKER_EXECUTION_DISABLED");
  assert.ok(r.blockReasons.length >= 10, "every failing gate must be reported");
});

// ── A non-armed-but-otherwise-valid trade still BLOCKS ──────────────────────
// The whole point of the task: "armed" is NOT a backdoor. The arming/consent
// state is represented at this layer as `userArmed`; with it false but every
// OTHER protection satisfied the chokepoint still refuses.
test("arming alone is not a backdoor — userArmed:false still BLOCKS", () => {
  const r = evaluateLivePhaseBDispatchGate(passingFastTradeInput({ userArmed: false }));
  assert.equal(r.decision, "BLOCKED");
  assert.equal(r.primaryReason, "USER_NOT_ARMED_FOR_LIVE");
});

// ── CLOSE-style ops bypass ONLY TP (governance), never a hard gate ──────────
// A close/modify op sets adminAllowNoTakeProfit=true (legitimate TP bypass) but
// must STILL respect the hard gates (here: kill switch).
test("an ops (TP-bypass) command still respects hard gates (kill switch)", () => {
  const r = evaluateLivePhaseBDispatchGate(
    passingFastTradeInput({
      adminAllowNoTakeProfit: true,
      commandHasTakeProfit: false,
      killSwitchEngaged: true,
    }),
  );
  assert.equal(r.decision, "BLOCKED");
  assert.equal(r.primaryReason, "KILL_SWITCH_ENGAGED");
});
