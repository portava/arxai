// Phase 22V — Admin per-user risk-profile assignment.
//
//   POST /api/admin/users/:id/risk-profile
//     Body: { profile: "APPROVED_SHARED_BRIDGE_DEFAULT"
//                    | "FIRST_LIVE_TEST_MODE"
//                    | "OWNER_UNRESTRICTED_LIVE",
//             confirm: true }
//     - ADMIN or OWNER session required.
//     - "OWNER_UNRESTRICTED_LIVE" can only be assigned to a user whose
//       role is OWNER (or the bootstrap user_id=4). Plain users and
//       plain ADMINs are rejected with 403/OWNER_PROFILE_REQUIRES_OWNER.
//     - On apply: updates user_master_live_access.assigned_risk_template_id
//       AND mirrors the profile's per-user caps into arx_live_user_settings
//       so the 16-gate evaluator reads consistent values. NEVER places
//       a trade. Writes admin_action_audit_log row.
//
//   GET /api/admin/users/:id/risk-profile
//     Returns the user's currently-assigned profile.

import express, { type IRouter, Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  userMasterLiveAccessTable,
  arxLiveUserSettingsTable,
  adminActionAuditLogTable,
  riskTemplatesTable,
} from "@workspace/db";
import { getOrCreateUserSettings } from "../lib/live/liveCommandPipeline.js";
import { RISK_PROFILE_NAMES, isOwnerRole, getUserRiskProfile } from "../lib/live/userRiskProfile.js";

const router: IRouter = Router();
router.use(express.json());

const PROFILE_KEY = {
  APPROVED_SHARED_BRIDGE_DEFAULT: RISK_PROFILE_NAMES.APPROVED_SHARED_BRIDGE_DEFAULT,
  FIRST_LIVE_TEST_MODE: RISK_PROFILE_NAMES.FIRST_LIVE_TEST_MODE,
  OWNER_UNRESTRICTED_LIVE: RISK_PROFILE_NAMES.OWNER_UNRESTRICTED_LIVE,
} as const;

type ProfileKey = keyof typeof PROFILE_KEY;

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role: role as "ADMIN" | "OWNER" };
}

// Per-profile per-user caps that get mirrored into BOTH
// user_master_live_access and arx_live_user_settings on apply.
function capsForProfile(profile: ProfileKey): {
  uMaxLot: number | null; uAllowedSymbols: string[]; uRequireStopLoss: boolean;
  uRequireTakeProfit: boolean; uMaxOpenPositions: number | null;
  uMaxExposurePerSymbolLots: number | null; uDailyLossLimitUsd: number;
  uScannerLiveEnabled: boolean;
  sAllowedSymbols: string[]; sMaxLotPerMarket: Record<string, number>;
  sRequireStopLoss: boolean; sAdminAllowNoStopLoss: boolean;
  sDailyLossLimitUsd: number;
} {
  switch (profile) {
    case "FIRST_LIVE_TEST_MODE":
      return {
        uMaxLot: 0.01, uAllowedSymbols: ["EURUSD"], uRequireStopLoss: true,
        uRequireTakeProfit: true, uMaxOpenPositions: 1,
        uMaxExposurePerSymbolLots: 0.01, uDailyLossLimitUsd: 10,
        uScannerLiveEnabled: false,
        sAllowedSymbols: ["EURUSD"], sMaxLotPerMarket: { EURUSD: 0.01 },
        sRequireStopLoss: true, sAdminAllowNoStopLoss: false,
        sDailyLossLimitUsd: 10,
      };
    case "OWNER_UNRESTRICTED_LIVE":
      // No app-level caps. The 16-gate evaluator, kill switch, bridge
      // heartbeat, broker-execution master switch, manual confirmation,
      // and audit log all still apply.
      return {
        uMaxLot: null, uAllowedSymbols: [], uRequireStopLoss: false,
        uRequireTakeProfit: false, uMaxOpenPositions: null,
        uMaxExposurePerSymbolLots: null, uDailyLossLimitUsd: 0,
        uScannerLiveEnabled: true,
        sAllowedSymbols: [], sMaxLotPerMarket: {},
        sRequireStopLoss: false, sAdminAllowNoStopLoss: true,
        sDailyLossLimitUsd: 0,
      };
    case "APPROVED_SHARED_BRIDGE_DEFAULT":
    default:
      return {
        uMaxLot: 0.5, uAllowedSymbols: ["EURUSD","GBPUSD","USDJPY","XAUUSD"],
        uRequireStopLoss: true, uRequireTakeProfit: true,
        uMaxOpenPositions: 3, uMaxExposurePerSymbolLots: 0.5,
        uDailyLossLimitUsd: 100, uScannerLiveEnabled: true,
        sAllowedSymbols: ["EURUSD","GBPUSD","USDJPY","XAUUSD"],
        sMaxLotPerMarket: { EURUSD: 0.5, GBPUSD: 0.5, USDJPY: 0.5, XAUUSD: 0.2 },
        sRequireStopLoss: true, sAdminAllowNoStopLoss: false,
        sDailyLossLimitUsd: 100,
      };
  }
}

