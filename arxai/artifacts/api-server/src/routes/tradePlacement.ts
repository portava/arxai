// Phase 3 — User-facing trade placement endpoint.
//
// SAFETY: requires auth; delegates entirely to placeOrder() which is the
// SOLE supported path. Cannot bypass the guard chain.

import { Router, type IRouter, type Request } from "express";
import { z } from "zod/v4";
import { placeOrder } from "../lib/adminTrading/placeOrder.js";
import { denyInvestorExecution } from "../lib/auth/productRole.js";

const router: IRouter = Router();

const placeSchema = z.object({
  mode: z.enum(["SIMULATED", "DEMO", "LIVE"]),
  symbol: z.string().min(1).max(20),
  side: z.enum(["BUY", "SELL"]),
  lotSize: z.number().positive().max(100),
  stopLoss: z.number().positive().nullable().optional(),
  takeProfit: z.number().positive().nullable().optional(),
  confirmedByUser: z.boolean().default(false),
});

// Task #71 — investor accounts are view-only and cannot place trades.
router.post("/trade/place", denyInvestorExecution, async (req, res) => {
  const userId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? 0;
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const parsed = placeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.message });
    return;
  }
  const result = await placeOrder({
    userId,
    mode: parsed.data.mode,
    symbol: parsed.data.symbol,
    side: parsed.data.side,
    lotSize: parsed.data.lotSize,
    stopLoss: parsed.data.stopLoss ?? null,
    takeProfit: parsed.data.takeProfit ?? null,
    confirmedByUser: parsed.data.confirmedByUser,
    requestedBy: "user",
  });
  const httpStatus = result.status === "QUEUED" || result.status === "SIMULATED_FILL" ? 200 : 400;
  res.status(httpStatus).json({ ok: httpStatus === 200, result });
});

export default router;
