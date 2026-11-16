// Build K — AI Trade Plan Builder routes.
//
// COMPOSES (does not duplicate):
//   - permission/evaluate     → reused via internal helper for current verdict
//   - broker/health           → live broker status snapshot
//   - safetyCore.getStatus    → kill switch + LIVE policy
//   - executionConfirmations  → conversion target on POST /:id/convert
//   - vault_events            → BEHAVIOR audit trail
//
// Inviolable: this layer never executes orders. Conversion creates an
// execution_confirmation row in PENDING; that flow is what `safetyCore`
// continues to gate.

import { Router } from "express";
import { db, tradePlansTable, executionConfirmationsTable, vaultEventsTable } from "@workspace/db";
import { readBrokerHealthState } from "../lib/brokerHub/brokerHealthState.js";
import { BROKER_HEALTH_VERDICT_STALE_MS } from "../lib/brokerHub/freshness.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { z } from "zod/v4";
import { evaluateChecklist, planRewardToRisk, summarizePlan, type ChecklistInputs, type ChecklistItem } from "@workspace/domain/trade-plan";
import { gatherInputsAndEvaluate } from "./permission.js";
import { getCachedIntelligenceContext } from "../lib/data/chart/chartIntelligence.js";
import type { ChartTimeframe } from "../lib/data/chart/timeframes.js";
import { createAlert } from "../lib/alerts/alertManager.js";
import { generateNewsRiskForSymbol, readStoredCalendarCoverage } from "./newsCalendar.js";
import { getLatestPortfolioRiskOrCompute } from "./portfolioRisk.js";
import crypto from "node:crypto";

function createHashShort(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
}

const router = Router();

// ── helpers ────────────────────────────────────────────────────────────────

async function gatherPermissionContext(userId: number): Promise<{
  status: "CLEAR" | "CAUTION" | "LOCKED" | "LIVE_TRADING_DISABLED";
  blockers: string[];
  warnings: string[];
  hasActiveRiskLock: boolean;
}> {
  const { verdict } = await gatherInputsAndEvaluate(userId);
  return {
    status: verdict.status,
    blockers: verdict.blockers,
    warnings: verdict.warnings,
    hasActiveRiskLock: (verdict.activeLocks?.length ?? 0) > 0,
  };
}

type BrokerStatus = "CONNECTED" | "DEGRADED" | "DOWN" | "DISABLED" | "UNKNOWN";

interface BrokerEvidence {
  status: BrokerStatus;
  /** The cached verdict is too old (or has no time) to describe the connection now. */
  stale: boolean;
  /** Plain statement for the checklist: which check, when, what it said. */
  detail: string;
}

