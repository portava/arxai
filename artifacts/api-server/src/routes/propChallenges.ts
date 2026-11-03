// (R) Build R — Prop Firm Challenge Mode routes.
//
// SIMULATED. Reads paper_orders (Build Q) only. Never touches live trades,
// /execute-trade, mt5_*, safetyCore, or canPlaceTrades. Practice/training only;
// no funded-account approval is promised.

import { Router } from "express";
import {
  db, propChallengesTable, propChallengeDaysTable, propChallengeViolationsTable,
  paperAccountsTable, paperOrdersTable, vaultEventsTable,
} from "@workspace/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { notify } from "../lib/notifications/service.js";
import { buildPropFirmAlert, violationToAlertKind } from "../lib/notifications/propFirmAlerts.js";
import { isUnsizedPaperClose, paperLedgerModelPnl } from "../lib/paperExecution/paperRiskCount.js";

const router = Router();
// Phase 18A — every prop-challenge route is now per-user. No row created
// without userId, no row read or mutated without an ownership check.
router.use("/prop-challenges", requireUser);

async function ownChallenge(id: number, userId: number) {
  const rows = await db.select().from(propChallengesTable)
    .where(and(eq(propChallengesTable.id, id), eq(propChallengesTable.userId, userId)))
    .limit(1);
  return rows[0];
}
const SIMULATED_TAG = "Practice/training only — Prop Challenge Mode is simulated and does not promise funded-account approval or guaranteed profits.";

function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, simulated: true, disclaimer: SIMULATED_TAG });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), simulated: true, disclaimer: SIMULATED_TAG });
}

