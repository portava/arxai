// ═══════════════════════════════════════════════════════════════════════════
// Trade Limit Policy
//
// Caps how many new trades the trader may take and which symbols/sessions
// are restricted. Built from Personal Danger Fingerprint + severity.
//
//   • maxTradesPerSession  hard cap
//   • restrictedSymbols    symbols blocked outright
//   • restrictedSessions   sessions blocked outright
//   • aPlusOnly            require highest-grade setups
//   • oneCandleDelay       force a 1-candle wait between entries
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { type EdgeFingerprint } from "../edgeFingerprint.engine";

export const TradeLimitPolicySchema = z.object({
  maxTradesPerSession: z.number().int().min(0),
  restrictedSymbols:   z.array(z.string()),
  restrictedSessions:  z.array(z.string()),
  aPlusOnly:           z.boolean(),
  oneCandleDelay:      z.boolean(),
  reasons:             z.array(z.string()),
});
export type TradeLimitPolicy = z.infer<typeof TradeLimitPolicySchema>;

export interface TradeLimitInput {
  severity01: number;
  dangerFingerprint?: EdgeFingerprint | null;
}

export function recommendTradeLimitPolicy(input: TradeLimitInput): TradeLimitPolicy {
  const reasons: string[] = [];
  let maxTradesPerSession = 100;
  let aPlusOnly = false;
  let oneCandleDelay = false;

  if (input.severity01 >= 0.85)      { maxTradesPerSession = 0;  aPlusOnly = true;  oneCandleDelay = true;  reasons.push("severity ≥0.85 → no new trades"); }
  else if (input.severity01 >= 0.65) { maxTradesPerSession = 3;  aPlusOnly = true;  oneCandleDelay = true;  reasons.push("severity ≥0.65 → max 3 A+ setups, 1-candle delay"); }
  else if (input.severity01 >= 0.50) { maxTradesPerSession = 5;  aPlusOnly = true;  oneCandleDelay = true;  reasons.push("severity ≥0.50 → max 5 A+ setups, 1-candle delay"); }
  else if (input.severity01 >= 0.35) { maxTradesPerSession = 10; aPlusOnly = false; oneCandleDelay = true;  reasons.push("severity ≥0.35 → max 10 trades, 1-candle delay"); }
  else if (input.severity01 >= 0.25) { maxTradesPerSession = 15;                                            reasons.push("severity ≥0.25 → reduce frequency to 15"); }
  else                               {                                                                     reasons.push("no trade-frequency cap required"); }

  // Restrict symbols/sessions found in the danger fingerprint when severity is meaningful.
  const restrictedSymbols  = input.severity01 >= 0.35 ? (input.dangerFingerprint?.symbols  ?? []) : [];
  const restrictedSessions = input.severity01 >= 0.50 ? (input.dangerFingerprint?.sessions ?? []) : [];
  if (restrictedSymbols.length)  reasons.push(`restricted symbols: ${restrictedSymbols.join(", ")}`);
  if (restrictedSessions.length) reasons.push(`restricted sessions: ${restrictedSessions.join(", ")}`);

  return { maxTradesPerSession, restrictedSymbols, restrictedSessions, aPlusOnly, oneCandleDelay, reasons };
}
