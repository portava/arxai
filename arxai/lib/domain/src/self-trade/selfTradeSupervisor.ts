// SelfTradeSupervisor — fleet-level resolution. PURE & deterministic.
//
// Takes every per-agent candidate decision from one evaluation cycle and applies
// one-owner-per-trade: when two agents contend for the same symbol (or stacked
// correlated exposure), the highest-ranked agent owns the trade and the others
// are reassigned/downgraded with an honest reason. Decision-only — no dispatch.

import type {
  DecisionCandidate,
  TradeSide,
} from "./selfTradeDecision.types.js";
import {
  evaluateCorrelationConflict,
  type CorrelationLookup,
} from "./correlation.js";
import { rankCandidates } from "./opportunityRanking.js";

const ACTIONABLE = new Set(["APPROVED", "APPROVED_REDUCED", "PREPARE_ONLY"]);

export interface SupervisorResult {
  candidates: DecisionCandidate[];
  /** Symbols where a contention was resolved (for audit/notify). */
  contendedSymbols: string[];
}

export function resolveSupervisor(
  candidates: DecisionCandidate[],
  opts?: { measuredCorrelation?: CorrelationLookup },
): SupervisorResult {
  const out = candidates.map((c) => ({ ...c }));
  const contended = new Set<string>();

  const isActionable = (c: DecisionCandidate) =>
    ACTIONABLE.has(c.outcome) && c.side != null && c.thesis != null;

  // ── 1. Same-symbol contention ─────────────────────────────────────────────
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
    const winner = ranked[0]!;
    winner.ownerAgentKey = winner.agentKey;
    winners.push(winner);
    if (ranked.length === 1) continue;
    contended.add(symbol);
    for (const loser of ranked.slice(1)) {
      if (loser.side === winner.side) {
        loser.outcome = "ASSIGNED_TO_ANOTHER";
        loser.conflictState = "SAME_SYMBOL_SAME_SIDE";
        loser.ownerAgentKey = winner.agentKey;
        loser.reason = `Trade assigned to higher-ranked agent ${winner.agentKey}.`;
        loser.plannedAction = `Defer ${symbol} to ${winner.agentKey}`;
      } else {
        loser.outcome = "WAIT";
        loser.conflictState = "SAME_SYMBOL_OPPOSITE";
        loser.ownerAgentKey = winner.agentKey;
        loser.reason = `Opposing ${symbol} position owned by ${winner.agentKey}; standing down.`;
        loser.plannedAction = `Wait — ${symbol} owned by ${winner.agentKey}`;
      }
    }
  }

  // ── 2. Cross-symbol correlated concentration (among per-symbol winners) ────
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

  return { candidates: out, contendedSymbols: [...contended] };
}
