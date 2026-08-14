// Phase 28-MT5-DEMO-ARMING (May 2026, sub-phase 2) — demo command queue.
//
// User-owned demo command lifecycle endpoints:
//   POST   /api/me/demo-commands               -> create DRAFT, advance to
//                                                 USER_CONFIRMATION_REQUIRED
//   POST   /api/me/demo-commands/:id/confirm   -> advance to DEMO_APPROVED
//   POST   /api/me/demo-commands/:id/cancel    -> BLOCKED (terminal)
//   GET    /api/me/demo-commands               -> list owned commands
//   GET    /api/me/demo-commands/:id           -> single owned command
//
// Dispatch to the EA is a SEPARATE per-user endpoint
// (`POST /api/me/demo-commands/:id/dispatch`) that re-evaluates every
// per-user gate at send time. The create/confirm/list/get endpoints here
// only manage queue lifecycle and report the dispatch posture as a hint —
// the chokepoint is the dispatch endpoint, not this file.

import { Router, type Request } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  cancelCommand,
  cancelOrphanedSentCommands,
  confirmCommand,
  createDraftCommand,
  getUserCommand,
  listUserCommands,
} from "../lib/mt5/demoCommandQueue.js";
import { consumeApprovedCommand } from "../lib/mt5/demoCommandConsumer.js";
import { DEMO_COMMAND_TYPES, type DemoCommandType } from "@workspace/domain/safety-contracts/executionMode";

const router = Router();

function getUserId(req: Request): number | null {
  const authUser = (req as Request & { authUser?: { id: number } }).authUser;
  return authUser?.id ?? null;
}

function clientIp(req: Request): string | null {
  const xf = req.header("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() ?? null;
  return req.ip ?? null;
}

const draftBodySchema = z.object({
  commandType: z.enum(DEMO_COMMAND_TYPES as readonly [DemoCommandType, ...DemoCommandType[]]),
  payload: z.record(z.string(), z.unknown()),
});

router.post("/me/demo-commands", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const parsed = draftBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_BODY", issues: parsed.error.issues }); return;
  }
  const result = await createDraftCommand({
    userId,
    commandType: parsed.data.commandType,
    payload: parsed.data.payload,
    actorIp: clientIp(req),
    actorUserAgent: req.header("user-agent") ?? null,
  });
  res.status(result.ok ? 201 : 409).json({
    ok: result.ok,
    reason: result.reason ?? null,
    command: result.command ?? null,
    canDispatchToMt5: false,
    canDispatchToMt5Reason:
      "DISPATCH_DEFERRED_TO_PER_USER_ENDPOINT — call POST /api/me/demo-commands/:id/dispatch to attempt send; per-user gate is re-evaluated at send time.",
  });
});

router.post("/me/demo-commands/:commandId/confirm", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const commandId = String(req.params.commandId ?? "");
  if (!commandId) { res.status(400).json({ error: "MISSING_COMMAND_ID" }); return; }
  const result = await confirmCommand({
    userId,
    commandId,
    actorIp: clientIp(req),
    actorUserAgent: req.header("user-agent") ?? null,
  });
  res.status(result.ok ? 200 : 409).json({
    ok: result.ok,
    reason: result.reason ?? null,
    command: result.command ?? null,
    canDispatchToMt5: false,
    canDispatchToMt5Reason:
      "DISPATCH_DEFERRED_TO_PER_USER_ENDPOINT — call POST /api/me/demo-commands/:id/dispatch to attempt send; per-user gate is re-evaluated at send time.",
  });
});

const cancelBodySchema = z.object({ reason: z.string().min(1).max(500).optional() });

router.post("/me/demo-commands/:commandId/cancel", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const commandId = String(req.params.commandId ?? "");
  if (!commandId) { res.status(400).json({ error: "MISSING_COMMAND_ID" }); return; }
  const parsed = cancelBodySchema.safeParse(req.body ?? {});
  const reason = parsed.success && parsed.data.reason ? parsed.data.reason : "user_cancel";
  const result = await cancelCommand({
    userId,
    commandId,
    reason,
    actorIp: clientIp(req),
    actorUserAgent: req.header("user-agent") ?? null,
  });
  res.status(result.ok ? 200 : 409).json({
    ok: result.ok,
    reason: result.reason ?? null,
    command: result.command ?? null,
  });
});

// Sub-phase 3D — bulk-cancel orphaned demo commands (DEMO_APPROVED or
// SENT_TO_MT5_DEMO bound to a previous bridge connection). Transitions to
// FAILED with reason EXPIRED_ORPHANED_BRIDGE_COMMAND. Never dispatches.
router.post("/me/demo-commands/cancel-orphaned", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const result = await cancelOrphanedSentCommands({
    userId,
    actorIp: clientIp(req),
    actorUserAgent: req.header("user-agent") ?? null,
  });
  res.status(result.ok ? 200 : 409).json({
    ok: result.ok,
    cancelledCommandIds: result.cancelledCommandIds,
    cancelledCount: result.cancelledCommandIds.length,
    currentBridgeConnectionId: result.currentBridgeConnectionId,
    reason: result.reason ?? null,
    safetyMode: "demo_only",
    liveExecutionBlocked: true,
  });
});

// Sub-phase 3B — user-initiated dispatch trigger. Calls the consumer which
// re-runs the per-user gate + chokepoint AND writes SENT_TO_MT5_DEMO under
// a partial-unique-index belt. Live execution remains LOCKED; this only
// admits demo-account, EA-v1.26+, verified, armed, confirmed commands.
router.post("/me/demo-commands/:commandId/dispatch", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const commandId = String(req.params.commandId ?? "");
  if (!commandId) { res.status(400).json({ error: "MISSING_COMMAND_ID" }); return; }
  const result = await consumeApprovedCommand({
    userId,
    commandId,
    actorIp: clientIp(req),
    actorUserAgent: req.header("user-agent") ?? null,
  });
  res.status(result.ok ? 200 : 409).json({
    ok: result.ok,
    reason: result.reason,
    stage: result.stage,
    command: result.command ?? null,
    perUserBlockers: result.perUserBlockers ?? null,
    duplicateMatchedCommandIds: result.duplicateMatchedCommandIds ?? null,
    canDispatchToMt5: result.canDispatchToMt5Allowed,
  });
});

router.get("/me/demo-commands", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const limit = Number(req.query.limit ?? 50);
  const items = await listUserCommands({ userId, limit: Number.isFinite(limit) ? limit : 50 });
  res.json({ items, count: items.length, canDispatchToMt5: false });
});

router.get("/me/demo-commands/:commandId", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const commandId = String(req.params.commandId ?? "");
  if (!commandId) { res.status(400).json({ error: "MISSING_COMMAND_ID" }); return; }
  const row = await getUserCommand(userId, commandId);
  if (!row) { res.status(404).json({ error: "COMMAND_NOT_FOUND" }); return; }
  res.json({ command: row, canDispatchToMt5: false });
});

export default router;
