// Profit Mission Phase 9 — Learning loop (reliability aggregation).
//
// Pure, deterministic, IO-free reducer. Given the mission's closed-trade records it
// computes reliability scores per agent / strategy / symbol / session / pattern,
// which future missions read to weight proposals. ADVISORY ONLY — reliability never
// gates execution; it can only inform ranking and the promotion gate's agent-
// reliability input. No fabrication: a dimension with no closed trades reports no
// score rather than a guessed one.

export interface ClosedTradeRecord {
  agentKey: string | null;
  strategyKey: string | null;
  symbol: string | null;
  /** Trading session label (e.g. ASIA / LONDON / NEWYORK), if known. */
  session: string | null;
  /** Pattern/setup label, if known. */
  pattern: string | null;
  /** Realised reward-to-risk for the trade. */
  rMultiple: number;
  /** True if the trade closed in profit. */
  win: boolean;
}

export interface ReliabilityScore {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  avgR: number;
  /** Reliability 0..1 blending win rate and a sample-confidence factor. */
  reliability: number;
}

export interface LearningLoopResult {
  byAgent: ReliabilityScore[];
  byStrategy: ReliabilityScore[];
  bySymbol: ReliabilityScore[];
  bySession: ReliabilityScore[];
  byPattern: ReliabilityScore[];
  /** Aggregate agent reliability across all agents (0 when no evidence). */
  aggregateAgentReliability: number;
  totalTrades: number;
}

// Sample-confidence ramp: a dimension is fully trusted at this many trades.
const FULL_CONFIDENCE_TRADES = 20;

function score(key: string, records: ClosedTradeRecord[]): ReliabilityScore {
  const trades = records.length;
  const wins = records.filter((r) => r.win).length;
  const winRate = trades > 0 ? wins / trades : 0;
  const avgR = trades > 0 ? records.reduce((s, r) => s + (Number.isFinite(r.rMultiple) ? r.rMultiple : 0), 0) / trades : 0;
  const confidence = Math.min(1, trades / FULL_CONFIDENCE_TRADES);
  // Reliability is win rate damped by how much evidence backs it.
  const reliability = winRate * confidence;
  return { key, trades, wins, winRate, avgR, reliability };
}

function groupScores(records: ClosedTradeRecord[], pick: (r: ClosedTradeRecord) => string | null): ReliabilityScore[] {
  const groups = new Map<string, ClosedTradeRecord[]>();
  for (const r of records) {
    const k = pick(r);
    if (!k) continue; // no fabrication for unknown dimension values
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }
  return [...groups.entries()]
    .map(([k, rs]) => score(k, rs))
    .sort((a, b) => b.reliability - a.reliability);
}

export function runMissionLearningLoop(records: ClosedTradeRecord[]): LearningLoopResult {
  const byAgent = groupScores(records, (r) => r.agentKey);
  const byStrategy = groupScores(records, (r) => r.strategyKey);
  const bySymbol = groupScores(records, (r) => r.symbol);
  const bySession = groupScores(records, (r) => r.session);
  const byPattern = groupScores(records, (r) => r.pattern);

  // Aggregate agent reliability = trade-weighted mean across agents (0 if none).
  const agentTrades = byAgent.reduce((s, a) => s + a.trades, 0);
  const aggregateAgentReliability = agentTrades > 0
    ? byAgent.reduce((s, a) => s + a.reliability * a.trades, 0) / agentTrades
    : 0;

  return {
    byAgent, byStrategy, bySymbol, bySession, byPattern,
    aggregateAgentReliability,
    totalTrades: records.length,
  };
}
