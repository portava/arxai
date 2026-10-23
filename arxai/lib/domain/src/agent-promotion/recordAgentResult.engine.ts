import {
  type AgentBucketStats, type AgentLedgerEntry, type AgentLedgerStorePort,
  AGENT_PROMOTION_THRESHOLDS, contextKey,
} from "./agentPromotion.types";

// recordAgentResult — append a graded outcome to the ledger and update
// the (agent, context) bucket's EMA score and counters.
export async function recordAgentResult(
  store: AgentLedgerStorePort,
  entry: AgentLedgerEntry,
): Promise<AgentBucketStats> {
  const T = AGENT_PROMOTION_THRESHOLDS;
  await store.putEntry(entry);

  const key = contextKey(entry.context);
  const existing = await store.getBucket(entry.agentId, key);

  const wasRight = entry.contribution === "RIGHT";
  const wasWrong = entry.contribution === "WRONG";

  const updated: AgentBucketStats = existing
    ? {
        agentId: entry.agentId,
        contextKey: key,
        sampleCount: existing.sampleCount + 1,
        rightCount: existing.rightCount + (wasRight ? 1 : 0),
        wrongCount: existing.wrongCount + (wasWrong ? 1 : 0),
        averageScore: existing.averageScore + T.emaAlpha * (entry.score - existing.averageScore),
        recordedThrough: entry.recordedAt,
      }
    : {
        agentId: entry.agentId,
        contextKey: key,
        sampleCount: 1,
        rightCount: wasRight ? 1 : 0,
        wrongCount: wasWrong ? 1 : 0,
        averageScore: entry.score,
        recordedThrough: entry.recordedAt,
      };

  await store.putBucket(updated);
  return updated;
}