function agoText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} second${s === 1 ? "" : "s"} ago`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

const PLATFORM_SCOPE = "This is the platform's MT5 bridge, not a check of your own broker account.";

// broker_health_state is the platform-wide cache of the last broker health
// evaluation, rewritten only when an operator runs a health check. Its
// lastStatus is "what the broker was when we last checked", so it is only
// current within BROKER_HEALTH_VERDICT_STALE_MS of lastEvaluatedAt. An older
// (or undated) CONNECTED / DEGRADED verdict does not describe the connection
// now: it is reported as not confirmed (WARN), never as a PASS. Bad verdicts
// (DOWN / disabled / none) keep failing whatever their age.
async function gatherBrokerStatus(nowMs = Date.now()): Promise<BrokerEvidence> {
  const row = await readBrokerHealthState();
  if (!row) {
    return { status: "UNKNOWN", stale: false, detail: "No platform broker health check has been recorded, so the broker connection is unknown." };
  }
  if (!row.executionEnabled) {
    return { status: "DISABLED", stale: false, detail: "Execution is turned off in the platform broker health settings." };
  }
  const evaluatedMs = row.lastEvaluatedAt ? new Date(row.lastEvaluatedAt).getTime() : NaN;
  const ageMs = Number.isFinite(evaluatedMs) ? nowMs - evaluatedMs : NaN;
  const current = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= BROKER_HEALTH_VERDICT_STALE_MS;
  const when = Number.isFinite(ageMs) && ageMs >= 0 ? agoText(ageMs) : null;
  const status: BrokerStatus =
    row.lastStatus === "CONNECTED" ? "CONNECTED"
    : row.lastStatus === "DEGRADED" ? "DEGRADED"
    : row.lastStatus === "DISCONNECTED" || row.lastStatus === "ERROR" ? "DOWN"
    : "UNKNOWN";
  const said = row.lastStatus ?? "no status";
  if (status === "CONNECTED" || status === "DEGRADED") {
    if (!current) {
      const age = when
        ? `said ${said} ${when}`
        : `said ${said}, but when it ran could not be confirmed`;
      return {
        status, stale: true,
        detail: `Not confirmed — the last platform broker health check ${age}, too old to describe the connection now ` +
          `(a check is current for ${Math.round(BROKER_HEALTH_VERDICT_STALE_MS / 1000)} seconds). ${PLATFORM_SCOPE}`,
      };
    }
    return { status, stale: false, detail: `${said} at the platform broker health check ${when}. ${PLATFORM_SCOPE}` };
  }
  return {
    status, stale: false,
    detail: `${said} at the last platform broker health check${when ? ` (${when})` : ""}. ${PLATFORM_SCOPE}`,
  };
}

// The checklist domain maps a status to PASS / WARN / FAIL with a bare
// detail. Here the broker item gets the evidence detail, and a stale
// CONNECTED / DEGRADED verdict (PASS / WARN) becomes a WARN: a downgrade only,
// a FAIL is never softened.
function withBrokerEvidence(items: ChecklistItem[], broker: BrokerEvidence): ChecklistItem[] {
  return items.map((i) => {
    if (i.key !== "BROKER_HEALTH") return i;
    const status = broker.stale && i.status === "PASS" ? "WARN" : i.status;
    return { ...i, status, detail: broker.detail };
  });
}

function serializePlan(row: typeof tradePlansTable.$inferSelect) {
  return {
    id: row.id,
    symbol: row.symbol,
    directionBias: row.directionBias,
    strategyId: row.strategyId,
    marketCondition: row.marketCondition,
    entryConditions: row.entryConditions,
    invalidationConditions: row.invalidationConditions,
    stopLossPlan: row.stopLossPlan,
    takeProfitPlan: row.takeProfitPlan,
    entryPrice: row.entryPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    lotSize: row.lotSize,
    riskAmount: row.riskAmount,
    maxLossAllowed: row.maxLossAllowed,
    rewardToRiskTarget: row.rewardToRiskTarget,
    confidenceLevel: row.confidenceLevel,
    status: row.status,
    aiSummary: row.aiSummary,
    checklist: row.checklistJson ?? null,
    // The stored checklist and AI review describe the values they were
    // computed on. A DRAFT only carries one when it was edited after a
    // validate (validate always leaves READY or INVALIDATED), so its checklist
    // describes earlier values: out of date, never "ready". Derived from the
    // row, so plans edited before this flag existed read the same way.
    checklistStale: row.status === "DRAFT" && row.checklistJson != null,
    executionConfirmationId: row.executionConfirmationId,
    createdAtIso: row.createdAt.toISOString(),
    updatedAtIso: row.updatedAt.toISOString(),
  };
}

async function vaultBehavior(kind: string, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity: "INFO", source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload, reasons: [], blockers: [],
    generatedAtIso: new Date().toISOString(),
  });
}

// ── schemas ────────────────────────────────────────────────────────────────

const PlanFields = {
  symbol: z.string().min(1).max(32).nullish(),
  directionBias: z.enum(["BUY", "SELL", "NEUTRAL"]).nullish(),
  strategyId: z.string().min(1).max(64).nullish(),
  marketCondition: z.enum(["TRENDING", "RANGING", "NO_TRADE", "UNKNOWN"]).nullish(),
  entryConditions: z.string().max(2000).nullish(),
  invalidationConditions: z.string().max(2000).nullish(),
  stopLossPlan: z.string().max(2000).nullish(),
  takeProfitPlan: z.string().max(2000).nullish(),
  entryPrice: z.number().finite().positive().nullish(),
  stopLoss: z.number().finite().positive().nullish(),
  takeProfit: z.number().finite().positive().nullish(),
  lotSize: z.number().finite().positive().nullish(),
  riskAmount: z.number().finite().nonnegative().nullish(),
  maxLossAllowed: z.number().finite().positive().nullish(),
  rewardToRiskTarget: z.number().finite().positive().nullish(),
  confidenceLevel: z.number().int().min(0).max(100).nullish(),
} as const;

const CreateBody = z.object(PlanFields).strict();
const PatchBody = z.object(PlanFields).strict().partial();

// ── routes ─────────────────────────────────────────────────────────────────

router.post("/trade-plans", requireUser, async (req, res): Promise<void> => {
  try {
    const body = CreateBody.parse(req.body ?? {});
    const inserted = await db.insert(tradePlansTable).values({
      ...body,
      userId: req.authUser!.id,
      status: "DRAFT",
    }).returning();
    await vaultBehavior("TRADE_PLAN_CREATED", { id: inserted[0]!.id, symbol: body.symbol ?? null });
    res.json(serializePlan(inserted[0]!));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /trade-plans failed");
    res.status(500).json({ error: "Failed to create trade plan" });
  }
});

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

router.get("/trade-plans", requireUser, async (req, res) => {
  try {
    const { limit } = ListQuery.parse(req.query);
    const rows = await db.select().from(tradePlansTable)
      .where(eq(tradePlansTable.userId, req.authUser!.id))
      .orderBy(desc(tradePlansTable.createdAt)).limit(limit);
    res.json({ plans: rows.map(serializePlan) });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid query", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "GET /trade-plans failed");
    res.status(500).json({ error: "Failed to load trade plans" });
  }
});

router.get("/trade-plans/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const rows = await db.select().from(tradePlansTable)
      .where(and(eq(tradePlansTable.id, id), eq(tradePlansTable.userId, req.authUser!.id)))
      .limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(serializePlan(rows[0]));
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /trade-plans/:id failed");
    res.status(500).json({ error: "Failed to load trade plan" });
  }
});

router.patch("/trade-plans/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = PatchBody.parse(req.body ?? {});
    const userId = req.authUser!.id;
    // Only allow editing while DRAFT or READY (terminal states are immutable).
    const cur = await db.select().from(tradePlansTable)
      .where(and(eq(tradePlansTable.id, id), eq(tradePlansTable.userId, userId)))
      .limit(1);
    if (!cur[0]) { res.status(404).json({ error: "Not found" }); return; }
    if (cur[0].status === "EXECUTED" || cur[0].status === "CANCELED") {
      res.status(409).json({ error: cur[0].status === "EXECUTED"
        ? "Plan was already sent to the Pre-Trade Confirmation flow and cannot be edited."
        : "Plan is CANCELED and cannot be edited." }); return;
    }
    // Editing a READY or INVALIDATED plan demotes it to DRAFT — the last
    // checklist (pass or fail) was computed on the previous values, so the
    // edited plan is unchecked until validated again.
    const nextStatus = cur[0].status === "READY" || cur[0].status === "INVALIDATED" ? "DRAFT" : cur[0].status;
    const updated = await db.update(tradePlansTable)
      .set({ ...body, status: nextStatus, updatedAt: new Date() })
      .where(and(eq(tradePlansTable.id, id), eq(tradePlansTable.userId, userId))).returning();
    res.json(serializePlan(updated[0]!));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /trade-plans/:id failed");
    res.status(500).json({ error: "Failed to update trade plan" });
  }
});

router.post("/trade-plans/:id/validate", requireUser, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const userId = req.authUser!.id;

    // Race-safe validate: gather context outside the transaction (the slow I/O),
    // then row-lock the plan inside a transaction so concurrent validate / PATCH
    // calls serialize instead of stomping each other. The lock is released on
    // commit, so multiple concurrent validates each produce a fresh consistent
    // checklist + summary based on the most recent committed plan state.
    const [perm, broker] = await Promise.all([
      gatherPermissionContext(userId),
      gatherBrokerStatus(),
    ]);

    // (N) News-risk gate runs BEFORE the validate transaction so a
    // NO_TRADE_WINDOW result aborts without ever persisting a status flip.
    // The plan's symbol can in theory change between this read and the FOR
    // UPDATE inside the tx, but PATCH validation pins symbol changes through
    // the same validate flow, so the race is bounded (next validate re-checks).
    // (O) Portfolio-risk gate — also runs before the validate transaction.
    // Blocks ONLY when overall portfolio risk is CRITICAL (rule per spec).
    // HIGH/MODERATE warnings flow through to the user but do not block.
    //
    // Either check may fail (throw) or not run (no symbol). Validate carries
    // on, as before, but those risks were NOT checked: each one adds a WARN
    // item that says so. A WARN does not change readiness (isReady counts
    // FAILs only), so no gate moves; the checklist, summary and alert simply
    // stop implying the risk was considered.
    const notChecked: ChecklistItem[] = [];
    try {
      const port = await getLatestPortfolioRiskOrCompute(req.authUser);
      if (port.portfolioRiskLevel === "CRITICAL") {
        await vaultBehavior("TRADE_PLAN_VALIDATE_BLOCKED_PORTFOLIO", {
          id, level: port.portfolioRiskLevel, blockers: port.blockers,
        });
        res.status(409).json({
          error: "PORTFOLIO_RISK_CRITICAL",
          reason: port.blockers.join(" ") || port.aiSummary,
          level: port.portfolioRiskLevel,
          blockers: port.blockers,
          warnings: port.warnings,
        });
        return;
      }
    } catch (err) {
      req.log.warn({ err: String(err) }, "portfolio-risk check failed (non-fatal); continuing validate");
      notChecked.push({
        key: "PORTFOLIO_RISK", label: "Portfolio risk (critical exposure)", status: "WARN",
        detail: "Could not be checked — the portfolio-risk check failed, so your open positions and total exposure were not considered.",
      });
    }

    const preRow = await db.select().from(tradePlansTable)
      .where(and(eq(tradePlansTable.id, id), eq(tradePlansTable.userId, userId)))
      .limit(1);
    if (!preRow[0]) { res.status(404).json({ error: "Not found" }); return; }
    const preSymbol = preRow[0]?.symbol ?? null;
    if (preSymbol) {
      try {
        const news = await generateNewsRiskForSymbol(preSymbol);
        if (news.result.blockTrading) {
          await vaultBehavior("TRADE_PLAN_VALIDATE_BLOCKED_NEWS", {
            id, symbol: preSymbol, riskLevel: news.result.riskLevel, eventId: news.result.event?.id ?? null,
          });
          res.status(409).json({
            error: "NEWS_NO_TRADE_WINDOW",
            reason: news.result.tradeWarning ?? news.result.aiSummary,
            riskLevel: news.result.riskLevel,
            event: news.result.event,
          });
          return;
        }
        // The news check scores only the stored economic_events rows (filled
        // by a manual sync) in the next 24h. An empty table, or one that ends
        // before the window does, returns CLEAR without throwing; that is not
        // "no events" (same rule as the News Risk card's calendarCoverage).
        // A WARN only: readiness and every gate are unchanged.
        try {
          const coverage = await readStoredCalendarCoverage(new Date(Date.now() + 24 * 3600 * 1000));
          if (!coverage.windowCovered) {
            // "Partly" only when the stored calendar reaches past now, i.e.
            // some of the upcoming window was checked. A calendar whose last
            // event is already in the past covered none of it: not checked.
            const throughMs = coverage.coveredThrough != null ? Date.parse(coverage.coveredThrough) : NaN;
            const partly = coverage.storedEventCount > 0 && Number.isFinite(throughMs) && throughMs > Date.now();
            notChecked.push({
              key: "NEWS_RISK", label: "News risk (no-trade window)", status: "WARN",
              detail: `${partly ? "Only partly checked" : "Not checked"} — ${coverage.note ?? "the stored economic calendar does not cover the next 24 hours, so upcoming events cannot be ruled out."}`,
            });
          }
        } catch (err) {
          req.log.warn({ err: String(err) }, "calendar coverage read failed (non-fatal); continuing validate");
          notChecked.push({
            key: "NEWS_RISK", label: "News risk (no-trade window)", status: "WARN",
            detail: "Could not be checked — the stored economic calendar's coverage could not be read, so it is not known whether every upcoming economic event was considered.",
          });
        }
      } catch (err) {
        req.log.warn({ err: String(err) }, "news-risk check failed (non-fatal); continuing validate");
        notChecked.push({
          key: "NEWS_RISK", label: "News risk (no-trade window)", status: "WARN",
          detail: "Could not be checked — the news-risk check failed, so upcoming economic events were not considered.",
        });
      }
    } else {
      notChecked.push({
        key: "NEWS_RISK", label: "News risk (no-trade window)", status: "WARN",
        detail: "Not checked — the plan has no symbol, so upcoming economic events could not be matched to it.",
      });
    }

    const result = await db.transaction(async (tx) => {
      const cur = await tx.execute(
        sql`SELECT * FROM trade_plans WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`
      );
      const plan = (cur as unknown as { rows: Array<typeof tradePlansTable.$inferSelect> }).rows[0];
      if (!plan) return { error: { code: 404, msg: "Not found" } };
      if (plan.status === "EXECUTED" || plan.status === "CANCELED") {
        return { error: { code: 409, msg: `Plan is ${plan.status}.` } };
      }

      const inputs: ChecklistInputs = {
        symbol: plan.symbol, directionBias: plan.directionBias, strategyId: plan.strategyId,
        marketCondition: plan.marketCondition, entryPrice: plan.entryPrice, stopLoss: plan.stopLoss,
        takeProfit: plan.takeProfit, riskAmount: plan.riskAmount, maxLossAllowed: plan.maxLossAllowed,
        rewardToRiskTarget: plan.rewardToRiskTarget, confidenceLevel: plan.confidenceLevel,
        permissionStatus: perm.status, permissionBlockers: perm.blockers, permissionWarnings: perm.warnings,
        brokerStatus: broker.status, hasActiveRiskLock: perm.hasActiveRiskLock,
      };
      const checkedAtIso = new Date().toISOString();
      const evaluated = evaluateChecklist(inputs);
      const items = [...withBrokerEvidence(evaluated.items, broker), ...notChecked];
      const checklist = {
        ...evaluated,
        items,
        passCount: items.filter((i) => i.status === "PASS").length,
        warnCount: items.filter((i) => i.status === "WARN").length,
        checkedAtIso,
      };
      const aiSummary = summarizePlan({
        symbol: plan.symbol, directionBias: plan.directionBias, strategyId: plan.strategyId,
        rewardToRisk: checklist.rewardToRisk, rewardToRiskTarget: plan.rewardToRiskTarget,
        confidenceLevel: plan.confidenceLevel,
      }, checklist, checkedAtIso);
      const nextStatus = checklist.isReady ? "READY" : "INVALIDATED";

      const updated = await tx.update(tradePlansTable).set({
        status: nextStatus, aiSummary, checklistJson: checklist, updatedAt: new Date(),
      }).where(and(eq(tradePlansTable.id, id), eq(tradePlansTable.userId, userId))).returning();

      return { plan: updated[0]!, nextStatus, checklist };
    });

    if ("error" in result && result.error) { res.status(result.error.code).json({ error: result.error.msg }); return; }

    await vaultBehavior("TRADE_PLAN_VALIDATED", {
      id, status: result.nextStatus, fails: result.checklist!.failCount, warns: result.checklist!.warnCount,
    });
    // (L) Surface validate result as a smart alert. Dedupe key hashes the
    // *content* of the validation outcome (status + per-item pass/fail) rather
    // than updatedAt, so re-validating an unchanged plan within the dedupe TTL
    // does not re-alert. Any meaningful field change (which would flip a
    // checklist item) yields a different revision hash and a fresh alert.
    const plan = result.plan!;
    const checklist = result.checklist!;
    const itemSig = checklist.items.map((i) => `${i.key}:${i.status}`).join(",");
    const revision = createHashShort(`${result.nextStatus}|${itemSig}`);
    // Items the user typed (market condition, confidence, risk amount) are
    // UNKNOWN — not checks ARX ran — so "passed all readiness checks" would
    // overstate what was verified.
    const uncheckedCount = checklist.items.filter((i) => i.status === "UNKNOWN").length;
    if (result.nextStatus === "READY") {
      void createAlert({
        userId: plan.userId,
        type: "TRADE_PLAN_READY", priority: "MEDIUM", severity: "success",
        title: `Trade plan ready: ${plan.symbol ?? `#${plan.id}`}`,
        message: `Plan #${plan.id} passed every blocking check` +
          (checklist.warnCount > 0 ? ` (${checklist.warnCount} warning${checklist.warnCount === 1 ? "" : "s"} to review)` : "") +
          "." +
          (uncheckedCount > 0 ? ` ${uncheckedCount} item${uncheckedCount === 1 ? " is your own input" : "s are your own inputs"} that ARX did not verify.` : "") +
          (notChecked.length > 0 ? ` Not checked: ${notChecked.map((i) => i.label.toLowerCase()).join("; ")}.` : "") +
          " Final execution remains gated by the live-execution safety layer.",
        symbol: plan.symbol ?? undefined, relatedTradePlanId: plan.id, actionRequired: true,
        dedupeKey: `plan-ready:${plan.id}:${revision}`,
      });
    } else {
      void createAlert({
        userId: plan.userId,
        type: "TRADE_PLAN_INVALIDATED", priority: "MEDIUM", severity: "warning",
        title: `Trade plan invalidated: ${plan.symbol ?? `#${plan.id}`}`,
        message: `Plan #${plan.id} did not pass the readiness checklist (${checklist.failCount} fail, ${checklist.warnCount} warn).`,
        symbol: plan.symbol ?? undefined, relatedTradePlanId: plan.id,
        dedupeKey: `plan-invalid:${plan.id}:${revision}`,
      });
    }

    // Phase 4 (Step 6): Emit a chartQualityNote when Chart Truth is degraded.
    // Planning confidence is limited — the plan may still be prepared and the
    // status stands, but the note communicates that the chart basis is unverified.
    // Fail-open: absent cache → no note (honest unknown, not a false degradation).
    // chartTruthStatus always says which it was, so a missing note is never
    // read as "the chart verified": PASSED (cached read passed every chart
    // gate), LIMITED (a note explains what did not), NOT_CHECKED (no symbol,
    // no recent cached read, or the read failed).
    let chartQualityNote: string | null = null;
    let chartTruthScore: number | null = null;
    let chartTruthStatus: "PASSED" | "LIMITED" | "NOT_CHECKED" = "NOT_CHECKED";
    if (plan.symbol) {
      try {
        const PLAN_TF: ChartTimeframe = "M15";
        const cached =
          getCachedIntelligenceContext(plan.symbol, PLAN_TF, 300) ??
          getCachedIntelligenceContext(plan.symbol, PLAN_TF, 200);
        if (cached) {
          chartTruthScore = cached.state.gateOutput.chartTruthScore;
          // Gate on Chart Truth (confidentReadAllowed) — this is the same
          // threshold (≥ 75) that gates Eleanor reads and scanner confirmation.
          // tradeConfirmationAllowed/autonomousChartActionAllowed may still be
          // false even when truth passes (mirror degraded, feed stale), so
          // surface the primary block reason either way.
          if (!cached.state.gateOutput.confidentReadAllowed) {
            chartQualityNote =
              cached.state.gateOutput.primaryBlockReason ??
              "Chart Truth has not passed the verification threshold. " +
              "Your plan is saved, but chart-based confidence is limited until the chart verifies.";
          } else if (!cached.state.gateOutput.tradeConfirmationAllowed || !cached.state.gateOutput.autonomousChartActionAllowed) {
            // Chart Truth passes but mirror/freshness are degraded — still surface a note.
            chartQualityNote =
              cached.state.gateOutput.primaryBlockReason ??
              "Chart data is partially degraded (mirror or freshness issue). " +
              "Your plan is saved; review the chart feed before trading.";
          }
          chartTruthStatus = chartQualityNote != null ? "LIMITED" : "PASSED";
        }
      } catch {
        // fail-open: chart quality is advisory, never blocks plan save
        chartQualityNote = null;
        chartTruthScore = null;
        chartTruthStatus = "NOT_CHECKED";
      }
    }

    const planResponse = serializePlan(plan);
    // Phase 4: Compute effective confidence cap when Chart Truth is degraded.
    // The cap is advisory — the plan's stored confidenceLevel is unchanged;
    // effectiveConfidenceLevel is what the UI should display as the plan's
    // actual usable confidence given the current chart verification state.
    // When chart is verified (chartQualityNote is null), effectiveConfidenceLevel === confidenceLevel.
    let effectiveConfidenceLevel: number | null = planResponse.confidenceLevel;
    if (chartQualityNote != null && chartTruthScore != null && planResponse.confidenceLevel != null) {
      // Cap = min(user-entered confidence, chart truth score).
      // Chart truth score is 0–100; anything below 75 is "unverified" by the
      // gate threshold. We cap conservatively to never exceed the truth score.
      effectiveConfidenceLevel = Math.min(planResponse.confidenceLevel, Math.round(chartTruthScore));
    }
    res.json({
      ...planResponse,
      chartTruthStatus,
      ...(chartTruthScore != null ? { chartTruthScore } : {}),
      ...(chartQualityNote != null
        ? { chartQualityNote, chartTruthScore, effectiveConfidenceLevel }
        : {}),
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /trade-plans/:id/validate failed");
    res.status(500).json({ error: "Failed to validate trade plan" });
  }
});

