// ARX AI Assistant — backend tool layer.
// Every tool is user-scoped: takes a userId and queries only that user's rows.
// Read-only by design. NEVER places trades or returns secrets (apiKeyHash,
// passwordHash, MT5_BRIDGE_TOKEN, SESSION_SECRET, raw bridge tokens).
//
// Pre-trade risk check is purely advisory; live order execution is system-locked.

import {
  db,
  paperTradesTable,
  tradeJournalTable,
  paperSessionsTable,
  userNotificationsTable,
  userActivityTimelineTable,
  userRiskSettingsTable,
  mt5ConnectionTable,
  usersTable,
  propChallengesTable,
  paperOrdersTable,
  sharedTradeAttributionTable,
  unattributedMasterTradesTable,
  adminActionAuditLogTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { ARX_FEATURES, getAppFeatureMap, explainFeature as featureExplain, getAppFeatureRegistry as featureRegistry, getFeatureHelp as featureHelpLookup, getCurrentPageHelp as pageHelpLookup } from "./featureMap.js";
import { scannerStatus, effectiveOpportunityScore, DEFAULT_SYMBOLS } from "../marketScanner.js";
import { getMarketProvider, getMarketStatus, getCurrentEventsFromProvider } from "./marketProvider.js";
import { sanitizeExternalText } from "../security/promptInjectionGuard.js";
import { mapLegacyToDecisionStatus } from "./decisionStatus.js";
import { scanCoreOpportunities } from "../data/marketOverview.js";
import {
  classifyLivePosition,
  classifyAttribution,
  classifyTradeKey,
  getUserSnapshotReliable,
} from "../live/positionTruthAdapter.js";
import type { PositionTruthVerdict } from "@workspace/domain/live-position";
import { isApprovedArxMarket, ARX_FOCUS_BLOCKED_REASON } from "@workspace/domain/market";
import { deriveOpportunityLabel, projectOpportunitySetup } from "../data/opportunityAdapters.js";
import { evaluatePaperTradePlan, getTradingStyleProfile } from "./coachTools.js";
import { getVoiceModeStatus } from "./realtimeSession.js";
import { mapLegacyReconciliationStatus } from "@workspace/domain/safety-contracts/reconciliation";
import { mapLegacyBridgeMode, applyHeartbeatStaleness } from "@workspace/domain/safety-contracts/bridgeMode";
import { isLiveBrokerExecutionEnabledEnv } from "@workspace/domain/safety-contracts/isLiveBrokerExecutionEnabled";
import { computeAccountShell } from "../../routes/meAccountShell.js";
import { aggregateReconciliationIssues } from "../reconciliation/detect.js";
import { resolveAssistantMarket } from "../markets/assistantMarketResolver.js";
import { buildRubyStructuralRead } from "./rubyStructuralReadService.js";
import {
  deriveAssistantEnvelope,
  assistantEnvelopeFields,
  buildPaperSafetyStatus,
  liveExecutionAvailabilityNote,
  type SafetyEnvelope,
} from "./derivedEnvelope.js";
import { getAssistantDisplayName } from "./assistantName.js";

// Shared "feed not confirmed" honesty caveat (mirrors the chart-read signal).
// A market read is only "confirmed" when the data quality is good AND the most
// recent bar/quote is a live (REALTIME) tick. Anything else — partial /
// insufficient candles, or a DELAYED/STALE/UNAVAILABLE last value — is an
// unconfirmed feed, so Ruby must caveat the read. Advisory only: this never
// gates execution (Ruby is read-only) and never fabricates data.
const FEED_NOT_CONFIRMED_CAVEAT =
  "Feed not confirmed at read-time — limited visibility. Tell the user this read is low-confidence and to verify the live feed before trading.";

// Task #816 — the honest "feed cannot be confirmed" status that EVERY market
// tool's block / withheld / error branch must carry, so Eleanor is never handed
// an undefined feed signal (an undefined feedConfirmed/freshness is exactly what
// made her market answers go silently blank). Advisory only — mirrors the values
// getMarketSnapshot's ARX-blocked return already emits; fabricates no price and
// weakens no live-data honesty gate (blocks still block, nothing is fetched).
//
// Flat variant — for tools whose success shape exposes the feed signal at the
// TOP level (getMarketSnapshot and the shared withheld-advice payload).
function unavailableFeedStatusFields() {
  return {
    source: null,
    quality: "unavailable" as const,
    aiUsable: false as const,
    isLive: false as const,
    stale: true as const,
    freshness: "UNAVAILABLE" as const,
    feedConfirmed: false as const,
    feedCaveat: FEED_NOT_CONFIRMED_CAVEAT,
  };
}

// Nested variant — for the context tools (getSymbolMarketContext /
// getTradeMarketContext) whose success shape nests the feed signal under
// `context`. Eleanor is instructed to read context.feedConfirmed AND
// context.dataQuality.quality, so BOTH must be defined on every branch here too.
function unavailableFeedContext(cause: string | null = null) {
  return {
    source: null,
    freshness: "UNAVAILABLE" as const,
    dataQuality: { quality: "unavailable" as const },
    sharedQuality: null,
    sharedAiUsable: null,
    sharedCause: cause,
    feedConfirmed: false as const,
    feedCaveat: FEED_NOT_CONFIRMED_CAVEAT,
  };
}

// Safe reason extraction for the feed-status catch branches — a non-Error throw
// value must not itself throw (which would defeat the honest-fallback contract).
function errReason(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 120);
}

// ── helpers ─────────────────────────────────────────────────────────────
function dayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function publicConn(c: typeof mt5ConnectionTable.$inferSelect) {
  return {
    id: c.id,
    connectionName: c.connectionName,
    status: c.status,
    accountNumber: c.accountNumber,
    brokerName: c.brokerName,
    server: (c as Record<string, unknown>).server ?? null,
    leverage: (c as Record<string, unknown>).leverage ?? null,
    currency: (c as Record<string, unknown>).currency ?? null,
    tokenLast4: c.tokenLast4,
    lastHeartbeat: c.lastHeartbeat,
  };
}

// Honest per-user reported account mode for assistant reporting surfaces.
// DERIVED from the canonical per-user envelope (`safetyMode`), fail-closed to
// "paper_only" on any error. This is REPORTING ONLY — it authorizes nothing.
// Live execution stays governed by the per-user activation gate + the 23-gate
// Phase B dispatch + the per-trade confirmation choreography.
async function reportedAccountMode(
  userId: number,
): Promise<SafetyEnvelope["safetyMode"]> {
  try {
    const env = await deriveAssistantEnvelope(userId);
    return env.safetyMode;
  } catch {
    return "paper_only";
  }
}

// ── 1. getCurrentUserContext ────────────────────────────────────────────
export async function getCurrentUserContext(userId: number) {
  const rows = await db.select({
    id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role,
    createdAt: usersTable.createdAt,
  }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const u = rows[0];
  if (!u) return { connected: false,};
  // Phase 3.5 — include routing summary so the assistant can answer
  // "where do my trades go?" without ever exposing master credentials.
  let routing: Awaited<ReturnType<typeof getRoutingContext>> | null = null;
  try { routing = await getRoutingContext(userId); } catch { routing = null; }
  // Phase Account-Shell — proactive answer hooks for "what's my balance",
  // "how much risk do I have left", "am I approved" without forcing a
  // second tool call. Per-user scoped via computeAccountShell.
  let accountShellSummary: {
    accountMode: string;
    approvalStatus: string;
    tradingStatus: string;
    accountStatus: string;
    currentBalance: number;
    // null = no marked-to-market equity read exists (never balance-as-equity).
    equity: number | null;
    availableRisk: number | null;
    availableRiskAmount: number | null;
    dailyLossRemaining: number | null;
  } | null = null;
  try {
    const shell = await computeAccountShell(userId);
    accountShellSummary = {
      accountMode: shell.accountMode,
      approvalStatus: shell.approvalStatus,
      tradingStatus: shell.tradingStatus,
      accountStatus: `${shell.approvalStatus}/${shell.tradingStatus}`,
      currentBalance: shell.allocation.currentBalance,
      equity: shell.allocation.equity,
      availableRisk: shell.risk.availableRiskAmount,
      availableRiskAmount: shell.risk.availableRiskAmount,
      dailyLossRemaining: shell.risk.dailyLossRemaining,
    };
  } catch { accountShellSummary = null; }
  return {
    connected: true,
    user: { id: u.id, email: u.email, name: u.name, role: u.role, memberSince: u.createdAt },
    accountMode: await reportedAccountMode(userId),
    routing,
    accountShell: accountShellSummary,
  };
}

// ── 1b. getRoutingContext (Phase 3.5) ───────────────────────────────────
// Read-only summary of this user's effective account routing. NEVER
// returns master credentials — only the connection id + connection type +
// masked broker label. The assistant uses this to truthfully answer
// "where do my trades go?". Falls back to a safe inert payload if the
// envelope module is unavailable for any reason.
export async function getRoutingContext(userId: number) {
  try {
    const { getEnvelope } = await import("../adminTrading/safetyEnvelope.js");
    const env = await getEnvelope(userId);
    let brokerLabel: string | null = null;
    let sharedMasterLabel: string | null = null;
    if (env.connectionType === "user_owned") {
      const [c] = await db.select().from(mt5ConnectionTable)
        .where(eq(mt5ConnectionTable.userId, userId)).limit(1);
      brokerLabel = c
        ? `${c.brokerName ?? "MT5"} ${c.accountNumber ? `(•••• ${String(c.accountNumber).slice(-4)})` : ""}`.trim()
        : null;
    } else if (env.connectionType === "shared_master") {
      sharedMasterLabel = env.accountRoutingMode === "SHARED_MASTER_MT5"
        ? "Shared master MT5 (managed by ARX admin)" : null;
    }
    return {
      accountRoutingMode: env.accountRoutingMode,
      connectionType: env.connectionType,
      routingOverride: env.routingOverride,
      sharedDemoConfigured: env.sharedDemoConfigured,
      sharedLiveConfigured: env.sharedLiveConfigured,
      sharedLiveTradingEnabled: env.sharedLiveTradingEnabled,
      brokerLabel,
      sharedMasterLabel,
      explanation: env.connectionType === "shared_master"
        ? "Your orders are queued through ARX's shared master MT5 account. ARX keeps your virtual balance, P&L and exposure isolated per user. You never see and never need the master broker credentials."
        : "Your orders go to your own MT5 connection. ARX never holds your broker password — only your local terminal/EA touches it.",
    };
  } catch {
    // Honest unknown — NEVER a guessed routing mode. The envelope read failed,
    // so we do not know where this user's orders would go; answering with a
    // concrete enum ("USER_OWNED_MT5") would let the assistant quote a definite
    // wrong routing mode to a shared-master user. Typed nulls + "unknown" so the
    // model has nothing confident to repeat.
    return {
      accountRoutingMode: null,
      connectionType: "unknown" as const,
      routingOverride: null,
      sharedDemoConfigured: null, sharedLiveConfigured: null, sharedLiveTradingEnabled: null,
      brokerLabel: null, sharedMasterLabel: null,
      explanation: "Routing context temporarily unavailable — the account routing mode could not be read, so it is unknown right now. Do not state where orders would go. Trading remains read-only.",
    };
  }
}

// ── 1c. getTeamReportSummary ────────────────────────────────────────────
// User-facing, read-only: returns the latest day's plain-English summary of
// how the decision-support "trading team" performed. Reuses ONLY the persisted
// `rubySummary` (built by buildRubySummary), which carries no internal agent
// codes, table/route names, or operator/admin numbers. Never returns the
// structured report body, headline, or registry totals. Honest empty state when
// no report has been generated yet — never fabricates a summary. Not user-scoped
// because the report is a system-wide picture of the advisory desk, but it
// exposes nothing operator-only and nothing about any other user.
export async function getTeamReportSummary() {
  const { getLatestRubyTeamSummary } = await import("../agentEcosystem/householdReport.js");
  const latest = await getLatestRubyTeamSummary();
  if (!latest) {
    return {
      isEmpty: true,
      reportDate: null,
      summary: null,
      note: "The trading team's daily summary hasn't been generated yet. Check back once the desk has run for the day.",
    };
  }
  return {
    isEmpty: false,
    reportDate: latest.reportDate,
    summary: latest.rubySummary,
  };
}

// ── 2. getAppFeatureMap ─────────────────────────────────────────────────
export function getAppFeatureMapTool() {
  return { ...getAppFeatureMap(),};
}

// ── 3. getMT5BridgeStatus ───────────────────────────────────────────────
export async function getMT5BridgeStatus(userId: number) {
  const rows = await db.select().from(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, userId));
  const connections = rows.map(publicConn);
  const anyConnected = connections.some((c) => c.status === "connected");
  const env = await deriveAssistantEnvelope(userId);
  const assistantName = await getAssistantDisplayName(userId);
  return {
    hasConnection: connections.length > 0,
    isConnected: anyConnected,
    connections,
    bridgeMode: "per_user",
    note: connections.length === 0
      ? "No MT5 connection configured. Add one from the MT5 page to enable bridge sync."
      : `MT5 bridge is per-user. ${liveExecutionAvailabilityNote(env, assistantName)}`,
  };
}

// ── 4. getMT5Heartbeat ──────────────────────────────────────────────────
export async function getMT5Heartbeat(userId: number) {
  const rows = await db.select({
    id: mt5ConnectionTable.id, status: mt5ConnectionTable.status,
    lastHeartbeat: mt5ConnectionTable.lastHeartbeat,
  }).from(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, userId));
  const now = Date.now();
  const items = rows.map((r) => {
    const ageSec = r.lastHeartbeat ? Math.floor((now - new Date(r.lastHeartbeat).getTime()) / 1000) : null;
    return {
      connectionId: r.id, status: r.status, lastHeartbeat: r.lastHeartbeat,
      ageSeconds: ageSec,
      health: ageSec == null ? "unknown" : ageSec <= 60 ? "healthy" : ageSec <= 300 ? "stale" : "unhealthy",
    };
  });
  return { items,};
}

// ── 5. getAccountSnapshot (paper) ───────────────────────────────────────
export async function getAccountSnapshot(userId: number) {
  const sessions = await db.select().from(paperSessionsTable)
    .where(eq(paperSessionsTable.userId, userId))
    .orderBy(desc(paperSessionsTable.createdAt))
    .limit(1);
  const session = sessions[0] ?? null;
  const totals = await db.select({
    closedCount: sql<number>`COALESCE(COUNT(*) FILTER (WHERE ${paperTradesTable.status} = 'closed'), 0)`.mapWith(Number),
    openCount: sql<number>`COALESCE(COUNT(*) FILTER (WHERE ${paperTradesTable.status} = 'open'), 0)`.mapWith(Number),
    totalPnl: sql<number>`COALESCE(SUM(${paperTradesTable.pnl}) FILTER (WHERE ${paperTradesTable.status} = 'closed'), 0)`.mapWith(Number),
    wins: sql<number>`COALESCE(COUNT(*) FILTER (WHERE ${paperTradesTable.status} = 'closed' AND ${paperTradesTable.pnl} > 0), 0)`.mapWith(Number),
    losses: sql<number>`COALESCE(COUNT(*) FILTER (WHERE ${paperTradesTable.status} = 'closed' AND ${paperTradesTable.pnl} < 0), 0)`.mapWith(Number),
  }).from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const t = totals[0] ?? { closedCount: 0, openCount: 0, totalPnl: 0, wins: 0, losses: 0 };
  const winRate = t.closedCount > 0 ? Math.round((t.wins / t.closedCount) * 1000) / 10 : null;
  return {
    accountMode: await reportedAccountMode(userId),
    session: session ? {
      id: session.id, name: (session as Record<string, unknown>).name ?? null,
      startingBalance: (session as Record<string, unknown>).startingBalance ?? null,
      currentBalance: (session as Record<string, unknown>).currentBalance ?? null,
      status: (session as Record<string, unknown>).status ?? null,
    } : null,
    closedCount: Number(t.closedCount), openCount: Number(t.openCount),
    totalPnl: Number(t.totalPnl), wins: Number(t.wins), losses: Number(t.losses),
    winRate,
    isEmpty: Number(t.closedCount) === 0 && Number(t.openCount) === 0,
  };
}

// ── 6. getOpenPositions ─────────────────────────────────────────────────
export async function getOpenPositions(userId: number) {
  const rows = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.status, "open")))
    .orderBy(desc(paperTradesTable.openedAt))
    .limit(50);
  return {
    count: rows.length,
    positions: rows.map((r) => ({
      id: r.id, symbol: r.symbol, side: r.side, lotSize: r.lotSize,
      entryPrice: r.entryPrice, stopLoss: r.stopLoss, takeProfit: r.takeProfit,
      openedAt: r.openedAt, strategy: (r as Record<string, unknown>).strategy ?? null,
    })),
    isEmpty: rows.length === 0,
  };
}

// ── 7. getTradeJournalSummary ───────────────────────────────────────────
export async function getTradeJournalSummary(userId: number, lookbackDays = 30) {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.status, "closed")))
    .orderBy(desc(paperTradesTable.closedAt))
    .limit(200);
  const recent = rows.filter((r) => r.closedAt && new Date(r.closedAt) >= since);
  const bySymbol = new Map<string, { count: number; pnl: number }>();
  for (const t of recent) {
    const key = t.symbol ?? "unknown";
    const cur = bySymbol.get(key) ?? { count: 0, pnl: 0 };
    cur.count += 1; cur.pnl += Number(t.pnl ?? 0);
    bySymbol.set(key, cur);
  }
  return {
    lookbackDays,
    totalClosed: recent.length,
    perSymbol: Array.from(bySymbol, ([symbol, v]) => ({ symbol, ...v })).sort((a, b) => b.count - a.count).slice(0, 10),
    isEmpty: recent.length === 0,
  };
}

// ── 8. getDailyPnLCalendar ──────────────────────────────────────────────
export async function getDailyPnLCalendar(userId: number, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.status, "closed")));
  const map = new Map<string, { date: string; tradesCount: number; totalPnl: number; wins: number; losses: number }>();
  for (const t of rows) {
    if (!t.closedAt) continue;
    const d = new Date(t.closedAt);
    if (d < since) continue;
    const k = dayKey(d);
    const cur = map.get(k) ?? { date: k, tradesCount: 0, totalPnl: 0, wins: 0, losses: 0 };
    cur.tradesCount += 1;
    const pnl = Number(t.pnl ?? 0);
    cur.totalPnl += pnl;
    if (pnl > 0) cur.wins += 1; else if (pnl < 0) cur.losses += 1;
    map.set(k, cur);
  }
  const days_ = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  return { days: days_, isEmpty: days_.length === 0,};
}

// ── 9. getRiskLimits ────────────────────────────────────────────────────
export async function getRiskLimits(userId: number) {
  const rows = await db.select().from(userRiskSettingsTable)
    .where(eq(userRiskSettingsTable.userId, userId)).limit(1);
  const r = rows[0] ?? null;
  if (!r) {
    return { hasRiskSettings: false, defaults: true, note: "No personal risk settings yet — defaults apply.",};
  }
  return {
    hasRiskSettings: true,
    limits: {
      maxRiskPerTradePercent: r.maxRiskPerTradePercent,
      maxDailyLossPercent: r.maxDailyLossPercent,
      maxOpenTrades: r.maxOpenTrades,
      maxTradesPerDay: r.maxTradesPerDay,
      maxConsecutiveLosses: r.maxConsecutiveLosses,
      minRewardRiskRatio: r.minRewardRiskRatio,
      cooldownAfterLossMinutes: r.cooldownAfterLossMinutes,
      requireStopLoss: r.requireStopLoss,
      requirePlaybook: r.requirePlaybook,
      requireJournalReason: r.requireJournalReason,
    },
  };
}

// ── 8b. getMyPerformanceSummary ─────────────────────────────────────────
/**
 * Phase 25 — Trade Journal + Performance Awareness.
 * One per-user-scoped tool that answers the spec's user-facing questions:
 *   • "How am I performing?"          → headline win-rate / P&L (closed only)
 *   • "What trades did I take today?" → todayCount + todayPnl
 *   • "Biggest mistake?"              → topMistakes (from journal mistakeTag)
 *   • "Which strategy is working?"    → strategyRanking (by total P&L)
 *   • "Which trade hurt me most?"     → largestLoss
 *   • "Am I overtrading?"             → overtradingHint (today vs 30d avg)
 *   • "What should I review?"         → reviewSuggestion
 *   • "Lessons from closed trades?"   → recentLessons (from journal)
 *
 * Honest fallbacks: returns `isEmpty:true` with a clear emptyMessage when no
 * closed trades exist. Never invents win rate, P&L, or lessons. Win rate is
 * computed ONLY from closed trades, never from open ones. Per-user-scoped on
 * every query (paper_trades.userId + trade_journal.userId).
 */
export async function getMyPerformanceSummary(userId: number, lookbackDays = 30) {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const todayKey = dayKey(new Date());
  const [closedRows, openRows, journalRows] = await Promise.all([
    db.select().from(paperTradesTable)
      .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.status, "closed")))
      .orderBy(desc(paperTradesTable.closedAt)).limit(500),
    db.select().from(paperTradesTable)
      .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.status, "open"))),
    db.select().from(tradeJournalTable)
      .where(eq(tradeJournalTable.userId, userId))
      .orderBy(desc(tradeJournalTable.createdAt)).limit(200),
  ]);

  const recent = closedRows.filter((r) => r.closedAt && new Date(r.closedAt) >= since);
  const totalClosed = recent.length;

  if (totalClosed === 0 && journalRows.length === 0) {
    return {
      isEmpty: true,
      emptyMessage: "Not enough trade history yet. Place a paper trade and journal it to start building your performance picture.",
      lookbackDays, openTrades: openRows.length,
    };
  }

  const wins = recent.filter((r) => Number(r.pnl ?? 0) > 0);
  const losses = recent.filter((r) => Number(r.pnl ?? 0) < 0);
  const breakeven = totalClosed - wins.length - losses.length;
  const realizedPnl = Number(recent.reduce((s, r) => s + Number(r.pnl ?? 0), 0).toFixed(4));
  const winRate = totalClosed > 0 ? Number(((wins.length / totalClosed) * 100).toFixed(1)) : null;
  const avgWin = wins.length > 0
    ? Number((wins.reduce((s, r) => s + Number(r.pnl ?? 0), 0) / wins.length).toFixed(4)) : null;
  const avgLoss = losses.length > 0
    ? Number((losses.reduce((s, r) => s + Number(r.pnl ?? 0), 0) / losses.length).toFixed(4)) : null;
  const largestWin = wins.length > 0
    ? wins.reduce((b, r) => (Number(r.pnl ?? 0) > Number(b.pnl ?? 0) ? r : b))
    : null;
  const largestLoss = losses.length > 0
    ? losses.reduce((b, r) => (Number(r.pnl ?? 0) < Number(b.pnl ?? 0) ? r : b))
    : null;
  const profitFactor = (avgLoss != null && avgLoss !== 0 && avgWin != null)
    ? Number(Math.abs((avgWin * wins.length) / (avgLoss * losses.length)).toFixed(2))
    : null;

  const todayClosed = recent.filter((r) => r.closedAt && dayKey(new Date(r.closedAt)) === todayKey);
  const todayCount = todayClosed.length;
  const todayPnl = Number(todayClosed.reduce((s, r) => s + Number(r.pnl ?? 0), 0).toFixed(4));
  const distinctDays = new Set(recent.filter((r) => r.closedAt).map((r) => dayKey(new Date(r.closedAt!)))).size;
  const avgTradesPerActiveDay = distinctDays > 0 ? Number((totalClosed / distinctDays).toFixed(2)) : 0;
  const overtradingHint = (distinctDays >= 3 && todayCount > 0 && avgTradesPerActiveDay > 0 && todayCount >= Math.max(5, 2 * avgTradesPerActiveDay))
    ? `Today's count (${todayCount}) is well above your ${lookbackDays}-day average of ${avgTradesPerActiveDay}/active-day. Consider whether each trade has a real edge.`
    : null;
  const overtradingNote = distinctDays < 3
    ? "Not enough active trading days to judge overtrading yet."
    : null;

  const strategyMap = new Map<string, { strategy: string; count: number; pnl: number; wins: number; losses: number }>();
  for (const r of recent) {
    const key = r.strategyTag ?? "(no strategy tag)";
    const cur = strategyMap.get(key) ?? { strategy: key, count: 0, pnl: 0, wins: 0, losses: 0 };
    cur.count += 1;
    const p = Number(r.pnl ?? 0);
    cur.pnl += p;
    if (p > 0) cur.wins += 1; else if (p < 0) cur.losses += 1;
    strategyMap.set(key, cur);
  }
  const strategyRanking = Array.from(strategyMap.values())
    .map((s) => ({ ...s, pnl: Number(s.pnl.toFixed(4)) }))
    .sort((a, b) => b.pnl - a.pnl);
  const bestStrategy = strategyRanking[0]?.strategy ?? null;
  const worstStrategy = strategyRanking.length > 0 ? strategyRanking[strategyRanking.length - 1].strategy : null;

  const mistakeMap = new Map<string, number>();
  for (const j of journalRows) {
    const tag = j.mistakeTag && j.mistakeTag !== "None" ? j.mistakeTag : null;
    if (!tag) continue;
    mistakeMap.set(tag, (mistakeMap.get(tag) ?? 0) + 1);
  }
  const topMistakes = Array.from(mistakeMap, ([mistake, count]) => ({ mistake, count }))
    .sort((a, b) => b.count - a.count).slice(0, 5);

  const recentLessons = journalRows
    .filter((j) => j.lessonLearned && j.lessonLearned.trim().length > 0)
    .slice(0, 5)
    .map((j) => ({
      journalId: j.id, symbol: j.symbol, strategy: j.strategy,
      lesson: j.lessonLearned, createdAt: j.createdAt,
    }));

  let reviewSuggestion: string;
  if (winRate != null && winRate < 40 && totalClosed >= 5) {
    reviewSuggestion = `Win rate is ${winRate}% over ${totalClosed} closed trades — review recent losers before placing more.`;
  } else if (topMistakes.length > 0) {
    reviewSuggestion = `Recurring journal mistake: "${topMistakes[0].mistake}" (${topMistakes[0].count}× logged). Review those entries.`;
  } else if (worstStrategy && strategyMap.get(worstStrategy)!.pnl < 0) {
    reviewSuggestion = `Strategy "${worstStrategy}" is your weakest right now — review setups before re-running it.`;
  } else {
    reviewSuggestion = "Nothing alarming flagged — keep logging trades and lessons to refine the picture.";
  }

  return {
    isEmpty: false,
    lookbackDays,
    headline: {
      totalClosed, openTrades: openRows.length,
      wins: wins.length, losses: losses.length, breakeven,
      winRate, // null when no closed trades
      realizedPnl,
      winRateNote: winRate == null ? "Win rate unavailable — no closed trades in window." : "Win rate computed from closed trades only (open trades excluded).",
    },
    today: { count: todayCount, realizedPnl: todayPnl, isToday: todayKey },
    averages: { avgWin, avgLoss, profitFactor,
      profitFactorNote: profitFactor == null ? "Profit factor unavailable — need at least one win and one loss." : null,
    },
    extremes: {
      largestWin: largestWin ? { id: largestWin.id, symbol: largestWin.symbol, pnl: Number(largestWin.pnl ?? 0), closedAt: largestWin.closedAt } : null,
      largestLoss: largestLoss ? { id: largestLoss.id, symbol: largestLoss.symbol, pnl: Number(largestLoss.pnl ?? 0), closedAt: largestLoss.closedAt } : null,
    },
    strategyRanking,
    bestStrategy, worstStrategy,
    topMistakes,
    recentLessons,
    overtradingHint,
    overtradingNote,
    reviewSuggestion,
    unrealizedPnlNote: "Unrealized P&L on open trades is not included — requires fresh live price per symbol. Call getMyLiveOpenTrades + getTradeIntelligence per trade for that.",
    dataSource: "user_paper_trades_and_journal_only",
    perUserScoped: true,
  };
}

// ── 9b. getOpenExposure ─────────────────────────────────────────────────
/**
 * Phase 26 — Portfolio Awareness.
 * Returns total open notional / lot exposure broken down by symbol and side
 * for the signed-in user only. Reads paper_trades WHERE userId=userId AND
 * status='open'. Never reads another user's rows. Never invents prices.
 */
export async function getOpenExposure(userId: number) {
  const rows = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.status, "open")));
  const bySymbol = new Map<string, { symbol: string; longLots: number; shortLots: number; netLots: number; positions: number }>();
  let totalLongLots = 0, totalShortLots = 0;
  for (const r of rows) {
    const sym = r.symbol ?? "unknown";
    const lots = Number(r.lotSize ?? 0);
    const side = String(r.side ?? "").toLowerCase();
    const cur = bySymbol.get(sym) ?? { symbol: sym, longLots: 0, shortLots: 0, netLots: 0, positions: 0 };
    if (side === "buy") { cur.longLots += lots; totalLongLots += lots; }
    else if (side === "sell") { cur.shortLots += lots; totalShortLots += lots; }
    cur.netLots = cur.longLots - cur.shortLots;
    cur.positions += 1;
    bySymbol.set(sym, cur);
  }
  return {
    accountMode: await reportedAccountMode(userId),
    openPositionsCount: rows.length,
    totalLongLots, totalShortLots,
    netLots: totalLongLots - totalShortLots,
    bySymbol: Array.from(bySymbol.values()).sort((a, b) => b.positions - a.positions),
    isEmpty: rows.length === 0,
    note: "Lot totals are paper-trade lot counts. Notional/USD exposure requires connected market data per symbol — call getMarketSnapshot per symbol to compute that honestly.",
  };
}

// ── 9c. getRiskUtilization ──────────────────────────────────────────────
/**
 * Phase 26 — Portfolio Awareness.
 * Reports how much of the user's configured risk envelope is in use right
 * now: open trades / maxOpenTrades, today's realized loss vs maxDailyLoss,
 * and whether they are at/over any limit. Per-user-scoped. Returns
 * hasRiskSettings:false when the user has no settings row — never invents
 * default percentages.
 */
