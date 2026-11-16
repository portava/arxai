import {
  type AgentCascadeInput, type Level4Result, type ReviewSeverity, type ReviewSignal,
  AGENT_CASCADE_THRESHOLDS,
} from "./agentCascade.types";

// ── Level 4 — Review Agents ───────────────────────────────────────────────
//
// CRITICAL DISTINCTION: Level 4 agents do NOT block, modify direction, or
// adjust confidence for the current trade. They emit signals about the
// SYSTEM ITSELF. These signals are surfaced to the operator and recorded
// for future decisions (regime memory, weighting adjustments, etc.).
//
// The level runner ALWAYS executes — even when Level 1 vetoed — because
// review signals are independent of any single trade and inform what the
// system should do next.

// ── Monitoring Agent ──────────────────────────────────────────────────────
//
// Watches intelligence-v2 disagreement and validation metrics. Flags when
// the agents are disagreeing more than usual or when prior vetoes are
// turning out to have been wrong (false-veto rate).
export function evaluateMonitoringAgent(input: AgentCascadeInput): ReviewSignal[] {
  const T = AGENT_CASCADE_THRESHOLDS.level4;
  const out: ReviewSignal[] = [];
  const m = input.monitoring;

  if (m.shadowSampleSize < 20) {
    out.push({
      agentId: "L4.MONITOR", agentName: "Monitoring Agent",
      signalKind: "INSUFFICIENT_SAMPLE",
      severity: "INFO",
      reasons: [`shadow sample ${m.shadowSampleSize} < 20 — monitoring metrics not yet meaningful`],
    });
    return out;
  }

  if (m.recentDisagreementRate01 >= T.disagreementWarnRate01) {
    out.push({
      agentId: "L4.MONITOR", agentName: "Monitoring Agent",
      signalKind: "DISAGREEMENT_RATE_HIGH",
      severity: "WARNING",
      reasons: [`agents disagreeing ${(m.recentDisagreementRate01 * 100).toFixed(0)}% of recent decisions ≥ ${(T.disagreementWarnRate01 * 100).toFixed(0)}% — investigate which agents are split`],
    });
  }
  if (m.recentFalseVetoRate01 >= T.falseVetoWarnRate01) {
    out.push({
      agentId: "L4.MONITOR", agentName: "Monitoring Agent",
      signalKind: "FALSE_VETO_RATE_HIGH",
      severity: "ADVISORY",
      reasons: [`${(m.recentFalseVetoRate01 * 100).toFixed(0)}% of recent vetoes turned out to have been wrong (≥ ${(T.falseVetoWarnRate01 * 100).toFixed(0)}% threshold) — review veto thresholds`],
    });
  }

  if (out.length === 0) {
    out.push({
      agentId: "L4.MONITOR", agentName: "Monitoring Agent",
      signalKind: "NOMINAL",
      severity: "INFO",
      reasons: [`disagreement ${(m.recentDisagreementRate01 * 100).toFixed(0)}%, false-veto ${(m.recentFalseVetoRate01 * 100).toFixed(0)}% — within tolerance`],
    });
  }
  return out;
}

