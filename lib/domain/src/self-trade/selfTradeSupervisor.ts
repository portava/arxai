// SelfTradeSupervisor — fleet-level resolution. PURE & deterministic.
//
// Takes every per-agent candidate decision from one evaluation cycle and
// applies, in order:
//   0. #18 DEDUPLICATION — candidates holding the SAME THESIS (same symbol,
//      side, time-horizon class, setup kind; similarity ≥ threshold over entry
//      geometry + evidence) are clustered; the highest-ranked member owns the
//      cluster and every other member is downgraded with conflictState
//      DUPLICATE. Each merge is journaled with its similarity breakdown.
//   1. Same-symbol SAME-SIDE contention — one-owner-per-trade: highest rank
//      owns, others are reassigned (SAME_SYMBOL_SAME_SIDE), unchanged.
//   2. Same-symbol OPPOSITE-SIDE conflicts — #19 TIGHTENED (2026-08-29):
//      ═══════════════════════════════════════════════════════════════════
//      BEHAVIOR CHANGE: rank no longer resolves a direction disagreement.
//      An opposite conflict is resolvable ONLY by a validated rule
//      (opportunity-spine/oppositeConflict.ts). When no rule resolves it,
//      EVERY actionable candidate on that symbol — the higher-ranked agent
//      included — is downgraded to WAIT. Previously the higher-ranked agent
//      traded and only the loser waited. Strictly conservative: this change
//      can only reduce approvals, never add one.
//      ═══════════════════════════════════════════════════════════════════
//      Conflicts are classified horizon-aware (SAME_HORIZON_OPPOSITE vs
//      CROSS_HORIZON_OPPOSITE) and journaled with every rule consulted.
//   3. Cross-symbol correlated concentration among surviving winners
//      (correlation.ts), unchanged.
//
// Decision-only — no dispatch. Never fabricates: every downgrade carries the
// factual reason and lands in the returned journals for persistence.

import type {
  DecisionCandidate,
  TradeSide,
} from "./selfTradeDecision.types.js";
import {
  evaluateCorrelationConflict,
  type CorrelationLookup,
} from "./correlation.js";
import { rankCandidates } from "./opportunityRanking.js";
import {
  clusterDuplicates,
  candidateDedupId,
  type DedupJournalEntry,
} from "../opportunity-spine/opportunityDedup.js";
import {
  resolveOppositeConflict,
  type OppositeConflictClass,
  type OppositeRuleVerdict,
} from "../opportunity-spine/oppositeConflict.js";

const ACTIONABLE = new Set(["APPROVED", "APPROVED_REDUCED", "PREPARE_ONLY"]);

export interface OppositeConflictJournalEntry {
  symbol: string;
  conflictClass: OppositeConflictClass;
  buyAgentKey: string;
  sellAgentKey: string;
  rulesConsulted: OppositeRuleVerdict[];
  resolution: "RULE_RESOLVED" | "ALL_WAIT";
  winnerAgentKey: string | null;
  reason: string;
}

export interface SupervisorResult {
  candidates: DecisionCandidate[];
  /** Symbols where a contention was resolved (for audit/notify). */
  contendedSymbols: string[];
  /** #18: every duplicate merge, with its similarity breakdown (journal this). */
  dedupJournal: DedupJournalEntry[];
  /** #19: every opposite-direction conflict verdict (journal this). */
  conflictJournal: OppositeConflictJournalEntry[];
}

export interface SupervisorOpts {
  measuredCorrelation?: CorrelationLookup;
  /** Evaluation clock for validated conflict rules (e.g. EXPIRED_OPPONENT).
   * Omitted ⇒ time-dependent rules honestly never apply. */
  nowMs?: number;
}

