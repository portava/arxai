// Phase 11C — Per-user report builder service.
// SAFETY:
//  - Every query is scoped by userId. Never accepts client-supplied userId.
//  - Defensive secret stripping: apiKeyHash, tokenLast4, raw bridge tokens, secrets.
//  - Reports never trigger trade execution; pure read of user-owned tables.
//  - PDF is not implemented; HTML is the safe fallback.
import {
  db,
  mt5ConnectionTable, paperTradesTable, paperSessionsTable, tradingSessionsTable,
  tradeJournalEntriesTable, aiTradeReviewsTable, userPlaybooksTable, playbookRulesV2Table,
  preTradeChecksTable, userRiskSettingsTable, userRiskEventsTable, userNotificationsTable,
  userActivityTimelineTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";

export const REPORT_TYPES = [
  "account_summary", "trading_session_summary", "paper_trades", "performance_calendar",
  "trade_journal", "ai_trade_reviews", "risk_governor", "playbook_performance",
  "coaching_summary", "full_trading_archive",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_FORMATS = ["json", "csv", "html"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ReportRequest {
  reportType: ReportType;
  format: ReportFormat;
  dateRangeStart?: Date | null;
  dateRangeEnd?: Date | null;
  tradingSessionId?: number | null;
  symbol?: string | null;
  strategyTag?: string | null;
  status?: string | null;
  includeJournal?: boolean;
  includeAIReviews?: boolean;
  includeRiskEvents?: boolean;
  includePlaybooks?: boolean;
  includeCalendar?: boolean;
  includeNotifications?: boolean;
  timezone?: string | null;
}

export interface BuildResult {
  body: string;
  mimeType: string;
  fileName: string;
  rowCount: number;
}

const SECRET_KEYS = new Set([
  "apiKeyHash", "api_key_hash", "tokenLast4", "token_last4",
  "bridgeToken", "bridge_token", "MT5_BRIDGE_TOKEN", "x-mt5-bridge-token",
  "password", "passwordHash", "password_hash", "secret", "session_secret",
  "vapidPrivateKey", "vapid_private_key", "privateKey", "private_key",
]);
const SECRET_KEY_RE = /(token|secret|password|api[_-]?key|private[_-]?key|bridge)/i;

export function stripSecrets<T>(v: T, depth = 0): T {
  if (v == null || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => stripSecrets(x, depth + 1)) as unknown as T;
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k) || SECRET_KEY_RE.test(k)) continue;
      out[k] = stripSecrets(val, depth + 1);
    }
    return out as unknown as T;
  }
  return v;
}

function sanitizeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return columns ? columns.join(",") + "\n" : "";
  const cols = columns ?? Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(","));
  return lines.join("\n") + "\n";
}

const BRAND = "ARX AI — Analyze. Risk. eXecute.";
const DISCLAIMER = "Paper/read-only report — not financial advice.";

function htmlHeader(title: string, dateRange: { start?: Date | null; end?: Date | null }): string {
  const range = dateRange.start || dateRange.end
    ? `${dateRange.start?.toISOString() ?? "—"} → ${dateRange.end?.toISOString() ?? "—"}`
    : "All time";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#222}
h1{margin:0 0 8px}h2{margin-top:32px;border-bottom:1px solid #eee;padding-bottom:4px}
table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:13px}
th{background:#f8fafc}.meta{color:#666;font-size:12px}.banner{background:#fef3c7;padding:8px 12px;border-radius:6px;margin:12px 0;font-size:13px}
.empty{color:#999;font-style:italic;padding:12px;background:#f9fafb;border-radius:6px}</style></head><body>
<h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(BRAND)} · Generated ${new Date().toISOString()} · Range: ${escapeHtml(range)}</div>
<div class="banner">${escapeHtml(DISCLAIMER)}</div>`;
}
function htmlFooter(): string { return `</body></html>`; }
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
}
function htmlTable(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return `<div class="empty">No data for this section.</div>`;
  const cols = columns ?? Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const head = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr>`;
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(r[c] == null ? "" : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c]))}</td>`).join("")}</tr>`).join("");
  return `<table>${head}${body}</table>`;
}
function htmlSection(title: string, content: string): string {
  return `<h2>${escapeHtml(title)}</h2>${content}`;
}

