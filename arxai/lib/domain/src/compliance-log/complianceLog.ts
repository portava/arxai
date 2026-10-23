import type { ComplianceEntry, ComplianceLogPort } from "./complianceLog.types";

// createInMemoryComplianceLog — append-only Port impl. Returned entries
// are deep-copied so callers cannot mutate the log via the references
// they receive.
export function createInMemoryComplianceLog(): ComplianceLogPort {
  const entries: ComplianceEntry[] = [];
  return {
    async append(entry) {
      entries.push({
        ...entry,
        reasons: [...entry.reasons],
        metadata: entry.metadata ? Object.freeze({ ...entry.metadata }) : undefined,
      });
    },
    async list(filter) {
      let out = entries.map((e) => ({
        ...e,
        reasons: [...e.reasons],
        metadata: e.metadata ? { ...e.metadata } : undefined,
      }));
      if (filter?.since) {
        const t = filter.since.getTime();
        out = out.filter((e) => Date.parse(e.recordedAt) >= t);
      }
      if (filter?.until) {
        const t = filter.until.getTime();
        out = out.filter((e) => Date.parse(e.recordedAt) <= t);
      }
      if (filter?.kind)      out = out.filter((e) => e.kind === filter.kind);
      if (filter?.subjectId) out = out.filter((e) => e.subjectId === filter.subjectId);
      return out;
    },
  };
}
