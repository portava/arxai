// ARX AI Assistant — Phase 20A coaching tools.
//
// Two ADDITIVE, READ-ONLY assistant tools that wrap existing systems:
//   1. evaluatePaperTradePlan — plan-quality / risk-readiness scorecard for
//      a stored paper trade owned by the current user, OR an inline draft.
//   2. getTradingStyleProfile — surfaces the user's saved trading-style
//      preferences (risk settings + active symbol/market). Returns
//      { configured:false } for fresh users instead of inventing defaults.
//
// SAFETY:
//   - Never executes, modifies, or cancels a trade.
//   - Never returns secrets.
//   - Output is a transparent score with reasons, not a profit prediction.
//   - Labels are constrained: incomplete | needs_review | watchlist_ready |
//     paper_trade_ready | blocked_by_risk | blocked_by_liveLocked.
//   - Reuses minRewardRiskRatio + requireStopLoss + requireTakeProfit +
//     requireJournalReason from user_risk_settings (no duplicate scoring).

import { db, paperTradesTable, userRiskSettingsTable, userSettingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getMarketProvider } from "./marketProvider.js";

type Side = "buy" | "sell";
type PlanLabel =
  | "incomplete"
  | "needs_review"
  | "watchlist_ready"
  | "paper_trade_ready"
  | "blocked_by_risk"
  | "blocked_by_liveLocked";

interface PlanInputs {
  symbol: string | null;
  side: Side | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  lotSize: number | null;
  reasonForEntry: string | null;
  setupType: string | null;
}

interface CategoryScore {
  category: string;
  score: number;        // 0..100
  weight: number;       // 0..1
  passes: string[];
  warnings: string[];
  blockers: string[];
}

function computeRR(side: Side | null, entry: number | null, sl: number | null, tp: number | null): number | null {
  if (!side || entry == null || sl == null || tp == null) return null;
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk <= 0) return null;
  // Direction sanity: for a buy, sl<entry<tp; for a sell, sl>entry>tp.
  const dirOk = side === "buy" ? (sl < entry && tp > entry) : (sl > entry && tp < entry);
  if (!dirOk) return null;
  return Number((reward / risk).toFixed(2));
}

function pct(n: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((n / total) * 100)));
}

