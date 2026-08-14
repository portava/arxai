// Phase 28-MT5-DEMO-ARMING (May 2026, sub-phase 1) — arm/disarm endpoints.
//
// All endpoints require an authenticated user. The arm endpoint refuses
// unless `runDemoVerificationGate()` returns VERIFIED_DEMO. The disarm
// endpoint is always allowed (kill-switch contract). The status endpoint
// returns current mode + last arm/disarm timestamps + the live readiness
// gate result.
//
// NO endpoint here sends anything to the EA. NO endpoint here returns
// tokens, hashes, or secrets.

import { Router, type Request } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  armDemoExecution,
  disarmDemoExecution,
  getCurrentArmState,
} from "../lib/mt5/demoArmingService.js";
import { runDemoVerificationGate } from "../lib/mt5/demoVerificationGate.js";
import { evaluatePerUserDispatchGate } from "../lib/mt5/demoDispatchGate.js";
import { getDuplicateEaProbe } from "./mt5.js";

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

router.get("/me/demo-execution/status", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const [state, readiness, dispatchEval] = await Promise.all([
    getCurrentArmState(userId),
    (async () => {
      const probe = getDuplicateEaProbe();
      return runDemoVerificationGate({
        userId,
        duplicateEaProbe: { suspected: probe.suspected, reason: probe.reason ?? null },
      });
    })(),
    // Per-user dispatch posture — computed dynamically from live inputs, not
    // hardcoded. `userConfirmed:false` because no specific command is in
    // hand at status time; this still exercises every other gate.
    evaluatePerUserDispatchGate({
      userId,
      userConfirmed: false,
      duplicateClear: !getDuplicateEaProbe().suspected,
    }),
  ]);
  const canDispatch = dispatchEval.eligibility.eligible;
  res.json({
    mode: state.mode,
    armed: state.mode === "MT5_DEMO_EXECUTION",
    armedAt: state.armedAt,
    disarmedAt: state.disarmedAt,
    disarmedReason: state.disarmedReason,
    readiness,
    canDispatchToMt5: canDispatch,
    canDispatchToMt5Reason: canDispatch
      ? "PER_USER_DEMO_DISPATCH_ALLOWED"
      : `PER_USER_DEMO_DISPATCH_REFUSED: ${dispatchEval.eligibility.blockers.join("; ")}`,
    dispatchEvidence: dispatchEval.evidence,
  });
});

router.post("/me/demo-execution/arm", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const result = await armDemoExecution({
    userId,
    actorIp: clientIp(req),
    actorUserAgent: req.header("user-agent") ?? null,
  });
  res.status(result.ok ? 200 : 409).json(result);
});

const disarmBodySchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

router.post("/me/demo-execution/disarm", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const parsed = disarmBodySchema.safeParse(req.body ?? {});
  const reason = parsed.success && parsed.data.reason ? parsed.data.reason : "user_disarm";
  const result = await disarmDemoExecution({
    userId,
    reason,
    actorIp: clientIp(req),
    actorUserAgent: req.header("user-agent") ?? null,
  });
  res.json(result);
});

export default router;
