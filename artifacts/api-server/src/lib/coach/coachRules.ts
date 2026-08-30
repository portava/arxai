// AI Coach honesty helpers — rule derivation and the calibration note.
//
// Kept in its own module (no database imports) so the derivation can be unit
// tested in the offline CI lane.

// ── AI Coach honesty helpers ────────────────────────────────────────────────

/** Fixed engine rules. Identical for every caller — labelled as such. */
export const GENERAL_COACH_RULES = [
  "Require setupQualityScore >= 70 before generating a card.",
  "Reject trades when marketBias is 'choppy'.",
  "Block any entry with riskRewardRatio < 1.5.",
] as const;

export const CONFIDENCE_NOT_MEASURED_NOTE =
  "Confidence calibration is not measured. Journal entries do not record the confidence " +
  "you had going into a trade, so there is nothing to compare with outcomes.";

export interface DerivedRuleChange {
  rule: string;
  /** The caller's own data this rule came from. Never a constant. */
  evidence: string;
}

/**
 * Rule suggestions derived from THIS caller's journal distribution. Returns an
 * empty array when the journal does not support any — an empty list is the
 * correct answer, not a reason to fall back to generic copy.
 */
export function deriveRuleChanges(input: {
  byMistake: Map<string, number>;
  byStrategy: Map<string, number>;
  bySymbol: Map<string, number>;
  total: number;
}): DerivedRuleChange[] {
  const { byMistake, byStrategy, bySymbol, total } = input;
  const out: DerivedRuleChange[] = [];

  const topMistake = Array.from(byMistake.entries()).sort((a, b) => b[1] - a[1])[0];
  if (topMistake && topMistake[1] >= 2) {
    out.push({
      rule: `Add a pre-trade check that blocks "${topMistake[0]}".`,
      evidence: `You tagged "${topMistake[0]}" on ${topMistake[1]} of ${total} journalled trades.`,
    });
  }

  const worstStrategy = Array.from(byStrategy.entries()).sort((a, b) => a[1] - b[1])[0];
  if (worstStrategy && worstStrategy[1] < 0) {
    out.push({
      rule: `Stop taking "${worstStrategy[0]}" setups until you can show it working in replay.`,
      evidence: `"${worstStrategy[0]}" is net ${worstStrategy[1].toFixed(2)} across your journal.`,
    });
  }

  const worstSymbol = Array.from(bySymbol.entries()).sort((a, b) => a[1] - b[1])[0];
  if (worstSymbol && worstSymbol[1] < 0) {
    out.push({
      rule: `Drop ${worstSymbol[0]} from your watchlist for now.`,
      evidence: `${worstSymbol[0]} is net ${worstSymbol[1].toFixed(2)} across your journal.`,
    });
  }

  return out;
}
