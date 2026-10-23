// Smart Chart Layers & Market Impact Radar (Task #197).
//
// SAFETY: requireUser (per-user gated → 401 when unauthenticated). The signal is
// built per-user via buildRubyMarketEdgeForUser; structure levels come from the
// public candle-truth layer (no per-user data). ADVISORY / VISUAL ONLY — this
// endpoint never places, modifies, or closes a trade and never gates execution.
// HONEST: news is real or honestly absent (no connected economic-calendar
// provider → no scheduled events shown, technicals-only behavior, never
// fabricated), structure/signal geometry is real-or-null, and reserved overlay
// slots are anchored to the user's real open positions and labeled not-yet-active.
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db, paperTradesTable } from "@workspace/db";
import { GetMeChartSmartLayersQueryParams } from "@workspace/api-zod";
import {
  buildExecutionCostLayers,
  buildOverlayHandshake,
  buildSignalLayers,
  buildTradeHealthSlots,
  type ReservedSlotPosition,
  type SignalLayerInput,
  type SmartChartLayer,
  type StructureLevelInput,
} from "@workspace/domain/smart-chart";
import { requireUser } from "../lib/auth/middleware.js";
import { buildRubyMarketEdgeForUser } from "../lib/signalIntelligence/signalIntelligenceService.js";
import { buildChartIntelligenceState } from "../lib/data/chart/chartIntelligence.js";
import { buildMarketImpactRadar } from "../lib/news/marketImpactRadar.js";
import { buildExecutionPreviewForUser } from "../lib/execution/executionPreviewService.js";

const router = Router();
const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

/** Plain-English rendering of a chart-level personality (no internal tokens). */
function humanizeLevelPersonality(p: string): string {
  switch (p) {
    case "fresh":
      return "fresh";
    case "defended":
      return "defended";
    case "weakening":
      return "weakening";
    case "broken":
      return "broken";
    case "retest_pending":
      return "retest pending";
    case "trap_zone":
      return "trap zone";
    case "scalp_only":
      return "scalp only";
    case "invalidated":
      return "invalidated";
    default:
      return p.replace(/_/g, " ");
  }
}

