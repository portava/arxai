// T003 — Pure account-mode precedence resolver.
//
// Extracted from routes/meUnifiedMode.ts so unit tests can exercise the
// precedence matrix without spinning up the HTTP server or seeding the
// DB. The route handler calls this function with the values it has
// already fetched from the per-user, userId-scoped data layer. No DB
// access here, no IO, no side effects — a pure function.
//
// SAFETY: this helper is the single source of truth for which mode the
// UI shows. Behaviour preserved byte-for-byte from the previous inline
// implementation. Do not relax any branch — every branch corresponds to
// a hard rule in the T003 spec (an armed user always stays LIVE_SHARED;
// blocked states attach `cleanBlockedReason`; the user-facing copy
// never leaks operator/admin diagnostics).

export type CurrentAccountMode = "LIVE_SHARED" | "DEMO" | "PAPER";

export interface PrecedenceInput {
  isAdmin: boolean;
  liveExecutionArmed: boolean;
  sharedMasterAttached: boolean;
  effectiveLiveBrokerOn: boolean;
  serverEnvOn: boolean;
  operatorOn: boolean;
  accountShellTradingMode: "DISABLED" | "DEMO" | "SIMULATED" | "LIVE";
  accountShellTradingStatus: string;
  needsReviewItems: boolean;
  /**
   * Task #737 — an admin-approved HUMAN trader attached to the shared live
   * bridge. Optional; defaults to false so existing call sites and tests are
   * byte-for-byte unchanged. When true (and the user is NOT yet armed), the UI
   * shows LIVE_SHARED for DISPLAY with an honest "complete live confirmation"
   * blocked reason — execution stays blocked (every dispatch still re-runs the
   * full Phase B gate set + the new activation gate). Never grants execution.
   */
  approvedTraderBridgeAssigned?: boolean;
}

export interface PrecedenceResult {
  currentAccountMode: CurrentAccountMode;
  cleanBlockedReason: string | null;
  cleanModeLabel: string;
  cleanUserMessage: string;
  userCanManualTrade: boolean;
  userCanAutoTrade: boolean;
}

export function computeAccountModePrecedence(
  input: PrecedenceInput,
): PrecedenceResult {
  const {
    isAdmin,
    liveExecutionArmed,
    sharedMasterAttached,
    effectiveLiveBrokerOn,
    serverEnvOn,
    operatorOn,
    accountShellTradingMode,
    accountShellTradingStatus,
    needsReviewItems,
    approvedTraderBridgeAssigned = false,
  } = input;

  let currentAccountMode: CurrentAccountMode;
  let cleanBlockedReason: string | null = null;

  if (liveExecutionArmed) {
    currentAccountMode = "LIVE_SHARED";
    if (accountShellTradingMode === "DISABLED") {
      cleanBlockedReason = isAdmin
        ? "User is armed for live, but user_trading_permissions.tradingMode=DISABLED. " +
          "Operator has revoked trading. Disarm via MT5 Setup or restore the user's " +
          "tradingMode to LIVE."
        : "Your operator has paused trading on your account. Live dispatch will " +
          "remain blocked until trading is re-enabled.";
    } else if (
      accountShellTradingMode === "SIMULATED" ||
      accountShellTradingMode === "DEMO"
    ) {
      cleanBlockedReason = isAdmin
        ? `User is armed for live, but user_trading_permissions.tradingMode=` +
          `${accountShellTradingMode}. Live dispatch will refuse. Restore tradingMode=LIVE ` +
          `or disarm.`
        : "Live execution is currently disabled on your account. Your operator must " +
          "restore live mode before trades will dispatch.";
    } else if (accountShellTradingStatus !== "ACTIVE") {
      cleanBlockedReason = isAdmin
        ? `User is armed for live, but accountShell.tradingStatus=${accountShellTradingStatus}. ` +
          `Live dispatch will refuse until ACTIVE.`
        : "Your account is not active for live trading right now. Contact your operator.";
    } else if (!sharedMasterAttached) {
      cleanBlockedReason =
        "Your live shared-master assignment is pending. You are armed for live, " +
        "but your allocation slice is not active yet. Contact your operator to " +
        "finish onboarding.";
    } else if (!effectiveLiveBrokerOn) {
      cleanBlockedReason = isAdmin
        ? `Live broker dispatch is OFF at the server master switch. ` +
          `Required env: ARX_LIVE_BROKER_EXECUTION_ENABLED=true ` +
          `(case-insensitive, trimmed). Current parses to ${serverEnvOn}. ` +
          `Operator DB arm flag is ${operatorOn}.`
        : "Live execution is currently paused for maintenance. Your account is armed; " +
          "trades will resume automatically once the operator re-enables dispatch.";
    }
  } else if (approvedTraderBridgeAssigned) {
    // Task #737 — admin-approved HUMAN trader attached to the shared live
    // bridge, but not yet armed/confirmed. Show LIVE_SHARED for DISPLAY so the
    // UI is honest about the account's intent; execution stays BLOCKED (the
    // non-null cleanBlockedReason forces userCanManualTrade/AutoTrade=false and
    // every dispatch still re-runs the full Phase B gate set + activation gate).
    currentAccountMode = "LIVE_SHARED";
    cleanBlockedReason = isAdmin
      ? "Trader is admin-approved and attached to the shared live bridge but has " +
        "not completed live confirmation. Use Full Live Activation (typed phrase " +
        "ENABLE LIVE TRADING) or have the trader arm + confirm. Execution stays " +
        "blocked until then."
      : "Complete live confirmation to start placing live orders. Your operator can " +
        "enable Full Live Activation on your behalf.";
  } else if (accountShellTradingMode === "DEMO") {
    currentAccountMode = "DEMO";
  } else if (accountShellTradingMode === "SIMULATED") {
    currentAccountMode = "PAPER";
  } else if (accountShellTradingMode === "LIVE") {
    currentAccountMode = "DEMO";
    cleanBlockedReason = isAdmin
      ? "User trading mode is LIVE but per-user arming has not been completed. " +
        "Run the 15-check arming gate from MT5 Setup."
      : "Your operator has enabled live trading on your account. Complete the " +
        "MT5 Setup → Arm Live Trading checklist to start placing live orders.";
  } else {
    currentAccountMode = "DEMO";
    if (accountShellTradingMode === "DISABLED") {
      cleanBlockedReason = isAdmin
        ? "user_trading_permissions.tradingMode=DISABLED. Set to DEMO/SIMULATED/LIVE to enable."
        : "Trading is not enabled on your account yet. Contact your operator.";
    }
  }

  const cleanModeLabel =
    currentAccountMode === "LIVE_SHARED"
      ? "Live (Shared Master MT5)"
      : currentAccountMode === "DEMO"
        ? "Demo Mode"
        : "Paper Mode";

  const cleanUserMessage =
    currentAccountMode === "LIVE_SHARED"
      ? cleanBlockedReason
        ? cleanBlockedReason
        : "Live trading is active on your shared-master allocation. Real money risk."
      : currentAccountMode === "DEMO"
        ? "Demo mode — practice only. No real money is at risk."
        : "Paper mode — simulated orders only. No broker placement.";

  const userCanManualTrade =
    accountShellTradingStatus === "ACTIVE" &&
    !needsReviewItems &&
    cleanBlockedReason === null;
  const userCanAutoTrade =
    userCanManualTrade &&
    currentAccountMode === "LIVE_SHARED" &&
    cleanBlockedReason === null;

  return {
    currentAccountMode,
    cleanBlockedReason,
    cleanModeLabel,
    cleanUserMessage,
    userCanManualTrade,
    userCanAutoTrade,
  };
}
