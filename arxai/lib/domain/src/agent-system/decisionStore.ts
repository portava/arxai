import type {
  AuditReport, DecisionRecord, DecisionStorePort, MonitoringBundle,
} from "./agentSystem.types";

// inMemoryDecisionStore — minimal in-memory implementation of the typed
// DecisionStorePort. Useful for tests, dev mode, and as a reference for
// what a real Postgres / S3 implementation must satisfy.
//
// Real implementations would persist to durable storage; everything in
// this layer references the Port, never this implementation directly.
export function createInMemoryDecisionStore(): DecisionStorePort {
  const records = new Map<string, DecisionRecord>();

  return {
    async put(record) {
      records.set(record.decisionId, { ...record });
    },
    async appendMonitoring(decisionId, bundle: MonitoringBundle) {
      const r = records.get(decisionId);
      if (!r) throw new Error(`decision ${decisionId} not found — monitoring append failed`);
      r.monitoring = [...r.monitoring, bundle];
      records.set(decisionId, r);
    },
    async setAudit(decisionId, report: AuditReport) {
      const r = records.get(decisionId);
      if (!r) throw new Error(`decision ${decisionId} not found — audit set failed`);
      r.audit = report;
      records.set(decisionId, r);
    },
    async get(decisionId) {
      const r = records.get(decisionId);
      return r ? { ...r } : null;
    },
    async list(filter) {
      let arr = Array.from(records.values());
      if (filter?.symbol) arr = arr.filter((r) => r.snapshot.setup.symbol === filter.symbol);
      if (filter?.since) {
        const since = filter.since.getTime();
        arr = arr.filter((r) => Date.parse(r.recordedAt) >= since);
      }
      if (filter?.until) {
        const until = filter.until.getTime();
        arr = arr.filter((r) => Date.parse(r.recordedAt) <= until);
      }
      return arr;
    },
  };
}
