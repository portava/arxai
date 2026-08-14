import {
  FAIL_CLOSED_ON_MISSING_DATA, KILL_SWITCH_LABELS,
  type DailyLossInput, type ExposureInput, type KillSwitchInput,
  type KillSwitchKind, type KillSwitchTrigger, type KillSwitchVerdict,
  type Mt5StabilityInput, type NewsLockoutInput, type RevengeLevel,
  type RevengeTradingInput, type SpreadInput,
} from "./riskGovernor.types";

// evaluateRiskGovernor
//
// Pure: takes the 6 input sections and returns a structured verdict.
// Every kill-switch is evaluated independently, in the declared order,
// and the verdict is BLOCKED iff any of them fires. Missing data
// (null observations) fails closed by convention.
//
// This is the master pre-trade gate. v1 and v2 consensus engines both
// call it before any agent is even invoked — saves compute, guarantees
// hard stops independent of agent logic, and gives the v2 stability
// gate's `riskGovernorTested` flag a real engine to point at.
export function evaluateRiskGovernor(input: KillSwitchInput): KillSwitchVerdict {
  const now = input.now ?? new Date();

  const triggers: KillSwitchTrigger[] = [
    evalDailyLoss(input.dailyLoss),
    evalSpread(input.spread),
    evalMt5(input.mt5),
    evalNewsLockout(input.news),
    evalRevenge(input.revenge),
    evalExposure(input.exposure),
  ];

  const blockingKinds = triggers.filter((t) => t.triggered).map((t) => t.kind);
  const reasons = triggers
    .filter((t) => t.triggered)
    .map((t) => `[${t.kind}] ${t.reason}`);

  return {
    blocked: blockingKinds.length > 0,
    triggers,
    blockingKinds,
    reasons,
    evaluatedAt: now.toISOString(),
  };
}

// ── 1. Max daily loss ─────────────────────────────────────────────────────
function evalDailyLoss(input: DailyLossInput): KillSwitchTrigger {
  const kind: KillSwitchKind = "MAX_DAILY_LOSS";
  if (input.realizedDailyLossPct === null) {
    return failClosed(kind, "daily P&L unavailable", null, input.maxDailyLossPct);
  }
  const triggered = input.realizedDailyLossPct >= input.maxDailyLossPct;
  return {
    kind, label: KILL_SWITCH_LABELS[kind],
    triggered,
    reason: triggered
      ? `realized daily loss ${input.realizedDailyLossPct.toFixed(2)}% ≥ cap ${input.maxDailyLossPct.toFixed(2)}%`
      : `${input.realizedDailyLossPct.toFixed(2)}% / ${input.maxDailyLossPct.toFixed(2)}% cap — within limit`,
    observed: input.realizedDailyLossPct,
    threshold: input.maxDailyLossPct,
    dataMissing: false,
  };
}

// ── 2. Spread too high ────────────────────────────────────────────────────
function evalSpread(input: SpreadInput): KillSwitchTrigger {
  const kind: KillSwitchKind = "SPREAD_TOO_HIGH";
  if (input.currentPips === null) {
    return failClosed(kind, "spread reading unavailable", null, input.maxPips);
  }
  const triggered = input.currentPips > input.maxPips;
  return {
    kind, label: KILL_SWITCH_LABELS[kind],
    triggered,
    reason: triggered
      ? `spread ${input.currentPips.toFixed(2)}p > cap ${input.maxPips.toFixed(2)}p`
      : `${input.currentPips.toFixed(2)}p / ${input.maxPips.toFixed(2)}p cap — within limit`,
    observed: input.currentPips,
    threshold: input.maxPips,
    dataMissing: false,
  };
}

// ── 3. MT5 unstable ──────────────────────────────────────────────────────
function evalMt5(input: Mt5StabilityInput): KillSwitchTrigger {
  const kind: KillSwitchKind = "MT5_UNSTABLE";
  const subFails: string[] = [];
  let dataMissing = false;

  if (!input.isHealthy) subFails.push("bridge unhealthy");
  if (input.avgLatencyMs === null) {
    dataMissing = true;
    subFails.push("latency unknown");
  } else if (input.avgLatencyMs > input.maxLatencyMs) {
    subFails.push(`avg latency ${input.avgLatencyMs.toFixed(0)}ms > ${input.maxLatencyMs}ms`);
  }
  if (input.lastHeartbeatAgeSec === null) {
    dataMissing = true;
    subFails.push("heartbeat age unknown");
  } else if (input.lastHeartbeatAgeSec > input.maxHeartbeatAgeSec) {
    subFails.push(`heartbeat ${input.lastHeartbeatAgeSec.toFixed(0)}s > ${input.maxHeartbeatAgeSec}s`);
  }

  const triggered = subFails.length > 0;
  return {
    kind, label: KILL_SWITCH_LABELS[kind],
    triggered,
    reason: triggered ? subFails.join("; ") : `healthy, latency/heartbeat within limits`,
    observed: input.avgLatencyMs,
    threshold: input.maxLatencyMs,
    dataMissing,
  };
}

