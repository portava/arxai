import type {
  CandleClosesParamsSchema, ClosedCandle, ConditionEvaluation, EvaluationContext,
} from "../conditionalExecution.types";
import type { z } from "zod/v4";

type Params = z.infer<typeof CandleClosesParamsSchema>;

// candleCloses — confirmation candle.
//   • NEXT: the FIRST candle that closes after arming must match the
//     required direction with body ≥ minBodyPips. A wrong-direction first
//     close → PERMANENTLY_IMPOSSIBLE (the confirmation chance is gone).
//   • ANY_IN_WINDOW: any closed candle in the validity window can satisfy;
//     wrong closes are ignored, condition stays PENDING.
export function evaluateCandleCloses(
  params: Params,
  ctx: EvaluationContext,
): ConditionEvaluation {
  const candles = ctx.recentClosedCandles;
  if (candles.length === 0) {
    return { kind: "CANDLE_CLOSES", status: "PENDING", reasons: ["no candle has closed yet"] };
  }
  // "First close AFTER arming" — use closeTime, not openTime. A candle
  // that opened before arming but closed after arming IS the first close
  // we observed; using openTime would skip it and let a wrong-direction
  // close slip past the NEXT-mode invalidation gate.
  const armedTime = Date.parse(ctx.armedAt);
  const candlesAfterArm = candles.filter((c) => Date.parse(c.closeTime) > armedTime);

  if (params.mode === "NEXT") {
    if (candlesAfterArm.length === 0) {
      return { kind: "CANDLE_CLOSES", status: "PENDING", reasons: ["next candle has not yet closed"] };
    }
    const first = candlesAfterArm[0];
    const ok = matchesCandle(first, params, ctx.pipSize);
    if (ok.matches) {
      return {
        kind: "CANDLE_CLOSES", status: "SATISFIED",
        reasons: [`first close after arming matched: ${ok.detail}`],
      };
    }
    return {
      kind: "CANDLE_CLOSES", status: "PERMANENTLY_IMPOSSIBLE",
      reasons: [`first close after arming was wrong (${ok.detail}) — confirmation chance gone`],
    };
  }

  // ANY_IN_WINDOW
  for (const c of candlesAfterArm) {
    const ok = matchesCandle(c, params, ctx.pipSize);
    if (ok.matches) {
      return {
        kind: "CANDLE_CLOSES", status: "SATISFIED",
        reasons: [`closed ${params.direction.toLowerCase()} candle observed: ${ok.detail}`],
      };
    }
  }
  return {
    kind: "CANDLE_CLOSES", status: "PENDING",
    reasons: [`${candlesAfterArm.length} candle(s) closed since arming, none matched ${params.direction} body ≥ ${params.minBodyPips}p`],
  };
}

function matchesCandle(c: ClosedCandle, params: Params, pipSize: number): { matches: boolean; detail: string } {
  const isBull = c.close > c.open;
  const isBear = c.close < c.open;
  const wantBull = params.direction === "BULLISH";
  const wantBear = params.direction === "BEARISH";
  const bodyPips = Math.abs(c.close - c.open) / pipSize;
  const dirMatches = (wantBull && isBull) || (wantBear && isBear);
  const bodyMatches = bodyPips >= params.minBodyPips;
  const detail = `${isBull ? "BULL" : isBear ? "BEAR" : "DOJI"} body ${bodyPips.toFixed(1)}p`;
  return { matches: dirMatches && bodyMatches, detail };
}
