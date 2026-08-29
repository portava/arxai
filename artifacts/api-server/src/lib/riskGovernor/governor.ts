// Build HH — Risk Governor + Trader Readiness Service.
//
// SAFETY (strict freeze): READS ONLY across AA/BB/CC/DD/EE/FF/GG. Never places
// trades, never calls MT5, never enables canPlaceTrades, never recommends live
// trading. liveTradingStatus is hardcoded "DISABLED". liveTradingAllowed is
// hardcoded false. canPlaceLiveTrade is hardcoded false.

import { randomUUID } from "node:crypto";
import { computeTimingRead } from "../../brain/timing/marketTimingBrainService.js";
import {
  db,
  paperAccountsTable,
  paperOrdersTable,
  tradeDecisionLogsTable,
  postTradeDebriefsTable,
  learningEventsTable,
  strategyEdgesTable,
  mistakePatternsTable,
  autopilotCyclesTable,
  autopilotCycleLogsTable,
  autopilotSymbolCooldownsTable,
  riskSettingsTable,
  riskGovernorEvaluationsTable,
  riskGovernorEventsTable,
} from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { logger } from "../logger.js";
import { checkBrokerSafety } from "../brokerReadOnly/service.js";

export type OverallStatus = "PAPER_ALLOWED" | "PAPER_CAUTION" | "PAPER_PAUSED" | "WATCH_ONLY" | "LOCKED";
export type ReadinessLevel = "NOT_READY" | "EARLY_TESTING" | "DEVELOPING_EDGE" | "PAPER_STABLE" | "ADVANCED_PAPER_READY";
export type ReadinessGrade = "A" | "B" | "C" | "D" | "F";
export type Severity = "INFO" | "WARN" | "BLOCK" | "CRITICAL";

/** Whose limits governed this evaluation. */
export type LimitsScope =
  /** Read from this user's own risk_settings row. */
  | "USER"
  /** The user has no risk_settings row yet — documented defaults were used. */
  | "USER_DEFAULTS"
  /** No user was supplied (instance-level readiness surface) — documented
   *  defaults were used. NEVER another user's row. */
  | "DEFAULTS_UNSCOPED";

/** What the dollar daily-loss limit was derived from. */
export type DailyLossLimitBasis =
  /** maxDailyLossPct applied to the trader's active paper-account equity. */
  | "PAPER_ACCOUNT_EQUITY"
  /** No balance to apply the percentage to — the dollar limit is UNKNOWN and
   *  `dailyLossLimit` is 0 (meaning "not derived", not "no limit"). */
  | "UNKNOWN";

export interface HardBlock { code: string; severity: Severity; message: string; details?: Record<string, unknown>; }
export interface SoftWarning { code: string; message: string; details?: Record<string, unknown>; }
export interface RiskFlag { code: string; message: string; }
export interface Cooldown { symbol: string; reason: string | null; until: string | null; }

export interface GovernorMetrics {
  dailyPnl: number;
  /** Dollar daily-loss limit. 0 means NOT DERIVED (see dailyLossLimitBasis) —
   *  it never means "unlimited". */
  dailyLossLimit: number;
  dailyLossLimitBasis: DailyLossLimitBasis;
  /** Percentage limit as configured by the trader, independent of any balance. */
  maxDailyLossPct: number | null;
  limitsScope: LimitsScope;
  weeklyPnl: number;
  maxDrawdown: number;
  openPaperTrades: number;
  maxOpenPaperTrades: number;
  sameSymbolExposure: Record<string, number>;
  winRate30d: number;
  sampleSize: number;
  decisionToWinRate: number;
  avgRiskScore: number;
  avgConfidence: number;
  learningConfidence: number;
  marketDataQuality: "GOOD" | "DEGRADED" | "FALLBACK_ONLY" | "FAILED" | "UNKNOWN";
  autopilotErrorRate: number;
  repeatedMistakeCount: number;
}

export interface AllowedActions {
  canRunAADecision: boolean;
  canOpenPaperTrade: boolean;
  canRunPaperAutopilot: boolean;
  canManualClosePaperTrade: boolean;
  canRebuildPerformance: boolean;
  canProcessLearning: boolean;
  canPlaceLiveTrade: false;
}

export interface GovernorEvaluation {
  governor_id: string;
  evaluated_at: string;
  mode: "PAPER_ONLY";
  liveTradingStatus: "DISABLED";
  overallStatus: OverallStatus;
  paperTradingAllowed: boolean;
  autopilotAllowed: boolean;
  manualPaperAllowed: boolean;
  liveTradingAllowed: false;
  readinessScore: number;
  readinessGrade: ReadinessGrade;
  readinessLevel: ReadinessLevel;
  hardBlocks: HardBlock[];
  softWarnings: SoftWarning[];
  riskFlags: RiskFlag[];
  cooldowns: Cooldown[];
  metrics: GovernorMetrics;
  nextBestActions: string[];
  allowedActions: AllowedActions;
  explanation: string;
  generatedAt: string;
  dataSourcesRead: string[];
  missingDataSources: string[];
  timingAdvisory?: TimingAdvisory;
}

export interface SimulateOverrides {
  forceCanPlaceTradesTrue?: boolean;
  forceLiveTradingFlag?: boolean;
  forceMarketDataMode?: "read_only" | "live_writable" | "missing";
  forceDailyPnl?: number;
  forceOpenPaperTrades?: number;
  forceRevengeCooldown?: boolean;
  forceMarketDataQuality?: GovernorMetrics["marketDataQuality"];
  forceAutopilotErrorRate?: number;
  forceSampleSize?: number;
  forceWinRate?: number;
  forceLearningConfidence?: number;
  forceRepeatedMistakes?: number;
}

