// Ruby fakeout policy (owner spec 2026-11-04): "allow user to give ai
// authority to shift stop loss or take profit if they believe a fake out is
// taking place". Pure — no I/O. The evaluator feeds it the position, the last
// closed M15 bars and the intelligence scores; it answers with at most ONE
// bounded SL/TP shift, or NONE.
//
// What counts as a fakeout here: the latest completed bar spiked AGAINST the
// position (adverse wick ≥ FAKEOUT_SCORE_THRESHOLD % of the bar's range) and
// CLOSED back on the position's side of its open, while the broader reversal
// evidence is NOT standing (reversal score below the monitor's threshold). That
// is a whipsaw through a level, not a trend change: the trader's stop sat
// inside the wick's reach and would be (or nearly was) hit by noise.
//
// What Ruby may do, bounded:
//   • STOP LOSS — move it just beyond the fakeout wick extreme (plus a small
//     buffer), but never further than MAX_SL_WIDEN_RATIO of the ORIGINAL risk
//     distance (entry→stop) beyond the current stop, and never across entry
//     in the wrong direction. Widening a stop ADDS risk, so the cap is hard.
//   • TAKE PROFIT — only tightened, never widened: if a spike in the trade's
//     favour reached within TP_REACH_RATIO of the target and snapped back, the
//     target comes in to just inside that spike's extreme so the next test
//     fills. Tightening never adds risk.
//   • At most MAX_ADJUSTMENTS per monitor, one per ADJUST_COOLDOWN_MS, and only
//     while the position is not already at/through its stop (that is the
//     protective close's job, which runs first).
// Every shift is notified to the trader and audited; the broker confirms it.

export const FAKEOUT_SCORE_THRESHOLD = 60;
export const FAKEOUT_MAX_ADJUSTMENTS = 2;
export const FAKEOUT_ADJUST_COOLDOWN_MS = 15 * 60_000;
/** The new stop may sit at most this fraction of the ORIGINAL risk distance beyond the current stop. */
export const FAKEOUT_MAX_SL_WIDEN_RATIO = 0.5;
/** Buffer beyond the wick extreme, as a fraction of the bar's range. */
export const FAKEOUT_WICK_BUFFER_RATIO = 0.1;
/** A favourable spike must reach within this fraction of the entry→TP distance of the target to count. */
export const FAKEOUT_TP_REACH_RATIO = 0.15;
/** Refused/failed shift attempts allowed per monitor before Ruby stops trying (no alert storm). */
export const FAKEOUT_MAX_FAILED_ATTEMPTS = 2;
/** The last completed bar must have closed within this many bar intervals of now. */
export const FAKEOUT_MAX_BAR_AGE_INTERVALS = 2;
export const FAKEOUT_BAR_INTERVAL_MS = 15 * 60_000;

/** One OHLC bar; `t` = bar open time (epoch ms) when known. */
export interface FakeoutBar { o: number; h: number; l: number; c: number; t?: number | null }

/**
 * Share of the bar's range taken by the wick on the side AGAINST the position
 * (the lower wick for a long, the upper wick for a short), 0-100. This is the
 * stop-hunting spike. (The trade-intelligence "fakeoutRiskScore" measures the
 * OTHER wick — a rejection on the profit side — so it is not used here.)
 */
export function adverseWickPct(side: "BUY" | "SELL", b: FakeoutBar | null): number | null {
  if (!b || !(b.h > b.l)) return null;
  const wick = side === "BUY" ? Math.min(b.o, b.c) - b.l : b.h - Math.max(b.o, b.c);
  return Math.max(0, Math.min(100, (wick / (b.h - b.l)) * 100));
}

export interface FakeoutDecisionInput {
  side: "BUY" | "SELL";
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Latest COMPLETED bar (not the forming one). */
  lastBar: FakeoutBar | null;
  /** Informational only (trade-intelligence score of the profit-side wick); the rule reads adverseWickPct(lastBar). */
  fakeoutRiskScore?: number | null;
  reversalRiskScore: number | null;
  reversalThreshold: number;
  atOrThroughStop: boolean;
  adjustmentsSoFar: number;
  lastAdjustAt: string | null;
  nowMs: number;
  /** The stop when the monitor first saw the position. The widening cap is
   *  measured from it, so a second shift cannot add another half-risk on top
   *  of the first. Falls back to the current stop when unknown. */
  originalStopLoss?: number | null;
  /** Digits for rounding the new level (defaults to 5). */
  digits?: number;
  /** Open time of the bar the last shift acted on: one shift per bar. */
  lastFakeoutBarAt?: number | null;
  /** Refused/failed attempts so far for this monitor. */
  failedSoFar?: number;
  /** Bar interval (ms) for the staleness check; defaults to M15. */
  barIntervalMs?: number;
}

