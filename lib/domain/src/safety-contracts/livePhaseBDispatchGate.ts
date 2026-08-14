// Phase B — Live Dispatch Gate (18-gate evaluator + disclosure)
//
// CONTRACT: this gate must return `decision: "PASS"` ONLY when ALL 18 gates
// pass. Any single failing gate returns `decision: "BLOCKED"` with the exact
// failing reason(s). The 18 gates are the original 16 base gates + #17
// MISSING_TAKE_PROFIT (governance-conditional on requireTakeProfit /
// adminAllowNoTakeProfit) + #18 DISCLOSURE_NOT_ACCEPTED. The default for
// `liveBrokerExecutionEnabled` is FALSE — when false, this gate ALWAYS appends
// BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED as a trailing sentinel block reason
// (NOT an evaluated gate), preserving the Phase A safety semantic.
//
// SAFETY (inviolable):
// - This is a pure function. No DB/network/IO. Caller assembles all inputs.
// - The OLD `liveDispatchGate.ts` (Phase A) is NOT touched — its contract that
//   it always returns canDispatchLive=false stays truthful for legacy callers.
// - This new file is consumed ONLY by `liveCommandPipeline.dispatchLiveCommand`
//   in the api-server Phase B path. The Build TT `placeLiveOrderGuarded()` /
//   `lib/liveTrading/guard.ts` chokepoint also stays untouched.

export const LIVE_BROKER_EXECUTION_ENABLED_DEFAULT = false as const;
export const MIN_LIVE_EA_VERSION = "1.27" as const;
export const LIVE_HEARTBEAT_MAX_AGE_SEC = 15 as const;

export type LivePhaseBGateKey =
  | "LIVE_BROKER_EXECUTION_DISABLED"           // server master switch off
  | "USER_NOT_ARMED_FOR_LIVE"                  // user has no isArmed row
  | "USER_NOT_LIVE_APPROVED"                   // admin per-user approval missing
  | "GLOBAL_LIVE_DISABLED"                     // singleton flag off
  | "KILL_SWITCH_ENGAGED"                      // per-user kill switch
  | "BRIDGE_NOT_LIVE_ACCOUNT"                  // accountType != live/real
  | "EA_HEARTBEAT_STALE"                       // > LIVE_HEARTBEAT_MAX_AGE_SEC
  | "EA_VERSION_TOO_OLD"                       // < MIN_LIVE_EA_VERSION
  | "EA_ENABLE_LIVE_EXECUTION_FALSE"           // EA input toggle
  | "EA_READ_ONLY_MODE_TRUE"                   // EA input toggle
  | "EA_TERMINAL_NOT_CONNECTED"                // EA reports
  | "EA_ALGO_TRADING_NOT_ALLOWED"              // EA reports
  | "SYMBOL_NOT_ALLOWED"                       // not in allowedSymbols
  | "VOLUME_EXCEEDS_MAX_LIVE_LOT"              // > per-market max
  | "DAILY_LOSS_LIMIT_REACHED"                 // realised loss today >= cap
  | "MISSING_STOP_LOSS"                        // command lacks SL (no override)
  | "MISSING_TAKE_PROFIT"                      // command lacks TP (no override)
  | "DISCLOSURE_NOT_ACCEPTED"                  // user has no row in live_risk_disclosure_acceptances
  | "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED";  // historical chokepoint reason

export interface LivePhaseBGateInput {
  // server master switches
  liveBrokerExecutionEnabled: boolean;
  globalLiveEnabled: boolean;
  userLiveApproved: boolean;

  // per-user arming state
  userArmed: boolean;
  killSwitchEngaged: boolean;

  // bridge facts (from latest heartbeat)
  bridgeAccountType: string | null;            // "live" | "real" | "demo" | other
  bridgeHeartbeatAgeSec: number | null;        // null = never
  bridgeEaVersion: string | null;              // e.g. "1.27"
  bridgeEnableLiveExecution: boolean | null;   // EA input
  bridgeReadOnlyMode: boolean | null;          // EA input
  bridgeTerminalConnected: boolean | null;
  bridgeAlgoTradingAllowed: boolean | null;

  // command facts
  commandSymbol: string;
  commandVolume: number;
  commandHasStopLoss: boolean;

  // settings facts
  allowedSymbols: string[];
  maxLotForSymbol: number;                     // resolved per-market max
  dailyLossLimitUsd: number;                   // 0 = unset/no limit
  realisedDailyLossUsd: number;                // already-realised loss today (>=0)
  requireStopLoss: boolean;
  adminAllowNoStopLoss: boolean;