async function vaultBehavior(kind: string, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity: "INFO", source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload: { ...payload, simulated: true, disclaimer: SIMULATED_TAG },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

// ── Validation ─────────────────────────────────────────────────────────────
const CreateChallengeBody = z.object({
  paperAccountId: z.number().int().positive(),
  challengeName: z.string().min(1).max(64).default("Practice Challenge"),
  startingBalance: z.number().positive().default(10_000),
  profitTarget: z.number().positive().max(1).default(0.10),
  maxDailyLoss: z.number().positive().max(1).default(0.05),
  maxTotalDrawdown: z.number().positive().max(1).default(0.10),
  minTradingDays: z.number().int().positive().max(365).default(5),
  maxTradingDays: z.number().int().positive().max(365).default(30),
  consistencyRulePercent: z.number().positive().max(1).default(0.40),
  // Phase 27-B extended rules (all optional; safe defaults preserve current behavior).
  trailingDrawdownEnabled: z.boolean().default(false),
  trailingDrawdownAmount: z.number().positive().max(1).default(0.05),
  trailingDrawdownType: z.enum(["STATIC", "TRAILING"]).default("STATIC"),
  // PERMISSIVE defaults (effectively unlimited) — opt-in via PATCH /rules.
  maxRiskPerTrade: z.number().positive().max(1).default(1.0),
  maxOpenTrades: z.number().int().positive().max(100).default(100),
  maxPendingOrders: z.number().int().positive().max(100).default(100),
  maxPositionSize: z.number().positive().max(100).default(100),
  newsTradingAllowed: z.boolean().default(true),
  weekendHoldingAllowed: z.boolean().default(true),
  overnightHoldingAllowed: z.boolean().default(true),
  strictGuardrailsEnabled: z.boolean().default(false),
});

const UpdateStatusBody = z.object({
  status: z.enum(["PAUSED", "ACTIVE", "CANCELED"]),
});

const UpdateRulesBody = z.object({
  trailingDrawdownEnabled: z.boolean().optional(),
  trailingDrawdownAmount: z.number().positive().max(1).optional(),
  trailingDrawdownType: z.enum(["STATIC", "TRAILING"]).optional(),
  maxRiskPerTrade: z.number().positive().max(1).optional(),
  maxOpenTrades: z.number().int().positive().max(100).optional(),
  maxPendingOrders: z.number().int().positive().max(100).optional(),
  maxPositionSize: z.number().positive().max(100).optional(),
  newsTradingAllowed: z.boolean().optional(),
  weekendHoldingAllowed: z.boolean().optional(),
  overnightHoldingAllowed: z.boolean().optional(),
  strictGuardrailsEnabled: z.boolean().optional(),
});

// ── Evaluator: deterministic from paper_orders + challenge rules ───────────
interface Eval {
  daysWorked: number;
  totalPnl: number;
  totalPct: number;
  peakBalance: number;
  maxDrawdownPct: number;
  worstDayPct: number;
  worstDayDate: string | null;
  bestDayPnl: number;
  consistencyTopShare: number; // single-day P&L / total P&L (capped at 1)
  tradeCount: number;
  daysSinceStart: number;
  days: Array<{
    tradeDate: string;
    startingBalance: number;
    endingBalance: number;
    dailyProfitLoss: number;
    dailyLossPercent: number;
    tradesTaken: number;
    rulesViolated: string[];
  }>;
  violations: Array<{ type: string; severity: "INFO"|"WARN"|"HARD"; message: string }>;
  resolvedStatus: "ACTIVE" | "PASSED" | "FAILED";
  failureReason: string | null;
  /** True for a finished challenge (PASSED, FAILED, CANCELED): judged only up to its end. */
  final: boolean;
  /** The end of the evaluated window (ISO): completedAt for a finished challenge, now otherwise. */
  evaluatedThrough: string;
  /** Open paper positions at evaluation time. Their floating P&L is not on
   *  the row and is not read, so drawdown / daily loss leave them out.
   *  Always 0 for a finished challenge, which is judged on closed trades up
   *  to its end. */
  openPositionsNotCounted: number;
  /** Closed trades whose P&L could not be sized (the stored 0 placeholder). */
  unsizedCloses: number;
  /** Plain-English disclosure of unsizedCloses; null when there are none. */
  unsizedClosesNote: string | null;
  /**
   * The pass and fail rules are checked on two complete running balances:
   * the booked one (the figures above: totalPnl, maxDrawdownPct, ...) and
   * this one, each closed trade at the paper risk model (price move × lots ×
   * 100, the figure every paper close was booked at in 16c8a1a0). A breach
   * on either fails the challenge; a pass needs both.
   */
  ruleBasis: {
    basis: "PAPER_RISK_MODEL";
    totalPnl: number; totalPct: number; maxDrawdownPct: number;
    worstDayPct: number; worstDayDate: string | null; consistencyTopShare: number;
  };
  /** Says how the paper-risk-model figures differ from the booked ones; null when they agree. */
  ruleBasisNote: string | null;
  /** Why an ACTIVE challenge whose booked figures meet every pass rule is not PASSED; null otherwise. */
  passBlockedReason: string | null;
}

// A challenge in one of these states is over. It is judged on what happened
// up to its end, never on trades or days after it.
const FINISHED_STATUSES: ReadonlySet<string> = new Set(["PASSED", "FAILED", "CANCELED"]);
function isFinishedChallenge(status: string): boolean {
  return FINISHED_STATUSES.has(status);
}

export const RISK_PER_TRADE_NOTE =
  "Max risk per trade is checked on each closed trade's realised loss against that day's starting balance. " +
  "Risk at entry (stop-loss distance) is not measured, so a trade that risked more but closed at a small loss or a profit is not flagged.";

/** Drawdown, trailing drawdown and daily loss are a running balance of
 *  realised P&L from closed paper orders; open positions are not marked to
 *  market. A finished challenge is judged on closed trades up to its end, so
 *  it does not count (or claim the absence of) positions open now. */
export function closedTradeDrawdownNote(openPositions: number, final = false, trailing = false): string {
  const base = trailing
    ? "Drawdown, trailing drawdown and daily loss are measured from closed demo trades only."
    : "Drawdown and daily loss are measured from closed demo trades only.";
  if (final) return `${base} This challenge is finished, so only trades closed by its end count; open positions are not counted.`;
  if (openPositions <= 0) return `${base} No positions were open when this was evaluated.`;
  const n = openPositions === 1 ? "1 open position is" : `${openPositions} open positions are`;
  return `${base} ${n} not counted, so their floating profit or loss is not in these figures.`;
}

type ChallengeOrder = typeof paperOrdersTable.$inferSelect;

/**
 * The pass and fail rules are checked on two complete running balances over
 * the same closed trades, each with its own peak and daily window, never on a
 * per-trade mix of them (a mix can fall below both, e.g. a 1-unit index
 * contract's wins at the booked figure and its losses at the model):
 *   - BOOKED: each trade's stored P&L, the figures shown and the figure the
 *     evaluator read before the paper risk count (dbefac1c). A close whose
 *     P&L could not be sized stores 0 and counts 0 here.
 *   - PAPER_RISK_MODEL: each trade at price move × lots × 100, the figure
 *     every paper close was booked at before contract sizing (16c8a1a0); the
 *     stored figure when no exit price is recorded. An unsized close counts
 *     at its price move here.
 * A breach on either basis fails the challenge; a pass needs both to meet
 * the target and every rule, and no unsized close. So the result is never
 * more lenient than either basis, and never stricter than the stricter one.
 */
const bookedFigure = (o: ChallengeOrder): number => o.profitLoss;
/** The paper risk model figure (price move × lots × 100); the stored figure when there is no exit price. */
const modelFigure = (o: ChallengeOrder): number => o.exitPrice == null
  ? o.profitLoss
  : paperLedgerModelPnl(o.direction, Math.abs(o.lotSize || 1), o.entryPrice, o.exitPrice);
const BOOKED_CLAUSE = "each closed trade counted at its booked P&L";
const MODEL_CLAUSE = "each closed trade counted at the paper risk model, price move × lots × 100";
const BOTH_CLAUSE = "both with each closed trade counted at its booked P&L and with each counted at the paper risk model, price move × lots × 100";

/** One complete running balance the pass and fail rules are checked on. */
interface RuleBasisWalk {
  key: "BOOKED" | "PAPER_RISK_MODEL";
  clause: string;
  figure: (o: ChallengeOrder) => number;
  balance: number;
  peak: number;
  maxDrawdownPct: number;
  worstDayPct: number;
  worstDayDate: string | null;
  dayPnls: number[];
  /** The current day: its starting balance, P&L and loss as a share of the start. */
  dayStart: number;
  dayPnl: number;
  dayLossPct: number;
}
function ruleBasisWalk(key: RuleBasisWalk["key"], clause: string, figure: RuleBasisWalk["figure"], start: number): RuleBasisWalk {
  return {
    key, clause, figure, balance: start, peak: start, maxDrawdownPct: 0, worstDayPct: 0, worstDayDate: null,
    dayPnls: [], dayStart: start, dayPnl: 0, dayLossPct: 0,
  };
}
type RuleLevel = "HARD" | "WARN" | "INFO" | null;
interface BasisCheck { b: RuleBasisWalk; value: number; level: RuleLevel }
/**
 * The clause naming the bases a result holds on: none when both bases count
 * every trade the same, one basis, or both.
 */
function basesClause(hit: readonly RuleBasisWalk[], basisDiffers: boolean): string {
  if (!basisDiffers || hit.length === 0) return "";
  return ` (${hit.length > 1 ? BOTH_CLAUSE : hit[0]!.clause})`;
}
/**
 * Reports one rule check on both bases: once when both give the same figure
 * at the same level, otherwise once per basis that reached a level, each
 * naming its basis.
 */
function onBases(checks: readonly BasisCheck[], basisDiffers: boolean, emit: (value: number, level: Exclude<RuleLevel, null>, clause: string) => void): void {
  const hits = checks.filter((c) => c.level !== null);
  if (hits.length === 2 && hits[0]!.level === hits[1]!.level && Math.abs(hits[0]!.value - hits[1]!.value) < 1e-12) {
    emit(hits[0]!.value, hits[0]!.level!, basesClause(hits.map((c) => c.b), basisDiffers));
    return;
  }
  for (const c of hits) emit(c.value, c.level!, basesClause([c.b], basisDiffers));
}

/** Largest single positive day's share of the total positive-day profit (0 when none). */
function consistencyOf(dayPnls: number[]): { share: number; totalPositive: number } {
  const positive = dayPnls.filter((p) => p > 0);
  const totalPositive = positive.reduce((s, p) => s + p, 0);
  const top = positive.reduce((m, p) => Math.max(m, p), 0);
  return { share: totalPositive > 0 ? top / totalPositive : 0, totalPositive };
}

/** The disclosure for closes whose P&L could not be sized, in the Ruby prop-firm tool's words. */
export function unsizedChallengeClosesNote(unsized: Array<{ symbol: string }>): string | null {
  const n = unsized.length;
  if (n === 0) return null;
  const symbols = [...new Set(unsized.map((o) => o.symbol).filter(Boolean))].sort();
  return `${n} closed paper trade${n === 1 ? "" : "s"}${symbols.length ? ` (${symbols.join(", ")})` : ""} could not be sized for the instrument (no contract size or currency conversion), so ${n === 1 ? "its" : "their"} P&L is not known and is left out of the balance, profit, daily loss and drawdown shown here. `
    + `The pass and fail rules are also checked with every closed trade counted at the paper risk model (price move × lots × 100), which does count ${n === 1 ? "its" : "their"} price move, and the challenge cannot pass while any closed trade is unsized.`;
}

async function evaluateChallenge(challengeId: number): Promise<Eval | null> {
  const ch = (await db.select().from(propChallengesTable)
    .where(eq(propChallengesTable.id, challengeId)).limit(1))[0];
  if (!ch) return null;

  // Pull all closed paper orders for this challenge's paper account, after start.
  // Defense-in-depth (Phase 18A): also filter by ch.userId so a challenge can
  // never aggregate another user's orders even if a paperAccountId somehow
  // points outside the owner. ACTIVE challenges always have userId set; if
  // null (legacy), restrict to NULL userId rows to avoid cross-user bleed.
  const orderWhere = ch.userId == null
    ? and(eq(paperOrdersTable.paperAccountId, ch.paperAccountId), sql`${paperOrdersTable.userId} IS NULL`)
    : and(eq(paperOrdersTable.paperAccountId, ch.paperAccountId), eq(paperOrdersTable.userId, ch.userId));
  const orders = await db.select().from(paperOrdersTable)
    .where(orderWhere)
    .orderBy(asc(paperOrdersTable.openedAt));
  // A finished challenge ends at completedAt (updatedAt for an older row that
  // has none: status changes stamp it, and a finished challenge's rules cannot
  // be edited). Trades closed after the end are not part of the challenge.
  const final = isFinishedChallenge(ch.status);
  const endAt: Date = final ? (ch.completedAt ?? ch.updatedAt ?? new Date()) : new Date();
  const closed = orders.filter((o) => o.status !== "OPEN" && o.closedAt && o.closedAt >= ch.startedAt
    && (!final || o.closedAt <= endAt));

  // Bucket by UTC date.
  const byDay = new Map<string, typeof closed>();
  for (const o of closed) {
    const d = (o.closedAt as Date).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(o);
  }
  const sortedDates = [...byDay.keys()].sort();

  // The booked running balance (each trade's stored P&L) is what the summary
  // and day rows show. The pass and fail rules below are checked on two
  // complete running balances, the booked one and the paper risk model one
  // (see bookedFigure / modelFigure): a breach on either fails, a pass needs
  // both. Each keeps its own peak and daily window; trades are never mixed
  // across them.
  let runningBalance = ch.startingBalance;
  let peakBalance = ch.startingBalance;
  let maxDrawdownPct = 0;
  let worstDayPct = 0;
  let worstDayDate: string | null = null;
  let bestDayPnl = -Infinity;
  const booked = ruleBasisWalk("BOOKED", BOOKED_CLAUSE, bookedFigure, ch.startingBalance);
  const model = ruleBasisWalk("PAPER_RISK_MODEL", MODEL_CLAUSE, modelFigure, ch.startingBalance);
  const bases = [booked, model];
  const days: Eval["days"] = [];
  const violations: Eval["violations"] = [];
  // When the two bases count some trade differently, every rule message and
  // the failure reason name the basis they hold on.
  const basisDiffers = closed.some((o) => modelFigure(o) !== bookedFigure(o));
  // A loss on a day that starts with nothing left is more than the whole
  // balance, never a negative percentage.
  const lossPctOf = (start: number, loss: number) => start > 0 ? Math.abs(loss) / start : 1 + Math.abs(loss) / ch.startingBalance;
  const levelOf = (value: number, limit: number, over: RuleLevel, near: RuleLevel): RuleLevel =>
    value > limit ? over : value > limit * 0.8 ? near : null;

  // Hard fail tracking: the first rule breached, naming the basis it breached on.
  let hardFail: string | null = null;
  const failOn = (what: string, checks: readonly BasisCheck[]) => {
    const hit = checks.filter((c) => c.level === "HARD").map((c) => c.b);
    if (hit.length > 0 && !hardFail) hardFail = `${what}${basesClause(hit, basisDiffers)}`;
  };

  for (const date of sortedDates) {
    const dayOrders = byDay.get(date)!;
    const dayPnl = dayOrders.reduce((s, o) => s + o.profitLoss, 0);
    const startBal = runningBalance;
    const endBal = runningBalance + dayPnl;
    const dayLossPct = dayPnl < 0 ? Math.abs(dayPnl) / startBal : 0;
    for (const b of bases) {
      b.dayStart = b.balance;
      b.dayPnl = dayOrders.reduce((s, o) => s + b.figure(o), 0);
      b.dayLossPct = b.dayPnl < 0 ? lossPctOf(b.dayStart, b.dayPnl) : 0;
      b.dayPnls.push(b.dayPnl);
    }

    const dayRules: string[] = [];

    // Phase 27-B: Max risk per trade (per-trade loss vs day-start balance).
    // Per-trade, never fabricated — each trade on each basis against that
    // basis's day-start balance. This is the REALISED loss after close; risk
    // at entry (stop-loss distance) is not measured, so a trade that risked
    // more but closed at a small loss or a profit raises nothing. Messages and
    // the summary say so.
    if (startBal > 0) {
      for (const o of dayOrders) {
        const risk: BasisCheck[] = bases.map((b) => {
          const v = b.figure(o);
          const value = v < 0 ? lossPctOf(b.dayStart, v) : 0;
          return { b, value, level: levelOf(value, ch.maxRiskPerTrade, "WARN", "INFO") };
        });
        if (risk.some((c) => c.level === "WARN")) dayRules.push("MAX_RISK_PER_TRADE");
        onBases(risk, basisDiffers, (pct, level, clause) => violations.push({
          type: "MAX_RISK_PER_TRADE", severity: level,
          message: level === "WARN"
            ? `Trade #${o.id} realised loss ${(pct*100).toFixed(2)}% of the day's starting balance exceeds the max-risk-per-trade limit ${(ch.maxRiskPerTrade*100).toFixed(2)}% on ${date} (checked after close; risk at entry is not measured)${clause}`
            : `Trade #${o.id} realised loss ${(pct*100).toFixed(2)}% of the day's starting balance is approaching the max-risk-per-trade limit ${(ch.maxRiskPerTrade*100).toFixed(2)}% on ${date} (checked after close; risk at entry is not measured)${clause}`,
        }));
        // Position size rule (lots).
        if (o.lotSize > ch.maxPositionSize) {
          violations.push({
            type: "MAX_POSITION_SIZE", severity: "WARN",
            message: `Trade #${o.id} size ${o.lotSize} lots exceeds max position size ${ch.maxPositionSize} on ${date}`,
          });
        } else if (o.lotSize > ch.maxPositionSize * 0.8) {
          violations.push({
            type: "MAX_POSITION_SIZE", severity: "INFO",
            message: `Trade #${o.id} size ${o.lotSize} lots approaching max position size ${ch.maxPositionSize} on ${date}`,
          });
        }
      }
    }

    // Daily-loss rule, on each basis.
    const daily: BasisCheck[] = bases.map((b) => ({ b, value: b.dayLossPct, level: levelOf(b.dayLossPct, ch.maxDailyLoss, "HARD", "WARN") }));
    if (daily.some((c) => c.level === "HARD")) dayRules.push("DAILY_LOSS");
    failOn("Daily loss limit exceeded", daily);
    onBases(daily, basisDiffers, (pct, level, clause) => violations.push({
      type: "DAILY_LOSS", severity: level,
      message: level === "HARD"
        ? `Closed-trade daily loss ${(pct*100).toFixed(2)}% on ${date} exceeds limit ${(ch.maxDailyLoss*100).toFixed(2)}%${clause}`
        : `Closed-trade daily loss ${(pct*100).toFixed(2)}% approaching limit ${(ch.maxDailyLoss*100).toFixed(2)}% on ${date}${clause}`,
    }));

    // Overtrading: > 20 trades in a day is a soft warning.
    if (dayOrders.length > 20) {
      dayRules.push("OVERTRADING");
      violations.push({
        type: "OVERTRADING", severity: "WARN",
        message: `Overtrading: ${dayOrders.length} trades on ${date}`,
      });
    }

    // Drawdown from peak — of the realised (closed-trade) balance only; open
    // positions are not marked to market here (see closedTradeDrawdownNote).
    runningBalance = endBal;
    peakBalance = Math.max(peakBalance, runningBalance);
    const ddPct = (peakBalance - runningBalance) / peakBalance;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    for (const b of bases) {
      b.balance = b.dayStart + b.dayPnl;
      b.peak = Math.max(b.peak, b.balance);
      const bDd = (b.peak - b.balance) / b.peak;
      if (bDd > b.maxDrawdownPct) b.maxDrawdownPct = bDd;
    }
    const drawdown: BasisCheck[] = bases.map((b) => ({ b, value: b.maxDrawdownPct, level: levelOf(b.maxDrawdownPct, ch.maxTotalDrawdown, "HARD", "WARN") }));
    failOn("Max total drawdown exceeded", drawdown);
    onBases(drawdown, basisDiffers, (pct, level, clause) => violations.push({
      type: "TOTAL_DRAWDOWN", severity: level,
      message: level === "HARD"
        ? `Closed-trade drawdown ${(pct*100).toFixed(2)}% exceeds limit ${(ch.maxTotalDrawdown*100).toFixed(2)}% on ${date}${clause}`
        : `Closed-trade drawdown ${(pct*100).toFixed(2)}% approaching limit ${(ch.maxTotalDrawdown*100).toFixed(2)}%${clause}`,
    }));

    if (dayLossPct > worstDayPct) { worstDayPct = dayLossPct; worstDayDate = date; }
    for (const b of bases) {
      if (b.dayLossPct > b.worstDayPct) { b.worstDayPct = b.dayLossPct; b.worstDayDate = date; }
    }
    if (dayPnl > bestDayPnl) bestDayPnl = dayPnl;

    days.push({
      tradeDate: date, startingBalance: startBal, endingBalance: endBal,
      dailyProfitLoss: dayPnl, dailyLossPercent: dayLossPct,
      tradesTaken: dayOrders.length, rulesViolated: dayRules,
    });
  }

  const totalPnl = runningBalance - ch.startingBalance;
  const totalPct = totalPnl / ch.startingBalance;
  const totalPctOf = (b: RuleBasisWalk) => (b.balance - ch.startingBalance) / ch.startingBalance;
  const modelTotalPnl = model.balance - ch.startingBalance;
  const modelTotalPct = totalPctOf(model);
  const daysWorked = sortedDates.length;
  // The day count stops at the end of a finished challenge.
  const daysSinceStart = Math.max(1, Math.ceil((endAt.getTime() - ch.startedAt.getTime()) / 86_400_000));

  // Time-limit (max trading days) — HARD terminal rule. Even if profit target
  // is reached later, the challenge must be passed WITHIN maxTradingDays. If
  // exceeded → FAIL regardless of current profit (architect fix #1).
  if (daysSinceStart > ch.maxTradingDays) {
    if (!hardFail) hardFail = "Max trading days exceeded";
    violations.push({
      type: "TIME_LIMIT", severity: "HARD",
      message: `Day ${daysSinceStart} > maxTradingDays ${ch.maxTradingDays} (profit ${(totalPct*100).toFixed(2)}%)`,
    });
  }

  // ── Phase 27-B: Trailing drawdown rule ─────────────────────────────
  // STATIC = drawdown from starting balance; TRAILING = drawdown from peak.
  // Same closed-trade running balances as total drawdown: open positions are
  // not marked to market, so the messages say "Closed-trade".
  if (ch.trailingDrawdownEnabled === 1) {
    // Checked on each basis, against its own peak.
    const trailing: BasisCheck[] = bases.map((b) => {
      const tdRef = ch.trailingDrawdownType === "TRAILING" ? b.peak : ch.startingBalance;
      const value = tdRef > 0 ? (tdRef - b.balance) / tdRef : 0;
      return { b, value, level: levelOf(value, ch.trailingDrawdownAmount, "HARD", "WARN") };
    });
    failOn("Trailing drawdown exceeded", trailing);
    onBases(trailing, basisDiffers, (pct, level, clause) => violations.push({
      type: "TRAILING_DRAWDOWN", severity: level,
      message: level === "HARD"
        ? `Closed-trade trailing drawdown ${(pct*100).toFixed(2)}% (${ch.trailingDrawdownType}) exceeds limit ${(ch.trailingDrawdownAmount*100).toFixed(2)}%${clause}`
        : `Closed-trade trailing drawdown ${(pct*100).toFixed(2)}% (${ch.trailingDrawdownType}) approaching limit ${(ch.trailingDrawdownAmount*100).toFixed(2)}%${clause}`,
    }));
  }

  // ── Phase 27-B: Max open trades + max pending orders ───────────────
  // OPEN paper orders = currently open positions. Paper schema has no
  // PENDING status (LIMIT orders fill immediately at entryPrice), so
  // pending-orders rule cannot be evaluated honestly today → INSUFFICIENT_DATA.
  // Rules about positions open now say nothing about a finished challenge.
  const openOrders = final ? [] : orders.filter((o) => o.status === "OPEN");
  if (openOrders.length >= ch.maxOpenTrades) {
    violations.push({
      type: "MAX_OPEN_TRADES",
      severity: openOrders.length > ch.maxOpenTrades ? "HARD" : "WARN",
      message: `${openOrders.length} open trades >= max open trades ${ch.maxOpenTrades}`,
    });
  } else if (openOrders.length > ch.maxOpenTrades * 0.8) {
    violations.push({
      type: "MAX_OPEN_TRADES", severity: "INFO",
      message: `${openOrders.length} open trades approaching max ${ch.maxOpenTrades}`,
    });
  }
  // Pending orders — honest INSUFFICIENT_DATA, never fabricated.
  // (Recorded as INFO so the AI can surface it; not a violation.)
  violations.push({
    type: "MAX_PENDING_ORDERS", severity: "INFO",
    message: "Pending-order rule cannot be evaluated: paper schema has no PENDING status. INSUFFICIENT_DATA.",
  });

  // ── Phase 27-B: Weekend / Overnight holding (clock-based, no fabrication) ──
  const nowUtc = new Date();
  const isWeekendUtc = nowUtc.getUTCDay() === 0 || nowUtc.getUTCDay() === 6;
  if (ch.weekendHoldingAllowed === 0 && isWeekendUtc && openOrders.length > 0) {
    violations.push({
      type: "WEEKEND_RESTRICTION", severity: "WARN",
      message: `Weekend holding blocked but ${openOrders.length} paper position(s) open over weekend (UTC).`,
    });
  }
  if (ch.overnightHoldingAllowed === 0 && openOrders.length > 0) {
    const todayUtc = nowUtc.toISOString().slice(0, 10);
    const overnight = openOrders.filter((o) =>
      (o.openedAt as Date).toISOString().slice(0, 10) < todayUtc,
    );
    if (overnight.length > 0) {
      violations.push({
        type: "OVERNIGHT_RESTRICTION", severity: "WARN",
        message: `Overnight holding blocked but ${overnight.length} paper position(s) opened on a prior UTC day.`,
      });
    }
  }

  // ── Phase 27-B: News restriction — INSUFFICIENT_DATA (no news provider). ──
  if (ch.newsTradingAllowed === 0) {
    violations.push({
      type: "NEWS_RESTRICTION", severity: "INFO",
      message: "News-trading rule cannot be evaluated: news/current-events provider not connected. INSUFFICIENT_DATA.",
    });
  }

  // Consistency: largest single-day profit ≤ consistencyRulePercent of total
  // profit, on each basis. A breach on a basis that has reached the profit
  // target fails the challenge; a pass needs both within the rule.
  const positiveDays = days.filter((d) => d.dailyProfitLoss > 0);
  const totalPositive = positiveDays.reduce((s, d) => s + d.dailyProfitLoss, 0);
  const topDay = positiveDays.reduce((m, d) => Math.max(m, d.dailyProfitLoss), 0);
  const consistencyTopShare = totalPositive > 0 ? topDay / totalPositive : 0;
  const consistencyByBasis = bases.map((b) => ({ b, ...consistencyOf(b.dayPnls), reached: totalPctOf(b) >= ch.profitTarget }));
  const consistency: BasisCheck[] = consistencyByBasis.map((c) => ({
    b: c.b, value: c.share,
    level: c.totalPositive > 0 && c.share > ch.consistencyRulePercent ? (c.reached ? "HARD" : "WARN") : null,
  }));
  onBases(consistency, basisDiffers, (share, level, clause) => violations.push({
    type: "CONSISTENCY", severity: level,
    message: `Single best day = ${(share*100).toFixed(1)}% of profit, exceeds ${(ch.consistencyRulePercent*100).toFixed(0)}%${clause}`,
  }));
  failOn("Consistency rule violated at evaluation", consistency);
  const consistencyOk = consistencyByBasis.every((c) => c.share <= ch.consistencyRulePercent);
  const modelConsistency = consistencyByBasis[1]!;

  // Closes whose P&L could not be sized: the P&L is not known, so the
  // challenge cannot pass while any is in it (it stays ACTIVE, with the reason).
  const unsized = closed.filter((o) => o.status !== "CANCELLED" && isUnsizedPaperClose(o));
  const unsizedClosesNote = unsizedChallengeClosesNote(unsized);
  if (unsizedClosesNote) violations.push({ type: "UNSIZED_PNL", severity: "WARN", message: unsizedClosesNote });

  // Resolve status. The profit target must be met on both bases.
  let resolvedStatus: Eval["resolvedStatus"] = "ACTIVE";
  let failureReason: string | null = null;
  let passBlockedReason: string | null = null;
  const bookedPassRulesMet = totalPct >= ch.profitTarget && daysWorked >= ch.minTradingDays && consistencyTopShare <= ch.consistencyRulePercent;
  if (hardFail) {
    resolvedStatus = "FAILED";
    failureReason = hardFail;
  } else if (totalPctOf(booked) >= ch.profitTarget && modelTotalPct >= ch.profitTarget
    && daysWorked >= ch.minTradingDays && consistencyOk && unsized.length === 0) {
    resolvedStatus = "PASSED";
  } else if (bookedPassRulesMet) {
    const why: string[] = [];
    if (unsized.length > 0) why.push(`${unsized.length} closed trade${unsized.length === 1 ? "'s" : "s'"} P&L could not be sized, so the result is not known`);
    if (modelTotalPct < ch.profitTarget) why.push(`with ${MODEL_CLAUSE} the profit is ${(modelTotalPct*100).toFixed(2)}%, below the ${(ch.profitTarget*100).toFixed(2)}% target (booked ${(totalPct*100).toFixed(2)}%)`);
    if (!consistencyOk) why.push("the consistency rule is not met when the trades are counted at the paper risk model");
    passBlockedReason = `Not passed: ${why.join("; ")}.`;
  }

  const ruleBasis: Eval["ruleBasis"] = {
    basis: "PAPER_RISK_MODEL",
    totalPnl: modelTotalPnl, totalPct: modelTotalPct, maxDrawdownPct: model.maxDrawdownPct,
    worstDayPct: model.worstDayPct, worstDayDate: model.worstDayDate, consistencyTopShare: modelConsistency.share,
  };
  const pct = (x: number) => `${(x*100).toFixed(2)}%`;
  const ruleBasisNote = basisDiffers
    ? `The pass and fail rules are checked twice: with each closed trade counted at its booked P&L (the figures shown) and with each counted at the paper risk model (price move × lots × 100). A breach on either fails the challenge, and a pass needs both. At the paper risk model: profit ${pct(modelTotalPct)} (booked ${pct(totalPct)}), drawdown ${pct(model.maxDrawdownPct)} (booked ${pct(maxDrawdownPct)}), worst day ${pct(model.worstDayPct)} (booked ${pct(worstDayPct)}).`
    : null;

  return {
    daysWorked, totalPnl, totalPct, peakBalance, maxDrawdownPct,
    worstDayPct, worstDayDate, bestDayPnl: bestDayPnl === -Infinity ? 0 : bestDayPnl,
    consistencyTopShare, tradeCount: closed.length, daysSinceStart,
    days, violations, resolvedStatus, failureReason,
    final, evaluatedThrough: endAt.toISOString(),
    openPositionsNotCounted: openOrders.length,
    unsizedCloses: unsized.length, unsizedClosesNote, ruleBasis, ruleBasisNote, passBlockedReason,
  };
}

// ── POST /prop-challenges ──────────────────────────────────────────────────
router.post("/prop-challenges", async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const b = CreateChallengeBody.parse(req.body ?? {});
    // Only the caller's own paper account can back a challenge. Another user's
    // account and legacy ownerless accounts both answer 404, matching the
    // owner-scoped paper sandbox.
    const acct = (await db.select().from(paperAccountsTable)
      .where(and(eq(paperAccountsTable.id, b.paperAccountId), eq(paperAccountsTable.userId, userId))).limit(1))[0];
    if (!acct) { fail(res, 404, "Paper account not found"); return; }
    const ins = await db.insert(propChallengesTable).values({
      userId,
      paperAccountId: b.paperAccountId,
      challengeName: b.challengeName,
      startingBalance: b.startingBalance,
      profitTarget: b.profitTarget, maxDailyLoss: b.maxDailyLoss,
      maxTotalDrawdown: b.maxTotalDrawdown, minTradingDays: b.minTradingDays,
      maxTradingDays: b.maxTradingDays, consistencyRulePercent: b.consistencyRulePercent,
      // Phase 27-B extended rules.
      trailingDrawdownEnabled: b.trailingDrawdownEnabled ? 1 : 0,
      trailingDrawdownAmount: b.trailingDrawdownAmount,
      trailingDrawdownType: b.trailingDrawdownType,
      maxRiskPerTrade: b.maxRiskPerTrade,
      maxOpenTrades: b.maxOpenTrades,
      maxPendingOrders: b.maxPendingOrders,
      maxPositionSize: b.maxPositionSize,
      newsTradingAllowed: b.newsTradingAllowed ? 1 : 0,
      weekendHoldingAllowed: b.weekendHoldingAllowed ? 1 : 0,
      overnightHoldingAllowed: b.overnightHoldingAllowed ? 1 : 0,
      strictGuardrailsEnabled: b.strictGuardrailsEnabled ? 1 : 0,
      status: "ACTIVE",
    }).returning();
    await vaultBehavior("PROP_CHALLENGE_CREATED", {
      challengeId: ins[0]!.id, paperAccountId: b.paperAccountId, name: b.challengeName,
    });
    ok(res, { challenge: ins[0] });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /prop-challenges failed");
    fail(res, 500, "Failed to create challenge");
  }
});

