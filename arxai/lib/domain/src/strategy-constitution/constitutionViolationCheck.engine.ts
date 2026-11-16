import {
  type ConstitutionCheckResult, type ProposedAction, type StrategyConstitution,
} from "./strategyConstitution.types";

// checkConstitution — validate a proposed action against the strategy's
// constitution. Returns COMPLIANT only when ALL invariants hold.
// Mismatched strategyId is itself a violation (defense in depth — never
// trust caller-provided pairing).
//
// Hard prohibitions (martingale, no-stop) must be acknowledged in the
// constitution itself; if they're not acknowledged, ANY action under
// that constitution is a violation.
export function checkConstitution(c: StrategyConstitution, p: ProposedAction): ConstitutionCheckResult {
  const violations: string[] = [];
  const reasons: string[] = [];

  if (p.strategyId !== c.strategyId) {
    violations.push(`STRATEGY_ID_MISMATCH proposed=${p.strategyId} constitution=${c.strategyId}`);
  }

  if (!c.acknowledgesNoMartingale) violations.push("CONSTITUTION_INVALID_NO_MARTINGALE_ACK");
  if (!c.acknowledgesNoNoStop)     violations.push("CONSTITUTION_INVALID_NO_NOSTOP_ACK");

  if (p.riskPerTradePct > c.maxRiskPerTradePct) {
    violations.push(`RISK_PER_TRADE ${p.riskPerTradePct.toFixed(2)}% > ${c.maxRiskPerTradePct}%`);
  }
  if (p.concurrentTradesAfter > c.maxConcurrentTrades) {
    violations.push(`CONCURRENT_TRADES ${p.concurrentTradesAfter} > ${c.maxConcurrentTrades}`);
  }
  if (p.dailyLossSoFarPct >= c.maxDailyLossPct) {
    violations.push(`DAILY_LOSS_CAP ${p.dailyLossSoFarPct.toFixed(2)}% ≥ ${c.maxDailyLossPct}%`);
  }
  if (!c.allowedSymbols.includes(p.symbol)) {
    violations.push(`SYMBOL_NOT_ALLOWED ${p.symbol} not in [${c.allowedSymbols.join(", ")}]`);
  }
  if (!c.allowedSessions.includes(p.session)) {
    violations.push(`SESSION_NOT_ALLOWED ${p.session} not in [${c.allowedSessions.join(", ")}]`);
  }
  if (p.riskRewardRatio < c.minRiskRewardRatio) {
    violations.push(`RR_BELOW_MIN ${p.riskRewardRatio.toFixed(2)} < ${c.minRiskRewardRatio}`);
  }
  if (p.stopDistancePips < c.minStopDistancePips) {
    violations.push(`STOP_TOO_TIGHT ${p.stopDistancePips.toFixed(1)}p < ${c.minStopDistancePips}p`);
  }

  // Forbidden time windows — observedAtIso must NOT fall inside any window
  const t = Date.parse(p.observedAtIso);
  if (!Number.isNaN(t)) {
    for (const w of c.forbiddenWindows) {
      const a = Date.parse(w.startIso);
      const b = Date.parse(w.endIso);
      if (!Number.isNaN(a) && !Number.isNaN(b) && t >= a && t <= b) {
        violations.push(`FORBIDDEN_WINDOW ${w.startIso}..${w.endIso} (${w.reason})`);
      }
    }
  } else {
    violations.push(`OBSERVED_AT_INVALID ${p.observedAtIso} — fail-closed`);
  }

  if (violations.length === 0) {
    reasons.push(`all ${countInvariants()} invariants satisfied`);
    return { verdict: "COMPLIANT", strategyId: c.strategyId, violations: [], reasons };
  }
  reasons.push(`${violations.length} violation(s) — REJECT`, ...violations);
  return { verdict: "VIOLATION", strategyId: c.strategyId, violations, reasons };
}

function countInvariants(): number {
  // ID match + 2 acks + risk + concurrent + daily + symbol + session + RR + stop + windows = 10 categories
  return 10;
}
