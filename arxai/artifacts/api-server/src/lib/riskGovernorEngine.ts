// Phase 8C — Deterministic Risk Governor engine.
// Pure functions. No I/O, no broker calls, no LLM.
// HARD RULE: any live execution intent is blocked regardless of override.
import type { UserRiskSettings, PaperTrade } from "@workspace/db";

export type RiskCheckInput = {
  symbol: string;
  side?: string | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  entryPrice?: number | null;
  lotSize?: number | null;
  riskAmount?: number | null;
  riskPercent?: number | null;
  rewardRiskRatio?: number | null;
  reasonForEntry?: string | null;
  // Phase 7 ties
  playbookId?: number | null;
  preTradeCheckPassed?: boolean | null;
  preTradeCheckDecision?: "pass" | "warning" | "block" | null;
  // Live intent — must always be false in this app
  liveExecutionIntent?: boolean;
};

export type AggregatedHistory = {
  openTradesCount: number;
  tradesToday: number;
  todayPnl: number;
  weekPnl: number;
  consecutiveLosses: number;
  lastClosedAt: Date | null;
  lastClosedWasLoss: boolean;
  recentClosesInLastHour: number;
  reentriesAfterLossInLastHour: number;
};

export type RiskCheckResult = {
  decision: "pass" | "warning" | "block";
  riskScore: number;
  failedRules: Array<{ rule: string; severity: "info" | "warning" | "critical" }>;
  warnings: string[];
  passedRules: string[];
  requiredActions: string[];
  overrideAllowed: boolean;
  reason: string;
  details: Record<string, unknown>;
  liveExecutionAttempted: boolean;
};

export const DEFAULT_USER_RISK_SETTINGS = {
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null as number | null,
  maxDailyLossPercent: 3, maxDailyLossAmount: null as number | null,
  maxWeeklyLossPercent: null as number | null, maxWeeklyLossAmount: null as number | null,
  maxOpenTrades: 3, maxTradesPerDay: 5, maxConsecutiveLosses: 3,
  maxPositionSize: null as number | null,
  minRewardRiskRatio: 1.5,
  cooldownAfterLossMinutes: 30, cooldownAfterMaxLossMinutes: 1440,
  blockAfterDailyLossHit: true, blockAfterConsecutiveLosses: true,
  requireStopLoss: true, requireTakeProfit: false,
  requirePlaybook: true, requirePreTradeChecklist: true, requireJournalReason: true,
  allowOverrideInPaperMode: true,
  liveLocked: true, readOnlyMode: true, allowOrderExecution: false,
} as const;

export function aggregateHistory(trades: PaperTrade[], now = new Date()): AggregatedHistory {
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - 7);
  const open = trades.filter((t) => t.status === "open");
  const closed = trades.filter((t) => t.status === "closed").sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  const closedToday = closed.filter((t) => t.closedAt && t.closedAt >= dayStart);
  const closedWeek = closed.filter((t) => t.closedAt && t.closedAt >= weekStart);
  const tradesToday = closedToday.length + open.filter((t) => (t.openedAt ?? t.createdAt) >= dayStart).length;
  const todayPnl = closedToday.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const weekPnl = closedWeek.reduce((s, t) => s + (t.pnl ?? 0), 0);
  let consecutiveLosses = 0;
  for (const t of closed) { if ((t.pnl ?? 0) < 0) consecutiveLosses++; else break; }
  const lastClosed = closed[0] ?? null;
  const lastClosedAt = lastClosed?.closedAt ?? null;
  const lastClosedWasLoss = !!(lastClosed && (lastClosed.pnl ?? 0) < 0);
  const oneHourAgo = now.getTime() - 60 * 60_000;
  const recentClosesInLastHour = closed.filter((t) => t.closedAt && t.closedAt.getTime() >= oneHourAgo).length;
  const reentriesAfterLossInLastHour = closed.filter((t, i, arr) => {
    if (!t.closedAt || t.closedAt.getTime() < oneHourAgo) return false;
    const prev = arr[i + 1]; // older
    return !!(prev && (prev.pnl ?? 0) < 0);
  }).length;
  return { openTradesCount: open.length, tradesToday, todayPnl, weekPnl, consecutiveLosses, lastClosedAt, lastClosedWasLoss, recentClosesInLastHour, reentriesAfterLossInLastHour };
}

