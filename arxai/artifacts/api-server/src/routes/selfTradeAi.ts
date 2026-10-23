// Self-Trade AI — read surfaces (Task #211, Foundation).
//
// SAFETY / SCOPE:
//   - READ-ONLY. Nothing here places / modifies / closes a trade, touches the
//     MT5 bridge, the 16-gate live pipeline, kill switches, or any execution
//     surface. It only reads the Self-Trade fleet control state.
//   - Owner-isolated: a non-admin caller sees ONLY their own USER agents.
//     ADMIN/OWNER callers see the whole fleet (operator + per-user).

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { resolveProductRole, isAdminProductRole } from "../lib/auth/productRole.js";
import {
  getFleetOverview,
  listAgents,
  getAgentById,
  listLedgerEntries,
  listAllocations,
  listKillSwitches,
  listAuditLog,
  listAgentExecutions,
  type AgentScope,
} from "../lib/selfTrade/service.js";
import { runDecisionCycle } from "../lib/selfTrade/decisionEngine.js";
import { getVolatilityMatrix } from "../lib/selfTrade/volatilityMatrixService.js";
import { runAutonomousCycle } from "../lib/selfTrade/autonomousCycle.js";

const router = Router();

function err(res: Response, status: number, error: string, message: string) {
  res.status(status).json({ ok: false, error, message });
}