export async function getRiskUtilization(userId: number) {
  const limitsRes = await getRiskLimits(userId);
  const limits = (limitsRes as { hasRiskSettings: boolean; limits?: Record<string, unknown> });
  const openRes = await getOpenPositions(userId);
  const openCount = Number(openRes.count ?? 0);
  // Today's realized P&L (closed paper trades since 00:00 UTC)
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const closedToday = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.status, "closed")));
  let todaysRealizedPnl = 0, todaysLoss = 0;
  for (const r of closedToday) {
    if (!r.closedAt || new Date(r.closedAt) < dayStart) continue;
    const p = Number(r.pnl ?? 0);
    todaysRealizedPnl += p;
    if (p < 0) todaysLoss += -p;
  }
  if (!limits.hasRiskSettings) {
    return {
      hasRiskSettings: false,
      openTrades: openCount,
      todaysRealizedPnl,
      todaysLoss,
      atOrOverLimit: false,
      blockingReasons: [],
      note: "No personal risk settings configured — utilization is reported only against open positions today. Defaults will apply on order submission.",
    };
  }
  const maxOpen = Number(limits.limits?.maxOpenTrades ?? 0) || null;
  const maxDailyLossPct = Number(limits.limits?.maxDailyLossPercent ?? 0) || null;
  const blocking: string[] = [];
  if (maxOpen && openCount >= maxOpen) blocking.push(`MAX_OPEN_TRADES_REACHED (${openCount}/${maxOpen})`);
  return {
    hasRiskSettings: true,
    openTrades: openCount,
    maxOpenTrades: maxOpen,
    openTradesUtilization: maxOpen ? Math.round((openCount / maxOpen) * 100) : null,
    todaysRealizedPnl,
    todaysLoss,
    maxDailyLossPercent: maxDailyLossPct,
    dailyLossNote: maxDailyLossPct
      ? "Daily loss utilization in percent requires current account equity — call getAccountSnapshot to convert."
      : "No max daily loss configured.",
    atOrOverLimit: blocking.length > 0,
    blockingReasons: blocking,
  };
}

// ── 9d. getReconciliationStatus ─────────────────────────────────────────
/**
 * Phase 27 — MT5 Bridge / Reconciliation Awareness.
 * Reports the user's broker/app reconciliation state honestly.
 * Per-user-scoped for attribution rows. The unattributed-master count is a
 * SYSTEM-WIDE integer only (no per-row leakage, no user identifiers) so the
 * user can see "are there broker-only fills the system can't attribute to
 * anyone yet" without violating cross-user isolation.
 *
 * Status precedence:
 *  - BRIDGE_OFFLINE — no MT5 connection or no heartbeat in 60s
 *  - RECONCILIATION_BLOCKED — shared routing locked at placement layer
 *    (placeLiveOrderGuarded always REJECTED). Reconciliation is observation-
 *    only; nothing is being executed against the broker.
 *  - ATTRIBUTION_INCOMPLETE — at least one user attribution row is missing
 *    mt5OrderTicket AND mt5PositionTicket (no broker ack received yet)
 *  - MATCHED — every user attribution row has a broker ticket reference
 *
 * NEVER auto-links a broker-only position to this user. NEVER returns broker
 * balance, equity, or another user's data.
 */
export async function getReconciliationStatus(userId: number) {
  // 1. Bridge health
  const [conn] = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId)).limit(1);
  const lastHeartbeatAt = conn?.lastHeartbeat ?? null;
  const heartbeatAgeSec = lastHeartbeatAt
    ? Math.floor((Date.now() - new Date(lastHeartbeatAt).getTime()) / 1000)
    : null;
  const bridgeConnected = !!conn && heartbeatAgeSec !== null && heartbeatAgeSec < 60;
  const bridgeMode: "OFFLINE" | "READ_ONLY" | "PAPER_ONLY" | "LIVE_LOCKED" =
    !bridgeConnected ? "OFFLINE" : (conn?.liveLocked ? "LIVE_LOCKED" : "READ_ONLY");

  // 2. Per-user attribution rows (shared-master routing model — currently
  //    BLOCKED at placement layer so these will normally be empty)
  const attrRows = await db.select({
    id: sharedTradeAttributionTable.id,
    symbol: sharedTradeAttributionTable.symbol,
    side: sharedTradeAttributionTable.side,
    lotSize: sharedTradeAttributionTable.lotSize,
    status: sharedTradeAttributionTable.status,
    mt5OrderTicket: sharedTradeAttributionTable.mt5OrderTicket,
    mt5PositionTicket: sharedTradeAttributionTable.mt5PositionTicket,
    virtualAccountId: sharedTradeAttributionTable.virtualAccountId,
    tradeCommandId: sharedTradeAttributionTable.tradeCommandId,
    auditLogId: sharedTradeAttributionTable.auditLogId,
  }).from(sharedTradeAttributionTable)
    .where(eq(sharedTradeAttributionTable.userId, userId));

  const byStatus: Record<string, number> = {};
  let matchedCount = 0;
  let missingTicketCount = 0;
  let missingAttributionMetadataCount = 0;
  for (const r of attrRows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const hasTicket = !!(r.mt5OrderTicket || r.mt5PositionTicket);
    if (hasTicket) matchedCount++; else missingTicketCount++;
    if (!r.tradeCommandId || !r.auditLogId || !r.virtualAccountId) {
      missingAttributionMetadataCount++;
    }
  }

  // 3. System-wide unattributed master fills (admin-visible only; expose count)
  //    Per-row details require admin role and are not returned to a user tool.
  const unattributedPending = await db.select({ id: unattributedMasterTradesTable.id })
    .from(unattributedMasterTradesTable)
    .where(eq(unattributedMasterTradesTable.status, "pending_review"));
  const unattributedSystemPendingCount = unattributedPending.length;

  // 4. Status precedence
  let reconciliationStatus:
    | "BRIDGE_OFFLINE" | "RECONCILIATION_BLOCKED"
    | "ATTRIBUTION_INCOMPLETE" | "MATCHED" | "NO_ROUTED_TRADES";
  let note: string;
  if (!bridgeConnected) {
    reconciliationStatus = "BRIDGE_OFFLINE";
    note = "MT5 bridge is offline or has no recent heartbeat. Reconciliation cannot run until the EA reconnects. Broker balance/positions are unavailable — never inferred.";
  } else if (attrRows.length === 0) {
    reconciliationStatus = "NO_ROUTED_TRADES";
    note = "No shared-routing attribution rows for this user. Shared MT5 routing is currently BLOCKED at the placement layer (paper-only by construction), so nothing is being executed against the broker.";
  } else if (missingTicketCount > 0 || missingAttributionMetadataCount > 0) {
    reconciliationStatus = "ATTRIBUTION_INCOMPLETE";
    note = `${missingTicketCount} attribution row(s) have no broker ticket yet; ${missingAttributionMetadataCount} row(s) are missing required metadata (commandId / auditId / virtualAccountId). Affected commands stay BLOCKED until attribution is complete.`;
  } else {
    reconciliationStatus = "MATCHED";
    note = `All ${matchedCount} attribution row(s) reference a broker ticket. Real placement is still BLOCKED — this confirms only the observation-side mapping.`;
  }

  // Cleanup phase A + B — emit canonical bridge mode + canonical
  // reconciliation literal alongside the legacy fields. Backward compat:
  // `reconciliationStatus` and `bridge.mode` unchanged; new fields
  // consume the shared contract enums at lib/domain/safety-contracts.
  const canonicalReconciliationStatus = mapLegacyReconciliationStatus(reconciliationStatus);
  const heartbeatStale = !bridgeConnected || (heartbeatAgeSec != null && heartbeatAgeSec > 60);
  const canonicalBridgeMode = applyHeartbeatStaleness(
    mapLegacyBridgeMode(bridgeConnected ? "connected" : "disconnected"),
    heartbeatStale,
  );
  return {
    reconciliationStatus,
    canonicalReconciliationStatus,
    bridge: {
      connected: bridgeConnected,
      mode: bridgeMode,
      canonicalMode: canonicalBridgeMode,
      lastHeartbeatAt: lastHeartbeatAt ? new Date(lastHeartbeatAt).toISOString() : null,
      heartbeatAgeSec,
      heartbeatStaleThresholdSec: 60,
      accountNumber: conn?.accountNumber ?? null,
      serverName: conn?.serverName ?? null,
      readOnlyMode: conn?.readOnlyMode ?? true,
      allowOrderExecution: false as const,
      liveLocked: conn?.liveLocked ?? true,
    },
    placementLayer: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED" as const,
    placementLayerNote: "All real MT5 commands resolve to BLOCKED — placeLiveOrderGuarded always returns REJECTED.",
    userAttributions: {
      total: attrRows.length,
      matchedToBrokerTicket: matchedCount,
      missingBrokerTicket: missingTicketCount,
      missingMetadata: missingAttributionMetadataCount,
      byStatus,
    },
    unattributedSystemPendingCount,
    unattributedNote: unattributedSystemPendingCount > 0
      ? "Broker-only fills exist that the system could not auto-attribute to any user. They sit in admin review and are NEVER auto-assigned. Per-user isolation preserved."
      : "No system-wide unattributed broker fills.",
    note,
  };
}

// ── 10. runPreTradeRiskCheck (advisory only) ────────────────────────────
export async function runPreTradeRiskCheck(userId: number, args: {
  symbol: string; side: "buy" | "sell"; size: number; stopLoss?: number; takeProfit?: number; entry?: number;
}) {
  const limitsRes = await getRiskLimits(userId);
  const limits = (limitsRes as { limits?: Record<string, unknown> }).limits ?? null;
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!args.stopLoss && limits && limits.requireStopLoss) reasons.push("STOP_LOSS_REQUIRED");
  if (!args.symbol) reasons.push("SYMBOL_REQUIRED");
  if (!Number.isFinite(args.size) || args.size <= 0) reasons.push("SIZE_INVALID");
  if (limits && args.entry && args.stopLoss && args.takeProfit) {
    const risk = Math.abs(args.entry - args.stopLoss);
    const reward = Math.abs(args.takeProfit - args.entry);
    const rr = risk > 0 ? reward / risk : 0;
    const minRr = Number(limits.minRewardRiskRatio ?? 1.5);
    if (rr < minRr) warnings.push(`R:R ${rr.toFixed(2)} below minimum ${minRr}`);
  }
  // Open-trade count check
  const openRes = await getOpenPositions(userId);
  if (limits && Number(openRes.count) >= Number(limits.maxOpenTrades ?? 3)) {
    reasons.push("MAX_OPEN_TRADES_REACHED");
  }
  const env = await deriveAssistantEnvelope(userId);
  const assistantName = await getAssistantDisplayName(userId);
  return {
    advisoryOnly: true,
    wouldPass: reasons.length === 0,
    blockingReasons: reasons,
    warnings,
    note: `This is an advisory pre-trade check. ${liveExecutionAvailabilityNote(env, assistantName)}`,
  };
}

// ── 11–13. Market tools (provider adapter, "not connected" by default) ──
export async function getMarketSnapshot(symbol: string) {
  // Task #558 — ARX Focus lock: Ruby may only snapshot approved markets. An
  // unapproved symbol returns an honest blocked result with NO market data —
  // never a fabricated or fetched price for an outside-universe market.
  if (!isApprovedArxMarket((symbol ?? "").toString())) {
    return {
      symbol: (symbol ?? "").toString(),
      isApprovedMarket: false as const,
      blocked: true as const,
      reason: ARX_FOCUS_BLOCKED_REASON,
      // Honest feed status so Ruby never reports an undefined/blank feed for an
      // off-universe market — there is no usable ARX feed for it. No data is
      // fetched and no price is fabricated; the block above still stands. Uses
      // the shared helper so every block/error branch emits the SAME shape.
      ...unavailableFeedStatusFields(),
      lastPrice: null,
      lastCandleTime: null,
      cause: ARX_FOCUS_BLOCKED_REASON,
      message: "This market is outside the ARX Focus universe, so no live feed is available for it.",
      quote: null,
    };
  }
  // Source of truth = the SAME shared chart resolver the chart uses, so Ruby's
  // per-symbol snapshot reports identical source/quality/freshness to the chart.
  // A provider quote is OPTIONAL enrichment (bid/ask/spread) layered on top —
  // it never overrides the shared feed status and is never fabricated.
  try {
    const { getSymbolSnapshot } = await import("../data/marketOverview.js");
    const snap = await getSymbolSnapshot((symbol ?? "").toString().trim() || symbol);

    // Optional provider quote enrichment (bid/ask/spread) — best-effort only.
    const p = getMarketProvider();
    let quote: {
      bid: number | null; ask: number | null; spread: number | null;
      price: number | null; providerFreshness: string; source: string;
    } | null = null;
    if (p.connected && p.features.quotes) {
      try {
        const q = await p.getLiveQuote((symbol ?? "").toString().trim() || symbol);
        const bid = typeof q.bid === "number" ? q.bid : null;
        const ask = typeof q.ask === "number" ? q.ask : null;
        quote = {
          bid, ask,
          spread: bid != null && ask != null ? ask - bid : null,
          price: typeof q.price === "number" ? q.price : null,
          providerFreshness: q.freshness,
          source: q.source,
        };
      } catch {
        quote = null;
      }
    }

    // Feed-confirmation mirrors the chart exactly: confirmed only when the shared
    // feed is AI-usable AND realtime. Advisory only — see FEED_NOT_CONFIRMED_CAVEAT.
    const feedConfirmed = snap.aiUsable && snap.freshness === "REALTIME";
    const feedCaveat = feedConfirmed ? null : FEED_NOT_CONFIRMED_CAVEAT;
    return {
      symbol: snap.symbol,
      displaySymbol: snap.displaySymbol,
      assetClass: snap.assetClass,
      // Shared chart-truth (identical to what the chart shows for this symbol).
      source: snap.source,
      quality: snap.quality,
      aiUsable: snap.aiUsable,
      isLive: snap.isLive,
      stale: snap.stale,
      freshness: snap.freshness,
      lastPrice: snap.lastPrice,
      lastCandleTime: snap.lastCandleTime,
      cause: snap.cause,
      message: snap.message,
      // Optional provider enrichment; null when no provider/quote is available.
      quote,
      provider: p.name,
      providerConnected: p.connected,
      feedConfirmed,
      feedCaveat,
    };
  } catch (e) {
    // Task #816 — a runtime throw (e.g. the shared snapshot resolver failing) is
    // also a "can't answer": return the SAME honest feed-status contract the
    // ARX-block branch uses so Eleanor never gets an undefined/blank feed here.
    const reason = errReason(e);
    return {
      symbol: (symbol ?? "").toString(),
      ...unavailableFeedStatusFields(),
      lastPrice: null,
      lastCandleTime: null,
      cause: "snapshot_failed",
      message: "The market snapshot is temporarily unavailable — there is no confirmed feed to report right now.",
      error: "snapshot_failed",
      reason,
      quote: null,
    };
  }
}
export async function getEconomicCalendar() {
  const p = getMarketProvider();
  const r = await p.getEconomicCalendar();
  // External provider text is DATA — neutralize any embedded prompt-injection
  // before it reaches the assistant model.
  const events = Array.isArray(r.events)
    ? r.events.map((e) => ({
        ...e,
        title: sanitizeExternalText(e.title, { source: "economic_calendar", field: "title" }),
        region: sanitizeExternalText(e.region, { source: "economic_calendar", field: "region" }),
      }))
    : r.events;
  return { ...r, events,};
}
export async function getRecentMarketNews(query: string, limit = 5) {
  const p = getMarketProvider();
  const status = getMarketStatus();
  if (!p.connected || !p.features.news) {
    return {
      connected: false,
      configured: status.configured,
      provider: p.name,
      items: [],
      reason: p.name === "none" ? "no_provider_configured" : "provider_does_not_support_news",
      setupHint: status.setupHint,
    };
  }
  const r = await p.getMarketNews(query, limit);
  const fresh = getMarketStatus();
  // External provider text is DATA — neutralize any embedded prompt-injection.
  const items = Array.isArray(r.items)
    ? r.items.map((i) => ({
        ...i,
        headline: sanitizeExternalText(i.headline, { source: "market_news", field: "headline" }),
        source: sanitizeExternalText(i.source, { source: "market_news", field: "source" }),
        summary: typeof i.summary === "string"
          ? sanitizeExternalText(i.summary, { source: "market_news", field: "summary" })
          : i.summary,
      }))
    : r.items;
  return { ...r, items, configured: true, stale: fresh.stale, lastSuccessfulFetchAt: fresh.lastSuccessfulFetchAt,};
}

/** Phase 24 — Current events / real-world news. Separate channel from
 *  symbol-scoped financial news. Returns connected:false today (no adapter
 *  wired). The assistant MUST say "current events are unavailable" rather
 *  than substitute getRecentMarketNews. NEVER fabricates. */
export async function getCurrentEvents(limit = 10) {
  const result = await getCurrentEventsFromProvider(limit);
  const status = getMarketStatus();
  // External provider text is DATA — neutralize any embedded prompt-injection.
  const events = Array.isArray(result.events)
    ? result.events.map((e) => ({
        ...e,
        headline: sanitizeExternalText(e.headline, { source: "current_events", field: "headline" }),
        summary: typeof (e as { summary?: unknown }).summary === "string"
          ? sanitizeExternalText((e as { summary?: string }).summary, { source: "current_events", field: "summary" })
          : (e as { summary?: unknown }).summary,
      }))
    : result.events;
  return {
    ...result,
    events,
    configured: status.configured,
    setupHint: result.connected ? null : "No real-world / current-events adapter is wired. The assistant will say current events are unavailable rather than substitute symbol-scoped financial news. To enable, add a dedicated current-events provider (e.g. GDELT, NewsAPI top-headlines, geopolitical feed) and implement `getCurrentEvents` on the provider.",
    note: "This channel is for geopolitical, macro-policy, conflict, supply-shock, regulatory, and natural-disaster context. It is a CONTEXT/RISK MODIFIER, not a trading signal. Treat as advisory only.",
  };
}

// ── 14. explainFeature ──────────────────────────────────────────────────
export function explainFeatureTool(routeOrFeatureName: string) {
  return { ...featureExplain(routeOrFeatureName),};
}

// ── 15. getCurrentPageContext ───────────────────────────────────────────
// Page-aware: the panel sends {pathname,label?} per turn (Phase 14A). We
// pass it through to the model via a session system message AND expose it
// as a callable tool so the model can self-check "what page am I on".
// The tool reads ONLY the per-request page context the client sent (no
// cross-user data, no fabrication).
interface StoredPageContext {
  pathname: string;
  label?: string | null;
  // Task #602 follow-on — the symbol/timeframe currently on the user's chart
  // (Scanner). Lets a chat chart-read default to what the user is LOOKING at.
  chartSymbol?: string | null;
  chartTimeframe?: string | null;
}
const PAGE_CONTEXT_REGISTRY = new WeakMap<object, StoredPageContext>();
export function setRequestPageContext(reqKey: object, ctx: StoredPageContext | null): void {
  if (!ctx) { PAGE_CONTEXT_REGISTRY.delete(reqKey); return; }
  PAGE_CONTEXT_REGISTRY.set(reqKey, {
    pathname: String(ctx.pathname).slice(0, 200),
    label: ctx.label?.slice(0, 200) ?? null,
    chartSymbol: ctx.chartSymbol ? String(ctx.chartSymbol).slice(0, 40) : null,
    chartTimeframe: ctx.chartTimeframe ? String(ctx.chartTimeframe).slice(0, 12) : null,
  });
}
/** Read the on-screen chart symbol/timeframe the client sent for this turn (if
 *  any). Used by readChartStructure to default to the chart the user is viewing.
 *  Returns null when no page context was sent for the turn. */
export function getRequestChartContext(
  reqKey: object,
): { chartSymbol: string | null; chartTimeframe: string | null } | null {
  const ctx = PAGE_CONTEXT_REGISTRY.get(reqKey);
  if (!ctx) return null;
  return { chartSymbol: ctx.chartSymbol ?? null, chartTimeframe: ctx.chartTimeframe ?? null };
}
export function getCurrentPageContextTool(reqKey: object) {
  const ctx = PAGE_CONTEXT_REGISTRY.get(reqKey) ?? null;
  if (!ctx) {
    return { hasPageContext: false, note: "Client did not send a page context for this turn.",};
  }
  const feat = featureExplain(ctx.pathname);
  return {
    hasPageContext: true,
    pathname: ctx.pathname,
    label: ctx.label ?? null,
    matchedFeature: feat.found ? feat.feature : null,
    suggestions: feat.suggestions,
  };
}

// ── 16. getPaperSafetyStatus ────────────────────────────────────────────
// Dedicated tool so the model can confidently answer
// "why does it say paper-only / can you place a live trade?"
// DERIVED, never hardcoded: the answer reflects the user's real per-user
// envelope (honest both ways) — see buildPaperSafetyStatus. Advisory only.
export function getPaperSafetyStatusTool(env: SafetyEnvelope, assistantName?: string) {
  return buildPaperSafetyStatus(env, assistantName);
}

// ── 17. getMarketDataProviderStatus ─────────────────────────────────────
// Callable wrapper around the /market-status endpoint so the model can
// self-check provider connectivity inside a reply.
export function getMarketDataProviderStatusTool() {
  return { ...getMarketStatus(),};
}

