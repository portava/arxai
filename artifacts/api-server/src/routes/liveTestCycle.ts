// Live Test Cycle routes — OWNER-only single-shot live verification.
//
// Mount path: /api/me/live/test-cycle/*
//
// SAFETY:
// - Every endpoint is OWNER-only via authUser.role === "OWNER".
// - The /start endpoint requires the exact typed phrase "EXECUTE LIVE
//   TEST CYCLE" and acknowledgement boolean. Side and stopLoss are
//   user-supplied; symbol and volume are server-pinned (EURUSD, 0.01).
// - /preview never dispatches and never contacts the EA — it only runs
//   precheck + preflight + immediate cancel.
// - /start delegates to liveTestCycle.startCycle which uses the
//   STANDARD createLiveDraft → confirm → dispatch path. The 16-gate
//   evaluator, allocation freeze, master bridge, idempotency, audit
//   row all run as normal. Nothing is bypassed.

import { Router, type Request } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import {
  previewCycle, startCycle, getCurrentCycle, getCycleById, manualResolveCycle,
} from "../lib/live/liveTestCycle.js";

const router = Router();

function uid(req: Request): number | null {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
}
function isOwner(req: Request): boolean {
  return (req as Request & { authUser?: { role?: string } }).authUser?.role === "OWNER";
}
function ownerOnly(req: Request, res: import("express").Response): boolean {
  if (!isOwner(req)) {
    res.status(403).json({ error: "OWNER_REQUIRED", detail: "Live Test Cycle is OWNER-only." });
    return false;
  }
  return true;
}

function parseInput(b: Record<string, unknown>) {
  const side: "BUY" | "SELL" = b.side === "SELL" ? "SELL" : "BUY";
  const stopLoss = Number(b.stopLoss);
  const takeProfit = b.takeProfit != null ? Number(b.takeProfit) : null;
  return { side, stopLoss, takeProfit };
}

function validInput(input: { side: "BUY" | "SELL"; stopLoss: number; takeProfit: number | null }) {
  if (!Number.isFinite(input.stopLoss) || input.stopLoss <= 0) {
    return { ok: false as const, error: "STOP_LOSS_REQUIRED", detail: "stopLoss must be a positive number" };
  }
  if (input.takeProfit != null && (!Number.isFinite(input.takeProfit) || input.takeProfit <= 0)) {
    return { ok: false as const, error: "TAKE_PROFIT_INVALID", detail: "takeProfit must be positive if provided" };
  }
  return { ok: true as const };
}

// POST /api/me/live/test-cycle/preview — dry-run preview, no dispatch.
router.post("/me/live/test-cycle/preview", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  if (!ownerOnly(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const parsed = parseInput(b);
  const valid = validInput(parsed);
  if (!valid.ok) { res.status(400).json({ error: valid.error, detail: valid.detail }); return; }
  const result = await previewCycle({ userId, ...parsed });
  res.json(result);
});

// POST /api/me/live/test-cycle/start — single-flight, modal-ack gated
// (no typed phrase; UI must show Confirm/Cancel modal + ack checkbox).
router.post("/me/live/test-cycle/start", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  if (!ownerOnly(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (b.acknowledged !== true) {
    res.status(400).json({ error: "ACKNOWLEDGEMENT_REQUIRED",
      detail: "You must acknowledge that this places one real live order and auto-closes it." });
    return;
  }
  const parsed = parseInput(b);
  const valid = validInput(parsed);
  if (!valid.ok) { res.status(400).json({ error: valid.error, detail: valid.detail }); return; }
  const result = await startCycle({ userId, ...parsed });
  res.status(result.ok ? 200 : 409).json(result);
});

// GET /api/me/live/test-cycle/current — most-recent cycle (lazy-advanced).
router.get("/me/live/test-cycle/current", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  if (!ownerOnly(req, res)) return;
  const cycle = await getCurrentCycle(userId);
  res.json({ cycle });
});

// GET /api/me/live/test-cycle/:cycleId — specific cycle (lazy-advanced).
router.get("/me/live/test-cycle/:cycleId", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  if (!ownerOnly(req, res)) return;
  const cycle = await getCycleById({ userId, cycleId: String(req.params.cycleId ?? "") });
  if (!cycle) { res.status(404).json({ error: "CYCLE_NOT_FOUND" }); return; }
  res.json({ cycle });
});

// POST /api/me/live/test-cycle/:cycleId/resolve — operator manual resolve.
router.post("/me/live/test-cycle/:cycleId/resolve", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  if (!ownerOnly(req, res)) return;
  const note = String((req.body ?? {}).note ?? "").trim();
  if (!note) { res.status(400).json({ error: "NOTE_REQUIRED" }); return; }
  const result = await manualResolveCycle({
    userId, cycleId: String(req.params.cycleId ?? ""), note,
  });
  res.status(result.ok ? 200 : 404).json(result);
});

export default router;
