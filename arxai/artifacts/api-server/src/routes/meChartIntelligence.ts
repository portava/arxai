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
import {
  applyRenderEvidence, recordRenderEvidence, judgeRenderEvidence, latestRenderEvidence, HA_SAMPLE_LIMIT,
} from "../lib/data/chart/renderEvidence.js";
import { normalizeChartTimeframe } from "../lib/data/chart/timeframes.js";
import { currentFeedScopeBridge } from "../lib/data/feedScope.js";
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
  visibleBarsRoundTripped: z.number().int().min(0).max(100_000),
  drawings: z.object({
    checked: z.number().int().min(0).max(10_000),
    failed: z.number().int().min(0).max(10_000),
    unplaced: z.number().int().min(0).max(10_000),
    failedIds: z.array(z.string().max(128)).max(20),
  }).strict(),
  projections: z.array(z.object({
    previewId: z.string().min(1).max(128),
    symbol: z.string().trim().min(1).max(32),
    timeframe: z.string().max(8),
    role: z.string().min(1).max(32),
    price: z.number().finite(),
    axisRoundTripOk: z.boolean().nullable(),
  }).strict()).max(40),
  // Heikin Ashi only (renderEvidence.ts "Heikin Ashi"): the server re-derives these.
  transform: z.literal("heikinAshi").nullable().optional(),
  transformVerified: z.boolean().nullable().optional(),
  transformCheck: z.object({
    seed: z.object({ open: z.number().finite(), close: z.number().finite() }).strict().nullable(),
    samples: z.array(z.object({
      time: z.number().int().positive(),
      source: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
      drawn: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
    }).strict()).min(1).max(HA_SAMPLE_LIMIT),
  }).strict().nullable().optional(),
}).strict();

router.post("/me/chart/render-evidence", requireUser, async (req, res): Promise<void> => {
  const parsed = RenderEvidenceBody.safeParse(req.body);
  const timeframe = parsed.success ? normalizeChartTimeframe(parsed.data.timeframe) : null;
  const userId = req.authUser?.id;
  if (!parsed.success || !timeframe || userId == null) {
    res.status(400).json({ ok: false, error: "INVALID_RENDER_EVIDENCE" });
    return;
  }
  // Bind to the series this reader is served (their feed-scope bridge).
  recordRenderEvidence(userId, { ...parsed.data, timeframe }, await currentFeedScopeBridge());
  res.json({ ok: true });
});

// The latest render verdict for the reader's own chart, judged against the
// series served now (the chart's "Render verified" chip). Read-only.
const RenderVerdictQuery = z.object({
  symbol: z.string().trim().min(1).max(32),
  timeframe: z.string().min(1).max(8),
});

router.get("/me/chart/render-evidence", requireUser, async (req, res): Promise<void> => {
  const parsed = RenderVerdictQuery.safeParse(req.query);
  const timeframe = parsed.success ? normalizeChartTimeframe(parsed.data.timeframe) : null;
  const userId = req.authUser?.id;
  if (!parsed.success || !timeframe || userId == null) {
    res.status(400).json({ ok: false, error: "INVALID_RENDER_VERDICT_REQUEST" });
    return;
  }
  // Resolve the reader's feed scope first: the judge reads it synchronously.
  await currentFeedScopeBridge();
  const latest = latestRenderEvidence(userId, parsed.data.symbol, timeframe);
  if (!latest) {
    res.json({ ok: true, verdict: { status: "absent", detail: "The chart has not reported a measured draw yet." }, report: null, ...SAFETY_ENVELOPE });
    return;
  }
  let verdict;
  try {
    const state = await buildChartIntelligenceState(parsed.data.symbol, timeframe, 300);
    verdict = judgeRenderEvidence(userId, state);
  } catch (err) {
    req.log.warn({ err }, "render verdict: served series unavailable");
    verdict = { status: "unbound" as const, detail: "The served series is unavailable, so the draw cannot be bound to it." };
  }
  res.json({ ok: true, verdict, report: latest, ...SAFETY_ENVELOPE });
});

export default router;