// ── 18. getPropFirmModeStatus ───────────────────────────────────────────
// Phase 18A — per-user. Reads the user's own ACTIVE prop_challenge row
// (Build R, paper-only). Does NOT read the global riskGovernor2 module
// state, which is a system-wide simulator and would leak the same numbers
// to every user. If the user has not configured a challenge, returns a
// clean NOT_CONFIGURED response — never fabricates a profit, drawdown,
// pass/fail, or funded-account status.
export async function getPropFirmModeStatus(userId: number) {
  try {
    const rows = await db.select().from(propChallengesTable)
      .where(and(eq(propChallengesTable.userId, userId), eq(propChallengesTable.status, "ACTIVE")))
      .orderBy(desc(propChallengesTable.createdAt))
      .limit(1);
    const ch = rows[0];
    if (!ch) {
      return {
        enabled: false,
        status: "NOT_CONFIGURED",
        ruleStatus: "PROP_MODE_OFF" as const,
        configured: false,
        note: "Prop firm mode is not configured for this user. Set up a challenge in the Prop Firm Mode page to track your rules.",
        honestyDisclaimer: "Prop firm tracking is paper/simulator only. We do not claim to be connected to any real prop firm or funded account.",
        dataSource: "USER_CONFIG",
        perUserScoped: true as const,
      };
    }

    // Phase 27 — per-user paper-only progress evaluator. Mirrors the math
    // in /prop-challenges/:id/evaluate (routes/propChallenges.ts) but is
    // read-only and per-user-scoped (defense-in-depth filter on userId).
    // Uses ONLY this user's paper_orders. Never live. Never fabricated.
    const orderWhere = ch.userId == null
      ? and(eq(paperOrdersTable.paperAccountId, ch.paperAccountId), sql`${paperOrdersTable.userId} IS NULL`)
      : and(eq(paperOrdersTable.paperAccountId, ch.paperAccountId), eq(paperOrdersTable.userId, ch.userId));
    const orders = await db.select().from(paperOrdersTable).where(orderWhere);
    const closed = orders.filter((o) => o.status !== "OPEN" && o.closedAt && o.closedAt >= ch.startedAt);
    const openCount = orders.filter((o) => o.status === "OPEN").length;

    // Bucket P&L + trade count per UTC day.
    const byDayPnl = new Map<string, number>();
    const byDayCount = new Map<string, number>();
    for (const o of closed) {
      const d = (o.closedAt as Date).toISOString().slice(0, 10);
      byDayPnl.set(d, (byDayPnl.get(d) ?? 0) + o.profitLoss);
      byDayCount.set(d, (byDayCount.get(d) ?? 0) + 1);
    }
    const sortedDates = [...byDayPnl.keys()].sort();
    const totalPnl = closed.reduce((s, o) => s + o.profitLoss, 0);
    const totalPct = totalPnl / ch.startingBalance;
    const currentBalance = ch.startingBalance + totalPnl;
    const daysWorked = sortedDates.length;
    const daysSinceStart = Math.max(1, Math.ceil((Date.now() - ch.startedAt.getTime()) / 86_400_000));

    // Sequential walk — same math as evaluateChallenge() in
    // routes/propChallenges.ts so the AI never reports numbers that
    // disagree with the UI / /evaluate endpoint. Daily-loss percentage
    // uses the DAY-START balance as denominator (not startingBalance).
    let runBal = ch.startingBalance;
    let peakBal = ch.startingBalance;
    let maxDrawdownPct = 0;
    let todayLossPct = 0; // today's loss as % of today's start balance
    const todayKey = new Date().toISOString().slice(0, 10);
    // Per-day start balance — mirrors routes/propChallenges.ts evaluator so
    // per-trade risk uses the SAME denominator as the authoritative path.
    const dayStartBalMap = new Map<string, number>();
    for (const date of sortedDates) {
      const dayPnl = byDayPnl.get(date) ?? 0;
      const startBal = runBal;
      dayStartBalMap.set(date, startBal);
      runBal = startBal + dayPnl;
      const dayLossPct = dayPnl < 0 && startBal > 0 ? Math.abs(dayPnl) / startBal : 0;
      if (date === todayKey) todayLossPct = dayLossPct;
      peakBal = Math.max(peakBal, runBal);
      const dd = peakBal > 0 ? (peakBal - runBal) / peakBal : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    // Consistency: largest single positive-day P&L share of total profit.
    let consistencyTopShare = 0;
    let totalPositive = 0;
    let topPositiveDay = 0;
    for (const date of sortedDates) {
      const dayPnl = byDayPnl.get(date) ?? 0;
      if (dayPnl > 0) {
        totalPositive += dayPnl;
        if (dayPnl > topPositiveDay) topPositiveDay = dayPnl;
      }
    }
    if (totalPositive > 0) consistencyTopShare = topPositiveDay / totalPositive;

    // Honest INSUFFICIENT_DATA: brand-new challenge with zero closed trades.
    const hasData = closed.length > 0;

    // Remaining headroom (clamped at 0).
    const dailyLossRemainingPct = Math.max(0, ch.maxDailyLoss - todayLossPct);
    const totalDrawdownRemainingPct = Math.max(0, ch.maxTotalDrawdown - maxDrawdownPct);
    const profitTargetProgressPct = ch.profitTarget > 0 ? Math.max(0, totalPct) / ch.profitTarget : 0;

    // Compliance status (no fabrication: WARNING at 80% of any limit).
    const warnings: string[] = [];
    const violations: string[] = [];
    if (todayLossPct > ch.maxDailyLoss) violations.push(`Daily loss ${(todayLossPct*100).toFixed(2)}% exceeds limit ${(ch.maxDailyLoss*100).toFixed(2)}%`);
    else if (todayLossPct > ch.maxDailyLoss * 0.8) warnings.push(`Daily loss ${(todayLossPct*100).toFixed(2)}% approaching limit ${(ch.maxDailyLoss*100).toFixed(2)}%`);
    if (maxDrawdownPct > ch.maxTotalDrawdown) violations.push(`Drawdown ${(maxDrawdownPct*100).toFixed(2)}% exceeds limit ${(ch.maxTotalDrawdown*100).toFixed(2)}%`);
    else if (maxDrawdownPct > ch.maxTotalDrawdown * 0.8) warnings.push(`Drawdown ${(maxDrawdownPct*100).toFixed(2)}% approaching limit ${(ch.maxTotalDrawdown*100).toFixed(2)}%`);
    if (daysSinceStart > ch.maxTradingDays) violations.push(`Day ${daysSinceStart} > maxTradingDays ${ch.maxTradingDays}`);
    // Consistency rule (mirrors routes/propChallenges.ts evaluateChallenge):
    // HARD when profit target already reached and rule exceeded; WARN otherwise.
    if (totalPositive > 0 && consistencyTopShare > ch.consistencyRulePercent) {
      const msg = `Single best day = ${(consistencyTopShare*100).toFixed(1)}% of profit, exceeds consistency rule ${(ch.consistencyRulePercent*100).toFixed(0)}%`;
      if (totalPct >= ch.profitTarget) violations.push(msg); else warnings.push(msg);
    }
    // Overtrading: >20 closed trades on any single day → soft warning.
    for (const date of sortedDates) {
      const c = byDayCount.get(date) ?? 0;
      if (c > 20) { warnings.push(`Overtrading: ${c} trades on ${date}`); break; }
    }

    // ── Phase 27-B extended rule evaluation (mirrors routes/propChallenges.ts) ──
    const insufficientDataRules: string[] = [];
    // Trailing drawdown.
    let trailingDdPct = 0;
    if (ch.trailingDrawdownEnabled === 1) {
      const tdRef = ch.trailingDrawdownType === "TRAILING" ? peakBal : ch.startingBalance;
      trailingDdPct = tdRef > 0 ? (tdRef - runBal) / tdRef : 0;
      if (trailingDdPct > ch.trailingDrawdownAmount) {
        violations.push(`Trailing drawdown ${(trailingDdPct*100).toFixed(2)}% (${ch.trailingDrawdownType}) exceeds limit ${(ch.trailingDrawdownAmount*100).toFixed(2)}%`);
      } else if (trailingDdPct > ch.trailingDrawdownAmount * 0.8) {
        warnings.push(`Trailing drawdown ${(trailingDdPct*100).toFixed(2)}% (${ch.trailingDrawdownType}) approaching limit ${(ch.trailingDrawdownAmount*100).toFixed(2)}%`);
      }
    }
    // Max risk per trade + max position size (per-trade scan).
    let largestTradeRiskPct = 0;
    let largestPositionSizeLots = 0;
    for (const o of closed) {
      const dayKey = (o.closedAt as Date).toISOString().slice(0, 10);
      // Mirror route evaluator: per-trade risk uses that day's start balance
      // as the denominator (NOT challenge startingBalance), so the AI and
      // /evaluate endpoint produce identical risk percentages.
      const dayStart = dayStartBalMap.get(dayKey) ?? ch.startingBalance;
      const tradeRiskPct = o.profitLoss < 0 && dayStart > 0 ? Math.abs(o.profitLoss) / dayStart : 0;
      if (tradeRiskPct > largestTradeRiskPct) largestTradeRiskPct = tradeRiskPct;
      if (o.lotSize > largestPositionSizeLots) largestPositionSizeLots = o.lotSize;
      if (tradeRiskPct > ch.maxRiskPerTrade) {
        // Mirrors route severity: WARN (not HARD) — does NOT trigger BLOCKED.
        warnings.push(`Trade #${o.id} loss ${(tradeRiskPct*100).toFixed(2)}% exceeds max risk per trade ${(ch.maxRiskPerTrade*100).toFixed(2)}%`);
      }
      if (o.lotSize > ch.maxPositionSize) {
        warnings.push(`Trade #${o.id} size ${o.lotSize} lots exceeds max position size ${ch.maxPositionSize}`);
      }
    }
    // Max open trades.
    if (openCount >= ch.maxOpenTrades) {
      const msg = `${openCount} open trades >= max open trades ${ch.maxOpenTrades}`;
      if (openCount > ch.maxOpenTrades) violations.push(msg); else warnings.push(msg);
    } else if (openCount > ch.maxOpenTrades * 0.8) {
      warnings.push(`${openCount} open trades approaching max ${ch.maxOpenTrades}`);
    }
    // Max pending orders — INSUFFICIENT_DATA (no PENDING status in paper schema).
    insufficientDataRules.push("MAX_PENDING_ORDERS");
    // Weekend / overnight holding.
    const nowUtc = new Date();
    const isWeekendUtc = nowUtc.getUTCDay() === 0 || nowUtc.getUTCDay() === 6;
    const openOrdersAll = orders.filter((o) => o.status === "OPEN");
    if (ch.weekendHoldingAllowed === 0 && isWeekendUtc && openOrdersAll.length > 0) {
      warnings.push(`Weekend holding blocked but ${openOrdersAll.length} paper position(s) open over weekend (UTC).`);
    }
    if (ch.overnightHoldingAllowed === 0 && openOrdersAll.length > 0) {
      const todayUtcKey = nowUtc.toISOString().slice(0, 10);
      const overnightOpen = openOrdersAll.filter((o) =>
        (o.openedAt as Date).toISOString().slice(0, 10) < todayUtcKey,
      );
      if (overnightOpen.length > 0) {
        warnings.push(`Overnight holding blocked but ${overnightOpen.length} paper position(s) opened on a prior UTC day.`);
      }
    }
    // News restriction — INSUFFICIENT_DATA.
    if (ch.newsTradingAllowed === 0) insufficientDataRules.push("NEWS_RESTRICTION");

    let ruleStatus: "COMPLIANT" | "WARNING" | "VIOLATION" | "INSUFFICIENT_DATA" | "BLOCKED" = "COMPLIANT";
    if (!hasData) ruleStatus = "INSUFFICIENT_DATA";
    else if (violations.length > 0) ruleStatus = "VIOLATION";
    else if (warnings.length > 0) ruleStatus = "WARNING";
    // BLOCKED status only when strictGuardrails is enabled AND a HARD-severity
    // violation exists. In this tool, violations[] is reserved for HARD-equivalent
    // failures only (DAILY_LOSS exceed, TOTAL_DRAWDOWN exceed, TIME_LIMIT,
    // TRAILING_DRAWDOWN exceed, CONSISTENCY when profit target reached,
    // MAX_OPEN_TRADES strictly exceeded). WARN-level signals (per-trade risk,
    // position size, near-limit, overtrading, weekend/overnight holding) live
    // in warnings[] and never trigger BLOCKED — mirroring routes/propChallenges.ts.
    if (ch.strictGuardrailsEnabled === 1 && violations.length > 0) ruleStatus = "BLOCKED";

    // Profit-target reached signal (informational; route /evaluate is the
    // authoritative pass/fail writer — we never mutate state here).
    const profitTargetReached = hasData && totalPct >= ch.profitTarget && daysWorked >= ch.minTradingDays;

    // Read-only advisory: would a new trade still be allowed under hard rules?
    const canTakeNewTradeReasons: string[] = [];
    if (violations.length > 0) canTakeNewTradeReasons.push(...violations);
    const canTakeNewTrade = canTakeNewTradeReasons.length === 0;

    return {
      enabled: true,
      configured: true,
      challengeId: ch.id,
      challengeName: ch.challengeName,
      status: ch.status,
      ruleStatus,
      failureReason: ch.failureReason ?? null,
      startedAt: ch.startedAt instanceof Date ? ch.startedAt.toISOString() : ch.startedAt,
      rules: {
        startingBalance: ch.startingBalance,
        profitTargetPct: ch.profitTarget,
        maxDailyLossPct: ch.maxDailyLoss,
        maxTotalDrawdownPct: ch.maxTotalDrawdown,
        minTradingDays: ch.minTradingDays,
        maxTradingDays: ch.maxTradingDays,
        consistencyRulePercent: ch.consistencyRulePercent,
        // Phase 27-B extended rules (user-entered; never official unless verified).
        trailingDrawdownEnabled: ch.trailingDrawdownEnabled === 1,
        trailingDrawdownAmount: ch.trailingDrawdownAmount,
        trailingDrawdownType: ch.trailingDrawdownType,
        maxRiskPerTradePct: ch.maxRiskPerTrade,
        maxOpenTrades: ch.maxOpenTrades,
        maxPendingOrders: ch.maxPendingOrders,
        maxPositionSizeLots: ch.maxPositionSize,
        newsTradingAllowed: ch.newsTradingAllowed === 1,
        weekendHoldingAllowed: ch.weekendHoldingAllowed === 1,
        overnightHoldingAllowed: ch.overnightHoldingAllowed === 1,
        strictGuardrailsEnabled: ch.strictGuardrailsEnabled === 1,
      },
      extendedRuleSignals: {
        trailingDrawdownPct: trailingDdPct,
        largestTradeRiskPct,
        largestPositionSizeLots,
        openTradeCount: openCount,
        insufficientDataRules,
        weekendUtcNow: isWeekendUtc,
      },
      progress: {
        currentBalance,
        totalPnl,
        totalPct,
        profitTargetProgressPct,
        profitTargetReached,
        maxDrawdownPct,
        dailyLossUsedPct: todayLossPct,
        dailyLossRemainingPct,
        totalDrawdownRemainingPct,
        daysWorked,
        daysSinceStart,
        openTradeCount: openCount,
        closedTradeCount: closed.length,
      },
      warnings,
      violations,
      canTakeNewTrade,
      canTakeNewTradeReasons,
      hasSufficientData: hasData,
      note: hasData
        ? "Prop firm tracking is paper/simulator only. Numbers reflect simulated paper P&L, not a real funded account. Run /prop-challenges/:id/evaluate for the authoritative pass/fail and to persist day-bucket history."
        : "Prop firm challenge is configured but has no closed paper trades yet — INSUFFICIENT_DATA. Take some paper trades to start tracking rule progress.",
      honestyDisclaimer: "Prop firm tracking is paper/simulator only. We do not claim to be connected to any real prop firm or funded account. Rules shown are user-entered; not official prop firm rules unless explicitly verified.",
      dataSource: "USER_PROP_CHALLENGE",
      perUserScoped: true as const,
    };
  } catch {
    // Tool/DB outage. MUST NOT collide with INSUFFICIENT_DATA (which the
    // prompt routes to "no closed paper trades yet"). Use UNAVAILABLE so
    // the assistant says the status is unavailable, not that the user
    // has no trades.
    return {
      enabled: false,
      status: "UNAVAILABLE",
      ruleStatus: "UNAVAILABLE" as const,
      configured: false,
      note: "Prop firm status is temporarily unavailable. Please retry shortly.",
      honestyDisclaimer: "We cannot read your prop firm challenge right now. Numbers are not being computed.",
      perUserScoped: true as const,
    };
  }
}

// ── 19. createSupportDiagnosticReport ───────────────────────────────────
export async function createSupportDiagnosticReport(userId: number) {
  const [bridge, snap, risk] = await Promise.all([
    getMT5BridgeStatus(userId),
    getAccountSnapshot(userId),
    getRiskLimits(userId),
  ]);
  const notifs = await db.select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(userNotificationsTable).where(eq(userNotificationsTable.userId, userId));
  const activity = await db.select().from(userActivityTimelineTable)
    .where(eq(userActivityTimelineTable.userId, userId))
    .orderBy(desc(userActivityTimelineTable.createdAt)).limit(10);
  return {
    generatedAt: new Date().toISOString(),
    user: { id: userId },
    mt5: bridge,
    account: snap,
    risk,
    notifications: { totalCount: Number(notifs[0]?.count ?? 0) },
    recentActivity: activity.map((a) => ({
      kind: (a as Record<string, unknown>).eventType ?? (a as Record<string, unknown>).kind ?? null,
      at: a.createdAt,
      summary: (a as Record<string, unknown>).summary ?? (a as Record<string, unknown>).message ?? null,
    })),
    market: getMarketStatus(),
  };
}

// ── Phase 22C: getRecentNotifications ───────────────────────────────────
// Reads the current user's notifications from the canonical modern table
// (`user_notifications`). Per-user-scoped via SQL filter on userId. Optional
// filters for unreadOnly, severity, type/category. Never fabricates rows.
export async function getRecentNotifications(userId: number, args: {
  unreadOnly?: boolean;
  limit?: number;
  type?: string;
  severity?: "info" | "warning" | "critical";
} = {}) {
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 20)));
  const conds = [eq(userNotificationsTable.userId, userId)];
  if (args.unreadOnly) conds.push(eq(userNotificationsTable.status, "unread"));
  if (args.type && typeof args.type === "string") {
    conds.push(eq(userNotificationsTable.notificationType, args.type));
  }
  if (args.severity && ["info", "warning", "critical"].includes(args.severity)) {
    conds.push(eq(userNotificationsTable.severity, args.severity));
  }
  const rows = await db.select().from(userNotificationsTable)
    .where(and(...conds))
    .orderBy(desc(userNotificationsTable.createdAt))
    .limit(limit);
  const unreadAgg = await db.select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(userNotificationsTable)
    .where(and(
      eq(userNotificationsTable.userId, userId),
      eq(userNotificationsTable.status, "unread"),
    ));
  const unread = Number(unreadAgg[0]?.count ?? 0);
  const market = getMarketStatus();
  const { getPushSummaryForUser } = await import("../push/sendService.js");
  const pushSummary = await getPushSummaryForUser(userId);
  return {
    notifications: rows.map((n) => ({
      id: n.id,
      type: n.notificationType,
      severity: n.severity,
      title: n.title,
      message: n.message,
      source: n.source,
      status: n.status,
      actionLabel: n.actionLabel,
      actionTarget: n.actionTarget,
      createdAt: n.createdAt?.toISOString?.() ?? null,
      readAt: n.readAt?.toISOString?.() ?? null,
    })),
    unread,
    isEmpty: rows.length === 0,
    pushConfigured: pushSummary.configured,
    pushEnabled: pushSummary.pushEnabled,
    activePushSubscriptions: pushSummary.activeSubscriptions,
    pushPermissionStatus: "unknown_server_side" as const,
    marketDataProviderConnected: Boolean((market as { connected?: boolean }).connected),
    canonicalSurface: "/api/me/notifications",
  };
}

// ── Phase 22F: getAssistantLiveAwarenessStatus ──────────────────────────
// Single rollup that aggregates real status of every system the assistant
// must reason about. Per-user-scoped. Never fabricates. Adds a `warnings`
// list when a sub-system is missing or unconfigured. Includes a
// `missingTools` list (tools known to the registry but not currently
// dispatchable, currently always empty by construction). Safety envelope
// always present. NEVER returns secrets.
export async function getAssistantLiveAwarenessStatus(userId: number) {
  const warnings: string[] = [];
  const safe = async <T>(label: string, fn: () => Promise<T> | T): Promise<T | null> => {
    try { return await fn(); } catch (e) {
      warnings.push(`${label}_unavailable: ${(e as Error).message ?? "unknown"}`);
      return null;
    }
  };
  const [
    _user, bridge, heartbeat, risk, style, prop, account, journal, notifs, push,
  ] = await Promise.all([
    safe("user", () => getCurrentUserContext(userId)),
    safe("bridge", () => getMT5BridgeStatus(userId)),
    safe("heartbeat", () => getMT5Heartbeat(userId)),
    safe("risk", () => getRiskLimits(userId)),
    safe("trading_style", () => getTradingStyleProfile(userId)),
    safe("prop_firm", () => getPropFirmModeStatus(userId)),
    safe("account", () => getAccountSnapshot(userId)),
    safe("journal", () => getTradeJournalSummary(userId, 30)),
    safe("notifications", () => getRecentNotifications(userId, { unreadOnly: false, limit: 1 })),
    safe("push", async () => {
      const { getPushSummaryForUser } = await import("../push/sendService.js");
      return getPushSummaryForUser(userId);
    }),
  ]);
  const market = (() => {
    try { return getMarketStatus(); } catch (e) {
      warnings.push(`market_status_unavailable: ${(e as Error).message ?? "unknown"}`);
      return null;
    }
  })();

  const bridgeConnected = Boolean((bridge as { isConnected?: boolean } | null)?.isConnected);
  const lastHeartbeatAt = (() => {
    const items = (heartbeat as { items?: Array<{ lastHeartbeat?: unknown }> } | null)?.items ?? [];
    let latest: number | null = null;
    for (const it of items) {
      const ts = it.lastHeartbeat ? new Date(it.lastHeartbeat as string).getTime() : NaN;
      if (Number.isFinite(ts) && (latest === null || ts > latest)) latest = ts;
    }
    return latest ? new Date(latest).toISOString() : null;
  })();
  const mt5AccountDetected = (() => {
    const conns = (bridge as { connections?: Array<{ accountNumber?: unknown }> } | null)?.connections ?? [];
    const c = conns.find((x) => x.accountNumber);
    return c ? String(c.accountNumber) : null;
  })();
  const riskLimitsConfigured = Boolean((risk as { hasRiskSettings?: boolean } | null)?.hasRiskSettings);
  const tradingStyleConfigured = Boolean((style as { configured?: boolean } | null)?.configured);
  const propFirmModeEnabled = Boolean((prop as { enabled?: boolean } | null)?.enabled);
  const marketDataProviderConnected = Boolean((market as { connected?: boolean } | null)?.connected);
  const marketDataProviderName = (market as { provider?: string } | null)?.provider ?? "none";
  const marketDataStale = Boolean((market as { stale?: boolean } | null)?.stale);
  const notificationsUnread = Number((notifs as { unread?: number } | null)?.unread ?? 0);
  const pushConfigured = Boolean((push as { configured?: boolean } | null)?.configured);
  const pushEnabled = Boolean((push as { pushEnabled?: boolean } | null)?.pushEnabled);
  const activePushSubscriptions = Number((push as { activeSubscriptions?: number } | null)?.activeSubscriptions ?? 0);
  const journalHasTrades = !((journal as { isEmpty?: boolean } | null)?.isEmpty ?? true);
  const performanceSummaryAvailable = !((account as { isEmpty?: boolean } | null)?.isEmpty ?? true);

  if (!bridgeConnected) warnings.push("mt5_bridge_not_connected");
  if (!riskLimitsConfigured) warnings.push("risk_limits_not_configured");
  if (!tradingStyleConfigured) warnings.push("trading_style_not_configured");
  if (!marketDataProviderConnected) warnings.push("market_data_provider_not_connected");
  if (marketDataStale) warnings.push("market_data_stale");
  if (!pushConfigured) warnings.push("push_notifications_not_configured");
  else if (!pushEnabled) warnings.push("push_notifications_disabled_by_user");
  if (!performanceSummaryAvailable) warnings.push("no_paper_trades_yet");

  // missingTools is reserved for future use when tools may be conditionally
  // disabled (e.g. dropping a tool when an upstream provider is removed).
  // Today every TOOL_DEFINITIONS entry is dispatchable, so it's always [].
  const missingTools: string[] = [];

  return {
    userId,
    bridgeConnected,
    lastHeartbeatAt,
    mt5AccountDetected,
    riskLimitsConfigured,
    tradingStyleConfigured,
    propFirmModeEnabled,
    marketDataProviderConnected,
    marketDataProviderName,
    marketDataStale,
    notificationsUnread,
    pushConfigured,
    pushEnabled,
    activePushSubscriptions,
    journalHasTrades,
    performanceSummaryAvailable,
    assistantToolsAvailable: TOOL_DEFINITIONS.length + 1, // +1 = self
    missingTools,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

// Scanner snapshot for the assistant — routed through the SINGLE scoring path.
//
// This tool ranks candidates from scanCoreOpportunities (which loops the SAME
// scanSymbolTimeframe scoring path the dashboard scanner uses, over the shared
// market data router) and keeps ONLY confirmed-live rows. Simulator /
// awaiting-feed / history-only rows are dropped upstream by scanCoreOpportunities,
// so the never-simulator invariant holds without a blanket provider gate here.
//
// The response is NO LONGER gated on the assistant composite provider's
// connectivity — the router may serve live candles (e.g. mt5_broker, Deriv,
// TwelveData) even when that provider reports disconnected. liveDataConnected is
// now ROW-LEVEL truth (any symbol with confirmed live data). When the scanner
// has no live setups, the response is an honest scanner-idle picture, never
// fabricated candidates.
const SCANNER_TOOL_TIMEFRAMES = ["M15", "H1"] as const;
export async function getMarketScannerOpportunities(args: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit ?? 10), 50));
  const status = scannerStatus();
  const providerStatus = getMarketDataProviderStatusTool();

  const scan = await scanCoreOpportunities([...DEFAULT_SYMBOLS], SCANNER_TOOL_TIMEFRAMES, limit);
  const scannerIdle = scan.opportunities.length === 0;
  const liveDataConnected = scan.symbolsWithLiveData > 0;

  return {
    opportunities: scan.opportunities.map((o) => {
      const score = effectiveOpportunityScore(o);
      const opportunityLabel = deriveOpportunityLabel(score);
      // Sufficiency-gated setup (withhold-only). Assemble entry/stop/TP/R:R ONLY
      // when this row's SHARED sufficiency verdict permits it — the SAME verdict
      // the Ruby Chart Read panel uses. A missing/insufficient verdict withholds
      // EVERY level (including alternate fields) and carries the chart panel's
      // exact reason, so chat can never hand a user a setup the chart refuses.
      // Display-only; never an execution gate.
      const setup = projectOpportunitySetup(o);
      // ROW-LEVEL live truth — scanCoreOpportunities returns only live rows, so
      // this is true per row, but it is fed from the row's own dataStatus, not
      // a blanket assumption.
      const rowLive = o.dataStatus === "live";
      return {
        symbol: o.symbol,
        timeframe: o.timeframe,
        bias: o.bias,
        recommendedAction: o.recommendedAction,
        setupType: o.setupType,
        signalStrength: o.signalStrength, // canonical name; equals confidenceScore
        confidenceScore: o.confidenceScore,
        riskScore: o.riskScore,
        riskRewardRatio: setup.riskRewardRatio,
        reasonForTrade: o.reasonForTrade,
        reasonToAvoid: o.reasonToAvoid,
        statusBadge: o.statusBadge,
        opportunityLabel,
        // Phase 24 — Additive canonical decisionStatus. Legacy fields above
        // are unchanged; readers that don't know decisionStatus ignore it.
        decisionStatus: mapLegacyToDecisionStatus({
          statusBadge: o.statusBadge,
          opportunityLabel,
          liveDataConnected: rowLive,
        }),
        entry: setup.entry,
        stopLoss: setup.stopLoss,
        takeProfit: setup.takeProfit,
        takeProfitTargets: setup.takeProfitTargets,
        bestTargetLabel: setup.bestTargetLabel,
        targetsUnavailableReason: setup.targetsUnavailableReason,
        // Withhold-only sufficiency state (additive). withheldReason mirrors the
        // Ruby Chart Read panel's reason for the same symbol/timeframe.
        setupWithheld: setup.setupWithheld,
        withheldReason: setup.withheldReason,
        withheldReasonCode: setup.withheldReasonCode,
        withheldMessage: setup.withheldMessage,
        // Honest per-row provenance from the shared router.
        dataSource: o.dataSource,
        feedProvider: o.feedProvider ?? null,
        generatedAt: o.generatedAt,
      };
    }),
    count: scan.opportunities.length,
    scannerRunning: status.running,
    lastScanAt: scan.scannerLastScanAt,
    defaults: { symbols: [...DEFAULT_SYMBOLS], timeframes: [...SCANNER_TOOL_TIMEFRAMES] },
    dataSource: "ROUTER" as const,
    liveDataConnected,
    paperOnly: true,
    provider: providerStatus.provider,
    symbolsAttempted: scan.pairsAttempted,
    symbolsWithData: scan.symbolsWithLiveData,
    scannerIdle,
    warnings: [],
    safetyNote: scannerIdle
      ? scan.scannerLastScanAt
        ? `No live setups right now. The scanner produced no confirmed-live candidates across the core universe (scanner last completed a scan at ${scan.scannerLastScanAt}). Simulator / awaiting-feed rows are intentionally NOT shown. Tell the user honestly there are no live setups right now — this reflects feed/market conditions, not an app error.`
        : `No live setups right now. The scanner has not completed a live scan yet. Simulator / awaiting-feed rows are intentionally NOT shown.`
      : `Scanner ranked ${scan.opportunities.length} live setup(s) from ${scan.symbolsWithLiveData} symbol(s) with confirmed live data, routed through the shared market data router. These are decision-support candidates only — placing any order is per-user and always requires the user's explicit confirmation plus every live safety gate at dispatch.`,
    generatedAt: new Date().toISOString(),
  };
}

