// Phase 7D/7E/7F — Deterministic playbook engine.
// Pure functions over user data. No I/O, no broker calls, no LLM.
import type { PaperTrade, AiTradeReview, UserPlaybook, PlaybookRuleV2 } from "@workspace/db";

export type GeneratedPlaybook = {
  title: string; description: string; strategyType: string;
  marketType: string | null; preferredSymbols: string[]; preferredSessions: string[];
  timeframe: string | null;
  entryModel: string; exitModel: string; riskModel: string;
  invalidationRules: string[]; confirmationRules: string[]; avoidRules: string[];
  checklist: string[];
  source: "ai_generated" | "from_trade_history" | "from_single_trade";
  confidenceScore: number; winRateSnapshot: number | null; sampleSize: number;
  rules: Array<{ ruleType: PlaybookRuleV2["ruleType"]; ruleText: string; severity: PlaybookRuleV2["severity"]; orderIndex: number }>;
  notice: string | null;
};

function topItem<T>(arr: T[], key: (x: T) => string): { value: string; count: number } | null {
  const m = new Map<string, number>();
  for (const x of arr) { const k = key(x); if (!k) continue; m.set(k, (m.get(k) ?? 0) + 1); }
  if (m.size === 0) return null;
  const [value, count] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { value, count };
}

export function generatePlaybookFromHistory(
  trades: PaperTrade[],
  reviews: AiTradeReview[],
): GeneratedPlaybook {
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const winRate = closed.length ? Number(((wins.length / closed.length) * 100).toFixed(1)) : null;

  const topStrategy = topItem(wins.length >= 3 ? wins : closed, (t) => t.strategyTag ?? "");
  const topSymbol = topItem(closed, (t) => t.symbol);
  const winSymbols = [...new Set(wins.map((t) => t.symbol))];

  const avgRR = (() => {
    const xs = closed.map((t) => t.rewardRiskRatio).filter((x): x is number => x != null);
    return xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null;
  })();
  const avgRiskPct = (() => {
    const xs = closed.map((t) => t.riskPercent).filter((x): x is number => x != null);
    return xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null;
  })();

  const mistakes = new Map<string, number>();
  for (const r of reviews) for (const m of r.mistakeTags ?? []) mistakes.set(m, (mistakes.get(m) ?? 0) + 1);
  for (const t of closed) for (const m of t.mistakeTags ?? []) mistakes.set(m, (mistakes.get(m) ?? 0) + 1);
  const topMistakes = [...mistakes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag]) => tag);

  const sample = closed.length;
  const isStarter = sample < 5;
  const strategyName = topStrategy?.value || "discretionary";
  const title = isStarter
    ? `Starter playbook (${strategyName})`
    : `${strategyName} on ${topSymbol?.value ?? "your top market"}`;

  const description = isStarter
    ? `Starter draft built from ${sample} closed paper trade${sample === 1 ? "" : "s"}. Test in paper mode and refine.`
    : `Built from ${sample} of your closed paper trades (${winRate}% win rate). Codifies what worked and what to avoid.`;

  const confirmationRules: string[] = [];
  if (avgRR != null) confirmationRules.push(`Reward:risk ≥ ${Math.max(1.5, avgRR).toFixed(1)}`);
  confirmationRules.push("Stop loss is defined before entry");
  confirmationRules.push("At least one sentence written explaining the setup");
  if (topStrategy) confirmationRules.push(`Setup matches the ${topStrategy.value} pattern`);

  const riskModel = avgRiskPct != null
    ? `Risk no more than ${Math.min(2, avgRiskPct).toFixed(1)}% of account per trade`
    : "Risk no more than 1% of account per trade";

  const entryModel = `Enter on ${strategyName} signal with confirmation. Avoid market entries without a planned price.`;
  const exitModel = "Honor the stop loss. Take profit at planned target or scale out at 1R and trail the runner.";

  const invalidationRules = ["Setup invalidated if price closes beyond stop loss", "Setup invalidated if confirmation never appears within the planned timeframe"];

  const avoidRules: string[] = [];
  if (topMistakes.includes("no_stop_loss")) avoidRules.push("Never enter without a stop loss");
  if (topMistakes.includes("no_reason_for_entry") || topMistakes.includes("no_journal")) avoidRules.push("Never enter without a written reason");
  if (topMistakes.includes("oversized_risk")) avoidRules.push("Never risk more than 2% on a single trade");
  if (topMistakes.includes("chased_entry")) avoidRules.push("Never chase entry — wait for retest at planned price");
  if (topMistakes.includes("closed_winner_early")) avoidRules.push("Do not exit a winner before the 1R partial");
  if (topMistakes.includes("held_loser_too_long")) avoidRules.push("Do not move stop loss away from entry");
  if (avoidRules.length === 0) avoidRules.push("Avoid trading during major news within 15 minutes either side");

  const checklist = [
    "Symbol matches preferred list",
    "Stop loss defined",
    "Take profit defined",
    "Reward:risk meets threshold",
    "Reason for entry written",
    "No avoid-rule triggered",
    "Within risk-per-trade cap",
  ];

  const rules: GeneratedPlaybook["rules"] = [];
  let order = 0;
  for (const r of confirmationRules) rules.push({ ruleType: "confirmation", ruleText: r, severity: "required", orderIndex: order++ });
  rules.push({ ruleType: "entry", ruleText: entryModel, severity: "required", orderIndex: order++ });
  rules.push({ ruleType: "exit", ruleText: exitModel, severity: "required", orderIndex: order++ });
  rules.push({ ruleType: "risk", ruleText: riskModel, severity: "required", orderIndex: order++ });
  for (const r of avoidRules) rules.push({ ruleType: "avoid", ruleText: r, severity: "required", orderIndex: order++ });
  for (const r of invalidationRules) rules.push({ ruleType: "exit", ruleText: r, severity: "recommended", orderIndex: order++ });
  rules.push({ ruleType: "psychology", ruleText: "Take a 1-hour cool-off after any losing trade before re-entering", severity: "recommended", orderIndex: order++ });

  return {
    title, description, strategyType: strategyName,
    marketType: null,
    preferredSymbols: winSymbols.length ? winSymbols.slice(0, 5) : (topSymbol ? [topSymbol.value] : []),
    preferredSessions: [],
    timeframe: null,
    entryModel, exitModel, riskModel,
    invalidationRules, confirmationRules, avoidRules, checklist,
    source: "from_trade_history",
    confidenceScore: Math.min(95, 30 + Math.min(50, sample * 5) + (winRate ? Math.min(15, winRate / 5) : 0)),
    winRateSnapshot: winRate, sampleSize: sample,
    rules,
    notice: isStarter ? "Not enough trade history yet. This playbook is a starter draft and should be tested in paper mode." : null,
  };
}

