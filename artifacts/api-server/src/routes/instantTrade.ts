// Global Instant Trade Router — POST /api/trades/instant/*
//
// Single shared backend used by every trade-capable surface in the
// app: trade panel, scanner, chart, watchlist, position card, dashboard,
// alert click-through, and Ruby AI (text + voice). All callers send the
// same `InstantTradeIntent` shape so audit logs and source attribution
// are uniform.
//
// SAFETY: zero new gate logic lives here. Every decision (live one-click
// enabled, master-live access, server master switch, 16-gate Phase B,
// kill switch, max lot, daily loss, symbol allowlist, missing SL unless
// override) is enforced inside `executeInstant()` in
// `lib/live/instantTrade.ts`, which calls the existing
// `createLiveDraft → confirmLiveCommand → dispatchLiveCommand` pipeline.
//
// What this route file adds:
//   - HTTP surface area
//   - Zod input validation
//   - Pulls IP / User-Agent off req for audit row
//   - Maps `InstantTradeResult` → HTTP status code
import express, { type IRouter, Router, type Request } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { denyInvestorExecution } from "../lib/auth/productRole.js";
import {
  executeInstant, validateInstant,
  INSTANT_TRADE_SOURCES, INSTANT_TRADE_ACTIONS,
  type InstantTradeIntent,
} from "../lib/live/instantTrade.js";
import { detectLegacyPaperModeRequest } from "../lib/safety/rejectLegacyPaperMode.js";
import { categorizeLiveBlock } from "../lib/governance/effectiveGovernance.js";

const router: IRouter = Router();
router.use(express.json());
// Task #71 — investor accounts are view-only and can never reach any
// trading-execution surface. Applied per-route below (not via router.use)
// because this router is mounted globally (router.use(instantTradeRouter));
// a router-level use() leaks the guard onto every later route in the chain.

/**
 * T019 — attach the block category to a refusal so every trade surface can
 * explain *why* it was blocked and whether the owner can change it in
 * Admin Risk/Governance (changeableInGovernance) or it is permanent
 * broker/technical/security truth (brokerEnforced). The raw primaryReason is
 * already returned; the frontend gates whether to show it.
 */
function withBlockCategory(reason: string | null) {
  const c = categorizeLiveBlock(reason);
  return {
    category: c.category,
    blockUserReason: c.userReason,
    blockAdminReason: c.adminReason,
    changeableInGovernance: c.changeableInGovernance,
    brokerEnforced: c.brokerEnforced,
  };
}

const userOf = (req: Request) =>
  (req as Request & { authUser?: { id: number } }).authUser!.id;

const ipOf = (req: Request) =>
  (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
  ?? req.socket.remoteAddress ?? null;
const uaOf = (req: Request) => (req.headers["user-agent"] as string | undefined) ?? null;

const IntentSchema = z.object({
  source: z.enum(INSTANT_TRADE_SOURCES),
  action: z.enum(INSTANT_TRADE_ACTIONS),
  // Phase 5: "paper" removed from production mode union. Legacy
  // requests sending accountMode=paper are intercepted in parseIntent()
  // below and rejected with the canonical message before Zod runs.
  accountMode: z.enum(["live", "demo"]),
  symbol: z.string().min(1).max(32).optional(),
  volume: z.number().positive().optional(),
  orderType: z.string().min(1).max(32).optional(),
  stopLoss: z.number().nullable().optional(),
  takeProfit: z.number().nullable().optional(),
  positionId: z.string().min(1).max(64).optional(),
  newStopLoss: z.number().nullable().optional(),
  newTakeProfit: z.number().nullable().optional(),
  oneClick: z.boolean().optional(),
  aiCommand: z.boolean().optional(),
  rawUserCommand: z.string().max(1024).nullable().optional(),
  parsedByRuby: z.boolean().optional(),
}) satisfies z.ZodType<InstantTradeIntent>;

function parseIntent(req: Request, defaultAction?: "BUY" | "SELL" | "CLOSE" | "CLOSE_ALL" | "MODIFY_SL_TP") {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (defaultAction && !body.action) body.action = defaultAction;
  const r = IntentSchema.safeParse(body);
  return r;
}

/** Phase 5: canonical 400 for `accountMode=paper` (or any legacy paper mode field). */
function rejectLegacyPaperOrNull(req: Request, res: Parameters<Parameters<typeof router.post>[1]>[1]): boolean {
  const legacy = detectLegacyPaperModeRequest(req.body);
  if (!legacy) return false;
  res.status(400).json({ ok: false, ...legacy });
  return true;
}

router.post("/trades/instant/execute", denyInvestorExecution, requireUser, async (req, res) => {
  if (rejectLegacyPaperOrNull(req, res)) return;
  const userId = userOf(req);
  const parsed = parseIntent(req);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_INTENT", issues: parsed.error.issues });
    return;
  }
  const result = await executeInstant({
    userId, intent: parsed.data, ip: ipOf(req), ua: uaOf(req),
  });
  if (result.ok) {
    res.json({ ok: true, action: result.action, commandId: result.commandId, detail: result.detail });
    return;
  }
  res.status(result.httpStatus).json({
    ok: false, error: result.error, primaryReason: result.primaryReason ?? null, detail: result.detail,
    ...withBlockCategory(result.primaryReason ?? null),
  });
});

router.post("/trades/instant/close", denyInvestorExecution, requireUser, async (req, res) => {
  if (rejectLegacyPaperOrNull(req, res)) return;
  const userId = userOf(req);
  const parsed = parseIntent(req, "CLOSE");
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_INTENT", issues: parsed.error.issues });
    return;
  }
  const intent: InstantTradeIntent = { ...parsed.data, action: "CLOSE" };
  const result = await executeInstant({ userId, intent, ip: ipOf(req), ua: uaOf(req) });
  if (result.ok) {
    res.json({ ok: true, action: "CLOSE", commandId: result.commandId, detail: result.detail });
    return;
  }
  res.status(result.httpStatus).json({ ok: false, error: result.error, primaryReason: result.primaryReason ?? null, detail: result.detail, ...withBlockCategory(result.primaryReason ?? null) });
});

router.post("/trades/instant/close-all", denyInvestorExecution, requireUser, async (req, res) => {
  if (rejectLegacyPaperOrNull(req, res)) return;
  const userId = userOf(req);
  const parsed = parseIntent(req, "CLOSE_ALL");
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_INTENT", issues: parsed.error.issues });
    return;
  }
  const intent: InstantTradeIntent = { ...parsed.data, action: "CLOSE_ALL" };
  const result = await executeInstant({ userId, intent, ip: ipOf(req), ua: uaOf(req) });
  if (result.ok) {
    res.json({ ok: true, action: "CLOSE_ALL", detail: result.detail });
    return;
  }
  res.status(result.httpStatus).json({ ok: false, error: result.error, primaryReason: result.primaryReason ?? null, detail: result.detail, ...withBlockCategory(result.primaryReason ?? null) });
});

router.post("/trades/instant/validate", denyInvestorExecution, requireUser, async (req, res) => {
  if (rejectLegacyPaperOrNull(req, res)) return;
  const userId = userOf(req);
  const parsed = parseIntent(req);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_INTENT", issues: parsed.error.issues });
    return;
  }
  const result = await validateInstant({ userId, intent: parsed.data, ip: ipOf(req), ua: uaOf(req) });
  if (result.ok) { res.json({ ok: true, detail: result.detail }); return; }
  res.status(result.httpStatus).json({ ok: false, error: result.error, primaryReason: result.primaryReason ?? null, ...withBlockCategory(result.primaryReason ?? null) });
});

export default router;