// Resolve the visibility scope for the caller. Admin/owner → whole fleet.
// Everyone else → strictly their own USER agents.
function scopeFor(req: Request): AgentScope | undefined {
  const role = resolveProductRole(req.authUser);
  if (isAdminProductRole(role)) return undefined; // full fleet
  return { ownerType: "USER", ownerId: req.authUser?.id ?? -1 };
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });
const allocQuery = z.object({ agentId: z.coerce.number().int().positive().optional() });
const auditQuery = z.object({
  agentId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

router.get("/self-trade-ai/overview", requireUser, async (req, res) => {
  const overview = await getFleetOverview(scopeFor(req));
  res.json(overview);
});

router.get("/self-trade-ai/agents", requireUser, async (req, res) => {
  const agents = await listAgents(scopeFor(req));
  res.json({ agents });
});

router.get("/self-trade-ai/agents/:id", requireUser, async (req, res) => {
  const p = idParam.safeParse(req.params);
  if (!p.success) { err(res, 400, "INVALID_ID", "Invalid agent id."); return; }
  const detail = await getAgentById(p.data.id, scopeFor(req));
  if (!detail) { err(res, 404, "NOT_FOUND", "Agent not found."); return; }
  res.json(detail);
});

router.get("/self-trade-ai/agents/:id/ledger", requireUser, async (req, res) => {
  const p = idParam.safeParse(req.params);
  if (!p.success) { err(res, 400, "INVALID_ID", "Invalid agent id."); return; }
  // Owner-isolation: confirm the agent is visible to the caller first.
  const detail = await getAgentById(p.data.id, scopeFor(req));
  if (!detail) { err(res, 404, "NOT_FOUND", "Agent not found."); return; }
  const q = limitQuery.safeParse(req.query ?? {});
  const entries = await listLedgerEntries(p.data.id, q.success ? q.data.limit ?? 100 : 100);
  res.json({ entries });
});

router.get("/self-trade-ai/allocations", requireUser, async (req, res) => {
  const q = allocQuery.safeParse(req.query ?? {});
  if (!q.success) { err(res, 400, "INVALID_QUERY", "Invalid query."); return; }
  // Non-admins can only ask about an agent they own.
  const role = resolveProductRole(req.authUser);
  if (!isAdminProductRole(role)) {
    if (!q.data.agentId) {
      const mine = await listAgents(scopeFor(req));
      const ids = new Set(mine.map((a) => a.id));
      const all = await listAllocations();
      res.json({ allocations: all.filter((a) => ids.has(a.agentId)) });
      return;
    }
    const detail = await getAgentById(q.data.agentId, scopeFor(req));
    if (!detail) { err(res, 404, "NOT_FOUND", "Agent not found."); return; }
  }
  const allocations = await listAllocations(q.data.agentId);
  res.json({ allocations });
});

router.get("/self-trade-ai/kill-switches", requireUser, async (req, res) => {
  // Kill switches are operator-scope state; only admins see them.
  const role = resolveProductRole(req.authUser);
  if (!isAdminProductRole(role)) { res.json({ killSwitches: [] }); return; }
  const killSwitches = await listKillSwitches();
  res.json({ killSwitches });
});

router.get("/self-trade-ai/audit", requireUser, async (req, res) => {
  const q = auditQuery.safeParse(req.query ?? {});
  if (!q.success) { err(res, 400, "INVALID_QUERY", "Invalid query."); return; }
  const role = resolveProductRole(req.authUser);
  if (!isAdminProductRole(role)) {
    // Non-admins may only read audit rows for an agent they own.
    if (!q.data.agentId) { res.json({ rows: [] }); return; }
    const detail = await getAgentById(q.data.agentId, scopeFor(req));
    if (!detail) { err(res, 404, "NOT_FOUND", "Agent not found."); return; }
  }
  const rows = await listAuditLog(q.data.agentId, q.data.limit ?? 100);
  res.json({ rows });
});

router.get("/self-trade-ai/decisions", requireUser, async (req, res) => {
  // SHADOW / decision-only. Triggers a cached evaluation cycle for the agents
  // visible to the caller and persists it (fail-open). No order is ever placed.
  const result = await runDecisionCycle(scopeFor(req), req.authUser?.id ?? null);
  res.json(result);
});

router.get("/self-trade-ai/volatility-matrix", requireUser, async (_req, res) => {
  // Real-candle volatility relationships over the synthetic family. Honest blind
  // nodes/pairs when data is insufficient; never fabricated relationships.
  const matrix = await getVolatilityMatrix();
  res.json(matrix);
});

const execQuery = z.object({
  agentId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

router.get("/self-trade-ai/executions", requireUser, async (req, res) => {
  // Owner-isolated REAL execution feed. honest dispatch≠fill: a DISPATCHED row
  // is NOT a fill — only a row carrying a real brokerTicket + FILLED is.
  const q = execQuery.safeParse(req.query ?? {});
  if (!q.success) { err(res, 400, "INVALID_QUERY", "Invalid query."); return; }
  const executions = await listAgentExecutions(scopeFor(req), q.data.agentId, q.data.limit ?? 100);
  res.json({ executions });
});

const runCycleInput = z
  .object({
    reason: z.string().trim().min(3).max(400),
    ownerType: z.enum(["OPERATOR_FLEET", "USER"]).nullish(),
    ownerId: z.coerce.number().int().positive().nullish(),
  })
  .refine((v) => v.ownerType !== "USER" || v.ownerId != null, {
    message: "ownerId is required when ownerType is USER.",
    path: ["ownerId"],
  });

router.post("/self-trade-ai/run-autonomous-cycle", requireUser, async (req, res) => {
  // ADMIN/OWNER only, audited. Drives ONE controlled autonomous cycle through
  // the existing gated pipeline — no always-on loop, no gate bypass.
  const role = resolveProductRole(req.authUser);
  if (!isAdminProductRole(role)) { err(res, 403, "ADMIN_REQUIRED", "Admin or owner access required."); return; }
  const p = runCycleInput.safeParse(req.body ?? {});
  if (!p.success) { err(res, 400, "INVALID_INPUT", p.error.issues[0]?.message ?? "Invalid input."); return; }
  const actorUserId = req.authUser?.id ?? -1;
  const scope =
    p.data.ownerType != null
      ? { ownerType: p.data.ownerType, ownerId: p.data.ownerId ?? null }
      : undefined;
  req.log.warn({ actorUserId, scope, reason: p.data.reason }, "self-trade autonomous cycle invoked");
  const result = await runAutonomousCycle({
    scope,
    actorUserId,
    actorRole: req.authUser?.role ?? null,
    reason: p.data.reason,
  });
  res.json({ ok: true, ...result });
});

export default router;
