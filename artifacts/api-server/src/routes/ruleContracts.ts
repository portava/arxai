// (S) Build S — AI Accountability & Rule Contract System routes.
//
// SOFT accountability. Records and surfaces violations; does NOT enforce hard
// trade-blocking. That authority remains with safetyCore (canPlaceTrades) and
// the Risk Lock system. Reads paper_orders (Build Q) only — never references
// live trades, mt5_*, /execute-trade, or canPlaceTrades.
//
// No guaranteed-profit claims. Accountability framing, not punishment.

import { Router } from "express";
import {
  db, tradingRuleContractsTable, tradingRuleViolationsTable, sessionCommitmentsTable,
  paperOrdersTable, vaultEventsTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { z } from "zod/v4";

const router = Router();
const ACCOUNTABILITY_TAG = "Accountability layer — soft warnings to support discipline. Does not enforce hard trade locks or guarantee profits.";

function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, accountability: true, disclaimer: ACCOUNTABILITY_TAG });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), accountability: true, disclaimer: ACCOUNTABILITY_TAG });
}
async function vaultBehavior(kind: string, severity: "INFO"|"WARN"|"HIGH", payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity, source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload: { ...payload, accountability: true },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

// ── Validation ─────────────────────────────────────────────────────────────
const ContractBody = z.object({
  contractName: z.string().min(1).max(64).default("My Rules"),
  maxTradesPerDay: z.number().int().positive().max(1000).nullable().optional(),
  maxDailyLossPercent: z.number().positive().max(1).nullable().optional(),
  maxRiskPerTradePercent: z.number().positive().max(1).nullable().optional(),
  allowedSessions: z.string().default("ASIA,LONDON,NEWYORK"),
  allowedSymbols: z.string().default(""),
  requiredRrMinimum: z.number().positive().max(100).nullable().optional(),
  cooldownAfterLosses: z.number().int().positive().max(50).nullable().optional(),
  noTradeConditions: z.string().default(""),
  isActive: z.boolean().default(true),
});

const CommitmentBody = z.object({
  contractId: z.number().int().positive(),
  commitmentText: z.string().min(1).max(500),
});

const EndCommitmentBody = z.object({
  status: z.enum(["ENDED", "ABANDONED"]).default("ENDED"),
});

// ── Session helper: classify UTC hour into trading session ─────────────────
function sessionOf(d: Date): "ASIA"|"LONDON"|"NEWYORK"|"OFF" {
  const h = d.getUTCHours();
  if (h >= 0 && h < 8)   return "ASIA";
  if (h >= 7 && h < 16)  return "LONDON";
  if (h >= 13 && h < 22) return "NEWYORK";
  return "OFF";
}

// ── POST /rule-contracts ───────────────────────────────────────────────────
router.post("/rule-contracts", async (req, res): Promise<void> => {
  try {
    const b = ContractBody.parse(req.body ?? {});
    if (b.isActive) {
      // Single-active invariant.
      await db.update(tradingRuleContractsTable)
        .set({ isActive: 0, updatedAt: new Date() })
        .where(eq(tradingRuleContractsTable.isActive, 1));
    }
    const ins = await db.insert(tradingRuleContractsTable).values({
      contractName: b.contractName,
      maxTradesPerDay: b.maxTradesPerDay ?? null,
      maxDailyLossPercent: b.maxDailyLossPercent ?? null,
      maxRiskPerTradePercent: b.maxRiskPerTradePercent ?? null,
      allowedSessions: b.allowedSessions,
      allowedSymbols: b.allowedSymbols,
      requiredRrMinimum: b.requiredRrMinimum ?? null,
      cooldownAfterLosses: b.cooldownAfterLosses ?? null,
      noTradeConditions: b.noTradeConditions,
      isActive: b.isActive ? 1 : 0,
    }).returning();
    await vaultBehavior("RULE_CONTRACT_CREATED", "INFO", { contractId: ins[0]!.id, name: b.contractName });
    ok(res, { contract: ins[0] });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /rule-contracts failed");
    fail(res, 500, "Failed to create contract");
  }
});

// ── GET /rule-contracts ────────────────────────────────────────────────────
router.get("/rule-contracts", async (_req, res): Promise<void> => {
  const rows = await db.select().from(tradingRuleContractsTable)
    .orderBy(desc(tradingRuleContractsTable.createdAt)).limit(100);
  ok(res, { contracts: rows });
});

// ── GET /rule-contracts/active ─────────────────────────────────────────────
router.get("/rule-contracts/active", async (_req, res): Promise<void> => {
  const rows = await db.select().from(tradingRuleContractsTable)
    .where(eq(tradingRuleContractsTable.isActive, 1)).limit(1);
  if (!rows[0]) { fail(res, 404, "No active contract"); return; }
  ok(res, { contract: rows[0] });
});

// ── PATCH /rule-contracts/:id ──────────────────────────────────────────────
router.patch("/rule-contracts/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const b = ContractBody.partial().parse(req.body ?? {});
    const cur = (await db.select().from(tradingRuleContractsTable)
      .where(eq(tradingRuleContractsTable.id, id)).limit(1))[0];
    if (!cur) { fail(res, 404, "Not found"); return; }
    if (b.isActive === true) {
      await db.update(tradingRuleContractsTable)
        .set({ isActive: 0, updatedAt: new Date() })
        .where(eq(tradingRuleContractsTable.isActive, 1));
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (b.contractName !== undefined) patch["contractName"] = b.contractName;
    if (b.maxTradesPerDay !== undefined) patch["maxTradesPerDay"] = b.maxTradesPerDay;
    if (b.maxDailyLossPercent !== undefined) patch["maxDailyLossPercent"] = b.maxDailyLossPercent;
    if (b.maxRiskPerTradePercent !== undefined) patch["maxRiskPerTradePercent"] = b.maxRiskPerTradePercent;
    if (b.allowedSessions !== undefined) patch["allowedSessions"] = b.allowedSessions;
    if (b.allowedSymbols !== undefined) patch["allowedSymbols"] = b.allowedSymbols;
    if (b.requiredRrMinimum !== undefined) patch["requiredRrMinimum"] = b.requiredRrMinimum;
    if (b.cooldownAfterLosses !== undefined) patch["cooldownAfterLosses"] = b.cooldownAfterLosses;
    if (b.noTradeConditions !== undefined) patch["noTradeConditions"] = b.noTradeConditions;
    if (b.isActive !== undefined) patch["isActive"] = b.isActive ? 1 : 0;
    await db.update(tradingRuleContractsTable).set(patch).where(eq(tradingRuleContractsTable.id, id));
    const refreshed = (await db.select().from(tradingRuleContractsTable)
      .where(eq(tradingRuleContractsTable.id, id)).limit(1))[0];
    await vaultBehavior("RULE_CONTRACT_UPDATED", "INFO", { contractId: id });
    ok(res, { contract: refreshed });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /rule-contracts/:id failed");
    fail(res, 500, "Failed to update contract");
  }
});

