import type { PipelineDecision, PipelineRecord, PipelineStorePort } from "./pipelineStages.types";

export function createInMemoryPipelineStore(): PipelineStorePort {
  const records = new Map<string, PipelineRecord>();
  const decisions: { decision: PipelineDecision; atIso: string }[] = [];
  return {
    async load(id) {
      const r = records.get(id);
      return r ? { ...r, history: r.history.map((h) => ({ ...h })) } : null;
    },
    async save(r) {
      records.set(r.strategyId, { ...r, history: r.history.map((h) => ({ ...h })) });
    },
    async appendDecision(d, atIso) {
      decisions.push({
        decision: { ...d, failedGates: [...d.failedGates], reasons: [...d.reasons] },
        atIso,
      });
    },
    async listAll() {
      return Array.from(records.values()).map((r) => ({ ...r, history: r.history.map((h) => ({ ...h })) }));
    },
  };
}