// ── Tool registry & dispatcher ──────────────────────────────────────────
export const TOOL_DEFINITIONS = [
  { name: "getCurrentUserContext", description: "Returns the current signed-in user's id/email/name/role, account mode, routing summary, and a compact accountShell summary (balance, equity, availableRisk, dailyLossRemaining, approvalStatus). Use to personalize greetings and answer quick 'what's my balance / am I approved / how much risk do I have' questions in one call.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getTeamReportSummary", description: "Returns the latest day's plain-English summary of how ARX's decision-support 'trading team' (the advisory specialists) performed — strongest/weakest performer, how many earned or lost standing, weak setups steered away from, quality setups surfaced, noisy alerts quietened. Read-only and SAFE for any user: it reuses ONLY the pre-written plain-English summary, with NO internal agent codes, table/route names, or operator/admin numbers, and nothing about any other user. Returns isEmpty:true with an honest note when no daily summary has been generated yet — NEVER fabricate a summary. Use for 'how did the trading team do', 'how are the agents performing', 'give me the team report / daily team summary', 'what did the desk do today'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getReconciliationCenterSummary", description: "Reconciliation Center — ADMIN/OWNER ONLY. Returns counts of open reconciliation issues by category and severity. Never returns bridge tokens, API keys, broker passwords, raw account numbers, or other secrets. Per-user callers get a synthetic 403 response. Use for 'admin: are there any reconciliation issues', 'how many orphan positions', 'is anything stuck'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "explainMyReconciliationIssue", description: "Per-user-safe explanation of a reconciliation status the user might encounter (e.g. attribution waiting on broker ticket, bridge stale). Returns a generic, non-diagnostic explanation. Never reveals admin-only diagnostics, other users' data, command IDs, broker tickets, bridge IDs, or secrets. Use for 'why is this trade still pending reconciliation' from a regular user.", parameters: { type: "object", properties: { issueType: { type: "string", description: "Optional category hint." } }, additionalProperties: false } },
  { name: "getMyAccountShell", description: "Phase Account-Shell — Per-user unified account view across Demo / Personal MT5 / Shared Master MT5. ONE call answers: 'what is my balance', 'my equity', 'today's / week's / total P&L', 'open P&L', 'available risk', 'daily loss remaining', 'max lot / max open trades', 'allowed symbols', 'am I approved'. Per-user scoped — never returns another user's balance, another user's trades, or master-pool totals. Pure read; no execution. Returns the same shape as GET /api/me/account-shell.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getAppFeatureMap", description: "Returns the full ARX AI feature map (pages, routes, what each does). Use for 'what is X' or 'where do I find Y'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getMT5BridgeStatus", description: "Returns the user's MT5 bridge connections and per-user connection status. Use for any MT5/EA/bridge question.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getMT5Heartbeat", description: "Returns the user's MT5 connection heartbeat health (healthy/stale/unhealthy/unknown).", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getAccountSnapshot", description: "Returns the user's paper account snapshot: open/closed counts, total P&L, win rate, current session.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getOpenPositions", description: "Returns the user's currently open paper positions.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getTradeJournalSummary", description: "Summarizes the user's recent closed paper trades grouped by symbol.", parameters: { type: "object", properties: { lookbackDays: { type: "integer", minimum: 1, maximum: 365, default: 30 } }, additionalProperties: false } },
  { name: "getDailyPnLCalendar", description: "Returns the user's daily P&L for the last N days.", parameters: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 365, default: 30 } }, additionalProperties: false } },
  { name: "getMyPerformanceSummary", description: "Phase 25 — Per-user trade journal + performance summary. ONE call answers: 'how am I performing', 'what trades did I take today', 'biggest mistake', 'best/worst strategy', 'which trade hurt me most', 'am I overtrading', 'what should I review', 'lessons from closed trades'. Per-user-scoped on paper_trades + trade_journal. Returns isEmpty:true with an honest emptyMessage when there is no data — NEVER fabricates win rate, P&L, strategy ranking, mistakes, or lessons. Win rate is computed ONLY from closed trades. Unrealized P&L on open trades is intentionally excluded (requires fresh price data — call getMyLiveOpenTrades + getTradeIntelligence per trade for that). Profit factor is null when there is not at least one win and one loss. Overtrading hint is null when there is not enough trading-day history to judge.", parameters: { type: "object", properties: { lookbackDays: { type: "integer", minimum: 1, maximum: 365, default: 30 } }, additionalProperties: false } },
  { name: "getRiskLimits", description: "Returns the user's risk governor limits.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getOpenExposure", description: "Phase 26 — Portfolio awareness. Returns the user's total open exposure broken down by symbol and side (long lots / short lots / net lots / positions count). Paper-trade lot totals only. Per-user-scoped — never returns another user's positions. Use for 'am I overexposed', 'what symbols do I have open', 'how much am I trading right now', 'what's my net exposure on EURUSD'. To convert lots → USD notional honestly, call getMarketSnapshot per symbol; never fabricate a notional number.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getRiskUtilization", description: "Phase 26 — Portfolio awareness. Reports how much of the user's configured risk envelope is currently used: open trades vs maxOpenTrades, today's realized loss, and which limits are at/over threshold. Returns hasRiskSettings:false when the user has none — never invents defaults. Per-user-scoped. Use for 'how much risk am I taking', 'am I close to my daily loss limit', 'should I reduce risk', 'how many open trades can I still take', 'am I at my limit'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getReconciliationStatus", description: "Phase 27 — MT5 bridge + reconciliation awareness. Returns the user's broker/app reconciliation state: bridge connected + mode (OFFLINE | READ_ONLY | LIVE_LOCKED), heartbeat age, attribution rows matched-vs-missing-broker-ticket, system-wide unattributed-fill count. Per-user-scoped — never returns another user's attribution rows. Possible reconciliationStatus values: BRIDGE_OFFLINE | RECONCILIATION_BLOCKED | ATTRIBUTION_INCOMPLETE | MATCHED | NO_ROUTED_TRADES. ALWAYS check bridge.connected — if false, say MT5 is not connected and reconciliation cannot run. NEVER imply broker execution is enabled (placementLayer is always BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED today). Use for 'is my MT5 connected', 'is this trade synced with MT5', 'why is broker balance unavailable', 'are any trades missing attribution', 'is the bridge live'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "runPreTradeRiskCheck", description: "Advisory: would this trade pass the risk governor? Returns blocking reasons + warnings. Does NOT execute anything.", parameters: { type: "object", properties: { symbol: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] }, size: { type: "number" }, stopLoss: { type: "number" }, takeProfit: { type: "number" }, entry: { type: "number" } }, required: ["symbol", "side", "size"], additionalProperties: false } },
  { name: "getMarketSnapshot", description: "Returns the per-symbol market snapshot from the SAME shared chart-truth resolver the chart uses, so source/quality/freshness match exactly what the chart shows for that symbol. Read source, quality, aiUsable, freshness, lastPrice, and (when not usable) cause/message — report them honestly; when no feed is available, say so with the actual cause and never fabricate a price. An optional provider quote (bid/ask/spread) may be present as enrichment but never overrides the shared feed status. ALSO read feedConfirmed — when it is false you MUST surface the feedCaveat line (feed not confirmed / low-confidence, verify before trading) and never present the snapshot as a confident/firm number. This caveat is advisory only and never blocks anything.", parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false } },
  { name: "getEconomicCalendar", description: "Returns upcoming economic events from the configured market provider, or empty + connected:false if no provider is wired.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getRecentMarketNews", description: "Returns recent market headlines from the configured market provider, or empty + connected:false if no provider is wired. SYMBOL-SCOPED FINANCIAL NEWS ONLY. For geopolitical / real-world / current-events context, call getCurrentEvents instead.", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20, default: 5 } }, required: ["query"], additionalProperties: false } },
  { name: "getCurrentEvents", description: "Phase 24 — SEPARATE current-events / real-world / geopolitical news channel. Distinct from getRecentMarketNews (which is symbol-scoped financial news). Use for: 'what's happening in the world', 'any geopolitical risk', 'wars / conflicts / supply shocks', 'major news today', 'current events affecting markets'. Returns connected:false today (no adapter wired). If connected:false, you MUST say 'current events are unavailable' — do NOT substitute symbol-scoped market news. Treat events as CONTEXT/RISK MODIFIER only, never as a trading signal.", parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }, additionalProperties: false } },
  { name: "explainFeature", description: "Look up an ARX AI feature or route and return its summary.", parameters: { type: "object", properties: { routeOrFeatureName: { type: "string" } }, required: ["routeOrFeatureName"], additionalProperties: false } },
  { name: "getCurrentPageContext", description: "Returns the page the user is currently looking at (pathname + matched feature). Use for 'what page am I on' or 'explain this page'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getPaperSafetyStatus", description: "Returns the paper-only / liveLocked / readOnlyMode safety status with the reason. Use when the user asks why the app is paper-only, whether you can place a live trade, or what live execution requires.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getMarketDataProviderStatus", description: "Returns whether a real market data provider is wired (Finnhub, Alpha Vantage, Polygon, NewsAPI). Use when the user asks 'do I have live market data'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getPropFirmModeStatus", description: "Per-user prop firm challenge status. Returns ruleStatus (PROP_MODE_OFF | INSUFFICIENT_DATA | COMPLIANT | WARNING | VIOLATION | BLOCKED), rules (profitTargetPct, maxDailyLossPct, maxTotalDrawdownPct, minTradingDays, maxTradingDays, consistencyRulePercent, plus Phase 27-B extended rules: trailingDrawdownEnabled/Amount/Type, maxRiskPerTradePct, maxOpenTrades, maxPendingOrders, maxPositionSizeLots, newsTradingAllowed, weekendHoldingAllowed, overnightHoldingAllowed, strictGuardrailsEnabled), extendedRuleSignals (trailingDrawdownPct, largestTradeRiskPct, largestPositionSizeLots, openTradeCount, insufficientDataRules[], weekendUtcNow), progress (currentBalance, totalPnl, totalPct, profitTargetProgressPct, profitTargetReached, maxDrawdownPct, dailyLossUsedPct, dailyLossRemainingPct, totalDrawdownRemainingPct, daysWorked, daysSinceStart, openTradeCount, closedTradeCount), warnings[], violations[], canTakeNewTrade + canTakeNewTradeReasons. BLOCKED is emitted only when strictGuardrailsEnabled is true AND a HARD violation exists. News + pending-order rules return INSUFFICIENT_DATA (no provider / no PENDING status). Numbers are paper/simulator ONLY — never a real funded account. Returns NOT_CONFIGURED when the user has no ACTIVE challenge. Returns INSUFFICIENT_DATA when configured but zero closed paper trades. Rules are user-entered; not official prop firm rules unless explicitly verified.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "createSupportDiagnosticReport", description: "Builds a diagnostic snapshot (MT5, account, risk, notifications, activity, market provider) for the current user. Use when the user asks for a support summary.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "evaluatePaperTradePlan", description: "Transparent plan-quality scorecard for the user's stored paper trade or an inline draft. Returns plan_completeness, risk_quality, reward_quality, timing_readiness, discipline_alignment, overall score, and a label (incomplete | needs_review | watchlist_ready | paper_trade_ready | blocked_by_risk). NOT a profit prediction. Use when the user asks 'is this trade ready', 'what's missing', 'why was this blocked', 'what's my setup score'.", parameters: { type: "object", properties: { paperTradeId: { type: "integer" }, plan: { type: "object", properties: { symbol: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] }, entry: { type: "number" }, stopLoss: { type: "number" }, takeProfit: { type: "number" }, lotSize: { type: "number" }, reasonForEntry: { type: "string" }, setupType: { type: "string" } }, additionalProperties: false } }, additionalProperties: false } },
  { name: "getTradingStyleProfile", description: "Returns the user's saved trading style: preferred symbol/market, account mode, risk rules. Returns configured:false for fresh users — never invents preferences.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getAssistantLiveAwarenessStatus", description: "Single rollup of the assistant's live awareness for the current user: MT5 bridge + heartbeat, paper safety, risk limits, trading style, prop firm mode, market data provider connection + staleness, in-app notifications unread count, push configured/enabled, journal/performance availability, plus a warnings[] list of missing/disconnected systems. Use FIRST when the user asks 'is everything working', 'what's my status', 'what's connected', 'is this app ready', 'am I set up'. Never fabricates connection status. Per-user-scoped.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getRecentNotifications", description: "Returns the current user's recent in-app notifications (risk, bridge, market_data, trade_journal, prop_firm, scanner, system, account, assistant). Per-user-scoped. Returns isEmpty:true with empty list when the user has none — never fabricates. Includes pushConfigured + marketDataProviderConnected honesty flags. Use for 'do I have alerts?', 'any notifications?', 'any risk warnings?', 'any bridge warnings?', 'any market provider alerts?', 'did anything happen today?'.", parameters: { type: "object", properties: { unreadOnly: { type: "boolean", default: false }, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }, type: { type: "string", description: "Optional notification type filter (e.g. risk, bridge, market_data, trade_journal, prop_firm, scanner, system, account, assistant)." }, severity: { type: "string", enum: ["info", "warning", "critical"] } }, additionalProperties: false } },
  { name: "getAppFeatureRegistry", description: "Phase 22H. Returns the canonical ARX AI feature registry — every page/feature with its userFacingName, where to find it, required setup, status (live | partial | disabled | planned | needsQA), related features, safety notes and empty-state behavior. Use FIRST for broad app-knowledge questions: 'what does this app do', 'what features exist', 'what's available', 'what's planned'. Never fabricate — answer only from this registry.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getFeatureHelp", description: "Phase 22H. Look up a single ARX AI feature by id (e.g. 'mt5_bridge'), name ('MT5 Bridge'), user-facing name ('Risk Settings'), or route ('/risk') and return its full registry entry: short + full description, where to find it, required setup, current status, safety notes, related features. Use for 'what is X', 'how do I use Y', 'is feature Z live', 'what setup does X need'.", parameters: { type: "object", properties: { idOrName: { type: "string", description: "Feature id, name, user-facing name, or route." } }, required: ["idOrName"], additionalProperties: false } },
  { name: "getCurrentPageHelp", description: "Phase 22H. Explains the page the user is currently looking at. ONLY use when the user EXPLICITLY asks about the current page or screen — e.g. 'what does this page do', 'what does this button do', 'how do I use this screen', 'explain this page', 'why is this empty'. DO NOT use for short follow-ups ('?', '??', 'and?', 'so?', 'what happened?', 'did you check?', 'what did you find?', 'I asked you a question'), market/scanner/trade/risk/MT5/account questions, or anything where the prior turn was about a different topic. Short follow-ups always continue the most recent unresolved request — never default to page help.", parameters: { type: "object", properties: { pathname: { type: "string", description: "Optional pathname override. Defaults to the page context sent by the frontend." } }, additionalProperties: false } },
  { name: "getAssistantCapabilityStatus", description: "Phase 22H. Reports what the assistant can actually do RIGHT NOW for this user: app help, market awareness, bridge awareness, risk checks, journal analysis, notifications, voice input, speech output, live realtime mode, plus order-execution lock. Each capability includes available + reason + setup hints. Use for 'what can the assistant do', 'what can you do', 'are you live', 'can you talk', 'what's broken'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getMarketScannerOpportunities", description: "Phase 22O + TW. Returns ranked scanner candidates from REAL provider candles when a market data provider with candle support is connected (currently: TwelveData / Finnhub). Each candidate has symbol, timeframe, bias, setupType, confidenceScore, riskScore, riskRewardRatio, reasonForTrade, statusBadge, opportunityLabel, entry, stopLoss, takeProfit (= TP2 main, backward-compat), AND a Phase TW takeProfitTargets[] array with up to TP1/TP2/TP3 — each {label, price, reason, rr, distancePoints, distancePips, suggestedAction (partial|full|runner), confidence (low|medium|high)}. bestTargetLabel names the primary target (usually TP2). If targetsUnavailableReason is non-null, takeProfitTargets is [] and you MUST report that targets are unavailable — never invent them. Call this WHENEVER the user asks 'check the scanner', 'what should I trade', 'best market right now', 'any opportunities', 'scan the market', 'what's hot', 'where should I take profit', 'where to TP'. ALWAYS read liveDataConnected: if false, opportunities is EMPTY and you MUST tell the user that live market data with candle support is not connected. Never fabricate scanner candidates or TP levels of your own.", parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }, additionalProperties: false } },
  { name: "getTradingMode", description: "Phase 23. Returns the user's current trading mode envelope: platform mode (OFF/SIMULATED/DEMO/LIVE), per-user permissions, emergency kill switch state, MT5 account type, banner label, and the top blocker reason. Use for 'is trading on', 'am I in demo or live', 'can I trade', 'why is my trade blocked', 'is my MT5 account demo or live', 'what is the current platform mode'. NEVER guess — always call this first.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "requestDemoOrder", description: "Phase 23. Submits a DEMO trade order through the guarded placement chain. Routes ONLY to verified MT5 demo accounts. Cannot bypass any backend gate — every order goes through runOrderGuards() and then the broker placement queue. Returns the audit log id, queued command id, and rejection reason if any gate failed. Use ONLY when the user has explicitly said 'place this demo trade' / 'send the demo order' etc. Never use to silently trade.", parameters: { type: "object", properties: { symbol: { type: "string" }, side: { type: "string", enum: ["BUY", "SELL"] }, lotSize: { type: "number", minimum: 0.01, maximum: 100 }, stopLoss: { type: "number" }, takeProfit: { type: "number" } }, required: ["symbol", "side", "lotSize"], additionalProperties: false } },
  { name: "getMyLiveOpenTrades", description: "Phase UX1. Returns the signed-in user's open trades, routing-aware. USER_OWNED_MT5 reads from live_positions; SHARED_MASTER_MT5 reads from shared_trade_attribution. Per-user P&L on shared master is an allocation estimate (pnlIsEstimate:true). Never returns master credentials or other users' rows. Use whenever the user asks 'what are my open trades', 'how is my position doing', 'show my live trades'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "prepareCloseTicket", description: "Phase UX1. Validates that a trade id belongs to the signed-in user and is closable, and returns a preview of the close action. Does NOT close the trade — the user must click Confirm Close in the UI. Use when the user asks 'close my EURUSD trade' or 'help me close trade X'.", parameters: { type: "object", properties: { tradeId: { type: "string" } }, required: ["tradeId"], additionalProperties: false } },
  { name: "prepareOpenTicket", description: "Phase UX1. Previews how a hypothetical order would route (mode, broker, block reason). Does NOT place the order — the user must click Submit Order in the Quick Trade modal. Use when the user asks 'walk me through opening a EURUSD buy' or 'what would happen if I went short XAUUSD'.", parameters: { type: "object", properties: { symbol: { type: "string" }, side: { type: "string", enum: ["BUY", "SELL"] }, lotSize: { type: "number", minimum: 0.01, maximum: 100 }, mode: { type: "string", enum: ["SIMULATED", "DEMO", "LIVE"] } }, required: ["symbol", "side", "lotSize", "mode"], additionalProperties: false } },
  { name: "requestLiveOrder", description: "Phase 23. Submits a LIVE (real-money) trade order through the guarded placement chain. ALWAYS requires confirmedByUser=true — pass true ONLY when the user has just typed an explicit confirmation phrase like 'confirm live trade' or 'yes, place the live order'. Otherwise pass false; the order will be rejected with LIVE_CONFIRMATION_REQUIRED. Routes only to verified MT5 live accounts. Cannot bypass any backend gate.", parameters: { type: "object", properties: { symbol: { type: "string" }, side: { type: "string", enum: ["BUY", "SELL"] }, lotSize: { type: "number", minimum: 0.01, maximum: 100 }, stopLoss: { type: "number" }, takeProfit: { type: "number" }, confirmedByUser: { type: "boolean", default: false } }, required: ["symbol", "side", "lotSize", "confirmedByUser"], additionalProperties: false } },
  { name: "getTradeIntelligence", description: "Phase UX2. Returns a fresh live-trade intelligence snapshot for one of the signed-in user's open trades (tradeKey is 'lp_<id>' or 'att_<id>' from getMyLiveOpenTrades). Scores: continuation, pullback, reversal, fakeout, profit protection, close urgency, hold confidence, trend strength, volatility risk. Includes derived pnlPips and profitGivebackPercent, plus a label and recommendedAction (HOLD | WATCH_CLOSELY | MOVE_STOP_TO_BREAKEVEN | TRAIL_STOP | PARTIAL_CLOSE | CLOSE_CONSIDERATION | CLOSE_NOW_PROMPT | NO_ACTION_DATA_INSUFFICIENT). dataQuality lists missing inputs — when missing.length>0, you MUST tell the user which signals are unavailable instead of pretending you can judge confidently. Never guarantees profit. Never closes a trade.", parameters: { type: "object", properties: { tradeKey: { type: "string" } }, required: ["tradeKey"], additionalProperties: false } },
  { name: "getSymbolMarketContext", description: "Phase UX6. Returns the LIVE multi-timeframe market context for a symbol (M1..D1): trend per TF, ATR, swing high/low, S/R, range, plus a classifier label (Strong continuation | Weak continuation | Healthy pullback | Deep retracement | Reversal risk rising | Possible fakeout | Liquidity sweep possible | Breakout holding | Failed breakout | Choppy / no clear edge | Data insufficient) with 11 scores and an evidence-cited explanation. context.source and context.freshness now come from the SAME shared chart-truth resolver the chart uses, so they match the chart exactly; context.sharedQuality / context.sharedAiUsable / context.sharedCause carry that shared verdict (sharedCause names the actual reason when data is not usable). ALWAYS read context.dataQuality.quality (and context.sharedQuality) — if data is insufficient/unavailable you MUST tell the user live candle data is unavailable, name the cause, and not invent a read. ALSO read context.feedConfirmed — when it is false you MUST open your answer with the context.feedCaveat line (feed not confirmed / low-confidence) before any read; never present an unconfirmed-feed read as a confident call. This caveat is advisory only and never blocks anything. Never fabricates candles. Use for a BROAD multi-timeframe live-quote/context overview — e.g. 'what is the market doing on X', 'is there a trend on GBPUSD H1', 'give me the broad picture on EURUSD'. For a SINGLE-SYMBOL structural/direction read ('read <symbol>', 'analyze <symbol>', 'what do you see on <symbol>') use readChartStructure instead — never this tool.", parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false } },
  { name: "readChartStructure", description: "Phase Chart-Read (Task #602). THE primary tool for a STRUCTURAL chart read — use this FIRST whenever the user says 'read <symbol>', 'analyze <symbol>', 'what do you see on <symbol>', 'redo on V75', 'structure on GBPUSD', or asks for the direction/bias on a specific market (and optional timeframe). Returns the SAME directional read the Scanner 'Chart Read' panel shows, so chat and the panel never disagree: chartRead carries bias, confidence, summary, support/resistance levels, conditions, invalidation, risk notes — plus readLayer. ALWAYS branch on readLayer: 'FULL' = the exact entry/stopLoss/takeProfit/reward:risk in chartRead are valid and you MAY state them; 'STRUCTURAL_ONLY' = give the directional structure (bias, S/R, conditions, invalidation) but you MUST say the exact entry/stop/target are WITHHELD until the live feed confirms (cite chartRead.blockedReason) and NEVER invent levels; 'INSUFFICIENT' = there isn't enough verified candle data, so say exactly that (use chartRead.headline / chartRead.blockedReason) and do NOT invent a read. ALWAYS surface chartRead.trustLine and end with chartRead.disclaimer. symbol is OPTIONAL — when omitted it reads the symbol currently on the user's chart (page context). timeframe is OPTIONAL — omit to use the user's on-screen chart timeframe, otherwise it defaults to H1. Read-only; never places a trade; never fabricates candles. Prefer this over getSymbolMarketContext for a single-symbol structure/direction read (getSymbolMarketContext is for a broad multi-timeframe live quote/context overview).", parameters: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string" } }, additionalProperties: false } },
  { name: "getTradeMarketContext", description: "Phase UX6. Returns LIVE market context attached to one of the signed-in user's open trades (tradeKey is 'lp_<id>' or 'att_<id>' from getMyLiveOpenTrades). Includes trendAlignment (ALIGNED | FIGHTING | NEUTRAL | UNKNOWN), tradeLabel (Trade aligned with trend | Trade still valid | Trade weakening | Trade fighting trend | Trade invalidation near | Trade at decision level | Profit protection needed | Exit review recommended | Data insufficient), keyLevels (invalidationLevel, continuationLevel, nearestSupport/Resistance, swingHigh/Low, breakoutLevel, keyLevelToWatch), bullishScenario, bearishScenario, exitHoldReview. Use to answer 'how is my trade looking', 'is my trade still valid', 'where is my invalidation', 'what is the structure on my open trade'. Never closes a trade. If context.dataQuality.quality is 'insufficient', say so and recommend no price-action call. ALSO read context.feedConfirmed — when it is false you MUST open your answer with the context.feedCaveat line (feed not confirmed / low-confidence) before any read; never present an unconfirmed-feed read on an open trade as a confident call. This caveat is advisory only and never blocks anything.", parameters: { type: "object", properties: { tradeKey: { type: "string" } }, required: ["tradeKey"], additionalProperties: false } },
  { name: "getTradeDecision", description: "Phase UX7. Returns the SINGLE central trade decision for one of the signed-in user's open trades (tradeKey is 'lp_<id>' or 'att_<id>'). Fuses market context (UX6) + smart exit plan (UX5) + live trade intelligence (UX2) + the user's preferences into one decisionLabel from this fixed set: Hold | Hold but monitor | Healthy pullback | Continuation still valid | Protect profit | Review partial close | Review full close | Move stop review | Trail stop review | Exit risk rising | Trade invalidation near | Trade invalidated | No clear decision | Data insufficient. Also returns decisionAction (HOLD | WATCH_CLOSELY | SET_ALERT | REVIEW_MOVE_STOP | REVIEW_TRAIL_STOP | REVIEW_PARTIAL_CLOSE | REVIEW_FULL_CLOSE | WAIT_FOR_CONFIRMATION | NO_ACTION_DATA_INSUFFICIENT), confidenceScore/urgencyScore/riskScore (0..100 or null), mainReason, supportingReasons[], invalidation/protectProfit/continuation levels, suggestedButton (always opens a review modal — NEVER an instant order), and dataQuality with missing[]. If dataQuality.hasIntelligence=false and hasMarketContext=false the decision will be 'Data insufficient' — you MUST say live data is not connected and stop, never invent a call. Use to answer 'what should I do with my trade', 'is my trade still good', 'why are you saying review close', 'do I hold or close'.", parameters: { type: "object", properties: { tradeKey: { type: "string" } }, required: ["tradeKey"], additionalProperties: false } },
  { name: "getTradeExitAlerts", description: "Phase UX2. Returns the signed-in user's recent Sniper Exit Alerts (user-scoped). Each row has alertType, severity (info|watch|warning|urgent), title, message, recommendedAction, acknowledgedAt. Use to answer 'any alerts on my trades', 'why did I get a notification', or before suggesting a close.", parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, additionalProperties: false } },
  { name: "prepareCloseReview", description: "Phase UX2. Builds a close-review preview for one of the user's open trades. Returns symbol, side, lotSize, currentPnl, peakPnl, profitGivebackPercent, accountType, routingMode, label, recommendedAction, and (for LIVE) a warningIfLive string. Does NOT close anything — the user must click Confirm Close in the modal. Use when the user says 'should I close this' or after a close_urgency alert.", parameters: { type: "object", properties: { tradeKey: { type: "string" } }, required: ["tradeKey"], additionalProperties: false } },
  { name: "getSniperWatchlist", description: "Phase UX3. Returns the signed-in user's open trades that need attention RIGHT NOW (ranked by closeUrgencyScore desc). Each item has tradeKey, symbol, side, lotSize, unrealizedPnl, peakPnl, profitGivebackPercent, closeUrgencyScore, reversalRiskScore, fakeoutRiskScore, label, recommendedAction, an array of human-readable reasons, and urgencyTier (info|watch|warning|urgent). USE THIS for: 'which of my trades need attention', 'which trade is closest to reversing', 'which trade is giving back the most profit', 'should I close anything', 'which open trade has the highest close urgency', 'which trade looks like a fakeout', 'which trade is still healthy' (those NOT in the list), 'what is my safest exit plan'. Never fabricates entries — if list is empty, say so. Read-only.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getTradeTimeline", description: "Phase UX3. Returns the per-trade decision timeline for one of the user's trades (events: user_asked_ai, ai_answered, alert_fired, alert_ignored, alert_acknowledged, close_reviewed, close_confirmed, trade_closed, etc). Use to answer 'did AI warn me before this trade reversed', 'did I ignore any close alerts', 'what happened with this trade'. Only returns the caller's own trades. tradeKey is 'lp_<id>' or 'att_<id>'.", parameters: { type: "object", properties: { tradeKey: { type: "string" } }, required: ["tradeKey"], additionalProperties: false } },
  { name: "getExitPlan", description: "Phase UX5. Returns the Smart Exit Plan for one of the user's open trades (tradeKey 'lp_<id>' or 'att_<id>'). Includes suggested levels (protectProfit, invalidation, continuation, conservativeExit, aggressiveExit, partialClose, trailStop), tradeEfficiencyScore (0..100), efficiencyLabel, timeWarning, recommendedAction, explanation, invalidationTrigger, continuationTrigger, dataQuality (canDeriveLevels / canScoreEfficiency / missing[]). NEVER guarantees profit. NEVER moves stops, never closes trades, never modifies broker state — every level is decision support and requires explicit user confirmation. When canDeriveLevels is false, levels are null and the user MUST be told that entry/SL/TP are missing.", parameters: { type: "object", properties: { tradeKey: { type: "string" } }, required: ["tradeKey"], additionalProperties: false } },
  { name: "getRecentExitReviews", description: "Phase UX3. Returns recent post-trade exit reviews for the signed-in user. Each review has symbol, side, peakUnrealizedPnl, finalRealizedPnl, profitGivebackPercent, closeMethod (manual|ai_reviewed|sl|tp|mt5_broker), aiAlertsFiredCount, aiAlertsActedCount, labels (great_exit | early_exit | late_exit | protected_profit | held_too_long | ignored_close_alert | stop_loss_hit | take_profit_hit | data_insufficient). Use for 'did closing protect profit', 'did I exit too early', 'did I act on the alerts'. Read-only.", parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }, additionalProperties: false } },
  { name: "createTradeActionDraft", description: "Phase UX8 (Trade Action Center). Creates a DRAFT trade action that the user MUST review and confirm in the Trade Action Center before any guard runs or any command is queued. NEVER executes anything. NEVER closes a trade, opens a trade, or moves a stop. Use when the user asks 'queue a close review', 'prepare a partial close', 'draft a move-stop review', or when getTradeDecision returned a suggestedButton that the user wants to act on. actionType is one of OPEN | CLOSE | PARTIAL_CLOSE | MOVE_STOP | TRAIL_STOP | MODIFY_TP_SL | CANCEL_ORDER. For trade-touching actions tradeKey is required ('lp_<id>' or 'att_<id>'); for OPEN provide symbol+side+lotSize. Returns the draft id and status='ai_suggested'. After calling this tool ALWAYS tell the user: 'I drafted action #<id>. Open the Action Center to review and confirm — ARX will not execute until you confirm.'", parameters: { type: "object", properties: { actionType: { type: "string", enum: ["OPEN","CLOSE","PARTIAL_CLOSE","MOVE_STOP","TRAIL_STOP","MODIFY_TP_SL","CANCEL_ORDER"] }, tradeKey: { type: "string" }, symbol: { type: "string" }, side: { type: "string", enum: ["BUY","SELL"] }, lotSize: { type: "number", minimum: 0.01, maximum: 100 }, requestedMode: { type: "string", enum: ["SIMULATED","DEMO","LIVE"], default: "SIMULATED" }, stopLoss: { type: "number" }, takeProfit: { type: "number" }, reason: { type: "string", maxLength: 500 } }, required: ["actionType"], additionalProperties: false } },
  { name: "listMyPendingActions", description: "Phase UX8. Returns the signed-in user's trade actions that are NOT yet terminal — i.e. still in ai_suggested | user_reviewing | awaiting_confirmation | confirmed | guard_checking | queued | sent_to_mt5. Each item includes id, actionType, symbol, tradeKey, status, requestedMode, createdAt, expiresAt, reason. Use to answer 'what actions are pending', 'do I have anything awaiting confirmation', 'did I leave a close review open'. Read-only.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getTradeActionStatus", description: "Phase UX8. Returns the lifecycle status of one of the signed-in user's trade actions by id, including current status, guardResult.checks (passed/failed reasons), rejectionReason, tradeCommandId, mt5Ticket. Use to answer 'did my close request execute', 'what happened to action #N', 'is action #N still pending'. Read-only.", parameters: { type: "object", properties: { actionId: { type: "integer", minimum: 1 } }, required: ["actionId"], additionalProperties: false } },
  { name: "explainActionRejection", description: "Phase UX8. Returns the rejectionReason and the FIRST failed guard check for a rejected or failed trade action belonging to the signed-in user. Use to answer 'why was my action rejected', 'why did the close request fail', 'what guard blocked action #N'. Read-only. If the action is not rejected/failed, returns the current status with note 'not_in_failed_state'.", parameters: { type: "object", properties: { actionId: { type: "integer", minimum: 1 } }, required: ["actionId"], additionalProperties: false } },
  { name: "getActionExecutionResult", description: "Phase UX9. Returns the broker execution result for ONE of the signed-in user's trade actions: status (awaiting_confirmation | confirmed | guard_checking | queued | sent_to_mt5 | executed | rejected | failed | expired | cancelled), mt5OrderTicket, mt5PositionTicket, fillPrice, requestedPrice, slippage, filledLotSize, brokerMessage, errorCode, executedAt, plus the linked tradeCommandId. Read-only, per-user. NEVER fabricates fill prices or tickets — when fields are null, say so. Use to answer 'did my order execute', 'what was my fill price', 'was there slippage', 'did my close go through', 'is action #N still pending', 'what did the broker say'.", parameters: { type: "object", properties: { actionId: { type: "integer", minimum: 1 } }, required: ["actionId"], additionalProperties: false } },
  { name: "explainBrokerRejection", description: "Phase UX9. For a rejected or failed trade action of the signed-in user, returns a short, user-friendly explanation of WHY the broker rejected it (invalid volume, market closed, insufficient margin, off quotes, invalid stops, requote, account type, auto-trading disabled, EA disabled, etc.) plus a recommendedFix. If the action wasn't rejected, returns status+note='not_rejected'. Read-only. Never invents rejection reasons — uses the actual errorCode + brokerMessage saved by the reconciler.", parameters: { type: "object", properties: { actionId: { type: "integer", minimum: 1 } }, required: ["actionId"], additionalProperties: false } },
  { name: "getRecentExecutionResults", description: "Phase UX9. Returns the most recent (default 10) trade-action execution results for the signed-in user across all statuses. Each row has actionId, actionType, symbol, requestedMode, status, mt5OrderTicket, mt5PositionTicket, fillPrice, slippage, brokerMessage, errorCode, executedAt, createdAt. Read-only. Use for 'show my recent executions', 'what did the broker do last', 'how have my trades been filling'.", parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }, additionalProperties: false } },
  { name: "getStuckCommandsForUser", description: "Phase UX9. Returns any of the signed-in user's trade actions whose underlying broker command went stale (status=failed with errorCode=WATCHDOG_STALE or status=sent_to_mt5 past timeout). Each row has actionId, symbol, requestedMode, status, brokerMessage, staleAt, ageMinutes, recommendedAction. Read-only. Use for 'why is my action stuck', 'did anything time out', 'is my close still pending'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getLaunchReadiness", description: "Alias of getMyTradingReadiness. Returns the signed-in user's launch/readiness report (ready_for_paper / ready_for_demo / ready_for_live + blockers). Use when the user asks 'am I ready to launch', 'launch readiness', 'can I go live'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "summarizeLaunchReadinessForAdmin", description: "ADMIN/OWNER ONLY. Read-only operator summary of the ARX Operator Command Center: trading mode, server live-broker master switch (boolean), kill switch, queue depth, open live commands, reconciliation severity counts, user-approval counts (totals only — no per-user PII beyond aggregate buckets), and a 'ready / blocked / needsAction / safeToManuallyTest' verdict. NEVER returns raw bridge tokens, hashes, env values, IP addresses, or account numbers. NEVER places trades, modifies connections, or contacts the EA. If the caller is not ADMIN or OWNER, returns {error:'ADMIN_REQUIRED'}. Use when an operator asks 'summarize launch readiness', 'what's the operator status', 'is the platform safe to live-test'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getMyTradingReadiness", description: "Readiness Engine. Returns the signed-in user's full 14-status readiness report: accountMode (USER_OWNED_MT5 | SHARED_MASTER_MT5 | null), paperOnlyHardLockActive, ready_for_paper, ready_for_demo, ready_for_live, blockers[], and statuses[] (id, label, status: pass|fail|warning|blocked|not_required, requiredFor, blockerReason, userFriendlyExplanation, nextStep). NEVER fabricates readiness — every flag comes from the same engine the API and admin dashboard use. ready_for_live is REPORTING ONLY (no execution path reads it) and is true ONLY for an admin-approved, armed, eligible trader who has cleared every live gate; it is false for non-approved, non-armed, investor, or system accounts. Use to answer 'am I ready to trade', 'what's my readiness', 'can I trade live yet'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "explainReadinessBlockers", description: "Readiness Engine. Returns only the FAILING readiness items for the signed-in user with a plain-English explanation and the exact next step for each. Use when the user asks 'why am I blocked', 'why can't I trade live', 'what's stopping me', 'what do I need to fix'. Read-only.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "listMyOnboardingSteps", description: "Readiness Engine. Returns the full list of the signed-in user's onboarding/readiness statuses grouped by stage (profile, risk, disclosures, account_mode, mt5, demo, live) with their current status. Use for 'what onboarding steps are left', 'where am I in setup', 'show my checklist'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getOnboardingProgress", description: "Readiness Engine. Returns the signed-in user's onboarding completion: percent (0..100), passed/total counts, currentStage, nextStep, onboardingStatus, completedSteps[], walkthroughCompleted. Use for 'how far am I in onboarding', 'am I done with setup'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getMyPlaybooks", description: "Phase Playbook. Returns the signed-in user's trading playbooks (id, title, strategyType, status, preferredSymbols, preferredSessions, timeframe, sampleSize, winRateSnapshot). Read-only, per-user (SQL-filtered on userId). Returns isEmpty:true when the user has no playbooks — NEVER fabricates one. Use to answer 'what are my playbooks', 'show my strategies', 'do I have a playbook for XAUUSD'.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "evaluateTradeAgainstPlaybook", description: "Phase Playbook. For ONE of the signed-in user's recent pre-trade checks, returns the playbook match: playbookId, playbookTitle, decision (pass|warning|block), score 0-100, label (A+|A|B|C|low|avoid|insufficient), passedRequiredCount, failedRequiredCount, ruleResults[]. Read-only. Returns notFound when the check doesn't exist or belongs to another user. NEVER invents a score — if the pre-trade check was never run, returns dataAvailable:false.", parameters: { type: "object", properties: { preTradeCheckId: { type: "integer", minimum: 1 } }, required: ["preTradeCheckId"], additionalProperties: false } },
  { name: "getBestAndWorstPlaybooks", description: "Phase Playbook. Returns the signed-in user's playbook performance from REAL closed trades only: best[] (top 3 by realized P&L, with trade count, win rate, avg P&L) and worst[] (bottom 3). Per-user-scoped and (where applicable) shared-master-attribution-scoped. Returns isEmpty:true with reason='no_closed_trades_with_playbook_tag' when no journal entries have matchedPlaybookId set yet. NEVER fabricates win rates.", parameters: { type: "object", properties: { minTrades: { type: "integer", minimum: 1, maximum: 50, default: 3 } }, additionalProperties: false } },
  { name: "getRecentPreTradeChecks", description: "Phase Playbook. Returns the signed-in user's most recent (default 10) pre-trade-check results: id, playbookId, symbol, side, decision, score, passedRequiredCount, failedRequiredCount, createdAt. Read-only, per-user. Use to answer 'show my recent setup checks', 'how was my last setup scored'.", parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }, additionalProperties: false } },
  { name: "getTopOpportunitiesForMe", description: "Opportunity Radar. Returns the signed-in user's ranked opportunities from REAL provider candles via LiveScanner. Per-user-scoped (uses the user's watchlist preferences / watchlist items / sensible defaults). Each opportunity has symbol, timeframe, directionBias, opportunityScore, setupQualityScore, confluenceScore, riskScore, label, reasonSummary, suggestedAction, toolsUsed, dataQuality, dataSource. Sections: bestOpportunities, watchClosely, waitForConfirmation, highRiskOrAvoid, dataInsufficient. ALWAYS read liveDataConnected — if false, opportunities are empty/data-insufficient and you MUST say live data isn't connected. NEVER fabricate opportunities. Use for: 'best market right now', 'what should I watch', 'any opportunities', 'scan my watchlist'.", parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }, additionalProperties: false } },
  { name: "explainOpportunityRanking", description: "Opportunity Radar. Returns the ranked opportunities for the signed-in user PLUS a per-symbol explanation of which tools were used and why each rank. Use when the user asks 'why did you rank X higher than Y', 'what tools did you use to rank this', 'explain the ranking', 'why is gold #1'. Reads only from real scanner output; never invents reasoning.", parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20, default: 5 } }, additionalProperties: false } },
  { name: "explainOrderType", description: "Phase TT (Trade Ticket). Static educational explanation of one of the 8 supported order types: BUY_MARKET, SELL_MARKET, BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP, BUY_STOP_LIMIT, SELL_STOP_LIMIT. Returns whatItIs, whenToUse, requiredFields, placementRule, typicalUseCase, slTpRule. Use when the user asks 'what is a Buy Stop', 'when do I use a Sell Limit', 'difference between stop and limit', 'how does Stop Limit work'. Read-only, no user state. NEVER invents new order types.", parameters: { type: "object", properties: { orderType: { type: "string", enum: ["BUY_MARKET","SELL_MARKET","BUY_LIMIT","SELL_LIMIT","BUY_STOP","SELL_STOP","BUY_STOP_LIMIT","SELL_STOP_LIMIT"] } }, required: ["orderType"], additionalProperties: false } },
  { name: "analyzeTradeTicket", description: "Phase TT (Trade Ticket). Runs the SAME per-order-type validation the trade ticket UI and backend use: SL/TP direction relative to entry, pending-order entry vs current market, stop-limit trigger/limit relationship, min-stop distance, lot rules. Returns { ok, errors[], warnings[], riskReward, slDistancePips, tpDistancePips, riskPriceUnits, rewardPriceUnits, dataUnavailable }. Use when the user asks 'is my stop loss too tight', 'is my TP realistic', 'what is my risk/reward', 'where is my invalidation', 'why was my order blocked', 'check this setup before I submit'. NEVER fabricates a current price — when currentPrice is omitted, market-relative checks are skipped honestly (dataUnavailable:true).", parameters: { type: "object", properties: { orderType: { type: "string", enum: ["BUY_MARKET","SELL_MARKET","BUY_LIMIT","SELL_LIMIT","BUY_STOP","SELL_STOP","BUY_STOP_LIMIT","SELL_STOP_LIMIT"] }, lotSize: { type: "number" }, currentPrice: { type: "number" }, entryPrice: { type: "number" }, stopTriggerPrice: { type: "number" }, stopLimitPrice: { type: "number" }, stopLoss: { type: "number" }, takeProfit: { type: "number" }, minStopDistance: { type: "number" }, minPendingDistance: { type: "number" }, symbolPipSize: { type: "number" } }, required: ["orderType","lotSize"], additionalProperties: false } },
  { name: "getMyPendingOrderDrafts", description: "Phase TT/TU/TV (Trade Ticket). Returns the signed-in user's saved pending-order drafts. Each draft has id, orderType, symbol, side, lotSize, entryPrice, stopTriggerPrice, stopLimitPrice, stopLoss, takeProfit, expiration, pendingStatus, status, tradeCommandId (link to the mt5_commands row if forward-submitted), mt5OrderTicket (only present after MT5 confirmed), createdAt. Per-user-scoped. pendingStatus VOCABULARY: EA_UPGRADE_REQUIRED|BRIDGE_DISCONNECTED|BRIDGE_UNSUPPORTED|READ_ONLY|LIVE_LOCKED|BLOCKED_BY_PAPER_LOCK = draft only, NOT at broker. QUEUED = command row inserted into mt5_commands. PLACED = MT5 returned a real order ticket (mt5OrderTicket populated). REJECTED = MT5 refused. CANCELLED = soft-cancelled OR broker-confirmed cancel. CANCEL_QUEUED/MODIFIED = transient post-bridge states. CRITICAL: NEVER claim a draft is 'live', 'at the broker', 'filling', or 'working' unless pendingStatus='PLACED' AND mt5OrderTicket is non-null. The system is paper-only today: nearly every submit returns BLOCKED_BY_PAPER_LOCK.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getProtectiveCloseStatus", description: "Phase 13 (Protective Auto-Close). READ-ONLY. Returns the signed-in user's Protective Auto-Close settings and the most recent decisions journal (one entry per evaluation, even ALERT_ONLY / NO_ACTION / BLOCKED). Each decision row has tradeKey, decision (NO_ACTION | ALERT_ONLY | RECOMMEND_CLOSE | RECOMMEND_PARTIAL_CLOSE | AUTO_CLOSE_ELIGIBLE | BLOCKED), reasonCode, signals[], confidenceScore, activityStatus (ACTIVE | INACTIVE | UNKNOWN), failedChecks[] (when BLOCKED), actionTakenActionId (only when the engine actually drafted a CLOSE action — null otherwise), createdAt. The settings object includes enabled (default false), inactivityThresholdMinutes, minConfidence, allowPartialCloseOnly, killSwitchActive, optInAt, lastUpdatedAt. CRITICAL: ARX may EXPLAIN these decisions but NEVER claims a close happened unless actionTakenActionId is non-null AND the linked action's execution result shows status='executed'. When decision='BLOCKED' say so honestly with the failedChecks reason. When settings.enabled=false say protective auto-close is OFF (default). When activityStatus='UNKNOWN' explain that the engine downgraded to alert-only. NEVER triggers the engine — only the worker does. Per-user-scoped (SQL-filtered on userId).", parameters: { type: "object", properties: { tradeKey: { type: "string", description: "Optional. Filter decisions for a single trade ('lp_<id>' or 'att_<id>')." }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }, additionalProperties: false } },
  { name: "getFinalTradeRead", description: "Phase News-Decision. Returns the fused FINAL TRADE READ for a symbol/timeframe — combines current technical scanner score, same-time historical context, and news-risk context into one decision: TRADE_WATCH | WAIT_FOR_CONFIRMATION | AVOID_FOR_NOW | NO_TRADE. Also returns headline, reasons[], technicalScore, historicalScore, newsRiskLevel, conflict, confidence. CRITICAL: you are EXPLICITLY ALLOWED — and expected — to recommend WAIT / AVOID / NO_TRADE when this tool returns those. Do NOT force a buy/sell answer when the safer answer is no trade. If confidence=LOW because news/history are unavailable, say so honestly. Use for 'should I trade EURUSD now', 'what's the read on gold', 'is this a good entry', 'safe to buy', 'should I wait'.", parameters: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string", description: "Defaults to 'M15'." } }, required: ["symbol"], additionalProperties: false } },
  { name: "getMarketNewsIntelligence", description: "Phase News. Returns a normalized MarketNewsDecisionPack for a symbol: riskLevel (none|low|medium|high|critical), bias (bullish|bearish|mixed|unclear) from recent headlines, timing (now|upcoming|recent|quiet), recommendation (watch|wait|avoid|proceed_with_caution), upcomingEvent {title,currency,impact,minutesUntil}, recentHeadlines (real provider only — empty if no provider wired), affectedCurrencies, and dataSources with connected flags for headlines/calendar/social. CRITICAL: if dataSources.headlines.connected=false the headlines array is empty — you MUST say 'news feed is unavailable' rather than inventing headlines. The economic calendar today is a built-in schedule (mock) — never claim it as a live live calendar feed. Social/X monitoring is not configured. Decision support only, never a buy/sell signal. Per-symbol cached 60s. Use for 'what news affects EURUSD', 'is there event risk', 'should I avoid this trade due to news', 'why is gold moving', 'what catalysts are active'.", parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false } },
  { name: "getHistoricalContext", description: "Phase Historical. Returns same-time historical comparison for a symbol over yesterday / last week / last month / last year / 5 years ago, using REAL provider candles via the market data provider chain. Returns bias (BULLISH | BEARISH | MIXED | INSUFFICIENT_DATA), confidence (LOW | MEDIUM | HIGH), sampleSize (0-5), per-window directions and % moves, plus setupSummary {sampleSize, winRate, avgMovePct, worstDrawdownPct, bestMovePct, avgTimeToNextCandleMs}. CRITICAL: if bias = INSUFFICIENT_DATA OR setupSummary.sampleSize = 0, you MUST tell the user historical data is unavailable for this symbol/timeframe — never invent a number. Treat as decision support only, never as a buy/sell signal. Per-symbol cached for 60s. Use for 'what does history say about X', 'how did EURUSD behave this time last year', 'is this setup historically reliable', 'what's the same-time pattern'.", parameters: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string", description: "Defaults to '1d'." } }, required: ["symbol"], additionalProperties: false } },
  { name: "getBridgeCapabilities", description: "Phase TU (MT5 EA/Bridge upgrade). Returns the signed-in user's MT5 bridge capability disclosure as last reported by their EA on heartbeat. Fields: bridgeConnected (bool, true only if a heartbeat arrived within the last ~90s), eaVersion (string|null), capabilitiesReportedAt (ISO|null), capabilities (object with booleans: marketOrders, marketOrderSLTP, pendingOrders, stopLimitOrders, modifyPositionProtection, modifyPendingOrders, cancelPendingOrders, expiration, sharedMasterSafeRouting), pendingOrderExecutable (bool — always false today because of the system-wide paper-only lock), currentSubmitStatus (one of: BRIDGE_DISCONNECTED, BRIDGE_UNSUPPORTED, READ_ONLY, LIVE_LOCKED, BLOCKED_BY_PAPER_LOCK, QUEUED), currentSubmitExplanation (plain-language reason). Use when the user asks 'is my EA up to date', 'does my bridge support pending orders', 'why can't I submit a stop-limit', 'what version is my EA', 'is my bridge connected'. NEVER claims the bridge supports an action when the capability is false. NEVER says pendingOrderExecutable is true today.", parameters: { type: "object", properties: {}, additionalProperties: false } },
] as const;