export function evaluateRiskCheck(
  settings: UserRiskSettings,
  history: AggregatedHistory,
  input: RiskCheckInput,
  ctx: { accountBalance?: number | null; now?: Date } = {},
): RiskCheckResult {
  const now = ctx.now ?? new Date();
  const balance = ctx.accountBalance ?? null;
  const failed: RiskCheckResult["failedRules"] = [];
  const warnings: string[] = [];
  const passed: string[] = [];
  const required: string[] = [];

  // ── Live safety contract (cannot be overridden) ─────────────────────────
  let liveExecutionAttempted = false;
  if (input.liveExecutionIntent === true) {
    liveExecutionAttempted = true;
    failed.push({ rule: "Live execution attempted — blocked by safety contract", severity: "critical" });
    required.push("Remove live execution intent. App is paper-only.");
  }
  if (!settings.liveLocked) {
    failed.push({ rule: "liveLocked must be true", severity: "critical" });
  } else passed.push("liveLocked=true");
  if (settings.allowOrderExecution) {
    failed.push({ rule: "allowOrderExecution must be false", severity: "critical" });
  } else passed.push("allowOrderExecution=false");
  if (!settings.readOnlyMode) {
    failed.push({ rule: "readOnlyMode must be true", severity: "critical" });
  } else passed.push("readOnlyMode=true");

  // ── Quality gates ────────────────────────────────────────────────────────
  if (settings.requireStopLoss) {
    if (input.stopLoss == null) { failed.push({ rule: "Stop loss required", severity: "critical" }); required.push("Set a stop loss"); }
    else passed.push("Stop loss defined");
  }
  if (settings.requireTakeProfit) {
    if (input.takeProfit == null) { failed.push({ rule: "Take profit required", severity: "warning" }); required.push("Set a take profit"); }
    else passed.push("Take profit defined");
  }
  const rr = input.rewardRiskRatio ?? null;
  if (rr != null) {
    if (rr < settings.minRewardRiskRatio) { failed.push({ rule: `Reward:risk ${rr} below minimum ${settings.minRewardRiskRatio}`, severity: "warning" }); required.push(`Improve setup so RR ≥ ${settings.minRewardRiskRatio}`); }
    else passed.push(`RR ${rr} ≥ ${settings.minRewardRiskRatio}`);
  } else if (settings.requireStopLoss) {
    warnings.push("Reward:risk not provided");
  }
  if (input.riskPercent != null && input.riskPercent > settings.maxRiskPerTradePercent) {
    failed.push({ rule: `Risk ${input.riskPercent}% exceeds max ${settings.maxRiskPerTradePercent}%`, severity: "critical" });
    required.push(`Reduce risk to ≤ ${settings.maxRiskPerTradePercent}%`);
  } else if (input.riskPercent != null) passed.push(`Risk ${input.riskPercent}% within limit`);
  if (settings.maxRiskPerTradeAmount != null && input.riskAmount != null && input.riskAmount > settings.maxRiskPerTradeAmount) {
    failed.push({ rule: `Risk amount exceeds max ${settings.maxRiskPerTradeAmount}`, severity: "critical" });
  }
  if (settings.maxPositionSize != null && input.lotSize != null && input.lotSize > settings.maxPositionSize) {
    failed.push({ rule: `Lot size ${input.lotSize} exceeds max ${settings.maxPositionSize}`, severity: "warning" });
  }

  // ── Trade counts ─────────────────────────────────────────────────────────
  if (history.openTradesCount >= settings.maxOpenTrades) {
    failed.push({ rule: `Max open trades reached (${history.openTradesCount}/${settings.maxOpenTrades})`, severity: "warning" });
    required.push("Close an existing trade first");
  } else passed.push(`Open trades ${history.openTradesCount}/${settings.maxOpenTrades}`);
  if (history.tradesToday >= settings.maxTradesPerDay) {
    failed.push({ rule: `Max trades/day reached (${history.tradesToday}/${settings.maxTradesPerDay})`, severity: "critical" });
    required.push("Stop for today — daily trade cap hit");
  } else passed.push(`Trades today ${history.tradesToday}/${settings.maxTradesPerDay}`);

  // ── Loss caps ────────────────────────────────────────────────────────────
  if (balance && balance > 0) {
    const dailyLossPct = history.todayPnl < 0 ? (Math.abs(history.todayPnl) / balance) * 100 : 0;
    if (dailyLossPct >= settings.maxDailyLossPercent && settings.blockAfterDailyLossHit) {
      failed.push({ rule: `Daily loss ${dailyLossPct.toFixed(2)}% ≥ cap ${settings.maxDailyLossPercent}%`, severity: "critical" });
      required.push("Stop for today — daily loss limit hit");
    }
  }
  if (settings.maxDailyLossAmount != null && history.todayPnl <= -settings.maxDailyLossAmount && settings.blockAfterDailyLossHit) {
    failed.push({ rule: `Daily loss amount cap hit (${history.todayPnl})`, severity: "critical" });
  }
  if (settings.maxWeeklyLossAmount != null && history.weekPnl <= -settings.maxWeeklyLossAmount) {
    failed.push({ rule: `Weekly loss amount cap hit (${history.weekPnl})`, severity: "critical" });
  }

  // ── Streak + cooldown ────────────────────────────────────────────────────
  if (history.consecutiveLosses >= settings.maxConsecutiveLosses && settings.blockAfterConsecutiveLosses) {
    failed.push({ rule: `Consecutive losses ${history.consecutiveLosses} ≥ cap ${settings.maxConsecutiveLosses}`, severity: "critical" });
    required.push("Take a break — consecutive-loss cap hit");
  }
  if (history.lastClosedWasLoss && history.lastClosedAt) {
    const elapsed = (now.getTime() - history.lastClosedAt.getTime()) / 60_000;
    if (elapsed < settings.cooldownAfterLossMinutes) {
      failed.push({ rule: `In cooldown after loss (${Math.ceil(settings.cooldownAfterLossMinutes - elapsed)} min remaining)`, severity: "warning" });
      required.push(`Wait ${Math.ceil(settings.cooldownAfterLossMinutes - elapsed)} minutes`);
    }
  }

  // ── Behavioral ───────────────────────────────────────────────────────────
  if (history.recentClosesInLastHour >= 5) {
    failed.push({ rule: `Overtrading detected (${history.recentClosesInLastHour} in last hour)`, severity: "warning" });
  }
  if (history.reentriesAfterLossInLastHour >= 2) {
    failed.push({ rule: `Revenge trading pattern detected`, severity: "warning" });
  }

  // ── Phase-7 ties ─────────────────────────────────────────────────────────
  if (settings.requirePlaybook && (input.playbookId == null || !Number.isFinite(input.playbookId))) {
    failed.push({ rule: "Playbook required for trades", severity: "warning" });
    required.push("Attach a playbook to this setup");
  } else if (input.playbookId) passed.push("Playbook attached");
  if (settings.requirePreTradeChecklist) {
    if (input.preTradeCheckDecision === "block") {
      failed.push({ rule: "Pre-trade checklist returned BLOCK", severity: "warning" });
      required.push("Address checklist failures or run a new check");
    } else if (input.preTradeCheckDecision == null && input.preTradeCheckPassed !== true) {
      failed.push({ rule: "Pre-trade checklist required but not run", severity: "warning" });
      required.push("Run the pre-trade check first");
    } else passed.push(`Pre-trade check ${input.preTradeCheckDecision ?? "passed"}`);
  }
  if (settings.requireJournalReason) {
    if (!input.reasonForEntry || input.reasonForEntry.trim().length < 5) {
      failed.push({ rule: "Reason for entry required", severity: "warning" });
      required.push("Write at least one sentence explaining the setup");
    } else passed.push("Reason for entry written");
  }

  const total = failed.length + passed.length || 1;
  const riskScore = Math.round((passed.length / total) * 100);
  const hasCritical = failed.some((f) => f.severity === "critical");
  const decision: RiskCheckResult["decision"] =
    failed.length === 0 ? "pass" : hasCritical ? "block" : (failed.length >= 2 ? "block" : "warning");

  // Override: paper-mode only AND user policy on AND no live attempt AND no live-contract violation
  const liveContractViolation = liveExecutionAttempted || !settings.liveLocked || settings.allowOrderExecution || !settings.readOnlyMode;
  const overrideAllowed = !liveContractViolation && settings.allowOverrideInPaperMode && decision !== "pass";

  const reason = decision === "pass"
    ? "All risk checks passed. Trade aligned with your safety rules."
    : hasCritical
      ? `Blocked: ${failed.filter((f) => f.severity === "critical")[0]?.rule ?? "critical risk rule violated"}`
      : `Warnings: ${failed.map((f) => f.rule).slice(0, 3).join("; ")}`;

  return {
    decision, riskScore,
    failedRules: failed, warnings, passedRules: passed, requiredActions: required,
    overrideAllowed, reason,
    details: {
      tradesToday: history.tradesToday, openTradesCount: history.openTradesCount,
      todayPnl: history.todayPnl, weekPnl: history.weekPnl,
      consecutiveLosses: history.consecutiveLosses,
      cooldownActive: failed.some((f) => f.rule.startsWith("In cooldown")),
      liveLocked: settings.liveLocked, allowOrderExecution: settings.allowOrderExecution,
      readOnlyMode: settings.readOnlyMode,
    },
    liveExecutionAttempted,
  };
}
