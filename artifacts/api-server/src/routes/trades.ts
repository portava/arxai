import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable, botSettingsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  GetTradesQueryParams,
  GetTradesResponse,
  GetOpenTradesResponse,
  ExecuteTradeBody,
  ExecuteTradeResponse,
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
import { CLIENT_DECLARABLE_ORIGIN_CLASSES } from "../lib/attribution/originClassAnalytics.js";

const router = Router();

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
    // ── TRUTH GUARD — LIVE is refused outright on this route. ────────────────
    // There is NO broker placement anywhere in /execute-trade: no MT5 command
    // is queued, no order leaves ARX. Before this guard, LIVE_TRADING mode +
    // an API-supplied confirmationId inserted a mode='LIVE' OPEN trades row
    // and replied "LIVE trade executed." — a phantom live position that then
    // rendered on the Live Trades surface with no position at any venue.
    // Refusing here preserves the checklist default-deny above (the
    // confirmationId requirement MUST stay — see components/execution/index.ts)
    // and makes the honesty structural: this route can never record a LIVE row.
    // Real live orders go through the Phase-B guided pipeline, which queues a
    // broker command and only records what the broker confirms.
    if (isEffectivelyLive) {
      await logBlockedTrade({
        symbol: body.symbol, direction: body.direction, lot: body.lot,
        strategy: body.strategy, confidence: body.confidence,
        reasons: ["LIVE execution refused: /execute-trade has no broker placement path"],
        blockers: ["broker placement not implemented on this route — use the guided live execution pipeline"],
        operationalMode: gate.operationalMode, globalState: gate.globalState,
        generatedAtIso: new Date().toISOString(),
      });
      if (typeof body.confirmationId === "number") {
        await markConfirmationRejected({
          confirmationId: body.confirmationId,
          reason: "LIVE execution refused: /execute-trade has no broker placement path",
        });
      }
      res.status(501).json({
        error: "LIVE execution is not implemented on this route — no broker placement exists, so no live trade was executed and no trade row was recorded.",
        decision: "HARD_BLOCK",
        decisionMode: gate.decisionMode,
        operationalMode: gate.operationalMode,
        globalState: gate.globalState,
        reasons: ["broker placement not implemented on /execute-trade"],
        blockers: ["Use the guided live execution pipeline for real orders"],
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

    // Capability #45 — origin-class attribution, stamped at creation.
    // The client may declare MANUAL / ASSISTED / MODIFIED (how the human press
    // relates to the platform's proposal). AUTOMATED is server-stamped only —
    // a browser claiming automation would be fabricated provenance, so it is
    // ignored here. When nothing is declared, this seam derives ASSISTED: an
    // /execute-trade press is an authenticated human executing parameters the
    // platform composed (strategy + confidence are required fields of this
    // endpoint). The derivation is recorded as DERIVED_DEFAULT, never passed
    // off as a declaration.
    const declaredOriginRaw = (req.body as Record<string, unknown> | undefined)?.["originClass"];
    const declaredOrigin = (CLIENT_DECLARABLE_ORIGIN_CLASSES as readonly string[]).includes(declaredOriginRaw as string)
      ? (declaredOriginRaw as string)
      : null;

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
      // Structurally never "LIVE": the truth guard above refuses LIVE before
      // this insert, because nothing on this route places a broker order. A
      // mode='LIVE' row here would be a fabricated live position.
      mode: "DEMO",
      originClass: declaredOrigin ?? "ASSISTED",
      originClassSource: declaredOrigin != null ? "DECLARED" : "DERIVED_DEFAULT",
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

// Suppress unused-var warning when botSettingsTable is no longer referenced.
void botSettingsTable;

export default router;