/** Plain-English rendering of a signal lifecycle stage (no internal tokens). */
function humanizeLifecycleStage(stage: string): string {
  return stage
    .toLowerCase()
    .split("_")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

router.get(
  "/me/chart/smart-layers",
  requireUser,
  async (req, res): Promise<void> => {
    let q;
    try {
      q = GetMeChartSmartLayersQueryParams.parse({
        symbol: req.query["symbol"],
        timeframe: req.query["timeframe"] ?? "M5",
      });
    } catch (err) {
      req.log.warn({ err }, "invalid smart-layers request");
      res.status(400).json({ error: "Invalid smart chart layers request" });
      return;
    }

    const userId = req.authUser!.id;
    const symbol = q.symbol;
    const timeframe = q.timeframe ?? "M5";

    const nowMs = Date.now();
    const [signal, chartState, radarResult, openPositions] = await Promise.all([
      buildRubyMarketEdgeForUser(userId, { symbol, timeframe }).catch((err) => {
        req.log.warn({ err }, "smart-layers signal build failed");
        return null;
      }),
      buildChartIntelligenceState(symbol, timeframe, 300).catch((err) => {
        req.log.warn({ err }, "smart-layers chart state build failed");
        return null;
      }),
      buildMarketImpactRadar(symbol, nowMs).catch((err) => {
        req.log.warn({ err }, "smart-layers radar build failed");
        return null;
      }),
      // Per-user open positions for this symbol (paper lifecycle is the per-user
      // position source for this advisory PAPER-mode endpoint). Scoped by
      // userId — never another user's rows. Drives the reserved overlay slots.
      db
        .select({
          id: paperTradesTable.id,
          symbol: paperTradesTable.symbol,
          entryPrice: paperTradesTable.entryPrice,
        })
        .from(paperTradesTable)
        .where(
          and(
            eq(paperTradesTable.userId, userId),
            eq(paperTradesTable.symbol, symbol),
            eq(paperTradesTable.status, "open"),
          ),
        )
        .catch((err) => {
          req.log.warn({ err }, "smart-layers open-position read failed");
          return [] as { id: number; symbol: string; entryPrice: number | null }[];
        }),
    ]);

    const structureLevels: StructureLevelInput[] = (
      chartState?.marketUnderstanding?.levels?.levels ?? []
    ).map((lvl) => ({
      kind: lvl.kind,
      price: lvl.price,
      personality: humanizeLevelPersonality(lvl.personality),
    }));

    const signalInput: SignalLayerInput | null = signal
      ? {
          symbol: signal.symbol,
          hasSufficientData: signal.hasSufficientData,
          entryZone: signal.entryZone,
          watchZone: signal.watchZone,
          retestZone: signal.retestZone,
          doNotChaseZone: signal.doNotChaseZone,
          invalidationPrice: signal.invalidationPrice,
          stopLoss: signal.stopLoss,
          takeProfitZones: signal.takeProfitZones,
        }
      : null;

    const signalLayers = buildSignalLayers(signalInput, structureLevels, symbol);

    // Execution-cost overlay (DRAWN). When the signal has a directional, usable
    // read, run the SAME per-user execution preview the live-shared ticket uses
    // and draw its expected-fill band + break-even line. Every number is real
    // broker-derived or null — buildExecutionCostLayers emits a layer ONLY when
    // its inputs are finite, so a missing quote/degraded estimate yields fewer
    // layers, never a fabricated cost. Advisory/visual only — no execution.
    let execCostLayers: SmartChartLayer[] = [];
    const dir = signal?.direction;
    if (
      signalInput &&
      signalInput.hasSufficientData &&
      (dir === "BUY" || dir === "SELL") &&
      signalInput.entryZone
    ) {
      const entryMid = (signalInput.entryZone.from + signalInput.entryZone.to) / 2;
      const firstTp = signalInput.takeProfitZones[0];
      const tpMid = firstTp ? (firstTp.from + firstTp.to) / 2 : null;
      try {
        const preview = await buildExecutionPreviewForUser(userId, {
          symbol,
          side: dir,
          orderType: "MARKET",
          entry: Number.isFinite(entryMid) && entryMid > 0 ? entryMid : null,
          stopLoss: signalInput.stopLoss,
          takeProfit: tpMid,
          lots: 0.01,
          maxSpreadPoints: 300,
        });
        execCostLayers = buildExecutionCostLayers({
          side: dir,
          expectedFill: preview.expectedFillRange?.expected ?? null,
          fillLow: preview.expectedFillRange?.low ?? null,
          fillHigh: preview.expectedFillRange?.high ?? null,
          breakEvenPoints: preview.breakEven.points,
          pointSize: preview.pointSize,
        });
      } catch (err) {
        // Honest skip: no execution-cost overlay rather than a fabricated one.
        req.log.warn({ err }, "smart-layers execution-cost preview failed");
      }
    }

    // Reserved trade-health slot, anchored to the user's REAL open positions on
    // this symbol. The slot is surfaced at each position's entry and labeled
    // honestly as not-yet-active — trade-health scoring (Phase 5) lands later.
    // We never draw a fabricated health value, and no slot is drawn when there
    // is no open position. (Execution-cost is now drawn live above.)
    const reservedPositions: ReservedSlotPosition[] = openPositions.map((p) => ({
      ticket: String(p.id),
      symbol: p.symbol,
      entryPrice: p.entryPrice,
    }));
    const tradeHealthSlots = buildTradeHealthSlots(reservedPositions, symbol);
    const layers: SmartChartLayer[] = [
      ...signalLayers,
      ...execCostLayers,
      ...tradeHealthSlots,
    ];

    const levelCount = structureLevels.length;
    const signalExists = !!signal;
    const hasSufficientData = signal?.hasSufficientData ?? false;
    // Honest news-mapping fact: events are only "mapped" when a real
    // economic-calendar provider is connected; otherwise NOT_AVAILABLE.
    const newsMapped = radarResult?.radar.provider.connected ?? false;
    // Honest overlay age: how old the driving signal read is (null when there is
    // no signal yet → the freshness check reports NOT_AVAILABLE rather than a
    // fabricated "fresh").
    const signalGeneratedMs = signal?.generatedAt
      ? Date.parse(signal.generatedAt)
      : NaN;
    const overlayAgeMs = Number.isFinite(signalGeneratedMs)
      ? Math.max(0, nowMs - signalGeneratedMs)
      : null;

    // Server-side (data) handshake: chart is assumed rendered for the data view
    // and the chart symbol is the requested symbol vs the symbol the signal was
    // actually built for. The frontend re-runs this with the live chart-bus
    // symbol + real chartLoaded fact to catch a mismatch.
    const handshake = buildOverlayHandshake({
      chartLoaded: true,
      chartSymbol: symbol,
      signalSymbol: signal?.symbol ?? null,
      signalExists,
      hasSufficientData,
      levelCount,
      newsMapped,
      overlayAgeMs,
    });

    res.json({
      symbol,
      timeframe,
      signal: signal
        ? {
            symbol: signal.symbol,
            direction: signal.direction,
            lifecycleStage: humanizeLifecycleStage(signal.lifecycleStage),
            hasSufficientData: signal.hasSufficientData,
            freshness: signal.freshness,
            generatedAt: signal.generatedAt,
          }
        : null,
      layers,
      newsRadar: radarResult?.radar ?? {
        symbol,
        provider: {
          connected: false,
          name: "unavailable",
          note: "The economic-calendar read is temporarily unavailable — no scheduled events are shown (none are fabricated).",
        },
        events: [],
        topSeverity: null,
        highImpactWindowActive: false,
        summary: "The economic-calendar read is temporarily unavailable for this symbol.",
      },
      newsBehavior: radarResult?.behavior ?? {
        mode: "NO_PROVIDER",
        note: "The economic-calendar read is temporarily unavailable, so the read below is technicals-only and does not include event timing or confirmed headlines.",
      },
      handshake,
      handshakeInputs: {
        signalSymbol: signal?.symbol ?? null,
        signalExists,
        hasSufficientData,
        levelCount,
        newsMapped,
      },
      ...SAFETY_ENVELOPE,
    });
  },
);

export default router;
