import type { LiveInputsSnapshot } from "../live-inputs";
import type { AgentContext } from "../agents/agents.types";
import type { ConsensusResult as V1Result } from "../ai-agents/aiAgents.types";
import type { ConsensusResult as V2Result } from "../agents/consensusVerdict.types";
import { buildAgentContextFromSensors } from "./sensorAdapter";
import { runShadowComparison } from "./shadowRunner";
import { buildDisagreementRecord, shouldRecord } from "./disagreementStore";
import type { DisagreementStorePort, ShadowComparison } from "./intelligenceV2.types";

// runShadowCycle
//
// End-to-end orchestration for one shadow-mode tick. Materially completes
// requirements 1, 3, and 4 of the v2 spec:
//
//   1. Adapts a live-inputs snapshot onto a base AgentContext via the
//      sensor adapter (caller supplies the non-sensor base).
//   3. Runs both v1 and v2 consensus on the same input via caller-
//      supplied closures and produces a structured ShadowComparison.
//   4. Mandatorily persists every disagreement to the supplied store —
//      no caller-side opt-out, so "store every disagreement" is enforced.
//
// Pure orchestration: every IO point is a Port (the store) or a closure
// (runV1/runV2). The 10 v2 agent engines and v1 ai-agent engines have
// arbitrary signatures; the closures let callers wire them however the
// host environment requires (sync, async, batched, cached) without this
// layer needing to know.
export interface RunShadowCycleInput {
  signalId: string;
  symbol: string;
  snapshot: LiveInputsSnapshot;
  base: AgentContext;
  runV1: (context: AgentContext) => Promise<V1Result>;
  runV2: (context: AgentContext) => Promise<V2Result>;
  store: DisagreementStorePort;
  now?: Date;
}

export interface RunShadowCycleResult {
  context: AgentContext;
  appliedOverlays: string[];
  skippedOverlays: string[];
  v1: V1Result;
  v2: V2Result;
  comparison: ShadowComparison;
  recorded: boolean;             // true when this cycle wrote a disagreement record
  recordId: string | null;
}

export async function runShadowCycle(input: RunShadowCycleInput): Promise<RunShadowCycleResult> {
  const now = input.now ?? new Date();

  // 1. Adapt sensor snapshot onto the base context
  const { context, appliedOverlays, skippedOverlays } = buildAgentContextFromSensors({
    base: input.base, snapshot: input.snapshot, now,
  });

  // 2. Run both engines in parallel — they share the adapted context
  const [v1, v2] = await Promise.all([input.runV1(context), input.runV2(context)]);

  // 3. Compare
  const comparison = runShadowComparison({ signalId: input.signalId, v1, v2, now });

  // 4. Mandatory persistence on disagreement
  let recorded = false;
  let recordId: string | null = null;
  if (shouldRecord(comparison)) {
    const record = buildDisagreementRecord({ comparison, symbol: input.symbol, now });
    await input.store.record(record);
    recorded = true;
    recordId = record.id;
  }

  return { context, appliedOverlays, skippedOverlays, v1, v2, comparison, recorded, recordId };
}