interface EvalLog {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

function defaultLog(): EvalLog {
  return {
    info: (m, x) => logger.info(x ?? {}, `HH governor: ${m}`),
    warn: (m, x) => logger.warn(x ?? {}, `HH governor: ${m}`),
    error: (m, x) => logger.error(x ?? {}, `HH governor: ${m}`),
  };
}

/**
 * Derive the DOLLAR daily-loss limit from the trader's configured percentage
 * and the account balance it protects.
 *
 * Replaces `Math.max(10, Math.round(pct * 50))` — a hardcoded "$50 per 1%"
 * proxy that bore no relation to the account. When there is no balance to
 * apply the percentage to we return UNKNOWN and a limit of 0, which callers
 * MUST read as "not derived" (never as "no limit"): the evaluator refuses to
 * certify the limit intact rather than assuming it is.
 */
export function deriveDailyLossLimit(
  maxDailyLossPct: number | null,
  accountEquity: number | null,
): { limit: number; basis: DailyLossLimitBasis } {
  if (maxDailyLossPct == null || accountEquity == null || accountEquity <= 0) {
    return { limit: 0, basis: "UNKNOWN" };
  }
  return {
    limit: Math.round((maxDailyLossPct / 100) * accountEquity * 100) / 100,
    basis: "PAPER_ACCOUNT_EQUITY",
  };
}

// ── Metric collection (READ-ONLY against AA/BB/CC/DD/EE/FF/GG) ────────────
//
// `userId` identifies WHOSE limits and WHOSE trades this evaluation is about.
// It may be null only for instance-level readiness surfaces that genuinely
// have no single owner; in that case the governor uses its documented
// conservative defaults and reports `limitsScope: "DEFAULTS_UNSCOPED"` — it
// never adopts another user's row.
async function collectMetrics(overrides: SimulateOverrides | undefined, userId: number | null): Promise<{
  metrics: GovernorMetrics;
  cooldowns: Cooldown[];
  dataSourcesRead: string[];
  missingDataSources: string[];
  limitsScope: LimitsScope;
}> {
  const dataSourcesRead: string[] = [];
  const missingDataSources: string[] = [];

  const utcMidnight = new Date(); utcMidnight.setUTCHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const thirtyAgo = new Date(Date.now() - 30 * 86_400_000);

  // --- EE: paper_orders ---
  let dailyPnl = 0, weeklyPnl = 0, openCount = 0, winRate30d = 0, sampleSize = 0, maxDrawdown = 0;
  const sameSymbolExposure: Record<string, number> = {};
  try {
    // Per-user isolation: when the evaluation belongs to a user, only that
    // user's paper orders may move their governor.
    const userIdScope = userId == null ? [] : [eq(paperOrdersTable.userId, userId)];
    const dRows = await db.select({ pnl: sql<number>`COALESCE(SUM(${paperOrdersTable.profitLoss}),0)` })
      .from(paperOrdersTable)
      .where(and(...userIdScope, eq(paperOrdersTable.status, "CLOSED"), gte(paperOrdersTable.closedAt, utcMidnight)));
    dailyPnl = Number(dRows[0]?.pnl ?? 0);

    const wRows = await db.select({ pnl: sql<number>`COALESCE(SUM(${paperOrdersTable.profitLoss}),0)` })
      .from(paperOrdersTable)
      .where(and(...userIdScope, eq(paperOrdersTable.status, "CLOSED"), gte(paperOrdersTable.closedAt, weekAgo)));
    weeklyPnl = Number(wRows[0]?.pnl ?? 0);

    const open = await db.select().from(paperOrdersTable)
      .where(and(...userIdScope, eq(paperOrdersTable.status, "OPEN")));
    openCount = open.length;
    for (const o of open) sameSymbolExposure[o.symbol] = (sameSymbolExposure[o.symbol] ?? 0) + 1;

    const closed30 = await db.select().from(paperOrdersTable)
      .where(and(...userIdScope, eq(paperOrdersTable.status, "CLOSED"), gte(paperOrdersTable.closedAt, thirtyAgo)));
    sampleSize = closed30.length;
    if (sampleSize > 0) {
      const wins = closed30.filter(t => Number(t.profitLoss ?? 0) > 0).length;
      winRate30d = Math.round((wins / sampleSize) * 10000) / 100;
      let cum = 0, peak = 0, dd = 0;
      const sorted = [...closed30].sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0));
      for (const t of sorted) { cum += Number(t.profitLoss ?? 0); if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
      maxDrawdown = Math.round(dd * 100) / 100;
    }
    dataSourcesRead.push("paper_orders");
  } catch (e) { missingDataSources.push("paper_orders"); }

