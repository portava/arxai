// Opportunity Conflict Resolver (#19) — validated rules for opposite-direction
// conflicts + horizon-aware conflict classes. PURE + deterministic.
//
// ════════════════════════════════════════════════════════════════════════════
// BEHAVIOR CHANGE (2026-08-29, build/opportunity-spine) — TIGHTENING.
//
// BEFORE: when two agents wanted OPPOSITE sides of one symbol, the supervisor
// let the HIGHER-RANKED agent trade and only the loser stood down (WAIT).
//
// AFTER: rank is NOT authority to resolve a direction disagreement. An
// opposite-direction conflict is resolvable ONLY by a VALIDATED RULE from the
// registry below. When no rule resolves it, EVERY candidate on that symbol is
// downgraded to WAIT — nobody trades. This enforces the spec's authority
// boundary: preferring WAIT over letting the higher-ranked agent trade is a
// strictly conservative change (fewer approvals, never more).
// ════════════════════════════════════════════════════════════════════════════
//
// Horizon-aware conflict classes: a scalp-BUY vs swing-SELL disagreement is a
// materially different situation from two intraday agents disagreeing head-on.
// The class is recorded in every verdict/journal entry. NOTE: cross-horizon is
// classification only — it is deliberately NOT a validated resolution rule
// (opposite exposure on one netted symbol still nets); relaxing that requires
// an owner ruling, not code drift.

import type { DecisionCandidate } from "../self-trade/selfTradeDecision.types.js";
import { timeframeHorizonClass } from "./opportunityStateMachine.js";

export type OppositeConflictClass = "SAME_HORIZON_OPPOSITE" | "CROSS_HORIZON_OPPOSITE";

export function classifyOppositeConflict(
  a: DecisionCandidate,
  b: DecisionCandidate,
): OppositeConflictClass {
  return timeframeHorizonClass(a.timeframe) === timeframeHorizonClass(b.timeframe)
    ? "SAME_HORIZON_OPPOSITE"
    : "CROSS_HORIZON_OPPOSITE";
}

// ── Validated rule registry ──────────────────────────────────────────────────
// A rule may resolve a conflict ONLY on hard, non-rank evidence. Every rule
// consulted is journaled whether or not it applied.

export interface OppositeRuleVerdict {
  ruleId: string;
  applied: boolean;
  /** When applied: the side that may proceed. */
  winner: DecisionCandidate | null;
  loser: DecisionCandidate | null;
  detail: string;
}

export interface OppositeConflictVerdict {
  conflictClass: OppositeConflictClass;
  resolved: boolean;
  winner: DecisionCandidate | null;
  loser: DecisionCandidate | null;
  rulesConsulted: OppositeRuleVerdict[];
  reason: string;
}

/** Rule 1 — EXPIRED_OPPONENT: one thesis has already aged out (setupExpiresAt
 * in the past at evaluation time). Trading against dead evidence is not a live
 * disagreement; the still-valid thesis proceeds. Requires an injected clock —
 * without nowMs the rule honestly never applies. */
function ruleExpiredOpponent(
  a: DecisionCandidate,
  b: DecisionCandidate,
  nowMs: number | undefined,
): OppositeRuleVerdict {
  const base = { ruleId: "EXPIRED_OPPONENT", winner: null, loser: null };
  if (nowMs == null) {
    return { ...base, applied: false, detail: "No evaluation clock supplied — rule not applied." };
  }
  const expired = (c: DecisionCandidate): boolean => {
    if (!c.setupExpiresAt) return false;
    const t = Date.parse(c.setupExpiresAt);
    return Number.isFinite(t) && t <= nowMs;
  };
  const aDead = expired(a);
  const bDead = expired(b);
  if (aDead && !bDead) {
    return { ruleId: "EXPIRED_OPPONENT", applied: true, winner: b, loser: a, detail: `${a.agentKey}'s setup expired at ${a.setupExpiresAt}; ${b.agentKey}'s thesis is still live.` };
  }
  if (bDead && !aDead) {
    return { ruleId: "EXPIRED_OPPONENT", applied: true, winner: a, loser: b, detail: `${b.agentKey}'s setup expired at ${b.setupExpiresAt}; ${a.agentKey}'s thesis is still live.` };
  }
  return {
    ...base,
    applied: false,
    detail: aDead && bDead ? "Both setups expired — nothing to resolve toward." : "Neither setup has expired.",
  };
}

/**
 * Resolve an opposite-direction conflict between the strongest candidate of
 * each side. Rank is deliberately NOT consulted. Unresolved ⇒ resolved=false
 * and the caller must downgrade BOTH sides to WAIT.
 */
export function resolveOppositeConflict(
  a: DecisionCandidate,
  b: DecisionCandidate,
  opts?: { nowMs?: number },
): OppositeConflictVerdict {
  const conflictClass = classifyOppositeConflict(a, b);
  const rulesConsulted: OppositeRuleVerdict[] = [];

  const r1 = ruleExpiredOpponent(a, b, opts?.nowMs);
  rulesConsulted.push(r1);
  if (r1.applied && r1.winner && r1.loser) {
    return {
      conflictClass,
      resolved: true,
      winner: r1.winner,
      loser: r1.loser,
      rulesConsulted,
      reason: `Opposite-direction conflict on ${a.symbol} (${conflictClass}) resolved by validated rule ${r1.ruleId}: ${r1.detail}`,
    };
  }

  return {
    conflictClass,
    resolved: false,
    winner: null,
    loser: null,
    rulesConsulted,
    reason:
      `Unresolved opposite-direction conflict on ${a.symbol} (${conflictClass}): ` +
      `${a.agentKey} wants ${a.side}, ${b.agentKey} wants ${b.side}, and no validated rule resolves it. ` +
      `Preferring WAIT for all parties over rank authority (tightened 2026-08-29).`,
  };
}
