import type { RegretRecord, RegretStorePort } from "./regretEngine.types";

export function createInMemoryRegretStore(): RegretStorePort {
  const records: RegretRecord[] = [];
  return {
    async put(r) { records.push({ ...r, reasons: [...r.reasons] }); },
    async list(filter) {
      let arr = records.map((r) => ({ ...r, reasons: [...r.reasons] }));
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