export type FakeoutAction = "NONE" | "SHIFT_SL" | "SHIFT_TP";

export interface FakeoutDecision {
  action: FakeoutAction;
  newStopLoss: number | null;
  newTakeProfit: number | null;
  reason: string;
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));

export function isAdverseFakeout(i: Pick<FakeoutDecisionInput, "side" | "lastBar" | "fakeoutRiskScore" | "reversalRiskScore" | "reversalThreshold">): { yes: boolean; reason: string } {
  const b = i.lastBar;
  if (!b || !(b.h > b.l)) return { yes: false, reason: "no completed bar" };
  const wickPct = adverseWickPct(i.side, b);
  if (wickPct == null || wickPct < FAKEOUT_SCORE_THRESHOLD) return { yes: false, reason: "no long adverse wick" };
  if (typeof i.reversalRiskScore === "number" && i.reversalRiskScore >= i.reversalThreshold) return { yes: false, reason: "reversal evidence is standing, not a fakeout" };
  // The bar must have closed back on the trade's side of its open.
  const closedBack = i.side === "BUY" ? b.c >= b.o : b.c <= b.o;
  if (!closedBack) return { yes: false, reason: "bar closed against the position" };
  return { yes: true, reason: `fakeout wick (${Math.round(wickPct)}% of the bar) that closed back` };
}

