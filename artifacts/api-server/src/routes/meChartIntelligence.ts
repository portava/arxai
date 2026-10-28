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
  }

  // Strip adminDetail from the brokerAlignment before serializing — this field
  // contains raw bid/ask/deviation numbers that must not reach end users.
  const { adminDetail: _adminDetail, ...safeAlignment } = state.brokerAlignment;
  const safeState = { ...state, brokerAlignment: { ...safeAlignment, adminDetail: null } };

  res.json({ state: safeState, ...SAFETY_ENVELOPE });
});

export default router;
