import type {
  AgentBucketStats, AgentLedgerEntry, AgentLedgerStorePort,
} from "./agentPromotion.types";

export function createInMemoryAgentLedgerStore(): AgentLedgerStorePort {
  const entries: AgentLedgerEntry[] = [];
  const buckets = new Map<string, AgentBucketStats>();   // key = agentId|contextKey

  const k = (agentId: string, contextKey: string) => `${agentId}|${contextKey}`;

  return {
    async putEntry(e) { entries.push({ ...e }); },
    async getBucket(agentId, contextKey) {
      const b = buckets.get(k(agentId, contextKey));
      return b ? { ...b } : null;
    },
    async putBucket(b) { buckets.set(k(b.agentId, b.contextKey), { ...b }); },
    async listBucketsForContext(contextKey) {
      return Array.from(buckets.values()).filter((b) => b.contextKey === contextKey);
    },
  };
}
