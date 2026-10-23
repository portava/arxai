import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Constitution — declarative, immutable rules each strategy
// must adhere to. Anything that violates the constitution is REJECTED
// before it ever reaches the risk-governor. Composes WITH (does not
// replace) the risk-governor — the constitution enforces strategy-level
// invariants; the governor enforces account-level invariants.
// ═══════════════════════════════════════════════════════════════════════════

export interface StrategyConstitution {
  strategyId: string;
  version: number;
  // Hard caps the strategy promises never to violate
  maxRiskPerTradePct: number;           // % of equity at risk per trade
  maxConcurrentTrades: number;
  maxDailyLossPct: number;
  // Allowed contexts
  allowedSymbols: string[];
  allowedSessions: ReadonlyArray<"ASIA" | "LONDON" | "NEW_YORK">;
  forbiddenWindows: ReadonlyArray<{ startIso: string; endIso: string; reason: string }>;
  // Required setup invariants
  minRiskRewardRatio: number;
  minStopDistancePips: number;
  // Acknowledgements
  acknowledgesNoMartingale: boolean;
  acknowledgesNoNoStop: boolean;
  signedAtIso: string;
}

export interface ProposedAction {
  strategyId: string;
  symbol: string;
  session: "ASIA" | "LONDON" | "NEW_YORK";
  riskPerTradePct: number;
  riskRewardRatio: number;
  stopDistancePips: number;
  concurrentTradesAfter: number;        // count if this trade fires
  dailyLossSoFarPct: number;
  observedAtIso: string;
}

export const ConstitutionVerdictSchema = z.enum(["COMPLIANT", "VIOLATION"]);
export type ConstitutionVerdict = z.infer<typeof ConstitutionVerdictSchema>;

export interface ConstitutionCheckResult {
  verdict: ConstitutionVerdict;
  strategyId: string;
  violations: string[];
  reasons: string[];
}
