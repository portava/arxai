export interface TradeOutcomeInput {
  symbol: string;
  marketType?: string;
  strategy: string;
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  // NOTE: there is deliberately no `exit` field. It used to exist, was never
  // read by this function, and both call sites filled it by GUESSING —
  // "a winner closed at TP, a loser closed at SL". The `trades` table carries
  // no close-price column, so there is no real exit price to substitute; the
  // honest move is to make the guess unrepresentable (Theme A3).
  profitLoss: number;
  session?: string;
  marketCondition?: string;
  newsRisk?: string;
  volatilityState?: string;
  technicalBias?: string;
  macroBias?: string;
  holdTimeMinutes?: number;
}

export interface TradeOutcomeResult {
  outcome: "win" | "loss" | "breakeven";
  mistakeTags: string[];
  successTags: string[];
  entryQuality: number;
  exitQuality: number;
  riskQuality: number;
  lesson: string;
  suggestedAdjustment: string;
}

export const MISTAKE_TAGS = [
  "entered during chop",
  "entered before news",
  "stop too tight",
  "stop too wide",
  "poor risk reward",
  "low confidence trade",
  "ignored trend",
  // "late entry" / "early exit" were removed with the inverted hold-time rules
  // below — the vocabulary must not advertise a tag nothing can emit.
  "overtrading",
  "revenge trade risk",
  "abnormal volatility",
] as const;

export const SUCCESS_TAGS = [
  "trend aligned",
  "clean break of structure",
  "strong risk reward",
  "good session timing",
  "strong pullback entry",
  "volatility confirmed",
  "news avoided",
  "risk respected",
] as const;

export function analyzeTradeOutcome(t: TradeOutcomeInput): TradeOutcomeResult {
  const outcome: TradeOutcomeResult["outcome"] =
    t.profitLoss > 0.01 ? "win" : t.profitLoss < -0.01 ? "loss" : "breakeven";

  const risk = Math.abs(t.entry - t.stopLoss);
  const reward = Math.abs(t.takeProfit - t.entry);
  const rr = risk > 0 ? reward / risk : 0;

  const mistakeTags: string[] = [];
  const successTags: string[] = [];

  // Risk:reward
  if (rr < 1.2) mistakeTags.push("poor risk reward");
  if (rr >= 2) successTags.push("strong risk reward");

  // Confidence
  if (t.confidence < 60) mistakeTags.push("low confidence trade");

  // Stop sizing relative to typical move (~entry * 0.005 baseline)
  const stopPct = t.entry > 0 ? risk / t.entry : 0;
  if (stopPct > 0 && stopPct < 0.0008) mistakeTags.push("stop too tight");
  if (stopPct > 0.02) mistakeTags.push("stop too wide");

  // Market condition
  if ((t.marketCondition ?? "") === "chop") mistakeTags.push("entered during chop");
  if ((t.volatilityState ?? "") === "abnormal") mistakeTags.push("abnormal volatility");
  if ((t.newsRisk ?? "") === "high") mistakeTags.push("entered before news");
  if ((t.newsRisk ?? "") === "none") successTags.push("news avoided");

  // Bias alignment
  if (t.technicalBias && t.macroBias && t.technicalBias !== t.macroBias) mistakeTags.push("ignored trend");
  if (t.technicalBias === t.macroBias && t.technicalBias) successTags.push("trend aligned");

  // Hold time: no tag is inferred from duration alone.
  //
  // Two rules used to live here and both drew the wrong conclusion:
  //   <3-min LOSS → "late entry"  — a fast loss says the entry was wrong or the
  //                                 stop was tight; it says nothing about being
  //                                 late, and the same hold time on a winner was
  //                                 read as a virtue.
  //   <5-min WIN  → "early exit"  — a fast win is the normal shape of a trade
  //                                 that reached its target; calling it a
  //                                 mistake penalises the intended outcome.
  // Distinguishing either case needs the real close price and the excursion
  // path, neither of which this input carries.

  // Strategy hints
  if (t.strategy === "Break of Structure" && outcome === "win") successTags.push("clean break of structure");
  if (t.strategy === "Volatility Expansion" && outcome === "win") successTags.push("volatility confirmed");

  // Session
  if (t.session === "London" || t.session === "NewYork") successTags.push("good session timing");

  if (Math.abs(t.profitLoss) < risk * 0.4) successTags.push("risk respected");

  const entryQuality = clamp(50 + (t.confidence - 60) * 0.8 + (successTags.includes("trend aligned") ? 15 : 0) - (mistakeTags.includes("entered during chop") ? 20 : 0), 0, 100);
  const exitQuality = clamp(outcome === "win" ? 60 + Math.min(40, (t.profitLoss / Math.max(risk, 0.0001)) * 10) : 40 - Math.min(40, Math.abs(t.profitLoss) / Math.max(risk, 0.0001) * 10), 0, 100);
  const riskQuality = clamp(50 + (rr - 1) * 25 - (mistakeTags.includes("stop too tight") ? 20 : 0) - (mistakeTags.includes("stop too wide") ? 15 : 0), 0, 100);

  const lesson = buildLesson(outcome, mistakeTags, successTags, rr);
  const suggestedAdjustment = buildAdjustment(outcome, mistakeTags, t);

  return { outcome, mistakeTags, successTags, entryQuality, exitQuality, riskQuality, lesson, suggestedAdjustment };
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, Math.round(n))); }

function buildLesson(outcome: string, mistakes: string[], successes: string[], rr: number): string {
  if (outcome === "win" && mistakes.length === 0) return `Clean win at R:R ${rr.toFixed(2)}. Keep doing this.`;
  if (outcome === "win") return `Won despite warning signs (${mistakes[0]}). Don't take this as confirmation — review the entry.`;
  if (outcome === "loss" && mistakes.length > 0) return `Loss likely caused by: ${mistakes.slice(0, 2).join(", ")}. Avoid this setup until conditions change.`;
  if (outcome === "loss") return `Loss occurred even with valid setup. Review market context or reduce position size while pattern recovers.`;
  return successes.length > 0 ? `Breakeven trade — ${successes[0]} kept losses contained.` : `Breakeven outcome — re-check whether the setup met all rules.`;
}

function buildAdjustment(outcome: string, mistakes: string[], t: TradeOutcomeInput): string {
  if (mistakes.includes("low confidence trade")) return `Raise minimum confidence above ${t.confidence}.`;
  if (mistakes.includes("entered during chop")) return "Add chop filter or pause this strategy in sideways markets.";
  if (mistakes.includes("entered before news")) return "Block trading 30 min before high impact news on this currency.";
  if (mistakes.includes("stop too tight")) return "Use a stop ≥ 1× ATR; current stop was inside normal noise.";
  if (mistakes.includes("poor risk reward")) return "Skip setups with R:R below 1.5.";
  if (outcome === "loss") return "Reduce risk per trade by 25% on this strategy until win rate recovers.";
  return "No adjustment needed — keep current settings.";
}
