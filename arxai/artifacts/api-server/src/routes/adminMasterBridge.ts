// Admin — Master Bridge LIVE — Current Connected Bridge endpoints
//
// GET  /api/admin/master-bridge/current   — detector output (masked)
// POST /api/admin/master-bridge/snapshot  — persists detected bridgeId as
//                                            global_trading_settings.platform_master_bridge_connection_id
// GET  /api/admin/master-bridge/gate      — evaluator verdict (no dispatch)
//
// SECURITY:
//   - Every handler is ADMIN/OWNER-gated via requireAdmin.
//   - The detector evidence is rendered via `maskBridgeEvidenceForUser`
//     so account number is masked. Raw broker server is NOT exposed.
//   - NONE of these routes can place a trade, modify a bridge token,
//     or mutate any user's connection. The only mutation is updating
//     `global_trading_settings.platform_master_bridge_connection_id`.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { db, globalTradingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  detectCurrentConnectedBridge,
  maskBridgeEvidenceForUser,
} from "../lib/mt5/currentConnectedBridgeDetector.js";
import { loadAndEvaluateMasterLiveBridgeGate } from "../lib/mt5/masterLiveBridgeGate.js";
import { isLiveBrokerExecutionEnabledEnv } from "@workspace/domain/safety-contracts/isLiveBrokerExecutionEnabled";

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  const role = sess?.role ?? null;
  if (!sess) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return role;
}

// Server-side master switch surfaced read-only to admin operators so the
// bridge panel can show whether the runtime gate is in the "may PASS" state.
// We never read or echo the env value anywhere else; UI gets a boolean only.
function liveBrokerExecutionEnabled(): boolean {
  return isLiveBrokerExecutionEnabledEnv();
}

router.get("/admin/master-bridge/current", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const liveEnabled = liveBrokerExecutionEnabled();
  const det = await detectCurrentConnectedBridge();
  if (!det.ok) {
    return res.json({
      ok: true,
      detected: false,
      primaryReason: det.primaryReason,
      latestHint: det.latestHint ? maskBridgeEvidenceForUser(det.latestHint) : null,
      liveBrokerExecutionEnabled: liveEnabled,
    });
  }
  return res.json({
    ok: true,
    detected: true,
    bridge: maskBridgeEvidenceForUser(det.bridge),
    liveBrokerExecutionEnabled: liveEnabled,
  });
});

router.get("/admin/master-bridge/gate", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const verdict = await loadAndEvaluateMasterLiveBridgeGate();
  return res.json({ ok: true, verdict });
});

// Persist the currently-detected bridge id as platform_master_bridge_connection_id.
// Operator-only mutation. Refuses if detector is currently BLOCKED (cannot
// snapshot a stale/MOCK/non-real bridge).
router.post("/admin/master-bridge/snapshot", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const det = await detectCurrentConnectedBridge();
  if (!det.ok) {
    return res.status(409).json({
      ok: false,
      error: "DETECTOR_BLOCKED",
      primaryReason: det.primaryReason,
    });
  }
  const rows = await db.select().from(globalTradingSettingsTable).limit(1);
  const s = rows[0];
  if (!s) {
    return res.status(500).json({ ok: false, error: "SETTINGS_ROW_MISSING" });
  }
  await db.update(globalTradingSettingsTable)
    .set({
      platformMasterBridgeConnectionId: det.bridge.bridgeId,
      updatedAt: new Date(),
    })
    .where(eq(globalTradingSettingsTable.id, s.id));
  return res.json({
    ok: true,
    snapshotted: true,
    platformMasterBridgeConnectionId: det.bridge.bridgeId,
    bridge: maskBridgeEvidenceForUser(det.bridge),
  });
});

export default router;