// ── POST /session-commitments ──────────────────────────────────────────────
router.post("/session-commitments", async (req, res): Promise<void> => {
  try {
    const b = CommitmentBody.parse(req.body ?? {});
    const ct = (await db.select().from(tradingRuleContractsTable)
      .where(eq(tradingRuleContractsTable.id, b.contractId)).limit(1))[0];
    if (!ct) { fail(res, 404, "Contract not found"); return; }
    // End any prior ACTIVE commitment for this contract (single-active).
    await db.update(sessionCommitmentsTable)
      .set({ status: "ABANDONED", endedAt: new Date() })
      .where(and(eq(sessionCommitmentsTable.contractId, b.contractId),
                 eq(sessionCommitmentsTable.status, "ACTIVE")));
    const ins = await db.insert(sessionCommitmentsTable).values({
      contractId: b.contractId,
      sessionDate: new Date().toISOString().slice(0, 10),
      commitmentText: b.commitmentText,
      status: "ACTIVE",
    }).returning();
    await vaultBehavior("SESSION_COMMITMENT_STARTED", "INFO", {
      commitmentId: ins[0]!.id, contractId: b.contractId,
    });
    ok(res, { commitment: ins[0] });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /session-commitments failed");
    fail(res, 500, "Failed to start commitment");
  }
});

// ── POST /session-commitments/:id/end ──────────────────────────────────────
router.post("/session-commitments/:id/end", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const b = EndCommitmentBody.parse(req.body ?? {});
    const cur = (await db.select().from(sessionCommitmentsTable)
      .where(eq(sessionCommitmentsTable.id, id)).limit(1))[0];
    if (!cur) { fail(res, 404, "Not found"); return; }
    if (cur.status !== "ACTIVE") { fail(res, 409, `Commitment is ${cur.status}`); return; }
    await db.update(sessionCommitmentsTable)
      .set({ status: b.status, endedAt: new Date() })
      .where(eq(sessionCommitmentsTable.id, id));
    await vaultBehavior("SESSION_COMMITMENT_ENDED", "INFO", { commitmentId: id, status: b.status });
    const r = (await db.select().from(sessionCommitmentsTable)
      .where(eq(sessionCommitmentsTable.id, id)).limit(1))[0];
    ok(res, { commitment: r });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /session-commitments/:id/end failed");
    fail(res, 500, "Failed to end commitment");
  }
});

