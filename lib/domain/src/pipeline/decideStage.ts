import { decide } from "../ai/aiDecision.engine";
import type { AiConfidenceFactor } from "../ai/aiInsight.types";
import { createDomainEvent } from "../events/eventFactory";
import type { PipelineContext, StageResult, DecideOutput } from "./pipeline.types";

export interface DecideStageInput {
  factors: AiConfidenceFactor[];
  blockers?: string[];
  cautions?: { reason: string; penalty: number }[];
  approveThreshold?: number;
  waitFloor?: number;
}

// Pure stage. Wraps the ai.decide engine and produces a stage result + events.
export function runDecide(
  ctx: PipelineContext,
  input: DecideStageInput,
  now: () => Date = () => new Date(),
): StageResult<DecideOutput> {
  const start = now().getTime();
  const decision = decide(input);
  const events = decision.verdict === "BLOCK"
    ? [createDomainEvent("AI_WARNING_CREATED", {
        source: ctx.source,
        correlationId: ctx.correlationId,
        severity: decision.confidence < 30 ? "CRITICAL" : "WARN",
        message: decision.reasoning,
        symbol: ctx.signal.symbol,
        factors: decision.blockers,
      }, { now })]
    : [];

  const status =
    decision.verdict === "APPROVE" ? "PASSED"
    : decision.verdict === "WAIT"  ? "REJECTED"
    : "REJECTED";

  return {
    stage: "DECIDE",
    status,
    output: { decision },
    reasons: [decision.reasoning, ...decision.blockers],
    events,
    durationMs: now().getTime() - start,
  };
}
