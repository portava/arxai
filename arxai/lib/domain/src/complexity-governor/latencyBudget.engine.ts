import { type LatencyBudgetReport } from "./complexity.types";

// ═══════════════════════════════════════════════════════════════════════════
// Latency Budget — checks p95/p99 cycle latency against a budget.
// recommendDegrade when p99 > 2× budget OR p95 > 1.25× budget. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface LatencyInput {
  recentCycleLatenciesMs: ReadonlyArray<number>;
  budgetMs: number;
}

export function evaluateLatencyBudget(input: LatencyInput): LatencyBudgetReport {
  const reasons: string[] = [];
  const sorted = [...input.recentCycleLatenciesMs].filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const p = (q: number) => sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0) : 0;
  const p95 = p(0.95);
  const p99 = p(0.99);
  const budget = Math.max(1, input.budgetMs);
  const overBudget = p95 > budget;
  const recommendDegrade = p99 > 2 * budget || p95 > 1.25 * budget;
  reasons.push(`p95 ${p95.toFixed(1)}ms · p99 ${p99.toFixed(1)}ms · budget ${budget}ms → over=${overBudget}, degrade=${recommendDegrade}`);
  return { budgetMs: budget, observedP95Ms: p95, observedP99Ms: p99, overBudget, recommendDegrade, reasons };
}
