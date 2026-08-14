// Chart Brain v2 — Task 5: per-user decision memory surface (SLOW BRAIN).
//
// READ-ONLY with respect to trading. None of these endpoints place, modify, or
// close a trade, touch the 16-gate live pipeline, the kill switch, candle
// render, or any broker/EA surface. They are decision-support memory:
//
//   • POST /me/chart/decision-receipt            — create ONE immutable receipt
//   • GET  /me/chart/decision-receipts           — per-user receipt history
//   • GET  /me/chart/decision-receipts/:id       — one receipt + its outcomes
//   • POST /me/chart/decision-receipts/:id/outcome — APPEND an outcome/review
//   • POST /me/chart/similar-setups              — Slow-Brain similar lookup
//   • GET  /me/chart/behavior-protection         — advisory behavior signals
//   • GET  /admin/chart/decision-receipts        — admin cross-user history
//
// Per-user isolation is absolute: every user-facing read/write is scoped by
// req.authUser.id. The admin history read is the only cross-user read and is
// gated on the EFFECTIVE role (u.role) so an admin previewing-as-user is
// downgraded and lands in the 403 branch. Receipts are immutable — there is no
// update or delete path. The behavior signals are advisory only and NEVER
// override market truth.

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { resolveProductRole } from "../lib/auth/productRole.js";
import { logger } from "../lib/logger.js";
import { buildChartIntelligenceState } from "../lib/data/chart/chartIntelligence.js";
import {
  buildRubyDraftRead,
  type RubyDraftIntent,
} from "../lib/assistant/rubyDraftRead.js";
import { buildSetupFingerprint } from "../lib/chart/setupFingerprint.js";
import {
  createDecisionReceipt,
  getUserReceipt,
  listUserReceipts,
  listAllReceiptsForAdmin,
  appendReceiptOutcome,
  type ReceiptSource,
} from "../lib/chart/decisionReceipts.js";
import { findSimilarSetups } from "../lib/chart/similarSetups.js";
import { getBehaviorProtection } from "../lib/chart/behaviorProtection.js";
import { computeChartBrainBenchmark } from "../lib/chart/benchmarkScore.js";
import {
  createAnnotation,
  listAnnotations,
  dismissAnnotation,
  toAnnotationDTO,
} from "../lib/chart/chartAnnotations.js";
import {
  scanChartAlerts,
  type ChartAlertRole,
  type ChartAlertSignals,
  type ChartAlertOpenPosition,
} from "../lib/chart/aiAlerts.js";
import { deriveChartFlameSignal } from "../lib/chart/chartFlameSignal.js";
import { getOpenPositions } from "../lib/assistant/tools.js";

const router = Router();

// Compile-time fail-closed envelope. The chart-memory surface is unconditionally
// read-only regardless of the caller's live-trading permissions, so we return
// the truthful paper_only envelope (matches the contract enum [paper_only] and
// the sibling Ruby draft-read / chart-intelligence endpoints).
const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true,
  readOnlyMode: true,
  allowOrderExecution: false,
};

function err(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message, ...SAFETY_ENVELOPE });
}

function safe(
  h: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    h(req, res).catch((e) => {
      logger.error({ err: e, path: req.path }, "meChartBrain: handler error");
      if (!res.headersSent) err(res, 500, "internal_error");
    });
  };
}

const TIMEFRAME = z.enum(["M1", "M5", "M15", "M30", "H1", "H4", "D1"]);
const DIRECTION = z.enum(["BUY", "SELL", "NEUTRAL"]);

