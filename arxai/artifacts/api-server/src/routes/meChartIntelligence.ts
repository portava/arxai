// Chart Brain v2 — Task 1: Chart Intelligence State endpoint (Fast Brain).
// SAFETY: requireUser (per-user gated → 401 when unauthenticated). Read-only;
// never places, modifies, or closes a trade. Base state is built from public
// candle-truth only; broker alignment enrichment is per-user but read-only.
// Never blocks candle rendering or live execution.
import { Router } from "express";
import { GetMeChartIntelligenceQueryParams } from "@workspace/api-zod";
import { requireUser } from "../lib/auth/middleware.js";
import { buildChartIntelligenceState } from "../lib/data/chart/chartIntelligence.js";
import { enrichStateWithUserBrokerQuote } from "../lib/data/chart/userBrokerAlignment.js";
import { applyRenderEvidence, recordRenderEvidence } from "../lib/data/chart/renderEvidence.js";
import { normalizeChartTimeframe } from "../lib/data/chart/timeframes.js";
import { z } from "zod/v4";

const router = Router();
const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

router.get("/me/chart/intelligence", requireUser, async (req, res): Promise<void> => {
  let q;
  try {
    q = GetMeChartIntelligenceQueryParams.parse({
      symbol: req.query["symbol"],
      timeframe: req.query["timeframe"] ?? "M5",
      limit: req.query["limit"] != null ? Number(req.query["limit"]) : 300,
    });
  } catch (err) {
    req.log.warn({ err }, "invalid chart intelligence request");
    res.status(400).json({ error: "Invalid chart intelligence request" });
    return;
  }

  // Build (or return cached) base state — shared across users.
  let state = await buildChartIntelligenceState(q.symbol, q.timeframe, q.limit);

  // Route-level enrichment: the user's broker quote, bound to the served
  // series through brokerQuoteBinding.ts (see userBrokerAlignment.ts). Only a
  // BOUND quote measures alignment. Fail-open: any error falls through to the
  // base state with the noBrokerAlignment placeholder (mirror unmeasured).
  const userId = req.authUser?.id;
  if (userId != null) {
    try {
      state = await enrichStateWithUserBrokerQuote(state, { userId, ...q });
    } catch (enrichErr) {
      req.log.warn({ enrichErr }, "broker alignment enrichment failed — using placeholder");
    }
    state = applyRenderEvidence(state, userId);
  }

  // Strip adminDetail from the brokerAlignment before serializing — this field
  // contains raw bid/ask/deviation numbers that must not reach end users.
  const { adminDetail: _adminDetail, ...safeAlignment } = state.brokerAlignment;
  const safeState = { ...state, brokerAlignment: { ...safeAlignment, adminDetail: null } };

  res.json({ state: safeState, ...SAFETY_ENVELOPE });
});

// Renderer evidence from the user's own chart draw (renderEvidence.ts). Record
// only; it changes no trade, gate or order. The server binds it to the series
// it serves before it counts, so a report can never raise an unrelated read.
const RenderEvidenceBody = z.object({
  symbol: z.string().trim().min(1).max(32),
  timeframe: z.string().min(1).max(8),
  source: z.string().min(1).max(128),
  displayMode: z.enum(["ohlc", "close", "hollow", "heikinAshi"]),
  newestBarTime: z.number().int().positive(),
  barsCompared: z.number().int().min(0).max(100_000),
  mismatchedBars: z.number().int().min(0).max(100_000),
  droppedBars: z.number().int().min(0).max(100_000),
  priceRoundTripOk: z.boolean(),
  timeRoundTripOk: z.boolean().nullable(),
}).strict();

router.post("/me/chart/render-evidence", requireUser, (req, res): void => {
  const parsed = RenderEvidenceBody.safeParse(req.body);
  const timeframe = parsed.success ? normalizeChartTimeframe(parsed.data.timeframe) : null;
  const userId = req.authUser?.id;
  if (!parsed.success || !timeframe || userId == null) {
    res.status(400).json({ ok: false, error: "INVALID_RENDER_EVIDENCE" });
    return;
  }
  recordRenderEvidence(userId, { ...parsed.data, timeframe });
  res.json({ ok: true });
});

export default router;
