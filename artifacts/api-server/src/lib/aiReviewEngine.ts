// Phase 6C/6D/6E — Deterministic AI review engine.
// SAFETY: pure functions over user data. No I/O, no broker calls, no LLM API.
// Output is structured grades + insights + coaching plan.

import type { PaperTrade } from "@workspace/db";

export type Grade = "A" | "B" | "C" | "D" | "F";

function letterFromScore(s: number): Grade {
  if (s >= 90) return "A";
  if (s >= 75) return "B";
  if (s >= 60) return "C";
  if (s >= 45) return "D";
  return "F";
}

export type TradeReviewInput = {
  trade: PaperTrade;
  journalNotes?: string | null;
  disciplineScore?: number | null;
  executionScore?: number | null;
};

export type TradeReviewOutput = {
  setupGrade: Grade; entryGrade: Grade; exitGrade: Grade;
  riskGrade: Grade; disciplineGrade: Grade; overallGrade: Grade;
  overallScore: number; aiConfidence: number;
  strengths: string[]; weaknesses: string[]; mistakeTags: string[];
  riskNotes: string; entryNotes: string; exitNotes: string; disciplineNotes: string;
  improvementPlan: string[]; nextTradeFocus: string;
};

export function reviewTrade(inp: TradeReviewInput): TradeReviewOutput {
  const t = inp.trade;
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const mistakeTags = new Set<string>(t.mistakeTags ?? []);
  const plan: string[] = [];

  // ── 1. SETUP — was it planned & rationale captured?
  let setup = 50;
  if (t.plannedEntryPrice != null) { setup += 15; strengths.push("Entry was pre-planned"); }
  else { weaknesses.push("Entered without a planned entry price"); mistakeTags.add("no_plan"); }
  if (t.strategyTag) { setup += 10; strengths.push(`Tagged strategy: ${t.strategyTag}`); }
  else { weaknesses.push("No strategy tag — pattern tracking is impossible"); mistakeTags.add("no_strategy_tag"); }
  if (t.reasonForEntry && t.reasonForEntry.trim().length >= 10) { setup += 15; strengths.push("Documented reason for entry"); }
  else { weaknesses.push("Missing or vague reason for entry"); mistakeTags.add("no_reason_for_entry"); plan.push("Always write at least one sentence justifying the setup before entering"); }
  if (t.setupGrade === "A") setup += 10; else if (t.setupGrade === "D") setup -= 10;

  // ── 2. RISK — SL defined, RR ≥ 1.5, risk capped
  let risk = 50;
  if (t.stopLoss != null) { risk += 20; strengths.push("Stop loss defined"); }
  else { weaknesses.push("No stop loss — uncapped downside"); mistakeTags.add("no_stop_loss"); risk -= 20; plan.push("Set a hard stop loss before every entry"); }
  if (t.takeProfit != null) risk += 5;
  const rr = t.rewardRiskRatio;
  if (rr != null && rr >= 2) { risk += 15; strengths.push(`Healthy reward:risk (${rr})`); }
  else if (rr != null && rr >= 1) { risk += 5; }
  else if (rr != null && rr < 1) { risk -= 15; weaknesses.push(`Poor reward:risk (${rr})`); mistakeTags.add("poor_rr"); plan.push("Skip setups with reward:risk below 1.5"); }
  if (t.riskPercent != null && t.riskPercent > 2) { risk -= 15; weaknesses.push(`Risked ${t.riskPercent}% — exceeds 2% rule`); mistakeTags.add("oversized_risk"); }

  // ── 3. ENTRY — actual close to planned, side aligned with bias
  let entry = 60;
  if (t.entryPrice != null && t.plannedEntryPrice != null) {
    const slip = Math.abs(t.entryPrice - t.plannedEntryPrice) / Math.max(1e-9, t.plannedEntryPrice);
    if (slip < 0.001) { entry += 20; strengths.push("Entry filled near plan"); }
    else if (slip > 0.01) { entry -= 15; weaknesses.push("Significant slippage / chased entry"); mistakeTags.add("chased_entry"); }
  }
  if (t.entryType === "manual") entry -= 5;

  // ── 4. EXIT — disciplined vs emotional
  let exit = 60;
  const pnl = t.pnl ?? 0;
  if (t.exitPrice != null && t.takeProfit != null && t.stopLoss != null && t.entryPrice != null) {
    const hitTp = (t.side === "buy" ? t.exitPrice >= t.takeProfit : t.exitPrice <= t.takeProfit);
    const hitSl = (t.side === "buy" ? t.exitPrice <= t.stopLoss : t.exitPrice >= t.stopLoss);
    if (hitTp) { exit += 25; strengths.push("Held to target — let winner run"); }
    else if (hitSl) { exit += 5; strengths.push("Honored stop loss"); }
    else if (pnl > 0) { exit -= 5; weaknesses.push("Closed winner early — left profit on the table"); mistakeTags.add("closed_winner_early"); plan.push("Use partials at 1R, hold runner to TP"); }
    else if (pnl < 0) { exit -= 15; weaknesses.push("Cut loss late or moved stop further"); mistakeTags.add("held_loser_too_long"); plan.push("Never widen a stop — accept the planned loss"); }
  }
  if (!t.reasonForExit) { exit -= 5; mistakeTags.add("no_reason_for_exit"); }

  // ── 5. DISCIPLINE
  let discipline = 60;
  if (inp.disciplineScore != null) discipline = Math.round((discipline + inp.disciplineScore) / 2);
  if (inp.executionScore != null) discipline = Math.round((discipline + inp.executionScore) / 2);
  if (inp.journalNotes && inp.journalNotes.trim().length > 30) { discipline += 10; strengths.push("Journaled the trade"); }
  else { weaknesses.push("Trade not journaled"); mistakeTags.add("no_journal"); plan.push("Add a journal entry within 1 hour of close"); }

  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  setup = clamp(setup); risk = clamp(risk); entry = clamp(entry); exit = clamp(exit); discipline = clamp(discipline);
  const overall = clamp(Math.round((setup + risk + entry + exit + discipline) / 5));

  // Confidence: how much input data we had
  const dataPoints = [t.plannedEntryPrice, t.entryPrice, t.exitPrice, t.stopLoss, t.takeProfit, t.riskAmount, t.strategyTag, t.reasonForEntry, t.reasonForExit, inp.journalNotes].filter((x) => x != null && x !== "").length;
  const aiConfidence = clamp(40 + dataPoints * 6);

  return {
    setupGrade: letterFromScore(setup),
    entryGrade: letterFromScore(entry),
    exitGrade: letterFromScore(exit),
    riskGrade: letterFromScore(risk),
    disciplineGrade: letterFromScore(discipline),
    overallGrade: letterFromScore(overall),
    overallScore: overall, aiConfidence,
    strengths, weaknesses,
    mistakeTags: Array.from(mistakeTags),
    riskNotes: `Score ${risk}/100. ${rr != null ? `RR ${rr}.` : "No RR computable."} ${t.stopLoss == null ? "No stop loss." : ""}`.trim(),
    entryNotes: `Score ${entry}/100. ${t.entryType} entry${t.plannedEntryPrice ? `, planned @ ${t.plannedEntryPrice}` : ""}.`,
    exitNotes: `Score ${exit}/100. ${t.exitPrice ? `Exited @ ${t.exitPrice} (PnL ${pnl}).` : "Not yet exited."}`,
    disciplineNotes: `Score ${discipline}/100. ${inp.journalNotes ? "Journaled." : "No journal."}`,
    improvementPlan: plan.length ? plan : ["Keep current process — log next trade for trend confirmation"],
    nextTradeFocus: weaknesses[0] ?? "Maintain process discipline on next setup",
  };
}