export function generatePlaybookFromSingleTrade(trade: PaperTrade, review: AiTradeReview | null): GeneratedPlaybook {
  const tag = trade.strategyTag ?? "discretionary";
  const won = (trade.pnl ?? 0) > 0;
  const confirmationRules: string[] = [];
  if (trade.rewardRiskRatio) confirmationRules.push(`Reward:risk ≥ ${Math.max(1.5, trade.rewardRiskRatio).toFixed(1)}`);
  if (trade.stopLoss != null) confirmationRules.push("Stop loss is defined before entry");
  if (trade.reasonForEntry) confirmationRules.push(`Setup matches: ${trade.reasonForEntry.slice(0, 120)}`);
  const avoidRules: string[] = [];
  for (const m of [...(trade.mistakeTags ?? []), ...(review?.mistakeTags ?? [])]) {
    if (m === "no_stop_loss") avoidRules.push("Never enter without a stop loss");
    if (m === "chased_entry") avoidRules.push("Never chase entry — wait for retest");
    if (m === "closed_winner_early") avoidRules.push("Do not close winners before 1R partial");
    if (m === "held_loser_too_long") avoidRules.push("Do not move stop loss away from entry");
  }
  if (avoidRules.length === 0) avoidRules.push("Avoid trading during major news");
  const rules: GeneratedPlaybook["rules"] = [];
  let order = 0;
  for (const r of confirmationRules) rules.push({ ruleType: "confirmation", ruleText: r, severity: "required", orderIndex: order++ });
  for (const r of avoidRules) rules.push({ ruleType: "avoid", ruleText: r, severity: "required", orderIndex: order++ });
  rules.push({ ruleType: "risk", ruleText: trade.riskPercent ? `Risk no more than ${Math.min(2, trade.riskPercent)}%` : "Risk no more than 1%", severity: "required", orderIndex: order++ });
  return {
    title: `${tag} on ${trade.symbol}${won ? " (winning template)" : " (post-mortem template)"}`,
    description: won
      ? `Promoted from a winning paper trade (PnL ${trade.pnl}). Validate in paper mode before considering live.`
      : `Promoted from a losing paper trade. Designed to prevent the mistakes observed.`,
    strategyType: tag, marketType: null,
    preferredSymbols: [trade.symbol], preferredSessions: [],
    timeframe: null,
    entryModel: trade.reasonForEntry ?? `Enter on ${tag} signal with confirmation`,
    exitModel: trade.reasonForExit ?? "Honor stop loss; take profit at planned target",
    riskModel: trade.riskPercent ? `Risk ≤ ${Math.min(2, trade.riskPercent)}% of account` : "Risk ≤ 1% of account",
    invalidationRules: ["Setup invalidated if price closes beyond stop loss"],
    confirmationRules, avoidRules,
    checklist: ["Stop loss defined", "Reward:risk meets threshold", "Reason written", "No avoid-rule triggered"],
    source: "from_single_trade",
    confidenceScore: won ? 60 : 50,
    winRateSnapshot: null, sampleSize: 1,
    rules,
    notice: "Built from a single trade. Treat as a draft and refine after testing in paper mode.",
  };
}