export function decideFakeoutAdjustment(i: FakeoutDecisionInput): FakeoutDecision {
  const none = (reason: string): FakeoutDecision => ({ action: "NONE", newStopLoss: null, newTakeProfit: null, reason });
  const digits = i.digits ?? 5;
  if (i.atOrThroughStop) return none("price at or through the stop — protective close applies");
  if (i.adjustmentsSoFar >= FAKEOUT_MAX_ADJUSTMENTS) return none(`already shifted ${i.adjustmentsSoFar} times for this monitor`);
  if ((i.failedSoFar ?? 0) >= FAKEOUT_MAX_FAILED_ATTEMPTS) return none(`${i.failedSoFar} shift attempts were refused — leaving the levels to the trader`);
  const last = i.lastAdjustAt ? Date.parse(i.lastAdjustAt) : NaN;
  if (Number.isFinite(last) && i.nowMs - last < FAKEOUT_ADJUST_COOLDOWN_MS) return none("fakeout adjustment cooldown");
  if (i.entryPrice == null || i.currentPrice == null || !i.lastBar) return none("entry, price or bar unknown");
  const b = i.lastBar;
  if (typeof b.t === "number" && Number.isFinite(b.t)) {
    if (i.lastFakeoutBarAt != null && b.t === i.lastFakeoutBarAt) return none("already acted on this bar");
    const interval = i.barIntervalMs ?? FAKEOUT_BAR_INTERVAL_MS;
    const closedAt = b.t + interval;
    if (i.nowMs - closedAt > interval * FAKEOUT_MAX_BAR_AGE_INTERVALS) return none("the last completed bar is stale");
  }
  const range = b.h - b.l;
  if (!(range > 0)) return none("flat bar");
  const buffer = range * FAKEOUT_WICK_BUFFER_RATIO;

  // 1. Adverse fakeout → stop loss shift (bounded widening).
  const adverse = isAdverseFakeout(i);
  if (adverse.yes && i.stopLoss != null) {
    const wickExtreme = i.side === "BUY" ? b.l : b.h;
    const stopInsideWick = i.side === "BUY" ? i.stopLoss > wickExtreme - buffer : i.stopLoss < wickExtreme + buffer;
    if (stopInsideWick) {
      const baseStop = typeof i.originalStopLoss === "number" && Number.isFinite(i.originalStopLoss) ? i.originalStopLoss : i.stopLoss;
      const originalRisk = Math.abs(i.entryPrice - baseStop);
      if (!(originalRisk > 0)) return none("no measurable risk distance");
      const maxWiden = originalRisk * FAKEOUT_MAX_SL_WIDEN_RATIO;
      const wanted = i.side === "BUY" ? wickExtreme - buffer : wickExtreme + buffer;
      const capped = i.side === "BUY" ? Math.max(wanted, baseStop - maxWiden) : Math.min(wanted, baseStop + maxWiden);
      // The total widening allowance (from the ORIGINAL stop) is used up.
      const widens = i.side === "BUY" ? round(capped, digits) < round(i.stopLoss, digits) : round(capped, digits) > round(i.stopLoss, digits);
      if (!widens) return none("stop already widened to the cap from the original stop");
      // Never cross to the wrong side of the current price.
      const safe = i.side === "BUY" ? capped < i.currentPrice : capped > i.currentPrice;
      if (!safe) return none("new stop would sit on the wrong side of price");
      const newSl = round(capped, digits);
      if (newSl === round(i.stopLoss, digits)) return none("stop already beyond the wick");
      return {
        action: "SHIFT_SL", newStopLoss: newSl, newTakeProfit: null,
        reason: `${adverse.reason}; stop ${i.stopLoss} sat inside the wick (extreme ${wickExtreme}), moved to ${newSl} (cap ${Math.round(FAKEOUT_MAX_SL_WIDEN_RATIO * 100)}% of original risk)`,
      };
    }
  }

  // 2. Favourable spike that failed → take profit tightened to inside it.
  if (i.takeProfit != null) {
    const favExtreme = i.side === "BUY" ? b.h : b.l;
    const favWick = i.side === "BUY" ? b.h - Math.max(b.o, b.c) : Math.min(b.o, b.c) - b.l;
    const favWickRatio = favWick / range;
    const closedShort = i.side === "BUY" ? b.c < b.h - buffer : b.c > b.l + buffer;
    const toTarget = Math.abs(i.takeProfit - i.entryPrice);
    const reached = i.side === "BUY" ? favExtreme >= i.takeProfit - toTarget * FAKEOUT_TP_REACH_RATIO && favExtreme < i.takeProfit
      : favExtreme <= i.takeProfit + toTarget * FAKEOUT_TP_REACH_RATIO && favExtreme > i.takeProfit;
    if (favWickRatio >= FAKEOUT_SCORE_THRESHOLD / 100 && closedShort && reached && toTarget > 0) {
      const wanted = i.side === "BUY" ? favExtreme - buffer : favExtreme + buffer;
      // Only tighten, and keep the target on the profit side of the current price.
      const tightens = i.side === "BUY" ? wanted < i.takeProfit && wanted > i.currentPrice : wanted > i.takeProfit && wanted < i.currentPrice;
      if (tightens) {
        const newTp = round(wanted, digits);
        return {
          action: "SHIFT_TP", newStopLoss: null, newTakeProfit: newTp,
          reason: `price spiked to ${favExtreme} (within ${Math.round(FAKEOUT_TP_REACH_RATIO * 100)}% of your target ${i.takeProfit}) and snapped back; target brought in to ${newTp}`,
        };
      }
    }
  }
  return none(adverse.yes ? "fakeout seen but the stop is already clear of the wick" : adverse.reason);
}

export function fakeoutCopy(args: { assistantName: string; symbol: string; decision: FakeoutDecision; ok: boolean; blocked: string | null }): { title: string; message: string } {
  const what = args.decision.action === "SHIFT_SL" ? `stop loss to ${args.decision.newStopLoss}` : `take profit to ${args.decision.newTakeProfit}`;
  return args.ok
    ? { title: `${args.symbol}: ${args.assistantName} moved your ${args.decision.action === "SHIFT_SL" ? "stop loss" : "take profit"} (fakeout)`,
        message: `${args.assistantName} sent a change of your ${args.symbol} ${what} because ${args.decision.reason}. You gave me authority to do this for fakeouts on this position; if you disagree, set the level back in the position panel. The broker confirms the change, not this message.` }
    : { title: `${args.symbol}: ${args.assistantName} could not move your ${args.decision.action === "SHIFT_SL" ? "stop loss" : "take profit"}`,
        message: `${args.assistantName} wanted to move your ${args.symbol} ${what} (${args.decision.reason}) but a safety gate refused: ${args.blocked ?? "unknown"}. Please check the position yourself.` };
}
