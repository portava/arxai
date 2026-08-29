// Economic Truth Hierarchy (#31) — the ONE deterministic precedence order for
// economic facts (cash, balances, fees, P&L), declared as a safety contract.
//
// WHY THIS EXISTS: precedence was already encoded per-domain (positionTruth,
// approvalTicket resolveUnresolved, canonicalState, composeVerdict) but no
// single contract covered ECONOMIC sources — so a reconciliation pass had no
// pinned answer to "the broker statement says X, our local fill record says Y,
// which wins?". This module is that answer, and nothing else: it is pure,
// browser-safe, imports nothing, and CANNOT move money, adjust a ledger, or
// resolve a contradiction silently — it only RANKS sources and REPORTS
// disagreements for journaling.
//
// THE ORDER (higher outranks lower, deterministic, never data-dependent):
//   1. BROKER_STATEMENT — a broker-issued statement/snapshot of record
//      (account balance sync, daily statement). The venue's own book.
//   2. BROKER_EVENT     — a broker-confirmed event (fill result with ticket,
//      venue contract ref). Venue truth about one event.
//   3. LOCAL_EXECUTION  — ARX's own durable execution records (command rows,
//      last-synced floating P/L). Honest, but locally derived.
//   4. DERIVED          — analytics computed from other data. Never evidence.
//
// GOVERNING INVARIANT: when sources disagree, the higher source wins AND the
// disagreement is journaled — a contradiction is surfaced, never swallowed.
// When EQUALLY-ranked sources disagree, nothing outranks anything: the result
// is honestly UNRESOLVED (winner = null). Falsely-certain tie-breaking is the
// exact failure mode this contract exists to prevent.

export const TRUTH_SOURCES = [
  "BROKER_STATEMENT",
  "BROKER_EVENT",
  "LOCAL_EXECUTION",
  "DERIVED",
] as const;

export type TruthSource = (typeof TRUTH_SOURCES)[number];

export function isTruthSource(v: unknown): v is TruthSource {
  return typeof v === "string" && (TRUTH_SOURCES as readonly string[]).includes(v);
}

/**
 * Rank of a source: LOWER number = HIGHER authority (index in TRUTH_SOURCES).
 * An unknown source string fails CLOSED to the bottom of the hierarchy —
 * strictly below DERIVED — so an unrecognised label can never outrank real
 * evidence.
 */
export function truthRank(source: string): number {
  const i = (TRUTH_SOURCES as readonly string[]).indexOf(source);
  return i === -1 ? TRUTH_SOURCES.length : i;
}

/** Does `a` strictly outrank `b`? Deterministic; both unknown → false. */
export function outranks(a: string, b: string): boolean {
  return truthRank(a) < truthRank(b);
}

/** One source's claim about the same economic fact (opaque value, compared by `key`). */
export interface TruthClaim {
  source: TruthSource;
  /** Canonical comparison key for the claimed value (e.g. minor-units string). */
  valueKey: string;
  /** Free-form description carried into the contradiction journal. */
  detail?: string;
}

export interface TruthContradiction {
  /** The claim that won (or would have won) the disagreement. */
  prevailing: TruthClaim;
  /** The claim it disagrees with. */
  overruled: TruthClaim;
  /** True when the two claims are EQUALLY ranked — nothing prevails. */
  unresolvable: boolean;
}

export interface TruthResolution {
  /**
   * The winning claim, or null when the top rank is contested by claims that
   * DISAGREE with each other (fail-closed: no winner is fabricated).
   */
  winner: TruthClaim | null;
  /**
   * Every pairwise disagreement found. NON-EMPTY whenever sources disagreed —
   * the consumer MUST journal these; this module cannot and does not.
   */
  contradictions: TruthContradiction[];
}

/**
 * Resolve one economic fact from multiple sources' claims.
 *
 * Deterministic: depends only on the claims' sources and valueKeys, never on
 * arrival order (claims are sorted by rank, then source name, then valueKey
 * before comparison). Zero claims → winner null, no contradictions (honest
 * "nothing is known", not an error).
 */
export function resolveTruthConflict(claims: readonly TruthClaim[]): TruthResolution {
  if (claims.length === 0) return { winner: null, contradictions: [] };

  const sorted = [...claims].sort((a, b) =>
    truthRank(a.source) - truthRank(b.source)
    || a.source.localeCompare(b.source)
    || a.valueKey.localeCompare(b.valueKey));

  const top = sorted[0]!;
  const topRank = truthRank(top.source);
  const contradictions: TruthContradiction[] = [];

  // Equal-rank disagreement at the top → unresolvable, winner is null.
  let topContested = false;
  for (const c of sorted.slice(1)) {
    if (c.valueKey === top.valueKey) continue; // agreement is not a contradiction
    const equalRank = truthRank(c.source) === topRank;
    if (equalRank) topContested = true;
    contradictions.push({ prevailing: top, overruled: c, unresolvable: equalRank });
  }

  return { winner: topContested ? null : top, contradictions };
}