// ── GET /prop-challenges ───────────────────────────────────────────────────
router.get("/prop-challenges", async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(propChallengesTable)
    .where(eq(propChallengesTable.userId, userId))
    .orderBy(desc(propChallengesTable.createdAt)).limit(100);
  ok(res, { challenges: rows });
});

// ── GET /prop-challenges/active ────────────────────────────────────────────
router.get("/prop-challenges/active", async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(propChallengesTable)
    .where(and(eq(propChallengesTable.userId, userId), eq(propChallengesTable.status, "ACTIVE")))
    .orderBy(desc(propChallengesTable.createdAt)).limit(1);
  if (!rows[0]) { fail(res, 404, "No active challenge"); return; }
  ok(res, { challenge: rows[0] });
});

// ── GET /prop-challenges/:id ───────────────────────────────────────────────
router.get("/prop-challenges/:id", async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
  const ch = await ownChallenge(id, userId);
  if (!ch) { fail(res, 404, "Not found"); return; }
  ok(res, { challenge: ch });
});

// ── POST /prop-challenges/:id/evaluate ─────────────────────────────────────
router.post("/prop-challenges/:id/evaluate", async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const ch = await ownChallenge(id, userId);
    if (!ch) { fail(res, 404, "Not found"); return; }
    const ev = await evaluateChallenge(id);
    if (!ev) { fail(res, 404, "Not found"); return; }

    // A finished challenge is evaluated read-only: its stored day and
    // violation rows are not rewritten and no prop-firm alerts are sent.
    if (!ev.final) {
      // Persist day rows (replace existing for idempotency). Stamp userId
      // for defense-in-depth ownership integrity (architect P1).
      await db.delete(propChallengeDaysTable).where(eq(propChallengeDaysTable.challengeId, id));
      if (ev.days.length > 0) {
        await db.insert(propChallengeDaysTable).values(ev.days.map((d) => ({
          challengeId: id, userId, tradeDate: d.tradeDate,
          startingBalance: d.startingBalance, endingBalance: d.endingBalance,
          dailyProfitLoss: d.dailyProfitLoss, dailyLossPercent: d.dailyLossPercent,
          tradesTaken: d.tradesTaken, rulesViolated: d.rulesViolated.join(","),
        })));
      }

      // Persist violations (replace existing). Stamp userId.
      await db.delete(propChallengeViolationsTable).where(eq(propChallengeViolationsTable.challengeId, id));
      if (ev.violations.length > 0) {
        await db.insert(propChallengeViolationsTable).values(ev.violations.map((v) => ({
          challengeId: id, userId, violationType: v.type, message: v.message, severity: v.severity,
        })));
      }

      // Phase 27-B: emit per-rule notifications with verbatim safety language.
      // Per-user scoped, deduped 1h/day/rule. Never blocks evaluation on
      // notification failure (notify() is fire-and-forget here).
      for (const v of ev.violations) {
        const kind = violationToAlertKind({ type: v.type, severity: v.severity });
        if (!kind) continue;
        const alert = buildPropFirmAlert(kind, {
          challengeId: id, ruleChecked: v.type, detail: v.message, userId,
        });
        notify({ ...alert, userId }).catch((e) => {
          req.log.warn({ err: String(e), challengeId: id, kind }, "prop-firm notify failed");
        });
      }
    }

    // Update status only if challenge is ACTIVE (PAUSED/CANCELED stay; PASSED/FAILED are terminal).
    let newStatus = ch.status;
    let completedAt = ch.completedAt;
    let failureReason = ch.failureReason;
    if (ch.status === "ACTIVE" && ev.resolvedStatus !== "ACTIVE") {
      newStatus = ev.resolvedStatus;
      completedAt = new Date();
      failureReason = ev.failureReason;
      await db.update(propChallengesTable).set({
        status: newStatus, completedAt, failureReason, updatedAt: new Date(),
      }).where(eq(propChallengesTable.id, id));
      await vaultBehavior(newStatus === "PASSED" ? "PROP_CHALLENGE_PASSED" : "PROP_CHALLENGE_FAILED", {
        challengeId: id, totalPct: ev.totalPct, daysWorked: ev.daysWorked, reason: failureReason,
      });
    }

    ok(res, {
      summary: {
        status: newStatus,
        failureReason,
        totalPnl: ev.totalPnl, totalPct: ev.totalPct,
        peakBalance: ev.peakBalance, maxDrawdownPct: ev.maxDrawdownPct,
        worstDayPct: ev.worstDayPct, worstDayDate: ev.worstDayDate,
        bestDayPnl: ev.bestDayPnl,
        daysWorked: ev.daysWorked, daysSinceStart: ev.daysSinceStart,
        consistencyTopShare: ev.consistencyTopShare,
        tradeCount: ev.tradeCount,
        profitTarget: ch.profitTarget, maxDailyLoss: ch.maxDailyLoss,
        maxTotalDrawdown: ch.maxTotalDrawdown,
        minTradingDays: ch.minTradingDays, maxTradingDays: ch.maxTradingDays,
        currentBalance: ch.startingBalance + ev.totalPnl,
        final: ev.final,
        evaluatedThrough: ev.evaluatedThrough,
        // What the drawdown / daily-loss figures above are built from.
        drawdownBasis: "CLOSED_TRADES_ONLY",
        openPositionsNotCounted: ev.openPositionsNotCounted,
        drawdownNote: closedTradeDrawdownNote(ev.openPositionsNotCounted, ev.final, ch.trailingDrawdownEnabled === 1),
        // What the max-risk-per-trade rule actually checks.
        maxRiskPerTrade: ch.maxRiskPerTrade,
        riskPerTradeBasis: "REALISED_LOSS_AFTER_CLOSE",
        riskPerTradeNote: RISK_PER_TRADE_NOTE,
        // Additive: closes whose P&L could not be sized, the second set of
        // figures the pass and fail rules were checked on (each closed trade
        // at the paper risk model, price move × lots × 100; the booked
        // figures above are the first), and why a challenge whose booked
        // figures meet the pass rules is not PASSED.
        unsizedCloses: ev.unsizedCloses,
        unsizedClosesNote: ev.unsizedClosesNote,
        ruleBasis: ev.ruleBasis,
        ruleBasisNote: ev.ruleBasisNote,
        passBlockedReason: ev.passBlockedReason,
      },
      days: ev.days,
      violations: ev.violations,
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /prop-challenges/:id/evaluate failed");
    fail(res, 500, "Failed to evaluate challenge");
  }
});

