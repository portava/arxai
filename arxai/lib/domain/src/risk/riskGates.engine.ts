import { evaluateDrawdown } from "./drawdownGuard.engine";
import { computeExposure } from "./exposure.engine";
import type {
  RiskGate, RiskGateContext, RiskGateEvaluation, RiskGateName, RiskGateResult,
} from "./riskGates.types";

// ── 10 named gates. Each is a pure (RiskGateContext) → RiskGateResult. ─────

const allow = (gate: RiskGateName, reason = ""): RiskGateResult =>
  ({ gate, status: "ALLOW", reason });

export const maxDailyLossGate: RiskGate = (ctx) => {
  const dd = evaluateDrawdown({
    startingDailyBalance: ctx.startingDailyBalance,
    startingWeeklyBalance: ctx.startingWeeklyBalance,
    currentBalance: ctx.account?.balance ?? 0,
    losingStreak: ctx.losingStreak,
    limits: ctx.limits,
  });
  if (dd.state === "DAILY_LIMIT") return {
    gate: "MAX_DAILY_LOSS", status: "BLOCK",
    reason: `Daily loss ${dd.dailyLossPct.toFixed(2)}% reached limit ${ctx.limits.maxDailyLossPct}%`,
    value: dd.dailyLossPct, threshold: ctx.limits.maxDailyLossPct,
  };
  if (dd.dailyLossPct >= ctx.limits.maxDailyLossPct * 0.7) return {
    gate: "MAX_DAILY_LOSS", status: "WARN",
    reason: `Daily loss ${dd.dailyLossPct.toFixed(2)}% within 70% of cap`,
    value: dd.dailyLossPct, threshold: ctx.limits.maxDailyLossPct,
  };
  return allow("MAX_DAILY_LOSS", `Daily loss ${dd.dailyLossPct.toFixed(2)}%`);
};

export const maxOpenTradesGate: RiskGate = (ctx) => {
  const count = ctx.openTrades.length;
  if (count >= ctx.limits.maxOpenTrades) return {
    gate: "MAX_OPEN_TRADES", status: "BLOCK",
    reason: `${count} open trades, max ${ctx.limits.maxOpenTrades}`,
    value: count, threshold: ctx.limits.maxOpenTrades,
  };
  return allow("MAX_OPEN_TRADES", `${count}/${ctx.limits.maxOpenTrades} open`);
};

export const maxLotSizeGate: RiskGate = (ctx) => {
  if (ctx.proposedLotSize > ctx.config.maxLotSize) return {
    gate: "MAX_LOT_SIZE", status: "BLOCK",
    reason: `Proposed lot ${ctx.proposedLotSize} exceeds cap ${ctx.config.maxLotSize}`,
    value: ctx.proposedLotSize, threshold: ctx.config.maxLotSize,
  };
  return allow("MAX_LOT_SIZE", `Lot ${ctx.proposedLotSize} ≤ ${ctx.config.maxLotSize}`);
};

export const maxExposurePerSymbolGate: RiskGate = (ctx) => {
  const exposure = computeExposure(ctx.openTrades, {
    maxLotsPerSymbol: ctx.config.maxExposurePerSymbol,
  });
  const symBucket = exposure.bySymbol.find((b) => b.key === ctx.symbol);
  const sign = ctx.proposedDirection === "BUY" ? 1 : -1;
  const projected = (symBucket?.netLots ?? 0) + sign * ctx.proposedLotSize;
  if (Math.abs(projected) > ctx.config.maxExposurePerSymbol) return {
    gate: "MAX_EXPOSURE_PER_SYMBOL", status: "BLOCK",
    reason: `${ctx.symbol} projected exposure ${projected.toFixed(2)} would exceed cap ${ctx.config.maxExposurePerSymbol}`,
    value: Math.abs(projected), threshold: ctx.config.maxExposurePerSymbol,
  };
  return allow("MAX_EXPOSURE_PER_SYMBOL", `${ctx.symbol} projected ${projected.toFixed(2)}`);
};

export const spreadCheckGate: RiskGate = (ctx) => {
  if (ctx.currentSpreadPips == null) return {
    gate: "SPREAD_CHECK", status: "WARN",
    reason: "Spread unknown — proceeding with caution",
  };
  if (ctx.currentSpreadPips > ctx.config.maxSpreadPips) return {
    gate: "SPREAD_CHECK", status: "BLOCK",
    reason: `Spread ${ctx.currentSpreadPips.toFixed(1)}p exceeds cap ${ctx.config.maxSpreadPips}p`,
    value: ctx.currentSpreadPips, threshold: ctx.config.maxSpreadPips,
  };
  return allow("SPREAD_CHECK", `${ctx.currentSpreadPips.toFixed(1)}p ≤ ${ctx.config.maxSpreadPips}p`);
};

const VOL_RANK = { CALM: 0, NORMAL: 1, ELEVATED: 2, EXTREME: 3 } as const;