  // --- AA: trade_decision_logs ---
  let avgConfidence = 0, avgRiskScore = 0, decisionToWinRate = 0, decisionsTotal = 0;
  try {
    const decisionUserIdScope = userId == null ? [] : [eq(tradeDecisionLogsTable.userId, userId)];
    const decisions = await db.select().from(tradeDecisionLogsTable)
      .where(and(...decisionUserIdScope, gte(tradeDecisionLogsTable.createdAt, thirtyAgo)));
    decisionsTotal = decisions.length;
    if (decisionsTotal > 0) {
      avgConfidence = Math.round((decisions.reduce((a, d) => a + (d.confidence ?? 0), 0) / decisionsTotal) * 100) / 100;
      avgRiskScore = Math.round((decisions.reduce((a, d) => a + (d.riskScore ?? 0), 0) / decisionsTotal) * 100) / 100;
    }
    const shouldTradeIds = decisions.filter(d => d.shouldTrade).map(d => d.id);
    if (shouldTradeIds.length > 0) {
      const placed = userId == null
        ? await db.select().from(paperOrdersTable)
        : await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, userId));
      const winFromDecision = placed.filter(p => p.decisionId && shouldTradeIds.includes(p.decisionId) && Number(p.profitLoss ?? 0) > 0).length;
      const closedFromDecision = placed.filter(p => p.decisionId && shouldTradeIds.includes(p.decisionId) && p.status === "CLOSED").length;
      decisionToWinRate = closedFromDecision > 0 ? Math.round((winFromDecision / closedFromDecision) * 10000) / 100 : 0;
    }
    dataSourcesRead.push("trade_decision_logs");
  } catch (e) { missingDataSources.push("trade_decision_logs"); }

  // --- BB: post_trade_debriefs (presence check + count) ---
  let debriefsCreated = 0;
  try {
    const debriefUserIdScope = userId == null ? [] : [eq(postTradeDebriefsTable.userId, userId)];
    const debriefs = await db.select().from(postTradeDebriefsTable)
      .where(and(...debriefUserIdScope, gte(postTradeDebriefsTable.createdAt, thirtyAgo)));
    debriefsCreated = debriefs.length;
    dataSourcesRead.push("post_trade_debriefs");
  } catch { missingDataSources.push("post_trade_debriefs"); }

  // --- CC: learning_events / strategy_edges / mistake_patterns ---
  let learningConfidence = 0, repeatedMistakeCount = 0, learningEventsCount = 0;
  try {
    const learningUserIdScope = userId == null ? [] : [eq(learningEventsTable.userId, userId)];
    const events = await db.select().from(learningEventsTable)
      .where(and(...learningUserIdScope, gte(learningEventsTable.createdAt, thirtyAgo)));
    learningEventsCount = events.length;
    dataSourcesRead.push("learning_events");
  } catch { missingDataSources.push("learning_events"); }
  try {
    const edges = userId == null
      ? await db.select().from(strategyEdgesTable)
      : await db.select().from(strategyEdgesTable).where(eq(strategyEdgesTable.userId, userId));
    if (edges.length > 0) {
      const confidences = edges.map(e => Number((e as { confidence?: number | null }).confidence ?? 0));
      learningConfidence = Math.round((confidences.reduce((a, b) => a + b, 0) / edges.length) * 100) / 100;
    }
    dataSourcesRead.push("strategy_edges");
  } catch { missingDataSources.push("strategy_edges"); }
  try {
    const patterns = userId == null
      ? await db.select().from(mistakePatternsTable)
      : await db.select().from(mistakePatternsTable).where(eq(mistakePatternsTable.userId, userId));
    repeatedMistakeCount = patterns.filter(p => Number((p as { occurrences?: number | null }).occurrences ?? 0) >= 3).length;
    dataSourcesRead.push("mistake_patterns");
  } catch { missingDataSources.push("mistake_patterns"); }

  // --- DD: market data mode ---
  const envMode = (process.env.MARKET_DATA_MODE ?? "read_only").trim();
  const mdMode = overrides?.forceMarketDataMode ?? envMode;
  let marketDataQuality: GovernorMetrics["marketDataQuality"] = "GOOD";
  if (mdMode === "missing") marketDataQuality = "FAILED";
  else if (mdMode !== "read_only") marketDataQuality = "DEGRADED";
  else marketDataQuality = "GOOD";
  if (overrides?.forceMarketDataQuality) marketDataQuality = overrides.forceMarketDataQuality;
  dataSourcesRead.push("market_data_mode");

  // --- FF: autopilot cycles + cooldowns ---
  let autopilotErrorRate = 0;
  const cooldowns: Cooldown[] = [];
  try {
    const cycleUserIdScope = userId == null ? [] : [eq(autopilotCyclesTable.userId, userId)];
    const cycles = await db.select().from(autopilotCyclesTable)
      .where(and(...cycleUserIdScope, gte(autopilotCyclesTable.startedAt, weekAgo)))
      .orderBy(desc(autopilotCyclesTable.startedAt)).limit(50);
    if (cycles.length > 0) {
      const errored = cycles.filter(c => (c.status ?? "").toUpperCase() === "ERROR" || (c.status ?? "").toUpperCase() === "FAILED").length;
      autopilotErrorRate = Math.round((errored / cycles.length) * 10000) / 100;
    }
    dataSourcesRead.push("autopilot_cycles");

    const activeCooldowns = await db.select().from(autopilotSymbolCooldownsTable)
      .where(sql`${autopilotSymbolCooldownsTable.cooldownUntil} > NOW()`)
      .orderBy(desc(autopilotSymbolCooldownsTable.cooldownUntil)).limit(20);
    for (const c of activeCooldowns) cooldowns.push({ symbol: c.symbol, reason: c.reason, until: c.cooldownUntil.toISOString() });
    dataSourcesRead.push("autopilot_symbol_cooldowns");
  } catch { missingDataSources.push("autopilot_cycles"); }

  // --- Risk settings (limits) ---
  //
  // WAS: `.orderBy(desc(id)).limit(1)` with no user predicate — the most
  // recently CREATED user's row governed everyone, so a new signup silently
  // relaxed (or tightened) the governor for every existing trader while their
  // own edits, written per-user by routes/risk.ts, were ignored.
  //
  // WAS ALSO: `dailyLossLimit = max(10, round(pct * 50))` — a hardcoded
  // "$50 per 1%" proxy with no relation to the account it protects. The dollar
  // limit is now the configured percentage applied to the trader's own active
  // paper-account equity (the governor is a PAPER_ONLY surface). If there is
  // no equity to apply it to we report UNKNOWN rather than inventing a figure.
  let dailyLossLimit = 0;
  let dailyLossLimitBasis: DailyLossLimitBasis = "UNKNOWN";
  let maxDailyLossPct: number | null = null;
  let maxOpenPaperTrades = 2;
  let limitsScope: LimitsScope = userId == null ? "DEFAULTS_UNSCOPED" : "USER_DEFAULTS";
  try {
    if (userId == null) {
      missingDataSources.push("risk_settings:user_scope");
    } else {
      const rs = await db.select().from(riskSettingsTable)
        .where(eq(riskSettingsTable.userId, userId)).limit(1);
      if (rs[0]) {
        limitsScope = "USER";
        maxOpenPaperTrades = rs[0].maxOpenTrades ?? 2;
        maxDailyLossPct = rs[0].maxDailyLossPct ?? 2;
        const acct = await db.select().from(paperAccountsTable)
          .where(and(eq(paperAccountsTable.userId, userId), eq(paperAccountsTable.isActive, 1)))
          .orderBy(desc(paperAccountsTable.id)).limit(1);
        const equity = acct[0] ? (acct[0].equity ?? acct[0].currentBalance) : null;
        const derived = deriveDailyLossLimit(maxDailyLossPct, equity);
        dailyLossLimit = derived.limit;
        dailyLossLimitBasis = derived.basis;
      }
      dataSourcesRead.push("risk_settings");
    }
  } catch { missingDataSources.push("risk_settings"); }

  // --- Apply simulate overrides ---
  if (overrides?.forceDailyPnl !== undefined) dailyPnl = overrides.forceDailyPnl;
  if (overrides?.forceOpenPaperTrades !== undefined) openCount = overrides.forceOpenPaperTrades;
  if (overrides?.forceAutopilotErrorRate !== undefined) autopilotErrorRate = overrides.forceAutopilotErrorRate;
  if (overrides?.forceSampleSize !== undefined) sampleSize = overrides.forceSampleSize;
  if (overrides?.forceWinRate !== undefined) winRate30d = overrides.forceWinRate;
  if (overrides?.forceLearningConfidence !== undefined) learningConfidence = overrides.forceLearningConfidence;
  if (overrides?.forceRepeatedMistakes !== undefined) repeatedMistakeCount = overrides.forceRepeatedMistakes;
  if (overrides?.forceRevengeCooldown) cooldowns.push({ symbol: "SIM_REVENGE", reason: "REVENGE_COOLDOWN_SIMULATED", until: new Date(Date.now() + 30 * 60_000).toISOString() });

  return {
    metrics: {
      dailyPnl: Number(dailyPnl.toFixed(2)),
      dailyLossLimit,
      dailyLossLimitBasis,
      maxDailyLossPct,
      limitsScope,
      weeklyPnl: Number(weeklyPnl.toFixed(2)),
      maxDrawdown,
      openPaperTrades: openCount,
      maxOpenPaperTrades,
      sameSymbolExposure,
      winRate30d,
      sampleSize,
      decisionToWinRate,
      avgRiskScore,
      avgConfidence,
      learningConfidence,
      marketDataQuality,
      autopilotErrorRate,
      repeatedMistakeCount,
    },
    cooldowns,
    dataSourcesRead,
    missingDataSources,
    limitsScope,
  };
}