router.post("/admin/users/:id/risk-profile", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = Number(req.params.id);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.confirm !== true) {
    res.status(400).json({ ok: false, error: "CONFIRMATION_REQUIRED",
      detail: "Send { confirm: true } from the switch-based UI." }); return;
  }
  const profileKey = String(body.profile ?? "") as ProfileKey;
  if (!(profileKey in PROFILE_KEY)) {
    res.status(400).json({ ok: false, error: "UNKNOWN_PROFILE",
      detail: `Allowed: ${Object.keys(PROFILE_KEY).join(", ")}` }); return;
  }

  // Security: unrestricted profile can only be assigned to OWNER role.
  if (profileKey === "OWNER_UNRESTRICTED_LIVE") {
    const ok = await isOwnerRole(targetUserId);
    if (!ok) {
      res.status(403).json({
        ok: false,
        error: "OWNER_PROFILE_REQUIRES_OWNER",
        detail: "Owner Unrestricted Live can only be assigned to a user whose role is OWNER.",
      }); return;
    }
  }

  const tplName = PROFILE_KEY[profileKey];
  const tplRows = await db.select({ id: riskTemplatesTable.id })
    .from(riskTemplatesTable).where(eq(riskTemplatesTable.name, tplName)).limit(1);
  const tplId = tplRows[0]?.id ?? null;
  if (tplId == null) {
    res.status(409).json({ ok: false, error: "RISK_TEMPLATE_MISSING",
      detail: `Seed the "${tplName}" row in risk_templates first.` }); return;
  }

  // Ensure both tables have a row for this user.
  let access = (await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, targetUserId)).limit(1))[0] ?? null;
  if (!access) {
    await db.insert(userMasterLiveAccessTable).values({ userId: targetUserId });
    access = (await db.select().from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, targetUserId)).limit(1))[0] ?? null;
  }
  await getOrCreateUserSettings(targetUserId);

  const before = {
    assignedRiskTemplateId: access?.assignedRiskTemplateId ?? null,
    maxLot: access?.maxLot ?? null,
    allowedSymbols: access?.allowedSymbols ?? null,
    requireStopLoss: access?.requireStopLoss ?? null,
    requireTakeProfit: access?.requireTakeProfit ?? null,
    maxOpenPositions: access?.maxOpenPositions ?? null,
    maxExposurePerSymbolLots: access?.maxExposurePerSymbolLots ?? null,
    dailyLossLimitUsd: access?.dailyLossLimitUsd ?? null,
    scannerLiveEnabled: access?.scannerLiveEnabled ?? null,
  };
  const caps = capsForProfile(profileKey);

  await db.transaction(async (tx) => {
    await tx.update(userMasterLiveAccessTable).set({
      assignedRiskTemplateId: tplId,
      maxLot: caps.uMaxLot as unknown as number,
      allowedSymbols: caps.uAllowedSymbols,
      requireStopLoss: caps.uRequireStopLoss,
      requireTakeProfit: caps.uRequireTakeProfit,
      maxOpenPositions: caps.uMaxOpenPositions,
      maxExposurePerSymbolLots: caps.uMaxExposurePerSymbolLots as unknown as number,
      dailyLossLimitUsd: caps.uDailyLossLimitUsd as unknown as number,
      scannerLiveEnabled: caps.uScannerLiveEnabled,
      updatedAt: new Date(),
    }).where(eq(userMasterLiveAccessTable.userId, targetUserId));

    await tx.update(arxLiveUserSettingsTable).set({
      allowedSymbols: caps.sAllowedSymbols,
      maxLotPerMarket: caps.sMaxLotPerMarket as unknown as Record<string, number>,
      requireStopLoss: caps.sRequireStopLoss,
      adminAllowNoStopLoss: caps.sAdminAllowNoStopLoss,
      dailyLossLimitUsd: String(caps.sDailyLossLimitUsd) as unknown as number,
      updatedAt: new Date(),
    }).where(eq(arxLiveUserSettingsTable.userId, targetUserId));

    await tx.insert(adminActionAuditLogTable).values({
      adminId: admin.id, adminRole: admin.role,
      action: "ADMIN_ASSIGNED_RISK_PROFILE",
      beforeState: { targetUserId, ...before },
      afterState: {
        targetUserId, profile: profileKey, templateName: tplName, templateId: tplId,
        appliedAccess: {
          maxLot: caps.uMaxLot, allowedSymbols: caps.uAllowedSymbols,
          requireStopLoss: caps.uRequireStopLoss, requireTakeProfit: caps.uRequireTakeProfit,
          maxOpenPositions: caps.uMaxOpenPositions,
          maxExposurePerSymbolLots: caps.uMaxExposurePerSymbolLots,
          dailyLossLimitUsd: caps.uDailyLossLimitUsd,
          scannerLiveEnabled: caps.uScannerLiveEnabled,
        },
        appliedSettings: {
          allowedSymbols: caps.sAllowedSymbols, maxLotPerMarket: caps.sMaxLotPerMarket,
          requireStopLoss: caps.sRequireStopLoss,
          adminAllowNoStopLoss: caps.sAdminAllowNoStopLoss,
          dailyLossLimitUsd: caps.sDailyLossLimitUsd,
        },
        didPlaceTrade: false,
      },
    });
  });

  res.json({
    ok: true, targetUserId, profile: profileKey, templateName: tplName, templateId: tplId,
    safety: {
      didPlaceTrade: false,
      sixteenGateStillEnforced: true,
      killSwitchStillEnforced: true,
      manualConfirmationStillRequired: true,
    },
  });
});

router.get("/admin/users/:id/risk-profile", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = Number(req.params.id);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return;
  }
  const profile = await getUserRiskProfile(targetUserId);
  // Wrap the profile under `current` so the admin UI can read a stable
  // shape (`data.current.isOwnerUnrestricted` etc.). Top-level fields
  // are kept for backward-compatibility with any other consumer.
  res.json({
    ok: true,
    targetUserId,
    current: profile,
    ...profile,
  });
});

export default router;