// ── Data loaders (all userId-scoped, optionally date-bounded) ─────────────
function withinRange<T extends { createdAt?: Date | null; closedAt?: Date | null; openedAt?: Date | null }>(
  field: "createdAt" | "closedAt" | "openedAt", start?: Date | null, end?: Date | null,
) {
  const conds = [];
  if (start) conds.push({ field, op: "gte" as const, val: start });
  if (end) conds.push({ field, op: "lte" as const, val: end });
  return conds;
  void { withinRange };
}

async function loadPaperTrades(userId: number, req: ReportRequest) {
  const where = [eq(paperTradesTable.userId, userId)];
  if (req.dateRangeStart) where.push(gte(paperTradesTable.createdAt, req.dateRangeStart));
  if (req.dateRangeEnd) where.push(lte(paperTradesTable.createdAt, req.dateRangeEnd));
  if (req.tradingSessionId != null) where.push(eq(paperTradesTable.tradingSessionId, req.tradingSessionId));
  if (req.symbol) where.push(eq(paperTradesTable.symbol, req.symbol));
  if (req.strategyTag) where.push(eq(paperTradesTable.strategyTag, req.strategyTag));
  if (req.status) where.push(eq(paperTradesTable.status, req.status));
  return db.select().from(paperTradesTable).where(and(...where)).orderBy(asc(paperTradesTable.createdAt)).limit(5000);
}
async function loadJournal(userId: number, req: ReportRequest) {
  const where = [eq(tradeJournalEntriesTable.userId, userId)];
  if (req.dateRangeStart) where.push(gte(tradeJournalEntriesTable.createdAt, req.dateRangeStart));
  if (req.dateRangeEnd) where.push(lte(tradeJournalEntriesTable.createdAt, req.dateRangeEnd));
  return db.select().from(tradeJournalEntriesTable).where(and(...where)).orderBy(desc(tradeJournalEntriesTable.createdAt)).limit(5000);
}
async function loadReviews(userId: number, req: ReportRequest) {
  const where = [eq(aiTradeReviewsTable.userId, userId)];
  if (req.dateRangeStart) where.push(gte(aiTradeReviewsTable.createdAt, req.dateRangeStart));
  if (req.dateRangeEnd) where.push(lte(aiTradeReviewsTable.createdAt, req.dateRangeEnd));
  return db.select().from(aiTradeReviewsTable).where(and(...where)).orderBy(desc(aiTradeReviewsTable.createdAt)).limit(5000);
}
async function loadRiskEvents(userId: number, req: ReportRequest) {
  const where = [eq(userRiskEventsTable.userId, userId)];
  if (req.dateRangeStart) where.push(gte(userRiskEventsTable.createdAt, req.dateRangeStart));
  if (req.dateRangeEnd) where.push(lte(userRiskEventsTable.createdAt, req.dateRangeEnd));
  return db.select().from(userRiskEventsTable).where(and(...where)).orderBy(desc(userRiskEventsTable.createdAt)).limit(5000);
}
async function loadPlaybooks(userId: number) {
  return db.select().from(userPlaybooksTable).where(eq(userPlaybooksTable.userId, userId)).orderBy(desc(userPlaybooksTable.createdAt));
}
async function loadPlaybookRules(userId: number) {
  return db.select().from(playbookRulesV2Table).where(eq(playbookRulesV2Table.userId, userId));
}
async function loadPreTradeChecks(userId: number) {
  return db.select().from(preTradeChecksTable).where(eq(preTradeChecksTable.userId, userId)).orderBy(desc(preTradeChecksTable.createdAt)).limit(5000);
}
async function loadConnections(userId: number) {
  return db.select().from(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, userId));
}
async function loadRiskSettings(userId: number) {
  return (await db.select().from(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, userId)).limit(1))[0] ?? null;
}
async function loadSessions(userId: number, req: ReportRequest) {
  const where = [eq(tradingSessionsTable.userId, userId)];
  if (req.tradingSessionId != null) where.push(eq(tradingSessionsTable.id, req.tradingSessionId));
  return db.select().from(tradingSessionsTable).where(and(...where)).orderBy(desc(tradingSessionsTable.createdAt));
}
async function loadPaperSessions(userId: number) {
  return db.select().from(paperSessionsTable).where(eq(paperSessionsTable.userId, userId));
}
async function loadActivity(userId: number, req: ReportRequest) {
  const where = [eq(userActivityTimelineTable.userId, userId)];
  if (req.dateRangeStart) where.push(gte(userActivityTimelineTable.createdAt, req.dateRangeStart));
  if (req.dateRangeEnd) where.push(lte(userActivityTimelineTable.createdAt, req.dateRangeEnd));
  return db.select().from(userActivityTimelineTable).where(and(...where)).orderBy(desc(userActivityTimelineTable.createdAt)).limit(2000);
}
async function loadNotifications(userId: number, req: ReportRequest) {
  const where = [eq(userNotificationsTable.userId, userId)];
  if (req.dateRangeStart) where.push(gte(userNotificationsTable.createdAt, req.dateRangeStart));
  if (req.dateRangeEnd) where.push(lte(userNotificationsTable.createdAt, req.dateRangeEnd));
  return db.select().from(userNotificationsTable).where(and(...where)).orderBy(desc(userNotificationsTable.createdAt)).limit(2000);
}

