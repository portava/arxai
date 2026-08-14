// TradeThesis builder — pure. No thesis ⇒ no decision. A thesis is only built
// when there is a real directional edge, a protective stop, and sufficient data;
// otherwise it returns null and the pipeline downgrades the decision honestly.

import type { RubyMarketEdgeSignal } from "../signal-intelligence/signalIntelligence.types.js";
import type {
  SetupKind,
  TradeSide,
  TradeThesis,
} from "./selfTradeDecision.types.js";

const MIN_THESIS_EDGE = 30;

export function buildTradeThesis(args: {
  signal: RubyMarketEdgeSignal;
  setup: SetupKind;
  side: TradeSide | null;
  decayedConfidence: number;
}): TradeThesis | null {
  const { signal, setup, side, decayedConfidence } = args;

  if (!signal.hasSufficientData) return null;
  if (setup === "NONE" || side == null) return null;
  if (signal.direction === "NEUTRAL") return null;
  if (signal.stopLoss == null) return null; // no protective stop ⇒ no thesis
  if (signal.edgeScore < MIN_THESIS_EDGE) return null;

  const whyNow: string[] = [];
  // Reason chain is sourced from the signal engine — never invented here.
  for (const r of signal.reasonChain.slice(0, 4)) whyNow.push(r);
  if (whyNow.length === 0) {
    whyNow.push(`${setup.replace(/_/g, " ").toLowerCase()} with ${signal.bias.toLowerCase()} bias`);
  }

  return {
    symbol: signal.symbol,
    side,
    setup,
    whyNow,
    entryZone: signal.entryZone,
    stopLoss: signal.stopLoss,
    invalidation: signal.invalidationPrice,
    takeProfits: signal.takeProfitZones,
    edge: signal.edgeScore,
    confidence: Math.round(decayedConfidence),
    newsRisk: deriveNewsRisk(signal),
  };
}

function deriveNewsRisk(signal: RubyMarketEdgeSignal): TradeThesis["newsRisk"] {
  // newsSafety 0–100 inverted to a coarse risk band (honest, derived).
  const ns = signal.scores.newsSafety;
  if (ns <= 10) return "critical";
  if (ns <= 40) return "high";
  if (ns <= 60) return "medium";
  if (ns <= 85) return "low";
  return "none";
}
