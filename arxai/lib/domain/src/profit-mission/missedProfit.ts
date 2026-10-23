// ── Profit Mission Phase 8 — Missed-Profit / Capture-Rate analysis (pure) ───────
//
// LEARNING / ADVISORY-only. Compares what a trade COULD have captured (its max
// favourable excursion, MFE) against what it actually captured, producing a
// capture-rate and an exit-quality classification used to train exits over time.
//
// HONESTY CONTRACT:
//   - A risk-JUSTIFIED early exit (invalidation, structure break, news, order-
//     flow reversal) is NEVER punished — its quality is "justified_early_exit",
//     not "left_money". The capture rate is still recorded for transparency.
//   - Unknown MFE → capture rate is null, not a fabricated 100%.
//   - No guaranteed-profit vocabulary.
//
// PURE + DETERMINISTIC + IO-FREE.

export type ExitQuality =
  | "excellent_capture" // captured most of the available move
  | "good_capture"
  | "left_money" // exited well short of MFE without a protective reason
  | "justified_early_exit" // protective exit — not penalised
  | "loss" // closed at a loss
  | "unknown"; // not enough data

export interface MissedProfitInput {
  /** Realised P/L of the closed trade, account currency (may be negative). */
  realisedPnl?: number | null;
  /** Max favourable excursion in account currency (best unrealised profit seen). */
  mfeProfit?: number | null;
  /** Max adverse excursion in account currency (worst unrealised loss seen, ≤ 0). */
  maeProfit?: number | null;
  /** Was the exit driven by a protective trigger (invalidation/news/structure)? */
  protectiveExit?: boolean;
}

export interface MissedProfitVerdict {
  /** Profit captured (realisedPnl, never below 0 for the rate maths). */
  capturedProfit: number;
  /** Best profit that was available (MFE), or null when unknown. */
  availableProfit: number | null;
  /** Profit left on the table (max(0, MFE - captured)), or null when unknown. */
  missedProfit: number | null;
  /** captured / MFE in 0..1, or null when MFE unknown / ≤ 0. */
  captureRate: number | null;
  quality: ExitQuality;
  /** True when the exit was protective and must NOT be penalised. */
  justified: boolean;
  reasons: string[];
}

function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const EXCELLENT = 0.8;
const GOOD = 0.5;

/**
 * Analyse how much of the available move a closed trade captured. Protective
 * early exits are flagged justified and never classified as "left money".
 */
export function analyseMissedProfit(input: MissedProfitInput): MissedProfitVerdict {
  const reasons: string[] = [];
  const realised = isNum(input.realisedPnl) ? input.realisedPnl : null;
  const mfe = isNum(input.mfeProfit) ? input.mfeProfit : null;
  const justified = input.protectiveExit === true;

  if (realised == null) {
    return {
      capturedProfit: 0,
      availableProfit: mfe,
      missedProfit: null,
      captureRate: null,
      quality: "unknown",
      justified,
      reasons: ["Realised P/L unknown — capture rate not computed."],
    };
  }

  // A losing trade has no positive capture to rate, but we still record it.
  if (realised <= 0) {
    return {
      capturedProfit: round2(realised),
      availableProfit: mfe,
      missedProfit: mfe != null && mfe > 0 ? round2(mfe) : null,
      captureRate: mfe != null && mfe > 0 ? 0 : null,
      quality: justified ? "justified_early_exit" : "loss",
      justified,
      reasons: justified
        ? ["Closed at/under break-even on a protective exit — not penalised."]
        : ["Closed at a loss — no favourable capture to rate."],
    };
  }

  if (mfe == null || mfe <= 0) {
    return {
      capturedProfit: round2(realised),
      availableProfit: mfe,
      missedProfit: null,
      captureRate: null,
      quality: "unknown",
      justified,
      reasons: ["Max favourable excursion unknown — capture rate not computed."],
    };
  }

  const captureRate = Math.min(1, realised / mfe);
  const missed = round2(Math.max(0, mfe - realised));

  let quality: ExitQuality;
  if (justified) {
    quality = "justified_early_exit";
    reasons.push(
      `Protective exit captured ${Math.round(captureRate * 100)}% of the move — justified, not penalised.`,
    );
  } else if (captureRate >= EXCELLENT) {
    quality = "excellent_capture";
    reasons.push(`Captured ${Math.round(captureRate * 100)}% of the available move.`);
  } else if (captureRate >= GOOD) {
    quality = "good_capture";
    reasons.push(`Captured ${Math.round(captureRate * 100)}% of the available move.`);
  } else {
    quality = "left_money";
    reasons.push(
      `Captured only ${Math.round(captureRate * 100)}% — left ${missed} on the table; review exit timing.`,
    );
  }

  return {
    capturedProfit: round2(realised),
    availableProfit: round2(mfe),
    missedProfit: missed,
    captureRate: round2(captureRate),
    quality,
    justified,
    reasons,
  };
}
