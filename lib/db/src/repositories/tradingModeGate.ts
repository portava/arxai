// Per-user trading-mode change gate. Pure functions used by:
//   - artifacts/api-server/src/routes/adminTrading.ts (POST /admin/users/:id/permissions)
//   - scripts/src/qaPerUserTradingMode.ts (truth-table QA)
//
// Spec mapping: PAPER ≡ SIMULATED (canonical column value).
// LIVE escalation requires a typed phrase + a non-trivial operator reason.

export type TradingMode = "DISABLED" | "SIMULATED" | "DEMO" | "LIVE";

export const TRADING_MODE_VALUES: readonly TradingMode[] = ["DISABLED", "SIMULATED", "DEMO", "LIVE"] as const;

export const LIVE_CONFIRM_PHRASE = "CONFIRM LIVE MODE";
export const LIVE_REASON_MIN_LENGTH = 10;

export type ModeChangeError =
  | "LIVE_CONFIRM_PHRASE_REQUIRED"
  | "LIVE_REASON_TOO_SHORT"
  | "INVALID_MODE";

export type ValidateModeChangeInput = {
  before: { tradingMode: string } | null;
  requestedMode?: string;
  reason?: string;
  confirmPhrase?: string;
};

export type ValidateModeChangeResult =
  | { ok: true }
  | { ok: false; error: ModeChangeError; message: string };

/** Pure: returns ok=false only when the operator is escalating into LIVE
 *  without the typed-phrase + reason. Demotions and non-LIVE switches are
 *  always allowed (still subject to admin auth at the route layer). */
export function validateModeChangeRequest(input: ValidateModeChangeInput): ValidateModeChangeResult {
  const requested = input.requestedMode;
  if (!requested) return { ok: true };
  if (!TRADING_MODE_VALUES.includes(requested as TradingMode)) {
    return { ok: false, error: "INVALID_MODE", message: `Mode must be one of ${TRADING_MODE_VALUES.join(", ")}.` };
  }
  const previous = input.before?.tradingMode ?? "DISABLED";
  if (requested === "LIVE" && previous !== "LIVE") {
    const phrase = (input.confirmPhrase ?? "").trim();
    if (phrase !== LIVE_CONFIRM_PHRASE) {
      return { ok: false, error: "LIVE_CONFIRM_PHRASE_REQUIRED", message: `Type "${LIVE_CONFIRM_PHRASE}" to escalate this user to LIVE.` };
    }
    if ((input.reason ?? "").trim().length < LIVE_REASON_MIN_LENGTH) {
      return { ok: false, error: "LIVE_REASON_TOO_SHORT", message: `A reason of at least ${LIVE_REASON_MIN_LENGTH} characters is required when escalating to LIVE.` };
    }
  }
  return { ok: true };
}

/** Pure: returns the mode-change-audit patch fields. Empty fields when the
 *  mode is unchanged or no mode was requested. */
export function buildModeChangePatch(input: {
  before: { tradingMode: string } | null;
  requestedMode?: string;
  reason?: string;
}): {
  previousTradingMode: string | null;
  tradingModeUpdatedAt: Date | null;
  tradingModeChangeReason: string | null;
} {
  const requested = input.requestedMode;
  if (!requested) return { previousTradingMode: null, tradingModeUpdatedAt: null, tradingModeChangeReason: null };
  const previous = input.before?.tradingMode ?? "DISABLED";
  if (requested === previous) return { previousTradingMode: null, tradingModeUpdatedAt: null, tradingModeChangeReason: null };
  return {
    previousTradingMode: previous,
    tradingModeUpdatedAt: new Date(),
    tradingModeChangeReason: (input.reason ?? "").trim() || null,
  };
}

/** User-facing one-liner for a given mode. */
export function tradingModeLabel(mode: string): string {
  switch (mode) {
    case "SIMULATED": return "Paper Mode — simulated only.";
    case "DEMO": return "Demo Mode — no real-money order.";
    case "LIVE": return "Live Mode — real account risk. Review before confirming.";
    default: return "Your operator has not enabled trading.";
  }
}