// ── PATCH /prop-challenges/:id ─────────────────────────────────────────────
router.patch("/prop-challenges/:id", async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const b = UpdateStatusBody.parse(req.body ?? {});
    const cur = await ownChallenge(id, userId);
    if (!cur) { fail(res, 404, "Not found"); return; }
    if (cur.status === "PASSED" || cur.status === "FAILED") {
      fail(res, 409, "Challenge is terminal"); return;
    }
    // Allowed transitions: ACTIVE↔PAUSED, ACTIVE→CANCELED, PAUSED→CANCELED.
    const allowed = (
      (cur.status === "ACTIVE" && (b.status === "PAUSED" || b.status === "CANCELED")) ||
      (cur.status === "PAUSED" && (b.status === "ACTIVE" || b.status === "CANCELED"))
    );
    if (!allowed) { fail(res, 409, `Cannot transition ${cur.status} → ${b.status}`); return; }
    const completedAt = b.status === "CANCELED" ? new Date() : cur.completedAt;
    await db.update(propChallengesTable).set({
      status: b.status, completedAt, updatedAt: new Date(),
    }).where(eq(propChallengesTable.id, id));
    await vaultBehavior(`PROP_CHALLENGE_${b.status}`, { challengeId: id });
    const refreshed = (await db.select().from(propChallengesTable).where(eq(propChallengesTable.id, id)).limit(1))[0];
    ok(res, { challenge: refreshed });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /prop-challenges/:id failed");
    fail(res, 500, "Failed to update challenge");
  }
});

