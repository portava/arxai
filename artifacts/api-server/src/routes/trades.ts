import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { tradesTable, botSettingsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  GetTradesQueryParams,
  GetTradesResponse,
  GetOpenTradesResponse,
  ExecuteTradeBody,
  ExecuteTradeResponse,
  Mt5WebhookBody,
  Mt5WebhookResponse,
} from "@workspace/api-zod";
import { tradeGate, getStatus } from "../lib/safetyCore.js";
import {
  logBlockedTrade, logApprovedTrade, logPaperTrade, logSimulatedTrade,
  logRejectedTrade,
} from "../lib/vaultLogger.js";
import {
  claimConfirmationForExecution,
  markConfirmationExecuted,
  markConfirmationRejected,
} from "./executionConfirmations.js";
import { getBrokerHealthVerdict } from "./brokerHealth.js";
import { requireUser } from "../lib/auth/middleware.js";
import { PNL_DATA_QUALITY_MISSING_CLOSE_FILL } from "../lib/live/realizedPnl.js";

const router = Router();

// Shared-secret authentication for the MT5 webhook. Mirrors `requireBridgeToken`
// in routes/mt5.ts. The webhook can insert rows into `trades` (TRADE_OPEN) and
// mutate trade state (TRADE_CLOSE), so it must reject all unauthenticated callers
// even though canPlaceTrades:false prevents real broker orders — pollution of the
// trades table would still corrupt user-visible history and analytics.
function requireBridgeToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env["MT5_BRIDGE_TOKEN"];
  if (!expected) {
    res.status(503).json({ error: "MT5 bridge disabled: MT5_BRIDGE_TOKEN not configured." });
    return;
  }
  const provided = req.header("X-MT5-Bridge-Token");
  if (provided !== expected) {
    res.status(401).json({ error: "Invalid MT5 bridge token." });
    return;
  }
  next();
}

// GET /trades — Phase-2: scoped to req.authUser.id.
router.get("/trades", requireUser, async (req, res) => {
  try {
    const params = GetTradesQueryParams.parse({
      symbol: req.query["symbol"],
      status: req.query["status"],
      limit: req.query["limit"] ? Number(req.query["limit"]) : 50,
    });
    const userId = req.authUser!.id;
    const rows = await db.select().from(tradesTable)
      .where(eq(tradesTable.userId, userId))
      .orderBy(desc(tradesTable.createdAt))
      .limit(params.limit ?? 50);
    let filtered = rows;
    if (params.symbol) filtered = filtered.filter((r) => r.symbol === params.symbol);
    if (params.status) filtered = filtered.filter((r) => r.status === params.status);
    const data = GetTradesResponse.parse(filtered.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
    })));
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get trades" });
  }
});

// GET /trades/open — Phase-2: scoped to req.authUser.id.
router.get("/trades/open", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const rows = await db.select().from(tradesTable)
      .where(and(eq(tradesTable.status, "OPEN"), eq(tradesTable.userId, userId)))
      .orderBy(desc(tradesTable.createdAt));
    const data = GetOpenTradesResponse.parse(rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
    })));
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get open trades" });
  }
});

