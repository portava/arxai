// What the client can truthfully say about a user's risk controls from the
// account-mode envelope alone. No risk *level* is measured anywhere on the
// client (no cap usage, no exposure, no audit), so this never says "Low" or
// "Active" off the freeze flag: it reports the freeze state and which
// per-user caps are assigned, "Checking" until the envelope has loaded, and
// "Could not be loaded" when the account-mode check failed.
// Display only — the server risk governor decides on every submit.
//
// This is the ONE "Risk caps" verdict: the cockpit Trading Permission card,
// the Trade Command Room Risk Governor and onboarding all use it, so the same
// envelope reads the same on every surface.
//
// The envelope always carries a `userRiskCaps` OBJECT (the server builds it
// unconditionally); its fields may all be null. An object's presence is
// therefore not evidence that any cap is set — only non-null fields (and a
// non-empty allowed-symbol list) are.

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

/** Plain-English list of the caps actually set ("max lot 0.1", "symbols EURUSD, GBPUSD"). */
export function assignedRiskCaps(c: RiskCapsEnvelopeSlice["userRiskCaps"]): string[] {
  const parts: string[] = [];
  if (c.maxLotSize != null) parts.push(`max lot ${c.maxLotSize}`);
  if (c.maxOpenTrades != null) parts.push(`max ${c.maxOpenTrades} open trades`);
  if (c.maxDailyLossAmount != null) parts.push(`daily loss limit $${c.maxDailyLossAmount}`);
  if (Array.isArray(c.allowedSymbols) && c.allowedSymbols.length > 0) {
    parts.push(`symbols ${c.allowedSymbols.join(", ")} only`);
  }
  return parts;
}

export function riskCapsStatus(
  env: RiskCapsEnvelopeSlice | null | undefined,
  opts: { failed?: boolean } = {},
): RiskCapsStatus {
  if (!env) {
    // A failed account-mode check is not "still loading".
    return opts.failed
      ? { label: "Could not be loaded", tone: "warning", detail: "Your account risk settings could not be loaded." }
      : { label: "Checking", tone: "muted", detail: "Account risk settings have not loaded yet." };
  }
  if (env.userFrozenStatus?.isFrozen === true) {
    // isFrozen is the account's trading status (paused or restricted), not a
    // cap breach — say where the lock comes from.
    return { label: "Lock active", tone: "danger", detail: "Trading on your account is paused or restricted, so new trades are blocked." };
  }
  if (!env.userRiskCaps) {
    // An envelope without its caps object: nothing about the caps was read.
    return { label: "Could not be loaded", tone: "warning", detail: "Your account risk settings could not be loaded." };
  }
  const parts = assignedRiskCaps(env.userRiskCaps);
  if (parts.length === 0) {
    return {
      label: "No caps assigned",
      tone: "warning",
      detail: "No per-account lot, open-trade, daily-loss or symbol caps are assigned. Only the platform-wide checks apply.",
    };
  }
  return { label: "Caps assigned", tone: "muted", detail: `Account caps: ${parts.join(", ")}.` };
}