// ── PATCH /prop-challenges/:id/rules ────────────────────────────────────────
// Phase 27-B: per-user opt-in for extended rules. Read-only safety; never
// touches live execution. Cannot mutate status or balance.
router.patch("/prop-challenges/:id/rules", async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const b = UpdateRulesBody.parse(req.body ?? {});
    const cur = await ownChallenge(id, userId);
    if (!cur) { fail(res, 404, "Not found"); return; }
    if (cur.status === "PASSED" || cur.status === "FAILED") {
      fail(res, 409, "Challenge is terminal"); return;
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (b.trailingDrawdownEnabled !== undefined) patch["trailingDrawdownEnabled"] = b.trailingDrawdownEnabled ? 1 : 0;
    if (b.trailingDrawdownAmount !== undefined) patch["trailingDrawdownAmount"] = b.trailingDrawdownAmount;
    if (b.trailingDrawdownType   !== undefined) patch["trailingDrawdownType"]   = b.trailingDrawdownType;
    if (b.maxRiskPerTrade        !== undefined) patch["maxRiskPerTrade"]        = b.maxRiskPerTrade;
    if (b.maxOpenTrades          !== undefined) patch["maxOpenTrades"]          = b.maxOpenTrades;
    if (b.maxPendingOrders       !== undefined) patch["maxPendingOrders"]       = b.maxPendingOrders;
    if (b.maxPositionSize        !== undefined) patch["maxPositionSize"]        = b.maxPositionSize;
    if (b.newsTradingAllowed     !== undefined) patch["newsTradingAllowed"]     = b.newsTradingAllowed ? 1 : 0;
    if (b.weekendHoldingAllowed  !== undefined) patch["weekendHoldingAllowed"]  = b.weekendHoldingAllowed ? 1 : 0;
    if (b.overnightHoldingAllowed !== undefined) patch["overnightHoldingAllowed"] = b.overnightHoldingAllowed ? 1 : 0;
    if (b.strictGuardrailsEnabled !== undefined) patch["strictGuardrailsEnabled"] = b.strictGuardrailsEnabled ? 1 : 0;
    await db.update(propChallengesTable).set(patch).where(eq(propChallengesTable.id, id));
    await vaultBehavior("PROP_RULES_UPDATED", { challengeId: id, userId, rules: b });
    const refreshed = (await db.select().from(propChallengesTable).where(eq(propChallengesTable.id, id)).limit(1))[0];
    ok(res, { challenge: refreshed });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /prop-challenges/:id/rules failed");
    fail(res, 500, "Failed to update rules");
  }
});

// ── GET /prop-challenges/:id/violations ────────────────────────────────────
router.get("/prop-challenges/:id/violations", async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
  const ch = await ownChallenge(id, userId);
  if (!ch) { fail(res, 404, "Not found"); return; }
  const rows = await db.select().from(propChallengeViolationsTable)
    .where(eq(propChallengeViolationsTable.challengeId, id))
    .orderBy(desc(propChallengeViolationsTable.createdAt)).limit(200);
  ok(res, { violations: rows });
});

// ── GET /prop-challenges/:id/days ──────────────────────────────────────────
router.get("/prop-challenges/:id/days", async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
  const ch = await ownChallenge(id, userId);
  if (!ch) { fail(res, 404, "Not found"); return; }
  const rows = await db.select().from(propChallengeDaysTable)
    .where(eq(propChallengeDaysTable.challengeId, id))
    .orderBy(asc(propChallengeDaysTable.tradeDate)).limit(400);
  ok(res, { days: rows });
});

export default router;
export { evaluateChallenge };
