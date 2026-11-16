import {
  DEFAULT_STALENESS_SECONDS,
  type AccountRiskReading, type AccountRiskSensorPort, type SensorReading,
} from "./liveInputs.types";

const MARGIN_CALL_PCT = 100;     // < 100% → margin call territory
const MARGIN_WARN_PCT = 200;
const DRAWDOWN_BLOCK_PCT = 20;   // hard block if peak-equity drawdown ≥ 20%
const DRAWDOWN_WARN_PCT  = 10;

export interface ReadAccountRiskSensorInput {
  port: AccountRiskSensorPort;
  now?: Date;
  stalenessSeconds?: number;
}

export async function readAccountRiskSensor(input: ReadAccountRiskSensorInput): Promise<SensorReading<AccountRiskReading>> {
  const now = input.now ?? new Date();
  const stale = input.stalenessSeconds ?? DEFAULT_STALENESS_SECONDS.accountRisk;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const snap = await input.port.getAccountSnapshot().catch(() => null);
  if (!snap) {
    return {
      sensor: "accountRisk", value: null,
      health: { isHealthy: false, isStale: true, ageSeconds: null, reasons: ["no account snapshot"] },
      warnings, blockers: ["No account snapshot available"],
      capturedAt: now.toISOString(),
    };
  }

  const ageSeconds = Math.max(0, (now.getTime() - new Date(snap.observedAt).getTime()) / 1000);
  const isStale = ageSeconds > stale;
  if (isStale) blockers.push(`Account snapshot stale (${ageSeconds.toFixed(1)}s > ${stale}s)`);

  if (snap.balance <= 0) blockers.push(`Account balance non-positive (${snap.balance})`);
  if (snap.equity <= 0)  blockers.push(`Account equity non-positive (${snap.equity})`);

  const marginLevelPct = snap.marginUsed > 0 ? (snap.equity / snap.marginUsed) * 100 : null;
  const freeMarginPct = snap.equity > 0 ? (snap.marginFree / snap.equity) * 100 : 0;

  if (marginLevelPct != null) {
    if (marginLevelPct < MARGIN_CALL_PCT) {
      blockers.push(`Margin level ${marginLevelPct.toFixed(0)}% < ${MARGIN_CALL_PCT}% — margin call risk`);
    } else if (marginLevelPct < MARGIN_WARN_PCT) {
      warnings.push(`Margin level ${marginLevelPct.toFixed(0)}% < ${MARGIN_WARN_PCT}%`);
    }
  }

  const drawdownPct = snap.peakEquity > 0
    ? Math.max(0, ((snap.peakEquity - snap.equity) / snap.peakEquity) * 100) : 0;
  if (drawdownPct >= DRAWDOWN_BLOCK_PCT) {
    blockers.push(`Drawdown ${drawdownPct.toFixed(2)}% ≥ ${DRAWDOWN_BLOCK_PCT}%`);
  } else if (drawdownPct >= DRAWDOWN_WARN_PCT) {
    warnings.push(`Drawdown ${drawdownPct.toFixed(2)}% ≥ ${DRAWDOWN_WARN_PCT}%`);
  }

  const value: AccountRiskReading = {
    balance: snap.balance, equity: snap.equity,
    marginUsed: snap.marginUsed, marginFree: snap.marginFree,
    marginLevelPct, drawdownPct, freeMarginPct,
  };

  return {
    sensor: "accountRisk", value,
    health: { isHealthy: blockers.length === 0, isStale, ageSeconds,
              reasons: blockers.length === 0 ? ["within limits"] : blockers },
    warnings, blockers, capturedAt: now.toISOString(),
  };
}