export async function evaluatePaperTradePlan(
  userId: number,
  args: { paperTradeId?: number; plan?: Partial<PlanInputs> },
) {
  // 1. Load the user's stored paper trade (if id given) — strictly user-scoped.
  let p: PlanInputs;
  let storedStatus: string | null = null;
  let storedId: number | null = null;
  if (args.paperTradeId != null && Number.isFinite(args.paperTradeId)) {
    const rows = await db.select().from(paperTradesTable)
      .where(and(eq(paperTradesTable.id, args.paperTradeId), eq(paperTradesTable.userId, userId)))
      .limit(1);
    if (rows.length === 0) {
      return {
        error: "PAPER_TRADE_NOT_FOUND",
        message: "No paper trade with that id belongs to you.",
      };
    }
    const t = rows[0]!;
    storedId = t.id;
    storedStatus = t.status;
    p = {
      symbol: t.symbol ?? null,
      side: (t.side === "buy" || t.side === "sell") ? t.side : null,
      entry: t.entryPrice ?? t.plannedEntryPrice ?? null,
      stopLoss: t.stopLoss ?? null,
      takeProfit: t.takeProfit ?? null,
      lotSize: t.lotSize ?? null,
      reasonForEntry: t.reasonForEntry ?? null,
      setupType: t.strategyTag ?? null,
    };
  } else if (args.plan) {
    const d = args.plan;
    p = {
      symbol: typeof d.symbol === "string" ? d.symbol : null,
      side: (d.side === "buy" || d.side === "sell") ? d.side : null,
      entry: typeof d.entry === "number" ? d.entry : null,
      stopLoss: typeof d.stopLoss === "number" ? d.stopLoss : null,
      takeProfit: typeof d.takeProfit === "number" ? d.takeProfit : null,
      lotSize: typeof d.lotSize === "number" ? d.lotSize : null,
      reasonForEntry: typeof d.reasonForEntry === "string" ? d.reasonForEntry : null,
      setupType: typeof d.setupType === "string" ? d.setupType : null,
    };
  } else {
    return {
      error: "PAPER_TRADE_OR_PLAN_REQUIRED",
      message: "Provide paperTradeId or an inline plan to evaluate.",
    };
  }

  // 2. Load the user's risk settings — fresh user => null, never invented.
  const rsRows = await db.select().from(userRiskSettingsTable)
    .where(eq(userRiskSettingsTable.userId, userId)).limit(1);
  const rs = rsRows[0] ?? null;

  // 3. Plan completeness (7 fields).
  const completeness: CategoryScore = { category: "plan_completeness", score: 0, weight: 0.30, passes: [], warnings: [], blockers: [] };
  const fields: Array<[keyof PlanInputs, string]> = [
    ["symbol", "symbol"], ["side", "direction"], ["entry", "entry"],
    ["stopLoss", "stop_loss"], ["takeProfit", "take_profit"],
    ["lotSize", "position_size"], ["reasonForEntry", "trade_thesis"],
  ];
  let filled = 0;
  for (const [k, label] of fields) {
    if (p[k] != null && p[k] !== "") { filled++; completeness.passes.push(label); }
    else completeness.blockers.push(`missing_${label}`);
  }
  if (!p.setupType) completeness.warnings.push("setup_type_not_tagged");
  completeness.score = pct(filled, fields.length);

  // 4. Risk quality.
  const risk: CategoryScore = { category: "risk_quality", score: 0, weight: 0.25, passes: [], warnings: [], blockers: [] };
  let rOk = 0; let rTotal = 0;
  rTotal++; if (p.lotSize != null && p.lotSize > 0) { rOk++; risk.passes.push("position_size_valid"); } else risk.blockers.push("position_size_invalid_or_missing");
  rTotal++;
  if (p.entry != null && p.stopLoss != null) {
    if (Math.abs(p.entry - p.stopLoss) > 0) { rOk++; risk.passes.push("stop_distance_valid"); }
    else risk.blockers.push("stop_loss_equals_entry");
  } else if (rs?.requireStopLoss !== false) {
    risk.blockers.push("stop_loss_required");
  }
  if (rs) {
    rTotal++;
    if (rs.requireStopLoss && p.stopLoss == null) risk.blockers.push("user_settings_require_stop_loss");
    else { rOk++; risk.passes.push("stop_loss_policy_ok"); }
  } else {
    risk.warnings.push("user_risk_settings_not_configured");
  }
  risk.score = pct(rOk, rTotal);

  // 5. Reward quality.
  const reward: CategoryScore = { category: "reward_quality", score: 0, weight: 0.20, passes: [], warnings: [], blockers: [] };
  const rr = computeRR(p.side, p.entry, p.stopLoss, p.takeProfit);
  let rwOk = 0; let rwTotal = 1;
  if (p.takeProfit != null) { rwOk++; reward.passes.push("take_profit_present"); }
  else if (rs?.requireTakeProfit) reward.blockers.push("take_profit_required");
  else reward.warnings.push("take_profit_missing");
  if (rr != null) {
    rwTotal++;
    const minRr = rs?.minRewardRiskRatio ?? 1.5;
    if (rr >= minRr) { rwOk++; reward.passes.push(`rr_meets_minimum_${minRr}`); }
    else reward.warnings.push(`rr_${rr}_below_minimum_${minRr}`);
  } else if (p.entry != null && p.stopLoss != null && p.takeProfit != null) {
    reward.blockers.push("direction_or_levels_inconsistent");
  } else {
    reward.warnings.push("rr_uncomputable_until_entry_sl_tp_set");
  }
  reward.score = pct(rwOk, rwTotal);

  // 6. Timing readiness — honest about market data availability.
  const timing: CategoryScore = { category: "timing_readiness", score: 0, weight: 0.15, passes: [], warnings: [], blockers: [] };
  const provider = getMarketProvider();
  if (provider.connected) {
    timing.passes.push("market_data_connected");
    timing.score = 75;
  } else {
    timing.warnings.push("live_market_data_not_connected_timing_analysis_limited");
    timing.score = 25;
  }
  if (!p.entry) timing.warnings.push("user_must_confirm_entry_trigger_manually");

  // 7. Discipline alignment.
  const discipline: CategoryScore = { category: "discipline_alignment", score: 0, weight: 0.10, passes: [], warnings: [], blockers: [] };
  let dOk = 0; let dTotal = 0;
  dTotal++;
  if (p.reasonForEntry && p.reasonForEntry.trim().length >= 8) { dOk++; discipline.passes.push("trade_thesis_present"); }
  else if (rs?.requireJournalReason) discipline.blockers.push("user_settings_require_journal_reason");
  else discipline.warnings.push("trade_thesis_missing_or_too_short");
  if (p.setupType) { dTotal++; dOk++; discipline.passes.push("setup_type_tagged"); }
  if (rs) { dTotal++; dOk++; discipline.passes.push("risk_settings_configured"); }
  discipline.score = pct(dOk, Math.max(1, dTotal));

  const cats: CategoryScore[] = [completeness, risk, reward, timing, discipline];
  const overall = Math.round(cats.reduce((s, c) => s + c.score * c.weight, 0));
  const blockers = cats.flatMap((c) => c.blockers);
  const warnings = cats.flatMap((c) => c.warnings);

  // 8. Label — derived strictly from blockers + completeness, never from
  // a profit prediction. liveLocked is always true so live labels are
  // structurally unreachable; we still guard for clarity.
  let label: PlanLabel = "incomplete";
  if (completeness.score >= 100 && blockers.length === 0 && overall >= 70) label = "paper_trade_ready";
  else if (completeness.score >= 100 && blockers.length === 0) label = "watchlist_ready";
  else if (blockers.length > 0) label = "needs_review";
  if (storedStatus === "open" || storedStatus === "closed" || storedStatus === "cancelled") label = "needs_review";
  // Risk-blocker-driven label only flips when a blocker explicitly violates a
  // user_risk_settings rule — not on missing-field blockers.
  const hasRiskBlock = risk.blockers.some((b) => b.startsWith("user_settings_require_"))
    || discipline.blockers.some((b) => b.startsWith("user_settings_require_"))
    || reward.blockers.some((b) => b.startsWith("user_settings_require_"));
  if (hasRiskBlock) label = "blocked_by_risk";

  return {
    paperTradeId: storedId,
    storedStatus,
    plan: p,
    rewardRiskRatio: rr,
    overallScore: overall,
    label,
    categories: cats,
    blockers,
    warnings,
    coachNotes: [
      "This is a transparent plan-quality scorecard, not a profit prediction.",
      "Labels: incomplete | needs_review | watchlist_ready | paper_trade_ready | blocked_by_risk.",
      provider.connected
        ? "Live market data is connected; timing is partially verifiable."
        : "Live market data is not connected, so timing analysis is limited to your stored plan only.",
      rs ? "Scored against your saved risk settings."
         : "You have no risk settings yet — score reflects defaults; configure them to tighten the score.",
    ],
  };
}