// ── 4. News lockout ──────────────────────────────────────────────────────
function evalNewsLockout(input: NewsLockoutInput): KillSwitchTrigger {
  const kind: KillSwitchKind = "NEWS_LOCKOUT";
  // Inside an active blackout window — always triggers
  if (input.inBlackoutWindow) {
    const inMin = input.minutesUntilBlackoutEnds ?? 0;
    return {
      kind, label: KILL_SWITCH_LABELS[kind],
      triggered: true,
      reason: `inside blackout window (${inMin.toFixed(0)} min until lifts)`,
      observed: "in_blackout",
      threshold: "no_blackout",
      dataMissing: false,
    };
  }
  // Approaching a high-impact event within the pre-event lockout window
  if (input.minutesUntilNextBlackout !== null
      && input.minutesUntilNextBlackout <= input.preEventLockoutMinutes) {
    return {
      kind, label: KILL_SWITCH_LABELS[kind],
      triggered: true,
      reason: `next high-impact event in ${input.minutesUntilNextBlackout.toFixed(0)} min ` +
              `≤ pre-event lockout ${input.preEventLockoutMinutes} min`,
      observed: input.minutesUntilNextBlackout,
      threshold: input.preEventLockoutMinutes,
      dataMissing: false,
    };
  }
  return {
    kind, label: KILL_SWITCH_LABELS[kind],
    triggered: false,
    reason: input.minutesUntilNextBlackout === null
      ? "no upcoming high-impact event"
      : `next event in ${input.minutesUntilNextBlackout.toFixed(0)} min — outside lockout`,
    observed: input.minutesUntilNextBlackout,
    threshold: input.preEventLockoutMinutes,
    dataMissing: false,
  };
}

// ── 5. Revenge trading ───────────────────────────────────────────────────
const REVENGE_RANK: Record<RevengeLevel, number> = {
  NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4,
};
function evalRevenge(input: RevengeTradingInput): KillSwitchTrigger {
  const kind: KillSwitchKind = "REVENGE_TRADING";
  const triggered = REVENGE_RANK[input.level] >= REVENGE_RANK[input.blockAtOrAbove];
  return {
    kind, label: KILL_SWITCH_LABELS[kind],
    triggered,
    reason: triggered
      ? `revenge level ${input.level} ≥ block-at ${input.blockAtOrAbove}`
      : `revenge level ${input.level} below block-at ${input.blockAtOrAbove}`,
    observed: input.level,
    threshold: input.blockAtOrAbove,
    dataMissing: false,
  };
}

// ── 6. Overexposure ──────────────────────────────────────────────────────
function evalExposure(input: ExposureInput): KillSwitchTrigger {
  const kind: KillSwitchKind = "OVEREXPOSURE";
  const subFails: string[] = [];
  let dataMissing = false;

  if (input.openTradeCount > input.maxOpenTrades) {
    subFails.push(`${input.openTradeCount} open trades > cap ${input.maxOpenTrades}`);
  }
  if (input.totalExposurePct === null) {
    dataMissing = true;
    subFails.push("total exposure % unavailable");
  } else if (input.totalExposurePct > input.maxExposurePct) {
    subFails.push(
      `exposure ${input.totalExposurePct.toFixed(1)}% > cap ${input.maxExposurePct.toFixed(1)}%`,
    );
  }

  const triggered = subFails.length > 0;
  return {
    kind, label: KILL_SWITCH_LABELS[kind],
    triggered,
    reason: triggered ? subFails.join("; ")
      : `${input.openTradeCount}/${input.maxOpenTrades} trades, ` +
        `exposure ${input.totalExposurePct?.toFixed(1) ?? "?"}%/${input.maxExposurePct.toFixed(1)}%`,
    observed: input.openTradeCount,
    threshold: input.maxOpenTrades,
    dataMissing,
  };
}

// ── Helper — fail-closed when measurement is unavailable ──────────────────
function failClosed(
  kind: KillSwitchKind, reason: string,
  observed: number | string | null, threshold: number | string,
): KillSwitchTrigger {
  return {
    kind, label: KILL_SWITCH_LABELS[kind],
    triggered: FAIL_CLOSED_ON_MISSING_DATA, // true by design
    reason: `${reason} — fail-closed (missing data treated as block)`,
    observed, threshold, dataMissing: true,
  };
}
