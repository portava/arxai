// Agent replay: a graded record for every agent whose read is a deterministic
// function of market data.
//
// On the scanner surface an agent's read is a 0..1 strength computed from the
// scanner row (advisoryInfluence.scannerStrength): Market Structure reads trend
// alignment, Entry Timing reads entry timing, Risk reads 1 - riskScore, Scanner
// AI reads the opportunity score. The scanner row itself is
// analyzeMarketFromCandles + opportunityScore over the last 30 closed bars, all
// pure. So the replay rebuilds, bar by bar on real history, the exact row the
// scanner would have shown, takes each agent's strength as its 0-100 score, and
// grades the row's own call (its direction, stop and target) first-touch on the
// bars AFTER it. Calls do not overlap: the next one starts after the previous
// one resolved (overlapping calls are correlated and would flatter the CV test).
//
// Agents that cannot be replayed are listed with the reason. Their influence
// stays 0 until they have a live graded record of their own.
//
// The graded record of a replayed agent is persisted as a calibration fit with
// source historical_replay / strategy_replay and its fixture provenance; it is
// NOT written into agent_predictions, which is the truth-locked journal of
// opinions an agent actually recorded at the time.

import { labelFirstTouch } from "@workspace/domain/calibration";
import { analyzeMarketFromCandles } from "../aiBrain.js";
import { advisoryDirectionFor, opportunityScore } from "../marketScanner.js";
import { scannerStrength, type ScannerAdvisoryContext } from "../agentEcosystem/advisoryInfluence.js";
import type { Candle } from "../strategyEngine.js";
import { REPLAY_HORIZON_BARS, resolutionBar } from "./strategyReplay.js";
import { AGENT_REPLAY_SPECS, REPLAYABLE_AGENT_KEYS } from "./agentReplaySpecs.js";

export { AGENT_REPLAY_SPECS, REPLAYABLE_AGENT_KEYS, agentNoReplayReason } from "./agentReplaySpecs.js";

/** The scanner's analysis window (marketScanner SCAN_ANALYSIS_WINDOW). */
export const AGENT_REPLAY_WINDOW = 30;
/** strategyMatch the scanner passes to opportunityScore. */
const SCANNER_STRATEGY_MATCH = 7;

export interface AgentReplaySample {
  agentKey: string;
  barIndex: number;
  direction: "BUY" | "SELL";
  /** The agent's strength on this row, 0-100. */
  score: number;
  outcome: 0 | 1;
}

/** The scanner row (context) at bar i, rebuilt from closed bars only. */
export function scannerContextAt(candles: readonly Candle[], i: number, symbol: string, timeframe: string) {
  const window = candles.slice(i - AGENT_REPLAY_WINDOW + 1, i + 1).map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close }));
  const last = window[window.length - 1];
  // History has no quote: the bar's close stands in for the mid, spread 0
  // (unobserved). The scanner does the same when its quote is not bound.
  const analysis = analyzeMarketFromCandles(symbol, timeframe, window, { mid: last.c, spread: 0 }, "LIVE_FEED");
  const opp = opportunityScore(analysis, SCANNER_STRATEGY_MATCH, { spreadPrice: null });
  const ctx: ScannerAdvisoryContext = {
    baseScore: opp.score,
    direction: advisoryDirectionFor(analysis),
    factors: opp.factors,
    riskScore: analysis.riskScore,
  };
  return { analysis, ctx };
}

/** A read graded on each replayed scanner call: 0..1 strength, or null to abstain. */
export interface ReplayScorer {
  key: string;
  strength: (ctx: ScannerAdvisoryContext, candles: readonly Candle[], i: number) => number | null;
}

/** The core agents' served reads (advisoryInfluence.scannerStrength). */
export function coreAgentScorers(keys: readonly string[] = REPLAYABLE_AGENT_KEYS): ReplayScorer[] {
  return keys.flatMap((k) => {
    const spec = AGENT_REPLAY_SPECS[k];
    return spec?.replayable ? [{ key: k, strength: (ctx: ScannerAdvisoryContext) => scannerStrength(spec.department, ctx) }] : [];
  });
}

export function replayAgents(
  candles: Candle[],
  symbol: string,
  timeframe: string,
  opts: { horizon?: number; agents?: readonly string[]; scorers?: readonly ReplayScorer[] } = {},
): AgentReplaySample[] {
  const horizon = opts.horizon ?? REPLAY_HORIZON_BARS;
  const scorers = opts.scorers ?? coreAgentScorers(opts.agents);
  const out: AgentReplaySample[] = [];
  let i = AGENT_REPLAY_WINDOW - 1;
  while (i < candles.length - 1) {
    const { analysis, ctx } = scannerContextAt(candles, i, symbol, timeframe);
    const direction = ctx.direction;
    if (direction !== "BUY" && direction !== "SELL") {
      i++;
      continue;
    }
    const outcome = labelFirstTouch(candles, i, direction, analysis.stopLoss, analysis.takeProfit, horizon);
    if (outcome === null) {
      i += horizon + 1;
      continue;
    }
    for (const sc of scorers) {
      const strength = sc.strength(ctx, candles, i);
      if (strength === null || !Number.isFinite(strength)) continue;
      out.push({
        agentKey: sc.key,
        barIndex: i,
        direction,
        score: Math.max(0, Math.min(100, strength * 100)),
        outcome,
      });
    }
    i = resolutionBar(candles, i, direction, analysis.stopLoss, analysis.takeProfit, horizon) + 1;
  }
  return out;
}
