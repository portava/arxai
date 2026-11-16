import type {
  ExecutionGateContext, ExecutionGateResult, FinalDecision,
  GateEvaluators, GateStage, GateVerdict, StageResult,
} from "./executionGate.types";

// Minimum AI confidence for the MARKET_AI gate to APPROVE.
const AI_CONFIDENCE_FLOOR = 60;
const AI_WARN_BAND = 70;       // 60-70 → APPROVE with warning

// ── Default evaluators — composed from existing engines ────────────────────
// Each is a pure function; callers may swap them via the optional
// `evaluators` parameter on runExecutionGate.

export const defaultEvaluators: GateEvaluators = {
  // 1. MARKET_AI — does the signal itself look real?
  evaluateMarketAi: (ctx) => {
    const { signal } = ctx;
    const reasons: string[] = [];
    const warnings: string[] = [];

    if (signal.action === "WAIT" || signal.action === "AVOID") {
      reasons.push(`Signal action is ${signal.action} — no opportunity to evaluate`);
      return { verdict: "BLOCK", reasons, warnings };
    }
    if (signal.confidence < AI_CONFIDENCE_FLOOR) {
      reasons.push(`Confidence ${signal.confidence} < floor ${AI_CONFIDENCE_FLOOR}`);
      return { verdict: "BLOCK", reasons, warnings };
    }
    if (signal.entry == null || signal.stopLoss == null) {
      reasons.push("Signal missing entry or stop loss");
      return { verdict: "BLOCK", reasons, warnings };
    }
    if (signal.consumedByTradeId != null) {
      reasons.push(`Signal already consumed by trade ${signal.consumedByTradeId}`);
      return { verdict: "BLOCK", reasons, warnings };
    }

    reasons.push(`Confidence ${signal.confidence} ≥ floor ${AI_CONFIDENCE_FLOOR}`);
    reasons.push(...signal.reasons.map((r) => `signal: ${r}`));
    if (signal.confidence < AI_WARN_BAND) {
      warnings.push(`Confidence ${signal.confidence} is in the marginal band (${AI_CONFIDENCE_FLOOR}-${AI_WARN_BAND})`);
    }
    return { verdict: "APPROVE", reasons, warnings };
  },

  // 2. RISK_ENGINE — can the account safely take it?
  evaluateRisk: (ctx) => {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const acc = ctx.account.account;
    const limits = ctx.baselineRiskLimits;

    if (!acc) {
      reasons.push("No connected MT5 account");
      return { verdict: "BLOCK", reasons, warnings };
    }
    if (acc.balance <= 0) {
      reasons.push(`Account balance non-positive (${acc.balance})`);
      return { verdict: "BLOCK", reasons, warnings };
    }

    // Daily / weekly loss caps
    const dailyLossPct = ctx.account.startingDailyBalance > 0
      ? -(ctx.account.realizedPnLToday / ctx.account.startingDailyBalance) * 100
      : 0;
    if (dailyLossPct >= limits.maxDailyLossPct) {
      reasons.push(`Daily loss ${dailyLossPct.toFixed(2)}% ≥ cap ${limits.maxDailyLossPct}%`);
      return { verdict: "BLOCK", reasons, warnings };
    }
    const weeklyLossPct = ctx.account.startingWeeklyBalance > 0
      ? -(ctx.account.realizedPnLWeek / ctx.account.startingWeeklyBalance) * 100
      : 0;
    if (weeklyLossPct >= limits.maxWeeklyLossPct) {
      reasons.push(`Weekly loss ${weeklyLossPct.toFixed(2)}% ≥ cap ${limits.maxWeeklyLossPct}%`);
      return { verdict: "BLOCK", reasons, warnings };
    }
    if (ctx.account.openTradeCount >= limits.maxOpenTrades) {
      reasons.push(`Open trades ${ctx.account.openTradeCount} ≥ cap ${limits.maxOpenTrades}`);
      return { verdict: "BLOCK", reasons, warnings };
    }
    if (ctx.signal.confidence < limits.minConfidenceScore) {
      reasons.push(`Signal confidence ${ctx.signal.confidence} < risk profile floor ${limits.minConfidenceScore}`);
      return { verdict: "BLOCK", reasons, warnings };
    }

    // Drawdown report attached to risk slice (if computed)
    if (ctx.risk.drawdown && (ctx.risk.drawdown as { exceeded?: boolean }).exceeded) {
      reasons.push("Drawdown guard exceeded");
      return { verdict: "BLOCK", reasons, warnings };
    }

    reasons.push(`Daily loss ${dailyLossPct.toFixed(2)}% < cap ${limits.maxDailyLossPct}%`);
    reasons.push(`Open trades ${ctx.account.openTradeCount} < cap ${limits.maxOpenTrades}`);

    // Soft warnings
    if (dailyLossPct >= limits.maxDailyLossPct * 0.75) {
      warnings.push(`Daily loss at ${(dailyLossPct / limits.maxDailyLossPct * 100).toFixed(0)}% of cap`);
    }
    if (ctx.account.openTradeCount >= limits.maxOpenTrades - 1) {
      warnings.push(`One slot left under maxOpenTrades (${limits.maxOpenTrades})`);
    }

    return { verdict: "APPROVE", reasons, warnings };
  },

  // 3. TRADER_DNA — is the human safe to take it?
  evaluateTraderDna: (ctx) => {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const { revenge, overtrade, patterns } = ctx.trader;

    // Hard blocks
    if (revenge?.detected && (revenge.severity === "HIGH" || revenge.severity === "CRITICAL")) {
      reasons.push(`Revenge trading detected (${revenge.severity})`);
      reasons.push(...revenge.evidence.map((e) => `revenge: ${e}`));
      const cd = revenge.cooldownUntil;
      if (cd && new Date(cd).getTime() > (ctx.now ?? new Date()).getTime()) {
        reasons.push(`Cooldown active until ${cd}`);
      }
      return { verdict: "BLOCK", reasons, warnings };
    }
    if (overtrade?.detected && overtrade.recommendBlock) {
      reasons.push(`Overtrading (${overtrade.severity}) — ${overtrade.tradesToday} trades vs baseline ${overtrade.baseline.toFixed(1)}`);
      return { verdict: "BLOCK", reasons, warnings };
    }
    const criticalPattern = patterns.hits.find((h) => h.severity === "CRITICAL");
    if (criticalPattern) {
      reasons.push(`Critical behavior pattern: ${criticalPattern.pattern}`);
      reasons.push(...criticalPattern.evidence.map((e) => `pattern: ${e}`));
      return { verdict: "BLOCK", reasons, warnings };
    }

    // Soft warnings (don't block, but inform the operator)
    if (revenge?.detected) warnings.push(`Revenge signature at ${revenge.severity} — not blocking but watch`);
    if (overtrade?.detected) warnings.push(`Overtrading at ${overtrade.severity} — not yet blocking`);
    for (const hit of patterns.hits) {
      if (hit.severity === "HIGH") warnings.push(`Pattern ${hit.pattern} at HIGH severity`);
    }

    reasons.push("No revenge / overtrade / critical pattern detected");
    return { verdict: "APPROVE", reasons, warnings };
  },
};

