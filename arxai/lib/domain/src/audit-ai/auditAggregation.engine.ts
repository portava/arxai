import type { AuditAggregate, AuditGrade } from "./auditAi.types";

// aggregateAudits — roll up many AuditGrade records. Identifies the
// weakest dimension across all decisions so the system knows where to
// focus improvement.
export function aggregateAudits(grades: AuditGrade[]): AuditAggregate {
  const reasons: string[] = [];
  const byGrade: AuditAggregate["byGrade"] = {};
  let compSum = 0;
  const dimSums = { ruleCompliance01: 0, processQuality01: 0, entryQuality01: 0, exitQuality01: 0, outcomeQuality01: 0 };
  for (const g of grades) {
    byGrade[g.grade] = (byGrade[g.grade] ?? 0) + 1;
    compSum += g.composite01;
    dimSums.ruleCompliance01 += g.byDimension.ruleCompliance01;
    dimSums.processQuality01 += g.byDimension.processQuality01;
    dimSums.entryQuality01   += g.byDimension.entryQuality01;
    dimSums.exitQuality01    += g.byDimension.exitQuality01;
    dimSums.outcomeQuality01 += g.byDimension.outcomeQuality01;
  }
  const meanComposite = grades.length > 0 ? compSum / grades.length : 0;
  let weakest: AuditAggregate["weakestDimension"] = null;
  if (grades.length > 0) {
    const entries = Object.entries(dimSums) as [keyof typeof dimSums, number][];
    entries.sort((a, b) => a[1] - b[1]);
    weakest = entries[0]![0];
    reasons.push(`weakest dimension across ${grades.length} grades: ${weakest} (mean ${(entries[0]![1] / grades.length).toFixed(2)})`);
  } else {
    reasons.push("no grades — empty aggregate");
  }
  reasons.push(`mean composite ${meanComposite.toFixed(3)}`);
  return { totalDecisions: grades.length, byGrade, meanComposite01: meanComposite, weakestDimension: weakest, reasons };
}
