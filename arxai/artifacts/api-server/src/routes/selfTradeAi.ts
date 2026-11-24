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
import { managementNote } from "../lib/selfTrade/executionLifecycle.js";
import { appendAtiShadowObservation, gradeAtiShadowRun, readAtiShadowRun, startAtiShadowRun } from "../lib/selfTrade/atiShadow.js";
import { readAtiPortfolioRisk } from "../lib/selfTrade/atiPortfolioReport.js";
import { readAtiCaptureOperations } from "../lib/selfTrade/atiCaptureOperations.js";
import { readAtiExecutionOperations } from "../lib/selfTrade/atiExecutionOperations.js";
import { readAtiGuardianComparison } from "../lib/selfTrade/atiGuardianReport.js";
import { readAtiShadowMemory } from "../lib/selfTrade/atiTradingMemory.js";
import { readAtiLiveMemory } from "../lib/selfTrade/atiLiveTradingMemory.js";
import { listAtiResearch, readAtiResearch, readAtiReplication, registerAtiResearch, replayAtiResearchObservation, sealAtiResearch } from "../lib/selfTrade/atiResearchLab.js";
import { atiResearchInput } from "../lib/selfTrade/atiResearchModel.js";
import { ATI_FLEET_BASELINE, ATI_FLEET_SYMBOL } from "../lib/selfTrade/atiFleetShadow.js";
import { atiShadowDefinition } from "../lib/selfTrade/atiShadowGrading.js";
import { atiChallengerVersion } from "../lib/selfTrade/atiCounterargument.js";

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

const atiPilotBody = z.object({
  baselineVersion: z.enum([atiShadowDefinition.baselineVersion, ATI_FLEET_BASELINE]).optional(),
  symbol: z.string().trim().min(1).max(40),
  setup: z.enum(["TREND_CONTINUATION", "BREAKOUT_RETEST", "REVERSAL", "LIQUIDITY_SWEEP", "RANGE_FADE"]),
  durationMinutes: z.number().int().min(1).max(1440),
  challengerVersion: atiChallengerVersion.optional(),
  assumedCosts: z.object({
    adverseSlippagePerFillPriceUnits: z.number().nonnegative(),
    feePerFillPriceUnits: z.number().nonnegative(),
  }).optional(),
});
const atiRunParams = idParam.extend({ runId: z.uuid() });

router.get("/self-trade-ai/ati-portfolio-risk/paper-accounts/:id", requireUser, async (req, res) => {
  const account = idParam.safeParse(req.params);
  const period = z.object({ from: z.iso.datetime(), through: z.iso.datetime() }).safeParse(req.query);
  if (!account.success || !period.success) { err(res, 400, "INVALID_INPUT", "Specify an account and UTC report window."); return; }
  const from = new Date(period.data.from), through = new Date(period.data.through);
  if (+through > Date.now() || +from >= +through) { err(res, 400, "INVALID_WINDOW", "Choose an elapsed report window."); return; }
  const report = await readAtiPortfolioRisk(req.authUser!.id, account.data.id, from, through);
  if (!report) { err(res, 404, "NOT_FOUND", "Paper account unavailable."); return; }
  if (report.state === "AUDIT_INTEGRITY_GAP") { err(res, 409, report.state, "Conflicting risk audit receipts."); return; }
  if (report.state === "NARROW_WINDOW") { err(res, 422, report.state, "Choose a window with at most 1,000 decisions."); return; }
  res.json(report);
});

router.post("/self-trade-ai/agents/:id/ati-shadow-runs", requireUser, async (req, res) => {
  const params = idParam.safeParse(req.params);
  const body = atiPilotBody.safeParse(req.body);
  if (!params.success || !body.success) {
    err(res, 400, "INVALID_INPUT", "Choose an agent, an allowed symbol, a setup, and a duration in minutes.");
    return;
  }
  if (body.data.baselineVersion === ATI_FLEET_BASELINE && (body.data.symbol !== ATI_FLEET_SYMBOL ||
      (body.data.challengerVersion ?? atiShadowDefinition.challengerVersion) !== atiShadowDefinition.challengerVersion)) {
    err(res, 400, "UNSUPPORTED_FLEET_COMPARISON", "The owner-fleet pilot supports V75 and the timeframe-conflict challenger.");
    return;
  }
  const run = await startAtiShadowRun(req.authUser!.id, params.data.id, body.data);
  if (!run) {
    err(res, 404, "AGENT_UNAVAILABLE", "No eligible agent and allowed symbol were found for this account.");
    return;
  }
  res.status(201).json(run);
});