// POST /execute-trade — Phase-2: stamps userId on every inserted trade.
router.post("/execute-trade", requireUser, async (req, res) => {
  try {
    const body = ExecuteTradeBody.parse(req.body);
    const userId = req.authUser!.id;

    // ── Phase 1 Safety Core gate — Control Tower / Risk Governor / Kill Switch ─
    const gate = await tradeGate({
      intentId: `intent_${Date.now()}_${body.symbol}`,
      symbol: body.symbol,
      direction: body.direction,
      lot: body.lot,
      strategy: body.strategy,
      confidence: body.confidence,
    });

    if (gate.decision === "HARD_BLOCK") {
      await logBlockedTrade({
        symbol: body.symbol, direction: body.direction, lot: body.lot,
        strategy: body.strategy, confidence: body.confidence,
        reasons: gate.reasons, blockers: gate.blockers,
        operationalMode: gate.operationalMode, globalState: gate.globalState,
        generatedAtIso: new Date().toISOString(),
      });
      if (typeof body.confirmationId === "number") {
        await markConfirmationRejected({
          confirmationId: body.confirmationId,
          reason: `Safety Core HARD_BLOCK: ${gate.reasons.join("; ")}`,
        });
      }
      res.status(409).json({
        error: "Trade blocked by Safety Core",
        decision: gate.decision,
        decisionMode: gate.decisionMode,
        operationalMode: gate.operationalMode,
        globalState: gate.globalState,
        reasons: gate.reasons,
        blockers: gate.blockers,
      });
      return;
    }

    if (gate.decisionMode === "OBSERVE" || gate.decisionMode === "SUGGEST") {
      await logSimulatedTrade({
        symbol: body.symbol, direction: body.direction, lot: body.lot,
        strategy: body.strategy, confidence: body.confidence,
        reasons: gate.reasons,
        operationalMode: gate.operationalMode, globalState: gate.globalState,
        generatedAtIso: new Date().toISOString(),
      });
      res.json(ExecuteTradeResponse.parse({
        success: true,
        message: `Signal recorded in ${gate.operationalMode} mode (no order placed). Reasons: ${gate.reasons.join("; ")}`,
        tradeId: 0,
        mode: gate.operationalMode,
      }));
      return;
    }

    const recheck = await getStatus();
    if (
      recheck.killSwitchEngaged ||
      recheck.operationalMode !== gate.operationalMode ||
      recheck.globalState !== gate.globalState
    ) {
      const blockers = recheck.killSwitchEngaged
        ? ["kill switch engaged mid-flight"]
        : ["mode or global state changed mid-flight"];
      await logRejectedTrade({
        symbol: body.symbol, direction: body.direction, lot: body.lot,
        strategy: body.strategy, confidence: body.confidence,
        reasons: ["safety state changed between gate decision and execution"],
        blockers,
        operationalMode: recheck.operationalMode, globalState: recheck.globalState,
        generatedAtIso: new Date().toISOString(),
      });
      if (typeof body.confirmationId === "number") {
        await markConfirmationRejected({
          confirmationId: body.confirmationId,
          reason: `TOCTOU abort: ${blockers.join("; ")}`,
        });
      }
      res.status(409).json({
        error: "Trade aborted — safety state changed during gating",
        decision: "HARD_BLOCK",
        operationalMode: recheck.operationalMode,
        globalState: recheck.globalState,
        reasons: ["safety state changed between gate decision and execution"],
        blockers,
      });
      return;
    }

    if (gate.decisionMode === "LIVE") {
      const brokerVerdict = await getBrokerHealthVerdict();
      if (brokerVerdict.status !== "CONNECTED") {
        await logBlockedTrade({
          symbol: body.symbol, direction: body.direction, lot: body.lot,
          strategy: body.strategy, confidence: body.confidence,
          reasons: [`broker health=${brokerVerdict.status}`, ...brokerVerdict.reasons],
          blockers: brokerVerdict.blockers,
          operationalMode: gate.operationalMode, globalState: gate.globalState,
          generatedAtIso: new Date().toISOString(),
        });
        if (typeof body.confirmationId === "number") {
          await markConfirmationRejected({
            confirmationId: body.confirmationId,
            reason: `Broker health HARD_BLOCK: ${brokerVerdict.status}`,
          });
        }
        res.status(409).json({
          error: "Trade blocked by Broker Health gate",
          decision: "HARD_BLOCK",
          brokerStatus: brokerVerdict.status,
          reasons: brokerVerdict.reasons,
          blockers: brokerVerdict.blockers,
          aiExplanation: brokerVerdict.aiExplanation,
        });
        return;
      }
    }

    type ClaimResult = Awaited<ReturnType<typeof claimConfirmationForExecution>>;
    let claimedConfirmation: ClaimResult | null = null;
    const isEffectivelyLive = gate.decisionMode === "LIVE";
    if (isEffectivelyLive && typeof body.confirmationId !== "number") {
      res.status(409).json({
        error: "Live execution requires a confirmed execution_confirmations id (Pre-Trade Checklist).",
        decision: "HARD_BLOCK",
        reasons: ["missing confirmationId"],
        blockers: ["Pre-Trade Checklist confirmation required for live execution"],
      });
      return;
    }
    if (typeof body.confirmationId === "number") {
      claimedConfirmation = await claimConfirmationForExecution({
        confirmationId: body.confirmationId,
        symbol: body.symbol,
        direction: body.direction,
        lotSize: body.lot,
      });
      if (!claimedConfirmation) {
        res.status(409).json({
          error: "Execution confirmation could not be claimed (already used, expired, mismatched, or not in CONFIRMED state).",
          decision: "HARD_BLOCK",
          reasons: ["confirmation not claimable"],
          blockers: ["Open the Pre-Trade Checklist and confirm again with fresh prices"],
        });
        return;
      }
    }

    const adjustedLot = Number((body.lot * gate.recommendedSizeMultiplier01).toFixed(4));

    // Phase-2: stamp the trade with the authenticated user's id. We deliberately
    // do NOT accept a userId from the request body — the only authoritative
    // source of identity is the session cookie.
    const inserted = await db.insert(tradesTable).values({
      userId,
      symbol: body.symbol,
      direction: body.direction,
      lot: adjustedLot,
      entryPrice: body.entry,
      stopLoss: body.sl,
      takeProfit: body.tp,
      strategy: body.strategy,
      confidence: body.confidence,
      status: "OPEN",
      mode: gate.decisionMode === "LIVE" ? "LIVE" : "DEMO",
    }).returning();

    const trade = inserted[0]!;
    const generatedAtIso = new Date().toISOString();
    if (gate.decisionMode === "PAPER") {
      await logPaperTrade({
        symbol: body.symbol, direction: body.direction, lot: adjustedLot,
        strategy: body.strategy, confidence: body.confidence,
        tradeId: String(trade.id),
        operationalMode: gate.operationalMode, globalState: gate.globalState,
        generatedAtIso,
      });
    } else {
      await logApprovedTrade({
        symbol: body.symbol, direction: body.direction, lot: adjustedLot,
        strategy: body.strategy, confidence: body.confidence,
        tradeId: String(trade.id),
        operationalMode: gate.operationalMode, globalState: gate.globalState,
        generatedAtIso,
      });
    }
    const data = ExecuteTradeResponse.parse({
      success: true,
      message: `${gate.decisionMode} trade executed. Mode: ${gate.operationalMode}, state: ${gate.globalState}, size×${gate.recommendedSizeMultiplier01.toFixed(2)}.`,
      tradeId: trade.id,
      mode: gate.operationalMode,
    });
    if (claimedConfirmation) {
      await markConfirmationExecuted({
        confirmationId: claimedConfirmation.id,
        tradeId: trade.id,
        resultSummary: `${gate.decisionMode} executed (size×${gate.recommendedSizeMultiplier01.toFixed(2)})`,
      });
    }
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Failed to execute trade" });
  }
});