export const volatilityCheckGate: RiskGate = (ctx) => {
  if (ctx.currentVolatility == null) return {
    gate: "VOLATILITY_CHECK", status: "WARN",
    reason: "Volatility unknown — proceeding with caution",
  };
  const observed = VOL_RANK[ctx.currentVolatility];
  const max = VOL_RANK[ctx.config.maxVolatility];
  if (observed > max) return {
    gate: "VOLATILITY_CHECK", status: "BLOCK",
    reason: `Volatility ${ctx.currentVolatility} above cap ${ctx.config.maxVolatility}`,
    value: observed, threshold: max,
  };
  return allow("VOLATILITY_CHECK", `${ctx.currentVolatility} ≤ ${ctx.config.maxVolatility}`);
};

export const newsLockoutGate: RiskGate = (ctx) => {
  const now = (ctx.now ?? new Date()).getTime();
  const beforeMs = ctx.config.newsLockoutMinutesBefore * 60_000;
  const afterMs  = ctx.config.newsLockoutMinutesAfter  * 60_000;
  for (const w of ctx.newsWindows) {
    if (w.symbol !== "*" && w.symbol !== ctx.symbol) continue;
    if (w.severity === "LOW") continue;
    const from = new Date(w.from).getTime() - beforeMs;
    const to   = new Date(w.to).getTime()   + afterMs;
    if (now >= from && now <= to) return {
      gate: "NEWS_LOCKOUT", status: "BLOCK",
      reason: `${w.severity} news active on ${w.symbol}: ${w.headline}`,
    };
  }
  return allow("NEWS_LOCKOUT", "No active news windows");
};

export const drawdownCheckGate: RiskGate = (ctx) => {
  const dd = evaluateDrawdown({
    startingDailyBalance: ctx.startingDailyBalance,
    startingWeeklyBalance: ctx.startingWeeklyBalance,
    currentBalance: ctx.account?.balance ?? 0,
    losingStreak: ctx.losingStreak,
    limits: ctx.limits,
  });
  if (dd.blocked) return {
    gate: "DRAWDOWN_CHECK", status: "BLOCK",
    reason: dd.reasons.join("; ") || `Drawdown state ${dd.state}`,
  };
  if (dd.state === "CAUTION") return {
    gate: "DRAWDOWN_CHECK", status: "WARN",
    reason: dd.reasons.join("; "),
  };
  return allow("DRAWDOWN_CHECK", "Drawdown OK");
};

export const sessionRuleGate: RiskGate = (ctx) => {
  if (!ctx.config.allowedSessions.includes(ctx.currentSession)) return {
    gate: "SESSION_RULE", status: "BLOCK",
    reason: `Session ${ctx.currentSession} not in allowed list [${ctx.config.allowedSessions.join(", ")}]`,
  };
  return allow("SESSION_RULE", `${ctx.currentSession} permitted`);
};

export const manualOverrideGate: RiskGate = (ctx) => {
  const o = ctx.override;
  const expired = o.expiresAt != null && new Date(o.expiresAt).getTime() < (ctx.now ?? new Date()).getTime();
  if (o.state === "NONE" || expired) return allow("MANUAL_OVERRIDE", "No override active");
  if (o.state === "FORCE_BLOCK") return {
    gate: "MANUAL_OVERRIDE", status: "BLOCK",
    reason: `Manual block by ${o.setBy ?? "operator"}: ${o.reason ?? "no reason given"}`,
  };
  // FORCE_ALLOW is reported separately at the composer level so it can
  // override BLOCKs from other gates intentionally.
  return { gate: "MANUAL_OVERRIDE", status: "ALLOW",
    reason: `Manual force-allow by ${o.setBy ?? "operator"}: ${o.reason ?? "no reason given"}` };
};

// ── The default registry, in evaluation order ──────────────────────────────
export const DEFAULT_GATES: RiskGate[] = [
  manualOverrideGate,        // evaluated first so we can detect FORCE_ALLOW/BLOCK
  drawdownCheckGate,
  maxDailyLossGate,
  maxOpenTradesGate,
  maxLotSizeGate,
  maxExposurePerSymbolGate,
  spreadCheckGate,
  volatilityCheckGate,
  newsLockoutGate,
  sessionRuleGate,
];

// ── Composer ────────────────────────────────────────────────────────────────
// Runs every gate, then aggregates. FORCE_ALLOW overrides BLOCKs (the operator
// is taking explicit responsibility); FORCE_BLOCK is sticky. WARNs never block
// on their own.
export function evaluateRiskGates(
  ctx: RiskGateContext,
  gates: RiskGate[] = DEFAULT_GATES,
): RiskGateEvaluation {
  const results = gates.map((g) => g(ctx));
  const blocking = results.filter((r) => r.status === "BLOCK");
  const warnings = results.filter((r) => r.status === "WARN");
  const override = ctx.override.state;

  let allowed: boolean;
  if (override === "FORCE_BLOCK") allowed = false;
  else if (override === "FORCE_ALLOW") allowed = !blocking.some((r) => r.gate === "MANUAL_OVERRIDE");
  else allowed = blocking.length === 0;

  return { allowed, results, blocking, warnings, override };
}
