import type { ConfidenceDecayInput, ConfidenceDecayResult } from "./aiAgents.types";

// "Confidence must decay dynamically after trade entry."
// Two independent decay sources, multiplied:
//   • Time decay — exponential half-life (default 60 min). Older trades
//     lose conviction even if price hasn't moved against us.
//   • Adverse-move decay — penalty proportional to MAE in ATR units. The
//     more the price has gone against us, the less confident we are that
//     the original setup is still valid.

const DEFAULT_HALF_LIFE_MIN = 60;
const ADVERSE_FLOOR_ATR = 1.5;   // beyond this ATR-adverse, factor → 0

export function applyConfidenceDecay(input: ConfidenceDecayInput): ConfidenceDecayResult {
  const reasons: string[] = [];
  const halfLife = input.halfLifeMinutes ?? DEFAULT_HALF_LIFE_MIN;
  const ageMs = input.now.getTime() - new Date(input.entryTime).getTime();
  const ageMinutes = Math.max(0, ageMs / 60_000);

  // Time decay — 0.5 ^ (age / halfLife)
  const timeFactor = Math.pow(0.5, ageMinutes / Math.max(1, halfLife));
  reasons.push(`time decay: ${ageMinutes.toFixed(1)}m / half-life ${halfLife}m → ×${timeFactor.toFixed(3)}`);

  // Adverse-move computed in ATR units. Negative = adverse for our direction.
  const priceMove = input.currentPrice - input.entryPrice;
  const directionalMove = input.direction === "BUY" ? priceMove : -priceMove;
  const adverseAtr = input.atr > 0 ? Math.min(0, directionalMove / input.atr) : 0;
  // adverseAtr in [-∞, 0] — make it [0, 1] factor
  let adverseFactor: number;
  if (input.atr <= 0) {
    adverseFactor = 1;
    reasons.push("ATR not available — skipping adverse-move decay");
  } else if (adverseAtr >= 0) {
    adverseFactor = 1;   // not adverse
    reasons.push(`favourable move ${(directionalMove / input.atr).toFixed(2)}×ATR → no adverse decay`);
  } else if (Math.abs(adverseAtr) >= ADVERSE_FLOOR_ATR) {
    adverseFactor = 0;
    reasons.push(`adverse ${Math.abs(adverseAtr).toFixed(2)}×ATR ≥ floor ${ADVERSE_FLOOR_ATR} → ×0`);
  } else {
    adverseFactor = 1 - (Math.abs(adverseAtr) / ADVERSE_FLOOR_ATR);
    reasons.push(`adverse ${Math.abs(adverseAtr).toFixed(2)}×ATR → ×${adverseFactor.toFixed(3)}`);
  }

  const decayedConfidence = Math.max(0, Math.min(100,
    input.initialConfidence * timeFactor * adverseFactor,
  ));

  return {
    decayedConfidence: Math.round(decayedConfidence),
    timeFactor, adverseFactor,
    ageMinutes, adverseAtr,
    reasons,
  };
}