// POST /mt5-webhook — auth-gated by bridge token. Bridge events are NOT scoped
// to a user (no user session present) — they are inserted with userId=null and
// can be reconciled later when per-user MT5 connections ship. The bridge is
// fail-closed when MT5_BRIDGE_TOKEN is unset.
router.post("/mt5-webhook", requireBridgeToken, async (req, res) => {
  try {
    const body = Mt5WebhookBody.parse(req.body);
    req.log.info({ webhook: body }, "MT5 webhook received");

    const sysStatus = await getStatus();
    const generatedAtIso = new Date().toISOString();

    if (body.event === "TRADE_OPEN" && body.direction && body.lot && body.price) {
      const inserted = await db.insert(tradesTable).values({
        symbol: body.symbol,
        direction: body.direction as "BUY" | "SELL",
        lot: body.lot,
        entryPrice: body.price,
        stopLoss: body.sl ?? 0,
        takeProfit: body.tp ?? 0,
        strategy: "MT5 Bridge",
        confidence: 90,
        status: "OPEN",
        mode: "LIVE",
      }).returning();
      const tradeRow = inserted[0]!;
      await logApprovedTrade({
        symbol: body.symbol,
        direction: body.direction as "BUY" | "SELL",
        lot: body.lot,
        strategy: "MT5 Bridge",
        confidence: 90,
        tradeId: String(tradeRow.id),
        operationalMode: sysStatus.operationalMode,
        globalState: sysStatus.globalState,
        generatedAtIso,
      });
    } else if (body.event === "TRADE_CLOSE" && body.ticket) {
      const trades = await db.select().from(tradesTable).where(eq(tradesTable.status, "OPEN")).limit(1);
      if (trades[0]) {
        // Refuse to fabricate a P/L when the EA reported no trustworthy
        // numeric profit (including the case where `profit` is omitted
        // entirely from the close payload). Surface as pnlStatus="UNKNOWN"
        // so Trade Logs shows "P/L unavailable" and analytics excludes
        // the row. Uses the canonical MISSING_CLOSE_FILL_PRICE flag from
        // lib/live/realizedPnl so admin diagnostics see one consistent
        // contract everywhere.
        const rawProfit = body.profit;
        const hasTrustedPnl = typeof rawProfit === "number" && Number.isFinite(rawProfit);
        const updateSet = hasTrustedPnl
          ? {
              status: (rawProfit >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS") as "CLOSED_WIN" | "CLOSED_LOSS",
              pnl: rawProfit,
              pnlStatus: "COMPUTED" as const,
              dataQualityFlag: null,
              closedAt: new Date(),
            }
          : {
              status: "CLOSED_LOSS" as const,
              pnl: null,
              pnlStatus: "UNKNOWN" as const,
              dataQualityFlag: PNL_DATA_QUALITY_MISSING_CLOSE_FILL,
              // Record the EA version that reported this close so Trade Logs can
              // show the "upgrade to v1.28" nudge when an older EA could not
              // return the broker's real close fill price.
              reportedEaVersion: body.eaVersion ?? null,
              closedAt: new Date(),
            };
        await db.update(tradesTable).set(updateSet).where(eq(tradesTable.id, trades[0].id));
        await logRejectedTrade({
          symbol: body.symbol,
          direction: "BUY",
          lot: 0,
          strategy: "MT5 Bridge",
          confidence: 0,
          reasons: [`MT5 close ticket=${body.ticket} profit=${body.profit}`],
          blockers: [],
          operationalMode: sysStatus.operationalMode,
          globalState: sysStatus.globalState,
          generatedAtIso,
        });
      }
    }

    const data = Mt5WebhookResponse.parse({ received: true, timestamp: new Date().toISOString() });
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid webhook payload" });
  }
});

// Suppress unused-var warning when botSettingsTable is no longer referenced.
void botSettingsTable;

export default router;
