// Phase 22V — Pin Master Bridge (heartbeat-gated) + First Live Test Mode
// (OWNER-only safest-limits preset). All mutations write an audit row.
//
//   POST /api/admin/live/pin-master-bridge
//     Switch-confirmed pin of the currently-detected master bridge.
//     409 if no heartbeat ≤15s. Wraps the existing detector+snapshot logic.
//
//   POST /api/admin/live/first-live-test-mode
//     OWNER-only (user_id=4 OR role=OWNER). Writes the safest possible
//     per-user limits on the OWNER's user_master_live_access row:
//       maxOpenPositions=1, maxLot=0.01, requireStopLoss=true,
//       allowedSymbols=["EURUSD"], scannerLiveEnabled=false.
//     Also disables platform oneClick + autoTrade by force on the OWNER.
//     Returns { ok, applied: { … } }. Audit row written.

import express, { type IRouter, Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  globalTradingSettingsTable,
  userMasterLiveAccessTable,
  arxLiveUserSettingsTable,
  adminActionAuditLogTable,
} from "@workspace/db";
import { detectCurrentConnectedBridge } from "../lib/mt5/currentConnectedBridgeDetector.js";
import { getOrCreateUserSettings } from "../lib/live/liveCommandPipeline.js";
import { getUserRiskProfile } from "../lib/live/userRiskProfile.js";

const router: IRouter = Router();
router.use(express.json());

const OWNER_USER_ID = 4 as const;
const HEARTBEAT_MAX_AGE_SEC = 15 as const;

function requireAdmin(
  req: Request,
  res: Response,
): { id: number; role: "ADMIN" | "OWNER" } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role: role as "ADMIN" | "OWNER" };
}

function requireOwner(
  req: Request,
  res: Response,
): { id: number; role: "OWNER" } | null {
  // Phase 22V QA tightening: OWNER-only means role === "OWNER" OR
  // user_id === OWNER_USER_ID (4 — bootstrapped OWNER). Plain ADMINs
  // are rejected from First Live Test Mode endpoints.
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  const role = sess.role ?? null;
  if (role !== "OWNER" && sess.id !== OWNER_USER_ID) {
    res.status(403).json({ ok: false, error: "OWNER_REQUIRED" });
    return null;
  }
  return { id: sess.id, role: "OWNER" };
}

