import {
  type StrategyAllocation, type StrategyMetrics, type SymbolContext,
  type ExposureBalance, type RiskBudget, clampNonNegative,
} from "./portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Exposure Balancer — given current strategy allocations and the symbols
// each strategy is designed to trade, compute per-symbol risk exposure
// and the "correlated" total risk. If any per-symbol exposure exceeds
// perSymbolCapR, scale down the contributing strategies proportionally
// and report blockers.
//
// Pure. Returns adjusted allocations plus an ExposureBalance summary.
// ═══════════════════════════════════════════════════════════════════════════

export interface ExposureInput {
  allocations: ReadonlyArray<StrategyAllocation>;
  metrics: ReadonlyArray<StrategyMetrics>;
  symbols: ReadonlyArray<SymbolContext>;
  riskBudget: RiskBudget;
  highCorrelationThreshold?: number;   // default 0.7
}

export interface ExposureOutput {
  adjustedAllocations: ReadonlyArray<StrategyAllocation>;
  balance: ExposureBalance;
  reasons: string[];
}

export function balanceExposure(input: ExposureInput): ExposureOutput {
  const corrThreshold = input.highCorrelationThreshold ?? 0.7;
  const reasons: string[] = [];
  const blockers: string[] = [];
  // Distribute each strategy's risk evenly across its designed symbols.
  const metricsById = new Map(input.metrics.map((m) => [m.strategyId, m]));
  const perSymbol = new Map<string, number>();
  // Track which strategies contribute to each symbol so we can scale down.
  const contributors = new Map<string, { strategyId: string; risk: number }[]>();

  for (const a of input.allocations) {
    const m = metricsById.get(a.strategyId);
    if (!m) {
      blockers.push(`no metrics found for allocated strategy ${a.strategyId}`);
      continue;
    }
    const symbols = m.designedSymbols;
    if (symbols.length === 0) continue;
    const per = a.riskR / symbols.length;
    for (const s of symbols) {
      perSymbol.set(s, (perSymbol.get(s) ?? 0) + per);
      const list = contributors.get(s) ?? [];
      list.push({ strategyId: a.strategyId, risk: per });
      contributors.set(s, list);
    }
  }

  // Scale per-symbol exposure down to perSymbolCapR if exceeded.
  const cap = input.riskBudget.perSymbolCapR;
  const scaleByStrategy = new Map<string, number>();
  for (const [sym, total] of perSymbol) {
    if (total > cap && total > 0) {
      const scale = cap / total;
      reasons.push(`symbol ${sym} exposure ${total.toFixed(2)} > cap ${cap.toFixed(2)} — scaling contributors by ${scale.toFixed(3)}`);
      blockers.push(`per-symbol cap breached for ${sym} before rebalance`);
      for (const c of contributors.get(sym) ?? []) {
        const prev = scaleByStrategy.get(c.strategyId) ?? 1;
        // Apply the smallest scale across all symbols a strategy touches —
        // ensures no symbol's adjusted exposure exceeds its cap.
        scaleByStrategy.set(c.strategyId, Math.min(prev, scale));
      }
      perSymbol.set(sym, cap);
    }
  }

  // Rebuild allocations with scaling applied.
  const adjusted: StrategyAllocation[] = input.allocations.map((a) => {
    const scale = scaleByStrategy.get(a.strategyId) ?? 1;
    if (scale === 1) return a;
    const newRiskR = clampNonNegative(a.riskR * scale);
    return {
      ...a,
      riskR: newRiskR,
      weight01: a.weight01 * scale,
      reasons: [...a.reasons, `exposure rebalance: riskR ${a.riskR.toFixed(2)} → ${newRiskR.toFixed(2)} (scale ${scale.toFixed(3)})`],
    };
  });

  // Recompute per-symbol exposure from the ADJUSTED allocations so the
  // returned balance is consistent with the final risk plan, not the
  // pre-scale snapshot. Otherwise downstream observability shows stale
  // numbers (e.g. perSymbol == cap pinned but reality is now lower).
  const adjustedPerSymbol = new Map<string, number>();
  for (const a of adjusted) {
    const m = metricsById.get(a.strategyId);
    if (!m || m.designedSymbols.length === 0) continue;
    const per = a.riskR / m.designedSymbols.length;
    for (const s of m.designedSymbols) {
      adjustedPerSymbol.set(s, (adjustedPerSymbol.get(s) ?? 0) + per);
    }
  }

  // Correlated total — sum of risks across symbols whose pairwise
  // correlation exceeds the threshold (we use mean of correlations as a
  // rough cluster proxy). Computed from adjusted exposure.
  const corrSet = new Set<string>();
  for (const sc of input.symbols) {
    if (!sc.correlations) continue;
    for (const [other, c] of Object.entries(sc.correlations)) {
      if (Math.abs(c) >= corrThreshold) { corrSet.add(sc.symbolId); corrSet.add(other); }
    }
  }
  let totalCorrelatedRiskR = 0;
  for (const s of corrSet) totalCorrelatedRiskR += adjustedPerSymbol.get(s) ?? 0;
  if (totalCorrelatedRiskR > 0) {
    reasons.push(`correlated cluster risk ${totalCorrelatedRiskR.toFixed(2)} across ${corrSet.size} symbol(s) at |corr|≥${corrThreshold} (post-rebalance)`);
  }

  const balance: ExposureBalance = {
    perSymbolRiskR: Object.fromEntries(adjustedPerSymbol),
    totalCorrelatedRiskR,
    reasons, blockers,
  };
  return { adjustedAllocations: adjusted, balance, reasons };
}
