import { runDecide, type DecideStageInput } from "./decideStage";
import { runApprove, type ApproveStageInput } from "./approveStage";
import { runPlace } from "./placeStage";
import { runAudit } from "./auditStage";
import type { PipelinePorts } from "./ports";
import type {
  PipelineContext, PipelineOutcome, StageResult,
  DecideOutput, ApproveOutput, PlaceOutput,
} from "./pipeline.types";

export interface RunPipelineInput {
  decide: DecideStageInput;
  approve: Omit<ApproveStageInput, "decision">;
}

// AI decides → Risk approves → Execution places → Audit records.
//
// (Manage runs on its own cadence against the live trade set, not as part of
// every entry pipeline — see runManage in manageStage.ts.)
//
// Short-circuits on the first non-PASSED stage. Audit always runs at the end
// so even rejected runs are persisted with full reasons + emitted events.
export async function runEntryPipeline(
  ctx: PipelineContext,
  input: RunPipelineInput,
  ports: PipelinePorts,
  now: () => Date = () => new Date(),
): Promise<PipelineOutcome> {
  const results: StageResult[] = [];
  const allEvents: PipelineOutcome["events"] = [];
  let trade: PipelineOutcome["trade"] = null;

  // 1. AI decides
  const decideRes = runDecide(ctx, input.decide, now) as StageResult<DecideOutput>;
  results.push(decideRes);
  allEvents.push(...decideRes.events);
  if (decideRes.status !== "PASSED" || !decideRes.output) {
    return finalize(decideRes, results, allEvents, trade, ports, now);
  }

  // 2. Risk approves
  const approveRes = runApprove(
    ctx,
    { ...input.approve, decision: decideRes.output.decision },
    now,
  ) as StageResult<ApproveOutput>;
  results.push(approveRes);
  allEvents.push(...approveRes.events);
  if (approveRes.status !== "PASSED" || !approveRes.output) {
    return finalize(approveRes, results, allEvents, trade, ports, now);
  }

  // 3. Execution places
  const placeRes = await runPlace(ctx, approveRes.output, ports.execution, now) as StageResult<PlaceOutput>;
  results.push(placeRes);
  allEvents.push(...placeRes.events);
  if (placeRes.status === "PASSED" && placeRes.output) trade = placeRes.output.trade;

  return finalize(placeRes, results, allEvents, trade, ports, now);
}

async function finalize(
  last: StageResult,
  results: StageResult[],
  events: PipelineOutcome["events"],
  trade: PipelineOutcome["trade"],
  ports: PipelinePorts,
  now: () => Date,
): Promise<PipelineOutcome> {
  // 4. Audit records — always
  const auditRes = await runAudit({ results, events }, ports.audit);
  results.push(auditRes);

  const passed = last.stage === "PLACE" && last.status === "PASSED";
  const rejectionReasons = passed
    ? []
    : results.filter((r) => r.status !== "PASSED" && r.stage !== "AUDIT").flatMap((r) => r.reasons);

  void now; // reserved for future timestamping of the outcome
  return {
    finalStage: passed ? "AUDIT" : last.stage,
    passed,
    results,
    events,
    rejectionReasons,
    trade,
  };
}
