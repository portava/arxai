// ═══════════════════════════════════════════════════════════════════════════
// System Health — pure. Ecosystem-wide operational health combining data
// freshness, broker availability, execution latency, vault backlog,
// quarantine ratio, and critical alert volume. Categorizes the system as
// HEALTHY | STRESSED | DEGRADED | CRITICAL and recommends actions.
// ═══════════════════════════════════════════════════════════════════════════

import { clamp01 } from "./confidenceHealth.engine";

export type SystemHealthStatus = "HEALTHY" | "STRESSED" | "DEGRADED" | "CRITICAL";

export interface SystemHealthInput {
  activeStrategies: number;
  quarantinedStrategies: number;
  dataFreshnessOk: boolean;
  brokerOk: boolean;
  executionLatencyMsP95: number;
  vaultBacklogEvents: number;
  criticalAlertsLast24h: number;
  // Optional thresholds
  latencyHealthyMs?: number;        // default 200
  latencyDegradedMs?: number;       // default 800
  vaultBacklogDegraded?: number;    // default 1000
  vaultBacklogCritical?: number;    // default 10000
  criticalAlertsCritical?: number;  // default 5
}
export interface SystemHealthResult {
  systemHealthScore01: number;
  status: SystemHealthStatus;
  factors: Record<string, number>;
  recommendations: string[];
  reasons: string[];
}

export function assessSystemHealth(i: SystemHealthInput): SystemHealthResult {
  const reasons: string[] = [];
  const recs: string[] = [];

  const latencyHealthy = i.latencyHealthyMs ?? 200;
  const latencyDegraded = i.latencyDegradedMs ?? 800;
  const backlogDeg = i.vaultBacklogDegraded ?? 1000;
  const backlogCri = i.vaultBacklogCritical ?? 10000;
  const alertsCri  = i.criticalAlertsCritical ?? 5;

  // Sub-scores in [0..1]
  const dataScore   = i.dataFreshnessOk ? 1 : 0;
  const brokerScore = i.brokerOk ? 1 : 0;
  // Latency: piecewise-linear from healthy→degraded
  const latency = i.executionLatencyMsP95;
  const latencyScore = latency <= latencyHealthy ? 1
                     : latency >= latencyDegraded ? 0
                     : 1 - (latency - latencyHealthy) / (latencyDegraded - latencyHealthy);
  const backlogScore = i.vaultBacklogEvents <= 0 ? 1
                     : i.vaultBacklogEvents >= backlogCri ? 0
                     : 1 - i.vaultBacklogEvents / backlogCri;
  const quarantineRatio = i.activeStrategies > 0
    ? i.quarantinedStrategies / Math.max(1, i.activeStrategies + i.quarantinedStrategies)
    : 0;
  const quarantineScore = clamp01(1 - quarantineRatio);
  const alertsScore = i.criticalAlertsLast24h <= 0 ? 1
                    : i.criticalAlertsLast24h >= alertsCri ? 0
                    : 1 - i.criticalAlertsLast24h / alertsCri;

  // Weights (sum=1.0)
  const W = { data: 0.20, broker: 0.25, latency: 0.15, backlog: 0.10, quarantine: 0.15, alerts: 0.15 };
  const score = clamp01(
      dataScore       * W.data
    + brokerScore     * W.broker
    + latencyScore    * W.latency
    + backlogScore    * W.backlog
    + quarantineScore * W.quarantine
    + alertsScore     * W.alerts,
  );

  // Status thresholds with hard overrides
  let status: SystemHealthStatus =
      score >= 0.85 ? "HEALTHY"
    : score >= 0.65 ? "STRESSED"
    : score >= 0.40 ? "DEGRADED"
    : "CRITICAL";

  // Hard CRITICAL conditions — broker down, data stale, or many critical alerts
  if (!i.brokerOk || !i.dataFreshnessOk || i.criticalAlertsLast24h >= alertsCri
      || i.vaultBacklogEvents >= backlogCri) {
    status = "CRITICAL";
  }

  if (!i.brokerOk)         recs.push("FREEZE_LIVE_TRADING_UNTIL_BROKER_RECOVERS");
  if (!i.dataFreshnessOk)  recs.push("REPLACE_DATA_FEED");
  if (latencyScore < 0.5)  recs.push("DEGRADE_TO_LIQUID_HOURS_ONLY");
  if (backlogScore < 0.5)  recs.push("THROTTLE_VAULT_PRODUCERS");
  if (quarantineScore < 0.5) recs.push("REVIEW_HIGH_QUARANTINE_RATIO");
  if (alertsScore < 0.5)   recs.push("ESCALATE_TO_OPERATOR");

  reasons.push(`score ${score.toFixed(3)} | status ${status}`);
  reasons.push(`data ${dataScore} | broker ${brokerScore} | latency ${latencyScore.toFixed(2)} | backlog ${backlogScore.toFixed(2)} | quarantine ${quarantineScore.toFixed(2)} | alerts ${alertsScore.toFixed(2)}`);

  return {
    systemHealthScore01: score,
    status,
    factors: {
      data: dataScore, broker: brokerScore, latency: latencyScore,
      backlog: backlogScore, quarantine: quarantineScore, alerts: alertsScore,
    },
    recommendations: dedupe(recs),
    reasons,
  };
}
function dedupe<T>(a: T[]): T[] {
  const s = new Set<T>(); const out: T[] = [];
  for (const x of a) if (!s.has(x)) { s.add(x); out.push(x); }
  return out;
}