// ── Pattern detection across many trades ─────────────────────────────────
export type Insight = { severity: "info" | "warning" | "critical"; title: string; detail: string };

export function detectPatterns(trades: PaperTrade[]): {
  topSymbols: Array<{ symbol: string; count: number; winRate: number }>;
  byStrategy: Array<{ strategy: string; count: number; winRate: number; avgPnl: number }>;
  averages: { avgWin: number; avgLoss: number; expectancy: number };
  bestDay: { date: string; pnl: number } | null;
  worstDay: { date: string; pnl: number } | null;
  topMistakes: Array<{ tag: string; count: number }>;
  insights: Insight[];
} {
  const closed = trades.filter((t) => t.status === "closed");
  const insights: Insight[] = [];

  // Symbols
  const sym = new Map<string, { c: number; w: number }>();
  for (const t of closed) {
    const r = sym.get(t.symbol) ?? { c: 0, w: 0 };
    r.c++; if ((t.pnl ?? 0) > 0) r.w++;
    sym.set(t.symbol, r);
  }
  const topSymbols = [...sym.entries()].map(([symbol, r]) => ({ symbol, count: r.c, winRate: Number(((r.w / r.c) * 100).toFixed(1)) })).sort((a, b) => b.count - a.count).slice(0, 8);

  // Strategy
  const strat = new Map<string, { c: number; w: number; pnl: number }>();
  for (const t of closed) {
    const k = t.strategyTag ?? "(untagged)";
    const r = strat.get(k) ?? { c: 0, w: 0, pnl: 0 };
    r.c++; if ((t.pnl ?? 0) > 0) r.w++; r.pnl += t.pnl ?? 0;
    strat.set(k, r);
  }
  const byStrategy = [...strat.entries()].map(([strategy, r]) => ({ strategy, count: r.c, winRate: Number(((r.w / r.c) * 100).toFixed(1)), avgPnl: Number((r.pnl / r.c).toFixed(4)) })).sort((a, b) => b.count - a.count);

  // Avg win/loss
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).map((t) => t.pnl ?? 0);
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0).map((t) => t.pnl ?? 0);
  const avgWin = wins.length ? Number((wins.reduce((a, b) => a + b, 0) / wins.length).toFixed(4)) : 0;
  const avgLoss = losses.length ? Number((losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(4)) : 0;
  const winRate = closed.length ? wins.length / closed.length : 0;
  const expectancy = Number((winRate * avgWin + (1 - winRate) * avgLoss).toFixed(4));

  // Day rollup
  const dayMap = new Map<string, number>();
  for (const t of closed) {
    if (!t.closedAt) continue;
    const d = t.closedAt.toISOString().slice(0, 10);
    dayMap.set(d, (dayMap.get(d) ?? 0) + (t.pnl ?? 0));
  }
  const days = [...dayMap.entries()].map(([date, pnl]) => ({ date, pnl: Number(pnl.toFixed(4)) }));
  const bestDay = days.reduce<{ date: string; pnl: number } | null>((b, d) => (b == null || d.pnl > b.pnl ? d : b), null);
  const worstDay = days.reduce<{ date: string; pnl: number } | null>((b, d) => (b == null || d.pnl < b.pnl ? d : b), null);

  // Mistake tags
  const mistakes = new Map<string, number>();
  for (const t of closed) for (const m of t.mistakeTags ?? []) mistakes.set(m, (mistakes.get(m) ?? 0) + 1);
  const topMistakes = [...mistakes.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 8);

  // Insights
  const withSL = closed.filter((t) => t.stopLoss != null);
  const woSL = closed.filter((t) => t.stopLoss == null);
  if (withSL.length >= 3 && woSL.length >= 3) {
    const wrSL = withSL.filter((t) => (t.pnl ?? 0) > 0).length / withSL.length;
    const wrNoSL = woSL.filter((t) => (t.pnl ?? 0) > 0).length / woSL.length;
    if (wrSL > wrNoSL + 0.1) insights.push({ severity: "info", title: "Stop loss boosts your win rate", detail: `Win rate ${Math.round(wrSL * 100)}% with SL vs ${Math.round(wrNoSL * 100)}% without.` });
  }
  const noReason = closed.filter((t) => !t.reasonForEntry);
  if (noReason.length >= 3) {
    const lossNoReason = noReason.filter((t) => (t.pnl ?? 0) < 0).length / noReason.length;
    if (lossNoReason > 0.5) insights.push({ severity: "warning", title: "Trades without a reason lose more often", detail: `${Math.round(lossNoReason * 100)}% of unjustified entries lost.` });
  }
  // Revenge / overtrading: ≥ 3 trades within 30min after a loss
  const sorted = [...closed].sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0));
  let revenge = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!; const cur = sorted[i]!;
    if ((prev.pnl ?? 0) < 0 && cur.openedAt && prev.closedAt && (cur.openedAt.getTime() - prev.closedAt.getTime()) < 30 * 60_000) revenge++;
  }
  if (revenge >= 2) insights.push({ severity: "critical", title: "Revenge trading detected", detail: `${revenge} trades opened within 30 min of a loss. Build a 1-hour cool-off rule.` });
  // Closing winners early
  const earlyExits = closed.filter((t) => (t.mistakeTags ?? []).includes("closed_winner_early"));
  if (earlyExits.length >= 2) insights.push({ severity: "warning", title: "Closing winners too early", detail: `${earlyExits.length} winners closed before target. Try scaling out instead.` });
  // Holding losers
  const heldLosers = closed.filter((t) => (t.mistakeTags ?? []).includes("held_loser_too_long"));
  if (heldLosers.length >= 2) insights.push({ severity: "critical", title: "Holding losers past stop", detail: `${heldLosers.length} losses ran past the planned stop. The stop is the rule, not a suggestion.` });
  // Best strategy
  if (byStrategy.length >= 1) {
    const best = byStrategy.slice().sort((a, b) => b.avgPnl - a.avgPnl)[0]!;
    if (best.count >= 3 && best.avgPnl > 0) insights.push({ severity: "info", title: `Your edge: ${best.strategy}`, detail: `Avg PnL ${best.avgPnl} across ${best.count} trades (${best.winRate}% win rate).` });
  }
  return { topSymbols, byStrategy, averages: { avgWin, avgLoss, expectancy }, bestDay, worstDay, topMistakes, insights };
}