  // Phase 22V Part 3 — per-user take-profit requirement mirrored from
  // user_master_live_access.require_take_profit (default true for
  // approved-shared-bridge users). When true, every entry order without
  // a positive TP is BLOCKED with MISSING_TAKE_PROFIT. Ops commands
  // (close/modify) bypass via `adminAllowNoTakeProfit=true`.
  requireTakeProfit: boolean;
  adminAllowNoTakeProfit: boolean;
  commandHasTakeProfit: boolean;

  // Phase B mode-separation Gap A — risk disclosure must be accepted (append-only
  // row in live_risk_disclosure_acceptances) before any live dispatch can PASS.
  // Default-deny: callers that omit this MUST pass false explicitly.
  disclosureAccepted: boolean;

  // Operator disclosure waiver — an OWNER/ADMIN may waive the disclosure
  // requirement for a user (recorded honestly on user_master_live_access as an
  // operator override, NEVER as the user accepting). When true, gate #18 is
  // satisfied even if `disclosureAccepted` is false, and the gate readout names
  // the waiver. Default-deny: omitted/undefined is treated as NOT waived.
  disclosureWaivedByOperator?: boolean;
}

export interface LivePhaseBGateResult {
  decision: "PASS" | "BLOCKED";
  blockReasons: LivePhaseBGateKey[];
  /** First failing reason (stable across calls). null when decision=PASS. */
  primaryReason: LivePhaseBGateKey | null;
  /** Each gate evaluated, in fixed order. UI-friendly. */
  gates: { key: LivePhaseBGateKey; passed: boolean; detail: string | null }[];
  evaluatedAt: string;
}

function parseVer(v: string | null): number {
  if (!v) return 0;
  const m = /^(\d+)\.(\d+)/.exec(v);
  if (!m) return 0;
  return Number(m[1]) + Number(m[2]) / 100;
}
const MIN_VER_NUM = parseVer(MIN_LIVE_EA_VERSION);