// ── Hard block & status rules ─────────────────────────────────────────────
function evaluateStatus(
  m: GovernorMetrics,
  cooldowns: Cooldown[],
  overrides: SimulateOverrides | undefined,
): { status: OverallStatus; hardBlocks: HardBlock[]; softWarnings: SoftWarning[]; riskFlags: RiskFlag[] } {
  const hardBlocks: HardBlock[] = [];
  const softWarnings: SoftWarning[] = [];
  const riskFlags: RiskFlag[] = [];

  // ── HARD BLOCKS (CRITICAL: live-trading attempts) ───────────────────────
  if (overrides?.forceCanPlaceTradesTrue) {
    hardBlocks.push({ code: "LIVE_CAN_PLACE_TRADES_TRUE", severity: "CRITICAL", message: "canPlaceTrades flag detected as TRUE — Build HH refuses to authorize anything until this is reverted." });
  }
  if (overrides?.forceLiveTradingFlag) {
    hardBlocks.push({ code: "LIVE_TRADING_FLAG_DETECTED", severity: "CRITICAL", message: "Live-trading flag detected — Build HH locks the system as a defence-in-depth measure." });
  }
  if (m.marketDataQuality === "FAILED") {
    hardBlocks.push({ code: "MARKET_DATA_FAILED", severity: "BLOCK", message: "Build DD market data is unavailable — paper trading cannot validate fills.", details: { quality: m.marketDataQuality } });
  }
  // MARKET_DATA_MODE not "read_only" is a hard block (defence-in-depth: read_only is the safety contract)
  const envMode = (process.env.MARKET_DATA_MODE ?? "read_only").trim();
  const effectiveMode = overrides?.forceMarketDataMode ?? envMode;
  if (effectiveMode !== "read_only" && effectiveMode !== "missing") {
    hardBlocks.push({ code: "MARKET_DATA_MODE_NOT_READ_ONLY", severity: "CRITICAL", message: `MARKET_DATA_MODE is "${effectiveMode}" — must be "read_only" for paper-only safety.` });
  }
  if (m.openPaperTrades > m.maxOpenPaperTrades && m.maxOpenPaperTrades > 0) {
    hardBlocks.push({ code: "MAX_OPEN_PAPER_TRADES_EXCEEDED", severity: "BLOCK", message: `Open paper trades ${m.openPaperTrades} exceed configured max ${m.maxOpenPaperTrades}.`, details: { open: m.openPaperTrades, max: m.maxOpenPaperTrades } });
  }
  const limitKnown = m.dailyLossLimitBasis !== "UNKNOWN" && m.dailyLossLimit > 0;
  if (limitKnown && m.dailyPnl <= -Math.abs(m.dailyLossLimit)) {
    hardBlocks.push({ code: "DAILY_LOSS_LIMIT_EXCEEDED", severity: "BLOCK", message: `Daily P&L ${m.dailyPnl} exceeds loss limit -${m.dailyLossLimit}.`, details: { dailyPnl: m.dailyPnl, limit: m.dailyLossLimit, basis: m.dailyLossLimitBasis } });
  }
  // FAIL CLOSED on an unreadable stop: if the day is already negative and we
  // could not derive the dollar loss limit, we cannot say the trader is inside
  // it — so we refuse rather than assume they are.
  if (!limitKnown && m.dailyPnl < 0) {
    hardBlocks.push({
      code: "DAILY_LOSS_LIMIT_UNKNOWN", severity: "BLOCK",
      message: "Daily loss limit could not be derived (no account equity to apply the configured % to) and today's P&L is negative — refusing to certify the limit is intact.",
      details: { dailyPnl: m.dailyPnl, maxDailyLossPct: m.maxDailyLossPct, limitsScope: m.limitsScope },
    });
  }
  for (const [sym, n] of Object.entries(m.sameSymbolExposure)) {
    if (n >= 3) hardBlocks.push({ code: "SAME_SYMBOL_CONFLICT", severity: "BLOCK", message: `Symbol ${sym} has ${n} concurrent open paper positions.`, details: { symbol: sym, count: n } });
  }
  if (m.autopilotErrorRate >= 50) {
    hardBlocks.push({ code: "AUTOPILOT_ERROR_SPIKE", severity: "BLOCK", message: `Autopilot error rate ${m.autopilotErrorRate}% — pausing for safety.`, details: { rate: m.autopilotErrorRate } });
  }
  // Build KK — broker safety: if BROKER_MODE is set to anything non-read_only, lock the system.
  // No crash if KK isn't configured; checkBrokerSafety() defaults to safe when env is unset.
  try {
    const bs = checkBrokerSafety();
    if (!bs.safe) {
      hardBlocks.push({
        code: "BROKER_MODE_NOT_READ_ONLY",
        severity: "CRITICAL",
        message: `Build KK broker connector is unsafe: ${bs.reason}`,
        details: { brokerModeEnv: bs.brokerModeEnv },
      });
    }
  } catch { /* never crash governor on KK failure */ }

  // ── PAUSE conditions ─────────────────────────────────────────────────────
  let pauseReasons = 0;
  if (limitKnown && m.dailyPnl < 0 && m.dailyPnl > -Math.abs(m.dailyLossLimit) && Math.abs(m.dailyPnl) >= 0.7 * Math.abs(m.dailyLossLimit)) {
    softWarnings.push({ code: "DAILY_LOSS_NEAR_LIMIT", message: `Daily P&L ${m.dailyPnl} is within 30% of loss limit -${m.dailyLossLimit}.` }); pauseReasons += 1;
  }
  if (cooldowns.some(c => (c.reason ?? "").toUpperCase().includes("REVENGE"))) {
    softWarnings.push({ code: "REVENGE_COOLDOWN_ACTIVE", message: "Active revenge-trade cooldown detected." }); pauseReasons += 1;
  }
  if (m.repeatedMistakeCount >= 5) {
    softWarnings.push({ code: "REPEATED_MISTAKES_RISING", message: `${m.repeatedMistakeCount} mistake patterns at ≥3 occurrences — pausing to learn.` }); pauseReasons += 1;
  }
  if (m.marketDataQuality === "DEGRADED") {
    softWarnings.push({ code: "MARKET_DATA_DEGRADED", message: "Build DD market data is degraded." }); pauseReasons += 1;
  }
  if (m.autopilotErrorRate > 20 && m.autopilotErrorRate < 50) {
    softWarnings.push({ code: "AUTOPILOT_ERRORS_ELEVATED", message: `Autopilot error rate ${m.autopilotErrorRate}% — slowing down.` }); pauseReasons += 1;
  }
  if (m.avgRiskScore >= 80 && m.sampleSize >= 5) {
    softWarnings.push({ code: "RISK_SCORE_TRENDING_HIGH", message: `Average risk score ${m.avgRiskScore} is too high.` }); pauseReasons += 1;
  }

  // ── CAUTION conditions (informational, do not pause) ────────────────────
  let cautionReasons = 0;
  if (!limitKnown) { riskFlags.push({ code: "DAILY_LOSS_LIMIT_UNKNOWN", message: `Dollar daily-loss limit is UNKNOWN (${m.maxDailyLossPct != null ? `${m.maxDailyLossPct}% configured, ` : ""}no account equity to apply it to).` }); cautionReasons += 1; }
  if (m.limitsScope !== "USER") { riskFlags.push({ code: "RISK_LIMITS_UNSCOPED", message: `Risk limits were not read from a specific trader's settings (${m.limitsScope}) — documented defaults were used, never another user's row.` }); cautionReasons += 1; }
  if (m.sampleSize < 30) { riskFlags.push({ code: "SMALL_SAMPLE_SIZE", message: `Only ${m.sampleSize} closed paper trades in last 30d.` }); cautionReasons += 1; }
  if (m.winRate30d > 0 && m.winRate30d < 50) { riskFlags.push({ code: "WIN_RATE_UNSTABLE", message: `30d win rate ${m.winRate30d}% < 50%.` }); cautionReasons += 1; }
  if (m.learningConfidence < 30) { riskFlags.push({ code: "LEARNING_CONFIDENCE_LOW", message: `Learning confidence ${m.learningConfidence} is low.` }); cautionReasons += 1; }
  if (m.marketDataQuality === "FALLBACK_ONLY") { riskFlags.push({ code: "MARKET_DATA_FALLBACK_ONLY", message: "Market data is fallback-only." }); cautionReasons += 1; }
  if (m.repeatedMistakeCount > 0 && m.repeatedMistakeCount < 5) { riskFlags.push({ code: "MISTAKES_PRESENT", message: `${m.repeatedMistakeCount} repeated mistake pattern(s).` }); cautionReasons += 1; }

  // ── Status decision tree ────────────────────────────────────────────────
  const critical = hardBlocks.some(b => b.severity === "CRITICAL");
  const block = hardBlocks.length > 0;
  let status: OverallStatus;
  if (critical) status = "LOCKED";
  else if (block) status = "WATCH_ONLY";
  else if (pauseReasons > 0) status = "PAPER_PAUSED";
  else if (cautionReasons > 0) status = "PAPER_CAUTION";
  else status = "PAPER_ALLOWED";
  return { status, hardBlocks, softWarnings, riskFlags };
}

