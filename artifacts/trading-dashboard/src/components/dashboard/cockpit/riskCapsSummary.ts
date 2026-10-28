// Risk caps → a plain value for a "Risk caps" row.
//
// The account-mode envelope always carries a `userRiskCaps` OBJECT (the server
// builds it unconditionally); its fields may all be null. An object's presence
// is therefore not evidence that any cap is set — only non-null fields are.

export interface RiskCapsLike {
  maxLotSize: number | null;
  maxOpenTrades: number | null;
  maxDailyLossAmount: number | null;
}

export interface RiskCapsSummary {
  label: string;
  detail: string;
  tone: "success" | "warning" | "muted";
}

export function describeRiskCaps(caps: RiskCapsLike | null | undefined): RiskCapsSummary {
  if (!caps) {
    return { label: "Not loaded", detail: "Your account risk caps could not be read.", tone: "muted" };
  }
  const parts: string[] = [];
  if (caps.maxLotSize != null) parts.push(`max lot ${caps.maxLotSize}`);
  if (caps.maxOpenTrades != null) parts.push(`max ${caps.maxOpenTrades} open trades`);
  if (caps.maxDailyLossAmount != null) parts.push(`daily loss limit $${caps.maxDailyLossAmount}`);
  if (parts.length === 0) {
    return {
      label: "None set",
      detail: "No lot, open-trade or daily-loss cap is set on your account. Server-side risk checks still run on every order.",
      tone: "warning",
    };
  }
  return { label: `${parts.length} set`, detail: `Account caps: ${parts.join(", ")}.`, tone: "success" };
}
