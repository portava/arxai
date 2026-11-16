// Phase UX6 — Price-action classifier.
//
// Pure function: given a MarketContext, returns 11 scores + a label + an
// explanation grounded in the actual TF observations used. No fabrication.

import type { MarketContext, TimeframeContext, Timeframe } from "./contextBuilder.js";

export type ClassificationLabel =
  | "Strong continuation" | "Weak continuation"
  | "Healthy pullback" | "Deep retracement"
  | "Reversal risk rising"
  | "Possible fakeout" | "Liquidity sweep possible"
  | "Breakout holding" | "Failed breakout"
  | "Choppy / no clear edge"
  | "Data insufficient";

export interface ClassificationResult {
  scores: {
    continuationScore: number | null;
    pullbackScore: number | null;
    retracementScore: number | null;
    reversalRiskScore: number | null;
    fakeoutRiskScore: number | null;
    liquiditySweepScore: number | null;
    chopRiskScore: number | null;
    breakoutStrengthScore: number | null;
    trendStrengthScore: number | null;
    momentumStrengthScore: number | null;
    volatilityRiskScore: number | null;
  };
  label: ClassificationLabel;
  explanation: string;
  evidence: string[];
  dataQuality: MarketContext["dataQuality"];
  primaryTimeframe: Timeframe | null;
  htfTimeframe: Timeframe | null;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

function pickPrimary(ctx: MarketContext): { primary: TimeframeContext | null; htf: TimeframeContext | null } {
  const order: Timeframe[] = ["M15", "M5", "M30", "H1", "M1"];
  const htfOrder: Timeframe[] = ["H4", "H1", "D1", "M30"];
  const primary = order.map((t) => ctx.timeframes[t]).find((t) => t.available) ?? null;
  const htf = htfOrder.map((t) => ctx.timeframes[t]).find((t) => t.available && t.timeframe !== primary?.timeframe) ?? null;
  return { primary, htf };
}

export function classify(ctx: MarketContext): ClassificationResult {
  const { primary, htf } = pickPrimary(ctx);
  const evidence: string[] = [];

  // Insufficient data short-circuit.
  if (!primary || !primary.available || ctx.currentPrice == null) {
    return {
      scores: {
        continuationScore: null, pullbackScore: null, retracementScore: null,
        reversalRiskScore: null, fakeoutRiskScore: null, liquiditySweepScore: null,
        chopRiskScore: null, breakoutStrengthScore: null,
        trendStrengthScore: null, momentumStrengthScore: null, volatilityRiskScore: null,
      },
      label: "Data insufficient",
      explanation: "Live candle data is not available for this symbol, so a price-action classification cannot be made.",
      evidence: [],
      dataQuality: ctx.dataQuality,
      primaryTimeframe: null, htfTimeframe: null,
    };
  }

  const price = ctx.currentPrice;
  const trend = primary.trendDirection;
  const trendStr = primary.trendStrengthScore ?? 0;
  const htfTrend = htf?.trendDirection ?? "UNKNOWN";
  const htfStr = htf?.trendStrengthScore ?? 0;
  const swingHigh = primary.swingHigh;
  const swingLow = primary.swingLow;
  const rangeHigh = primary.rangeHigh;
  const rangeLow = primary.rangeLow;
  const atr = primary.atr;

  evidence.push(`${primary.timeframe} trend=${trend} strength=${trendStr}`);
  if (htf) evidence.push(`${htf.timeframe} trend=${htfTrend} strength=${htfStr}`);
  if (atr != null) evidence.push(`ATR(14)=${atr}`);
  if (swingHigh != null && swingLow != null) evidence.push(`recent swing range ${swingLow}..${swingHigh}`);

  // Trend strength: average of primary + HTF.
  const trendStrengthScore = clamp(htf ? (trendStr * 0.55 + htfStr * 0.45) : trendStr);

  // Momentum: distance of price from recent SMA, sign by trend.
  const momentumPx = (price - (primary.lastClose ?? price));
  const momentumStrengthScore = clamp(50 + (momentumPx / (atr || 1)) * 30);

  // Volatility risk: ATR normalized vs price.
  const volPct = atr != null ? (atr / price) * 100 : null;
  const volatilityRiskScore = volPct == null ? null
    : clamp(volPct < 0.05 ? 20 : volPct < 0.15 ? 35 : volPct < 0.35 ? 55 : volPct < 0.7 ? 75 : 90);

  // Continuation: HTF trend aligned + recent close beyond mid-range in trend direction.
  let continuationScore = 50;
  if (htfTrend === trend && trend !== "FLAT" && trend !== "UNKNOWN") {
    continuationScore += 25;
    evidence.push("HTF aligned with primary trend");
  }
  if (trend === "UP" && rangeHigh != null && price > (rangeLow! + rangeHigh) / 2) continuationScore += 10;
  if (trend === "DOWN" && rangeLow != null && price < (rangeLow + rangeHigh!) / 2) continuationScore += 10;
  if (trendStr > 60) continuationScore += 10;
  continuationScore = clamp(continuationScore);

  // Pullback: in trend but price retraced from extreme without breaking opposite swing.
  let pullbackScore: number | null = null;
  if (trend === "UP" && swingLow != null && rangeHigh != null) {
    const retracePct = (rangeHigh - price) / Math.max(1e-9, rangeHigh - swingLow);
    if (retracePct > 0.15 && retracePct < 0.5 && price > swingLow) {
      pullbackScore = clamp(70 - retracePct * 30);
      evidence.push(`UP pullback ${(retracePct * 100).toFixed(0)}% from range high, above swing low`);
    } else pullbackScore = clamp(40 - Math.abs(retracePct - 0.3) * 50);
  } else if (trend === "DOWN" && swingHigh != null && rangeLow != null) {
    const retracePct = (price - rangeLow) / Math.max(1e-9, swingHigh - rangeLow);
    if (retracePct > 0.15 && retracePct < 0.5 && price < swingHigh) {
      pullbackScore = clamp(70 - retracePct * 30);
      evidence.push(`DOWN pullback ${(retracePct * 100).toFixed(0)}% from range low, below swing high`);
    } else pullbackScore = clamp(40 - Math.abs(retracePct - 0.3) * 50);
  }

  // Retracement (deeper than pullback, but structure still intact).
  let retracementScore: number | null = null;
  if (trend === "UP" && swingLow != null && rangeHigh != null) {
    const r = (rangeHigh - price) / Math.max(1e-9, rangeHigh - swingLow);
    retracementScore = clamp(r > 0.5 && r < 0.85 ? 30 + r * 60 : 20);
  } else if (trend === "DOWN" && swingHigh != null && rangeLow != null) {
    const r = (price - rangeLow) / Math.max(1e-9, swingHigh - rangeLow);
    retracementScore = clamp(r > 0.5 && r < 0.85 ? 30 + r * 60 : 20);
  }

  // Reversal risk: HTF turning against primary, or structure broken.
  let reversalRiskScore = 30;
  if (htfTrend !== "UNKNOWN" && htfTrend !== "FLAT" && htfTrend !== trend) {
    reversalRiskScore += 30;
    evidence.push(`HTF trend ${htfTrend} disagrees with ${primary.timeframe} ${trend}`);
  }
  if (trend === "UP" && swingLow != null && price < swingLow) {
    reversalRiskScore += 30;
    evidence.push(`Price broke below ${primary.timeframe} swing low → bullish structure broken`);
  }
  if (trend === "DOWN" && swingHigh != null && price > swingHigh) {
    reversalRiskScore += 30;
    evidence.push(`Price broke above ${primary.timeframe} swing high → bearish structure broken`);
  }
  reversalRiskScore = clamp(reversalRiskScore);

  // Fakeout: price swept rangeHigh/Low and closed back inside.
  let fakeoutRiskScore = 20;
  const lastClose = primary.lastClose ?? price;
  if (rangeHigh != null && rangeLow != null) {
    const swept = (price > rangeHigh && lastClose < rangeHigh) || (price < rangeLow && lastClose > rangeLow);
    if (swept) {
      fakeoutRiskScore = 75;
      evidence.push("Price swept range extreme and closed back inside → possible fakeout");
    }
  }
  fakeoutRiskScore = clamp(fakeoutRiskScore);

  // Liquidity sweep: wick beyond swing then close back (proxy via last candle).
  let liquiditySweepScore: number | null = null;
  if (atr != null) {
    if (trend === "UP" && swingLow != null && price > swingLow && lastClose < swingLow) {
      liquiditySweepScore = 70;
      evidence.push("Wick swept swing low then close back above → liquidity sweep");
    } else if (trend === "DOWN" && swingHigh != null && price < swingHigh && lastClose > swingHigh) {
      liquiditySweepScore = 70;
      evidence.push("Wick swept swing high then close back below → liquidity sweep");
    } else liquiditySweepScore = 20;
  }

  // Chop: low trend strength, tight ATR, no clear direction.
  let chopRiskScore: number | null = null;
  if (atr != null && rangeHigh != null && rangeLow != null) {
    const rangePct = ((rangeHigh - rangeLow) / price) * 100;
    chopRiskScore = clamp(
      (trendStr < 35 ? 35 : 10) +
      (rangePct < 0.3 ? 30 : rangePct < 0.6 ? 15 : 0) +
      (trend === "FLAT" || trend === "UNKNOWN" ? 25 : 0),
    );
    if (chopRiskScore > 60) evidence.push(`Range only ${rangePct.toFixed(2)}% with weak trend → choppy`);
  }

  // Breakout strength: price beyond rangeHigh/rangeLow with momentum in trend.
  let breakoutStrengthScore: number | null = null;
  if (rangeHigh != null && rangeLow != null && atr != null) {
    if (trend === "UP" && price > rangeHigh) {
      const dist = (price - rangeHigh) / atr;
      breakoutStrengthScore = clamp(60 + dist * 20);
    } else if (trend === "DOWN" && price < rangeLow) {
      const dist = (rangeLow - price) / atr;
      breakoutStrengthScore = clamp(60 + dist * 20);
    } else breakoutStrengthScore = 30;
  }

  // Label selection.
  let label: ClassificationLabel = "Choppy / no clear edge";
  if (chopRiskScore != null && chopRiskScore >= 65) label = "Choppy / no clear edge";
  else if (liquiditySweepScore != null && liquiditySweepScore >= 65) label = "Liquidity sweep possible";
  else if (fakeoutRiskScore >= 65) label = "Possible fakeout";
  else if (reversalRiskScore >= 70) label = "Reversal risk rising";
  else if (breakoutStrengthScore != null && breakoutStrengthScore >= 70) label = "Breakout holding";
  else if (breakoutStrengthScore != null && breakoutStrengthScore < 40 && (trend === "UP" || trend === "DOWN") && rangeHigh != null && rangeLow != null
           && ((trend === "UP" && price < rangeHigh && lastClose < rangeHigh)
            || (trend === "DOWN" && price > rangeLow && lastClose > rangeLow))) label = "Failed breakout";
  else if (retracementScore != null && retracementScore >= 60) label = "Deep retracement";
  else if (pullbackScore != null && pullbackScore >= 55) label = "Healthy pullback";
  else if (continuationScore >= 75) label = "Strong continuation";
  else if (continuationScore >= 55) label = "Weak continuation";

  const explanation = buildExplanation(label, primary, htf, ctx, evidence);

  return {
    scores: {
      continuationScore, pullbackScore, retracementScore,
      reversalRiskScore, fakeoutRiskScore, liquiditySweepScore,
      chopRiskScore, breakoutStrengthScore,
      trendStrengthScore, momentumStrengthScore, volatilityRiskScore,
    },
    label,
    explanation,
    evidence,
    dataQuality: ctx.dataQuality,
    primaryTimeframe: primary.timeframe,
    htfTimeframe: htf?.timeframe ?? null,
  };
}

function buildExplanation(
  label: ClassificationLabel, primary: TimeframeContext, htf: TimeframeContext | null,
  ctx: MarketContext, evidence: string[],
): string {
  const tf = primary.timeframe;
  const htfTag = htf ? `${htf.timeframe} ${htf.trendDirection}` : "no HTF data";
  const price = ctx.currentPrice;
  switch (label) {
    case "Strong continuation":
      return `${tf} trend is ${primary.trendDirection} with strength ${primary.trendStrengthScore}, and ${htfTag} agrees. Price ${price} is on the trend side of the recent range, so this looks like strong continuation based on available data.`;
    case "Weak continuation":
      return `${tf} trend is ${primary.trendDirection} but momentum is mixed. Continuation is possible but not strongly confirmed.`;
    case "Healthy pullback":
      return `Price is still respecting the prior swing structure on ${tf}, so the move against the trend looks like a pullback rather than a reversal — unless that swing level breaks.`;
    case "Deep retracement":
      return `Price has retraced more than half of the recent leg on ${tf}. The trend is still technically intact but stretched.`;
    case "Reversal risk rising":
      return `Reversal risk is elevated: ${evidence.find((e) => e.includes("disagrees") || e.includes("structure broken")) ?? "structure conditions weakened"}.`;
    case "Possible fakeout":
      return `Price pushed past the recent range extreme on ${tf} but closed back inside, which is a classic fakeout pattern.`;
    case "Liquidity sweep possible":
      return `A wick swept beyond a key swing on ${tf} and price returned, which often signals a liquidity sweep before continuation in the opposite direction.`;
    case "Breakout holding":
      return `Price has broken beyond the recent ${tf} range and is holding, suggesting breakout strength based on available data.`;
    case "Failed breakout":
      return `A breakout attempt on ${tf} did not hold — price returned inside the range, weakening the bullish/bearish case.`;
    case "Choppy / no clear edge":
      return `${tf} range is tight and trend strength is low. The market does not show a clear edge right now.`;
    case "Data insufficient":
      return "Live candle data is not available, so a price-action classification cannot be made.";
  }
}