// Strip MT5 connection rows aggressively.
function safeConnection(c: Record<string, unknown>) {
  return stripSecrets({
    id: c.id, connectionName: c.connectionName, status: c.status, mode: c.mode,
    accountNumber: c.accountNumber, brokerName: c.brokerName, serverName: c.serverName,
    accountCurrency: c.accountCurrency, accountBalance: c.accountBalance, accountEquity: c.accountEquity,
    leverage: c.leverage, liveLocked: c.liveLocked, readOnlyMode: c.readOnlyMode,
    allowOrderExecution: c.allowOrderExecution, lastHeartbeat: c.lastHeartbeat,
    createdAt: c.createdAt,
  });
}

// ── Builders per report type ──────────────────────────────────────────────
async function buildAccountSummary(userId: number, req: ReportRequest) {
  const [conns, riskSettings, trades, playbooks] = await Promise.all([
    loadConnections(userId), loadRiskSettings(userId), loadPaperTrades(userId, req), loadPlaybooks(userId),
  ]);
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0).length;
  const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  return {
    profile: { userId },
    mt5Connections: conns.map(safeConnection),
    riskSettings: stripSecrets(riskSettings),
    paperStats: { totalTrades: trades.length, closed: closed.length, wins, losses, totalPnl,
      winRate: closed.length ? +(100 * wins / closed.length).toFixed(2) : 0 },
    activePlaybooks: playbooks.filter((p) => p.status === "active").length,
    coachingFocus: playbooks.find((p) => p.status === "active")?.title ?? null,
  };
}

async function buildTradingSessionSummary(userId: number, req: ReportRequest) {
  const sessions = await loadSessions(userId, req);
  if (req.tradingSessionId != null && sessions.length === 0) {
    throw Object.assign(new Error("Session not found or not yours"), { status: 404 });
  }
  const trades = await loadPaperTrades(userId, req);
  const reviews = await loadReviews(userId, req);
  const riskEvents = await loadRiskEvents(userId, req);
  const journal = req.includeJournal !== false ? await loadJournal(userId, req) : [];
  return {
    sessions: sessions.map((s) => {
      const sTrades = trades.filter((t) => t.tradingSessionId === s.id);
      const closed = sTrades.filter((t) => t.status === "closed");
      const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
      return {
        id: s.id, name: (s as Record<string, unknown>).name ?? null,
        startedAt: (s as Record<string, unknown>).startedAt ?? null,
        endedAt: (s as Record<string, unknown>).endedAt ?? null,
        tradesTaken: sTrades.length, closed: closed.length,
        wins, losses: closed.length - wins,
        netPnl: closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0),
        riskEvents: riskEvents.filter((e) => e.tradingSessionId === s.id).length,
        journalEntries: journal.filter((j) => sTrades.some((t) => t.id === j.tradeId)).length,
        aiReviews: reviews.filter((r) => r.tradingSessionId === s.id).length,
      };
    }),
  };
}

async function buildPaperTradesReport(userId: number, req: ReportRequest) {
  const trades = await loadPaperTrades(userId, req);
  const reviews = req.includeAIReviews !== false ? await loadReviews(userId, req) : [];
  const reviewByTrade = new Map(reviews.map((r) => [r.paperTradeId, r]));
  return trades.map((t) => ({
    id: t.id, symbol: t.symbol, side: t.side, status: t.status,
    entryPrice: t.entryPrice, exitPrice: t.exitPrice,
    stopLoss: t.stopLoss, takeProfit: t.takeProfit,
    lotSize: t.lotSize, riskAmount: t.riskAmount, rewardRiskRatio: t.rewardRiskRatio,
    pnl: t.pnl, pnlPercent: t.pnlPercent,
    strategyTag: t.strategyTag, openedAt: t.openedAt, closedAt: t.closedAt,
    reasonForEntry: t.reasonForEntry, reasonForExit: t.reasonForExit,
    aiGrade: reviewByTrade.get(t.id)?.overallGrade ?? null,
  }));
}

