import {
  ALL_AGENTS, DEFAULT_AGENT_WEIGHTS,
  type AgentWeightProfile, type RegimeMemoryQuery,
  type RegimeMemoryStore, type RegimeMemoryRecord, type RegimeMemoryVerdict,
  type AiAgentName,
} from "./aiAgents.types";

const MIN_TRADES_FOR_MEMORY = 8;

// "AI must learn which strategies succeed in specific regimes."
// Read-only verdict on a (strategy, regime) pair, plus a weight modifier
// that the consensus engine multiplies into per-agent weights.
export function queryRegimeMemory(q: RegimeMemoryQuery): RegimeMemoryVerdict {
  const reasons: string[] = [];
  const rec = q.store.records.find(
    (r) => r.strategy === q.strategy && r.regime === q.regime,
  );

  if (!rec || rec.trades < MIN_TRADES_FOR_MEMORY) {
    reasons.push(`No memory yet (need ≥${MIN_TRADES_FOR_MEMORY} trades for ${q.strategy} in ${q.regime})`);
    return {
      hasMemory: false, trades: rec?.trades ?? 0,
      winRate: rec ? rec.wins / Math.max(1, rec.trades) : null,
      avgR: rec ? rec.totalR / Math.max(1, rec.trades) : null,
      weightMultiplier: 1.0, reasons,
    };
  }

  const winRate = rec.wins / rec.trades;
  const avgR = rec.totalR / rec.trades;

  // Multiplier curve: WR 0.5 + avgR 0.0 → 1.0; positive performance scales up to 1.5,
  // negative performance scales down to 0.5.
  const wrComponent = (winRate - 0.5) * 1.0;     // ±0.5
  const rComponent  = Math.max(-0.5, Math.min(0.5, avgR));
  const multiplier = clamp(1.0 + wrComponent + rComponent, 0.5, 1.5);

  reasons.push(`${rec.trades} trades: WR ${(winRate * 100).toFixed(0)}%, avg ${avgR.toFixed(2)}R → ×${multiplier.toFixed(2)}`);

  return {
    hasMemory: true, trades: rec.trades,
    winRate, avgR,
    weightMultiplier: multiplier, reasons,
  };
}

// Build a strategy/regime-specific weight profile by multiplying the
// regime-memory verdict into the default weights.
export function buildWeightProfile(
  strategy: string, regime: string, store: RegimeMemoryStore,
): AgentWeightProfile {
  const verdict = queryRegimeMemory({ strategy, regime, store });
  const weights = {} as Record<AiAgentName, number>;
  for (const a of ALL_AGENTS) {
    weights[a] = DEFAULT_AGENT_WEIGHTS[a] * verdict.weightMultiplier;
  }
  return {
    strategy, regime, weights,
    source: verdict.hasMemory ? "MEMORY" : "DEFAULT",
  };
}

// Update memory after a closed trade.
export function recordTradeOutcome(
  store: RegimeMemoryStore,
  strategy: string, regime: string,
  outcomeR: number, outcomeWasWin: boolean, now: Date = new Date(),
): RegimeMemoryStore {
  const existing = store.records.find((r) => r.strategy === strategy && r.regime === regime);
  if (!existing) {
    const fresh: RegimeMemoryRecord = {
      strategy, regime, trades: 1, wins: outcomeWasWin ? 1 : 0,
      totalR: outcomeR, lastUpdated: now.toISOString(),
    };
    return { records: [...store.records, fresh] };
  }
  const updated: RegimeMemoryRecord = {
    ...existing,
    trades: existing.trades + 1,
    wins: existing.wins + (outcomeWasWin ? 1 : 0),
    totalR: existing.totalR + outcomeR,
    lastUpdated: now.toISOString(),
  };
  return {
    records: store.records.map((r) => r === existing ? updated : r),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
