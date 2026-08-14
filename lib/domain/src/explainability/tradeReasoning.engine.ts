import {
  type TradeReasoning, type NarrativeStyle, type Fact, toFactLine,
} from "./explainability.types";

// ═══════════════════════════════════════════════════════════════════════════
// Trade Reasoning — structured "why we want it / why not yet / blockers"
// for a specific candidate trade. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface TradeReasoningInput {
  symbolId: string;
  side: "BUY" | "SELL";
  why: ReadonlyArray<string>;
  whyNotYet?: ReadonlyArray<string>;
  blockers?: ReadonlyArray<string>;
  facts?: ReadonlyArray<Fact>;
  style?: NarrativeStyle;
}

export function buildTradeReasoning(input: TradeReasoningInput): TradeReasoning {
  const style = input.style ?? "STANDARD";
  const blockers = [...(input.blockers ?? [])];
  const whyNotYet = [...(input.whyNotYet ?? [])];

  const headline = blockers.length
    ? `${input.side} ${input.symbolId} — blocked.`
    : whyNotYet.length
    ? `${input.side} ${input.symbolId} — waiting on conditions.`
    : `${input.side} ${input.symbolId} — ready to take.`;

  const paragraphs: string[] = [];
  if (input.why.length) paragraphs.push(`Reasons to take: ${input.why.slice(0, style === "TERSE" ? 2 : 4).join("; ")}.`);
  if (whyNotYet.length) paragraphs.push(`Conditions still pending: ${whyNotYet.slice(0, 3).join("; ")}.`);
  if (blockers.length)  paragraphs.push(`Blocked by: ${blockers.slice(0, 3).join("; ")}.`);

  const bullets: string[] = [];
  for (const f of (input.facts ?? []).slice(0, style === "DETAILED" ? 6 : 3)) {
    bullets.push(`· ${toFactLine(f)}`);
  }

  return {
    symbolId: input.symbolId, side: input.side,
    why: [...input.why], whyNotYet, blockers,
    narrative: { headline, paragraphs, bullets, style },
  };
}
