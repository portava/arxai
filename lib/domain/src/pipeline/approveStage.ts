import { calcLotSize } from "../risk/positionSizing.engine";
import { createDomainEvent } from "../events/eventFactory";
import type { AiDecision } from "../ai/aiInsight.types";
import type { PipelineContext, StageResult, ApproveOutput } from "./pipeline.types";
import type { RiskLimitKind } from "../events/domainEvents.types";

export interface ApproveStageInput {
  decision: AiDecision;
  pipSize: number;
  pipValuePerLot: number;
  minLot?: number;
  maxLot?: number;
  lotStep?: number;
}

// Pure stage. Combines drawdown/exposure/limits into a single allow/deny
// decision and computes the broker-clamped lot size.
export function runApprove(
  ctx: PipelineContext,
  input: ApproveStageInput,
  now: () => Date = () => new Date(),
): StageResult<ApproveOutput> {
  const start = now().getTime();
  const reasons: string[] = [];
  const events = [];

  const sig = ctx.signal;
  const limits = ctx.riskProfile.limits;

  // 1. Confidence floor
  if (input.decision.confidence < limits.minConfidenceScore) {
    const message = `Decision confidence ${input.decision.confidence} below floor ${limits.minConfidenceScore}`;
    events.push(createDomainEvent("RISK_LIMIT_HIT", {
      source: ctx.source, correlationId: ctx.correlationId,
      limit: "MIN_CONFIDENCE" satisfies RiskLimitKind,
      value: input.decision.confidence,
      threshold: limits.minConfidenceScore,
      blocked: true, message,
    }, { now }));
    reasons.push(message);
  }

  // 2. Drawdown guard already evaluated upstream — honor its verdict
  if (ctx.drawdown?.blocked) {
    const limit: RiskLimitKind =
      ctx.drawdown.state === "DAILY_LIMIT"  ? "DAILY_LOSS"
      : ctx.drawdown.state === "WEEKLY_LIMIT" ? "WEEKLY_LOSS"
      : "LOSING_STREAK";
    const message = ctx.drawdown.reasons.join("; ") || "Drawdown guard active";
    events.push(createDomainEvent("RISK_LIMIT_HIT", {
      source: ctx.source, correlationId: ctx.correlationId,
      limit, value: 0, threshold: 0, blocked: true, message,
    }, { now }));
    reasons.push(message);
  }

  // 3. Open-trade ceiling
  if (ctx.openTrades.length >= limits.maxOpenTrades) {
    const message = `${ctx.openTrades.length} open trades, max is ${limits.maxOpenTrades}`;
    events.push(createDomainEvent("RISK_LIMIT_HIT", {
      source: ctx.source, correlationId: ctx.correlationId,
      limit: "MAX_OPEN_TRADES",
      value: ctx.openTrades.length,
      threshold: limits.maxOpenTrades,
      blocked: true, message,
    }, { now }));
    reasons.push(message);
  }

  // 4. Sanity: signal must have entry + SL to size against
  if (sig.entry == null || sig.stopLoss == null) {
    reasons.push("Signal missing entry or stopLoss");
  }

  if (reasons.length > 0) {
    return { stage: "APPROVE", status: "REJECTED", output: null, reasons, events,
             durationMs: now().getTime() - start };
  }

  // Position sizing
  const slDistance = Math.abs((sig.entry as number) - (sig.stopLoss as number));
  const sized = calcLotSize({
    accountBalance: ctx.account.account?.balance ?? 0,
    riskPct: limits.riskPerTradePct,
    stopLossDistance: slDistance,
    pipSize: input.pipSize,
    pipValuePerLot: input.pipValuePerLot,
    minLot: input.minLot, maxLot: input.maxLot, lotStep: input.lotStep,
  });

  if (sized.recommendedLot <= 0) {
    return {
      stage: "APPROVE", status: "REJECTED", output: null,
      reasons: ["Position sizing returned 0 lots", ...sized.notes],
      events, durationMs: now().getTime() - start,
    };
  }

  return {
    stage: "APPROVE", status: "PASSED",
    output: {
      decision: input.decision,
      approvedLotSize: sized.recommendedLot,
      approvedStopLoss: sig.stopLoss as number,
      approvedTakeProfit: sig.takeProfit,
    },
    reasons: [`Approved at ${sized.recommendedLot} lots, risking ${sized.riskAmount}`, ...sized.notes],
    events,
    durationMs: now().getTime() - start,
  };
}
