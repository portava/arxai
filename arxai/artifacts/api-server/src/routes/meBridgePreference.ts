// User-facing bridge preference (Personal vs Shared).
//
// SAFETY (inviolable):
//  - Persists only the user's *preference* into
//    `user_trading_permissions.account_routing_override`.
//  - Does NOT grant approval. Switching to SHARED_MASTER_MT5 is rejected
//    unless `user_advanced_permissions.shared_bridge_approved = true`.
//  - Does NOT change the `sharedMt5RoutingBlocked` invariant. Live
//    dispatch via the shared bridge is still platform-blocked at the
//    chokepoint regardless of this preference.
//  - Per-user isolation: only the calling user's own row is read/updated.
//  - Never returns secrets, tokens, master credentials, or other users'
//    state.
import express, { Router, type IRouter, type Request } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  userTradingPermissionsTable,
  userAdvancedPermissionsTable,
} from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";

const router: IRouter = Router();
router.use(express.json());

type BridgeMode = "USER_OWNED_MT5" | "SHARED_MASTER_MT5";

const PutBody = z.object({
  mode: z.enum(["USER_OWNED_MT5", "SHARED_MASTER_MT5"]),
});

function getUserId(req: Request): number | null {
  const u = (req as Request & { authUser?: { id?: number } }).authUser;
  return u?.id ?? null;
}

async function loadState(userId: number) {
  const [perm] = await db
    .select({
      override: userTradingPermissionsTable.accountRoutingOverride,
      tradingMode: userTradingPermissionsTable.tradingMode,
      suspended: userTradingPermissionsTable.suspended,
    })
    .from(userTradingPermissionsTable)
    .where(eq(userTradingPermissionsTable.userId, userId))
    .limit(1);
  const [adv] = await db
    .select({
      sharedBridgeApproved: userAdvancedPermissionsTable.sharedBridgeApproved,
      personalBridgeEnabled: userAdvancedPermissionsTable.personalBridgeEnabled,
    })
    .from(userAdvancedPermissionsTable)
    .where(eq(userAdvancedPermissionsTable.userId, userId))
    .limit(1);

  const rawOverride = String(perm?.override ?? "inherit").toLowerCase();
  const preferredBridge: BridgeMode =
    rawOverride === "shared_master_mt5" ? "SHARED_MASTER_MT5" : "USER_OWNED_MT5";

  return {
    preferredBridge,
    sharedBridgeApproved: Boolean(adv?.sharedBridgeApproved),
    personalBridgeEnabled: adv?.personalBridgeEnabled !== false,
    // Platform-wide hard guard: shared live dispatch remains blocked.
    sharedLiveDispatchAvailable: false,
    sharedLiveDispatchNote:
      "Live execution via the shared bridge is currently unavailable platform-wide. Switching to the shared bridge sets your preference and demo routing only.",
  };
}

router.get("/me/bridge-preference", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return;
  }
  try {
    const state = await loadState(userId);
    res.json({ ok: true, ...state });
  } catch (err) {
    req.log?.warn({ err }, "me_bridge_preference_get_failed");
    res.status(500).json({ ok: false, error: "BRIDGE_PREFERENCE_READ_FAILED" });
  }
});

router.put("/me/bridge-preference", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return;
  }
  const parsed = PutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY" });
    return;
  }
  const requested = parsed.data.mode;

  try {
    const state = await loadState(userId);

    // Guard: switching TO shared requires admin approval.
    if (requested === "SHARED_MASTER_MT5" && !state.sharedBridgeApproved) {
      res.status(403).json({
        ok: false,
        error: "SHARED_BRIDGE_NOT_APPROVED",
        message:
          "Shared bridge access requires admin approval. Your preference was not changed.",
      });
      return;
    }
    if (requested === "USER_OWNED_MT5" && !state.personalBridgeEnabled) {
      res.status(403).json({
        ok: false,
        error: "PERSONAL_BRIDGE_DISABLED",
        message: "Your personal bridge is disabled. Contact support.",
      });
      return;
    }

    // Upsert preference into user_trading_permissions.
    // Use lower-case to match resolveRouting()'s case-insensitive read.
    const overrideValue = requested === "SHARED_MASTER_MT5"
      ? "shared_master_mt5"
      : "user_owned_mt5";

    const [existing] = await db
      .select({ id: userTradingPermissionsTable.id })
      .from(userTradingPermissionsTable)
      .where(eq(userTradingPermissionsTable.userId, userId))
      .limit(1);

    if (existing) {
      await db
        .update(userTradingPermissionsTable)
        .set({
          accountRoutingOverride: overrideValue,
          updatedAt: new Date(),
        })
        .where(eq(userTradingPermissionsTable.userId, userId));
    } else {
      await db.insert(userTradingPermissionsTable).values({
        userId,
        tradingMode: "DISABLED",
        demoEnabled: false,
        liveApproved: false,
        liveEnabled: false,
        suspended: true,
        accountRoutingOverride: overrideValue,
      });
    }

    req.log?.info(
      { userId, requested },
      "me_bridge_preference_updated",
    );

    const next = await loadState(userId);
    res.json({ ok: true, ...next });
  } catch (err) {
    req.log?.warn({ err }, "me_bridge_preference_put_failed");
    res.status(500).json({ ok: false, error: "BRIDGE_PREFERENCE_WRITE_FAILED" });
  }
});

export default router;