// ── Self-Audit Agent ──────────────────────────────────────────────────────
//
// Watches operator discipline — manual overrides, ignored exit warnings,
// emergency kills. Recurring patterns are flagged.
export function evaluateSelfAuditAgent(input: AgentCascadeInput): ReviewSignal[] {
  const T = AGENT_CASCADE_THRESHOLDS.level4;
  const out: ReviewSignal[] = [];
  const s = input.selfAudit;

  if (s.recentManualOverrideCount >= T.overrideWarnCount) {
    out.push({
      agentId: "L4.AUDIT", agentName: "Self-Audit Agent",
      signalKind: "OVERRIDE_PATTERN",
      severity: "WARNING",
      reasons: [`${s.recentManualOverrideCount} manual overrides recently — operator is fighting the system; review setup confidence`],
    });
  }
  if (s.recentIgnoredExitWarningCount >= 2) {
    out.push({
      agentId: "L4.AUDIT", agentName: "Self-Audit Agent",
      signalKind: "EXIT_WARNINGS_IGNORED",
      severity: "ADVISORY",
      reasons: [`${s.recentIgnoredExitWarningCount} exit warnings ignored recently — patterns suggest review of exit-warning thresholds OR operator discipline`],
    });
  }
  if (s.recentEmergencyKillCount >= 2) {
    out.push({
      agentId: "L4.AUDIT", agentName: "Self-Audit Agent",
      signalKind: "REPEATED_KILL_SWITCH",
      severity: "WARNING",
      reasons: [`${s.recentEmergencyKillCount} emergency kills recently — system or strategy is producing situations that require manual intervention`],
    });
  }

  if (out.length === 0) {
    out.push({
      agentId: "L4.AUDIT", agentName: "Self-Audit Agent",
      signalKind: "NOMINAL",
      severity: "INFO",
      reasons: [`overrides ${s.recentManualOverrideCount}, ignored warnings ${s.recentIgnoredExitWarningCount}, kills ${s.recentEmergencyKillCount} — within tolerance`],
    });
  }
  return out;
}

// ── Regime Memory Agent ───────────────────────────────────────────────────
//
// Watches the relationship between the current market regime and the
// system's historical performance in this regime. Flags when the regime
// has drifted significantly or when the system's performance in the
// current regime is poor.
export function evaluateRegimeMemoryAgent(input: AgentCascadeInput): ReviewSignal[] {
  const T = AGENT_CASCADE_THRESHOLDS.level4;
  const out: ReviewSignal[] = [];
  const r = input.regimeMemory;

  if (r.regimeChangedRecently) {
    out.push({
      agentId: "L4.REGIME", agentName: "Regime Memory Agent",
      signalKind: "REGIME_CHANGED",
      severity: "ADVISORY",
      reasons: [`regime changed recently to "${r.currentRegimeId}" — historical baselines may not apply yet`],
    });
  }
  if (r.regimeDriftSigma >= T.regimeDriftWarnSigma) {
    out.push({
      agentId: "L4.REGIME", agentName: "Regime Memory Agent",
      signalKind: "REGIME_DRIFT",
      severity: "WARNING",
      reasons: [`market is ${r.regimeDriftSigma.toFixed(2)}σ from regime centroid (≥ ${T.regimeDriftWarnSigma}σ) — regime classification may be stale`],
    });
  }
  if (r.currentRegimeHealth01 < 0.4) {
    out.push({
      agentId: "L4.REGIME", agentName: "Regime Memory Agent",
      signalKind: "REGIME_UNHEALTHY",
      severity: "WARNING",
      reasons: [`system performance in regime "${r.currentRegimeId}" is ${(r.currentRegimeHealth01 * 100).toFixed(0)}% — historical edge weak in current conditions`],
    });
  }

  if (out.length === 0) {
    out.push({
      agentId: "L4.REGIME", agentName: "Regime Memory Agent",
      signalKind: "NOMINAL",
      severity: "INFO",
      reasons: [`regime "${r.currentRegimeId}" stable, drift ${r.regimeDriftSigma.toFixed(2)}σ, health ${(r.currentRegimeHealth01 * 100).toFixed(0)}%`],
    });
  }
  return out;
}

// ── Level runner ──────────────────────────────────────────────────────────
export function runLevel4(input: AgentCascadeInput): Level4Result {
  const signals = [
    ...evaluateMonitoringAgent(input),
    ...evaluateSelfAuditAgent(input),
    ...evaluateRegimeMemoryAgent(input),
  ];
  const highestSeverity = pickHighestSeverity(signals);
  return { signals, highestSeverity };
}

function pickHighestSeverity(signals: ReviewSignal[]): ReviewSeverity | "NONE" {
  if (signals.length === 0) return "NONE";
  const order: Record<ReviewSeverity, number> = { INFO: 0, ADVISORY: 1, WARNING: 2 };
  let best: ReviewSeverity = "INFO";
  for (const s of signals) if (order[s.severity] > order[best]) best = s.severity;
  return best;
}
