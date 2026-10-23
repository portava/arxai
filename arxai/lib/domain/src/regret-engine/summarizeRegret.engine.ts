import type { RegretKind, RegretRecord, RegretSummary } from "./regretEngine.types";

// summarizeRegret — aggregate regret records into a single summary.
// Useful for surfacing "this week's regret scoreboard" and as an input
// to the trust-ladder snapshot's "lessons learned" reasoning.
export function summarizeRegret(records: RegretRecord[]): RegretSummary {
  const reasons: string[] = [];
  const byKind: Partial<Record<RegretKind, number>> = {};
  let totalRegretR = 0;
  for (const r of records) {
    byKind[r.regretKind] = (byKind[r.regretKind] ?? 0) + 1;
    totalRegretR += r.regretMagnitudeR;
  }
  const meanRegretR = records.length > 0 ? totalRegretR / records.length : 0;
  reasons.push(`${records.length} record(s); total regret ${totalRegretR.toFixed(2)}R; mean ${meanRegretR.toFixed(2)}R`);
  return { totalRecords: records.length, byKind, totalRegretR, meanRegretR, reasons };
}