async function buildPerformanceCalendar(userId: number, req: ReportRequest) {
  const trades = (await loadPaperTrades(userId, req)).filter((t) => t.status === "closed" && t.closedAt);
  const byDay = new Map<string, { date: string; trades: number; wins: number; losses: number; pnl: number }>();
  for (const t of trades) {
    const d = new Date(t.closedAt!).toISOString().slice(0, 10);
    const row = byDay.get(d) ?? { date: d, trades: 0, wins: 0, losses: 0, pnl: 0 };
    row.trades++;
    if ((t.pnl ?? 0) > 0) row.wins++; else if ((t.pnl ?? 0) < 0) row.losses++;
    row.pnl += t.pnl ?? 0;
    byDay.set(d, row);
  }
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const best = days.reduce<{ date: string; pnl: number } | null>((b, d) => !b || d.pnl > b.pnl ? { date: d.date, pnl: d.pnl } : b, null);
  const worst = days.reduce<{ date: string; pnl: number } | null>((b, d) => !b || d.pnl < b.pnl ? { date: d.date, pnl: d.pnl } : b, null);
  return { days, best, worst, totalDays: days.length, totalPnl: days.reduce((s, d) => s + d.pnl, 0) };
}

async function buildTradeJournal(userId: number, req: ReportRequest) {
  const journal = await loadJournal(userId, req);
  return journal.map((j) => ({
    id: j.id, tradeId: j.tradeId, symbol: j.symbol, direction: j.direction,
    strategyUsed: j.strategyUsed, setupType: j.setupType,
    confidenceLevel: j.confidenceLevel,
    mistakeTags: j.mistakeTags, strengthTags: j.strengthTags,
    lessonLearned: j.lessonLearned, followUpGoal: j.followUpGoal,
    createdAt: j.createdAt,
  }));
}

async function buildAiTradeReviews(userId: number, req: ReportRequest) {
  const reviews = await loadReviews(userId, req);
  return reviews.map((r) => ({
    id: r.id, paperTradeId: r.paperTradeId,
    overallGrade: r.overallGrade, overallScore: r.overallScore,
    setupGrade: r.setupGrade, entryGrade: r.entryGrade, exitGrade: r.exitGrade,
    riskGrade: r.riskGrade, disciplineGrade: r.disciplineGrade,
    strengths: r.strengths, weaknesses: r.weaknesses, mistakeTags: r.mistakeTags,
    improvementPlan: r.improvementPlan, nextTradeFocus: r.nextTradeFocus,
    createdAt: r.createdAt,
  }));
}

async function buildRiskGovernor(userId: number, req: ReportRequest) {
  const [settings, events] = await Promise.all([loadRiskSettings(userId), loadRiskEvents(userId, req)]);
  const blocked = events.filter((e) => e.decision === "block").length;
  const warnings = events.filter((e) => e.decision === "warning").length;
  const liveBlocked = events.filter((e) => e.eventType === "live_execution_blocked").length;
  return {
    settings: stripSecrets(settings),
    summary: { totalEvents: events.length, blocked, warnings, liveExecutionBlocked: liveBlocked },
    events: events.map((e) => ({
      id: e.id, eventType: e.eventType, severity: e.severity, decision: e.decision,
      reason: e.reason, paperTradeId: e.paperTradeId, tradingSessionId: e.tradingSessionId,
      overrideReason: e.overrideReason, createdAt: e.createdAt,
    })),
  };
}

async function buildPlaybookPerformance(userId: number, req: ReportRequest) {
  const [playbooks, rules, checks, trades] = await Promise.all([
    loadPlaybooks(userId), loadPlaybookRules(userId), loadPreTradeChecks(userId), loadPaperTrades(userId, req),
  ]);
  return playbooks.map((p) => {
    const pChecks = checks.filter((c) => c.playbookId === p.id);
    const passed = pChecks.filter((c) => c.decision === "pass").length;
    const linkedTradeIds = new Set(pChecks.map((c) => c.paperTradeId).filter((x): x is number => x != null));
    const linkedTrades = trades.filter((t) => linkedTradeIds.has(t.id));
    const closed = linkedTrades.filter((t) => t.status === "closed");
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    return {
      id: p.id, title: p.title, status: p.status, strategyType: p.strategyType,
      ruleCount: rules.filter((r) => r.playbookId === p.id).length,
      checklistPassRate: pChecks.length ? +(100 * passed / pChecks.length).toFixed(1) : 0,
      linkedTrades: linkedTrades.length,
      wins, losses: closed.length - wins,
      improvementSuggestion: closed.length === 0 ? "Run paper trades against this playbook to gather data."
        : wins / closed.length < 0.4 ? "Win rate <40% — review entry rules."
        : "Performance acceptable — keep refining.",
    };
  });
}