export type CoachingPlan = {
  traderProfile: string;
  topStrengths: string[]; topWeaknesses: string[]; topMistakes: string[];
  recommendedFocus: string; riskRuleSuggestion: string;
  journalingPrompt: string; weeklyGoal: string; confidenceNote: string;
};

export function buildCoachingPlan(trades: PaperTrade[]): CoachingPlan {
  const closed = trades.filter((t) => t.status === "closed");
  const totalCount = closed.length;
  if (totalCount === 0) {
    return {
      traderProfile: "New trader — no closed trades yet",
      topStrengths: [], topWeaknesses: [], topMistakes: [],
      recommendedFocus: "Place and close your first paper trade with a defined stop loss and reason for entry.",
      riskRuleSuggestion: "Start with risking no more than 1% per trade.",
      journalingPrompt: "Why am I taking this trade right now? What is my invalidation level?",
      weeklyGoal: "Complete 5 fully-journaled paper trades.",
      confidenceNote: "Educational paper-trading guidance only — no live execution.",
    };
  }
  const p = detectPatterns(trades);
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const wr = (wins / totalCount) * 100;
  let profile = "Developing trader";
  if (wr >= 60 && p.averages.expectancy > 0) profile = "Consistent paper trader";
  else if (wr >= 45) profile = "Improving paper trader";
  else profile = "Trader rebuilding fundamentals";

  const strengths: string[] = [];
  if (p.averages.expectancy > 0) strengths.push(`Positive expectancy (${p.averages.expectancy})`);
  const bestStrat = p.byStrategy.slice().sort((a, b) => b.avgPnl - a.avgPnl)[0];
  if (bestStrat && bestStrat.avgPnl > 0) strengths.push(`${bestStrat.strategy} edge`);
  if (closed.filter((t) => t.stopLoss != null).length / totalCount > 0.8) strengths.push("Consistent stop placement");

  const weaknesses: string[] = [];
  if (closed.filter((t) => !t.reasonForEntry).length / totalCount > 0.3) weaknesses.push("Entries without documented reason");
  if (p.averages.avgLoss < -Math.abs(p.averages.avgWin)) weaknesses.push("Losses larger than wins");
  if (p.topMistakes[0]) weaknesses.push(`Repeating mistake: ${p.topMistakes[0].tag}`);

  return {
    traderProfile: profile,
    topStrengths: strengths.slice(0, 3),
    topWeaknesses: weaknesses.slice(0, 3),
    topMistakes: p.topMistakes.slice(0, 3).map((m) => `${m.tag} (×${m.count})`),
    recommendedFocus: weaknesses[0] ?? "Keep refining your best setup with tighter risk",
    riskRuleSuggestion: p.averages.avgLoss < -2 * Math.abs(p.averages.avgWin) ? "Halve your position size for the next 5 trades" : "Cap risk at 1% per trade until win rate stabilizes",
    journalingPrompt: "After closing today's trade, write: what was my plan? what did I actually do? what was the gap?",
    weeklyGoal: totalCount < 10 ? "Hit 10 fully-journaled paper trades this week" : `Lift expectancy above ${Math.max(0, p.averages.expectancy + 0.5).toFixed(2)}`,
    confidenceNote: "All guidance is educational and applies only to paper trading. Live execution remains locked.",
  };
}
