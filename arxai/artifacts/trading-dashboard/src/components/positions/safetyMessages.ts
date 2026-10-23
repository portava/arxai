// Plain-English translations for the Phase B safety-gate codes that close
// and modify can return. Normal users see the friendly sentence; admins and
// operators also see the raw code in small grey text for triage.
//
// Keep these strings calm and specific — they appear inside toasts when a
// close or SL/TP edit is refused by the server.

export const FRIENDLY_SAFETY_MESSAGES: Record<string, string> = {
  // Master switches
  LIVE_BROKER_EXECUTION_DISABLED: "Live trading is turned off on the server. An operator needs to enable it before any live action can run.",
  BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED: "Live broker placement isn't enabled on this build. Contact your operator.",

  // Per-user arming / approval
  USER_NOT_ARMED_FOR_LIVE: "Your account isn't armed for live trading yet. Arm it in MT5 Setup → Live Execution Control first.",
  USER_NOT_APPROVED_FOR_LIVE: "Live trading isn't approved on your account yet. An admin needs to approve it.",
  GLOBAL_LIVE_KILL_ENGAGED: "The global live kill switch is engaged. Live close/modify is paused until it's lifted.",
  KILL_SWITCH_TRIGGERED: "The emergency kill switch is on. Lift it before sending live actions.",

  // Bridge / EA state
  ACCOUNT_TYPE_NOT_LIVE: "Your MT5 account is reporting as demo, not live. Switch to a live MT5 account on the EA.",
  HEARTBEAT_TOO_OLD: "ARX hasn't heard from your MT5 EA recently. Check that MT5 is open and the EA is attached.",
  EA_VERSION_TOO_OLD: "Your MT5 EA is out of date. Install EA v1.27 or later from MT5 Setup.",
  EA_LIVE_EXECUTION_DISABLED: "Your EA has live execution turned off. Set EnableLiveExecution = true in the EA Inputs.",
  EA_READ_ONLY_MODE: "Your EA is in read-only mode. Set ReadOnlyMode = false in the EA Inputs.",
  TERMINAL_NOT_CONNECTED: "Your MT5 terminal isn't connected to the broker right now. Wait for the connection to recover.",
  ALGO_TRADING_NOT_ALLOWED: "MT5 has AutoTrading disabled. Click the AutoTrading button in MT5 to enable it.",

  // Trade-level rules
  SYMBOL_NOT_ALLOWED: "This symbol isn't on your live allowlist. Add it on the Live Settings page first.",
  LOT_EXCEEDS_MAX: "The lot size is above your per-symbol cap. Reduce the lot or raise the cap on Live Settings.",
  DAILY_LOSS_LIMIT_REACHED: "You've hit your daily loss cap. Live actions are paused until the cap resets.",
  MISSING_STOP_LOSS: "A stop loss is required for live actions on this account. Add a stop loss and try again.",

  // Pipeline
  DUPLICATE_LIVE_IDEMPOTENCY_KEY: "The same action was just submitted. Wait a moment and try again if it didn't go through.",
  POSITION_NOT_FOUND: "We couldn't find this position on your live account. It may have already closed.",
  AUTH_REQUIRED: "Your session expired. Sign in again to continue.",
  NO_CHANGES: "Enter a new stop loss or take profit before submitting.",
};

export interface FriendlyError {
  /** Plain-English sentence that's safe to show every user. */
  friendly: string;
  /** Raw code, suitable for admin/debug surfaces only. */
  raw: string | null;
}

/**
 * Resolve a server response payload into a friendly + raw pair.
 * Accepts shapes like { primaryReason, error, blockReasons[], message }.
 */
export function resolveSafetyError(payload: unknown, httpStatus?: number): FriendlyError {
  const p = (payload ?? {}) as {
    primaryReason?: string;
    error?: string;
    blockReasons?: string[];
    message?: string;
  };
  const raw = p.primaryReason
    ?? p.blockReasons?.[0]
    ?? p.error
    ?? (httpStatus ? `HTTP_${httpStatus}` : null);
  if (raw && FRIENDLY_SAFETY_MESSAGES[raw]) {
    return { friendly: FRIENDLY_SAFETY_MESSAGES[raw], raw };
  }
  // Fall back to server-provided message, else a generic but honest line.
  if (p.message && typeof p.message === "string") {
    return { friendly: p.message, raw };
  }
  return {
    friendly: "The server refused this action for a safety reason. No order was sent to your broker.",
    raw,
  };
}
