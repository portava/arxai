// ARX Fund Book — investor-facing controls endpoint (Task #133).
//
// SAFETY (inviolable):
// - STRICTLY per-user. The value-status read is scoped to req.authUser.id only.
//   No row or status from investor A is ever returned to investor B.
// - DETECTION ONLY. This route NEVER edits a balance, closes a position, or
//   touches any execution path, lot sizing, the 16-gate live pipeline, kill
//   switch, or any broker dispatch surface.
// - Investors only ever see the coarse 5-state freshness + a calm, investor-safe
//   message. They NEVER see broker internals, admin notes, or the admin source.
// - No paper/sim/mock/fake/guaranteed-return wording anywhere.

import { Router, type Request } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { getValueStatusForUser } from "../lib/fundbook/fundControls.js";

const router = Router();

function uid(req: Request): number | null {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
}

// ── GET /me/fundbook/value-status ───────────────────────────────────────────
// The caller's own value freshness verdict. Returns only the coarse status +
// investor-safe message (never the admin source / broker internals).
router.get("/me/fundbook/value-status", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return;
  }
  const verdict = await getValueStatusForUser(userId);
  res.json({
    ok: true,
    status: verdict.status,
    message: verdict.investorMessage,
    asOf: new Date().toISOString(),
  });
});

export { router as meFundControlsRouter };