// ── POST /me/chart/decision-receipt — create ONE immutable receipt ──────────
const createReceiptSchema = z.object({
  symbol: z.string().min(1).max(64),
  timeframe: TIMEFRAME.default("M5"),
  limit: z.number().int().min(1).max(5000).default(300),
  intent: z.enum([
    "analyze",
    "is-this-a-buy",
    "is-this-a-scalp",
    "why-not-now",
    "what-changes-my-mind",
    "what-invalidates",
    "hold-or-close",
    "agent-consensus",
  ]),
  source: z.enum([
    "ruby_draft_read",
    "ruby_explain_signal",
    "chart_read",
    "chart_trade_plan",
  ]),
  direction: DIRECTION.optional(),
});
router.post(
  "/me/chart/decision-receipt",
  requireUser,
  safe(async (req, res) => {
    const parsed = createReceiptSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      err(res, 400, "invalid_body");
      return;
    }
    const userId = req.authUser!.id;
    const { symbol, timeframe, limit, intent, source, direction } = parsed.data;

    // Build (or reuse the short-cached) Chart Intelligence State + an honest
    // deterministic draft read for this symbol/timeframe. The builder degrades
    // to an honest empty/insufficient state on a dirty feed — never fabricates.
    const state = await buildChartIntelligenceState(symbol, timeframe, limit);
    const draftRead = buildRubyDraftRead(
      state,
      intent as RubyDraftIntent,
      null,
    );

    const created = await createDecisionReceipt({
      userId,
      state,
      draftRead,
      source: source as ReceiptSource,
      intent,
      direction: direction ?? null,
    });

    // Fail-open: a storage hiccup returns created=false rather than erroring.
    if (!created) {
      res.json({ created: false, receipt: null, ...SAFETY_ENVELOPE });
      return;
    }
    const view = await getUserReceipt(userId, created.receiptId);
    res.json({
      created: true,
      receipt: view?.receipt ?? null,
      ...SAFETY_ENVELOPE,
    });
  }),
);

// ── GET /me/chart/decision-receipts — per-user history ──────────────────────
const listQuerySchema = z.object({
  symbol: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
router.get(
  "/me/chart/decision-receipts",
  requireUser,
  safe(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      err(res, 400, "invalid_query");
      return;
    }
    const userId = req.authUser!.id;
    const receipts = await listUserReceipts(userId, {
      symbol: parsed.data.symbol,
      limit: parsed.data.limit,
    });
    res.json({ receipts, ...SAFETY_ENVELOPE });
  }),
);

// ── GET /me/chart/decision-receipts/:receiptId — one receipt + outcomes ─────
router.get(
  "/me/chart/decision-receipts/:receiptId",
  requireUser,
  safe(async (req, res) => {
    const userId = req.authUser!.id;
    const receiptId = String(req.params.receiptId ?? "").slice(0, 64);
    if (!receiptId) {
      err(res, 404, "not_found");
      return;
    }
    const found = await getUserReceipt(userId, receiptId);
    if (!found) {
      err(res, 404, "not_found");
      return;
    }
    res.json({
      receipt: found.receipt,
      outcomes: found.outcomes,
      ...SAFETY_ENVELOPE,
    });
  }),
);

// ── POST /me/chart/decision-receipts/:receiptId/outcome — APPEND only ───────
const outcomeSchema = z.object({
  kind: z.enum(["OUTCOME", "REVIEW"]),
  outcome: z
    .enum([
      "WIN",
      "LOSS",
      "BREAKEVEN",
      "NO_TRADE_CORRECT",
      "NO_TRADE_MISSED",
      "EXPIRED",
      "UNKNOWN",
    ])
    .optional(),
  plQuality: z.enum(["KNOWN", "ESTIMATED", "UNKNOWN"]).optional(),
  realizedPl: z.number().optional(),
  note: z.string().max(2000).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});
router.post(
  "/me/chart/decision-receipts/:receiptId/outcome",
  requireUser,
  safe(async (req, res) => {
    const parsed = outcomeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      err(res, 400, "invalid_body");
      return;
    }
    const userId = req.authUser!.id;
    const receiptId = String(req.params.receiptId ?? "").slice(0, 64);
    if (!receiptId) {
      err(res, 404, "not_found");
      return;
    }
    const appended = await appendReceiptOutcome({
      userId,
      receiptRef: receiptId,
      kind: parsed.data.kind,
      outcome: parsed.data.outcome ?? null,
      plQuality: parsed.data.plQuality ?? null,
      realizedPl: parsed.data.realizedPl ?? null,
      note: parsed.data.note ?? null,
      evidence: parsed.data.evidence,
    });
    // null ⇒ receipt not found or not owned by the caller (per-user isolation).
    if (!appended) {
      err(res, 404, "not_found");
      return;
    }
    res.json({ outcome: appended, ...SAFETY_ENVELOPE });
  }),
);