async function buildCoachingSummary(userId: number, req: ReportRequest) {
  const [reviews, journal, riskEvents] = await Promise.all([
    loadReviews(userId, req), loadJournal(userId, req), loadRiskEvents(userId, req),
  ]);
  const tagCount = (rs: Array<{ mistakeTags?: unknown }>) => {
    const m = new Map<string, number>();
    for (const r of rs) for (const t of (r.mistakeTags as string[] | undefined) ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag, count]) => ({ tag, count }));
  };
  const strengthCount = (rs: Array<{ strengths?: unknown; strengthTags?: unknown }>) => {
    const m = new Map<string, number>();
    for (const r of rs) for (const t of ((r.strengths ?? r.strengthTags) as string[] | undefined) ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag, count]) => ({ tag, count }));
  };
  return {
    topStrengths: strengthCount([...reviews, ...journal]),
    topMistakes: tagCount([...reviews, ...journal]),
    weeklyGoal: reviews.length === 0 ? "Close 3 journaled paper trades this week." : "Keep mistake count below 2 per session.",
    recommendedFocus: reviews[0]?.nextTradeFocus ?? journal[0]?.followUpGoal ?? "Define one entry rule and stick to it.",
    riskRuleSuggestion: riskEvents.filter((e) => e.decision === "block").length > 0
      ? "Tighten daily loss cap or per-trade risk %."
      : "Current risk caps are holding.",
    journalingPrompt: "What did the market show me today that surprised me, and what will I do differently?",
  };
}

async function buildFullArchive(userId: number, req: ReportRequest) {
  const [sessions, paperSessions, trades, journal, reviews, risk, playbooks, rules, checks, calendar] = await Promise.all([
    loadSessions(userId, req), loadPaperSessions(userId), loadPaperTrades(userId, req),
    req.includeJournal !== false ? loadJournal(userId, req) : Promise.resolve([]),
    req.includeAIReviews !== false ? loadReviews(userId, req) : Promise.resolve([]),
    req.includeRiskEvents !== false ? loadRiskEvents(userId, req) : Promise.resolve([]),
    req.includePlaybooks !== false ? loadPlaybooks(userId) : Promise.resolve([]),
    req.includePlaybooks !== false ? loadPlaybookRules(userId) : Promise.resolve([]),
    req.includePlaybooks !== false ? loadPreTradeChecks(userId) : Promise.resolve([]),
    req.includeCalendar !== false ? buildPerformanceCalendar(userId, req) : Promise.resolve(null),
  ]);
  const activity = req.includeNotifications === true ? await loadActivity(userId, req) : [];
  return {
    sessions, paperSessions, paperTrades: trades, journal, aiReviews: reviews,
    riskEvents: risk, playbooks, playbookRules: rules, preTradeChecks: checks,
    performanceCalendar: calendar, activityTimelineSummary: activity.length,
  };
}

// ── Format helpers ────────────────────────────────────────────────────────
function flattenForCsv(reportType: ReportType, payload: unknown): { rows: Array<Record<string, unknown>>; columns?: string[] } {
  if (Array.isArray(payload)) return { rows: payload as Array<Record<string, unknown>> };
  if (reportType === "performance_calendar" && payload && typeof payload === "object") {
    const p = payload as { days: Array<Record<string, unknown>> };
    return { rows: p.days, columns: ["date", "trades", "wins", "losses", "pnl"] };
  }
  if (reportType === "risk_governor" && payload && typeof payload === "object") {
    return { rows: ((payload as { events: Array<Record<string, unknown>> }).events) ?? [] };
  }
  if (reportType === "trading_session_summary" && payload && typeof payload === "object") {
    return { rows: ((payload as { sessions: Array<Record<string, unknown>> }).sessions) ?? [] };
  }
  // Fallback: single-row CSV
  return { rows: [payload as Record<string, unknown>] };
}