router.post("/self-trade-ai/agents/:id/ati-shadow-runs/:runId/observations", requireUser, async (req, res) => {
  const params = atiRunParams.safeParse(req.params);
  if (!params.success) { err(res, 400, "INVALID_ID", "Invalid agent or run id."); return; }
  const result = await appendAtiShadowObservation(req.authUser!.id, params.data.id, params.data.runId);
  const status = result.status === "NOT_FOUND" ? 404
    : result.status === "RECORDED" ? 201
    : result.status === "ALREADY_OBSERVED" ? 200 : 409;
  res.status(status).json(result);
});

router.get("/self-trade-ai/agents/:id/ati-shadow-runs/:runId", requireUser, async (req, res) => {
  const params = atiRunParams.safeParse(req.params);
  if (!params.success) { err(res, 400, "INVALID_ID", "Invalid agent or run id."); return; }
  const query = z.object({ asOf: z.iso.datetime().optional() }).safeParse(req.query);
  if (!query.success) { err(res, 400, "INVALID_INPUT", "Use a UTC timestamp for asOf."); return; }
  const asOf = query.data.asOf ? new Date(query.data.asOf) : undefined;
  if (asOf && +asOf > Date.now()) { err(res, 400, "INVALID_INPUT", "Choose an elapsed shadow report cutoff."); return; }
  const report = await readAtiShadowRun(req.authUser!.id, params.data.id, params.data.runId, asOf);
  if (!report) { err(res, 404, "NOT_FOUND", "Shadow run not found."); return; }
  res.json(report);
});

router.get("/self-trade-ai/agents/:id/ati-shadow-runs/:runId/operations", requireUser, async (req, res) => {
  const params = atiRunParams.safeParse(req.params);
  const query = z.object({ observationKey: z.string().min(1).max(128).optional(), asOf: z.iso.datetime().optional() }).safeParse(req.query);
  if (!params.success || !query.success) { err(res,400,"INVALID_INPUT","Choose a run, observation and UTC cutoff."); return; }
  const asOf = query.data.asOf ? new Date(query.data.asOf) : new Date();
  if (+asOf > Date.now()) { err(res,400,"FUTURE_CUTOFF","Choose an elapsed cutoff."); return; }
  const report = query.data.observationKey
    ? await readAtiExecutionOperations(req.authUser!.id,params.data.id,params.data.runId,query.data.observationKey,asOf)
    : await readAtiCaptureOperations(req.authUser!.id,params.data.id,params.data.runId,asOf);
  if (!report) { err(res,404,"NOT_FOUND","Shadow observation unavailable at this cutoff."); return; }
  res.json(report);
});

router.get("/self-trade-ai/agents/:id/ati-shadow-runs/:runId/guardian", requireUser, async (req, res) => {
  const params = atiRunParams.safeParse(req.params);
  const query = z.object({ observationKey: z.string().min(1).max(128), asOf: z.iso.datetime().optional() }).safeParse(req.query);
  if (!params.success || !query.success) { err(res, 400, "INVALID_INPUT", "Choose a run, observation and UTC cutoff."); return; }
  const asOf = query.data.asOf ? new Date(query.data.asOf) : new Date();
  if (+asOf > Date.now()) { err(res, 400, "INVALID_INPUT", "The cutoff must be in the past."); return; }
  const report = await readAtiGuardianComparison(req.authUser!.id, params.data.id, params.data.runId, query.data.observationKey, asOf);
  if (!report) { err(res, 404, "NOT_FOUND", "Shadow observation unavailable at this cutoff."); return; }
  res.json(report);
});