// ── GET /session-commitments/active ────────────────────────────────────────
router.get("/session-commitments/active", async (_req, res): Promise<void> => {
  const rows = await db.select().from(sessionCommitmentsTable)
    .where(eq(sessionCommitmentsTable.status, "ACTIVE"))
    .orderBy(desc(sessionCommitmentsTable.startedAt)).limit(1);
  if (!rows[0]) { fail(res, 404, "No active commitment"); return; }
  ok(res, { commitment: rows[0] });
});

// ── POST /rule-contracts/:id/evaluate ──────────────────────────────────────
// Walks today's paper_orders against the contract rules. Returns compliance
// summary + violations. Idempotent: replaces today's violation rows for this
// contract on each call.
router.post("/rule-contracts/:id/evaluate", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const ct = (await db.select().from(tradingRuleContractsTable)
      .where(eq(tradingRuleContractsTable.id, id)).limit(1))[0];
    if (!ct) { fail(res, 404, "Not found"); return; }

    // Today's orders only (UTC-day window).
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const todays = await db.select().from(paperOrdersTable)
      .where(gte(paperOrdersTable.openedAt, startOfDay))
      .orderBy(asc(paperOrdersTable.openedAt));

    interface V { type: string; severity: "INFO"|"WARN"|"HARD"; message: string; tradeId?: number }
    const violations: V[] = [];
    const allowedSessions = ct.allowedSessions.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const allowedSymbols = ct.allowedSymbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

    let totalPnl = 0;
    let consecLosses = 0;
    let cooldownTriggered = false;
    let respectedCount = 0;

    for (const o of todays) {
      const tradeViols: string[] = [];
      // Session check
      const sess = sessionOf(o.openedAt as Date);
      if (allowedSessions.length > 0 && !allowedSessions.includes(sess)) {
        tradeViols.push("DISALLOWED_SESSION");
        violations.push({ type: "DISALLOWED_SESSION", severity: "WARN", tradeId: o.id,
          message: `${o.symbol} traded during ${sess} (allowed: ${allowedSessions.join(",")})` });
      }
      // Symbol check
      if (allowedSymbols.length > 0 && !allowedSymbols.includes(o.symbol.toUpperCase())) {
        tradeViols.push("DISALLOWED_SYMBOL");
        violations.push({ type: "DISALLOWED_SYMBOL", severity: "WARN", tradeId: o.id,
          message: `${o.symbol} not in allowed symbols (${allowedSymbols.join(",")})` });
      }
      // OVER_RISK — risk per trade ≤ maxRiskPerTradePercent (architect fix #1a).
      // risk$ = |entry - SL| × lotSize × 100 (same convention as paper P&L).
      // Compared against the active paper account starting balance (10k synthetic basis).
      if (ct.maxRiskPerTradePercent != null && o.stopLoss != null) {
        const riskDollars = Math.abs(o.entryPrice - o.stopLoss) * o.lotSize * 100;
        const riskPct = riskDollars / 10_000;
        if (riskPct > ct.maxRiskPerTradePercent) {
          tradeViols.push("OVER_RISK");
          violations.push({ type: "OVER_RISK", severity: "HARD", tradeId: o.id,
            message: `${o.symbol} risk ${(riskPct*100).toFixed(2)}% exceeds limit ${(ct.maxRiskPerTradePercent*100).toFixed(2)}%` });
        } else if (riskPct > ct.maxRiskPerTradePercent * 0.8) {
          violations.push({ type: "OVER_RISK", severity: "WARN", tradeId: o.id,
            message: `${o.symbol} risk ${(riskPct*100).toFixed(2)}% approaching limit ${(ct.maxRiskPerTradePercent*100).toFixed(2)}%` });
        }
      }
      // RR minimum (requires both SL and TP set, geometry from entry)
      if (ct.requiredRrMinimum != null && o.stopLoss != null && o.takeProfit != null) {
        const reward = Math.abs(o.takeProfit - o.entryPrice);
        const risk   = Math.abs(o.entryPrice - o.stopLoss);
        const rr = risk > 0 ? reward / risk : 0;
        if (rr < ct.requiredRrMinimum) {
          tradeViols.push("LOW_RR");
          violations.push({ type: "LOW_RR", severity: "WARN", tradeId: o.id,
            message: `${o.symbol} R:R ${rr.toFixed(2)} below required ${ct.requiredRrMinimum.toFixed(2)}` });
        }
      }
      // Cooldown after consecutive losses
      if (o.status !== "OPEN") {
        if (o.profitLoss < 0) consecLosses += 1; else consecLosses = 0;
        totalPnl += o.profitLoss;
        if (ct.cooldownAfterLosses != null && consecLosses > ct.cooldownAfterLosses && !cooldownTriggered) {
          cooldownTriggered = true;
          violations.push({ type: "COOLDOWN", severity: "WARN",
            message: `Cooldown advised: ${consecLosses} consecutive losses (limit ${ct.cooldownAfterLosses})` });
        }
      }
      if (tradeViols.length === 0) respectedCount += 1;
    }

    // Max trades per day — true 80% WARN threshold (architect fix #2: ceil not floor).
    if (ct.maxTradesPerDay != null && todays.length > ct.maxTradesPerDay) {
      violations.push({ type: "OVER_TRADES", severity: "HARD",
        message: `${todays.length} trades today exceeds limit ${ct.maxTradesPerDay}` });
    } else if (ct.maxTradesPerDay != null && todays.length >= Math.ceil(ct.maxTradesPerDay * 0.8)) {
      violations.push({ type: "OVER_TRADES", severity: "WARN",
        message: `${todays.length} of ${ct.maxTradesPerDay} trades used today` });
    }

    // NO_TRADE_CONDITION — checklist of conditions the trader must avoid.
    // Stored as CSV; if any condition is present AND any trade was placed today,
    // emit a per-condition WARN so the trader self-attests they verified each one
    // (architect fix #1b). Trader can clear conditions when satisfied.
    if (todays.length > 0 && ct.noTradeConditions.trim().length > 0) {
      const conditions = ct.noTradeConditions.split(",").map((c) => c.trim()).filter(Boolean);
      for (const cond of conditions) {
        violations.push({ type: "NO_TRADE_CONDITION", severity: "WARN",
          message: `Self-check required: did you verify "${cond}" was not active before trading today?` });
      }
    }

    // Max daily loss (% of starting balance — uses 10k synthetic basis when paper acct unknown)
    if (ct.maxDailyLossPercent != null && totalPnl < 0) {
      const lossPct = Math.abs(totalPnl) / 10_000;
      if (lossPct > ct.maxDailyLossPercent) {
        violations.push({ type: "DAILY_LOSS", severity: "HARD",
          message: `Daily loss ${(lossPct*100).toFixed(2)}% exceeds limit ${(ct.maxDailyLossPercent*100).toFixed(2)}%` });
      } else if (lossPct > ct.maxDailyLossPercent * 0.8) {
        violations.push({ type: "DAILY_LOSS", severity: "WARN",
          message: `Daily loss ${(lossPct*100).toFixed(2)}% approaching limit ${(ct.maxDailyLossPercent*100).toFixed(2)}%` });
      }
    }

    // Persist (replace today's violations for this contract).
    const today = new Date().toISOString().slice(0, 10);
    await db.delete(tradingRuleViolationsTable)
      .where(and(eq(tradingRuleViolationsTable.contractId, id),
                 gte(tradingRuleViolationsTable.createdAt, startOfDay)));
    if (violations.length > 0) {
      await db.insert(tradingRuleViolationsTable).values(violations.map((v) => ({
        contractId: id, tradeId: v.tradeId ?? null,
        violationType: v.type, severity: v.severity, message: v.message,
      })));
    }
    const hardCount = violations.filter((v) => v.severity === "HARD").length;
    if (hardCount > 0) {
      await vaultBehavior("RULE_CONTRACT_HARD_VIOLATION", "HIGH", {
        contractId: id, hardCount, sessionDate: today,
      });
    }

    const tradesEvaluated = todays.length;
    const accountabilityScore = tradesEvaluated > 0
      ? Math.round((respectedCount / tradesEvaluated) * 100)
      : 100;

    ok(res, {
      summary: {
        contractId: id, sessionDate: today,
        tradesEvaluated, respectedCount, accountabilityScore,
        totalPnl, consecLosses, cooldownTriggered,
        hardCount, warnCount: violations.filter((v) => v.severity === "WARN").length,
      },
      violations,
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /rule-contracts/:id/evaluate failed");
    fail(res, 500, "Failed to evaluate contract");
  }
});

// ── GET /rule-contracts/:id/violations ─────────────────────────────────────
router.get("/rule-contracts/:id/violations", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
  const rows = await db.select().from(tradingRuleViolationsTable)
    .where(eq(tradingRuleViolationsTable.contractId, id))
    .orderBy(desc(tradingRuleViolationsTable.createdAt)).limit(200);
  ok(res, { violations: rows });
});

export default router;