export type ToolName = typeof TOOL_DEFINITIONS[number]["name"];

// ── Phase UX1 — Live trades awareness (routing-aware, read-only) ─────────
// Reads the same tables as /api/me/trades/open but returns a flattened
// summary the LLM can quote without risk of leaking master credentials or
// another user's rows. Never queues a trade.
// Phase 1 — Live-Position Truth contract. `trades` returns ONLY verified live
// positions (broker ticket + symbol + side + volume + entry + current price +
// P/L + account source + fresh timestamp + confirmed attribution). Every
// non-broker-confirmed or not-yet-verifiable row is moved into the separate
// `unsyncedOrIncomplete` bucket WITHOUT a side or any advice field, carrying its
// category, badge, missingFields, and a human cannotVerifyReason. This is the
// chokepoint that stops Ruby/Eleanor from ever calling an unverified row a
// buy/sell or giving hold/close advice on data the broker never confirmed.
export async function getMyLiveOpenTrades(userId: number) {
  const { getEnvelope } = await import("../adminTrading/safetyEnvelope.js");
  const env = await getEnvelope(userId);
  const { livePositionsTable, sharedTradeAttributionTable } = await import("@workspace/db/schema");
  const now = Date.now();

  type VerifiedTrade = {
    id: string; source: string; symbol: string; side: string; lotSize: number;
    entryPrice: number | null; unrealizedPnl: number | null; pnlIsEstimate: boolean;
    waitingForSync: boolean; ticket: number | null;
  };
  type UnsyncedRow = {
    id: string; source: string; symbol: string;
    category: PositionTruthVerdict["category"]; badge: PositionTruthVerdict["badge"];
    countsTowardExposure: boolean; missingFields: string[]; cannotVerifyReason: string;
  };
  const trades: VerifiedTrade[] = [];
  const unsyncedOrIncomplete: UnsyncedRow[] = [];

  if (env.accountRoutingMode === "USER_OWNED_MT5") {
    const snapshotReliable = await getUserSnapshotReliable(userId, now);
    const rows = await db.select().from(livePositionsTable)
      .where(and(eq(livePositionsTable.userId, userId), eq(livePositionsTable.status, "OPEN")));
    for (const r of rows) {
      const verdict = classifyLivePosition(r, { snapshotReliable, now });
      if (verdict.isVerifiedLive) {
        trades.push({
          id: `lp_${r.id}`, source: "user_owned_mt5",
          symbol: r.symbol, side: r.direction, lotSize: r.lotSize,
          entryPrice: r.entryPrice ?? null,
          unrealizedPnl: r.unrealizedProfitLoss ?? null,
          pnlIsEstimate: false,
          waitingForSync: r.unrealizedProfitLoss == null || r.currentPrice == null,
          ticket: r.brokerPositionId ? Number(r.brokerPositionId) : null,
        });
      } else {
        unsyncedOrIncomplete.push({
          id: `lp_${r.id}`, source: "user_owned_mt5", symbol: r.symbol,
          category: verdict.category, badge: verdict.badge,
          countsTowardExposure: verdict.countsTowardExposure,
          missingFields: verdict.missingFields, cannotVerifyReason: verdict.reason,
        });
      }
    }
  } else {
    const rows = await db.select().from(sharedTradeAttributionTable)
      .where(and(eq(sharedTradeAttributionTable.userId, userId), eq(sharedTradeAttributionTable.status, "open")));
    for (const r of rows) {
      const verdict = classifyAttribution(r, { now });
      if (verdict.isVerifiedLive) {
        trades.push({
          id: `att_${r.id}`, source: "shared_master_attribution",
          symbol: r.symbol, side: r.side, lotSize: r.lotSize,
          entryPrice: r.entryPrice ?? null,
          unrealizedPnl: r.pnl ?? null,
          pnlIsEstimate: true,
          waitingForSync: r.pnl == null,
          ticket: r.mt5PositionTicket ? Number(r.mt5PositionTicket) : null,
        });
      } else {
        unsyncedOrIncomplete.push({
          id: `att_${r.id}`, source: "shared_master_attribution", symbol: r.symbol,
          category: verdict.category, badge: verdict.badge,
          countsTowardExposure: verdict.countsTowardExposure,
          missingFields: verdict.missingFields, cannotVerifyReason: verdict.reason,
        });
      }
    }
  }
  return {
    connected: true,
    routingMode: env.accountRoutingMode,
    accountType: env.accountType,
    tradingMode: env.tradingMode,
    count: trades.length,
    trades,
    // Diagnostic/repair visibility only — NEVER counted as active trades, never
    // included in P/L / exposure / risk totals, never advised on.
    unsyncedOrIncomplete,
    unsyncedCount: unsyncedOrIncomplete.length,
  };
}

// prepareCloseTicket — validates that a trade exists and is closable. Does
// NOT queue anything; the user must click Close in the UI to confirm.
export async function prepareCloseTicket(userId: number, args: { tradeId: string }) {
  const open = await getMyLiveOpenTrades(userId);
  const found = open.trades.find((t) => t.id === args.tradeId);
  if (!found) return { ok: false, reason: "TRADE_NOT_FOUND",};
  return {
    ok: true,
    action: "close",
    trade: found,
    requiresUserConfirmation: true,
    requiresLiveAck: open.accountType === "live" || open.tradingMode === "LIVE",
    nextStep: "User must click Confirm Close in the UI; the assistant cannot close trades directly.",
  };
}

// prepareOpenTicket — previews how a hypothetical order would route. Calls
// the routing resolver but does NOT call placeOrder.
export async function prepareOpenTicket(userId: number, args: {
  symbol: string; side: "BUY" | "SELL"; lotSize: number; mode: "SIMULATED" | "DEMO" | "LIVE";
}) {
  const { resolveRouting } = await import("../adminTrading/routingResolver.js");
  const routing = await resolveRouting({ userId, mode: args.mode });
  return {
    ok: true,
    preview: {
      symbol: args.symbol, side: args.side, lotSize: args.lotSize, mode: args.mode,
      wouldRouteTo: routing.effectiveRoutingMode ?? null,
      routedConnectionType: routing.connectionType ?? null,
      blockReason: routing.blockReason ?? null,
    },
    requiresUserConfirmation: true,
    requiresLiveAck: args.mode === "LIVE",
    nextStep: "User must click Submit Order in the Quick Trade modal. The assistant never places orders silently.",
  };
}

// ── Phase UX2 — Live trade intelligence tools (read-only) ────────────────
// These delegate to the same compute/persist pipeline the REST endpoint
// uses, so the assistant sees exactly what the UI sees. Never closes
// trades — only previews.
async function resolveAndComputeForUser(userId: number, tradeKey: string) {
  const { resolveRouting: _r } = await import("../adminTrading/routingResolver.js");
  void _r;
  const { db } = await import("@workspace/db");
  const { livePositionsTable, sharedTradeAttributionTable, sharedMasterAccountsTable } = await import("@workspace/db/schema");
  const { and: a2, eq: e2 } = await import("drizzle-orm");
  let trade: {
    tradeKey: string; routingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
    symbol: string; side: "BUY" | "SELL";
    entryPrice: number | null; currentPrice: number | null;
    stopLoss: number | null; takeProfit: number | null;
    unrealizedPnl: number | null; lotSize: number;
    openedAt: Date | null; brokerLabelMasked: string | null; pnlIsEstimate: boolean;
  } | null = null;
  // Phase 1 — the row's truth verdict, classified from the RAW row, travels with
  // the result so every advice tool can withhold direction/label/recommendation
  // on a row the broker never verified.
  let truth: PositionTruthVerdict | null = null;
  const nowMs = Date.now();
  if (tradeKey.startsWith("lp_")) {
    const id = Number(tradeKey.slice(3));
    if (Number.isFinite(id) && id > 0) {
      const [r] = await db.select().from(livePositionsTable)
        .where(a2(e2(livePositionsTable.id, id), e2(livePositionsTable.userId, userId))).limit(1);
      if (r) {
        const snapshotReliable = await getUserSnapshotReliable(userId, nowMs);
        truth = classifyLivePosition(r, { snapshotReliable, now: nowMs });
        trade = {
          tradeKey, routingMode: "USER_OWNED_MT5", symbol: r.symbol,
          side: r.direction as "BUY" | "SELL", entryPrice: r.entryPrice ?? null,
          currentPrice: r.currentPrice ?? null, stopLoss: r.stopLoss ?? null,
          takeProfit: r.takeProfit ?? null, unrealizedPnl: r.unrealizedProfitLoss ?? null,
          lotSize: r.lotSize, openedAt: r.openedAt ?? r.createdAt ?? null,
          brokerLabelMasked: null, pnlIsEstimate: false,
        };
      }
    }
  } else if (tradeKey.startsWith("att_")) {
    const id = Number(tradeKey.slice(4));
    if (Number.isFinite(id) && id > 0) {
      const [r] = await db.select().from(sharedTradeAttributionTable)
        .where(a2(e2(sharedTradeAttributionTable.id, id), e2(sharedTradeAttributionTable.userId, userId))).limit(1);
      if (r) {
        truth = classifyAttribution(r, { now: nowMs });
        const [sm] = await db.select({
          broker: sharedMasterAccountsTable.brokerName,
          masked: sharedMasterAccountsTable.accountNumberMasked,
        }).from(sharedMasterAccountsTable)
          .where(e2(sharedMasterAccountsTable.id, r.sharedMasterAccountId)).limit(1);
        trade = {
          tradeKey, routingMode: "SHARED_MASTER_MT5", symbol: r.symbol,
          side: r.side as "BUY" | "SELL", entryPrice: r.entryPrice ?? null,
          currentPrice: null, stopLoss: r.stopLoss ?? null, takeProfit: r.takeProfit ?? null,
          unrealizedPnl: r.pnl ?? null, lotSize: r.lotSize,
          openedAt: r.openedAt ?? r.createdAt ?? null,
          brokerLabelMasked: sm ? `${sm.broker ?? "Master"} ${sm.masked ?? ""}`.trim() : null,
          pnlIsEstimate: true,
        };
      }
    }
  }
  if (!trade || !truth) return null;
  const { getEnvelope } = await import("../adminTrading/safetyEnvelope.js");
  const env = await getEnvelope(userId);
  const { getRunning, nextRunning } = await import("../intelligence/mfeTracker.js");
  const { computeTradeIntelligence } = await import("../intelligence/scoring.js");
  const running = await getRunning(userId, trade.tradeKey);
  const updated = nextRunning(running, {
    side: trade.side, entryPrice: trade.entryPrice,
    currentPrice: trade.currentPrice, unrealizedPnl: trade.unrealizedPnl,
  });
  const ageMinutes = trade.openedAt
    ? Math.floor((Date.now() - trade.openedAt.getTime()) / 60_000) : null;
  const scoring = computeTradeIntelligence({
    side: trade.side, entryPrice: trade.entryPrice,
    currentPrice: trade.currentPrice, stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit, unrealizedPnl: trade.unrealizedPnl,
    mfe: updated.mfe, mae: updated.mae, peakPnl: updated.peakPnl,
    ageMinutes, symbol: trade.symbol,
  });
  return { trade, env, scoring, mfe: updated.mfe, mae: updated.mae, peakPnl: updated.peakPnl, truth };
}

// Phase 1 — shared withhold payload for an unverified row. The advice tools
// (intelligence, close-review, exit-plan) all return this instead of any
// direction/label/recommendation when the broker has not verified the row.
function withheldAdvicePayload(truth: PositionTruthVerdict, tradeKey: string) {
  return {
    ok: false as const,
    reason: "POSITION_NOT_VERIFIED" as const,
    tradeKey,
    truth: {
      category: truth.category,
      badge: truth.badge,
      brokerConfirmed: truth.brokerConfirmed,
      countsTowardExposure: truth.countsTowardExposure,
      missingFields: truth.missingFields,
      cannotVerifyReason: truth.reason,
    },
    adviceAllowed: false as const,
    // Task #816 — a withheld payload carries NO confirmed live read, so it must
    // still emit the honest feed signal (feedConfirmed:false + feedCaveat +
    // source/quality/freshness) rather than leaving those fields undefined. The
    // withhold reason stays POSITION_NOT_VERIFIED; this only guarantees no advice
    // tool ever hands Eleanor a blank feed shape.
    ...unavailableFeedStatusFields(),
    nextStep:
      "This position is not broker-verified, so the assistant cannot give a direction, label, or hold/close recommendation. Tell the user what is missing and direct them to re-sync MT5 / contact the operator. Never guess the side or outcome.",
  };
}

export async function getTradeIntelligenceTool(userId: number, tradeKey: string) {
  const r = await resolveAndComputeForUser(userId, tradeKey);
  if (!r) return { ok: false, reason: "TRADE_NOT_FOUND",};
  // Phase 1 — never emit a label/recommendedAction/direction for a row the
  // broker has not verified. Withhold all advice instead.
  if (!r.truth.isVerifiedLive) return withheldAdvicePayload(r.truth, tradeKey);
  return {
    ok: true,
    trade: {
      tradeKey: r.trade.tradeKey, routingMode: r.trade.routingMode,
      symbol: r.trade.symbol, side: r.trade.side, lotSize: r.trade.lotSize,
      entryPrice: r.trade.entryPrice, currentPrice: r.trade.currentPrice,
      stopLoss: r.trade.stopLoss, takeProfit: r.trade.takeProfit,
      unrealizedPnl: r.trade.unrealizedPnl, pnlIsEstimate: r.trade.pnlIsEstimate,
      brokerLabelMasked: r.trade.brokerLabelMasked,
    },
    intelligence: {
      label: r.scoring.label,
      recommendedAction: r.scoring.recommendedAction,
      explanation: r.scoring.explanation,
      scores: r.scoring.scores,
      derived: r.scoring.derived,
      mfe: r.mfe, mae: r.mae, peakPnl: r.peakPnl,
      dataQuality: r.scoring.dataQuality,
    },
    accountType: r.env.accountType,
    tradingMode: r.env.tradingMode,
    nextStep: "The assistant cannot close or modify this trade. Direct the user to Review Close in the UI.",
  };
}

export async function getTradeExitAlertsTool(userId: number, limit = 25) {
  const { db } = await import("@workspace/db");
  const { tradeExitAlertsTable } = await import("@workspace/db/schema");
  const { eq: e2, desc: d2 } = await import("drizzle-orm");
  const rows = await db.select().from(tradeExitAlertsTable)
    .where(e2(tradeExitAlertsTable.userId, userId))
    .orderBy(d2(tradeExitAlertsTable.createdAt)).limit(Math.min(100, Math.max(1, limit)));
  return { ok: true, count: rows.length, alerts: rows,};
}

export async function prepareCloseReviewTool(userId: number, tradeKey: string) {
  const r = await resolveAndComputeForUser(userId, tradeKey);
  if (!r) return { ok: false, reason: "TRADE_NOT_FOUND",};
  // Phase 1 — refuse to build a close review (label/recommendation) for an
  // unverified row; the assistant must not advise closing what isn't confirmed.
  if (!r.truth.isVerifiedLive) return withheldAdvicePayload(r.truth, tradeKey);
  return {
    ok: true,
    preview: {
      tradeKey: r.trade.tradeKey, symbol: r.trade.symbol, side: r.trade.side,
      lotSize: r.trade.lotSize, currentPnl: r.trade.unrealizedPnl,
      peakPnl: r.peakPnl, profitGivebackPercent: r.scoring.derived.profitGivebackPercent,
      accountType: r.env.accountType, routingMode: r.trade.routingMode,
      label: r.scoring.label, recommendedAction: r.scoring.recommendedAction,
      explanation: r.scoring.explanation,
    },
    warningIfLive: r.env.accountType === "live"
      ? "This will close a LIVE trade and may realize profit or loss."
      : null,
    requiresUserConfirmation: true,
    requiresLiveAck: r.env.accountType === "live" || r.env.tradingMode === "LIVE",
    nextStep: "User must click Confirm Close in the UI. The assistant never closes trades silently.",
  };
}

// ── Phase UX5 — Smart Exit Plan tool ─────────────────────────────────────
// Returns the freshly computed Smart Exit Plan for one of the caller's
// open trades. Read-only — never moves stops, never closes trades.
export async function getExitPlanTool(userId: number, tradeKey: string) {
  const r = await resolveAndComputeForUser(userId, tradeKey);
  if (!r) return { ok: false, reason: "TRADE_NOT_FOUND",};
  // Phase 1 — an exit plan is decision-support advice; withhold it entirely for
  // a row the broker has not verified.
  if (!r.truth.isVerifiedLive) return withheldAdvicePayload(r.truth, tradeKey);
  const { computeExitPlan } = await import("../intelligence/exitPlan.js");
  const { tradeAlertPreferencesTable } = await import("@workspace/db/schema");
  const [prefs] = await db.select().from(tradeAlertPreferencesTable)
    .where(eq(tradeAlertPreferencesTable.userId, userId)).limit(1);
  const ageMinutes = r.trade.openedAt
    ? Math.floor((Date.now() - new Date(r.trade.openedAt).getTime()) / 60_000) : null;
  const plan = computeExitPlan({
    symbol: r.trade.symbol, side: r.trade.side,
    entryPrice: r.trade.entryPrice, currentPrice: r.trade.currentPrice,
    stopLoss: r.trade.stopLoss, takeProfit: r.trade.takeProfit,
    unrealizedPnl: r.trade.unrealizedPnl, peakPnl: r.peakPnl,
    mae: r.scoring.scores.profitProtectionScore == null ? null : (r as unknown as { mae?: number | null }).mae ?? null,
    ageMinutes,
    prefs: {
      style: prefs?.style ?? "intraday",
      exitStyle: prefs?.exitStyle ?? "balanced",
      sensitivity: prefs?.sensitivity ?? "balanced",
      profitGivebackPercent: prefs?.profitGivebackPercent ?? 35,
      maxHoldTimeMinutes: prefs?.maxHoldTimeMinutes ?? 240,
      partialClosePreference: prefs?.partialClosePreference ?? "on",
      moveStopToBreakevenPref: prefs?.moveStopToBreakevenPref ?? "at_1r",
      trailStopPref: prefs?.trailStopPref ?? "after_1r",
    },
    scoring: r.scoring,
  });
  return {
    ok: true,
    trade: {
      tradeKey: r.trade.tradeKey, symbol: r.trade.symbol, side: r.trade.side,
      entryPrice: r.trade.entryPrice, currentPrice: r.trade.currentPrice,
      stopLoss: r.trade.stopLoss, takeProfit: r.trade.takeProfit,
      unrealizedPnl: r.trade.unrealizedPnl,
    },
    plan,
    ageMinutes,
    accountType: r.env.accountType,
    safety: {
      decisionSupportOnly: true,
      noProfitGuarantee: true,
      noAutoClose: true,
      noStopMove: true,
      requiresUserConfirmation: true,
    },
  };
}

