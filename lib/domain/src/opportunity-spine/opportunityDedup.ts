// Opportunity Deduplication (#18) — clustering by time-horizon, evidence and
// thesis similarity. PURE + deterministic.
//
// Prior art collapsed duplicates only by symbol contention and correlation
// (selfTradeSupervisor + correlation.ts). This module recognises when two
// agents hold THE SAME THESIS — same symbol, same side, same time-horizon
// class, same setup kind, overlapping entry/stop geometry, overlapping
// evidence — and merges them into one cluster with one owner. Cluster losers
// finally receive the declared-but-never-assigned DUPLICATE conflict state
// (selfTradeDecision.types.ts / SELF_TRADE_CONFLICT_STATES), and every merge
// is journaled with its full similarity breakdown as the reason.
//
// HONESTY: similarity is computed only from evidence both candidates actually
// carry. Missing geometry contributes ZERO similarity — we never fabricate
// closeness. Different horizon classes are NEVER duplicates (a scalp and a
// swing on the same symbol/side are different trades by construction).

import type { DecisionCandidate } from "../self-trade/selfTradeDecision.types.js";
import { timeframeHorizonClass } from "./opportunityStateMachine.js";

// A merge requires the full identity gate (symbol+side+horizon+setup) AND a
// similarity score at or above this threshold.
export const DUPLICATE_SIMILARITY_THRESHOLD = 60;

export interface ThesisSimilarity {
  /** 0–100 composite. */
  score: number;
  components: {
    /** 35 when the classified setup kinds match (gate — also required). */
    setupMatch: number;
    /** 0–25: entry-zone overlap ratio (0 when either zone is missing). */
    entryZoneOverlap: number;
    /** 0–15: stop-loss proximity relative to price scale. */
    stopProximity: number;
    /** 0–25: Jaccard overlap of the whyNow evidence lines. */
    evidenceOverlap: number;
  };
  reasons: string[];
}

