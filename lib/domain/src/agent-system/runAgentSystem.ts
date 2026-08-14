import { agentDebate } from "./debate/agentDebate.engine";
import { resolveConflicts } from "./debate/conflictResolver.engine";
import { explainDecision } from "./judge/decisionExplanation.engine";
import { tradeJudge } from "./judge/tradeJudge.engine";
import { riskGovernor } from "./governor/riskGovernor.engine";
import { prepareOrder } from "./execution/orderPreparation.engine";
import { executeOrderViaMt5, notSentResult } from "./execution/mt5Execution.engine";
import { verifyFill } from "./execution/fillVerification.engine";
import { riskAgent } from "./agents/risk.agent";
import { executionAgent } from "./agents/execution.agent";
import { newsAgent } from "./agents/news.agent";
import { traderDnaAgent } from "./agents/traderDNA.agent";
import { trendAgent } from "./agents/trend.agent";
import { momentumAgent } from "./agents/momentum.agent";
import { liquidityAgent } from "./agents/liquidity.agent";
import { marketStructureAgent } from "./agents/marketStructure.agent";
import { volatilityAgent } from "./agents/volatility.agent";
import { sessionAgent } from "./agents/session.agent";
import { entryPrecisionAgent } from "./agents/entryPrecision.agent";
import { historicalMatchAgent } from "./agents/historicalMatch.agent";
import type {
  AgentSystemSnapshot, AgentVerdict, DecisionRecord, DecisionStorePort,
  ExecutionPort, ExecutionResult, FillReport,
} from "./agentSystem.types";

// runAgentSystem — top-level pipeline.
//   sensors→agents→debate→judge→governor→execution
//
// EVERY decision is persisted via DecisionStorePort regardless of outcome
// (REJECT, BLOCKED, EXECUTE) — the store is the substrate for replay,
// training, and improvement, per the spec.
export interface RunAgentSystemDeps {
  store: DecisionStorePort;
  executionPort: ExecutionPort;
  generateDecisionId: () => string;
}
export interface RunAgentSystemResult {
  decisionId: string;
  record: DecisionRecord;
  fillReport: FillReport | null;
}

export async function runAgentSystem(
  snapshot: AgentSystemSnapshot,
  deps: RunAgentSystemDeps,
): Promise<RunAgentSystemResult> {
  // ── Agents ─────────────────────────────────────────────────────────────
  const agentVerdicts: AgentVerdict[] = [
    riskAgent(snapshot),
    executionAgent(snapshot),
    newsAgent(snapshot),
    traderDnaAgent(snapshot),
    trendAgent(snapshot),
    momentumAgent(snapshot),
    liquidityAgent(snapshot),
    marketStructureAgent(snapshot),
    volatilityAgent(snapshot),
    sessionAgent(snapshot),
    entryPrecisionAgent(snapshot),
    historicalMatchAgent(snapshot),
  ];

  // ── Debate (also resolves conflicts; resolutions surface in judge rationale) ─
  const debate = agentDebate(agentVerdicts);
  resolveConflicts(debate, agentVerdicts); // computed for completeness; judge uses debate directly

  // ── Judge ──────────────────────────────────────────────────────────────
  const proposed = tradeJudge(agentVerdicts, debate, snapshot.setup.direction);
  const explanation = explainDecision(proposed, agentVerdicts, debate);

  // ── Governor (final authority) ─────────────────────────────────────────
  const governor = riskGovernor(snapshot, proposed);

  // ── Execution (only if approved) ───────────────────────────────────────
  const decisionId = deps.generateDecisionId();
  let execution: ExecutionResult | null = null;
  let fillReport: FillReport | null = null;

  if (governor.finalAction === "REJECT") {
    execution = notSentResult(`governor ${governor.verdict} — order not prepared`);
  } else {
    const order = prepareOrder(snapshot, governor, decisionId);
    if (order === null) {
      execution = notSentResult("orderPreparation returned null");
    } else {
      execution = await executeOrderViaMt5(deps.executionPort, order);
      fillReport = verifyFill(execution, snapshot.setup.pipSize);
    }
  }

  // ── Persist decision (every decision, every outcome) ───────────────────
  const record: DecisionRecord = {
    decisionId,
    recordedAt: snapshot.now.toISOString(),
    snapshot,
    agentVerdicts,
    debate,
    proposedDecision: proposed,
    explanation,
    governorReview: governor,
    execution,
    monitoring: [],
    audit: null,
  };
  await deps.store.put(record);

  return { decisionId, record, fillReport };
}