// ── Phase UX3 — Sniper watchlist + timeline + exit-review tools ──────────
export async function getSniperWatchlistTool(userId: number) {
  const { livePositionsTable, sharedTradeAttributionTable } = await import("@workspace/db/schema");
  const { getEnvelope } = await import("../adminTrading/safetyEnvelope.js");
  const env = await getEnvelope(userId);
  // Re-build keys here (cannot call the route handler directly).
  const keys: string[] = [];
  if (env.accountRoutingMode === "USER_OWNED_MT5") {
    const rows = await db.select({ id: livePositionsTable.id }).from(livePositionsTable)
      .where(and(eq(livePositionsTable.userId, userId), eq(livePositionsTable.status, "OPEN")));
    for (const r of rows) keys.push(`lp_${r.id}`);
  } else {
    const rows = await db.select({ id: sharedTradeAttributionTable.id }).from(sharedTradeAttributionTable)
      .where(and(eq(sharedTradeAttributionTable.userId, userId), eq(sharedTradeAttributionTable.status, "open")));
    for (const r of rows) keys.push(`att_${r.id}`);
  }
  const items: Array<Record<string, unknown>> = [];
  for (const k of keys) {
    const r = await resolveAndComputeForUser(userId, k);
    if (!r) continue;
    // Phase 1 — never surface a watchlist alert (which carries side + advice)
    // for a row the broker has not verified.
    if (!r.truth.isVerifiedLive) continue;
    const s = r.scoring.scores;
    const reasons: string[] = [];
    const pnl = r.trade.unrealizedPnl ?? 0;
    const peak = r.peakPnl ?? 0;
    const giveback = r.scoring.derived.profitGivebackPercent ?? 0;
    if (giveback >= 30 && pnl > 0) reasons.push(`profit fading (${giveback}% giveback)`);
    if ((s.closeUrgencyScore ?? 0) >= 60) reasons.push(`close urgency ${s.closeUrgencyScore}`);
    if ((s.reversalRiskScore ?? 0) >= 60) reasons.push(`reversal risk ${s.reversalRiskScore}`);
    if ((s.fakeoutRiskScore ?? 0) >= 60) reasons.push(`fakeout risk ${s.fakeoutRiskScore}`);
    if ((s.volatilityRiskScore ?? 0) >= 70) reasons.push(`high volatility ${s.volatilityRiskScore}`);
    if (peak > 0 && pnl <= 0) reasons.push("returned to break-even or worse");
    if (reasons.length === 0) continue;
    const urg = s.closeUrgencyScore ?? 0;
    items.push({
      tradeKey: k, symbol: r.trade.symbol, side: r.trade.side, lotSize: r.trade.lotSize,
      unrealizedPnl: r.trade.unrealizedPnl, peakPnl: r.peakPnl,
      profitGivebackPercent: r.scoring.derived.profitGivebackPercent,
      closeUrgencyScore: s.closeUrgencyScore, reversalRiskScore: s.reversalRiskScore,
      fakeoutRiskScore: s.fakeoutRiskScore, label: r.scoring.label,
      recommendedAction: r.scoring.recommendedAction, reasons,
      urgencyTier: urg >= 85 ? "urgent" : urg >= 65 ? "warning" : urg >= 40 ? "watch" : "info",
    });
  }
  items.sort((a, b) => (Number(b.closeUrgencyScore ?? 0)) - (Number(a.closeUrgencyScore ?? 0)));
  return { ok: true, count: items.length, items,};
}

export async function getTradeTimelineTool(userId: number, tradeKey: string) {
  const { tradeDecisionTimelineTable } = await import("@workspace/db/schema");
  const { desc: d3, eq: e3, and: a3 } = await import("drizzle-orm");
  const rows = await db.select().from(tradeDecisionTimelineTable)
    .where(a3(e3(tradeDecisionTimelineTable.userId, userId), e3(tradeDecisionTimelineTable.tradeKey, tradeKey)))
    .orderBy(d3(tradeDecisionTimelineTable.createdAt)).limit(100);
  return { ok: true, count: rows.length, timeline: rows,};
}

export async function getRecentExitReviewsTool(userId: number, limit: number) {
  const { tradeExitReviewsTable } = await import("@workspace/db/schema");
  const { desc: d4, eq: e4 } = await import("drizzle-orm");
  const rows = await db.select().from(tradeExitReviewsTable)
    .where(e4(tradeExitReviewsTable.userId, userId))
    .orderBy(d4(tradeExitReviewsTable.createdAt))
    .limit(Math.min(50, Math.max(1, limit)));
  return { ok: true, count: rows.length, reviews: rows,};
}

async function getReconciliationCenterSummaryTool(userId: number): Promise<unknown> {
  // Admin/Owner gate — look up role via users table (the assistant doesn't have req.authUser).
  const [u] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    return { ok: false, error: "ADMIN_REQUIRED",};
  }
  const agg = await aggregateReconciliationIssues();
  // Write per-call audit for Ruby admin explanations.
  try {
    await db.insert(adminActionAuditLogTable).values({
      adminId: userId, adminRole: role, action: "RECONCILIATION_RUBY_ADMIN_EXPLAINED",
      targetUserId: null, beforeState: {}, afterState: { total: agg.total }, reason: null, ipAddress: null,
    });
  } catch { /* non-fatal for read-only summary */ }
  // Strip metadata to defense-in-depth against secret-shaped leaks (none expected).
  const issues = agg.issues.map((i) => ({
    id: i.id, type: i.type, severity: i.severity, userId: i.userId,
    bridgeConnectionId: i.bridgeConnectionId, commandId: i.commandId,
    brokerTicket: i.brokerTicket, symbol: i.symbol, status: i.status,
    reason: i.reason, recommendedAction: i.recommendedAction,
  }));
  return { ok: true, total: agg.total, countsByType: agg.countsByType, countsBySeverity: agg.countsBySeverity, issues,};
}

async function explainMyReconciliationIssueTool(issueType: string | null): Promise<unknown> {
  // Per-user-safe: returns a generic explanation. Does NOT query other-user data
  // and does NOT include admin diagnostics, command IDs, bridge IDs, or secrets.
  const t = String(issueType ?? "").toUpperCase();
  const generic: Record<string, string> = {
    MISSING_ATTRIBUTION: "Your trade is waiting for reconciliation because the broker position has not yet been linked to your ARX trade record.",
    STALE_HEARTBEAT: "Your MT5 bridge hasn't sent a recent heartbeat. Restart your EA or check the terminal.",
    BLOCKED_REJECTED_COMMAND: "Your command was blocked or rejected. Open Trade Logs for the rejection reason and contact support if you need help.",
    COMMAND_RESULT_MISMATCH: "Your command was sent to MT5 but no broker result has arrived. Support will reconcile this for you.",
  };
  const explanation = generic[t] ?? "If a trade looks out of sync, reconciliation is the process where ARX double-checks with the broker. Support will handle it.";
  try {
    await db.insert(adminActionAuditLogTable).values({
      adminId: null, adminRole: "USER", action: "RECONCILIATION_RUBY_USER_EXPLAINED",
      targetUserId: null, beforeState: {}, afterState: { issueType: t || null }, reason: null, ipAddress: null,
    });
  } catch { /* non-fatal */ }
  return { ok: true, explanation, readOnly: true,};
}

export async function dispatchTool(name: string, args: Record<string, unknown>, userId: number, reqKey?: object, envelope?: SafetyEnvelope): Promise<unknown> {
  // Derive the per-user safety envelope ONCE at the boundary. Honest both ways:
  // when the live path is open Ruby reports it; when locked it reports the real
  // top blocker. Advisory/reporting only — authorizes nothing.
  const env = envelope ?? await deriveAssistantEnvelope(userId);
  const result = await dispatchToolInner(name, args, userId, env, reqKey);
  // Every plain-object tool result carries the derived envelope. Result fields
  // win (spread last) so a tool that intentionally sets an advisory flag still
  // overrides; we only fill the envelope keys the tool itself omitted. Arrays /
  // primitives pass through untouched (they never carried an envelope).
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...assistantEnvelopeFields(env), ...(result as Record<string, unknown>) };
  }
  return result;
}