function buildHtml(reportType: ReportType, title: string, payload: unknown, req: ReportRequest): string {
  const head = htmlHeader(title, { start: req.dateRangeStart ?? null, end: req.dateRangeEnd ?? null });
  let body = "";
  const flat = flattenForCsv(reportType, payload);
  if (Array.isArray(payload) || reportType === "performance_calendar" || reportType === "risk_governor" || reportType === "trading_session_summary") {
    body += htmlSection("Records", htmlTable(flat.rows, flat.columns));
  } else if (reportType === "full_trading_archive" && payload && typeof payload === "object") {
    const arc = payload as Record<string, Array<Record<string, unknown>> | unknown>;
    for (const [k, v] of Object.entries(arc)) {
      if (Array.isArray(v)) body += htmlSection(k, htmlTable(v as Array<Record<string, unknown>>));
      else body += htmlSection(k, `<pre>${escapeHtml(JSON.stringify(v, null, 2))}</pre>`);
    }
  } else {
    body += `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
  }
  body += `<div class="meta">Note: PDF rendering can be added later via a lightweight server-side library. This HTML report is print-ready.</div>`;
  return head + body + htmlFooter();
}

// ── Public entry point ────────────────────────────────────────────────────
export async function generateReport(userId: number, req: ReportRequest): Promise<BuildResult> {
  if (!REPORT_TYPES.includes(req.reportType)) throw Object.assign(new Error("invalid reportType"), { status: 400 });
  if (!REPORT_FORMATS.includes(req.format)) throw Object.assign(new Error("invalid format"), { status: 400 });
  if (req.dateRangeStart && req.dateRangeEnd && req.dateRangeStart > req.dateRangeEnd) {
    throw Object.assign(new Error("dateRangeStart must be ≤ dateRangeEnd"), { status: 400 });
  }
  // Verify session ownership if provided
  if (req.tradingSessionId != null) {
    const s = await db.select().from(tradingSessionsTable)
      .where(and(eq(tradingSessionsTable.id, req.tradingSessionId), eq(tradingSessionsTable.userId, userId))).limit(1);
    if (!s[0]) throw Object.assign(new Error("Session not found or not yours"), { status: 404 });
  }

  let payload: unknown;
  switch (req.reportType) {
    case "account_summary": payload = await buildAccountSummary(userId, req); break;
    case "trading_session_summary": payload = await buildTradingSessionSummary(userId, req); break;
    case "paper_trades": payload = await buildPaperTradesReport(userId, req); break;
    case "performance_calendar": payload = await buildPerformanceCalendar(userId, req); break;
    case "trade_journal": payload = await buildTradeJournal(userId, req); break;
    case "ai_trade_reviews": payload = await buildAiTradeReviews(userId, req); break;
    case "risk_governor": payload = await buildRiskGovernor(userId, req); break;
    case "playbook_performance": payload = await buildPlaybookPerformance(userId, req); break;
    case "coaching_summary": payload = await buildCoachingSummary(userId, req); break;
    case "full_trading_archive": payload = await buildFullArchive(userId, req); break;
  }

  // Defensive: scrub the payload one more time before serialization.
  payload = stripSecrets(payload);
  const meta = { brand: BRAND, disclaimer: DISCLAIMER, generatedAt: new Date().toISOString(),
    dateRange: { start: req.dateRangeStart ?? null, end: req.dateRangeEnd ?? null },
    reportType: req.reportType, format: req.format };

  const title = `${BRAND} — ${req.reportType.replace(/_/g, " ")}`;
  const baseName = sanitizeFileName(`${req.reportType}_${new Date().toISOString().slice(0, 10)}`);

  if (req.format === "json") {
    const wrapper = { meta, data: payload };
    const body = JSON.stringify(wrapper, null, 2);
    const rowCount = Array.isArray(payload) ? payload.length : 1;
    return { body, mimeType: "application/json", fileName: `${baseName}.json`, rowCount };
  }
  if (req.format === "csv") {
    const flat = flattenForCsv(req.reportType, payload);
    const banner = `# ${BRAND}\n# ${DISCLAIMER}\n# Generated: ${meta.generatedAt}\n# Range: ${meta.dateRange.start ?? "—"} to ${meta.dateRange.end ?? "—"}\n`;
    const body = banner + toCsv(flat.rows, flat.columns);
    return { body, mimeType: "text/csv", fileName: `${baseName}.csv`, rowCount: flat.rows.length };
  }
  // html (also serves as PDF fallback on the route)
  const body = buildHtml(req.reportType, title, payload, req);
  const rowCount = Array.isArray(payload) ? payload.length : 1;
  return { body, mimeType: "text/html", fileName: `${baseName}.html`, rowCount };
}
