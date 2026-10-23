import type {
  CounterfactualOutcome, NoTradeRecord, NoTradeStorePort,
} from "./doNothing.types";

export function createInMemoryNoTradeStore(): NoTradeStorePort {
  const records = new Map<string, NoTradeRecord>();
  const outcomes = new Map<string, CounterfactualOutcome>();
  return {
    async putRecord(r) { records.set(r.noTradeId, { ...r }); },
    async putOutcome(o) { outcomes.set(o.noTradeId, { ...o }); },
    async listOutcomes(filter) {
      let arr = Array.from(outcomes.values());
      if (filter?.since || filter?.until) {
        arr = arr.filter((o) => {
          const r = records.get(o.noTradeId);
          if (!r) return false;
          const t = Date.parse(r.recordedAt);
          if (filter.since && t < filter.since.getTime()) return false;
          if (filter.until && t > filter.until.getTime()) return false;
          return true;
        });
      }
      return arr;
    },
    async listRecords(filter) {
      let arr = Array.from(records.values());
      if (filter?.since) {
        const t = filter.since.getTime();
        arr = arr.filter((r) => Date.parse(r.recordedAt) >= t);
      }
      if (filter?.until) {
        const t = filter.until.getTime();
        arr = arr.filter((r) => Date.parse(r.recordedAt) <= t);
      }
      return arr;
    },
  };
}
