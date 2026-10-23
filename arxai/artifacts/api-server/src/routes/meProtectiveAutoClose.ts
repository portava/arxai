// Phase 13 — Protective Auto-Close: user-scoped settings + journal + heartbeat.
//
// SAFETY:
//   * Every endpoint requires `requireUser`. All reads filter by userId.
//   * Enabling protective auto-close requires explicit `enabled:true` PLUS
//     `acknowledgedRiskOfAutoClose:true` in the body. A missing
//     acknowledgement is a 400 even if the user previously opted in.
//   * The kill-switch is a single POST that atomically disables and
//     latches `killSwitchEngaged:true` — cannot be cleared except by
//     POST /clear-kill-switch.
//   * NO endpoint executes a trade. The engine — and only the engine —
//     ever invokes confirmAction, and only on AUTO_CLOSE_ELIGIBLE.

import { Router, type IRouter, type Request } from "express";
import { z } from "zod/v4";
import {
  getEffectiveSettings, upsertSettings, engageKillSwitch, clearKillSwitch,
  type SettingsPatch,
} from "../lib/protectiveClose/settings.js";
import { listRecentDecisions } from "../lib/protectiveClose/journal.js";
import { bumpActivity, getActivityStatus, type PingKind } from "../lib/protectiveClose/inactivity.js";

const router: IRouter = Router();
const uid = (req: Request) => (req as Request & { authUser?: { id?: number } }).authUser?.id ?? 0;

const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

// ── Activity ping ───────────────────────────────────────────────────────────
const pingSchema = z.object({
  kinds: z.array(z.enum(["app", "trade", "ai"])).min(1).default(["app"]),
});
router.post("/me/activity-ping", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const parsed = pingSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_body", details: parsed.error.issues, safety: SAFETY_ENVELOPE });
  await bumpActivity(userId, parsed.data.kinds as PingKind[]);
  return res.json({ ok: true, safety: SAFETY_ENVELOPE });
});

// ── Settings ────────────────────────────────────────────────────────────────
router.get("/me/protective-auto-close/settings", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const settings = await getEffectiveSettings(userId);
  const activity = await getActivityStatus(userId, settings.inactivityThresholdMin);
  return res.json({ ok: true, settings, activity, safety: SAFETY_ENVELOPE });
});

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  inactivityThresholdMin: z.number().int().min(1).max(360).optional(),
  mode: z.enum(["ALERT_ONLY", "CONFIRM_IF_ACTIVE", "AUTO_IF_INACTIVE"]).optional(),
  closeType: z.enum(["FULL", "PARTIAL", "TIGHTEN"]).optional(),
  partialClosePercent: z.number().int().min(1).max(100).optional(),
  maxAutoClosesPerTrade: z.number().int().min(1).max(10).optional(),
  cooldownMin: z.number().int().min(1).max(1440).optional(),
  minConfidence: z.enum(["HIGH", "MEDIUM"]).optional(),
  requireMultiSignal: z.boolean().optional(),
  protectProfitEnabled: z.boolean().optional(),
  protectProfitGivebackPct: z.number().int().min(1).max(100).optional(),
  maxLossProtectionEnabled: z.boolean().optional(),
  maxLossProtectionPct: z.number().int().min(1).max(100).optional(),
  acknowledgedRiskOfAutoClose: z.boolean().optional(),
});

router.put("/me/protective-auto-close/settings", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const parsed = settingsPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_body", details: parsed.error.issues, safety: SAFETY_ENVELOPE });
  // Enabling requires acknowledgement.
  if (parsed.data.enabled === true && parsed.data.acknowledgedRiskOfAutoClose !== true) {
    return res.status(400).json({ ok: false, error: "acknowledgement_required",
      message: "Enabling Protective Auto-Close requires acknowledgedRiskOfAutoClose:true in the body. The AI may close or partially close your trades under your pre-authorized policy when you are inactive.",
      safety: SAFETY_ENVELOPE });
  }
  const patch: SettingsPatch = { ...parsed.data };
  delete (patch as Record<string, unknown>)["acknowledgedRiskOfAutoClose"];
  const settings = await upsertSettings(userId, patch);
  return res.json({ ok: true, settings, safety: SAFETY_ENVELOPE });
});

// ── Kill switch ─────────────────────────────────────────────────────────────
router.post("/me/protective-auto-close/kill-switch", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const settings = await engageKillSwitch(userId);
  return res.json({ ok: true, settings, safety: SAFETY_ENVELOPE });
});

router.post("/me/protective-auto-close/clear-kill-switch", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const settings = await clearKillSwitch(userId);
  return res.json({ ok: true, settings, safety: SAFETY_ENVELOPE });
});

// ── Decisions journal (read-only) ───────────────────────────────────────────
router.get("/me/protective-auto-close/decisions", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const limit = Math.min(Number(req.query["limit"] ?? 50) || 50, 200);
  const decisions = await listRecentDecisions(userId, limit);
  return res.json({ ok: true, decisions, count: decisions.length, safety: SAFETY_ENVELOPE });
});

export default router;
