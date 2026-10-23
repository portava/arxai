// Build I — Canonical mistake / strength tag vocabulary. Pure data.

export const MISTAKE_TAGS = [
  "EARLY_ENTRY",
  "LATE_ENTRY",
  "REVENGE_TRADE",
  "FOMO_ENTRY",
  "OVERSIZED_POSITION",
  "POOR_STOP_LOSS",
  "MOVED_STOP_LOSS",
  "EXITED_TOO_EARLY",
  "HELD_TOO_LONG",
  "IGNORED_MARKET_CONDITION",
  "STRATEGY_MISMATCH",
  "OVERTRADING",
] as const;
export type MistakeTag = typeof MISTAKE_TAGS[number];

export const STRENGTH_TAGS = [
  "WAITED_FOR_CONFIRMATION",
  "GOOD_RISK_CONTROL",
  "FOLLOWED_PLAN",
  "STRONG_ENTRY",
  "STRONG_EXIT",
  "AVOIDED_BAD_TRADE",
  "MANAGED_EMOTIONS",
  "RESPECTED_STOP_LOSS",
  "TOOK_VALID_SETUP",
  "PRACTICED_PATIENCE",
] as const;
export type StrengthTag = typeof STRENGTH_TAGS[number];

export const EMOTIONAL_STATES = [
  "CALM", "FOMO", "FEAR", "GREED", "REVENGE", "DISCIPLINED", "UNCERTAIN",
] as const;
export type EmotionalState = typeof EMOTIONAL_STATES[number];

/**
 * Score axes each tag affects, with delta sign + magnitude (caller scales).
 * NEGATIVE = penalty, POSITIVE = improvement.
 */
export interface ScoreImpact {
  discipline?: number;
  execution?: number;
  emotionalControl?: number;
  consistency?: number;
}

export const MISTAKE_IMPACT: Record<MistakeTag, ScoreImpact> = {
  EARLY_ENTRY:               { execution: -2 },
  LATE_ENTRY:                { execution: -2 },
  REVENGE_TRADE:             { emotionalControl: -4, discipline: -1 },
  FOMO_ENTRY:                { emotionalControl: -3, discipline: -1 },
  OVERSIZED_POSITION:        { discipline: -3 },
  POOR_STOP_LOSS:            { discipline: -2 },
  MOVED_STOP_LOSS:           { discipline: -4 },
  EXITED_TOO_EARLY:          { execution: -2, emotionalControl: -1 },
  HELD_TOO_LONG:             { execution: -2 },
  IGNORED_MARKET_CONDITION:  { discipline: -2, execution: -1 },
  STRATEGY_MISMATCH:         { consistency: -3 },
  OVERTRADING:               { discipline: -3, emotionalControl: -2 },
};

export const STRENGTH_IMPACT: Record<StrengthTag, ScoreImpact> = {
  WAITED_FOR_CONFIRMATION:   { execution: +2, discipline: +1 },
  GOOD_RISK_CONTROL:         { discipline: +3 },
  FOLLOWED_PLAN:             { consistency: +3, discipline: +1 },
  STRONG_ENTRY:              { execution: +2 },
  STRONG_EXIT:               { execution: +2 },
  AVOIDED_BAD_TRADE:         { discipline: +3 },
  MANAGED_EMOTIONS:          { emotionalControl: +3 },
  RESPECTED_STOP_LOSS:       { discipline: +2 },
  TOOK_VALID_SETUP:          { consistency: +2 },
  PRACTICED_PATIENCE:        { emotionalControl: +2, discipline: +1 },
};

/** Validate a list of mistake tags, returning the unknown ones. */
export function unknownMistakeTags(tags: string[]): string[] {
  const set = new Set<string>(MISTAKE_TAGS);
  return tags.filter((t) => !set.has(t));
}
export function unknownStrengthTags(tags: string[]): string[] {
  const set = new Set<string>(STRENGTH_TAGS);
  return tags.filter((t) => !set.has(t));
}