export function evaluateLivePhaseBDispatchGate(
  input: LivePhaseBGateInput,
): LivePhaseBGateResult {
  const gates: { key: LivePhaseBGateKey; passed: boolean; detail: string | null }[] = [];
  const fail = (key: LivePhaseBGateKey, detail: string | null) =>
    gates.push({ key, passed: false, detail });
  const pass = (key: LivePhaseBGateKey) =>
    gates.push({ key, passed: true, detail: null });

  // 1. Master switch — if off, this is the ONLY reason surfaced (after
  //    user/kill so the UI can still show the exact ordering), BUT we always
  //    append BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED last for audit/grep.
  if (!input.liveBrokerExecutionEnabled) fail("LIVE_BROKER_EXECUTION_DISABLED",
    "Server master switch LIVE_BROKER_EXECUTION_ENABLED is false.");
  else pass("LIVE_BROKER_EXECUTION_DISABLED");

  // 2. Per-user arming
  if (!input.userArmed) fail("USER_NOT_ARMED_FOR_LIVE",
    "User has not passed the 15-check arming gate.");
  else pass("USER_NOT_ARMED_FOR_LIVE");

  // 3. Per-user admin approval
  if (!input.userLiveApproved) fail("USER_NOT_LIVE_APPROVED",
    "Admin has not approved this user for live trading.");
  else pass("USER_NOT_LIVE_APPROVED");

  // 4. Global live enabled (singleton)
  if (!input.globalLiveEnabled) fail("GLOBAL_LIVE_DISABLED",
    "Global live trading flag is off.");
  else pass("GLOBAL_LIVE_DISABLED");

  // 5. Kill switch
  if (input.killSwitchEngaged) fail("KILL_SWITCH_ENGAGED",
    "User has engaged the live kill switch.");
  else pass("KILL_SWITCH_ENGAGED");

  // 6. Bridge account type LIVE
  const acct = (input.bridgeAccountType ?? "").toLowerCase();
  const isLive = acct === "live" || acct === "real";
  if (!isLive) fail("BRIDGE_NOT_LIVE_ACCOUNT",
    `Bridge reports accountType="${input.bridgeAccountType ?? "?"}". Must be live/real.`);
  else pass("BRIDGE_NOT_LIVE_ACCOUNT");

  // 7. Heartbeat fresh
  const hb = input.bridgeHeartbeatAgeSec;
  if (hb == null || hb > LIVE_HEARTBEAT_MAX_AGE_SEC) fail("EA_HEARTBEAT_STALE",
    hb == null ? "No heartbeat received yet."
      : `Last heartbeat ${hb}s ago (max ${LIVE_HEARTBEAT_MAX_AGE_SEC}s).`);
  else pass("EA_HEARTBEAT_STALE");

  // 8. EA version >= 1.27
  const verNum = parseVer(input.bridgeEaVersion);
  if (verNum < MIN_VER_NUM) fail("EA_VERSION_TOO_OLD",
    `EA reports v${input.bridgeEaVersion ?? "?"}. Requires v${MIN_LIVE_EA_VERSION}+.`);
  else pass("EA_VERSION_TOO_OLD");

  // 9. EA EnableLiveExecution=true
  if (input.bridgeEnableLiveExecution !== true) fail("EA_ENABLE_LIVE_EXECUTION_FALSE",
    "EA input EnableLiveExecution must be true.");
  else pass("EA_ENABLE_LIVE_EXECUTION_FALSE");

  // 10. EA ReadOnlyMode=false
  if (input.bridgeReadOnlyMode !== false) fail("EA_READ_ONLY_MODE_TRUE",
    "EA input ReadOnlyMode must be false.");
  else pass("EA_READ_ONLY_MODE_TRUE");

  // 11. Terminal connected
  if (input.bridgeTerminalConnected !== true) fail("EA_TERMINAL_NOT_CONNECTED",
    "EA did not report terminalConnected=true.");
  else pass("EA_TERMINAL_NOT_CONNECTED");

  // 12. Algo trading allowed
  if (input.bridgeAlgoTradingAllowed !== true) fail("EA_ALGO_TRADING_NOT_ALLOWED",
    "EA did not report algoTradingAllowed=true.");
  else pass("EA_ALGO_TRADING_NOT_ALLOWED");

  // 13. Symbol allowed
  if (!input.allowedSymbols.includes(input.commandSymbol)) fail("SYMBOL_NOT_ALLOWED",
    `Symbol ${input.commandSymbol} not in user's allowed list.`);
  else pass("SYMBOL_NOT_ALLOWED");

  // 14. Volume <= max for symbol
  if (input.commandVolume <= 0 || input.commandVolume > input.maxLotForSymbol) {
    fail("VOLUME_EXCEEDS_MAX_LIVE_LOT",
      `Volume ${input.commandVolume} exceeds max ${input.maxLotForSymbol} for ${input.commandSymbol}.`);
  } else pass("VOLUME_EXCEEDS_MAX_LIVE_LOT");

  // 15. Daily loss limit
  if (input.dailyLossLimitUsd > 0 && input.realisedDailyLossUsd >= input.dailyLossLimitUsd) {
    fail("DAILY_LOSS_LIMIT_REACHED",
      `Realised daily loss $${input.realisedDailyLossUsd.toFixed(2)} >= cap $${input.dailyLossLimitUsd.toFixed(2)}.`);
  } else pass("DAILY_LOSS_LIMIT_REACHED");

  // (bonus) Stop loss required
  if (input.requireStopLoss && !input.adminAllowNoStopLoss && !input.commandHasStopLoss) {
    fail("MISSING_STOP_LOSS", "Stop loss is required for live orders.");
  } else pass("MISSING_STOP_LOSS");

  // (Phase 22V Part 3) Take profit required for live bridge trading.
  if (input.requireTakeProfit && !input.adminAllowNoTakeProfit && !input.commandHasTakeProfit) {
    fail("MISSING_TAKE_PROFIT", "Take profit is required for live bridge trading.");
  } else pass("MISSING_TAKE_PROFIT");

  // (Gap A) Risk disclosure must be accepted — OR waived by an operator
  // (honest owner/admin override). The waiver is recorded distinctly on the
  // access row; here it only lets the gate PASS without faking acceptance.
  if (!input.disclosureAccepted && !input.disclosureWaivedByOperator) {
    fail("DISCLOSURE_NOT_ACCEPTED",
      "User has not accepted the live-trading risk disclosure.");
  } else if (!input.disclosureAccepted && input.disclosureWaivedByOperator) {
    gates.push({
      key: "DISCLOSURE_NOT_ACCEPTED",
      passed: true,
      detail: "Disclosure requirement waived by operator (owner/admin override).",
    });
  } else pass("DISCLOSURE_NOT_ACCEPTED");

  const failed = gates.filter((g) => !g.passed).map((g) => g.key);
  const blockReasons: LivePhaseBGateKey[] = [...failed];

  // Always append the legacy chokepoint sentinel as the LAST reason when
  // the master switch is off, so audit logs/CI greps still see it.
  if (!input.liveBrokerExecutionEnabled) {
    blockReasons.push("BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED");
  }

  return {
    decision: failed.length === 0 ? "PASS" : "BLOCKED",
    blockReasons,
    primaryReason: failed[0] ?? null,
    gates,
    evaluatedAt: new Date().toISOString(),
  };
}
