// Engine agreement — the scanner header's label for the composed verdict's
// STAGE, which is an agreement count across the four engines (scanner / flame /
// timing / scalp), not a setup stage.
//
// Owner screenshot 2026-10-27 (V75 1m, Deriv public data, no MT5 bridge): the
// header read "Bullish · Developing" while the Market Read card said "Setup
// forming". "Developing" meant "one engine leans bullish and nothing
// corroborates it"; printed bare it read as the same axis as the signal
// lifecycle. This helper names what was counted, using the SAME tally the
// composer used for its stage (summarizeAgreement / stageFromAgreement), and
// says nothing when it cannot reproduce that stage from the components it was
// given (fail closed: no count is invented, and the client never promotes).
//
// Display-only. No verdict, gate, or execution input is derived here.

import { stageFromAgreement, summarizeAgreement } from "@workspace/domain/truth";
import type { TruthComponents, TruthVerdict } from "@workspace/api-client-react";

export interface EngineAgreementLabel {
  /** Short chip text for the identity row. */
  chip: string;
  /** Per-engine breakdown for the chip's tooltip. */
  title: string;
  /** Bias wording qualified by how many engines carry it ("Bullish lean"). */
  biasLabel: string | null;
}

const ENGINE_NAME: Record<keyof TruthComponents, string> = {
  scanner: "Scanner",
  flame: "Flame (momentum)",
  timing: "Timing",
  scalp: "Scalp",
};

const ALIGNMENT_WORD: Record<string, string> = {
  BULLISH: "bullish",
  BEARISH: "bearish",
  NEUTRAL: "neutral",
};

function engines(n: number): string {
  return n === 1 ? "engine" : "engines";
}

export function describeEngineAgreement(
  verdict: Pick<TruthVerdict, "bias" | "stage"> | null | undefined,
  components: TruthComponents | null | undefined,
): EngineAgreementLabel | null {
  if (!verdict || !components) return null;
  const { stage, bias } = verdict;
  if (stage !== "ALIGNED" && stage !== "DEVELOPING" && stage !== "CONFLICT") return null;
  const keys = Object.keys(ENGINE_NAME) as Array<keyof TruthComponents>;
  if (!keys.every((k) => components[k] != null)) return null;
  const summary = summarizeAgreement(keys.map((k) => components[k]));
  // The count must reproduce the server's stage, or we do not label it.
  if (stageFromAgreement(summary) !== stage) return null;

  const title = "Engine agreement on this timeframe: " + keys.map((k) => {
    const comp = components[k];
    const word = comp.present ? ALIGNMENT_WORD[comp.alignment] : undefined;
    if (!word) return `${ENGINE_NAME[k]} — no read`;
    const label = comp.label?.trim();
    return label ? `${ENGINE_NAME[k]} — ${word} (${label})` : `${ENGINE_NAME[k]} — ${word}`;
  }).join("; ") + ".";

  const { voting, bullish, bearish } = summary;
  if (stage === "CONFLICT") {
    return {
      chip: `Engines disagree · ${bullish} bullish, ${bearish} bearish`,
      title,
      biasLabel: null,
    };
  }
  const side = bias === "BULLISH" ? "bullish" : bias === "BEARISH" ? "bearish" : null;
  const agree = side === "bullish" ? bullish : side === "bearish" ? bearish : 0;
  if (side == null || agree === 0) {
    // DEVELOPING with no directional vote: every reading engine is neutral.
    return {
      chip: `${voting} ${engines(voting)} read · none leans either way`,
      title,
      biasLabel: null,
    };
  }
  const capSide = side === "bullish" ? "Bullish" : "Bearish";
  if (stage === "ALIGNED") {
    return { chip: `${agree} of ${voting} ${engines(voting)} ${side} · agree`, title, biasLabel: capSide };
  }
  return {
    chip: `${agree} of ${voting} ${engines(voting)} ${side} · unconfirmed`,
    title,
    biasLabel: `${capSide} lean`,
  };
}
