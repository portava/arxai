// ═══════════════════════════════════════════════════════════════════════════
// Blocked Trade Replay
//
// Given a snapshot whose decision was BLOCK, simulate what would have
// happened had the trade been taken. Used for evidence on whether the
// block was correct, conservative, or harmful.
// ═══════════════════════════════════════════════════════════════════════════

import { playbackCandles } from "./candlePlayback.engine";
import type { ReplaySnapshot, TradeOutcome } from "./replay.types";

export interface BlockedTradeReplayResult {
  hadIntent: boolean;
  hypotheticalOutcome: TradeOutcome;
  blockWasCorrect: boolean;     // true if hypothetical was a loss
  blockMissedWin: boolean;      // true if hypothetical was a win
  notes: string[];
}

export function replayBlockedTrade(snapshot: ReplaySnapshot): BlockedTradeReplayResult {
  if (!snapshot.intent) {
    return { hadIntent: false,
      hypotheticalOutcome: { status: "NONE", exitTs: null, exitPrice: null,
        pnl: 0, rMultiple: 0, durationMin: 0, reason: "no intent on snapshot" },
      blockWasCorrect: true, blockMissedWin: false,
      notes: ["snapshot has no trade intent — nothing to replay"] };
  }
  const outcome = playbackCandles({ candles: snapshot.candles, intent: snapshot.intent });
  const win  = outcome.status === "CLOSED_WIN" || outcome.status === "TARGET_HIT";
  const loss = outcome.status === "CLOSED_LOSS" || outcome.status === "STOPPED_OUT";
  return {
    hadIntent: true, hypotheticalOutcome: outcome,
    blockWasCorrect: loss,
    blockMissedWin: win,
    notes: [
      `decision was ${snapshot.decisionKind}; hypothetical outcome ${outcome.status} (R=${outcome.rMultiple})`,
    ],
  };
}
