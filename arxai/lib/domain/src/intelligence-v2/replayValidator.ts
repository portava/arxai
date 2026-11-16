import type { ConsensusResult as V2Result } from "../agents/consensusVerdict.types";
import { v2ActionClass } from "./shadowRunner";
import type { HistoricalTradeForReplay, ReplayDifference, ReplayReport } from "./intelligenceV2.types";

// replayHistoricalTrades
//
// Runs a window of historical trades through a v2 consensus function and
// returns a structured comparison: where v2 would have agreed, where it
// would have skipped, where it would have flipped direction. Pure: the
// caller supplies the v2 runner closure so we don't bind to a specific
// consensus signature here.
//
// `hypotheticalRDelta` is the sum of R that v2 would have either captured
// (when it agreed/flipped) or avoided (when it skipped a losing trade).
// A positive delta means v2 would have produced more total R than reality.
export interface ReplayInput {
  trades: HistoricalTradeForReplay[];
  runV2: (trade: HistoricalTradeForReplay) => Promise<V2Result>;
  windowStart?: string;
  windowEnd?: string;
}

export async function replayHistoricalTrades(input: ReplayInput): Promise<ReplayReport> {
  const occurredAts = input.trades.map((t) => t.occurredAt).sort();
  const windowStart = input.windowStart ?? occurredAts[0] ?? new Date(0).toISOString();
  const windowEnd   = input.windowEnd   ?? occurredAts[occurredAts.length - 1] ?? new Date().toISOString();

  const differences: ReplayDifference[] = [];
  let agreementCount = 0;
  let v2WouldHaveTaken    = 0;
  let v2WouldHaveSkipped  = 0;
  let v2WouldHaveFlipped  = 0;
  let hypotheticalRDelta  = 0;

  for (const t of input.trades) {
    const v2 = await input.runV2(t);
    const v2Acts = v2ActionClass(v2.verdict) === "ACTED";
    let divergence: ReplayDifference["divergence"] = "AGREED";

    if (t.realActed && v2Acts && v2.direction === t.realDirection) {
      divergence = "AGREED";
      agreementCount++;
      // Same direction acted — no R delta vs reality
    } else if (t.realActed && v2Acts && v2.direction !== null && v2.direction !== t.realDirection) {
      divergence = "V2_WOULD_HAVE_FLIPPED";
      v2WouldHaveFlipped++;
      // Flip → hypothetical R is negated
      hypotheticalRDelta += (-t.realOutcomeR) - t.realOutcomeR;     // = -2 × realR
    } else if (!t.realActed && v2Acts) {
      divergence = "V2_WOULD_HAVE_TAKEN";
      v2WouldHaveTaken++;
      // We don't have a real R for this counterfactual; record 0 contribution.
      // The caller can override by re-running with simulated outcomes.
    } else if (t.realActed && !v2Acts) {
      divergence = "V2_WOULD_HAVE_SKIPPED";
      v2WouldHaveSkipped++;
      // Skipped a real trade → hypothetical R delta is the *negation* of
      // its outcome (skipping a +1R trade costs us +1R; skipping a −1R
      // trade saves us +1R).
      hypotheticalRDelta += -t.realOutcomeR;
    } else {
      // Neither acted — full agreement on a no-trade
      divergence = "AGREED";
      agreementCount++;
    }

    differences.push({
      signalId: t.signalId,
      realActed: t.realActed,
      v2Verdict: v2.verdict,
      v2WouldAct: v2Acts,
      v2Direction: v2.direction,
      divergence,
      realOutcomeR: t.realOutcomeR,
    });
  }

  return {
    windowStart, windowEnd,
    tradesReplayed: input.trades.length,
    agreementCount,
    divergenceCount: input.trades.length - agreementCount,
    v2WouldHaveTaken, v2WouldHaveSkipped, v2WouldHaveFlipped,
    hypotheticalRDelta,
    differences,
  };
}