// ── Readiness scoring (0–100, mapped to grade + level) ───────────────────
function scoreReadiness(m: GovernorMetrics): { score: number; grade: ReadinessGrade; level: ReadinessLevel; breakdown: Record<string, number> } {
  // A. Risk discipline (25)
  let a = 25;
  const limitKnown = m.dailyLossLimitBasis !== "UNKNOWN" && m.dailyLossLimit > 0;
  if (limitKnown && m.dailyPnl <= -Math.abs(m.dailyLossLimit)) a -= 15;
  else if (limitKnown && m.dailyPnl < 0 && Math.abs(m.dailyPnl) >= 0.7 * Math.abs(m.dailyLossLimit)) a -= 8;
  // An underivable loss limit is a risk-discipline gap, not a free pass.
  else if (!limitKnown) a -= 8;
  if (m.openPaperTrades > m.maxOpenPaperTrades) a -= 10;
  if (Object.values(m.sameSymbolExposure).some(n => n >= 3)) a -= 5;
  if (m.avgRiskScore >= 80) a -= 5;
  a = Math.max(0, a);

  // B. Strategy edge maturity (25)
  let b = 0;
  if (m.sampleSize >= 100) b += 12;
  else if (m.sampleSize >= 50) b += 9;
  else if (m.sampleSize >= 20) b += 6;
  else if (m.sampleSize >= 5) b += 3;
  if (m.winRate30d >= 60) b += 8;
  else if (m.winRate30d >= 50) b += 5;
  else if (m.winRate30d >= 40) b += 2;
  if (m.maxDrawdown < 50) b += 5;
  else if (m.maxDrawdown < 100) b += 2;

  // C. AI decision quality (20)
  let c = 0;
  if (m.avgConfidence >= 70 && m.avgConfidence <= 90) c += 8;
  else if (m.avgConfidence >= 50) c += 4;
  if (m.avgRiskScore > 0 && m.avgRiskScore <= 60) c += 6;
  else if (m.avgRiskScore <= 80) c += 3;
  if (m.decisionToWinRate >= 60) c += 6;
  else if (m.decisionToWinRate >= 40) c += 3;

  // D. System reliability (15)
  let d = 0;
  if (m.marketDataQuality === "GOOD") d += 8;
  else if (m.marketDataQuality === "DEGRADED") d += 4;
  else if (m.marketDataQuality === "FALLBACK_ONLY") d += 2;
  if (m.autopilotErrorRate <= 5) d += 7;
  else if (m.autopilotErrorRate <= 20) d += 4;
  else if (m.autopilotErrorRate <= 50) d += 1;

  // E. Learning/debrief quality (15)
  let e = 0;
  if (m.learningConfidence >= 70) e += 8;
  else if (m.learningConfidence >= 40) e += 5;
  else if (m.learningConfidence > 0) e += 2;
  if (m.repeatedMistakeCount === 0) e += 7;
  else if (m.repeatedMistakeCount <= 2) e += 4;
  else if (m.repeatedMistakeCount <= 5) e += 2;

  const score = Math.max(0, Math.min(100, Math.round(a + b + c + d + e)));
  let grade: ReadinessGrade;
  if (score >= 90) grade = "A"; else if (score >= 80) grade = "B"; else if (score >= 70) grade = "C"; else if (score >= 60) grade = "D"; else grade = "F";

  let level: ReadinessLevel;
  if (m.sampleSize < 5) level = "NOT_READY";
  else if (m.sampleSize < 20 || score < 50) level = "EARLY_TESTING";
  else if (score < 70) level = "DEVELOPING_EDGE";
  else if (score < 85) level = "PAPER_STABLE";
  else level = "ADVANCED_PAPER_READY";

  return { score, grade, level, breakdown: { riskDiscipline: a, strategyEdge: b, aiQuality: c, systemReliability: d, learningQuality: e } };
}