router.post("/trade-plans/:id/cancel", requireUser, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const userId = req.authUser!.id;
    const cur = await db.select().from(tradePlansTable)
      .where(and(eq(tradePlansTable.id, id), eq(tradePlansTable.userId, userId)))
      .limit(1);
    if (!cur[0]) { res.status(404).json({ error: "Not found" }); return; }
    if (cur[0].status === "EXECUTED") { res.status(409).json({ error: "Cannot cancel a plan that was already sent to the Pre-Trade Confirmation flow." }); return; }
    if (cur[0].status === "CANCELED") { res.json(serializePlan(cur[0])); return; }
    const updated = await db.update(tradePlansTable)
      .set({ status: "CANCELED", updatedAt: new Date() })
      .where(and(eq(tradePlansTable.id, id), eq(tradePlansTable.userId, userId))).returning();
    await vaultBehavior("TRADE_PLAN_CANCELED", { id });
    res.json(serializePlan(updated[0]!));
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /trade-plans/:id/cancel failed");
    res.status(500).json({ error: "Failed to cancel trade plan" });
  }
});

// POST /trade-plans/:id/convert — creates an execution_confirmation in PENDING.
// Plan transitions to EXECUTED (= "submitted to confirmation flow"); the
// confirmation row is what safetyCore continues to gate. Idempotent:
// re-converting returns the existing confirmation id.
// EXECUTED here never means an order was placed: the request is a practice
// confirmation (practiceMode, LIVE_TRADING_DISABLED) that expires in 5 minutes
// unless confirmed. The dashboard labels it "Sent to confirmation" and reads
// the confirmation's own status (GET /execution-confirmations/:id).
router.post("/trade-plans/:id/convert", requireUser, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const userId = req.authUser!.id;

    const result = await db.transaction(async (tx) => {
      const cur = await tx.select().from(tradePlansTable)
        .where(and(eq(tradePlansTable.id, id), eq(tradePlansTable.userId, userId)))
        .limit(1);
      const plan = cur[0];
      if (!plan) return { error: { code: 404, msg: "Not found" } };
      if (plan.status !== "READY" && plan.status !== "EXECUTED") {
        return { error: { code: 409, msg: `Plan must be READY (current: ${plan.status}). Run validate first.` } };
      }
      // Idempotent: if already converted, return the existing confirmation.
      if (plan.status === "EXECUTED" && plan.executionConfirmationId) {
        return { plan };
      }
      // Required numeric fields for confirmation
      if (plan.symbol == null || plan.directionBias == null || plan.entryPrice == null ||
          plan.stopLoss == null || plan.takeProfit == null || plan.lotSize == null ||
          (plan.directionBias !== "BUY" && plan.directionBias !== "SELL")) {
        return { error: { code: 400, msg: "Plan is missing required execution fields (symbol, directionBias=BUY|SELL, entryPrice, stopLoss, takeProfit, lotSize)." } };
      }
      // Directional R:R (the same rule validation uses): a stop or target on
      // the wrong side of entry is an impossible plan, never a 2.0 R:R. A
      // READY row stored before validation checked sides is refused here.
      const geo = planRewardToRisk(plan.directionBias, plan.entryPrice, plan.stopLoss, plan.takeProfit);
      if (geo.stopSide === "WRONG" || geo.targetSide === "WRONG") {
        return { error: { code: 409, msg: `Stop loss or take profit is on the wrong side of entry for a ${plan.directionBias.toLowerCase()} — fix the plan and validate it again.` } };
      }
      const rr = geo.rr ?? 0;

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5-minute confirmation window
      const conf = await tx.insert(executionConfirmationsTable).values({
        userId: String(userId),
        symbol: plan.symbol,
        direction: plan.directionBias,
        lotSize: plan.lotSize,
        entryType: "MARKET",
        entryPrice: plan.entryPrice,
        stopLoss: plan.stopLoss,
        takeProfit: plan.takeProfit,
        estimatedRisk: plan.riskAmount ?? 0,
        rewardToRisk: rr,
        marketCondition: plan.marketCondition ?? "UNKNOWN",
        permissionStatus: "LIVE_TRADING_DISABLED",
        brokerConnected: false,
        practiceMode: true,
        aiConfidence: plan.confidenceLevel != null ? plan.confidenceLevel / 100 : null,
        fitScore: null,
        warnings: [],
        blockers: [],
        status: "PENDING",
        userConfirmed: false,
        executed: false,
        expiresAt,
      }).returning();

      const updated = await tx.update(tradePlansTable).set({
        status: "EXECUTED",
        executionConfirmationId: conf[0]!.id,
        updatedAt: new Date(),
      }).where(and(eq(tradePlansTable.id, id), eq(tradePlansTable.userId, userId))).returning();

      return { plan: updated[0]!, confirmationId: conf[0]!.id };
    });

    if ("error" in result && result.error) {
      res.status(result.error.code).json({ error: result.error.msg }); return;
    }
    await vaultBehavior("TRADE_PLAN_CONVERTED", { id, confirmationId: result.plan!.executionConfirmationId });
    res.json({
      plan: serializePlan(result.plan!),
      executionConfirmationId: result.plan!.executionConfirmationId,
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /trade-plans/:id/convert failed");
    res.status(500).json({ error: "Failed to convert trade plan" });
  }
});

export default router;
