// Self-Trade AI — admin control surfaces (Task #211, Foundation).
//
// SAFETY / SCOPE:
//   - Every route requires an ADMIN/OWNER session. Admin-previewing-as-user is
//     downgraded by the upstream product-role gate and lands in the 403 branch.
//   - NO execution: nothing here places / modifies / closes a trade, inserts
//     into arx_live_commands, touches the 16-gate live pipeline, or the global
//     kill switch. It manages ONLY the Self-Trade fleet control state.
//   - Every mutation is fail-closed audited (the service wraps the change + a
//     self_trade_audit_log row in one transaction).

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  createAgentFromTemplate,
  configureAgent,
  setAutonomyLevel,
  setAgentStatus,
  toggleKillSwitch,
  type Actor,
  type ConfigurablePatch,
} from "../lib/selfTrade/service.js";
import { fundAgent, defundAgent } from "../lib/selfTrade/agentLedger.js";

const router = Router();

function err(res: Response, status: number, error: string, message: string) {
  res.status(status).json({ ok: false, error, message });
}

type AdminRole = "ADMIN" | "OWNER";

// Resolve a true ADMIN/OWNER session (admin-preview is already downgraded).
function requireAdmin(req: Request, res: Response): Actor | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  if (u?.id == null || (u.role !== "ADMIN" && u.role !== "OWNER")) {
    err(res, 403, "ADMIN_REQUIRED", "Admin or owner access required.");
    return null;
  }
  return { userId: u.id, role: u.role as AdminRole };
}

const idParam = z.object({ id: z.coerce.number().int().positive() });

const createInput = z.object({
  template: z.enum(["ALPHA", "BLAZE", "ATLAS", "NOVA", "TITAN"]),
  name: z.string().trim().min(2).max(80),
  reason: z.string().trim().min(3).max(400),
  description: z.string().trim().max(400).nullish(),
  ownerType: z.enum(["OPERATOR_FLEET", "USER"]).optional(),
  ownerId: z.number().int().positive().nullish(),
});

const fundInput = z.object({
  amount: z.number().positive(),
  reason: z.string().trim().min(3).max(400),
});

const configInput = z.object({
  reason: z.string().trim().min(3).max(400),
  riskPerTradePct: z.number().nonnegative().optional(),
  maxLotPerTrade: z.number().nonnegative().optional(),
  maxConcurrentPositions: z.number().int().nonnegative().optional(),
  maxDailyLossUsd: z.number().nonnegative().optional(),
  maxWeeklyLossUsd: z.number().nonnegative().optional(),
  dailyProfitGoalUsd: z.number().nonnegative().optional(),
  weeklyProfitGoalUsd: z.number().nonnegative().optional(),
  dailyMinTrades: z.number().int().nonnegative().optional(),
  baseMaxTrades: z.number().int().nonnegative().optional(),
  extensionEnabled: z.boolean().optional(),
  extensionMaxTrades: z.number().int().nonnegative().optional(),
  allowedSymbols: z.array(z.string().trim().min(1).max(32)).optional(),
  allowedSessions: z.array(z.string().trim().min(1).max(32)).optional(),
  allowedStrategies: z.array(z.string().trim().min(1).max(64)).optional(),
  newsTradingPermission: z.enum(["BLOCK", "CAUTION", "ALLOW"]).optional(),
  requireStopLoss: z.boolean().optional(),
});

const autonomyInput = z.object({
  level: z.number().int().min(0).max(4),
  reason: z.string().trim().min(3).max(400),
});

const statusInput = z.object({
  status: z.enum(["UNFUNDED", "FUNDED_IDLE", "ACTIVE", "PAUSED", "STOPPED", "ARCHIVED"]),
  reason: z.string().trim().min(3).max(400),
});

const killInput = z.object({
  scope: z.enum(["GLOBAL", "AGENT", "STRATEGY", "SYMBOL", "NEWS"]),
  scopeRef: z.string().trim().min(1).max(120).nullish(),
  engaged: z.boolean(),
  reason: z.string().trim().min(3).max(400),
});

function badRequest(res: Response, parsed: { error: z.ZodError }) {
  err(res, 400, "INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input.");
}

// ── POST /admin/self-trade-ai/agents — create from template ─────────────────
router.post("/admin/self-trade-ai/agents", requireUser, async (req, res) => {
  const actor = requireAdmin(req, res);
  if (!actor) return;
  const p = createInput.safeParse(req.body ?? {});
  if (!p.success) { badRequest(res, p); return; }
  const result = await createAgentFromTemplate(
    {
      template: p.data.template,
      name: p.data.name,
      reason: p.data.reason,
      description: p.data.description ?? null,
      ownerType: p.data.ownerType,
      ownerId: p.data.ownerId ?? null,
    },
    actor,
  );
  if (!result.ok) { err(res, 400, result.error ?? "ERROR", result.message ?? "Failed."); return; }
  req.log.info({ agentId: result.data?.agent.id }, "self-trade agent created");
  res.json({ ok: true, agent: result.data?.agent ?? null });
});