router.post("/self-trade-ai/agents/:id/ati-shadow-runs/:runId/grade", requireUser, async (req, res) => {
  const params = atiRunParams.safeParse(req.params);
  if (!params.success) { err(res, 400, "INVALID_ID", "Invalid agent or run id."); return; }
  const result = await gradeAtiShadowRun(req.authUser!.id, params.data.id, params.data.runId);
  if (!result) { err(res, 404, "NOT_FOUND", "Shadow run not found."); return; }
  res.json(result);
});

router.get("/self-trade-ai/agents/:id/ati-research-studies", requireUser, async (req, res) => {
  const params = idParam.safeParse(req.params);
  const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).safeParse(req.query);
  if (!params.success || !query.success) { err(res, 400, "INVALID_INPUT", "Invalid agent or limit."); return; }
  res.json({ studies: await listAtiResearch(req.authUser!.id, params.data.id, query.data.limit) });
});

router.post("/self-trade-ai/agents/:id/ati-research-studies", requireUser, async (req, res) => {
  const params = idParam.safeParse(req.params);
  const body = atiResearchInput.safeParse(req.body);
  if (!params.success || !body.success) { err(res, 400, "INVALID_REGISTRATION", "Invalid agent or research registration."); return; }
  const result = await registerAtiResearch(req.authUser!.id, params.data.id, body.data);
  const status = result.status === "REGISTERED" ? 201 : result.status === "ALREADY_REGISTERED" ? 200
    : result.status === "AGENT_UNAVAILABLE" ? 404 : result.status === "INVALID_REGISTRATION" ? 400 : 409;
  res.status(status).json(result);
});

router.get("/self-trade-ai/agents/:id/ati-research-studies/:runId", requireUser, async (req, res) => {
  const params = atiRunParams.safeParse(req.params);
  if (!params.success) { err(res, 400, "INVALID_ID", "Invalid agent or study id."); return; }
  const result = await readAtiResearch(req.authUser!.id, params.data.id, params.data.runId);
  if (!result) { err(res, 404, "NOT_FOUND", "Research study not found."); return; }
  res.json(result);
});

router.get("/self-trade-ai/agents/:id/ati-research-studies/:runId/forward-evidence", requireUser, async (req,res) => {
  const params = atiRunParams.safeParse(req.params);
  if (!params.success) { err(res,400,"INVALID_ID","Invalid agent or study id."); return; }
  const report = await readAtiReplication(req.authUser!.id,params.data.id,params.data.runId);
  if (!report) { err(res,404,"NOT_FOUND","Research study not found."); return; }
  res.json(report);
});

router.get("/self-trade-ai/agents/:id/ati-research-studies/:runId/replay/:observationKey", requireUser, async (req, res) => {
  const params = atiRunParams.extend({ observationKey: z.string().min(1).max(128) }).safeParse(req.params);
  if (!params.success) { err(res, 400, "INVALID_ID", "Invalid study or observation id."); return; }
  const { id, runId, observationKey } = params.data;
  const result = await replayAtiResearchObservation(req.authUser!.id, id, runId, observationKey);
  if (!result) { err(res, 404, "NOT_FOUND", "Research observation not found."); return; }
  res.status(result.status === "STUDY_NOT_SEALED" ? 409 : 200).json(result);
});

router.post("/self-trade-ai/agents/:id/ati-research-studies/:runId/observations", requireUser, async (req, res) => {
  const params = atiRunParams.safeParse(req.params);
  if (!params.success) { err(res, 400, "INVALID_ID", "Invalid agent or study id."); return; }
  const result = await appendAtiShadowObservation(req.authUser!.id, params.data.id, params.data.runId, "RESEARCH");
  const status = result.status === "NOT_FOUND" ? 404 : result.status === "ALREADY_OBSERVED" || result.status === "RECORDED" ? 202 : 409;
  // A duplicate or changed feed must not disclose a holdout row through the write receipt.
  res.status(status).json({ status: status === 202 ? "CAPTURE_CHECKED" : result.status });
});