// ── POST /me/chart/similar-setups — Slow-Brain similar lookup ───────────────
const similarSchema = z.object({
  symbol: z.string().min(1).max(64),
  timeframe: TIMEFRAME.default("M5"),
  limit: z.number().int().min(1).max(5000).default(300),
  matchLimit: z.number().int().min(1).max(20).default(5),
  direction: DIRECTION.optional(),
});
router.post(
  "/me/chart/similar-setups",
  requireUser,
  safe(async (req, res) => {
    const parsed = similarSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      err(res, 400, "invalid_body");
      return;
    }
    const userId = req.authUser!.id;
    const { symbol, timeframe, limit, matchLimit, direction } = parsed.data;
    const state = await buildChartIntelligenceState(symbol, timeframe, limit);
    const queryFingerprint = buildSetupFingerprint(state, {
      direction: direction ?? undefined,
    });
    const result = await findSimilarSetups(userId, queryFingerprint, matchLimit);
    res.json({ result, queryFingerprint, ...SAFETY_ENVELOPE });
  }),
);

// ── GET /me/chart/behavior-protection — advisory behavior signals ───────────
router.get(
  "/me/chart/behavior-protection",
  requireUser,
  safe(async (req, res) => {
    const userId = req.authUser!.id;
    const role = resolveProductRole(req.authUser);
    const protection = await getBehaviorProtection(userId, {
      isInvestor: role === "INVESTOR",
    });
    res.json({ protection, ...SAFETY_ENVELOPE });
  }),
);

// ── GET /admin/chart/decision-receipts — admin cross-user history ───────────
// Gated on the EFFECTIVE role (u.role): an admin previewing-as-user is
// downgraded to USER upstream and lands in the 403 branch here.
const adminListSchema = z.object({
  symbol: z.string().min(1).max(64).optional(),
  userId: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
router.get(
  "/admin/chart/decision-receipts",
  requireUser,
  safe(async (req, res) => {
    const u = req.authUser!;
    if (u.role !== "ADMIN" && u.role !== "OWNER") {
      err(res, 403, "admin_required");
      return;
    }
    const parsed = adminListSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      err(res, 400, "invalid_query");
      return;
    }
    const receipts = await listAllReceiptsForAdmin({
      symbol: parsed.data.symbol,
      userId: parsed.data.userId,
      limit: parsed.data.limit,
    });
    res.json({ receipts, ...SAFETY_ENVELOPE });
  }),
);

// ── GET /me/chart/annotations — per-user marked levels / zones / price alerts ─
const listAnnotationsSchema = z.object({
  symbol: z.string().min(1).max(64).optional(),
  includeDismissed: z.coerce.boolean().optional(),
});
router.get(
  "/me/chart/annotations",
  requireUser,
  safe(async (req, res) => {
    const userId = req.authUser!.id;
    const parsed = listAnnotationsSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      err(res, 400, "invalid_query");
      return;
    }
    const rows = await listAnnotations(userId, {
      symbol: parsed.data.symbol,
      includeDismissed: parsed.data.includeDismissed,
    });
    res.json({ annotations: rows.map(toAnnotationDTO), ...SAFETY_ENVELOPE });
  }),
);

// ── POST /me/chart/annotations — create a marked level / zone / price alert ──
const createAnnotationSchema = z
  .object({
    symbol: z.string().min(1).max(64),
    displaySymbol: z.string().min(1).max(64).optional(),
    timeframe: TIMEFRAME.default("M5"),
    kind: z.enum(["SUPPORT", "RESISTANCE", "WATCH_ZONE", "PRICE_ALERT"]),
    direction: z.enum(["above", "below"]).optional(),
    price: z.number().finite(),
    priceTo: z.number().finite().optional(),
    note: z.string().max(280).optional(),
    expiresInHours: z.number().int().min(1).max(720).optional(),
  })
  .refine((d) => d.kind !== "PRICE_ALERT" || !!d.direction, {
    message: "direction is required for PRICE_ALERT",
    path: ["direction"],
  })
  .refine((d) => d.kind !== "WATCH_ZONE" || typeof d.priceTo === "number", {
    message: "priceTo is required for WATCH_ZONE",
    path: ["priceTo"],
  });
router.post(
  "/me/chart/annotations",
  requireUser,
  safe(async (req, res) => {
    const userId = req.authUser!.id;
    const parsed = createAnnotationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      err(res, 400, "invalid_body");
      return;
    }
    const d = parsed.data;
    const expiresAt = d.expiresInHours
      ? new Date(Date.now() + d.expiresInHours * 60 * 60 * 1000)
      : null;
    const created = await createAnnotation({
      userId,
      symbol: d.symbol,
      displaySymbol: d.displaySymbol ?? null,
      timeframe: d.timeframe,
      kind: d.kind,
      direction: d.direction ?? null,
      price: d.price,
      priceTo: d.priceTo ?? null,
      note: d.note ?? null,
      expiresAt,
    });
    if (!created) {
      err(res, 500, "create_failed");
      return;
    }
    res.json({ annotation: toAnnotationDTO(created), ...SAFETY_ENVELOPE });
  }),
);

