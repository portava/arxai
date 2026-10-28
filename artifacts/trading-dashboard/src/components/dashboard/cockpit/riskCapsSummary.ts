// Risk caps → a plain value for a "Risk caps" row.
//
// Kept for callers that hold only the caps object. It is the same verdict as
// riskCapsStatus (lib/riskCapsStatus.ts) — the one helper every surface uses —
// so it can never word the same caps differently. Surfaces that have the whole
// envelope call riskCapsStatus directly, so the freeze state and a failed
// account-mode check are reported too.

import { riskCapsStatus, type RiskCapsStatus } from "@/lib/riskCapsStatus";

export interface RiskCapsLike {
  maxLotSize: number | null;
  maxOpenTrades: number | null;
  maxDailyLossAmount: number | null;
  allowedSymbols?: string[] | null;
}

export type RiskCapsSummary = RiskCapsStatus;

export function describeRiskCaps(caps: RiskCapsLike | null | undefined): RiskCapsSummary {
  return riskCapsStatus(
    caps
      ? { userRiskCaps: { ...caps, allowedSymbols: caps.allowedSymbols ?? null }, userFrozenStatus: { isFrozen: false } }
      : null,
  );
}
