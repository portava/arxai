// ── ARX Bridge v2 — per-user (session-authed) status route (Task #398) ──────
//
// Split out from bridgeV2.ts on purpose: the admin observability endpoints in
// that file legitimately read `req.query.userId` to scope by user, which the
// per-user-isolation-me-routes CI guard forbids in ANY file that also declares
// a /me/* route. Keeping the user route here — with NO client-supplied userId,
// session auth only — keeps both files clean against that guard.
//
// SAFETY:
// - Authenticated by the user SESSION (`requireUser`), never a bridge token.
// - Scoped strictly to the caller's own authUser.id — no client-supplied id.
// - Returns the REDACTED freshness DTO only: no sequences, integrity counters,
//   config versions, command counts, tokens, or gate snapshots. Honest empty
//   when the user has no v2 bridge. READ ONLY — never an execution affordance.
import { Router, type Request, type Response } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { buildBridgeV2UserStatus } from "../lib/bridgeV2/status.js";

const router = Router();

// ─── GET /api/me/bridge/v2/status ───────────────────────────────────────────
router.get("/me/bridge/v2/status", requireUser, async (req: Request, res: Response): Promise<void> => {
  const u = (req as Request & { authUser?: { id?: number } }).authUser;
  if (!u?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return;
  }
  const status = await buildBridgeV2UserStatus(u.id);
  res.json({ ok: true, ...status });
});

export default router;
