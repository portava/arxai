// What the client can truthfully say about a user's risk controls from the
// account-mode envelope alone. No risk *level* is measured anywhere on the
// client (no cap usage, no exposure, no audit), so this never says "Low" or
// "Active" off the freeze flag: it reports the freeze state and whether any
// per-user caps are assigned, and "Checking" until the envelope has loaded.
// Display only — the server risk governor decides on every submit.

export type RiskCapsTone = "success" | "warning" | "danger" | "muted";

export interface RiskCapsEnvelopeSlice {
  userRiskCaps: {
    maxLotSize: number | null;
    maxOpenTrades: number | null;
    maxDailyLossAmount: number | null;
    allowedSymbols: string[] | null;
  };
  userFrozenStatus: { isFrozen: boolean };
}

export interface RiskCapsStatus {
  label: string;
  tone: RiskCapsTone;
  detail: string;
}

export function riskCapsStatus(env: RiskCapsEnvelopeSlice | null | undefined): RiskCapsStatus {
  if (!env) {
    return { label: "Checking", tone: "muted", detail: "Account risk settings have not loaded yet." };
  }
  if (env.userFrozenStatus.isFrozen) {
    return { label: "Lock active", tone: "danger", detail: "Your account is risk-locked; new trades are paused." };
  }
  const c = env.userRiskCaps;
  const assigned = c.maxLotSize != null || c.maxOpenTrades != null || c.maxDailyLossAmount != null
    || (Array.isArray(c.allowedSymbols) && c.allowedSymbols.length > 0);
  if (!assigned) {
    return {
      label: "No caps assigned",
      tone: "warning",
      detail: "No per-account lot, open-trade or daily-loss caps are assigned. Only the platform-wide checks apply.",
    };
  }
  return {
    label: "Caps assigned",
    tone: "muted",
    detail: "Per-account caps are assigned. How much of each cap is used is not shown here; see Risk Settings.",
  };
}
