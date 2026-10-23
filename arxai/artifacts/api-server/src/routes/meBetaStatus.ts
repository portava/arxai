// Phase Private-Beta-10 — Per-user beta status. Per-user scoped via
// authenticated session. Read-only. No live-trading surface.

import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, betaInvitesTable } from "@workspace/db";

const router = Router();

function requireUser(req: Request, res: Response): { id: number; email: string } | null {
  const u = (req as unknown as { authUser?: { id: number; email: string } }).authUser;
  if (!u) { res.status(401).json({ error: "AUTH_REQUIRED" }); return null; }
  return { id: u.id, email: u.email };
}

router.get("/me/beta-status", async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const rows = await db.select({
    id: betaInvitesTable.id,
    cohort: betaInvitesTable.cohort,
    accountMode: betaInvitesTable.accountMode,
    status: betaInvitesTable.status,
    invitedAt: betaInvitesTable.invitedAt,
    acceptedAt: betaInvitesTable.acceptedAt,
  }).from(betaInvitesTable).where(
    and(
      eq(betaInvitesTable.acceptedUserId, u.id),
      eq(betaInvitesTable.cohort, "ARX_PRIVATE_BETA_10"),
    ),
  ).limit(1);
  const r = rows[0];
  res.json({
    inBeta: !!r,
    cohort: r?.cohort ?? null,
    accountMode: r?.accountMode ?? null,
    status: r?.status ?? null,
    invitedAt: r?.invitedAt ?? null,
    acceptedAt: r?.acceptedAt ?? null,
    paused: r?.status === "PAUSED",
    revoked: r?.status === "REVOKED",
    notice: "You're in the ARX AI private beta. Live trading remains disabled unless explicitly approved by the operator.",
  });
});

export default router;
