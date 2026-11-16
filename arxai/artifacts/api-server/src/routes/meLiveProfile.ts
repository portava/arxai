// Phase 22V — GET /api/me/live/profile
//
// Returns the calling user's current live risk-profile summary so the
// frontend (LiveTradeTicket, LiveSharedAccountPanel) can show the
// "Owner unrestricted live profile active" banner and skip blocking
// client-side cap warnings (server still enforces every other gate).

import express, { type IRouter, Router } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { getUserRiskProfile } from "../lib/live/userRiskProfile.js";

const router: IRouter = Router();
router.use(express.json());

router.get("/me/live/profile", requireUser, async (req, res) => {
  const sess = (req as express.Request & { authUser?: { id: number; role?: string } }).authUser!;
  const profile = await getUserRiskProfile(sess.id);
  res.json({
    ok: true,
    userId: sess.id,
    role: sess.role ?? null,
    templateId: profile.templateId,
    templateName: profile.templateName,
    isOwnerUnrestricted: profile.isOwnerUnrestricted,
    safety: {
      // Banner copy: this flag NEVER bypasses the 16-gate evaluator,
      // kill switch, bridge heartbeat, broker-execution master switch,
      // or the manual confirmation step.
      sixteenGateStillEnforced: true,
      killSwitchStillEnforced: true,
      manualConfirmationStillRequired: true,
      auditLoggingStillRecorded: true,
    },
  });
});

export default router;