function buildAllowedActions(status: OverallStatus, hardBlocks: HardBlock[]): AllowedActions {
  const locked = status === "LOCKED";
  const watchOnly = status === "WATCH_ONLY";
  const paused = status === "PAPER_PAUSED";
  const caution = status === "PAPER_CAUTION";
  const noOpen = locked || watchOnly || paused;
  const noAuto = locked || watchOnly || paused;
  const mdFailed = hardBlocks.some(b => b.code === "MARKET_DATA_FAILED");
  return {
    canRunAADecision: !locked,
    canOpenPaperTrade: !noOpen && !mdFailed,
    canRunPaperAutopilot: !noAuto,
    canManualClosePaperTrade: true, // ALWAYS allow manual close so users can exit safely
    canRebuildPerformance: !locked,
    canProcessLearning: !locked,
    canPlaceLiveTrade: false,
  };
}

function buildNextBestActions(status: OverallStatus, m: GovernorMetrics, hardBlocks: HardBlock[], soft: SoftWarning[]): string[] {
  const out: string[] = [];
  if (hardBlocks.some(b => b.code.startsWith("LIVE_"))) {
    out.push("Disable any live-trading flags immediately and re-evaluate the governor.");
  }
  if (hardBlocks.some(b => b.code === "MARKET_DATA_MODE_NOT_READ_ONLY")) {
    out.push('Set MARKET_DATA_MODE="read_only" before resuming any paper activity.');
  }
  if (hardBlocks.some(b => b.code === "DAILY_LOSS_LIMIT_EXCEEDED")) {
    out.push("Stop new paper trades for the day and review the day's debriefs.");
  }
  if (soft.some(s => s.code === "REVENGE_COOLDOWN_ACTIVE")) {
    out.push("Wait out the revenge-trade cooldown before opening any new paper trade.");
  }
  if (m.sampleSize < 30) {
    out.push("Continue paper trading to grow the sample size before changing strategies.");
  }
  if (m.repeatedMistakeCount >= 3) {
    out.push("Drill the most repeated mistake before the next session.");
  }
  if (status === "PAPER_ALLOWED") {
    out.push("Keep paper-practicing with discipline — live trading remains DISABLED by design.");
  }
  return out.slice(0, 5);
}

