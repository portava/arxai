// Display-only: the selected panel cannot publish an executable-looking setup
// that the same source/timeframe's canonical truth or Eleanor chart read withholds.
import type { SelectedMarketEnvelope } from "./selectedMarket.js";
import type { SymbolTruthSnapshot } from "../truth/symbolTruthSnapshot.js";
import type { EleanorChartContext } from "../data/chart/eleanorChartContext.js";
import { evidenceOfState } from "../data/chart/stateCandleWindow.js";
import { evidenceMatches, isCurrentBuild } from "../truth/marketReadEvidence.js";
export function capSelectedMarketByTruth(
  selected: SelectedMarketEnvelope, truth: SymbolTruthSnapshot | null,
  context: EleanorChartContext | null, now = Date.now(),
): SelectedMarketEnvelope {
  if (!selected.ok) return selected;
  const expected = truth?.data.sourceIdentity && truth.data.source && truth.data.lastCandleAt ? {
    symbol: truth.symbol, timeframe: truth.timeframe, source: truth.data.source,
    sourceIdentity: truth.data.sourceIdentity, lastClosedCandleAt: truth.data.lastCandleAt,
  } : null;
  const bound = !!truth && !!context && selected.symbol === truth.symbol && selected.timeframe === truth.timeframe &&
    evidenceMatches(selected.marketEvidence, expected, now) && evidenceMatches(evidenceOfState(context.state), expected, now) &&
    isCurrentBuild(selected.generatedAt, now) && isCurrentBuild(truth.generatedAt, now) &&
    Number.isFinite(Date.parse(truth.validUntil ?? "")) && Date.parse(truth.validUntil!) > now;
  const action = truth?.verdict.bestAction;
  const levels = truth?.levels;
  const eligible = bound && selected.dataState === "LIVE_CONFIRMED" && truth!.data.state === "LIVE_CONFIRMED" &&
    context!.basis === "VERIFIED" && context!.sufficiency.canShowTradeSetup && !selected.readWithheldReason &&
    (action === "BUY" || action === "SELL") && levels?.withheld === false;
  const entryFrom = levels?.entryFrom, entryTo = levels?.entryTo, stop = levels?.stopLoss, target = levels?.takeProfit[0];
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
  const geometry = finite(entryFrom) && finite(entryTo) && entryFrom <= entryTo && finite(stop) && finite(target) &&
    (action === "BUY" ? stop < entryFrom && target > entryTo : action === "SELL" && stop > entryTo && target < entryFrom);
  const reason = eligible && !geometry ? "Canonical setup geometry is invalid; exact levels are withheld." : !bound ? "The selected read is not bound to the current chart and canonical market verdict."
    : selected.readWithheldReason ?? (context!.basis !== "VERIFIED" || !context!.sufficiency.canShowTradeSetup
      ? context!.blockReason ?? "Chart verification is incomplete; only structural observations are available."
      : levels?.withheldReason ?? truth!.verdict.bestActionText);
  const shown = eligible && geometry;
  const midpoint = shown ? (entryFrom! + entryTo!) / 2 : 0;
  return { ...selected,
    highlights: { ...selected.highlights, bias: shown ? action as "BUY" | "SELL" : "WAIT",
      confidenceLabel: "Unmeasured", confidenceScore: null,
      trendState: shown ? action === "BUY" ? "bullish" : "bearish" : "neutral",
      entryZone: shown ? { low: entryFrom!, high: entryTo! } : null,
      suggestedStop: shown ? stop! : null, suggestedTakeProfit: shown ? target! : null,
      riskRewardRatio: shown ? Math.abs(target! - midpoint) / Math.abs(midpoint - stop!) : 0 },
    levelsWithheld: !shown, levelsWithheldReason: shown ? null : reason,
    readWithheldReason: shown ? null : reason,
    explanation: { ...selected.explanation,
      hedge: shown ? truth!.verdict.headline : "Live setup withheld.",
      why: shown ? truth!.verdict.evidenceFor.join(" ") : reason,
      whyItMatters: shown ? "These estimated levels come from the current canonical market verdict. Confidence has not been calibrated." : "Directional setup and exact trade levels are unavailable until the same chart and market checks pass.",
      risk: shown ? truth!.verdict.evidenceAgainst.join(" ") : "A structural observation does not establish a current trade setup.",
      invalidation: shown ? "The stop and target shown are the canonical verdict's estimated geometry." : "No actionable level geometry is available.", cautions: shown ? selected.explanation.cautions : [reason] },
  };
}