async function dispatchToolInner(name: string, args: Record<string, unknown>, userId: number, env: SafetyEnvelope, reqKey?: object): Promise<unknown> {
  switch (name) {
    case "getCurrentPageContext": return getCurrentPageContextTool(reqKey ?? {});
    case "getPaperSafetyStatus": return getPaperSafetyStatusTool(env, await getAssistantDisplayName(userId));
    case "getMarketDataProviderStatus": return getMarketDataProviderStatusTool();
    case "getPropFirmModeStatus": return getPropFirmModeStatus(userId);
    case "getCurrentUserContext": return getCurrentUserContext(userId);
    case "getTeamReportSummary": return getTeamReportSummary();
    case "getMyAccountShell": return computeAccountShell(userId);
    case "getReconciliationCenterSummary": return getReconciliationCenterSummaryTool(userId);
    case "explainMyReconciliationIssue": return explainMyReconciliationIssueTool(typeof args.issueType === "string" ? args.issueType : null);
    case "getAppFeatureMap": return getAppFeatureMapTool();
    case "getMT5BridgeStatus": return getMT5BridgeStatus(userId);
    case "getMT5Heartbeat": return getMT5Heartbeat(userId);
    case "getAccountSnapshot": return getAccountSnapshot(userId);
    case "getOpenPositions": return getOpenPositions(userId);
    case "getTradeJournalSummary": return getTradeJournalSummary(userId, Number(args.lookbackDays ?? 30));
    case "getDailyPnLCalendar": return getDailyPnLCalendar(userId, Number(args.days ?? 30));
    case "getMyPerformanceSummary": return getMyPerformanceSummary(userId, Number(args.lookbackDays ?? 30));
    case "getRiskLimits": return getRiskLimits(userId);
    case "getOpenExposure": return getOpenExposure(userId);
    case "getRiskUtilization": return getRiskUtilization(userId);
    case "getReconciliationStatus": return getReconciliationStatus(userId);
    case "runPreTradeRiskCheck": return runPreTradeRiskCheck(userId, args as Parameters<typeof runPreTradeRiskCheck>[1]);
    case "getMarketSnapshot": return getMarketSnapshot(String(args.symbol ?? ""));
    case "getEconomicCalendar": return getEconomicCalendar();
    case "getRecentMarketNews": return getRecentMarketNews(String(args.query ?? ""), Number(args.limit ?? 5));
    case "getCurrentEvents": return getCurrentEvents(Number(args.limit ?? 10));
    case "explainFeature": return explainFeatureTool(String(args.routeOrFeatureName ?? ""));
    case "createSupportDiagnosticReport": return createSupportDiagnosticReport(userId);
    case "evaluatePaperTradePlan": return evaluatePaperTradePlan(userId, args as Parameters<typeof evaluatePaperTradePlan>[1]);
    case "getTradingStyleProfile": return getTradingStyleProfile(userId);
    case "getRecentNotifications": return getRecentNotifications(userId, args as Parameters<typeof getRecentNotifications>[1]);
    case "getAssistantLiveAwarenessStatus": return getAssistantLiveAwarenessStatus(userId);
    case "getAppFeatureRegistry": return getAppFeatureRegistryTool();
    case "getFeatureHelp": return getFeatureHelpTool(String(args.idOrName ?? args.featureId ?? args.featureName ?? ""));
    case "getCurrentPageHelp": return getCurrentPageHelpTool(reqKey ?? {}, typeof args.pathname === "string" ? args.pathname : undefined);
    case "getAssistantCapabilityStatus": return getAssistantCapabilityStatus(userId);
    case "getMarketScannerOpportunities": return getMarketScannerOpportunities({ limit: typeof args.limit === "number" ? args.limit : undefined });
    case "getHistoricalContext": {
      const { getHistoricalAnalysis } = await import("../marketData/historicalAnalysis.js");
      try {
        const r = await getHistoricalAnalysis({
          symbol: String(args.symbol ?? ""),
          timeframe: typeof args.timeframe === "string" ? args.timeframe : "1d",
        });
        return {
          symbol: r.symbol,
          timeframe: r.timeframe,
          bias: r.bias,
          setupSummary: r.setupSummary,
          windows: r.windows.map((w) => ({
            label: w.label,
            available: w.available,
            direction: w.direction,
            changePct: w.changePct,
            unavailableReason: w.unavailableReason,
          })),
          dataQuality: r.dataQuality,
          safetyNote:
            r.bias.label === "INSUFFICIENT_DATA"
              ? "Historical data is unavailable for this symbol/timeframe. Do not invent a bias."
              : "Decision support only — historical patterns are not a buy or sell signal.",
        };
      } catch {
        return {
          symbol: String(args.symbol ?? ""),
          timeframe: typeof args.timeframe === "string" ? args.timeframe : "1d",
          bias: { label: "INSUFFICIENT_DATA", confidence: "LOW", sampleSize: 0, explanation: "Historical data is temporarily unavailable.", bullishCount: 0, bearishCount: 0, flatCount: 0 },
          setupSummary: { sampleSize: 0, winRate: null, avgMovePct: null, worstDrawdownPct: null, bestMovePct: null, avgTimeToNextCandleMs: null, confidence: "LOW", explanation: "Historical data is temporarily unavailable." },
          windows: [],
          dataQuality: { candlesProvided: 0, oldestCandle: null, newestCandle: null, coverageWarnings: ["Provider error"] },
          safetyNote: "Historical data is temporarily unavailable. Do not invent a bias.",
        };
      }
    }
    case "getFinalTradeRead": {
      const { scanOnce, decorateOpportunitiesWithHistory, decorateOpportunitiesWithNewsRisk, computeFinalRead } = await import("../marketScanner.js");
      const sym = String(args.symbol ?? "").toUpperCase();
      const tf = typeof args.timeframe === "string" ? args.timeframe : "M15";
      try {
        const all = await scanOnce({ symbols: [sym], timeframes: [tf] });
        if (all.length === 0) {
          return {
            symbol: sym, timeframe: tf,
            finalRead: { label: "NO_TRADE", headline: "No clean read available.", reasons: ["Scanner produced no opportunity for this symbol/timeframe."], technicalScore: 0, historicalScore: null, newsRiskLevel: "none", conflict: false, confidence: "LOW" },
            safetyNote: "Read is honest: no scanner setup means no trade right now.",
          };
        }
        const withHistory = await decorateOpportunitiesWithHistory(all);
        const withNews = await decorateOpportunitiesWithNewsRisk(withHistory);
        const opp = withNews[0]!;
        const finalRead = computeFinalRead(opp);
        return {
          symbol: opp.symbol, timeframe: opp.timeframe,
          finalRead,
          technicalDirection: opp.recommendedAction,
          statusBadge: opp.statusBadge,
          historicalContext: opp.historicalContext ?? null,
          newsContext: opp.newsContext ?? null,
          safetyNote: finalRead.confidence === "LOW"
            ? "Confidence is LOW because news/history feeds are limited. Say so honestly. Do not force a buy/sell answer."
            : "Decision support only. You are allowed to recommend WAIT or NO_TRADE when appropriate.",
        };
      } catch {
        return {
          symbol: sym, timeframe: tf,
          finalRead: { label: "WAIT_FOR_CONFIRMATION", headline: "Read temporarily unavailable.", reasons: ["Scanner / news / history feeds errored — defaulting to wait."], technicalScore: 0, historicalScore: null, newsRiskLevel: "none", conflict: false, confidence: "LOW" },
          safetyNote: "Read temporarily unavailable. Do not invent a recommendation.",
        };
      }
    }
    case "getMarketNewsIntelligence": {
      const { getNewsIntelligence } = await import("../news/newsIntelligenceService.js");
      try {
        const pack = await getNewsIntelligence(String(args.symbol ?? ""));
        return {
          ...pack,
          safetyNote:
            !pack.dataSources.headlines.connected
              ? "News feed is unavailable right now. Do not invent headlines. Rely on chart/history/scanner data and say the feed is unavailable."
              : pack.safetyNote,
        };
      } catch {
        return {
          symbol: String(args.symbol ?? ""),
          generatedAt: new Date().toISOString(),
          riskLevel: "none",
          bias: "unclear",
          timing: "quiet",
          warningSummary: "News intelligence is temporarily unavailable.",
          recommendation: "watch",
          upcomingEvent: null,
          recentHeadlines: [],
          affectedCurrencies: [],
          dataSources: {
            headlines: { connected: false, provider: "error", count: 0 },
            calendar: { connected: false, provider: "error", note: "Calendar temporarily unavailable." },
            social: { connected: false, provider: "none", note: "Social feed not configured." },
          },
          safetyNote: "News feed is unavailable right now. Do not invent headlines or events.",
        };
      }
    }
    case "getTradingMode": {
      // Derived at the boundary; reuse it (no second getEnvelope round-trip).
      return { envelope: env };
    }
    case "requestDemoOrder": {
      const { placeOrder } = await import("../adminTrading/placeOrder.js");
      const r = await placeOrder({
        userId, mode: "DEMO",
        symbol: String(args.symbol ?? ""),
        side: (String(args.side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY"),
        lotSize: Number(args.lotSize ?? 0),
        stopLoss: typeof args.stopLoss === "number" ? args.stopLoss : null,
        takeProfit: typeof args.takeProfit === "number" ? args.takeProfit : null,
        requestedBy: "ai-assistant",
        confirmedByUser: true,
      });
      return { result: r,};
    }
    case "requestLiveOrder": {
      const { placeOrder } = await import("../adminTrading/placeOrder.js");
      const r = await placeOrder({
        userId, mode: "LIVE",
        symbol: String(args.symbol ?? ""),
        side: (String(args.side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY"),
        lotSize: Number(args.lotSize ?? 0),
        stopLoss: typeof args.stopLoss === "number" ? args.stopLoss : null,
        takeProfit: typeof args.takeProfit === "number" ? args.takeProfit : null,
        requestedBy: "ai-assistant",
        confirmedByUser: args.confirmedByUser === true,
      });
      return { result: r,};
    }
    case "getMyLiveOpenTrades": return getMyLiveOpenTrades(userId);
    case "getTradeIntelligence": return getTradeIntelligenceTool(userId, String(args.tradeKey ?? ""));
    case "getTradeExitAlerts": return getTradeExitAlertsTool(userId, Number(args.limit ?? 25));
    case "getSymbolMarketContext": return getSymbolMarketContextTool(String(args.symbol ?? ""));
    case "readChartStructure": return readChartStructureTool(
      String(args.symbol ?? ""),
      typeof args.timeframe === "string" ? args.timeframe : null,
      reqKey,
      undefined,
      userId,
    );
    case "getTradeMarketContext": return getTradeMarketContextTool(userId, String(args.tradeKey ?? ""));
    case "getTradeDecision": return getTradeDecisionTool(userId, String(args.tradeKey ?? ""));
    case "prepareCloseReview": return prepareCloseReviewTool(userId, String(args.tradeKey ?? ""));
    case "getSniperWatchlist": return getSniperWatchlistTool(userId);
    case "getTradeTimeline": return getTradeTimelineTool(userId, String(args.tradeKey ?? ""));
    case "getRecentExitReviews": return getRecentExitReviewsTool(userId, Number(args.limit ?? 10));
    case "getProtectiveCloseStatus": return getProtectiveCloseStatusTool(userId, args.tradeKey ? String(args.tradeKey) : null, Number(args.limit ?? 10));
    case "createTradeActionDraft": return createTradeActionDraftTool(userId, args);
    case "listMyPendingActions": return listMyPendingActionsTool(userId);
    case "getTradeActionStatus": return getTradeActionStatusTool(userId, Number(args.actionId ?? 0));
    case "explainActionRejection": return explainActionRejectionTool(userId, Number(args.actionId ?? 0));
    case "getActionExecutionResult": return getActionExecutionResultTool(userId, Number(args.actionId ?? 0));
    case "explainBrokerRejection": return explainBrokerRejectionTool(userId, Number(args.actionId ?? 0));
    case "getRecentExecutionResults": return getRecentExecutionResultsTool(userId, Number(args.limit ?? 10));
    case "getStuckCommandsForUser": return getStuckCommandsForUserTool(userId);
    case "getMyTradingReadiness": return getMyTradingReadinessTool(userId);
    case "getLaunchReadiness": return getMyTradingReadinessTool(userId);
    case "summarizeLaunchReadinessForAdmin": return summarizeLaunchReadinessForAdminTool(userId);
    case "explainReadinessBlockers": return explainReadinessBlockersTool(userId);
    case "listMyOnboardingSteps": return listMyOnboardingStepsTool(userId);
    case "getOnboardingProgress": return getOnboardingProgressTool(userId);
    case "getMyPlaybooks": return getMyPlaybooksTool(userId);
    case "evaluateTradeAgainstPlaybook": return evaluateTradeAgainstPlaybookTool(userId, Number(args.preTradeCheckId ?? 0));
    case "getBestAndWorstPlaybooks": return getBestAndWorstPlaybooksTool(userId, Number(args.minTrades ?? 3));
    case "getRecentPreTradeChecks": return getRecentPreTradeChecksTool(userId, Number(args.limit ?? 10));
    case "getExitPlan": return getExitPlanTool(userId, String(args.tradeKey ?? ""));
    case "prepareCloseTicket": return prepareCloseTicket(userId, { tradeId: String(args.tradeId ?? "") });
    case "prepareOpenTicket": return prepareOpenTicket(userId, {
      symbol: String(args.symbol ?? ""),
      side: (String(args.side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY"),
      lotSize: Number(args.lotSize ?? 0),
      mode: (args.mode === "LIVE" ? "LIVE" : args.mode === "DEMO" ? "DEMO" : "SIMULATED"),
    });
    case "getTopOpportunitiesForMe": return getTopOpportunitiesForMeTool(userId, Number(args.limit ?? 10));
    case "explainOpportunityRanking": return explainOpportunityRankingTool(userId, Number(args.limit ?? 5));
    case "explainOrderType": return explainOrderTypeTool(String(args.orderType ?? ""));
    case "analyzeTradeTicket": return analyzeTradeTicketTool(args as Parameters<typeof analyzeTradeTicketTool>[0]);
    case "getMyPendingOrderDrafts": return getMyPendingOrderDraftsTool(userId);
    case "getBridgeCapabilities": return getBridgeCapabilitiesTool(userId, env);
    default: return { error: "unknown_tool", name };
  }
}

// Intent classifier (cheap heuristic). The LLM ALSO routes via tool calls,
// this is just for telemetry and quick suggestions.
export function classifyIntent(text: string): string {
  const s = text.toLowerCase();
  if (/(mt5|metatrader|bridge|ea|expert advisor|heartbeat)/.test(s)) return "mt5_bridge";
  if (/(risk|drawdown|loss cap|cooldown|governor)/.test(s)) return "risk_management";
  if (/(news|headline|economic|calendar|cpi|nfp)/.test(s)) return "market_news";
  if (/(strategy|setup|bias|trend|liquidity|sweep|bos)/.test(s)) return "trading_strategy";
  if (/(journal|review|debrief|mistake|past trade)/.test(s)) return "trade_journal";
  if (/(notification|alert|warning|did anything happen|any reminders|any updates|any messages)/.test(s)) return "user_notifications";
  if (/(prop|challenge|funded|payout|ftmo|myff)/.test(s)) return "prop_firm_mode";
  if (/(account|balance|equity|win rate|p&l|pnl|open trades)/.test(s)) return "account_status";
  if (/(buy|sell|enter|close|execute|place|order|size)/.test(s)) return "execution_request";
  if (/(how|where|what is|find|page|menu|navigate)/.test(s)) return "app_support";
  return "general_question";
}

// Deterministic chart-read routing (Task #602 follow-up). The pure helpers live
// in chartReadRouting.ts (no DB imports) so the routing test stays offline; they
// are re-exported here because the chat handler imports from this tool barrel.
export {
  detectChartReadIntent,
  detectTradeOptionsIntent,
  resolveAssistantToolChoice,
} from "./chartReadRouting.js";
export type { AssistantToolChoice } from "./chartReadRouting.js";


// ── Readiness AI Tools (per-user, read-only). Wired in the Last-30-Command
// Audit pass — descriptors were referenced in the onboarding test but never
// registered on dispatchTool. Source of truth is the same engine the API and
// admin dashboard use; this code never claims live trading is unlocked.
// `ready_for_live` is REPORTING ONLY (no execution path reads it) and is scoped
// inside the engine to admin-approved, armed, eligible traders only.
// ADMIN/OWNER only summary of the ARX Operator Command Center. Read-only.
// Re-uses the same aggregator endpoint logic via direct helper imports; never
// echoes raw tokens/hashes/env values/IPs/account numbers. Refuses for
// non-admin callers.
export async function summarizeLaunchReadinessForAdminTool(userId: number) {
  try {
    const { usersTable } = await import("@workspace/db");
    const u = await db.select({ role: usersTable.role })
      .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const role = u[0]?.role;
    if (role !== "ADMIN" && role !== "OWNER") {
      return { ok: false, error: "ADMIN_REQUIRED",};
    }
    const [{ detectCurrentConnectedBridge }, { aggregateReconciliationIssues },
           { getGlobalSettings }, schema] = await Promise.all([
      import("../mt5/currentConnectedBridgeDetector.js"),
      import("../reconciliation/detect.js"),
      import("../adminTrading/safetyEnvelope.js"),
      import("@workspace/db"),
    ]);
    const masterSwitch = isLiveBrokerExecutionEnabledEnv();
    const det = await detectCurrentConnectedBridge();
    const settings = await getGlobalSettings();
    const sharedLive = !!(settings as { sharedLiveTradingEnabled?: boolean }).sharedLiveTradingEnabled;
    const platformMode = (settings as { platformMode?: string }).platformMode ?? "OFF";
    // schema field is `emergencyKillSwitch` (default TRUE = engaged).
    const killEngaged = !!(settings as { emergencyKillSwitch?: boolean }).emergencyKillSwitch;

    const [queueRows, openLiveRows, recon, approvalRows] = await Promise.all([
      db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.mt5CommandsTable)
        .where(sql`${schema.mt5CommandsTable.status} IN ('PENDING','SENT_TO_MT5','SENT_TO_MT5_DEMO','DEMO_APPROVED')`),
      db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.arxLiveCommandsTable)
        .where(sql`${schema.arxLiveCommandsTable.status} NOT IN ('FILLED','REJECTED','CANCELLED','LIVE_BLOCKED')`),
      aggregateReconciliationIssues(),
      db.select({
        approved: schema.userMasterLiveAccessTable.approvedForMasterLive,
        status: schema.userMasterLiveAccessTable.masterLiveStatus,
        disclosure: schema.userMasterLiveAccessTable.riskDisclosureAcceptedAt,
      }).from(schema.userMasterLiveAccessTable),
    ]);

    const userApprovals = {
      total: approvalRows.length,
      approvedForMasterLive: approvalRows.filter(r => r.approved).length,
      pendingReview: approvalRows.filter(r => r.status === "PENDING_REVIEW").length,
      withDisclosureAccepted: approvalRows.filter(r => !!r.disclosure).length,
    };

    const blockers: string[] = [];
    if (!masterSwitch) blockers.push("ARX_LIVE_BROKER_EXECUTION_ENABLED=false (server master switch off)");
    if (killEngaged) blockers.push("GLOBAL_KILL_SWITCH_ENGAGED");
    if (!det.ok) blockers.push(`NO_CURRENT_LIVE_BRIDGE:${det.primaryReason}`);
    if ((openLiveRows[0]?.n ?? 0) > 0) blockers.push(`OPEN_LIVE_COMMANDS_NONTERMINAL=${openLiveRows[0]?.n}`);
    if ((recon.countsBySeverity?.critical ?? 0) > 0) blockers.push(`RECONCILIATION_CRITICAL=${recon.countsBySeverity?.critical}`);

    const needsAction: string[] = [];
    if (!sharedLive && masterSwitch) needsAction.push("SHARED_LIVE_TRADING_DISABLED");
    if ((recon.countsBySeverity?.high ?? 0) > 0) needsAction.push(`RECONCILIATION_HIGH=${recon.countsBySeverity?.high}`);
    if (userApprovals.pendingReview > 0) needsAction.push(`PENDING_USER_REVIEWS=${userApprovals.pendingReview}`);

    const safeToManuallyTest = blockers.length === 0 && det.ok;

    return {
      ok: true,
      verdict: safeToManuallyTest ? "READY_FOR_MANUAL_LIVE_TEST" : (blockers.length > 0 ? "BLOCKED" : "NEEDS_ACTION"),
      blockers,
      needsAction,
      safeToManuallyTest,
      systemStatus: { platformMode, killSwitchEngaged: killEngaged, latestQaStatus: "ARX_AUDIT_FIX_BUILD_READY" },
      tradingMode: { liveBrokerExecutionEnabled: masterSwitch, sharedLiveTradingEnabled: sharedLive, currentBridgeDetected: !!det.ok },
      counts: {
        queueDepth: queueRows[0]?.n ?? 0,
        openLiveCommandsNonTerminal: openLiveRows[0]?.n ?? 0,
        reconciliationTotal: recon.total,
        reconciliationCritical: recon.countsBySeverity?.critical ?? 0,
        reconciliationHigh: recon.countsBySeverity?.high ?? 0,
      },
      userApprovals,
      doNotTouch: [
        "lib/safetyCore.ts", "lib/liveTrading/", "lib/live/", "lib/domain/src/safety-contracts/",
        "vault tables", "MT5 routes (mt5.ts, mt5Live.ts)", "strategyEngine.ts",
        "EA bridge token hashing", "ARX_LIVE_BROKER_EXECUTION_ENABLED env",
      ],
    };
  } catch (e) {
    return { ok: false, error: "operator_summary_failed", reason: (e as Error).message.slice(0, 200),};
  }
}

export async function getMyTradingReadinessTool(userId: number) {
  try {
    const { evaluateUserReadiness, getOrCreateReadinessState } = await import("../userReadiness/engine.js");
    await getOrCreateReadinessState(userId);
    const report = await evaluateUserReadiness(userId);
    return {
      ok: true,
      accountMode: report.accountMode,
      liveExecutionHardLockActive: report.liveExecutionHardLockActive,
      paperOnlyHardLockActive: report.paperOnlyHardLockActive,
      ready_for_paper: report.ready_for_paper,
      ready_for_demo: report.ready_for_demo,
      ready_for_live: report.ready_for_live,
      blockers: report.blockers,
      statuses: report.statuses.map(s => ({
        id: s.id, label: s.label, status: s.status, requiredFor: s.requiredFor,
        blockerReason: s.blockerReason, userFriendlyExplanation: s.userFriendlyExplanation,
        nextStep: s.nextStep,
      })),
      evaluatedAt: report.evaluatedAt,
    };
  } catch (e) {
    return { ok: false, error: "readiness_eval_failed", reason: (e as Error).message.slice(0, 200),};
  }
}

export async function explainReadinessBlockersTool(userId: number) {
  try {
    const { evaluateUserReadiness } = await import("../userReadiness/engine.js");
    const report = await evaluateUserReadiness(userId);
    const failing = report.statuses.filter(s => s.status === "fail" || s.status === "blocked");
    return {
      ok: true,
      hasBlockers: failing.length > 0,
      ready_for_paper: report.ready_for_paper,
      ready_for_demo: report.ready_for_demo,
      ready_for_live: report.ready_for_live,
      blockers: failing.map(s => ({
        id: s.id, label: s.label, status: s.status,
        why: s.blockerReason ?? s.userFriendlyExplanation,
        nextStep: s.nextStep,
      })),
    };
  } catch (e) {
    return { ok: false, error: "blockers_failed", reason: (e as Error).message.slice(0, 200),};
  }
}

export async function listMyOnboardingStepsTool(userId: number) {
  try {
    const { evaluateUserReadiness } = await import("../userReadiness/engine.js");
    const report = await evaluateUserReadiness(userId);
    // Group statuses into stages for an onboarding-style checklist
    const stageOf = (id: string): string => {
      if (id.includes("auth") || id.includes("profile")) return "profile";
      if (id.includes("risk_profile")) return "risk";
      if (id.includes("disclaim") || id.includes("disclosure")) return "disclosures";
      if (id.includes("account_mode")) return "account_mode";
      if (id.includes("mt5")) return "mt5";
      if (id.includes("paper") || id.includes("demo")) return "demo";
      if (id.includes("live") || id.includes("admin_live")) return "live";
      return "other";
    };
    const groups: Record<string, Array<{ id: string; label: string; status: string; nextStep: string | null }>> = {};
    for (const s of report.statuses) {
      const stage = stageOf(s.id);
      (groups[stage] ??= []).push({ id: s.id, label: s.label, status: s.status, nextStep: s.nextStep });
    }
    return {
      ok: true,
      accountMode: report.accountMode,
      stages: groups,
      totalSteps: report.statuses.length,
      completed: report.statuses.filter(s => s.status === "pass" || s.status === "not_required").length,
    };
  } catch (e) {
    return { ok: false, error: "steps_failed", reason: (e as Error).message.slice(0, 200),};
  }
}

export async function getOnboardingProgressTool(userId: number) {
  try {
    const { db } = await import("@workspace/db");
    const { userOnboardingProgressTable } = await import("@workspace/db/schema");
    const { eq } = await import("drizzle-orm");
    const { evaluateUserReadiness } = await import("../userReadiness/engine.js");
    const [onb] = await db.select().from(userOnboardingProgressTable)
      .where(eq(userOnboardingProgressTable.userId, userId)).limit(1);
    const report = await evaluateUserReadiness(userId);
    const total = report.statuses.length;
    const passed = report.statuses.filter(s => s.status === "pass" || s.status === "not_required").length;
    const percent = total > 0 ? Math.round((passed / total) * 100) : 0;
    const nextItem = report.statuses.find(s => s.status === "fail" || s.status === "blocked");
    return {
      ok: true,
      percent, passed, total,
      currentStage: nextItem?.id ?? "complete",
      nextStep: nextItem?.nextStep ?? null,
      onboardingStatus: onb?.status ?? "NOT_STARTED",
      completedSteps: onb?.completedSteps ?? [],
      walkthroughCompleted: onb?.walkthroughCompleted ?? false,
    };
  } catch (e) {
    return { ok: false, error: "progress_failed", reason: (e as Error).message.slice(0, 200),};
  }
}

// ── Phase UX6 — Market Context tools (read-only, provider-backed) ───────
export async function getSymbolMarketContextTool(symbol: string) {
  const s = (symbol ?? "").toString().trim();
  if (!s) return { ok: false, error: "missing_symbol", context: unavailableFeedContext(),};
  try {
    const { buildMarketContext } = await import("../marketContext/contextBuilder.js");
    const { classify } = await import("../marketContext/classifier.js");
    // includeSharedFeed: this is one of Ruby's broad surfaces, so it must report
    // the SAME source/quality/freshness the chart shows for this symbol. The
    // overlay sets ctx.source/ctx.freshness from the shared resolver and adds
    // ctx.sharedFeed. Multi-timeframe candle analysis below stays provider-based.
    const ctx = await buildMarketContext({ symbol: s, includeSharedFeed: true });
    const classification = classify(ctx);
    // Feed-confirmation mirrors the chart exactly: prefer the shared feed verdict
    // (AI-usable AND realtime) when present; fall back to the provider-candle
    // verdict only when the shared resolver errored. See FEED_NOT_CONFIRMED_CAVEAT.
    const feedConfirmed = ctx.sharedFeed
      ? ctx.sharedFeed.aiUsable && ctx.sharedFeed.freshness === "REALTIME"
      : ctx.dataQuality.quality === "good" && ctx.freshness === "REALTIME";
    const feedCaveat = feedConfirmed ? null : FEED_NOT_CONFIRMED_CAVEAT;
    return {
      ok: true, symbol: s,
      context: {
        source: ctx.source, asOf: ctx.asOf, freshness: ctx.freshness,
        session: ctx.session, currentPrice: ctx.currentPrice,
        bid: ctx.bid, ask: ctx.ask, spread: ctx.spread,
        dataQuality: ctx.dataQuality,
        // Shared chart-truth verdict (identical to the chart) — honest source/
        // quality/cause for this symbol; null when the resolver errored.
        sharedQuality: ctx.sharedFeed?.quality ?? null,
        sharedAiUsable: ctx.sharedFeed?.aiUsable ?? null,
        sharedCause: ctx.sharedFeed?.cause ?? null,
        feedConfirmed,
        feedCaveat,
      },
      classification: {
        label: classification.label,
        primaryTimeframe: classification.primaryTimeframe,
        htfTimeframe: classification.htfTimeframe,
        scores: classification.scores,
        explanation: classification.explanation,
        evidence: classification.evidence,
      },
    };
  } catch (e) {
    const reason = errReason(e);
    return { ok: false, error: "context_failed", reason, context: unavailableFeedContext(reason),};
  }
}

// ── readChartStructure (Task #602 follow-on) ────────────────────────────────
// THE chat entry point for "read / analyze / what do you see on <symbol>".
// Calls the SAME shared structural-read service the Scanner "Ruby Chart Read"
// panel uses (buildRubyStructuralRead), so chat and the panel never disagree.
// Honest on resolution: an off-universe / ambiguous / empty symbol returns a
// plain message and NO read — never a fabricated one. readLayer is DISPLAY-ONLY
// and authorizes nothing (no execution / gate involvement).
export async function readChartStructureTool(
  rawSymbol: string,
  timeframe: string | null | undefined,
  reqKey?: object,
  clientFeedUnconfirmed?: boolean,
  userId?: number | null,
) {
  const chartCtx = reqKey ? getRequestChartContext(reqKey) : null;
  // Symbol priority: the explicit symbol the user named > the symbol currently
  // on their chart (page context). Never guess beyond these two.
  const symbolInput = (typeof rawSymbol === "string" && rawSymbol.trim())
    ? rawSymbol.trim()
    : (chartCtx?.chartSymbol ?? "");
  const resolution = resolveAssistantMarket(symbolInput);
  if (resolution.status === "empty") {
    return {
      ok: false,
      error: "missing_symbol",
      message: "Tell me which market to read (for example V75, EURUSD, or gold).",
    };
  }
  if (resolution.status !== "resolved" || !resolution.downstreamSymbol) {
    // not_in_universe → the exact ARX-Focus locked reply; ambiguous → candidates.
    return {
      ok: false,
      error: resolution.status,
      candidates: resolution.candidates,
      message: resolution.userMessage ?? "That market isn't available to read right now.",
    };
  }
  // Timeframe priority: explicit arg > on-screen chart timeframe > default H1.
  // The shared service normalizes the value and returns an honest "unsupported
  // timeframe" read if it cannot be mapped to a canonical chart timeframe.
  const tf = (typeof timeframe === "string" && timeframe.trim())
    ? timeframe.trim()
    : (chartCtx?.chartTimeframe?.trim() || "H1");
  const outcome = await buildRubyStructuralRead({
    symbol: resolution.downstreamSymbol,
    timeframe: tf,
    draft: null,
    clientFeedUnconfirmed: clientFeedUnconfirmed === true,
    // Thread the authenticated user so the per-user pattern-learning loop
    // (Task #617 Gap C) runs on the CHAT read path too, exactly like the panel
    // (/me/assistant/read-chart). Null/absent ⇒ no observation, no nudge.
    userId: userId ?? null,
  });
  return {
    ok: true,
    symbol: resolution.downstreamSymbol,
    displaySymbol: resolution.market?.displayName ?? resolution.downstreamSymbol,
    timeframe: outcome.normalizedTimeframe ?? tf,
    readLayer: outcome.readLayer,
    chartRead: outcome.chartRead,
    feedUnconfirmed: outcome.feedUnconfirmed,
  };
}

export async function getTradeMarketContextTool(userId: number, tradeKey: string) {
  const k = (tradeKey ?? "").toString().trim();
  // Task #816 — getTradeMarketContext nests its feed signal under `context`, and
  // Eleanor is told to read context.feedConfirmed / context.feedCaveat, so EVERY
  // block / withheld / error branch must carry an honest `context` (never leave
  // it undefined, which is what made her market answers go silently blank).
  if (!k) return { ok: false, error: "missing_tradeKey", context: unavailableFeedContext(),};
  // Phase 1 — Live-Position Truth gate. Resolve the row's verdict from the SAME
  // single source every advice tool shares. A row the broker never verified
  // (unsynced / attributed-but-incomplete / scanner artefact) gets NO directional
  // context, scenario, or hold/close guidance — only the withheld payload. This
  // is block-only and never weakens a live gate.
  try {
    const truth = await classifyTradeKey(userId, k);
    if (!truth) return { ok: false, error: "trade_not_found_or_not_yours", context: unavailableFeedContext(),};
    // The shared withheld payload already carries the FLAT feed signal; add the
    // nested `context` too so this tool's success/withheld shapes stay identical.
    if (!truth.isVerifiedLive) return { ...withheldAdvicePayload(truth, k), context: unavailableFeedContext(truth.reason ?? null) };
    const { resolveUserTrade } = await import("../trades/resolveTrade.js");
    const trade = await resolveUserTrade(userId, k);
    if (!trade) return { ok: false, error: "trade_not_found_or_not_yours", context: unavailableFeedContext(),};
    const { buildMarketContext } = await import("../marketContext/contextBuilder.js");
    const { classify } = await import("../marketContext/classifier.js");
    const { computeKeyLevels } = await import("../marketContext/keyLevels.js");
    const { buildTradeContext } = await import("../marketContext/tradeContext.js");
    const ctx = await buildMarketContext({ symbol: trade.symbol });
    const classification = classify(ctx);
    const feedConfirmed =
      ctx.dataQuality.quality === "good" && ctx.freshness === "REALTIME";
    const feedCaveat = feedConfirmed ? null : FEED_NOT_CONFIRMED_CAVEAT;
    const keyLevels = computeKeyLevels({
      side: trade.side, entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
      stopLoss: trade.stopLoss, takeProfit: trade.takeProfit, ctx, classification,
    });
    const tradeCtx = buildTradeContext({
      side: trade.side, entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
      stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
      unrealizedPnl: trade.unrealizedPnl, peakPnl: null,
      ctx, classification, keyLevels,
    });
    return {
      ok: true,
      trade: {
        tradeKey: trade.tradeKey, symbol: trade.symbol, side: trade.side,
        entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
        stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
      },
      classification: {
        label: classification.label, scores: classification.scores,
        explanation: classification.explanation,
        primaryTimeframe: classification.primaryTimeframe,
        htfTimeframe: classification.htfTimeframe,
      },
      tradeContext: {
        trendAlignment: tradeCtx.trendAlignment,
        tradeLabel: tradeCtx.tradeLabel,
        bullishScenario: tradeCtx.bullishScenario,
        bearishScenario: tradeCtx.bearishScenario,
        exitHoldReview: tradeCtx.exitHoldReview,
        rationale: tradeCtx.rationale,
      },
      keyLevels,
      context: {
        source: ctx.source, asOf: ctx.asOf, freshness: ctx.freshness,
        session: ctx.session, dataQuality: ctx.dataQuality,
        // Feed-confirmation honesty (mirrors getSymbolMarketContext) — see
        // FEED_NOT_CONFIRMED_CAVEAT.
        feedConfirmed,
        feedCaveat,
      },
    };
  } catch (e) {
    // Task #816 — a runtime throw is also a "can't answer": return the honest
    // nested feed-status contract (mirrors getSymbolMarketContext's catch) so
    // Eleanor never receives an undefined feed signal on this surface.
    const reason = errReason(e);
    return { ok: false, error: "context_failed", reason, context: unavailableFeedContext(reason),};
  }
}

// ── Phase 22H: app-knowledge tools ───────────────────────────────────────
export function getAppFeatureRegistryTool() {
  return { ...featureRegistry(),};
}

export function getFeatureHelpTool(idOrName: string) {
  return { ...featureHelpLookup(idOrName), query: String(idOrName ?? ""),};
}

export function getCurrentPageHelpTool(reqKey: object, pathnameOverride?: string) {
  const ctx = PAGE_CONTEXT_REGISTRY.get(reqKey) ?? null;
  const pathname = (pathnameOverride && pathnameOverride.trim().length > 0)
    ? pathnameOverride.trim()
    : ctx?.pathname ?? null;
  const result = pageHelpLookup(pathname);
  return {
    ...result,
    label: ctx?.label ?? null,
    pageContextSource: pathnameOverride ? "argument" : (ctx ? "frontend" : "none"),
  };
}

// Capability rollup — what the assistant can do RIGHT NOW for this user.
// All booleans derive from real env/state checks. Never fabricates.
export async function getAssistantCapabilityStatus(userId: number) {
  type MarketShape = { connected?: boolean; configured?: boolean; provider?: string; stale?: boolean };
  type VoiceShape = { realtimeConfigured?: boolean; currentMode?: string; notes?: string };
  let market: MarketShape | null = null;
  try { market = getMarketStatus() as MarketShape; } catch { market = null; }
  let voice: VoiceShape | null = null;
  try { voice = getVoiceModeStatus() as VoiceShape; } catch { voice = null; }

  const aiProviderConfigured = Boolean(process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]);
  let bridgeConnected = false;
  try {
    const b = await getMT5BridgeStatus(userId);
    bridgeConnected = Boolean((b as { isConnected?: boolean }).isConnected);
  } catch { /* leave false */ }
  let riskConfigured = false;
  try {
    const r = await getRiskLimits(userId);
    riskConfigured = Boolean((r as { hasRiskSettings?: boolean }).hasRiskSettings);
  } catch { /* leave false */ }
  let journalHasTrades = false;
  try {
    const j = await getTradeJournalSummary(userId, 30);
    journalHasTrades = !((j as { isEmpty?: boolean }).isEmpty ?? true);
  } catch { /* leave false */ }

  const env = await deriveAssistantEnvelope(userId);
  const capabilities = {
    appHelp:        { available: true, reason: "Backed by canonical feature registry." },
    liveChat:       { available: aiProviderConfigured, reason: aiProviderConfigured ? "AI provider configured server-side." : "AI provider key not configured. Set AI_INTEGRATIONS_OPENAI_API_KEY (server only)." },
    toolCalling:    { available: aiProviderConfigured, reason: aiProviderConfigured ? "Tools dispatched server-side per turn." : "Requires AI provider." },
    marketAwareness:{ available: Boolean(market?.connected), reason: market?.connected ? `Provider: ${market.provider}.` : "No market data provider configured. Set one of POLYGON_API_KEY, FINNHUB_API_KEY, ALPHA_VANTAGE_API_KEY, NEWSAPI_API_KEY.", stale: Boolean(market?.stale) },
    bridgeAwareness:{ available: true, bridgeConnected, reason: bridgeConnected ? "MT5 bridge connection detected for this user." : "MT5 bridge not connected for this user. The assistant can still report status truthfully." },
    riskChecks:     { available: true, riskConfigured, reason: riskConfigured ? "User risk limits configured. Pre-trade risk check is advisory." : "User risk limits not configured. Pre-trade risk check will report risk_not_configured." },
    journalAnalysis:{ available: journalHasTrades, reason: journalHasTrades ? "User has closed trades to analyze." : "No closed trades yet for this user." },
    notifications:  { available: true, reason: "Per-user in-app notifications. Push requires VAPID keys." },
    voiceInput:     { available: true, mode: voice?.currentMode ?? "degraded_gpt_audio", reason: voice?.notes ?? "Voice input via gpt-audio multipart upload. Mic is popup-scoped only." },
    speechOutput:   { available: true, reason: "Browser SpeechSynthesis (TTS) on the client. Falls back to silent if unsupported." },
    realtimeMode:   { available: Boolean(voice?.realtimeConfigured), reason: voice?.realtimeConfigured ? "True WebRTC Realtime can be minted." : "True WebRTC Realtime requires a direct OPENAI_API_KEY (the Replit AI proxy does not support it). gpt-audio degraded mode is used instead." },
    orderExecution: { available: !env.liveLocked && env.allowOrderExecution, reason: liveExecutionAvailabilityNote(env, await getAssistantDisplayName(userId)) },
  };

  const unavailableCapabilities = Object.entries(capabilities)
    .filter(([, v]) => !(v as { available: boolean }).available)
    .map(([k]) => k);

  return {
    aiProvider: { configured: aiProviderConfigured, provider: aiProviderConfigured ? "openai" : "none" },
    capabilities,
    unavailableCapabilities,
    keysExposed: false as const,
  };
}

// ── Phase UX7 — Trade Decision Orchestrator tool (read-only) ───────────
// Returns the single central decision per open trade. Never executes
// anything. All suggestedButton values open a review modal first.
export async function getTradeDecisionTool(userId: number, tradeKey: string) {
  const k = (tradeKey ?? "").toString().trim();
  if (!k) return { ok: false, error: "missing_tradeKey",};
  // Phase 1 — Live-Position Truth gate. The central decision (hold/close/action)
  // is the strongest advice surface, so it is withheld outright on any row the
  // broker never verified. Same single-source verdict, block-only.
  const truth = await classifyTradeKey(userId, k);
  if (!truth) return { ok: false, error: "trade_not_found_or_not_yours",};
  if (!truth.isVerifiedLive) return withheldAdvicePayload(truth, k);
  const { resolveUserTrade } = await import("../trades/resolveTrade.js");
  const trade = await resolveUserTrade(userId, k);
  if (!trade) return { ok: false, error: "trade_not_found_or_not_yours",};
  const { buildTradeDecision, loadUserDecisionPrefs } = await import("../decision/orchestrator.js");
  try {
    const prefs = await loadUserDecisionPrefs(userId);
    const r = await buildTradeDecision({
      tradeKey: trade.tradeKey, routingMode: trade.routingMode,
      symbol: trade.symbol, side: trade.side,
      entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
      stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
      unrealizedPnl: trade.unrealizedPnl, lotSize: trade.lotSize,
      openedAt: trade.openedAt,
    }, prefs);
    return {
      ok: true,
      trade: {
        tradeKey: trade.tradeKey, symbol: trade.symbol, side: trade.side,
        entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
        stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
      },
      decision: {
        decisionLabel: r.decision.decisionLabel,
        decisionAction: r.decision.decisionAction,
        confidenceScore: r.decision.confidenceScore,
        urgencyScore: r.decision.urgencyScore,
        riskScore: r.decision.riskScore,
        reasonSummary: r.decision.reasonSummary,
        mainReason: r.decision.mainReason,
        supportingReasons: r.decision.supportingReasons,
        invalidationLevel: r.decision.invalidationLevel,
        protectProfitLevel: r.decision.protectProfitLevel,
        continuationLevel: r.decision.continuationLevel,
        suggestedButton: r.decision.suggestedButton,
        requiresConfirmation: r.decision.requiresConfirmation,
        whatWouldChange: r.decision.whatWouldChange,
        dataQuality: r.decision.dataQuality,
        // Phase 24 — Additive canonical decisionStatus. Maps the decision
        // engine's action into the canonical enum WITHOUT inferring
        // connectivity from data-quality flags (those are telemetry
        // completeness, not provider connectivity — inferring would
        // falsely trip SCANNER_OFFLINE). Connectivity is intentionally
        // omitted; data-insufficient is signalled via legacySection so
        // the mapper resolves to DATA_INSUFFICIENT honestly.
        decisionStatus: mapLegacyToDecisionStatus({
          legacySection: r.decision.decisionAction === "NO_ACTION_DATA_INSUFFICIENT"
            ? "dataInsufficient" : null,
        }),
      },
      classification: {
        label: r.classification.label,
        primaryTimeframe: r.classification.primaryTimeframe,
      },
      exitPlanLabel: r.exitPlan.efficiencyLabel,
    };
  } catch (e) {
    return { ok: false, error: "decision_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

// ─── Phase UX8 — Trade Action Center AI tools ──────────────────────────
// All tools are DRAFT-ONLY or READ-ONLY. None can confirm, queue, or
// execute a trade — confirmation MUST come from an authenticated POST
// from the user via the Action Center UI.

export async function createTradeActionDraftTool(userId: number, args: Record<string, unknown>) {
  const { createActionDraft } = await import("../tradeAction/create.js");
  const ACTION_OK = new Set(["OPEN","CLOSE","PARTIAL_CLOSE","MOVE_STOP","TRAIL_STOP","MODIFY_TP_SL","CANCEL_ORDER"]);
  const actionType = String(args.actionType ?? "");
  if (!ACTION_OK.has(actionType)) return { ok: false, error: "invalid_actionType",};
  const mode = String(args.requestedMode ?? "SIMULATED");
  if (!["SIMULATED","DEMO","LIVE"].includes(mode)) return { ok: false, error: "invalid_requestedMode",};
  const sideRaw = String(args.side ?? "").toUpperCase();
  const side = sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw as "BUY" | "SELL" : null;
  try {
    const result = await createActionDraft({
      userId,
      actionType: actionType as "OPEN"|"CLOSE"|"PARTIAL_CLOSE"|"MOVE_STOP"|"TRAIL_STOP"|"MODIFY_TP_SL"|"CANCEL_ORDER",
      tradeKey: typeof args.tradeKey === "string" && args.tradeKey ? String(args.tradeKey) : null,
      requestedMode: mode as "SIMULATED" | "DEMO" | "LIVE",
      symbol: typeof args.symbol === "string" ? String(args.symbol) : undefined,
      side,
      lotSize: typeof args.lotSize === "number" ? Number(args.lotSize) : null,
      stopLoss: typeof args.stopLoss === "number" ? Number(args.stopLoss) : null,
      takeProfit: typeof args.takeProfit === "number" ? Number(args.takeProfit) : null,
      reason: typeof args.reason === "string" ? String(args.reason).slice(0, 500) : null,
      source: "ai_suggested",
    });
    if (!result.ok) return { ok: false, error: result.error,};
    return {
      ok: true,
      action: {
        id: result.action.id,
        actionType: result.action.actionType,
        status: result.action.status,
        tradeKey: result.action.tradeKey,
        symbol: result.action.symbol,
        requestedMode: result.action.requestedMode,
        reason: result.action.reason,
        expiresAt: result.action.expiresAt,
      },
      note: `Draft created. ARX will NOT execute until the user opens the Action Center and confirms action #${result.action.id}.`,
    };
  } catch (e) {
    return { ok: false, error: "create_draft_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

export async function listMyPendingActionsTool(userId: number) {
  const { db: _db } = await import("@workspace/db");
  const { tradeActionRequestsTable } = await import("@workspace/db/schema");
  const { and: _and, desc: _desc, eq: _eq, inArray } = await import("drizzle-orm");
  const pending = ["ai_suggested","user_reviewing","awaiting_confirmation","confirmed","guard_checking","queued","sent_to_mt5"];
  try {
    const rows = await _db.select().from(tradeActionRequestsTable)
      .where(_and(_eq(tradeActionRequestsTable.userId, userId), inArray(tradeActionRequestsTable.status, pending)))
      .orderBy(_desc(tradeActionRequestsTable.createdAt))
      .limit(50);
    return {
      ok: true,
      count: rows.length,
      actions: rows.map((r) => ({
        id: r.id, actionType: r.actionType, symbol: r.symbol, tradeKey: r.tradeKey,
        status: r.status, requestedMode: r.requestedMode, reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt?.toISOString() ?? null,
      })),
    };
  } catch (e) {
    return { ok: false, error: "list_pending_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

export async function getTradeActionStatusTool(userId: number, actionId: number) {
  if (!Number.isFinite(actionId) || actionId <= 0) return { ok: false, error: "invalid_actionId",};
  const { db: _db } = await import("@workspace/db");
  const { tradeActionRequestsTable } = await import("@workspace/db/schema");
  const { and: _and, eq: _eq } = await import("drizzle-orm");
  try {
    const [row] = await _db.select().from(tradeActionRequestsTable)
      .where(_and(_eq(tradeActionRequestsTable.id, actionId), _eq(tradeActionRequestsTable.userId, userId)))
      .limit(1);
    if (!row) return { ok: false, error: "action_not_found_or_not_yours",};
    return {
      ok: true,
      action: {
        id: row.id, actionType: row.actionType, symbol: row.symbol, tradeKey: row.tradeKey,
        status: row.status, requestedMode: row.requestedMode,
        rejectionReason: row.rejectionReason, tradeCommandId: row.tradeCommandId, mt5Ticket: row.mt5Ticket,
        guardChecks: ((row.guardResult as { checks?: Array<{ id: string; name: string; passed: boolean; detail?: string }> } | null)?.checks ?? []).map((c) => ({
          id: c.id, name: c.name, passed: c.passed, detail: c.detail ?? null,
        })),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  } catch (e) {
    return { ok: false, error: "status_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

export async function explainActionRejectionTool(userId: number, actionId: number) {
  if (!Number.isFinite(actionId) || actionId <= 0) return { ok: false, error: "invalid_actionId",};
  const { db: _db } = await import("@workspace/db");
  const { tradeActionRequestsTable } = await import("@workspace/db/schema");
  const { and: _and, eq: _eq } = await import("drizzle-orm");
  try {
    const [row] = await _db.select().from(tradeActionRequestsTable)
      .where(_and(_eq(tradeActionRequestsTable.id, actionId), _eq(tradeActionRequestsTable.userId, userId)))
      .limit(1);
    if (!row) return { ok: false, error: "action_not_found_or_not_yours",};
    if (row.status !== "rejected" && row.status !== "failed") {
      return { ok: true, note: "not_in_failed_state", currentStatus: row.status,};
    }
    const checks = (row.guardResult as { checks?: Array<{ id: string; name: string; passed: boolean; detail?: string }> } | null)?.checks ?? [];
    const failed = checks.find((c) => !c.passed) ?? null;
    return {
      ok: true,
      actionId: row.id,
      status: row.status,
      rejectionReason: row.rejectionReason ?? null,
      failedCheck: failed ? { id: failed.id, name: failed.name, detail: failed.detail ?? null } : null,
    };
  } catch (e) {
    return { ok: false, error: "explain_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

// ── Phase UX9 — execution result tools ────────────────────────────────────
export async function getActionExecutionResultTool(userId: number, actionId: number) {
  if (!Number.isFinite(actionId) || actionId <= 0) return { ok: false, error: "invalid_actionId",};
  const { db: _db } = await import("@workspace/db");
  const { tradeActionRequestsTable } = await import("@workspace/db/schema");
  const { and: _and, eq: _eq } = await import("drizzle-orm");
  try {
    const [row] = await _db.select().from(tradeActionRequestsTable)
      .where(_and(_eq(tradeActionRequestsTable.id, actionId), _eq(tradeActionRequestsTable.userId, userId)))
      .limit(1);
    if (!row) return { ok: false, error: "action_not_found_or_not_yours",};
    return {
      ok: true,
      actionId: row.id,
      status: row.status,
      actionType: row.actionType,
      symbol: row.symbol,
      requestedMode: row.requestedMode,
      tradeCommandId: row.tradeCommandId,
      mt5OrderTicket: row.mt5OrderTicket ?? null,
      mt5PositionTicket: row.mt5PositionTicket ?? null,
      requestedPrice: row.requestedPrice ?? null,
      fillPrice: row.fillPrice ?? null,
      slippage: row.slippage ?? null,
      filledLotSize: row.filledLotSize ?? null,
      brokerMessage: row.brokerMessage ?? null,
      errorCode: row.errorCode ?? null,
      executedAt: row.executedAt?.toISOString() ?? null,
      rejectionReason: row.rejectionReason ?? null,
    };
  } catch (e) {
    return { ok: false, error: "execution_result_fetch_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

export async function explainBrokerRejectionTool(userId: number, actionId: number) {
  if (!Number.isFinite(actionId) || actionId <= 0) return { ok: false, error: "invalid_actionId",};
  const { db: _db } = await import("@workspace/db");
  const { tradeActionRequestsTable } = await import("@workspace/db/schema");
  const { and: _and, eq: _eq } = await import("drizzle-orm");
  const { brokerRejectionHint } = await import("../mt5/executionReconciler.js");
  try {
    const [row] = await _db.select().from(tradeActionRequestsTable)
      .where(_and(_eq(tradeActionRequestsTable.id, actionId), _eq(tradeActionRequestsTable.userId, userId)))
      .limit(1);
    if (!row) return { ok: false, error: "action_not_found_or_not_yours",};
    if (row.status !== "rejected" && row.status !== "failed") {
      return { ok: true, note: "not_rejected", currentStatus: row.status,};
    }
    return {
      ok: true,
      actionId: row.id,
      status: row.status,
      errorCode: row.errorCode ?? null,
      brokerMessage: row.brokerMessage ?? null,
      rejectionReason: row.rejectionReason ?? null,
      explanation: brokerRejectionHint(row.errorCode, row.brokerMessage ?? row.rejectionReason),
      recommendedFix: brokerRejectionHint(row.errorCode, row.brokerMessage ?? row.rejectionReason),
    };
  } catch (e) {
    return { ok: false, error: "explain_broker_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

export async function getRecentExecutionResultsTool(userId: number, limit: number) {
  const { db: _db } = await import("@workspace/db");
  const { tradeActionRequestsTable } = await import("@workspace/db/schema");
  const { desc: _desc, eq: _eq } = await import("drizzle-orm");
  const lim = Math.min(50, Math.max(1, Number.isFinite(limit) ? limit : 10));
  try {
    const rows = await _db.select().from(tradeActionRequestsTable)
      .where(_eq(tradeActionRequestsTable.userId, userId))
      .orderBy(_desc(tradeActionRequestsTable.updatedAt))
      .limit(lim);
    return {
      ok: true,
      count: rows.length,
      results: rows.map((r) => ({
        actionId: r.id,
        actionType: r.actionType,
        symbol: r.symbol,
        requestedMode: r.requestedMode,
        status: r.status,
        mt5OrderTicket: r.mt5OrderTicket ?? null,
        mt5PositionTicket: r.mt5PositionTicket ?? null,
        fillPrice: r.fillPrice ?? null,
        slippage: r.slippage ?? null,
        filledLotSize: r.filledLotSize ?? null,
        brokerMessage: r.brokerMessage ?? null,
        errorCode: r.errorCode ?? null,
        executedAt: r.executedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  } catch (e) {
    return { ok: false, error: "recent_results_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

export async function getStuckCommandsForUserTool(userId: number) {
  const { db: _db } = await import("@workspace/db");
  const { tradeActionRequestsTable } = await import("@workspace/db/schema");
  const { and: _and, eq: _eq, or: _or, desc: _desc } = await import("drizzle-orm");
  try {
    const rows = await _db.select().from(tradeActionRequestsTable)
      .where(_and(
        _eq(tradeActionRequestsTable.userId, userId),
        _or(
          _eq(tradeActionRequestsTable.errorCode, "WATCHDOG_STALE"),
          _eq(tradeActionRequestsTable.status, "sent_to_mt5"),
          _eq(tradeActionRequestsTable.status, "queued"),
        )!,
      ))
      .orderBy(_desc(tradeActionRequestsTable.updatedAt))
      .limit(50);
    const now = Date.now();
    const stuck = rows
      .filter((r) => r.errorCode === "WATCHDOG_STALE" || (now - r.createdAt.getTime()) > 5 * 60 * 1000)
      .map((r) => ({
        actionId: r.id,
        symbol: r.symbol,
        requestedMode: r.requestedMode,
        status: r.status,
        brokerMessage: r.brokerMessage ?? null,
        errorCode: r.errorCode ?? null,
        staleAt: r.staleAt?.toISOString() ?? null,
        ageMinutes: Math.round((now - r.createdAt.getTime()) / 60000),
        recommendedAction: r.errorCode === "WATCHDOG_STALE"
          ? "Re-draft the action from the Action Center if you still want this change."
          : "Open the Action Center and check the broker connection.",
      }));
    return { ok: true, count: stuck.length, stuck,};
  } catch (e) {
    return { ok: false, error: "stuck_commands_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

// ── Phase Playbook — Strategy Playbook & Setup Quality AI tools ──────────
// All four tools are user-scoped, read-only, and NEVER fabricate scores,
// playbook matches, or win rates. They return explicit isEmpty / notFound /
// dataAvailable:false flags when the underlying data is missing.

export async function getMyPlaybooksTool(userId: number) {
  try {
    const { userPlaybooksTable } = await import("@workspace/db/schema");
    const rows = await db.select({
      id: userPlaybooksTable.id,
      title: userPlaybooksTable.title,
      strategyType: userPlaybooksTable.strategyType,
      status: userPlaybooksTable.status,
      preferredSymbols: userPlaybooksTable.preferredSymbols,
      preferredSessions: userPlaybooksTable.preferredSessions,
      timeframe: userPlaybooksTable.timeframe,
      sampleSize: userPlaybooksTable.sampleSize,
      winRateSnapshot: userPlaybooksTable.winRateSnapshot,
      source: userPlaybooksTable.source,
    }).from(userPlaybooksTable).where(eq(userPlaybooksTable.userId, userId))
      .orderBy(desc(userPlaybooksTable.updatedAt)).limit(50);
    return {
      ok: true,
      count: rows.length,
      isEmpty: rows.length === 0,
      playbooks: rows,
      noteIfEmpty: rows.length === 0
        ? "You have no trading playbooks yet. Create one from the Playbook page or generate one from your trade history."
        : null,
    };
  } catch (e) {
    return { ok: false, error: "playbooks_query_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

export async function evaluateTradeAgainstPlaybookTool(userId: number, preTradeCheckId: number) {
  try {
    if (!Number.isFinite(preTradeCheckId) || preTradeCheckId <= 0) {
      return { ok: false, error: "invalid_pre_trade_check_id",};
    }
    const { preTradeChecksTable, userPlaybooksTable } = await import("@workspace/db/schema");
    const [check] = await db.select().from(preTradeChecksTable)
      .where(and(eq(preTradeChecksTable.userId, userId), eq(preTradeChecksTable.id, preTradeCheckId)))
      .limit(1);
    if (!check) {
      return { ok: true, notFound: true, dataAvailable: false,
        message: "No pre-trade check with that id exists for you. Run a pre-trade check first from the Playbook page.",};
    }
    const [pb] = await db.select({ id: userPlaybooksTable.id, title: userPlaybooksTable.title })
      .from(userPlaybooksTable).where(eq(userPlaybooksTable.id, check.playbookId)).limit(1);
    const score = Number(check.score ?? 0);
    let label: string;
    if (score >= 90) label = "A+";
    else if (score >= 80) label = "A";
    else if (score >= 70) label = "B";
    else if (score >= 60) label = "C";
    else if (score >= 40) label = "low";
    else label = "avoid";
    return {
      ok: true,
      dataAvailable: true,
      preTradeCheckId: check.id,
      playbookId: check.playbookId,
      playbookTitle: pb?.title ?? null,
      symbol: check.symbol, side: check.side,
      decision: check.decision, score, label,
      passedRequiredCount: check.passedRequiredCount,
      failedRequiredCount: check.failedRequiredCount,
      ruleResults: (check.checklistResult ?? []),
      createdAt: check.createdAt,
    };
  } catch (e) {
    return { ok: false, error: "evaluate_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

export async function getBestAndWorstPlaybooksTool(userId: number, minTrades: number) {
  try {
    const { tradeJournalEntriesTable, userPlaybooksTable, paperTradesTable } = await import("@workspace/db/schema");
    const journals = await db.select({
      matchedPlaybookId: tradeJournalEntriesTable.matchedPlaybookId,
      tradeId: tradeJournalEntriesTable.tradeId,
      setupQualityScore: tradeJournalEntriesTable.setupQualityScore,
    }).from(tradeJournalEntriesTable)
      .where(and(
        eq(tradeJournalEntriesTable.userId, userId),
        sql`${tradeJournalEntriesTable.matchedPlaybookId} IS NOT NULL`,
      ))
      .limit(1000);
    if (journals.length === 0) {
      return { ok: true, isEmpty: true,
        reason: "no_closed_trades_with_playbook_tag",
        message: "I don't have any closed trades tagged to a playbook yet. Close a trade with a playbook-linked pre-trade check, or run /me/playbooks/:id/pre-trade-check on your next trade.",
        best: [], worst: [],};
    }
    const tradeIds = journals.map((j) => j.tradeId).filter((x): x is number => x != null);
    const trades = tradeIds.length > 0
      ? await db.select({ id: paperTradesTable.id, pnl: paperTradesTable.pnl, status: paperTradesTable.status })
          .from(paperTradesTable)
          .where(and(eq(paperTradesTable.userId, userId), sql`${paperTradesTable.id} = ANY(${tradeIds})`))
      : [];
    const pnlByTradeId = new Map<number, number>();
    for (const t of trades) if (t.status === "closed" && t.pnl != null) pnlByTradeId.set(t.id, Number(t.pnl));
    type Agg = { playbookId: number; trades: number; wins: number; pnl: number; };
    const agg = new Map<number, Agg>();
    for (const j of journals) {
      if (j.matchedPlaybookId == null || j.tradeId == null) continue;
      const p = pnlByTradeId.get(j.tradeId);
      if (p == null) continue;
      const a = agg.get(j.matchedPlaybookId) ?? { playbookId: j.matchedPlaybookId, trades: 0, wins: 0, pnl: 0 };
      a.trades += 1; if (p > 0) a.wins += 1; a.pnl += p;
      agg.set(j.matchedPlaybookId, a);
    }
    const candidates = Array.from(agg.values()).filter((a) => a.trades >= Math.max(1, minTrades));
    if (candidates.length === 0) {
      return { ok: true, isEmpty: true, reason: "below_min_trades",
        message: `No playbook has at least ${minTrades} closed trades yet. Lower the threshold or trade more before asking.`,
        best: [], worst: [],};
    }
    const pbIds = candidates.map((c) => c.playbookId);
    const pbs = await db.select({ id: userPlaybooksTable.id, title: userPlaybooksTable.title })
      .from(userPlaybooksTable).where(sql`${userPlaybooksTable.id} = ANY(${pbIds})`);
    const titleById = new Map(pbs.map((p) => [p.id, p.title]));
    const enriched = candidates.map((c) => ({
      playbookId: c.playbookId, title: titleById.get(c.playbookId) ?? `Playbook ${c.playbookId}`,
      trades: c.trades, winRate: Number(((c.wins / c.trades) * 100).toFixed(1)),
      totalPnl: Number(c.pnl.toFixed(2)), avgPnl: Number((c.pnl / c.trades).toFixed(2)),
    }));
    const sorted = [...enriched].sort((a, b) => b.totalPnl - a.totalPnl);
    return {
      ok: true, isEmpty: false,
      best: sorted.slice(0, 3),
      worst: sorted.slice(-3).reverse(),
      totalPlaybooksScored: enriched.length,
    };
  } catch (e) {
    return { ok: false, error: "best_worst_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

export async function getRecentPreTradeChecksTool(userId: number, limit: number) {
  try {
    const lim = Math.min(50, Math.max(1, Math.floor(limit)));
    const { preTradeChecksTable } = await import("@workspace/db/schema");
    const rows = await db.select({
      id: preTradeChecksTable.id, playbookId: preTradeChecksTable.playbookId,
      symbol: preTradeChecksTable.symbol, side: preTradeChecksTable.side,
      decision: preTradeChecksTable.decision, score: preTradeChecksTable.score,
      passedRequiredCount: preTradeChecksTable.passedRequiredCount,
      failedRequiredCount: preTradeChecksTable.failedRequiredCount,
      createdAt: preTradeChecksTable.createdAt,
    }).from(preTradeChecksTable).where(eq(preTradeChecksTable.userId, userId))
      .orderBy(desc(preTradeChecksTable.createdAt)).limit(lim);
    return { ok: true, count: rows.length, isEmpty: rows.length === 0, checks: rows,};
  } catch (e) {
    return { ok: false, error: "recent_checks_failed", reason: (e as Error).message.slice(0, 120),};
  }
}

// ── Opportunity Radar tools ───────────────────────────────────────────────
export async function getTopOpportunitiesForMeTool(userId: number, limit: number) {
  try {
    const { evaluateOpportunitiesForUser } = await import("../opportunityRadar/radar.js");
    const result = await evaluateOpportunitiesForUser(userId, { limit: Math.min(50, Math.max(1, limit)), persist: false });
    return {
      ok: true,
      liveDataConnected: result.liveDataConnected,
      dataSource: result.dataSource,
      symbolsRequested: result.symbolsRequested,
      symbolsWithData: result.symbolsWithData,
      symbolsInsufficient: result.symbolsInsufficient,
      sections: result.sections,
      opportunities: result.opportunities,
    };
  } catch (e) {
    return { ok: false, error: "radar_failed", reason: (e as Error).message.slice(0, 200),};
  }
}

export async function explainOpportunityRankingTool(userId: number, limit: number) {
  try {
    const { evaluateOpportunitiesForUser } = await import("../opportunityRadar/radar.js");
    const result = await evaluateOpportunitiesForUser(userId, { limit: Math.min(20, Math.max(1, limit)), persist: false });
    const explanations = result.opportunities.map((o, idx) => {
      const rc = o.ruleCheck;
      let ruleExplanation: string;
      const rd = rc.ruleDetail ?? null;
      if (rc.status === "BLOCKED_BY_RULE") {
        const ruleName = rd?.ruleName ?? rc.failedCheckId ?? "rule";
        const limits = rd && (rd.currentValue !== null || rd.allowedLimit !== null)
          ? ` (current ${rd.currentValue ?? "n/a"} vs allowed ${rd.allowedLimit ?? "n/a"})`
          : "";
        const fix = rd?.fixHint ? ` Fix: ${rd.fixHint}` : "";
        ruleExplanation = `BLOCKED by ${ruleName} [${rd?.source ?? "GUARD_CHAIN"} / ${rd?.severity ?? "WARN"}]: ${rc.reason}${limits}.${fix} You cannot queue this trade until the rule clears.`;
      } else if (rc.status === "WARNING_BY_RULE") {
        const ruleName = rd?.ruleName ?? "Advisory";
        const fix = rd?.fixHint ? ` Suggested next step: ${rd.fixHint}` : "";
        const warnList = rc.warnings && rc.warnings.length > 0 ? ` Warnings: ${rc.warnings.join("; ")}.` : "";
        ruleExplanation = `WARNING from ${ruleName} [${rd?.source ?? "SAFETY_CORE"}]: ${rc.reason ?? "soft advisory"}.${warnList}${fix} You can still queue this trade.`;
      } else if (rc.status === "CLEAR") {
        ruleExplanation = `Risk Governor: CLEAR. ${rc.checksRun.length} guard checks passed (same chain the live trade queue uses).`;
      } else if (rc.status === "DATA_INCOMPLETE") {
        const fix = rd?.fixHint ? ` Fix: ${rd.fixHint}` : "";
        ruleExplanation = `DATA INCOMPLETE — ${rc.reason ?? "Risk Governor context could not be loaded"}.${fix} No rule judgement was made; this is not a pass and not a block.`;
      } else if (rc.status === "RULE_CHECK_SKIPPED") {
        ruleExplanation = `Risk Governor not evaluated — ${rc.reason ?? "no market data"}.`;
      } else {
        ruleExplanation = `Risk Governor check failed to run: ${rc.reason ?? "unknown error"}.`;
      }
      return {
        rank: idx + 1,
        symbol: o.symbol,
        label: o.label,
        opportunityScore: o.opportunityScore,
        confluenceScore: o.confluenceScore,
        riskScore: o.riskScore,
        directionBias: o.directionBias,
        suggestedAction: o.suggestedAction,
        whyRanked: o.label === "Data insufficient"
          ? `Ranked at the bottom because live market data is not connected for ${o.symbol}.`
          : `Ranked #${idx + 1} by opportunityScore (${o.opportunityScore}). Confluence ${o.confluenceScore}, risk ${o.riskScore}, bias ${o.directionBias}.`,
        ruleStatus: rc.status,
        ruleReason: rc.reason,
        ruleFailedCheckId: rc.failedCheckId,
        ruleDetail: rd,
        ruleExplanation,
        toolsUsed: o.toolsUsed,
        dataQuality: o.dataQuality,
      };
    });
    return {
      ok: true,
      liveDataConnected: result.liveDataConnected,
      explanations,
      note: "Ranking uses LiveScanner score (opportunityScore) with data-insufficient items sunk to the bottom. Not guaranteed; decision support only.",
    };
  } catch (e) {
    return { ok: false, error: "explain_radar_failed", reason: (e as Error).message.slice(0, 200),};
  }
}

// ── Phase TT — Trade ticket assistant tools ────────────────────────────────
import { ORDER_TYPES as TT_ORDER_TYPES, isOrderType as ttIsOrderType, isMarketOrder as ttIsMarketOrder } from "../tradeAction/orderTypes.js";
import { validateOrderTicket as ttValidate } from "../tradeAction/orderTicketValidation.js";
import { tradeActionRequestsTable } from "@workspace/db/schema";
import { isNotNull } from "drizzle-orm";

const ORDER_TYPE_INFO: Record<string, { whatItIs: string; whenToUse: string; requiredFields: string[]; placementRule: string; typicalUseCase: string; slTpRule: string }> = {
  BUY_MARKET: {
    whatItIs: "Buy at the next available market price right now.",
    whenToUse: "When you want immediate entry and are willing to take any small spread/slippage.",
    requiredFields: ["lotSize", "stopLoss (optional)", "takeProfit (optional)"],
    placementRule: "Executes immediately at the current ask. No entryPrice required.",
    typicalUseCase: "Breakout already in motion you don't want to miss.",
    slTpRule: "Stop loss must be BELOW current price; take profit ABOVE current price.",
  },
  SELL_MARKET: {
    whatItIs: "Sell at the next available market price right now.",
    whenToUse: "When you want immediate short entry and accept current bid.",
    requiredFields: ["lotSize", "stopLoss (optional)", "takeProfit (optional)"],
    placementRule: "Executes immediately at the current bid. No entryPrice required.",
    typicalUseCase: "Bearish reversal already breaking down.",
    slTpRule: "Stop loss must be ABOVE current price; take profit BELOW current price.",
  },
  BUY_LIMIT: {
    whatItIs: "Pending order to buy at a price LOWER than the current market.",
    whenToUse: "When you expect price to pull back into support before going up.",
    requiredFields: ["entryPrice", "lotSize"],
    placementRule: "entryPrice must be BELOW current price.",
    typicalUseCase: "Buy the dip into a known support / order block.",
    slTpRule: "Stop loss must be BELOW entry; take profit ABOVE entry.",
  },
  SELL_LIMIT: {
    whatItIs: "Pending order to sell at a price HIGHER than the current market.",
    whenToUse: "When you expect price to rally into resistance before reversing down.",
    requiredFields: ["entryPrice", "lotSize"],
    placementRule: "entryPrice must be ABOVE current price.",
    typicalUseCase: "Fade a rally into resistance / supply zone.",
    slTpRule: "Stop loss must be ABOVE entry; take profit BELOW entry.",
  },
  BUY_STOP: {
    whatItIs: "Pending order to buy at a price HIGHER than the current market (breakout).",
    whenToUse: "When you want to enter only if price breaks above a resistance level.",
    requiredFields: ["entryPrice", "lotSize"],
    placementRule: "entryPrice must be ABOVE current price.",
    typicalUseCase: "Buy the breakout of a range high or trend line.",
    slTpRule: "Stop loss must be BELOW entry; take profit ABOVE entry.",
  },
  SELL_STOP: {
    whatItIs: "Pending order to sell at a price LOWER than the current market (breakdown).",
    whenToUse: "When you want to enter only if price breaks below a support level.",
    requiredFields: ["entryPrice", "lotSize"],
    placementRule: "entryPrice must be BELOW current price.",
    typicalUseCase: "Sell the breakdown of a range low or trend line.",
    slTpRule: "Stop loss must be ABOVE entry; take profit BELOW entry.",
  },
  BUY_STOP_LIMIT: {
    whatItIs: "Trigger above market, then place a Buy Limit at a specific price.",
    whenToUse: "When you want breakout confirmation but with limited entry slippage.",
    requiredFields: ["stopTriggerPrice", "stopLimitPrice", "lotSize"],
    placementRule: "stopTriggerPrice must be ABOVE current price; stopLimitPrice must be STRICTLY BELOW stopTriggerPrice (per MT5 ORDER_TYPE_BUY_STOP_LIMIT — once price breaks above trigger, a Buy Limit is placed at the lower stopLimitPrice to wait for a pullback fill).",
    typicalUseCase: "Breakout entry with a maximum fill price guard.",
    slTpRule: "Stop loss must be BELOW stopLimitPrice; take profit ABOVE stopLimitPrice.",
  },
  SELL_STOP_LIMIT: {
    whatItIs: "Trigger below market, then place a Sell Limit at a specific price.",
    whenToUse: "When you want breakdown confirmation but with limited entry slippage.",
    requiredFields: ["stopTriggerPrice", "stopLimitPrice", "lotSize"],
    placementRule: "stopTriggerPrice must be BELOW current price; stopLimitPrice must be STRICTLY ABOVE stopTriggerPrice (per MT5 ORDER_TYPE_SELL_STOP_LIMIT — once price breaks below trigger, a Sell Limit is placed at the higher stopLimitPrice to wait for a pullback fill).",
    typicalUseCase: "Breakdown entry with a minimum fill price guard.",
    slTpRule: "Stop loss must be ABOVE stopLimitPrice; take profit BELOW stopLimitPrice.",
  },
};

export function explainOrderTypeTool(orderType: string) {
  const key = orderType.toUpperCase();
  if (!ttIsOrderType(key)) {
    return { ok: false, error: "unknown_order_type", supported: TT_ORDER_TYPES,};
  }
  const info = ORDER_TYPE_INFO[key];
  const pending = !ttIsMarketOrder(key);
  return {
    ok: true,
    orderType: key,
    direction: key.startsWith("BUY") ? "BUY" : "SELL",
    isMarket: !pending,
    isPending: pending,
    ...info,
    executionNote: pending
      ? "Pending orders are validated and saved as drafts in ARX today. The MT5 EA does not yet support pending-order execution — drafts are NOT sent to the broker until that upgrade ships."
      : "Market orders are routed through the existing guarded placement chain (paper/demo only).",
  };
}

export function analyzeTradeTicketTool(args: {
  orderType?: string;
  lotSize?: number;
  currentPrice?: number;
  entryPrice?: number;
  stopTriggerPrice?: number;
  stopLimitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  minStopDistance?: number;
  minPendingDistance?: number;
  symbolPipSize?: number;
}) {
  const ot = String(args.orderType ?? "").toUpperCase();
  if (!ttIsOrderType(ot)) {
    return { ok: false, error: "unknown_order_type", supported: TT_ORDER_TYPES,};
  }
  const v = ttValidate({
    orderType: ot,
    lotSize: Number(args.lotSize ?? 0),
    currentPrice: args.currentPrice ?? null,
    entryPrice: args.entryPrice ?? null,
    stopTriggerPrice: args.stopTriggerPrice ?? null,
    stopLimitPrice: args.stopLimitPrice ?? null,
    stopLoss: args.stopLoss ?? null,
    takeProfit: args.takeProfit ?? null,
    minStopDistance: args.minStopDistance,
    minPendingDistance: args.minPendingDistance,
    symbolPipSize: args.symbolPipSize,
  });
  return { ok: true, validation: v,};
}

export async function getMyPendingOrderDraftsTool(userId: number) {
  try {
    const rows = await db.select().from(tradeActionRequestsTable)
      .where(and(
        eq(tradeActionRequestsTable.userId, userId),
        isNotNull(tradeActionRequestsTable.pendingStatus),
      ))
      .orderBy(desc(tradeActionRequestsTable.createdAt))
      .limit(50);
    return {
      ok: true,
      isEmpty: rows.length === 0,
      drafts: rows.map((r) => ({
        id: r.id,
        orderType: r.orderType,
        symbol: r.symbol,
        side: r.side,
        lotSize: r.lotSize,
        entryPrice: r.requestedPrice,
        stopTriggerPrice: r.stopTriggerPrice,
        stopLimitPrice: r.stopLimitPrice,
        stopLoss: r.stopLoss,
        takeProfit: r.takeProfit,
        expiration: r.expiration?.toISOString() ?? null,
        pendingStatus: r.pendingStatus,
        status: r.status,
        tradeCommandId: r.tradeCommandId ?? null,
        mt5OrderTicket: r.mt5OrderTicket ?? null,
        confirmedByUser: r.confirmedByUser ?? false,
        createdAt: r.createdAt.toISOString(),
      })),
      note: "Phase TV vocabulary: EA_UPGRADE_REQUIRED|BRIDGE_DISCONNECTED|BRIDGE_UNSUPPORTED|READ_ONLY|LIVE_LOCKED|BLOCKED_BY_PAPER_LOCK = NOT at broker. QUEUED = command row inserted. PLACED = MT5 returned a real ticket (mt5OrderTicket non-null). REJECTED|CANCELLED|MODIFIED are post-bridge states. NEVER claim a draft is PLACED unless pendingStatus='PLACED' AND mt5OrderTicket is non-null.",
    };
  } catch (e) {
    return { ok: false, error: "drafts_query_failed", reason: (e as Error).message.slice(0, 200),};
  }
}

// ── Phase TU — Bridge capability disclosure tool ─────────────────────────
// Returns the EA's reported capability set and the honest resolved
// "what would happen if the user tried to submit a pending order right
// now" probe. Per-user scoped. NEVER enables or claims execution.
// ── Phase 13 — Protective Auto-Close (READ-ONLY) ─────────────────────────
// Returns the signed-in user's current settings AND the most recent decisions
// journal. Per-user-scoped (SQL-filtered on userId). NEVER triggers the
// engine. NEVER claims a close happened — actionTakenActionId is null unless
// the engine drafted one, and even then the user must confirm.
export async function getProtectiveCloseStatusTool(
  userId: number,
  tradeKey: string | null,
  limit: number,
) {
  try {
    const { getEffectiveSettings } = await import("../protectiveClose/settings.js");
    const { protectiveCloseDecisionsTable } = await import("@workspace/db/schema");
    const settings = await getEffectiveSettings(userId);
    const safeLimit = Math.max(1, Math.min(50, Number.isFinite(limit) ? limit : 10));
    const whereExpr = tradeKey
      ? and(eq(protectiveCloseDecisionsTable.userId, userId), eq(protectiveCloseDecisionsTable.tradeKey, tradeKey))
      : eq(protectiveCloseDecisionsTable.userId, userId);
    const rows = await db.select().from(protectiveCloseDecisionsTable)
      .where(whereExpr)
      .orderBy(desc(protectiveCloseDecisionsTable.createdAt))
      .limit(safeLimit);
    const decisions = rows.map((r) => ({
      id: r.id,
      tradeKey: r.tradeKey,
      symbol: r.symbol,
      decision: r.decision,
      decisionReason: r.decisionReason,
      confidence: r.confidence,
      dataStatus: r.dataStatus,
      reversalSignals: r.reversalSignals ?? [],
      invalidationLevel: r.invalidationLevel,
      currentPnl: r.currentPnl,
      peakPnl: r.peakPnl,
      givebackPercent: r.givebackPercent,
      suggestedClosePercent: r.suggestedClosePercent,
      suggestedAction: r.suggestedAction,
      userInactive: r.userInactive,
      inactiveDurationMs: r.inactiveDurationMs,
      userOptedIn: r.userOptedIn,
      guardsPassed: r.guardsPassed,
      blockedReason: r.blockedReason,
      actionTakenActionId: r.actionTakenActionId,
      createdAt: r.createdAt.toISOString(),
    }));
    return {
      ok: true,
      settings: {
        enabled: settings.enabled,
        mode: settings.mode,
        closeType: settings.closeType,
        partialClosePercent: settings.partialClosePercent,
        inactivityThresholdMin: settings.inactivityThresholdMin,
        minConfidence: settings.minConfidence,
        requireMultiSignal: settings.requireMultiSignal,
        protectProfitEnabled: settings.protectProfitEnabled,
        protectProfitGivebackPct: settings.protectProfitGivebackPct,
        maxLossProtectionEnabled: settings.maxLossProtectionEnabled,
        maxLossProtectionPct: settings.maxLossProtectionPct,
        killSwitchEngaged: settings.killSwitchEngaged,
        cooldownMin: settings.cooldownMin,
        maxAutoClosesPerTrade: settings.maxAutoClosesPerTrade,
        optInAt: settings.optInAt,
        optOutAt: settings.optOutAt,
        source: settings.source,
      },
      decisions,
      decisionsIsEmpty: decisions.length === 0,
      note: "Protective auto-close is opt-in and default OFF. The engine only ever drafts a CLOSE action (it cannot OPEN, ADD, or WIDEN risk). actionTakenActionId is null unless a draft was created — and even then the user must still confirm before any broker call. Today the paper-only lock means even drafted actions remain BLOCKED.",
    };
  } catch (e) {
    return { ok: false, error: "protective_close_status_failed", reason: (e as Error).message.slice(0, 200),};
  }
}

export async function getBridgeCapabilitiesTool(userId: number, env: SafetyEnvelope) {
  try {
    const { mt5ConnectionTable } = await import("@workspace/db/schema");
    const {
      normaliseCapabilities,
      resolvePendingSubmitStatus,
      explainStatus,
    } = await import("../mt5/bridgeCapabilities.js");
    const rows = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId)).limit(1);
    const conn = rows[0] ?? null;
    const caps = normaliseCapabilities(conn?.capabilities);
    const lastHb = conn?.lastHeartbeat ? new Date(conn.lastHeartbeat) : null;
    const bridgeConnected = !!lastHb && (Date.now() - lastHb.getTime() < 90_000);
    const probe = resolvePendingSubmitStatus({
      capabilities: caps,
      bridgeConnected,
      needsStopLimit: false,
      // paperOnlyLock is the SEPARATE pending-order paper lock (out of scope —
      // still hard-true today). The live-envelope inputs below are DERIVED.
      paperOnlyLock: true,
      liveLocked: env.liveLocked,
      readOnlyMode: env.readOnlyMode,
      allowOrderExecution: env.allowOrderExecution,
    });
    return {
      ok: true,
      bridgeConnected,
      eaVersion: conn?.eaVersion ?? null,
      capabilitiesReportedAt: conn?.capabilitiesReportedAt?.toISOString() ?? null,
      lastHeartbeatAt: lastHb?.toISOString() ?? null,
      capabilities: caps,
      pendingOrderExecutable: probe === "QUEUED",
      currentSubmitStatus: probe,
      currentSubmitExplanation: explainStatus(probe),
      note: "Capabilities are reported by the EA on heartbeat. The backend NEVER claims an action is supported when the corresponding capability is false. Pending-order execution remains system-blocked today by the paper-only lock.",
    };
  } catch (e) {
    return { ok: false, error: "bridge_capabilities_failed", reason: (e as Error).message.slice(0, 200),};
  }
}