function buildExplanation(status: OverallStatus, score: number, grade: ReadinessGrade, level: ReadinessLevel, hardBlocks: HardBlock[], soft: SoftWarning[]): string {
  const parts: string[] = [];
  parts.push(`Status=${status} (readiness=${score}/${grade}, level=${level}).`);
  if (hardBlocks.length > 0) parts.push(`${hardBlocks.length} hard block(s): ${hardBlocks.map(b => b.code).join(", ")}.`);
  if (soft.length > 0) parts.push(`${soft.length} soft warning(s): ${soft.map(s => s.code).join(", ")}.`);
  parts.push("Live trading is DISABLED by design and Build HH never recommends enabling it.");
  return parts.join(" ");
}

// ── Main entry ────────────────────────────────────────────────────────────
export interface TimingAdvisory {
  symbol: string;
  heatState: string;
  entryPermission: string;
  heatScore: number;
  tradeabilityScore: number;
  timingGrade: string;
  recommendedLotMultiplier: number;
  advisoryNote: string;
}

export interface EvaluateOpts {
  persist?: boolean;
  governorId?: string;
  log?: EvalLog;
  simulate?: SimulateOverrides;
  symbol?: string;
  /** WHOSE governor this is. Callers that represent a signed-in trader MUST
   *  pass it; the limits and paper-trade metrics are then read from that
   *  trader's own rows. Instance-level readiness surfaces may omit it, in
   *  which case documented defaults are used and the evaluation says so via
   *  metrics.limitsScope — it never adopts another user's limits. */
  userId?: number | null;
}

