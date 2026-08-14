import type { LiveInputsSnapshot } from "../live-inputs";
import type { AgentContext } from "../agents/agents.types";

// buildAgentContextFromSensors
//
// Takes a base AgentContext (assembled by the caller from non-sensor
// sources — strategy stats, timeframe analysis, trader profile, market
// regime, etc.) and overlays the live-input sensor readings into the
// fields they directly inform. Returns a fully-populated AgentContext
// ready to feed to the v2 agents.
//
// The adapter never invents data: if a sensor is unhealthy or missing a
// value, the corresponding base field is preserved unchanged. The
// `appliedOverlays` and `skippedOverlays` arrays in the result let
// callers audit exactly which sensor data made it into the agent input.
export interface BuildAgentContextResult {
  context: AgentContext;
  appliedOverlays: string[];
  skippedOverlays: string[];
}

export function buildAgentContextFromSensors(input: {
  base: AgentContext;
  snapshot: LiveInputsSnapshot;
  now?: Date;
}): BuildAgentContextResult {
  const { base, snapshot } = input;
  const applied: string[] = [];
  const skipped: string[] = [];

  // Cloning at the field level — we never mutate the caller's base.
  const session = { ...base.session };
  const broker  = { ...base.broker, health: { ...base.broker.health }, execution: base.broker.execution ? { ...base.broker.execution } : null };
  const account = { ...base.account };
  const risk    = { ...base.risk };
  const marketSnapshot = { ...base.marketSnapshot };

  // ── session sensor → SessionQualityInput ────────────────────────────────
  const sessionReading = snapshot.readings.session;
  if (sessionReading.value && sessionReading.health.isHealthy) {
    session.current = sessionReading.value.kind;
    session.minutesSinceSessionOpen = sessionReading.value.minutesSinceOpen;
    session.minutesUntilSessionEnd  = sessionReading.value.minutesUntilClose;
    applied.push("session.current ← sensor.session.kind");
  } else {
    skipped.push(`session: ${sessionReading.health.reasons.join("; ")}`);
  }

  // ── mt5Latency sensor → broker.execution.avgLatencyMs ──────────────────
  const latReading = snapshot.readings.mt5Latency;
  if (latReading.value && latReading.health.isHealthy && broker.execution) {
    broker.execution.avgLatencyMs = latReading.value.avgMs;
    applied.push("broker.execution.avgLatencyMs ← sensor.mt5Latency.avgMs");
  } else if (!latReading.value) {
    skipped.push("mt5Latency: no samples");
  }

  // ── account-risk sensor → account fields + risk.drawdown ────────────────
  const accReading = snapshot.readings.accountRisk;
  if (accReading.value && accReading.health.isHealthy) {
    if (account.account) {
      account.account = {
        ...account.account,
        balance: accReading.value.balance,
        equity:  accReading.value.equity,
      };
      applied.push("account.account.{balance,equity} ← sensor.accountRisk");
    }
    // Drawdown overlay — replace dailyLossPct on the existing report (or
    // synthesise a minimal report when the base hadn't computed one yet).
    if (accReading.value.drawdownPct >= 0) {
      const blocked = accReading.value.drawdownPct >= 20;
      const existing = risk.drawdown;
      risk.drawdown = existing
        ? { ...existing, dailyLossPct: accReading.value.drawdownPct, blocked }
        : {
            state: blocked ? "DAILY_LIMIT" : "OK",
            dailyLossPct: accReading.value.drawdownPct,
            weeklyLossPct: 0, losingStreak: 0, blocked, reasons: [],
          };
      applied.push("risk.drawdown.dailyLossPct ← sensor.accountRisk.drawdownPct");
    }
  } else {
    skipped.push(`accountRisk: ${accReading.health.reasons.join("; ")}`);
  }

  // ── open-trades sensor → account.openTradeCount ─────────────────────────
  const otReading = snapshot.readings.openTrades;
  if (otReading.value && otReading.health.isHealthy) {
    account.openTradeCount = otReading.value.totalCount;
    applied.push("account.openTradeCount ← sensor.openTrades.totalCount");
  }

  // ── price sensor → marketSnapshot.lastPrice + spread overlay ────────────
  const priceReading = snapshot.readings.price;
  if (priceReading.value && priceReading.health.isHealthy) {
    (marketSnapshot as { lastPrice?: number }).lastPrice = priceReading.value.mid;
    applied.push("marketSnapshot.lastPrice ← sensor.price.mid");
  }
  const spreadReading = snapshot.readings.spread;
  if (spreadReading.value && spreadReading.health.isHealthy) {
    (marketSnapshot as { spreadPips?: number }).spreadPips = spreadReading.value.currentPips;
    applied.push("marketSnapshot.spreadPips ← sensor.spread.currentPips");
  }

  // ── broker health rollup — if any sensor that informs broker is blocked,
  //    promote the broker health to unhealthy so executionAgent will BLOCK.
  if (snapshot.readings.mt5Latency.blockers.length > 0) {
    broker.health.isHealthy = false;
    broker.health.reasons = [...broker.health.reasons, ...snapshot.readings.mt5Latency.blockers];
    applied.push("broker.health.isHealthy ← false (mt5Latency blocking)");
  }

  const context: AgentContext = {
    ...base,
    session, broker, account, risk, marketSnapshot,
    now: input.now ?? base.now ?? new Date(),
  };

  return { context, appliedOverlays: applied, skippedOverlays: skipped };
}
