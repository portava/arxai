// ═══════════════════════════════════════════════════════════════════════════
// Override Replay
//
// Compares a user override decision to what the system would have done
// (judge verdict). Computes outcome under both paths and decides whether
// the override helped or hurt.
//
// Pure. Outcome computation reuses candle playback for the actually-taken
// path; the system path is APPROVE→same outcome, BLOCK→no trade, DEFER→
// no trade.
// ═══════════════════════════════════════════════════════════════════════════

import { playbackCandles } from "./candlePlayback.engine";
import type { ReplaySnapshot, TradeOutcome } from "./replay.types";

export interface OverrideReplayResult {
  systemDecision: "APPROVE" | "BLOCK" | "DEFER" | "UNKNOWN";
  userTookTrade: boolean;
  takenOutcome: TradeOutcome;
  systemPathOutcome: TradeOutcome;
  overrideHelped: boolean;
  overrideHurt: boolean;
  rDelta: number;
  notes: string[];
}

const NO_TRADE: TradeOutcome = {
  status: "NONE", exitTs: null, exitPrice: null, pnl: 0, rMultiple: 0, durationMin: 0,
  reason: "system path: no trade",
};

export function replayOverride(snapshot: ReplaySnapshot): OverrideReplayResult {
  const systemDecision = snapshot.judgeVerdict?.decision ?? "UNKNOWN";
  const userTookTrade = snapshot.decisionKind === "OVERRIDE" || snapshot.decisionKind === "EXECUTED";

  const taken: TradeOutcome = snapshot.intent && userTookTrade
    ? playbackCandles({ candles: snapshot.candles, intent: snapshot.intent })
    : NO_TRADE;

  let systemPath: TradeOutcome;
  if (systemDecision === "APPROVE" && snapshot.intent) {
    systemPath = playbackCandles({ candles: snapshot.candles, intent: snapshot.intent });
  } else {
    systemPath = NO_TRADE;
  }

  const rDelta = round2(taken.rMultiple - systemPath.rMultiple);
  // "Override" means user-taken differs from system path
  const overrideOccurred = userTookTrade !== (systemPath.status !== "NONE");
  const overrideHelped = overrideOccurred && rDelta > 0.10;
  const overrideHurt   = overrideOccurred && rDelta < -0.10;

  return {
    systemDecision, userTookTrade,
    takenOutcome: taken, systemPathOutcome: systemPath,
    overrideHelped, overrideHurt, rDelta,
    notes: [
      `system decision was ${systemDecision}; user ${userTookTrade ? "took" : "skipped"} the trade`,
      `R delta vs system path: ${rDelta}`,
    ],
  };
}
function round2(n: number) { return Math.round(n * 100) / 100; }