// ── POST /admin/self-trade-ai/agents/:id/fund ───────────────────────────────
router.post("/admin/self-trade-ai/agents/:id/fund", requireUser, async (req, res) => {
  const actor = requireAdmin(req, res);
  if (!actor) return;
  const ip = idParam.safeParse(req.params);
  if (!ip.success) { err(res, 400, "INVALID_ID", "Invalid agent id."); return; }
  const p = fundInput.safeParse(req.body ?? {});
  if (!p.success) { badRequest(res, p); return; }
  const result = await fundAgent({
    agentId: ip.data.id,
    amount: p.data.amount,
    reason: p.data.reason,
    actorUserId: actor.userId,
    actorRole: actor.role,
  });
  if (!result.ok) { err(res, 400, result.error ?? "ERROR", result.message ?? "Failed."); return; }
  res.json({ ok: true, ledger: result.ledger ?? null });
});

// ── POST /admin/self-trade-ai/agents/:id/defund ─────────────────────────────
router.post("/admin/self-trade-ai/agents/:id/defund", requireUser, async (req, res) => {
  const actor = requireAdmin(req, res);
  if (!actor) return;
  const ip = idParam.safeParse(req.params);
  if (!ip.success) { err(res, 400, "INVALID_ID", "Invalid agent id."); return; }
  const p = fundInput.safeParse(req.body ?? {});
  if (!p.success) { badRequest(res, p); return; }
  const result = await defundAgent({
    agentId: ip.data.id,
    amount: p.data.amount,
    reason: p.data.reason,
    actorUserId: actor.userId,
    actorRole: actor.role,
  });
  if (!result.ok) { err(res, 400, result.error ?? "ERROR", result.message ?? "Failed."); return; }
  res.json({ ok: true, ledger: result.ledger ?? null });
});

// ── PATCH /admin/self-trade-ai/agents/:id/config ────────────────────────────
router.patch("/admin/self-trade-ai/agents/:id/config", requireUser, async (req, res) => {
  const actor = requireAdmin(req, res);
  if (!actor) return;
  const ip = idParam.safeParse(req.params);
  if (!ip.success) { err(res, 400, "INVALID_ID", "Invalid agent id."); return; }
  const p = configInput.safeParse(req.body ?? {});
  if (!p.success) { badRequest(res, p); return; }
  const { reason, ...patch } = p.data;
  const result = await configureAgent(ip.data.id, patch as ConfigurablePatch, reason, actor);
  if (!result.ok) { err(res, 400, result.error ?? "ERROR", result.message ?? "Failed."); return; }
  res.json({ ok: true });
});

// ── POST /admin/self-trade-ai/agents/:id/autonomy ───────────────────────────
router.post("/admin/self-trade-ai/agents/:id/autonomy", requireUser, async (req, res) => {
  const actor = requireAdmin(req, res);
  if (!actor) return;
  const ip = idParam.safeParse(req.params);
  if (!ip.success) { err(res, 400, "INVALID_ID", "Invalid agent id."); return; }
  const p = autonomyInput.safeParse(req.body ?? {});
  if (!p.success) { badRequest(res, p); return; }
  const result = await setAutonomyLevel(ip.data.id, p.data.level, p.data.reason, actor);
  if (!result.ok) { err(res, 400, result.error ?? "ERROR", result.message ?? "Failed."); return; }
  res.json({ ok: true });
});

// ── POST /admin/self-trade-ai/agents/:id/status ─────────────────────────────
router.post("/admin/self-trade-ai/agents/:id/status", requireUser, async (req, res) => {
  const actor = requireAdmin(req, res);
  if (!actor) return;
  const ip = idParam.safeParse(req.params);
  if (!ip.success) { err(res, 400, "INVALID_ID", "Invalid agent id."); return; }
  const p = statusInput.safeParse(req.body ?? {});
  if (!p.success) { badRequest(res, p); return; }
  const result = await setAgentStatus(ip.data.id, p.data.status, p.data.reason, actor);
  if (!result.ok) { err(res, 400, result.error ?? "ERROR", result.message ?? "Failed."); return; }
  res.json({ ok: true });
});

// ── POST /admin/self-trade-ai/kill-switch ───────────────────────────────────
router.post("/admin/self-trade-ai/kill-switch", requireUser, async (req, res) => {
  const actor = requireAdmin(req, res);
  if (!actor) return;
  const p = killInput.safeParse(req.body ?? {});
  if (!p.success) { badRequest(res, p); return; }
  const result = await toggleKillSwitch(
    p.data.scope,
    p.data.scopeRef ?? null,
    p.data.engaged,
    p.data.reason,
    actor,
  );
  if (!result.ok) { err(res, 400, result.error ?? "ERROR", result.message ?? "Failed."); return; }
  req.log.warn({ scope: p.data.scope, engaged: p.data.engaged }, "self-trade kill switch toggled");
  res.json({ ok: true });
});

export default router;