function overlapRatio(
  a: { from: number; to: number },
  b: { from: number; to: number },
): number {
  const aLo = Math.min(a.from, a.to);
  const aHi = Math.max(a.from, a.to);
  const bLo = Math.min(b.from, b.to);
  const bHi = Math.max(b.from, b.to);
  const inter = Math.min(aHi, bHi) - Math.max(aLo, bLo);
  const union = Math.max(aHi, bHi) - Math.min(aLo, bLo);
  if (union <= 0) return aLo === bLo && aHi === bHi ? 1 : 0;
  return inter > 0 ? inter / union : 0;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const sb = new Set(b.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** PURE thesis similarity between two candidates (order-independent). */
export function evaluateThesisSimilarity(
  a: DecisionCandidate,
  b: DecisionCandidate,
): ThesisSimilarity {
  const reasons: string[] = [];
  const setupMatch = a.setup !== "NONE" && a.setup === b.setup ? 35 : 0;
  reasons.push(
    setupMatch > 0 ? `Same setup kind (${a.setup}).` : `Different setup kinds (${a.setup} vs ${b.setup}).`,
  );

  let entryZoneOverlap = 0;
  const za = a.thesis?.entryZone ?? null;
  const zb = b.thesis?.entryZone ?? null;
  if (za && zb) {
    const r = overlapRatio(za, zb);
    entryZoneOverlap = Math.round(r * 25);
    reasons.push(`Entry zones overlap ${Math.round(r * 100)}%.`);
  } else {
    reasons.push("Entry-zone overlap unknown (a zone is missing) — contributes 0.");
  }

  let stopProximity = 0;
  const sa = a.thesis?.stopLoss;
  const sb = b.thesis?.stopLoss;
  if (sa != null && sb != null && Number.isFinite(sa) && Number.isFinite(sb)) {
    const scale = Math.max(Math.abs(sa), Math.abs(sb));
    if (scale > 0) {
      const relDiff = Math.abs(sa - sb) / scale;
      // ≤0.05% apart = full credit; linearly to 0 at 0.5% apart.
      const t = Math.max(0, Math.min(1, (0.005 - relDiff) / (0.005 - 0.0005)));
      stopProximity = Math.round(t * 15);
      reasons.push(`Stops ${(relDiff * 100).toFixed(3)}% apart.`);
    }
  } else {
    reasons.push("Stop proximity unknown (a stop is missing) — contributes 0.");
  }

  const evidenceJaccard = jaccard(a.thesis?.whyNow ?? [], b.thesis?.whyNow ?? []);
  const evidenceOverlap = Math.round(evidenceJaccard * 25);
  reasons.push(`Evidence overlap ${Math.round(evidenceJaccard * 100)}% (whyNow lines).`);

  const score = setupMatch + entryZoneOverlap + stopProximity + evidenceOverlap;
  return {
    score,
    components: { setupMatch, entryZoneOverlap, stopProximity, evidenceOverlap },
    reasons,
  };
}

export interface DedupJournalEntry {
  symbol: string;
  side: "BUY" | "SELL";
  horizonClass: string;
  setup: string;
  ownerAgentKey: string;
  duplicateAgentKey: string;
  similarity: ThesisSimilarity;
  reason: string;
}

export interface DedupCluster {
  symbol: string;
  side: "BUY" | "SELL";
  horizonClass: string;
  setup: string;
  /** Highest-ranked member — keeps its own decision. */
  ownerAgentKey: string;
  memberAgentKeys: string[];
}

export interface DedupResult {
  clusters: DedupCluster[];
  journal: DedupJournalEntry[];
  /** agentKey|symbol|timeframe → owner agentKey, for every merged loser. */
  duplicateOf: Map<string, string>;
}

export function candidateDedupId(c: DecisionCandidate): string {
  return `${c.agentKey}|${c.symbol}|${c.timeframe}`;
}

/**
 * Cluster actionable candidates that hold the same thesis. Callers pass only
 * candidates that are actionable (approved-class, side + thesis present) and
 * pre-ranked semantics are preserved: the highest rankScore in a cluster owns
 * it (ties broken by agentId for determinism, matching rankCandidates).
 */
export function clusterDuplicates(candidates: DecisionCandidate[]): DedupResult {
  const groups = new Map<string, DecisionCandidate[]>();
  for (const c of candidates) {
    if (c.side == null || c.setup === "NONE") continue;
    const key = `${c.symbol}|${c.side}|${timeframeHorizonClass(c.timeframe)}|${c.setup}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const clusters: DedupCluster[] = [];
  const journal: DedupJournalEntry[] = [];
  const duplicateOf = new Map<string, string>();

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) =>
      b.rankScore !== a.rankScore ? b.rankScore - a.rankScore : a.agentId - b.agentId,
    );
    const owner = ranked[0]!;
    const horizonClass = timeframeHorizonClass(owner.timeframe);
    const members: string[] = [owner.agentKey];
    for (const other of ranked.slice(1)) {
      const sim = evaluateThesisSimilarity(owner, other);
      if (sim.components.setupMatch === 0 || sim.score < DUPLICATE_SIMILARITY_THRESHOLD) {
        continue; // same identity gate but theses differ enough — NOT a duplicate
      }
      members.push(other.agentKey);
      duplicateOf.set(candidateDedupId(other), owner.agentKey);
      journal.push({
        symbol: owner.symbol,
        side: owner.side as "BUY" | "SELL",
        horizonClass,
        setup: owner.setup,
        ownerAgentKey: owner.agentKey,
        duplicateAgentKey: other.agentKey,
        similarity: sim,
        reason:
          `Duplicate thesis: ${other.agentKey} matches ${owner.agentKey} on ` +
          `${owner.symbol} ${owner.side} ${owner.setup} (${horizonClass}) — ` +
          `similarity ${sim.score}/100 ` +
          `(setup ${sim.components.setupMatch}, zone ${sim.components.entryZoneOverlap}, ` +
          `stop ${sim.components.stopProximity}, evidence ${sim.components.evidenceOverlap}).`,
      });
    }
    if (members.length > 1) {
      clusters.push({
        symbol: owner.symbol,
        side: owner.side as "BUY" | "SELL",
        horizonClass,
        setup: owner.setup,
        ownerAgentKey: owner.agentKey,
        memberAgentKeys: members,
      });
    }
  }

  return { clusters, journal, duplicateOf };
}