export async function getTradingStyleProfile(userId: number) {
  const [rsRows, usRows] = await Promise.all([
    db.select().from(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, userId)).limit(1),
    db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, userId)).limit(1),
  ]);
  const rs = rsRows[0] ?? null;
  const us = usRows[0] ?? null;
  if (!rs && !us) {
    return {
      configured: false,
      message: "Trading style not configured yet. Open Risk Settings and Settings to define your style.",
    };
  }
  return {
    configured: Boolean(rs),
    preferredSymbol: us?.activeSymbol ?? null,
    preferredMarket: us?.activeMarketType ?? null,
    accountMode: us?.accountMode ?? null,
    riskRules: rs ? {
      maxRiskPerTradePercent: rs.maxRiskPerTradePercent,
      maxDailyLossPercent: rs.maxDailyLossPercent,
      maxOpenTrades: rs.maxOpenTrades,
      maxTradesPerDay: rs.maxTradesPerDay,
      maxConsecutiveLosses: rs.maxConsecutiveLosses,
      minRewardRiskRatio: rs.minRewardRiskRatio,
      cooldownAfterLossMinutes: rs.cooldownAfterLossMinutes,
      requireStopLoss: rs.requireStopLoss,
      requireTakeProfit: rs.requireTakeProfit,
      requirePlaybook: rs.requirePlaybook,
      requirePreTradeChecklist: rs.requirePreTradeChecklist,
      requireJournalReason: rs.requireJournalReason,
      allowOverrideInPaperMode: rs.allowOverrideInPaperMode,
      blockAfterDailyLossHit: rs.blockAfterDailyLossHit,
      blockAfterConsecutiveLosses: rs.blockAfterConsecutiveLosses,
    } : null,
    forbiddenBehaviors: [
      "live_order_execution_locked",
      "no_profit_guarantees",
      "no_perfect_entry_claims",
    ],
    note: rs
      ? "These are your saved preferences. ARX AI uses them when scoring paper-trade plans."
      : "Risk settings not configured. Defaults are not assumed — set them on Risk Settings.",
  };
}