export async function evaluateGovernor(opts: EvaluateOpts = {}): Promise<GovernorEvaluation> {
  const log = opts.log ?? defaultLog();
  const governorId = opts.governorId ?? `gov_${randomUUID()}`;
  const startedAt = new Date();
  log.info("evaluation started", { governorId });

  const userId = opts.userId ?? null;
  const { metrics, cooldowns, dataSourcesRead, missingDataSources } = await collectMetrics(opts.simulate, userId);
  log.info("data sources read", { count: dataSourcesRead.length, sources: dataSourcesRead });
  if (missingDataSources.length > 0) log.warn("missing data sources", { missing: missingDataSources });
  log.info("metrics calculated", { metrics });

  const { status, hardBlocks, softWarnings, riskFlags } = evaluateStatus(metrics, cooldowns, opts.simulate);
  log.info("hard blocks found", { count: hardBlocks.length });
  log.info("soft warnings found", { count: softWarnings.length });

  const { score, grade, level } = scoreReadiness(metrics);
  log.info("readiness score calculated", { score, grade, level });

  const allowedActions = buildAllowedActions(status, hardBlocks);
  log.info("allowed actions returned", { ...allowedActions });

  const nextBestActions = buildNextBestActions(status, metrics, hardBlocks, softWarnings);
  const explanation = buildExplanation(status, score, grade, level, hardBlocks, softWarnings);

  const evaluation: GovernorEvaluation = {
    governor_id: governorId,
    evaluated_at: startedAt.toISOString(),
    mode: "PAPER_ONLY",
    liveTradingStatus: "DISABLED",
    overallStatus: status,
    paperTradingAllowed: allowedActions.canOpenPaperTrade,
    autopilotAllowed: allowedActions.canRunPaperAutopilot,
    manualPaperAllowed: allowedActions.canManualClosePaperTrade,
    liveTradingAllowed: false,
    readinessScore: score,
    readinessGrade: grade,
    readinessLevel: level,
    hardBlocks, softWarnings, riskFlags, cooldowns,
    metrics,
    nextBestActions,
    allowedActions,
    explanation,
    generatedAt: new Date().toISOString(),
    dataSourcesRead, missingDataSources,
  };

  // Phase 3 — attach timing advisory (advisory only, fail-open, never a gate).
  if (opts.symbol) {
    try {
      const read = await computeTimingRead({ symbol: opts.symbol, timeframe: "M15", persistSnapshot: false });
      const lotMultMap: Record<string, number> = {
        GO: 1.0, WAIT_FOR_ENTRY: 0.75, WAIT_NEWS: 0.5, NO_TRADE: 0.5, STAND_DOWN: 0.25,
      };
      const noteMap: Record<string, string> = {
        GO: "Heat conditions are clean — standard sizing is appropriate.",
        WAIT_FOR_ENTRY: "Timing is warming up — consider reducing size slightly while waiting for entry confirmation.",
        WAIT_NEWS: "News window active — reduce size; wait for the first post-news candle to close.",
        NO_TRADE: "Timing engine advises sitting out — consider staying flat or reducing to minimum size.",
        STAND_DOWN: "High-danger conditions — timing strongly advises against new positions; if already in a trade, tighten stops.",
      };
      evaluation.timingAdvisory = {
        symbol: opts.symbol,
        heatState: read.heatState,
        entryPermission: read.entryPermission,
        heatScore: read.heatScore,
        tradeabilityScore: read.tradeabilityScore,
        timingGrade: read.timingGrade,
        recommendedLotMultiplier: lotMultMap[read.entryPermission] ?? 1.0,
        advisoryNote: noteMap[read.entryPermission] ?? "Timing context is advisory — review heat data before sizing.",
      };
    } catch {
      // Fail-open: timing advisory is non-critical; evaluation proceeds without it.
    }
  }

  if (opts.persist !== false) {
    try {
      await db.insert(riskGovernorEvaluationsTable).values({
        governorId, overallStatus: status, mode: "PAPER_ONLY", liveTradingStatus: "DISABLED",
        readinessScore: score, readinessGrade: grade, readinessLevel: level,
        paperTradingAllowed: evaluation.paperTradingAllowed, autopilotAllowed: evaluation.autopilotAllowed,
        manualPaperAllowed: evaluation.manualPaperAllowed, liveTradingAllowed: false,
        hardBlocks, softWarnings, riskFlags, cooldowns,
        metrics, nextBestActions, allowedActions: allowedActions as unknown as Record<string, unknown>, explanation,
      }).onConflictDoUpdate({
        target: riskGovernorEvaluationsTable.governorId,
        set: {
          overallStatus: status, readinessScore: score, readinessGrade: grade, readinessLevel: level,
          paperTradingAllowed: evaluation.paperTradingAllowed, autopilotAllowed: evaluation.autopilotAllowed,
          manualPaperAllowed: evaluation.manualPaperAllowed,
          hardBlocks, softWarnings, riskFlags, cooldowns,
          metrics, nextBestActions, allowedActions: allowedActions as unknown as Record<string, unknown>, explanation,
        },
      });
      // Emit events for hard blocks
      for (const hb of hardBlocks) {
        await db.insert(riskGovernorEventsTable).values({
          governorId, eventType: "HARD_BLOCK", severity: hb.severity, message: hb.message, details: hb.details ?? {},
        });
      }
      for (const sw of softWarnings) {
        await db.insert(riskGovernorEventsTable).values({
          governorId, eventType: "SOFT_WARNING", severity: "WARN", message: sw.message, details: sw.details ?? {},
        });
      }
      log.info("evaluation stored", { governorId });
    } catch (e) {
      log.error("evaluation persist failed", { err: String(e).slice(0, 200) });
    }
  }
  log.info("evaluation completed", { governorId, status, score });
  return evaluation;
}

/** Lightweight governor check for EE / FF gates. Reads from a recent persisted
 *  evaluation if one exists in the last 60s; otherwise runs a fresh eval. */
export interface GovernorGateResult {
  allowed: boolean;
  status: OverallStatus;
  reasons: string[];
  governorId: string;
}

export async function gateForPaperTrade(userId?: number | null): Promise<GovernorGateResult> {
  const e = await evaluateGovernor({ persist: false, userId: userId ?? null });
  return {
    allowed: e.allowedActions.canOpenPaperTrade,
    status: e.overallStatus,
    reasons: [...e.hardBlocks.map(b => `${b.code}: ${b.message}`), ...e.softWarnings.map(s => `${s.code}: ${s.message}`)],
    governorId: e.governor_id,
  };
}
export async function gateForAutopilot(userId?: number | null): Promise<GovernorGateResult> {
  const e = await evaluateGovernor({ persist: false, userId: userId ?? null });
  return {
    allowed: e.allowedActions.canRunPaperAutopilot,
    status: e.overallStatus,
    reasons: [...e.hardBlocks.map(b => `${b.code}: ${b.message}`), ...e.softWarnings.map(s => `${s.code}: ${s.message}`)],
    governorId: e.governor_id,
  };
}
