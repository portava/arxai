// ═══════════════════════════════════════════════════════════════════════════
// Candle Playback
//
// Walks a candle sequence forward from an entry timestamp and resolves
// the trade against stop loss / take profit / time exit. Pure.
//
// Conservative ordering when both SL and TP are hit in the same candle:
//   • SL takes priority (worst-case assumption).
// ═══════════════════════════════════════════════════════════════════════════

import type { Candle, TradeIntent, TradeOutcome } from "./replay.types";

export interface PlaybackOptions {
  candles: Candle[];
  intent: TradeIntent;
  /** Optional cap on candles to step (for EXIT_LATER / EXIT_EARLIER). */
  maxCandles?: number;
  /** Optional forced exit at this ts (for EXIT_EARLIER atTs). */
  forceExitTs?: string;
  /** Override stop / take profit / size mid-replay (for what-ifs). */
  overrideStopLoss?: number;
  overrideTakeProfit?: number | null;
}

export function playbackCandles(opts: PlaybackOptions): TradeOutcome {
  const intent = opts.intent;
  const stop = opts.overrideStopLoss ?? intent.stopLoss;
  const tp = opts.overrideTakeProfit !== undefined ? opts.overrideTakeProfit : intent.takeProfit ?? null;
  const entry = intent.entryPrice;
  const isBuy = intent.direction === "BUY";
  const riskPerUnit = Math.abs(entry - stop);
  const entryMs = new Date(intent.intendedAt).getTime();
  const forceExitMs = opts.forceExitTs ? new Date(opts.forceExitTs).getTime() : null;

  let stepped = 0;
  let lastClose = entry, lastTs = intent.intendedAt;

  for (const c of opts.candles) {
    const cMs = new Date(c.ts).getTime();
    if (cMs < entryMs) continue;
    stepped++;
    lastClose = c.close;
    lastTs = c.ts;

    // Intrabar precedence: SL is evaluated FIRST (worst-case), then TP,
    // then forced time exit. This preserves conservative ordering even
    // when forceExitTs falls on a bar where stop or target would have
    // been hit intrabar.
    if (isBuy) {
      if (c.low <= stop) {
        return makeOutcome("STOPPED_OUT", c.ts, stop, intent, riskPerUnit, "stop loss hit");
      }
      if (tp !== null && c.high >= tp) {
        return makeOutcome("TARGET_HIT", c.ts, tp, intent, riskPerUnit, "take profit hit");
      }
    } else {
      if (c.high >= stop) {
        return makeOutcome("STOPPED_OUT", c.ts, stop, intent, riskPerUnit, "stop loss hit");
      }
      if (tp !== null && c.low <= tp) {
        return makeOutcome("TARGET_HIT", c.ts, tp, intent, riskPerUnit, "take profit hit");
      }
    }

    // Forced time exit only after SL/TP have been ruled out for the bar.
    if (forceExitMs !== null && cMs >= forceExitMs) {
      return makeOutcome("TIME_EXIT", c.ts, c.close, intent, riskPerUnit, "forced exit at ts");
    }

    if (opts.maxCandles && stepped >= opts.maxCandles) {
      return makeOutcome("TIME_EXIT", c.ts, c.close, intent, riskPerUnit, "max candles reached");
    }
  }

  // Walked all candles → mark to last close
  if (stepped === 0) {
    return { status: "NONE", exitTs: null, exitPrice: null, pnl: 0, rMultiple: 0,
      durationMin: 0, reason: "no candles after entry" };
  }
  return makeOutcome("TIME_EXIT", lastTs, lastClose, intent, riskPerUnit, "end of candles");
}

function makeOutcome(
  rawStatus: "STOPPED_OUT"|"TARGET_HIT"|"TIME_EXIT",
  exitTs: string, exitPrice: number,
  intent: TradeIntent, riskPerUnit: number, reason: string,
): TradeOutcome {
  const isBuy = intent.direction === "BUY";
  const perUnit = isBuy ? exitPrice - intent.entryPrice : intent.entryPrice - exitPrice;
  const pnl = perUnit * intent.lotSize;
  const r = riskPerUnit > 0 ? perUnit / riskPerUnit : 0;
  // Preserve raw exit reason (TARGET_HIT / STOPPED_OUT / TIME_EXIT) so
  // downstream consumers can distinguish a discretionary time exit from a
  // mechanical stop. Win/loss is also encoded redundantly in pnl/rMultiple.
  const status: TradeOutcome["status"] = rawStatus;
  const durationMin = Math.max(0, (new Date(exitTs).getTime() - new Date(intent.intendedAt).getTime()) / 60_000);
  return {
    status, exitTs, exitPrice,
    pnl: round2(pnl), rMultiple: round2(r),
    durationMin: round2(durationMin), reason,
  };
}
function round2(n: number) { return Math.round(n * 100) / 100; }