// ── Pre-trade checklist evaluator ────────────────────────────────────────
export type PreTradeInput = {
  symbol: string; side?: string | null;
  stopLoss?: number | null; takeProfit?: number | null;
  entryPrice?: number | null; lotSize?: number | null;
  riskAmount?: number | null; riskPercent?: number | null;
  rewardRiskRatio?: number | null; reasonForEntry?: string | null;
};

export type PreTradeResult = {
  decision: "pass" | "warning" | "block";
  score: number;
  passedRequiredCount: number; failedRequiredCount: number;
  checklistResult: Array<{ rule: string; severity: string; passed: boolean; ruleType: string }>;
  failedRules: string[]; passedRules: string[];
  improvementNote: string;
};

export function evaluatePreTradeCheck(
  playbook: UserPlaybook,
  rules: PlaybookRuleV2[],
  input: PreTradeInput,
  recentBehavior?: { lastClosedWasLoss: boolean; tradesInLastHour: number },
): PreTradeResult {
  const items: Array<{ rule: string; severity: string; passed: boolean; ruleType: string }> = [];

  // Built-in structural checks
  const symbolOk = !playbook.preferredSymbols?.length || playbook.preferredSymbols.includes(input.symbol);
  items.push({ rule: `Symbol ${input.symbol} is allowed by playbook`, severity: "required", passed: symbolOk, ruleType: "entry" });
  items.push({ rule: "Stop loss defined", severity: "required", passed: input.stopLoss != null, ruleType: "risk" });
  items.push({ rule: "Take profit defined", severity: "recommended", passed: input.takeProfit != null, ruleType: "risk" });
  const rrOk = input.rewardRiskRatio != null && input.rewardRiskRatio >= 1.5;
  items.push({ rule: "Reward:risk ≥ 1.5", severity: "required", passed: rrOk, ruleType: "risk" });
  const riskOk = input.riskPercent == null || input.riskPercent <= 2;
  items.push({ rule: "Risk per trade ≤ 2%", severity: "required", passed: riskOk, ruleType: "risk" });
  items.push({ rule: "Reason for entry written", severity: "required", passed: !!(input.reasonForEntry && input.reasonForEntry.trim().length >= 5), ruleType: "entry" });

  // Behavioral guards
  if (recentBehavior) {
    items.push({ rule: "Not entering within 1h of a losing trade (cool-off)", severity: "required", passed: !recentBehavior.lastClosedWasLoss, ruleType: "psychology" });
    items.push({ rule: "Fewer than 5 trades in the last hour (no overtrading)", severity: "recommended", passed: recentBehavior.tradesInLastHour < 5, ruleType: "psychology" });
  }

  // Avoid-rule trip detection (text-match against reason/symbol)
  const reason = (input.reasonForEntry ?? "").toLowerCase();
  for (const r of rules.filter((x) => x.ruleType === "avoid")) {
    const trip = r.ruleText.toLowerCase().includes("news") && reason.includes("news");
    items.push({ rule: r.ruleText, severity: r.severity, passed: !trip, ruleType: "avoid" });
  }
  for (const r of rules.filter((x) => x.ruleType === "confirmation")) {
    let pass = true;
    if (/stop loss/i.test(r.ruleText)) pass = input.stopLoss != null;
    else if (/reward.*risk/i.test(r.ruleText)) pass = rrOk;
    else if (/sentence|reason|written/i.test(r.ruleText)) pass = !!(input.reasonForEntry && input.reasonForEntry.trim().length >= 5);
    items.push({ rule: r.ruleText, severity: r.severity, passed: pass, ruleType: "confirmation" });
  }

  const required = items.filter((i) => i.severity === "required");
  const passedRequired = required.filter((i) => i.passed).length;
  const failedRequired = required.length - passedRequired;
  const total = items.length;
  const passedTotal = items.filter((i) => i.passed).length;
  const score = total ? Math.round((passedTotal / total) * 100) : 0;

  let decision: "pass" | "warning" | "block";
  if (failedRequired === 0 && score >= 85) decision = "pass";
  else if (failedRequired >= 2 || score < 60) decision = "block";
  else decision = "warning";

  const failedRules = items.filter((i) => !i.passed).map((i) => i.rule);
  const passedRules = items.filter((i) => i.passed).map((i) => i.rule);
  const improvementNote = failedRules.length === 0
    ? "All required checks passed. Trade aligned with your playbook — paper-test the execution."
    : `Address before entering (paper mode): ${failedRules.slice(0, 3).join("; ")}`;

  return { decision, score, passedRequiredCount: passedRequired, failedRequiredCount: failedRequired, checklistResult: items, failedRules, passedRules, improvementNote };
}