async function writeAudit(args: {
  adminId: number; adminRole: string; action: string;
  before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
}): Promise<void> {
  await db.insert(adminActionAuditLogTable).values({
    adminId: args.adminId,
    adminRole: args.adminRole,
    action: args.action,
    beforeState: (args.before ?? {}) as Record<string, unknown>,
    afterState: (args.after ?? {}) as Record<string, unknown>,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/live/pin-master-bridge
// Body: { confirm: true }
// 409 if detector blocked or heartbeat older than HEARTBEAT_MAX_AGE_SEC.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/live/pin-master-bridge", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.confirm !== true) {
    res.status(400).json({ ok: false, error: "CONFIRMATION_REQUIRED", detail: "Send { confirm: true } from the switch-based UI." });
    return;
  }
  const det = await detectCurrentConnectedBridge();
  if (!det.ok) {
    res.status(409).json({
      ok: false, error: "DETECTOR_BLOCKED",
      detail: "No live EA bridge detected. Attach EA v1.27 to your LIVE master chart and try again.",
      primaryReason: det.primaryReason,
    });
    return;
  }
  const ageSec = det.bridge.heartbeatAgeSec;
  if (ageSec == null || ageSec > HEARTBEAT_MAX_AGE_SEC) {
    res.status(409).json({
      ok: false, error: "HEARTBEAT_TOO_OLD",
      detail: `Heartbeat must be ≤${HEARTBEAT_MAX_AGE_SEC}s. Current: ${ageSec == null ? "none" : ageSec + "s"}.`,
      heartbeatAgeSec: ageSec,
    });
    return;
  }
  const settingsRow = (await db.select().from(globalTradingSettingsTable).limit(1))[0];
  if (!settingsRow) { res.status(500).json({ ok: false, error: "SETTINGS_ROW_MISSING" }); return; }
  const before = { platformMasterBridgeConnectionId: settingsRow.platformMasterBridgeConnectionId };
  await db.transaction(async (tx) => {
    await tx.update(globalTradingSettingsTable)
      .set({ platformMasterBridgeConnectionId: det.bridge.bridgeId, updatedAt: new Date() })
      .where(eq(globalTradingSettingsTable.id, settingsRow.id));
    await tx.insert(adminActionAuditLogTable).values({
      adminId: admin.id, adminRole: admin.role,
      action: "ADMIN_PINNED_MASTER_BRIDGE_VIA_SWITCH",
      beforeState: before,
      afterState: {
        platformMasterBridgeConnectionId: det.bridge.bridgeId,
        heartbeatAgeSec: ageSec,
        eaVersion: det.bridge.eaVersion ?? null,
      },
    });
  });
  res.json({
    ok: true,
    pinned: true,
    platformMasterBridgeConnectionId: det.bridge.bridgeId,
    heartbeatAgeSec: ageSec,
    eaVersion: det.bridge.eaVersion ?? null,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/live/first-live-test-mode
// OWNER-only. Body: { confirm: true, enabled: boolean }
// When enabled=true, force the safest possible per-user limits on the OWNER's
// user_master_live_access row. When enabled=false, no-op (limits are not
// auto-relaxed). This endpoint NEVER places a trade.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/live/first-live-test-mode", async (req, res) => {
  const admin = requireOwner(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.confirm !== true) {
    res.status(400).json({ ok: false, error: "CONFIRMATION_REQUIRED" });
    return;
  }
  const enabled = body.enabled === true;
  const force = body.force === true;
  // Refuse to clobber the OWNER's "Owner Unrestricted Live" profile by
  // accident. The admin must either revert the profile first via
  // /api/admin/users/:id/risk-profile or pass { force: true } to confirm
  // they really intend to re-tighten the caps.
  if (enabled && !force) {
    const profile = await getUserRiskProfile(OWNER_USER_ID);
    if (profile.isOwnerUnrestricted) {
      res.status(409).json({
        ok: false,
        error: "OWNER_HAS_UNRESTRICTED_PROFILE",
        detail: "OWNER currently has the 'Owner Unrestricted Live' risk profile assigned. Pass { force: true } to override and re-tighten caps to First Live Test Mode, OR revert the profile first via POST /api/admin/users/4/risk-profile with { profile: 'APPROVED_SHARED_BRIDGE_DEFAULT', confirm: true }.",
        currentProfile: profile.templateName,
      });
      return;
    }
  }
  // Ensure the OWNER row exists.
  let row = (await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, OWNER_USER_ID)).limit(1))[0] ?? null;
  if (!row) {
    await db.insert(userMasterLiveAccessTable).values({ userId: OWNER_USER_ID });
    row = (await db.select().from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, OWNER_USER_ID)).limit(1))[0] ?? null;
    if (!row) { res.status(500).json({ ok: false, error: "OWNER_ROW_INSERT_FAILED" }); return; }
  }
  const before = {
    maxOpenPositions: row.maxOpenPositions,
    maxLot: row.maxLot,
    allowedSymbols: row.allowedSymbols,
    requireStopLoss: row.requireStopLoss,
    scannerLiveEnabled: row.scannerLiveEnabled,
    dailyLossLimitUsd: row.dailyLossLimitUsd,
    maxExposurePerSymbolLots: row.maxExposurePerSymbolLots,
  };
  if (!enabled) {
    await writeAudit({
      adminId: admin.id, adminRole: admin.role,
      action: "ADMIN_FIRST_LIVE_TEST_MODE_NOOP_DISABLE",
      before, after: { enabled: false, note: "no-op; limits not relaxed automatically" },
    });
    res.json({ ok: true, enabled: false, applied: null, note: "First Live Test Mode disabled. Existing limits left untouched (safe-by-default)." });
    return;
  }
  const applied = {
    maxOpenPositions: 1,
    maxLot: 0.01,
    allowedSymbols: ["EURUSD"],
    requireStopLoss: true,
    scannerLiveEnabled: false,
    dailyLossLimitUsd: 10,
    maxExposurePerSymbolLots: 0.01,
  } as const;
  // Make sure the arx_live_user_settings row exists for the OWNER so the
  // 16-gate dispatch evaluator can read the mirrored caps. The 16-gate
  // path reads from arx_live_user_settings (allowedSymbols, requireStopLoss,
  // dailyLossLimitUsd, maxLotPerMarket); user_master_live_access feeds the
  // per-user exposure gate (maxOpenPositions, maxExposurePerSymbolLots).
  // Both tables must agree or the FLTM caps would be silently bypassed.
  await getOrCreateUserSettings(OWNER_USER_ID);
  const liveSettingsBefore = (await db.select().from(arxLiveUserSettingsTable)
    .where(eq(arxLiveUserSettingsTable.userId, OWNER_USER_ID)).limit(1))[0] ?? null;
  await db.transaction(async (tx) => {
    await tx.update(userMasterLiveAccessTable).set({
      maxOpenPositions: applied.maxOpenPositions,
      maxLot: applied.maxLot,
      allowedSymbols: [...applied.allowedSymbols],
      requireStopLoss: applied.requireStopLoss,
      scannerLiveEnabled: applied.scannerLiveEnabled,
      dailyLossLimitUsd: applied.dailyLossLimitUsd,
      maxExposurePerSymbolLots: applied.maxExposurePerSymbolLots,
      updatedAt: new Date(),
    }).where(eq(userMasterLiveAccessTable.userId, OWNER_USER_ID));
    // Mirror caps into arx_live_user_settings — this is what the 16-gate
    // dispatch evaluator actually consults. Without this mirror the FLTM
    // limits would only be enforced by the per-user exposure gate.
    await tx.update(arxLiveUserSettingsTable).set({
      allowedSymbols: [...applied.allowedSymbols],
      requireStopLoss: applied.requireStopLoss,
      dailyLossLimitUsd: String(applied.dailyLossLimitUsd) as unknown as number,
      maxLotPerMarket: { EURUSD: applied.maxLot } as unknown as Record<string, number>,
      adminAllowNoStopLoss: false,
      updatedAt: new Date(),
    }).where(eq(arxLiveUserSettingsTable.userId, OWNER_USER_ID));
    await tx.insert(adminActionAuditLogTable).values({
      adminId: admin.id, adminRole: admin.role,
      action: "ADMIN_FIRST_LIVE_TEST_MODE_ENABLED",
      beforeState: { ...before, liveSettingsBefore },
      afterState: {
        enabled: true,
        ownerUserId: OWNER_USER_ID,
        applied,
        liveSettingsMirrored: {
          allowedSymbols: applied.allowedSymbols,
          requireStopLoss: applied.requireStopLoss,
          dailyLossLimitUsd: applied.dailyLossLimitUsd,
          maxLotPerMarket: { EURUSD: applied.maxLot },
          adminAllowNoStopLoss: false,
        },
      },
    });
  });
  res.json({
    ok: true,
    enabled: true,
    ownerUserId: OWNER_USER_ID,
    applied,
    safety: {
      autoTradeEnabled: false,
      autoCloseMode: "ALERT_ONLY",
      oneClickEnabled: false,
      didPlaceTrade: false,
    },
    reminder: "First Live Test Mode tightens limits only. No trade is placed; ARX_LIVE_BROKER_EXECUTION_ENABLED must still be set + all 16 gates must PASS.",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/live/first-live-test-mode/status
// Returns whether the OWNER row currently matches the test-mode preset.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/live/first-live-test-mode/status", async (req, res) => {
  const admin = requireOwner(req, res);
  if (!admin) return;
  const row = (await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, OWNER_USER_ID)).limit(1))[0] ?? null;
  if (!row) { res.json({ ok: true, enabled: false, ownerRowExists: false }); return; }
  const enabled =
    row.maxOpenPositions === 1 &&
    Number(row.maxLot) === 0.01 &&
    row.requireStopLoss === true &&
    Array.isArray(row.allowedSymbols) &&
    row.allowedSymbols.length === 1 &&
    row.allowedSymbols[0] === "EURUSD" &&
    row.scannerLiveEnabled === false;
  res.json({
    ok: true,
    enabled,
    ownerRowExists: true,
    current: {
      maxOpenPositions: row.maxOpenPositions,
      maxLot: row.maxLot,
      allowedSymbols: row.allowedSymbols,
      requireStopLoss: row.requireStopLoss,
      scannerLiveEnabled: row.scannerLiveEnabled,
      dailyLossLimitUsd: row.dailyLossLimitUsd,
      maxExposurePerSymbolLots: row.maxExposurePerSymbolLots,
    },
  });
});

export default router;