router.post("/self-trade-ai/agents/:id/ati-research-studies/:runId/grade", requireUser, async (req, res) => {
  const params = atiRunParams.safeParse(req.params);
  if (!params.success) { err(res, 400, "INVALID_ID", "Invalid agent or study id."); return; }
  const result = await gradeAtiShadowRun(req.authUser!.id, params.data.id, params.data.runId, "RESEARCH");
  if (!result) { err(res, 404, "NOT_FOUND", "Research study not found."); return; }
  res.status(202).json({ status: "GRADING_CHECKED" });
});

router.post("/self-trade-ai/agents/:id/ati-research-studies/:runId/seal", requireUser, async (req, res) => {
  const params = atiRunParams.safeParse(req.params);
  if (!params.success) { err(res, 400, "INVALID_ID", "Invalid agent or study id."); return; }
  const result = await sealAtiResearch(req.authUser!.id, params.data.id, params.data.runId);
  if (!result) { err(res, 404, "NOT_FOUND", "Research study not found."); return; }
  res.status(result.status === "SEALED" ? 200 : 409).json(result);
});

const atiMemoryQuery = z.object({
  source: z.enum(["SHADOW", "LIVE"]).default("SHADOW"),
  symbol: z.string().min(1).max(40).optional(),
  setup: atiPilotBody.shape.setup.optional(),
  asOf: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
const atiMemoryCursor = z.discriminatedUnion("source", [
  z.object({ source: z.literal("SHADOW"), asOf: z.iso.datetime(), observedAt: z.iso.datetime(), runId: z.uuid(),
    observationKey: z.string().min(1).max(128), symbol: atiMemoryQuery.shape.symbol, setup: atiMemoryQuery.shape.setup }),
  z.object({ source: z.literal("LIVE"), asOf: z.iso.datetime(), beforeId: z.number().int().positive(),
    symbol: atiMemoryQuery.shape.symbol, setup: atiMemoryQuery.shape.setup }),
]);

router.get("/self-trade-ai/agents/:id/ati-trading-memory", requireUser, async (req, res) => {
  const params = idParam.safeParse(req.params);
  const query = atiMemoryQuery.safeParse(req.query);
  if (!params.success || !query.success) { err(res, 400, "INVALID_INPUT", "Invalid agent or memory filters."); return; }
  const { source, limit, setup, symbol } = query.data;
  let cursor: z.infer<typeof atiMemoryCursor> | undefined;
  if (query.data.cursor) {
    try { cursor = atiMemoryCursor.parse(JSON.parse(Buffer.from(query.data.cursor, "base64url").toString("utf8"))); }
    catch { err(res, 400, "INVALID_CURSOR", "Invalid trading memory cursor."); return; }
  }
  if (cursor && (cursor.source !== source || cursor.symbol !== symbol || cursor.setup !== setup ||
      (query.data.asOf && query.data.asOf !== cursor.asOf))) {
    err(res, 400, "INVALID_CURSOR", "The cursor belongs to a different memory snapshot."); return;
  }
  const asOf = new Date(cursor?.asOf ?? query.data.asOf ?? Date.now());
  if (+asOf > Date.now()) { err(res, 400, "INVALID_INPUT", "Choose a memory cutoff at or before the current time."); return; }
  const ownerId = req.authUser!.id;
  const agent = await getAgentById(params.data.id, { ownerType: "USER", ownerId });
  if (!agent) { err(res, 404, "NOT_FOUND", "Agent not found."); return; }
  const filter = { asOf, limit, setup, symbol };
  const encode = (position: object) => Buffer.from(JSON.stringify({ source, asOf: asOf.toISOString(), symbol, setup, ...position })).toString("base64url");
  if (source === "LIVE") {
    const page = await readAtiLiveMemory(ownerId, params.data.id, filter, cursor?.source === "LIVE" ? cursor.beforeId : undefined);
    res.json({ ...page, nextCursor: page.nextCursor ? encode({ beforeId: page.nextCursor }) : null });
    return;
  }
  const page = await readAtiShadowMemory(ownerId, params.data.id, filter, cursor?.source === "SHADOW" ? cursor : undefined);
  res.json({ ...page, nextCursor: page.nextCursor ? encode(page.nextCursor) : null });
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
  res.json({ executions: executions.map((execution) => ({ ...execution, managementNote: managementNote(execution) })) });
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
