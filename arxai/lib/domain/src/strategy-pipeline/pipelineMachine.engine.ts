import {
  type PipelineDecision, type PipelineRecord, type PipelineStorePort, type StagePerformance,
} from "./pipelineStages.types";
import { evaluateStagePromotion } from "./evaluateStagePromotion.engine";

// stepPipeline — pure orchestration: load record (or initialize at
// HYPOTHESIS), evaluate, apply transition, persist new record + decision.
// Returns the decision so the caller can react (e.g. update approval
// registry when reaching LIMITED_LIVE/FULL_APPROVAL).
export async function stepPipeline(
  strategyId: string,
  perf: StagePerformance,
  store: PipelineStorePort,
  nowIso: string,
): Promise<{ decision: PipelineDecision; record: PipelineRecord }> {
  let record = await store.load(strategyId);
  if (record === null) {
    record = {
      strategyId,
      currentStage: "HYPOTHESIS",
      enteredStageAt: nowIso,
      history: [{ stage: "HYPOTHESIS", enteredAt: nowIso }],
    };
    await store.save(record);
  }

  const decision = evaluateStagePromotion(strategyId, record.currentStage, perf);
  await store.appendDecision(decision, nowIso);

  if (decision.kind === "PROMOTE" || decision.kind === "DEMOTE") {
    const next: PipelineRecord = {
      ...record,
      currentStage: decision.toStage,
      enteredStageAt: nowIso,
      history: [...record.history, { stage: decision.toStage, enteredAt: nowIso }],
    };
    await store.save(next);
    return { decision, record: next };
  }
  // HOLD / RETIRE — record unchanged (RETIRE callers should mark strategy disabled out-of-band)
  return { decision, record };
}