export function resolveSupervisor(
  candidates: DecisionCandidate[],
  opts?: SupervisorOpts,
): SupervisorResult {
  const out = candidates.map((c) => ({ ...c }));
  const contended = new Set<string>();
  const conflictJournal: OppositeConflictJournalEntry[] = [];

  const isActionable = (c: DecisionCandidate) =>
    ACTIONABLE.has(c.outcome) && c.side != null && c.thesis != null;

  // ── 0. #18 Deduplication (same-thesis clustering) ─────────────────────────
  const dedup = clusterDuplicates(out.filter(isActionable));
  for (const c of out) {
    if (!isActionable(c)) continue;
    const owner = dedup.duplicateOf.get(candidateDedupId(c));
    if (owner === undefined) continue;
    const entry = dedup.journal.find(
      (j) => j.duplicateAgentKey === c.agentKey && j.symbol === c.symbol,
    );
    c.outcome = "ASSIGNED_TO_ANOTHER";
    c.conflictState = "DUPLICATE";
    c.ownerAgentKey = owner;
    c.reason =
      entry?.reason ??
      `Duplicate of ${owner}'s ${c.symbol} ${c.side} thesis — merged (one owner per thesis).`;
    c.plannedAction = `Merged into ${owner}'s ${c.symbol} thesis (duplicate)`;
    contended.add(c.symbol);
  }

  // ── 1+2. Same-symbol contention ───────────────────────────────────────────
  const bySymbol = new Map<string, DecisionCandidate[]>();
  for (const c of out) {
    if (!isActionable(c)) continue;
    const arr = bySymbol.get(c.symbol) ?? [];
    arr.push(c);
    bySymbol.set(c.symbol, arr);
  }

  const winners: DecisionCandidate[] = [];
  for (const [symbol, group] of bySymbol) {
    const ranked = rankCandidates(group);
    const sides = new Set(ranked.map((c) => c.side));

    if (sides.size > 1) {
      // ── #19 opposite-direction conflict (tightened). ─────────────────────
      contended.add(symbol);
      const topBuy = ranked.find((c) => c.side === "BUY")!;
      const topSell = ranked.find((c) => c.side === "SELL")!;
      const verdict = resolveOppositeConflict(topBuy, topSell, { nowMs: opts?.nowMs });
      conflictJournal.push({
        symbol,
        conflictClass: verdict.conflictClass,
        buyAgentKey: topBuy.agentKey,
        sellAgentKey: topSell.agentKey,
        rulesConsulted: verdict.rulesConsulted,
        resolution: verdict.resolved ? "RULE_RESOLVED" : "ALL_WAIT",
        winnerAgentKey: verdict.winner?.agentKey ?? null,
        reason: verdict.reason,
      });

      if (!verdict.resolved) {
        // Nobody trades this symbol: rank is not authority over direction.
        for (const c of ranked) {
          c.outcome = "WAIT";
          c.conflictState = "SAME_SYMBOL_OPPOSITE";
          c.ownerAgentKey = null; // no owner — the trade itself is withheld
          c.reason = verdict.reason;
          c.plannedAction = `Wait — unresolved ${verdict.conflictClass} on ${symbol}`;
        }
        continue; // no winner advances to the correlation stage
      }

      // A validated rule resolved it: the winning SIDE proceeds normally.
      const winSide = verdict.winner!.side;
      const sideGroup = ranked.filter((c) => c.side === winSide);
      const sideWinner = sideGroup[0]!;
      sideWinner.ownerAgentKey = sideWinner.agentKey;
      winners.push(sideWinner);
      for (const loser of sideGroup.slice(1)) {
        loser.outcome = "ASSIGNED_TO_ANOTHER";
        loser.conflictState = "SAME_SYMBOL_SAME_SIDE";
        loser.ownerAgentKey = sideWinner.agentKey;
        loser.reason = `Trade assigned to higher-ranked agent ${sideWinner.agentKey}.`;
        loser.plannedAction = `Defer ${symbol} to ${sideWinner.agentKey}`;
      }
      for (const loser of ranked.filter((c) => c.side !== winSide)) {
        loser.outcome = "WAIT";
        loser.conflictState = "SAME_SYMBOL_OPPOSITE";
        loser.ownerAgentKey = sideWinner.agentKey;
        loser.reason = verdict.reason;
        loser.plannedAction = `Wait — ${symbol} conflict resolved by rule for ${sideWinner.agentKey}`;
      }
      continue;
    }

    // ── Same-side-only contention (unchanged one-owner-per-trade). ─────────
    const winner = ranked[0]!;
    winner.ownerAgentKey = winner.agentKey;
    winners.push(winner);
    if (ranked.length === 1) continue;
    contended.add(symbol);
    for (const loser of ranked.slice(1)) {
      loser.outcome = "ASSIGNED_TO_ANOTHER";
      loser.conflictState = "SAME_SYMBOL_SAME_SIDE";
      loser.ownerAgentKey = winner.agentKey;
      loser.reason = `Trade assigned to higher-ranked agent ${winner.agentKey}.`;
      loser.plannedAction = `Defer ${symbol} to ${winner.agentKey}`;
    }
  }

  // ── 3. Cross-symbol correlated concentration (among per-symbol winners) ────
  const rankedWinners = rankCandidates(winners);
  const accepted: DecisionCandidate[] = [];
  for (const w of rankedWinners) {
    let conflicted: DecisionCandidate | null = null;
    for (const a of accepted) {
      const v = evaluateCorrelationConflict({
        symbolA: w.symbol,
        sideA: w.side as TradeSide,
        symbolB: a.symbol,
        sideB: a.side as TradeSide,
        measured: opts?.measuredCorrelation,
      });
      if (v.conflict) {
        conflicted = a;
        break;
      }
    }
    if (conflicted) {
      w.outcome = "WATCH_ONLY";
      w.conflictState = "CORRELATED";
      w.ownerAgentKey = conflicted.agentKey;
      w.reason = `Correlated exposure with ${conflicted.symbol} (owned by ${conflicted.agentKey}); avoiding concentration.`;
      w.plannedAction = `Monitor ${w.symbol} (correlated with ${conflicted.symbol})`;
      contended.add(w.symbol);
    } else {
      accepted.push(w);
    }
  }

  return {
    candidates: out,
    contendedSymbols: [...contended],
    dedupJournal: dedup.journal,
    conflictJournal,
  };
}
