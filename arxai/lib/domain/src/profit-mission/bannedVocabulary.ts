// Profit Mission — centralized banned-vocabulary guard for mission copy.
//
// Mission planning surfaces (feasibility explanations, probability disclaimers,
// any assistant/UI copy generated about a mission) must NEVER promise profit or
// certainty. This is the single source of truth for the forbidden phrases plus
// the preferred replacements, reused by the engines, the API layer, and tests.
//
// This is a MARKETING / COMPLIANCE guard (no "guaranteed profit" language). It
// is intentionally separate from lib/domain/src/security/userCopySafety.ts,
// which scrubs internal system leaks (secrets, tokens, API paths).

/** Phrases that must never appear in mission-facing copy. */
export const MISSION_BANNED_PHRASES: readonly string[] = [
  "guaranteed",
  "guarantee",
  "perfect",
  "risk-free",
  "risk free",
  "riskless",
  "can't lose",
  "cant lose",
  "cannot lose",
  "no risk",
  "zero risk",
  "certain profit",
  "certain return",
  "sure thing",
  "sure profit",
  "always wins",
  "always win",
  "never lose",
  "100% win",
  "100% profit",
];

/** Preferred vocabulary mission copy SHOULD lean on instead. */
export const MISSION_PREFERRED_VOCABULARY: readonly string[] = [
  "target",
  "probability",
  "feasibility",
  "expected return",
  "pace",
  "confidence",
  "possible loss",
  "estimate",
];

export interface BannedVocabularyResult {
  ok: boolean;
  /** Lower-cased matched phrases found in the copy. */
  violations: string[];
}

/**
 * Check a single string for banned mission vocabulary. Pure; case-insensitive.
 * Returns every distinct banned phrase present.
 */
export function checkMissionCopy(text: string | null | undefined): BannedVocabularyResult {
  if (!text) return { ok: true, violations: [] };
  const haystack = text.toLowerCase();
  const violations: string[] = [];
  for (const phrase of MISSION_BANNED_PHRASES) {
    if (haystack.includes(phrase) && !violations.includes(phrase)) {
      violations.push(phrase);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Check many copy fragments at once (e.g. a verdict's explanation + warnings).
 * Ignores non-string values so it is safe to spread arbitrary objects' values.
 */
export function checkMissionCopyDeep(values: readonly unknown[]): BannedVocabularyResult {
  const violations: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const r = checkMissionCopy(v);
    for (const phrase of r.violations) {
      if (!violations.includes(phrase)) violations.push(phrase);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Throwing assertion for development / tests / CI. Production copy is authored
 * to pass; this catches regressions where new copy sneaks a banned phrase in.
 */
export function assertMissionCopySafe(text: string, where = "mission copy"): void {
  const r = checkMissionCopy(text);
  if (!r.ok) {
    throw new Error(
      `Banned mission vocabulary in ${where}: ${r.violations.join(", ")}`,
    );
  }
}
