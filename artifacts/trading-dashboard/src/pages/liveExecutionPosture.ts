// Plain-English live-execution posture for pages that used to print a
// hard-coded "LIVE TRADING: DISABLED" / "No real orders will be placed".
//
// Source: the account-mode envelope (/api/me/account-mode via
// useTradingMode). It only says whether live execution is ARMED for this
// user; it is not a guarantee that no order can be placed (server execution
// gates are separate authorities), so the not-armed copy never promises that.
import type { UseTradingModeResult } from "@/hooks/useTradingMode";

export type LiveExecutionPosture = {
  tone: "armed" | "not-armed" | "unknown";
  label: string;
  detail: string;
};

export function describeLiveExecutionPosture(
  mode: Pick<UseTradingModeResult, "envelope" | "isLoading" | "isError" | "isLiveArmed" | "cleanModeLabel">,
): LiveExecutionPosture {
  if (!mode.envelope) {
    return {
      tone: "unknown",
      label: "Live execution: not checked",
      detail: mode.isLoading
        ? "Checking your account mode…"
        : "Your account mode could not be read, so whether live execution is armed is unknown.",
    };
  }
  if (mode.isLiveArmed) {
    return {
      tone: "armed",
      label: "Live execution: ARMED",
      detail: `Your account mode (${mode.cleanModeLabel}) has live execution armed. Real orders can be sent to the broker through your live route; server safety gates still check each one.`,
    };
  }
  return {
    tone: "not-armed",
    label: "Live execution: not armed",
    detail: `Your account mode (${mode.cleanModeLabel}) does not have live execution armed. Server safety gates decide every order.`,
  };
}
