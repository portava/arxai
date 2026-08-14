// falseBlockTracker — flag agents that voted AGAINST / STRONG_AGAINST on a
// trade that, when replayed or skipped, would have WON. These are the agents
// most responsible for missed opportunities.

import type { AgentPerformanceRecord } from "./agentPerformance.types";

export interface FalseBlock {
  agentId: string;
  agentName: string;
  decisionId: string;
  confidence01: number;
  outcome: "BLOCKED_WRONGLY";
  reason: string;
}

const BLOCKING_VOTES = new Set(["STRONG_AGAINST", "AGAINST"]);
const MIN_CONFIDENCE = 0.55;

export function trackFalseBlocks(
  records: ReadonlyArray<AgentPerformanceRecord>,
): FalseBlock[] {
  return records
    .filter(r => r.outcome === "BLOCKED_WRONGLY"
      && BLOCKING_VOTES.has(r.vote)
      && r.confidence01 >= MIN_CONFIDENCE)
    .map(r => ({
      agentId: r.agentId, agentName: r.agentName,
      decisionId: r.decisionId,
      confidence01: r.confidence01, outcome: "BLOCKED_WRONGLY",
      reason: `${r.agentName} voted ${r.vote} @ ${(r.confidence01 * 100).toFixed(0)}% and blocked a would-be winner`,
    }));
}

/** Roll-up: per-agent false-block rate over the supplied window. */
export function falseBlockRate(
  records: ReadonlyArray<AgentPerformanceRecord>,
): Record<string, { blocks: number; falseBlocks: number; rate01: number }> {
  const out: Record<string, { blocks: number; falseBlocks: number; rate01: number }> = {};
  for (const r of records) {
    if (!BLOCKING_VOTES.has(r.vote)) continue;
    const slot = (out[r.agentId] ??= { blocks: 0, falseBlocks: 0, rate01: 0 });
    slot.blocks += 1;
    if (r.outcome === "BLOCKED_WRONGLY" && r.confidence01 >= MIN_CONFIDENCE) slot.falseBlocks += 1;
  }
  for (const k of Object.keys(out)) {
    const s = out[k]!;
    s.rate01 = s.blocks === 0 ? 0 : +(s.falseBlocks / s.blocks).toFixed(4);
  }
  return out;
}