// ── Orchestrator — runs the gates in order, short-circuits on BLOCK ───────
export function runExecutionGate(
  ctx: ExecutionGateContext,
  evaluators: GateEvaluators = defaultEvaluators,
): ExecutionGateResult {
  const now = ctx.now ?? new Date();
  const stages: StageResult[] = [];
  const startedAt = now.getTime();

  const order: { stage: GateStage; run: GateEvaluators[keyof GateEvaluators] }[] = [
    { stage: "MARKET_AI",   run: evaluators.evaluateMarketAi   },
    { stage: "RISK_ENGINE", run: evaluators.evaluateRisk       },
    { stage: "TRADER_DNA",  run: evaluators.evaluateTraderDna  },
  ];

  let blockedAt: GateStage | null = null;
  for (const { stage, run } of order) {
    const t0 = Date.now();
    const partial = run(ctx);
    const result: StageResult = {
      stage,
      verdict: partial.verdict,
      reasons: partial.reasons,
      warnings: partial.warnings,
      evaluatedAt: new Date(now.getTime() + (Date.now() - startedAt)).toISOString(),
      durationMs: Date.now() - t0,
    };
    stages.push(result);
    if (result.verdict === "BLOCK") { blockedAt = stage; break; }
  }

  const decision = deriveFinal(stages, blockedAt);
  return {
    decision,
    blockedAt,
    stages,
    signalId: String(ctx.signal.id),
    decidedAt: new Date(now.getTime() + (Date.now() - startedAt)).toISOString(),
    totalDurationMs: stages.reduce((s, r) => s + r.durationMs, 0),
  };
}

function deriveFinal(stages: StageResult[], blockedAt: GateStage | null): FinalDecision {
  if (blockedAt) return "BLOCKED";
  const anyWarn = stages.some((s) => s.warnings.length > 0 || s.verdict === "WARN");
  return anyWarn ? "APPROVED_WITH_WARN" : "APPROVED";
}

// ── Read-only convenience: collapse a result to a single boolean ──────────
export function mayExecute(result: ExecutionGateResult): boolean {
  return result.decision === "APPROVED" || result.decision === "APPROVED_WITH_WARN";
}

// ── Read-only convenience: stage verdict lookup ───────────────────────────
export function stageVerdict(
  result: ExecutionGateResult, stage: GateStage,
): GateVerdict | null {
  return result.stages.find((s) => s.stage === stage)?.verdict ?? null;
}
