import { z } from "zod/v4";

// Agent Promotion System — per-(agent, context) performance ledger;
// weights derived from the ledger boost/penalize agents in the contexts
// where they prove themselves. NEVER places trades; only emits weights.

export const AgentContributionSchema = z.enum(["RIGHT", "WRONG", "ABSTAINED", "NEUTRAL"]);
export type AgentContribution = z.infer<typeof AgentContributionSchema>;

export interface AgentContext {
  symbol: string;
  session: "ASIA" | "LONDON" | "NY" | "OFF_HOURS";
  strategy: string;       // free-form tag (e.g. "TREND_PULLBACK")
  regimeId: string;
}

// A single graded outcome, recorded into the ledger.
export interface AgentLedgerEntry {
  agentId: string;
  context: AgentContext;
  contribution: AgentContribution;
  score: number;              // 0..100 from the audit grade
  recordedAt: string;
  tradeId: string;
}

// Aggregate over a (agent, contextKey) for weight derivation.
export interface AgentBucketStats {
  agentId: string;
  contextKey: string;
  sampleCount: number;
  rightCount: number;
  wrongCount: number;
  averageScore: number;       // EMA over recent scores
  recordedThrough: string;
}

export interface AgentWeight {
  agentId: string;
  contextKey: string;
  weight: number;             // 0..2  (1 = neutral)
  trust01: number;            // 0..1  (sample-size confidence)
  reasons: string[];
}

export interface AgentLedgerStorePort {
  putEntry(e: AgentLedgerEntry): Promise<void>;
  getBucket(agentId: string, contextKey: string): Promise<AgentBucketStats | null>;
  putBucket(b: AgentBucketStats): Promise<void>;
  listBucketsForContext(contextKey: string): Promise<AgentBucketStats[]>;
}

// ── Helpers ──────────────────────────────────────────────────────────────
export function contextKey(c: AgentContext): string {
  return `${c.symbol}|${c.session}|${c.strategy}|${c.regimeId}`;
}

export const AGENT_PROMOTION_THRESHOLDS = {
  trustFullSampleCount: 30,           // weight reaches full trust at 30 samples
  emaAlpha: 0.15,
  weightMin: 0.0,
  weightMax: 2.0,
  weightNeutral: 1.0,
} as const;
