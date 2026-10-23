// ═══════════════════════════════════════════════════════════════════════════
// Live Sanity Check — pure. Re-evaluates execution validity IMMEDIATELY
// before a trade entry. ANY blocker forbids the trade. The Risk Governor
// or Control Tower may also independently veto, but a sanity-check failure
// is a hard local "no" that cannot be overridden by upstream confidence.
// ═══════════════════════════════════════════════════════════════════════════

export type SanityBlockerKind =
  | "KILL_SWITCH_ENGAGED"
  | "SPREAD_TOO_WIDE"
  | "LATENCY_TOO_HIGH"
  | "FILL_PROBABILITY_TOO_LOW"
  | "MAX_OPEN_POSITIONS_REACHED"
  | "DATA_STALE"
  | "BROKER_DEGRADED"
  | "REGIME_MISMATCH"
  | "INSUFFICIENT_EQUITY"
  | "QUARANTINED";

export interface LiveSanityCheckInput {
  candidateId: string;
  killSwitchEngaged: boolean;
  spreadActual: number;
  spreadExpected: number;
  spreadMaxMultiple?: number;          // default 2.0
  latencyMs: number;
  latencyMaxMs?: number;               // default 500
  fillProbability01: number;
  fillProbabilityMin01?: number;       // default 0.6
  openPositions: number;
  maxOpenPositions: number;
  dataFreshnessMs: number;
  maxDataAgeMs?: number;               // default 5000
  brokerHealthScore01: number;
  brokerHealthMin01?: number;          // default 0.5
  regimeMatch: boolean;
  accountEquity: number;
  riskPerTradeR: number;
  riskPerTradeMaxR?: number;           // default 1.0
  isQuarantined: boolean;
}
export interface LiveSanityCheckResult {
  candidateId: string;
  allow: boolean;
  blockers: SanityBlockerKind[];
  severity: "INFO" | "WARN" | "DANGER" | "CRITICAL";
  reasons: string[];
}

export function liveSanityCheck(i: LiveSanityCheckInput): LiveSanityCheckResult {
  const blockers: SanityBlockerKind[] = [];
  const reasons: string[] = [];

  const spreadCap = (i.spreadMaxMultiple ?? 2.0) * Math.max(0, i.spreadExpected);
  const latencyCap = i.latencyMaxMs ?? 500;
  const fillMin = i.fillProbabilityMin01 ?? 0.6;
  const dataAgeCap = i.maxDataAgeMs ?? 5000;
  const brokerMin = i.brokerHealthMin01 ?? 0.5;
  const riskCap = i.riskPerTradeMaxR ?? 1.0;

  if (i.killSwitchEngaged) {
    blockers.push("KILL_SWITCH_ENGAGED");
    reasons.push("kill switch engaged — block all entries");
  }
  if (i.isQuarantined) {
    blockers.push("QUARANTINED");
    reasons.push("strategy is quarantined — entries denied");
  }
  if (spreadCap > 0 && i.spreadActual > spreadCap) {
    blockers.push("SPREAD_TOO_WIDE");
    reasons.push(`spread ${i.spreadActual} > ${spreadCap.toFixed(4)} (= ${(i.spreadMaxMultiple ?? 2.0)}× expected)`);
  }
  if (i.latencyMs > latencyCap) {
    blockers.push("LATENCY_TOO_HIGH");
    reasons.push(`latency ${i.latencyMs}ms > ${latencyCap}ms`);
  }
  if (i.fillProbability01 < fillMin) {
    blockers.push("FILL_PROBABILITY_TOO_LOW");
    reasons.push(`fill probability ${i.fillProbability01.toFixed(2)} < ${fillMin}`);
  }
  if (i.openPositions >= i.maxOpenPositions) {
    blockers.push("MAX_OPEN_POSITIONS_REACHED");
    reasons.push(`open positions ${i.openPositions} ≥ max ${i.maxOpenPositions}`);
  }
  if (i.dataFreshnessMs > dataAgeCap) {
    blockers.push("DATA_STALE");
    reasons.push(`data age ${i.dataFreshnessMs}ms > ${dataAgeCap}ms`);
  }
  if (i.brokerHealthScore01 < brokerMin) {
    blockers.push("BROKER_DEGRADED");
    reasons.push(`broker health ${i.brokerHealthScore01.toFixed(2)} < ${brokerMin}`);
  }
  if (!i.regimeMatch) {
    blockers.push("REGIME_MISMATCH");
    reasons.push("regime does not match the strategy's allowed regimes");
  }
  if (i.riskPerTradeR > riskCap || i.accountEquity <= 0) {
    blockers.push("INSUFFICIENT_EQUITY");
    reasons.push(`risk-per-trade ${i.riskPerTradeR}R > cap ${riskCap}R or equity ≤ 0`);
  }

  const allow = blockers.length === 0;
  const severity = !allow
    ? (blockers.includes("KILL_SWITCH_ENGAGED") || blockers.includes("QUARANTINED")
        ? "CRITICAL" : "DANGER")
    : "INFO";

  if (allow) reasons.push("all sanity checks passed");
  return { candidateId: i.candidateId, allow, blockers, severity, reasons };
}
