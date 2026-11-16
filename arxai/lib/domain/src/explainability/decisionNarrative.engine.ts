import {
  type DecisionNarrative, type DecisionVerdict, type Fact, type NarrativeStyle,
  toFactLine,
} from "./explainability.types";

// ═══════════════════════════════════════════════════════════════════════════
// Decision Narrative — explains the chosen verdict (APPROVED/WAITED/etc.)
// in plain English. Pure.
// ═══════════════════════════════════════════════════════════════════════════

const HEADLINES: Record<DecisionVerdict, string> = {
  APPROVED:      "Trade approved.",
  WAITED:        "Holding off — better setup expected soon.",
  REDUCED_SIZE:  "Trade approved at reduced size.",
  BLOCKED:       "Trade blocked.",
  RECOVERY_MODE: "Recovery mode active.",
  COOLDOWN:      "Cooldown active — no new entries.",
  DELAYED:       "Trade delayed pending better execution conditions.",
};

export interface DecisionInput {
  verdict: DecisionVerdict;
  primaryReason: string;
  supportingReasons?: ReadonlyArray<string>;
  blockers?: ReadonlyArray<string>;
  facts?: ReadonlyArray<Fact>;
  style?: NarrativeStyle;
}

export function buildDecisionNarrative(input: DecisionInput): DecisionNarrative {
  const style = input.style ?? "STANDARD";
  const headline = HEADLINES[input.verdict];
  const paragraphs: string[] = [`${input.primaryReason}.`];

  if (input.blockers?.length) {
    paragraphs.push(`Blockers (${input.blockers.length}): ${input.blockers.slice(0, style === "TERSE" ? 1 : 3).join("; ")}.`);
  }

  const bullets: string[] = [];
  for (const r of (input.supportingReasons ?? []).slice(0, style === "DETAILED" ? 8 : 3)) {
    bullets.push(`• ${r}`);
  }
  for (const f of (input.facts ?? []).slice(0, style === "DETAILED" ? 6 : 3)) {
    bullets.push(`· ${toFactLine(f)}`);
  }

  return { verdict: input.verdict, narrative: { headline, paragraphs, bullets, style } };
}
