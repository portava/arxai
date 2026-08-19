import type {
  PermissionInputs,
  PermissionVerdict,
  PermissionReason,
  RiskLevel,
} from "./types.js";

/**
 * Pure permission engine.
 *
 * Composes existing system state (safetyCore, risk_settings, trader-dna detectors,
 * recent trade outcomes, active risk_locks) into a single user-facing verdict.
 *
 * Inviolable: returns canPlaceTrades:false unconditionally — the MVP is
 * OBSERVE_ONLY + PAPER_TRADING. The status enum lets a future LIVE_TRADING build
 * gate execution by reading the same verdict.
 */
export function evaluatePermission(inputs: PermissionInputs): PermissionVerdict {
  const reasons: PermissionReason[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  // ── Hard blockers ──────────────────────────────────────────────────────
  if (inputs.killSwitchEngaged) {
    const m = "Kill switch is engaged — all trading is paused.";
    blockers.push(m);
    reasons.push({ code: "KILL_SWITCH", severity: "BLOCK", message: m });
  }

  if (inputs.liveLocked) {
    const m = "Live trading is locked by user setting (risk_settings.liveLocked).";
    blockers.push(m);
    reasons.push({ code: "LIVE_LOCKED_USER", severity: "BLOCK", message: m });
  }

  if (inputs.todaysLossPct < 0 && Math.abs(inputs.todaysLossPct) >= inputs.maxDailyLossPct) {
    const m = `Daily loss limit reached (${inputs.todaysLossPct.toFixed(2)}% vs −${inputs.maxDailyLossPct}%).`;
    blockers.push(m);
    reasons.push({ code: "DAILY_LOSS_LIMIT", severity: "BLOCK", message: m });
  }

  if (inputs.todaysTradesCount >= inputs.maxTradesPerDay) {
    const m = `Maximum trades per day reached (${inputs.todaysTradesCount}/${inputs.maxTradesPerDay}).`;
    blockers.push(m);
    reasons.push({ code: "MAX_TRADES_REACHED", severity: "BLOCK", message: m });
  }

  if (inputs.consecutiveLosses >= inputs.stopAfterLosingStreak) {
    const m = `Consecutive-loss limit hit (${inputs.consecutiveLosses}/${inputs.stopAfterLosingStreak}).`;
    blockers.push(m);
    reasons.push({ code: "CONSECUTIVE_LOSSES", severity: "BLOCK", message: m });
  }

  if (inputs.marketCondition === "NO_TRADE") {
    const m = "Current market condition is NO TRADE.";
    blockers.push(m);
    reasons.push({ code: "MARKET_NO_TRADE", severity: "BLOCK", message: m });
  }

  if (inputs.revengeTrading) {
    const m = "Revenge-trading pattern detected.";
    blockers.push(m);
    reasons.push({ code: "REVENGE_TRADING", severity: "BLOCK", message: m });
  }

  if (inputs.overtrading) {
    const m = "Overtrading pattern detected.";
    blockers.push(m);
    reasons.push({ code: "OVERTRADE", severity: "BLOCK", message: m });
  }

  for (const lock of inputs.activeLocks) {
    const m = `Active risk lock: ${lock.lockType} — ${lock.reason}`;
    blockers.push(m);
    reasons.push({ code: `LOCK_${lock.lockType}`, severity: "BLOCK", message: m });
  }

  // ── Warnings (non-blocking) ────────────────────────────────────────────
  if (inputs.consecutiveLosses > 0 && inputs.consecutiveLosses === inputs.stopAfterLosingStreak - 1 && inputs.consecutiveLosses >= 2) {
    const m = `Caution: ${inputs.consecutiveLosses} losses in a row — one more triggers a cooldown.`;
    warnings.push(m);
    reasons.push({ code: "WARN_LOSS_STREAK", severity: "WARN", message: m });
  }

  if (inputs.todaysLossPct < 0 && Math.abs(inputs.todaysLossPct) >= inputs.maxDailyLossPct * 0.75) {
    const m = `Approaching daily loss limit (${inputs.todaysLossPct.toFixed(2)}% of −${inputs.maxDailyLossPct}%).`;
    warnings.push(m);
    reasons.push({ code: "WARN_DAILY_LOSS", severity: "WARN", message: m });
  }

  if (inputs.todaysTradesCount >= Math.max(1, Math.floor(inputs.maxTradesPerDay * 0.8))) {
    const m = `Approaching daily trade limit (${inputs.todaysTradesCount}/${inputs.maxTradesPerDay}).`;
    warnings.push(m);
    reasons.push({ code: "WARN_TRADE_COUNT", severity: "WARN", message: m });
  }

  if (inputs.spreadWide) {
    const m = "Spread is wider than normal for this symbol.";
    warnings.push(m);
    reasons.push({ code: "WARN_WIDE_SPREAD", severity: "WARN", message: m });
  }

  if (inputs.liquidityLow) {
    const m = "Liquidity is low — slippage risk elevated.";
    warnings.push(m);
    reasons.push({ code: "WARN_LOW_LIQUIDITY", severity: "WARN", message: m });
  }

  if (inputs.mt5LinkHealth === "DEGRADED") {
    const m = "MT5 link is degraded — heartbeat is stale.";
    warnings.push(m);
    reasons.push({ code: "WARN_MT5_DEGRADED", severity: "WARN", message: m });
  }

  if (inputs.mt5LinkHealth === "DOWN" && !inputs.brokerCredentialsConfigured) {
    // EA auth is per-user only — the legacy MT5_BRIDGE_TOKEN env value is
    // rejected on every EA endpoint, so the fix is issuing a per-user token.
    const m = "MT5 bridge is not configured — live execution requires an active per-user bridge token issued from the MT5 Setup page.";
    reasons.push({ code: "INFO_BROKER_MISSING", severity: "INFO", message: m });
  }

  // ── Status derivation ──────────────────────────────────────────────────
  const liveTradingDisabled = !inputs.liveAllowed || inputs.liveLocked;

  let status: PermissionVerdict["status"];
  if (blockers.length > 0) status = "LOCKED";
  else if (warnings.length > 0) status = "CAUTION";
  else if (liveTradingDisabled) status = "LIVE_TRADING_DISABLED";
  else status = "CLEAR";

  // ── Risk level derivation (independent of LIVE gating) ─────────────────
  const blockCount = blockers.length;
  const warnCount = warnings.length;
  let riskLevel: RiskLevel;
  if (blockCount >= 2) riskLevel = "CRITICAL";
  else if (blockCount === 1) riskLevel = "HIGH";
  else if (warnCount >= 2) riskLevel = "MEDIUM";
  else riskLevel = "LOW";

  // ── Active lock summary ────────────────────────────────────────────────
  const activeLockType = inputs.activeLocks[0]?.lockType ?? null;

  return {
    status,
    riskLevel,
    canPlaceTrades: false,
    liveTradingDisabled,
    activeLockType,
    reasons,
    blockers,
    warnings,
    activeLocks: inputs.activeLocks,
    evaluatedAtIso: new Date().toISOString(),
  };
}
