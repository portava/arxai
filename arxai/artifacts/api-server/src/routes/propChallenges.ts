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
  const closed = orders.filter((o) => o.status !== "OPEN" && o.closedAt && o.closedAt >= ch.startedAt);

  // Bucket by UTC date.
  const byDay = new Map<string, typeof closed>();
  for (const o of closed) {
    const d = (o.closedAt as Date).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(o);
  }
  const sortedDates = [...byDay.keys()].sort();

  let runningBalance = ch.startingBalance;
  let peakBalance = ch.startingBalance;
  let maxDrawdownPct = 0;
  let worstDayPct = 0;
  let worstDayDate: string | null = null;
  let bestDayPnl = -Infinity;
  const days: Eval["days"] = [];
  const violations: Eval["violations"] = [];

  // Hard fail tracking
  let hardFail: string | null = null;

  for (const date of sortedDates) {
    const dayOrders = byDay.get(date)!;
    const dayPnl = dayOrders.reduce((s, o) => s + o.profitLoss, 0);
    const startBal = runningBalance;
    const endBal = runningBalance + dayPnl;
    const dayLossPct = dayPnl < 0 ? Math.abs(dayPnl) / startBal : 0;

    const dayRules: string[] = [];

    // Phase 27-B: Max risk per trade (per-trade loss vs day-start balance).
    // Per-trade, never fabricated — uses actual paper-order profitLoss.
    if (startBal > 0) {
      for (const o of dayOrders) {
        if (o.profitLoss < 0) {
          const tradeLossPct = Math.abs(o.profitLoss) / startBal;
          if (tradeLossPct > ch.maxRiskPerTrade) {
            dayRules.push("MAX_RISK_PER_TRADE");
            violations.push({
              type: "MAX_RISK_PER_TRADE", severity: "WARN",
              message: `Trade #${o.id} loss ${(tradeLossPct*100).toFixed(2)}% exceeds max risk per trade ${(ch.maxRiskPerTrade*100).toFixed(2)}% on ${date}`,
            });
          } else if (tradeLossPct > ch.maxRiskPerTrade * 0.8) {
            violations.push({
              type: "MAX_RISK_PER_TRADE", severity: "INFO",
              message: `Trade #${o.id} loss ${(tradeLossPct*100).toFixed(2)}% approaching max risk per trade ${(ch.maxRiskPerTrade*100).toFixed(2)}% on ${date}`,
            });
          }
        }
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

    // Daily-loss rule
    if (dayLossPct > ch.maxDailyLoss) {
      dayRules.push("DAILY_LOSS");
      violations.push({
        type: "DAILY_LOSS", severity: "HARD",
        message: `Daily loss ${(dayLossPct*100).toFixed(2)}% on ${date} exceeds limit ${(ch.maxDailyLoss*100).toFixed(2)}%`,
      });
      if (!hardFail) hardFail = "Daily loss limit exceeded";
    } else if (dayLossPct > ch.maxDailyLoss * 0.8) {
      violations.push({
        type: "DAILY_LOSS", severity: "WARN",
        message: `Daily loss ${(dayLossPct*100).toFixed(2)}% approaching limit ${(ch.maxDailyLoss*100).toFixed(2)}% on ${date}`,
      });
    }

    // Overtrading: > 20 trades in a day is a soft warning.
    if (dayOrders.length > 20) {
      dayRules.push("OVERTRADING");
      violations.push({
        type: "OVERTRADING", severity: "WARN",
        message: `Overtrading: ${dayOrders.length} trades on ${date}`,
      });
    }

    // Drawdown from peak
    runningBalance = endBal;
    peakBalance = Math.max(peakBalance, runningBalance);
    const ddPct = (peakBalance - runningBalance) / peakBalance;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    if (maxDrawdownPct > ch.maxTotalDrawdown) {
      if (!hardFail) hardFail = "Max total drawdown exceeded";
      violations.push({
        type: "TOTAL_DRAWDOWN", severity: "HARD",
        message: `Drawdown ${(maxDrawdownPct*100).toFixed(2)}% exceeds limit ${(ch.maxTotalDrawdown*100).toFixed(2)}% on ${date}`,
      });
    } else if (maxDrawdownPct > ch.maxTotalDrawdown * 0.8) {
      violations.push({
        type: "TOTAL_DRAWDOWN", severity: "WARN",
        message: `Drawdown ${(maxDrawdownPct*100).toFixed(2)}% approaching limit ${(ch.maxTotalDrawdown*100).toFixed(2)}%`,
      });
    }

    if (dayLossPct > worstDayPct) { worstDayPct = dayLossPct; worstDayDate = date; }
    if (dayPnl > bestDayPnl) bestDayPnl = dayPnl;

    days.push({
      tradeDate: date, startingBalance: startBal, endingBalance: endBal,
      dailyProfitLoss: dayPnl, dailyLossPercent: dayLossPct,
      tradesTaken: dayOrders.length, rulesViolated: dayRules,
    });
  }

  const totalPnl = runningBalance - ch.startingBalance;
  const totalPct = totalPnl / ch.startingBalance;
  const daysWorked = sortedDates.length;
  const daysSinceStart = Math.max(1, Math.ceil((Date.now() - ch.startedAt.getTime()) / 86_400_000));

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
  if (ch.trailingDrawdownEnabled === 1) {
    const tdRef = ch.trailingDrawdownType === "TRAILING" ? peakBalance : ch.startingBalance;
    const tdPct = tdRef > 0 ? (tdRef - runningBalance) / tdRef : 0;
    if (tdPct > ch.trailingDrawdownAmount) {
      if (!hardFail) hardFail = "Trailing drawdown exceeded";
      violations.push({
        type: "TRAILING_DRAWDOWN", severity: "HARD",
        message: `Trailing drawdown ${(tdPct*100).toFixed(2)}% (${ch.trailingDrawdownType}) exceeds limit ${(ch.trailingDrawdownAmount*100).toFixed(2)}%`,
      });
    } else if (tdPct > ch.trailingDrawdownAmount * 0.8) {
      violations.push({
        type: "TRAILING_DRAWDOWN", severity: "WARN",
        message: `Trailing drawdown ${(tdPct*100).toFixed(2)}% (${ch.trailingDrawdownType}) approaching limit ${(ch.trailingDrawdownAmount*100).toFixed(2)}%`,
      });
    }
  }

  // ── Phase 27-B: Max open trades + max pending orders ───────────────
  // OPEN paper orders = currently open positions. Paper schema has no
  // PENDING status (LIMIT orders fill immediately at entryPrice), so
  // pending-orders rule cannot be evaluated honestly today → INSUFFICIENT_DATA.
  const openOrders = orders.filter((o) => o.status === "OPEN");
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

  // Consistency: largest single-day profit ≤ consistencyRulePercent of total profit.
  const positiveDays = days.filter((d) => d.dailyProfitLoss > 0);
  const totalPositive = positiveDays.reduce((s, d) => s + d.dailyProfitLoss, 0);
  const topDay = positiveDays.reduce((m, d) => Math.max(m, d.dailyProfitLoss), 0);
  const consistencyTopShare = totalPositive > 0 ? topDay / totalPositive : 0;
  if (totalPositive > 0 && consistencyTopShare > ch.consistencyRulePercent) {
    violations.push({
      type: "CONSISTENCY",
      severity: totalPct >= ch.profitTarget ? "HARD" : "WARN",
      message: `Single best day = ${(consistencyTopShare*100).toFixed(1)}% of profit, exceeds ${(ch.consistencyRulePercent*100).toFixed(0)}%`,
    });
    if (totalPct >= ch.profitTarget && !hardFail) {
      hardFail = "Consistency rule violated at evaluation";
    }
  }

  // Resolve status
  let resolvedStatus: Eval["resolvedStatus"] = "ACTIVE";
  let failureReason: string | null = null;
  if (hardFail) {
    resolvedStatus = "FAILED";
    failureReason = hardFail;
  } else if (totalPct >= ch.profitTarget && daysWorked >= ch.minTradingDays && consistencyTopShare <= ch.consistencyRulePercent) {
    resolvedStatus = "PASSED";
  }

  return {
    daysWorked, totalPnl, totalPct, peakBalance, maxDrawdownPct,
    worstDayPct, worstDayDate, bestDayPnl: bestDayPnl === -Infinity ? 0 : bestDayPnl,
    consistencyTopShare, tradeCount: closed.length, daysSinceStart,
    days, violations, resolvedStatus, failureReason,
  };
}

// ── POST /prop-challenges ──────────────────────────────────────────────────
router.post("/prop-challenges", async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const b = CreateChallengeBody.parse(req.body ?? {});
    const acct = (await db.select().from(paperAccountsTable)
      .where(eq(paperAccountsTable.id, b.paperAccountId)).limit(1))[0];
    if (!acct) { fail(res, 404, "Paper account not found"); return; }
    // Phase 18A: block IDOR — if the account is owned by another user, reject.
    // Legacy/orphan accounts (userId = null) are allowed for backward compat;
    // evaluateChallenge applies a defense-in-depth ch.userId filter on orders
    // so cross-user data can never aggregate even on shared orphan accounts.
    if (acct.userId != null && acct.userId !== userId) { fail(res, 404, "Paper account not found"); return; }
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
