// ═══════════════════════════════════════════════════════════════════════════
// Missed Trade Replay
//
// For setups that were valid but never taken, simulate the outcome and
// quantify the missed expectancy in R multiples. Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { playbackCandles } from "./candlePlayback.engine";
import type { ReplaySnapshot, TradeOutcome } from "./replay.types";

export interface MissedTradeReplayResult {
  hadIntent: boolean;
  hypotheticalOutcome: TradeOutcome;
  setupWorked: boolean;
  missedRMultiple: number;
  notes: string[];
}

export function replayMissedTrade(snapshot: ReplaySnapshot): MissedTradeReplayResult {
  if (!snapshot.intent) {
    return { hadIntent: false,
      hypotheticalOutcome: { status: "NONE", exitTs: null, exitPrice: null,
        pnl: 0, rMultiple: 0, durationMin: 0, reason: "no intent on snapshot" },
      setupWorked: false, missedRMultiple: 0,
      notes: ["snapshot has no trade intent — nothing to replay"] };
  }
  const outcome = playbackCandles({ candles: snapshot.candles, intent: snapshot.intent });
  const win = outcome.status === "CLOSED_WIN" || outcome.status === "TARGET_HIT";
  return {
    hadIntent: true,
    hypotheticalOutcome: outcome,
    setupWorked: win,
    missedRMultiple: win ? Math.max(0, outcome.rMultiple) : 0,
    notes: [
      `missed setup hypothetical ${outcome.status}; opportunity ${win ? "+"+outcome.rMultiple+"R" : "no edge"}`,
    ],
  };
}
