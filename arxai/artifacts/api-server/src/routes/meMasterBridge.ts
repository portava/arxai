// User-facing Master Bridge LIVE status — read-only, masked.
//
// GET /api/me/master-bridge/status
//
// Returns whether master live is currently "ready" to dispatch for this
// authenticated user, plus a masked snapshot of the current connected
// bridge so the Live Trading page can show
//   "Master Live Bridge: Current Connected Bridge"
//
// SECURITY:
//   - Requires an authenticated session (requireUser).
//   - Returns ONLY masked operator fields — never broker server, raw
//     account number, apiKeyHash, tokenLast4, or any other secret.
//   - Returns the gate verdict reasons so the UI can render "what's
//     blocking master live" honestly. The block-reason strings match
//     the spec list exactly.
import express, { type IRouter, Router } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import {
  detectCurrentConnectedBridge,
  maskBridgeEvidenceForUser,
} from "../lib/mt5/currentConnectedBridgeDetector.js";
import { loadAndEvaluateMasterLiveBridgeGate } from "../lib/mt5/masterLiveBridgeGate.js";

const router: IRouter = Router();
router.use(express.json());

router.get("/me/master-bridge/status", requireUser, async (_req, res) => {
  const det = await detectCurrentConnectedBridge();
  const gate = await loadAndEvaluateMasterLiveBridgeGate();
  return res.json({
    ok: true,
    safetyMode: "paper_only",
    liveLocked: true,
    allowOrderExecution: false,
    // The label the UI renders verbatim:
    //   "Master Live Bridge: Current Connected Bridge."
    label: "Master Live Bridge: Current Connected Bridge",
    bridge: det.ok ? maskBridgeEvidenceForUser(det.bridge) : null,
    detected: det.ok,
    blocked: gate.decision === "BLOCKED",
    primaryReason: gate.decision === "BLOCKED" ? gate.primaryReason : null,
    blockReasons: gate.decision === "BLOCKED" ? gate.blockReasons : [],
  });
});

export default router;