// ── DELETE /me/chart/annotations/:id — SOFT-delete (dismiss) ─────────────────
router.delete(
  "/me/chart/annotations/:id",
  requireUser,
  safe(async (req, res) => {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      err(res, 400, "invalid_id");
      return;
    }
    const ok = await dismissAnnotation(userId, id);
    if (!ok) {
      err(res, 404, "not_found");
      return;
    }
    res.json({ dismissed: true, ...SAFETY_ENVELOPE });
  }),
);

// ── POST /me/chart/ai-alerts/scan — AI-aware transition + price-alert scan ───
// Builds the current Chart Intelligence State for the symbol/timeframe and fires
// / clears deduped alerts on real state transitions. Role-aware, per-user,
// fail-open. NEVER places a trade.
const aiAlertsScanSchema = z.object({
  symbol: z.string().min(1).max(64),
  timeframe: TIMEFRAME.default("M5"),
  limit: z.number().int().min(1).max(5000).default(300),
});
router.post(
  "/me/chart/ai-alerts/scan",
  requireUser,
  safe(async (req, res) => {
    const parsed = aiAlertsScanSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      err(res, 400, "invalid_body");
      return;
    }
    const userId = req.authUser!.id;
    const role = resolveProductRole(req.authUser) as ChartAlertRole;
    const { symbol, timeframe, limit } = parsed.data;
    const state = await buildChartIntelligenceState(symbol, timeframe, limit);

    // Enrich the scan with honest, read-only flame + open-position signals so
    // the engine can fire scalp-timing and position-near-stop/target alerts.
    // Suppressed for investors (view-only): they never get trade-oriented data.
    let signals: ChartAlertSignals | undefined;
    if (role !== "INVESTOR") {
      const flame = await deriveChartFlameSignal(symbol, timeframe, limit).catch(
        () => null,
      );
      let openPositions: ChartAlertOpenPosition[] = [];
      try {
        const open = await getOpenPositions(userId);
        openPositions = open.positions
          .filter(
            (p) =>
              typeof p.symbol === "string" &&
              p.symbol.toUpperCase() === symbol.toUpperCase(),
          )
          .map((p) => {
            const sl = p.stopLoss == null ? null : Number(p.stopLoss);
            const tp = p.takeProfit == null ? null : Number(p.takeProfit);
            return {
              id: p.id,
              side: String(p.side).toUpperCase() === "SELL" ? "SELL" : "BUY",
              entry: Number(p.entryPrice),
              sl: sl != null && Number.isFinite(sl) ? sl : null,
              tp: tp != null && Number.isFinite(tp) ? tp : null,
            } satisfies ChartAlertOpenPosition;
          })
          .filter((p) => Number.isFinite(p.entry));
      } catch {
        openPositions = [];
      }
      signals = {
        flame: flame
          ? { stage: flame.stage, entryTiming: flame.entryTiming, blind: flame.blind }
          : null,
        openPositions,
      };
    }

    const result = await scanChartAlerts(userId, role, state, signals);
    res.json({ result, ...SAFETY_ENVELOPE });
  }),
);

// ── GET /admin/chart/benchmark — Chart Brain benchmark scorecard ────────────
// Admin-only aggregation of REAL receipts/outcomes/governance traces into 15
// benchmark scores (+ trend, weak areas, recent failed reads, successful
// no-trades, speed/feed warnings). No fabricated scores — a dimension is null
// when there is not enough real evidence. Gated on the EFFECTIVE role so an
// admin previewing-as-user is downgraded and lands in the 403 branch.
const benchmarkSchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(90).default(30),
});
router.get(
  "/admin/chart/benchmark",
  requireUser,
  safe(async (req, res) => {
    const u = req.authUser!;
    if (u.role !== "ADMIN" && u.role !== "OWNER") {
      err(res, 403, "admin_required");
      return;
    }
    const parsed = benchmarkSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      err(res, 400, "invalid_query");
      return;
    }
    const benchmark = await computeChartBrainBenchmark({
      windowDays: parsed.data.windowDays,
    });
    res.json({ benchmark, ...SAFETY_ENVELOPE });
  }),
);

export const meChartBrainRouter = router;
