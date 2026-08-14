// ── Agent Ecosystem (Layer 1) — read-only admin/owner endpoints + seed ──────
//
//   GET  /api/admin/agent-ecosystem/agents
//     Returns all agent registry rows (full detail). Admin/OWNER only.
//
//   GET  /api/admin/agent-ecosystem/constitution
//     Returns the versioned Agent Constitution (the 18 permanent laws).
//
//   POST /api/admin/agent-ecosystem/seed
//     Idempotently seeds the 14 core agents. Writes an audit row. Re-running
//     is a no-op (created=0).
//
// SAFETY: ADMIN/OWNER session required. An admin previewing-as-user is
// auto-downgraded by attachAuthUser and lands in the 403 branch. NOTHING here
// places, modifies, or closes a trade, and no path touches the 16-gate live
// pipeline — the ecosystem is advisory/shadow only.

import express, { type IRouter, Router, type Request, type Response } from "express";
import {
  db, agentsTable, agentPredictionReviewsTable, agentLifecycleEventsTable,
  adminActionAuditLogTable,
} from "@workspace/db";
import { asc, desc, eq } from "drizzle-orm";
import { getConstitution } from "@workspace/domain/agent-system";
import { seedCoreAgents } from "../lib/agentEcosystem/seedCoreAgents.js";
import { resolveAndScorePending } from "../lib/agentEcosystem/reviewScoring.js";
import { runPromotionBoard } from "../lib/agentEcosystem/promotionLifecycle.js";
import { listLearningCampRecords, advanceLearningCamp } from "../lib/agentEcosystem/learningCamp.js";
import { getAdvisoryTraces, type AdvisoryTraceEntry } from "../lib/agentEcosystem/advisoryInfluence.js";
import {
  getGovernanceTraces,
  listPersistedGovernanceTraces,
  type GovernanceSurface,
  type GovernanceTraceEntry,
} from "../lib/agentEcosystem/governance.js";
import {
  proposeAgentCreation,
  listAgentCreationRequests,
  decideAgentCreationRequest,
  getEcosystemSettings,
  setCreationFrozen,
  setBackgroundRunnerEnabled,
  type FactoryRequestStatus,
} from "../lib/agentEcosystem/agentFactory.js";
import {
  getLifecycleRunnerStatus,
  runLifecycleSweep,
} from "../lib/agentEcosystem/lifecycleRunner.js";
import type { AgentCreationRequestInput, DisagreementRecordDraft } from "@workspace/domain/agent-system";
import {
  runImmuneScan, getFamilyTree, getPopulationReport,
  previewTrafficRouting, isTrafficMode,
  recordDisagreement, listDisagreements, resolveDisagreementOutcome,
} from "../lib/agentEcosystem/layer3.js";
import {
  generateHouseholdReport, listHouseholdReports, getHouseholdReport,
} from "../lib/agentEcosystem/householdReport.js";

function parseAgentId(req: Request): number | undefined {
  const raw = (req.query.agentId as string | undefined) ?? undefined;
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
function parseLimit(req: Request, def: number, max: number): number {
  const n = Number(req.query.limit ?? def);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

const router: IRouter = Router();
router.use(express.json());

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

router.get("/admin/agent-ecosystem/agents", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const rows = await db.select().from(agentsTable).orderBy(asc(agentsTable.id));
  res.json({ ok: true, total: rows.length, agents: rows });
});

router.get("/admin/agent-ecosystem/constitution", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  res.json({ ok: true, constitution: getConstitution() });
});

router.post("/admin/agent-ecosystem/seed", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const reason = String((req.body as Record<string, unknown> | undefined)?.reason ?? "").trim();
  const result = await seedCoreAgents();
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id,
    adminRole: admin.role,
    action: "SEED_CORE_AGENTS",
    beforeState: {},
    afterState: { ...result },
    reason: reason.length >= 3 ? reason : "seed core agents",
  });
  res.json({ ok: true, ...result });
});

// ── Layer 2 reads ───────────────────────────────────────────────────────────

router.get("/admin/agent-ecosystem/reviews", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const agentId = parseAgentId(req);
  const limit = parseLimit(req, 100, 500);
  const base = db.select().from(agentPredictionReviewsTable);
  const rows = await (agentId != null
    ? base.where(eq(agentPredictionReviewsTable.agentId, agentId))
    : base)
    .orderBy(desc(agentPredictionReviewsTable.createdAt))
    .limit(limit);
  res.json({ ok: true, total: rows.length, reviews: rows });
});

router.get("/admin/agent-ecosystem/lifecycle", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const agentId = parseAgentId(req);
  const limit = parseLimit(req, 100, 500);
  const base = db.select().from(agentLifecycleEventsTable);
  const rows = await (agentId != null
    ? base.where(eq(agentLifecycleEventsTable.agentId, agentId))
    : base)
    .orderBy(desc(agentLifecycleEventsTable.createdAt))
    .limit(limit);
  res.json({ ok: true, total: rows.length, events: rows });
});

router.get("/admin/agent-ecosystem/learning-camp", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const rows = await listLearningCampRecords(parseAgentId(req));
  res.json({ ok: true, total: rows.length, records: rows });
});

// ── Phase 0 advisory visibility (admin/OWNER) ─────────────────────────────────
//
//   GET /api/admin/agent-ecosystem/advisory-traces?surface=SCANNER|RISK|SCALP&limit=N
//     Returns the most recent agent-advisory traces (one per symbol+timeframe per
//     surface) recorded as the desk's agents re-weighted real Scanner ranking,
//     Risk grading, Scalp scoring, and Ruby reads. Visibility only — these are
//     advisory snapshots, never an execution input. Admin/OWNER only.

const ADVISORY_SURFACES: ReadonlySet<string> = new Set(["SCANNER", "RISK", "SCALP"]);

router.get("/admin/agent-ecosystem/advisory-traces", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const surfaceRaw = (req.query.surface as string | undefined)?.toUpperCase();
  const surface = surfaceRaw && ADVISORY_SURFACES.has(surfaceRaw)
    ? (surfaceRaw as AdvisoryTraceEntry["surface"])
    : undefined;
  const limit = parseLimit(req, 100, 500);
  const traces = getAdvisoryTraces({ surface, limit });
  res.json({ ok: true, total: traces.length, traces });
});

// ── Layer 3 governance trace + household recommendations (admin/OWNER) ────────
//
//   GET /api/admin/agent-ecosystem/governance-traces?surface=SCANNER|RISK|SCALP|RUBY&limit=N
//     Returns the most recent FULL governance reviews (one per symbol+timeframe
//     per surface): the authority-weighted outcome, bounded governanceScore vs
//     advisoryScore, every challenge with its raising agent + weight, the winning
//     reasoning, lifecycle recommendations, and the traffic-selection summary.
//     Admin/OWNER only — this is the operator breakdown, never sent to users.
//
//   GET /api/admin/agent-ecosystem/household-recommendations?limit=N
//     Aggregates the lifecycle/household recommendations across recent governance
//     reviews (deduped per agentKey+action, keeping the most recent context).
//     Advisory only — applied solely via the existing audited admin lifecycle flow.

const GOVERNANCE_SURFACES: ReadonlySet<string> = new Set(["SCANNER", "RISK", "SCALP", "RUBY"]);

router.get("/admin/agent-ecosystem/governance-traces", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const surfaceRaw = (req.query.surface as string | undefined)?.toUpperCase();
  const surface = surfaceRaw && GOVERNANCE_SURFACES.has(surfaceRaw)
    ? (surfaceRaw as GovernanceSurface)
    : undefined;
  const limit = parseLimit(req, 100, 500);
  const traces = getGovernanceTraces({ surface, limit });
  res.json({ ok: true, total: traces.length, traces });
});

// Durable, paginated proof that governance was actually involved in real app
// actions (scanner scans, Ruby reads, scalp reads, and live submit/close bypass
// markers). Reads the persisted `agent_governance_traces` table — admin-only.
router.get("/admin/agent-ecosystem/governance-trace-log", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const actionType = (req.query.actionType as string | undefined)?.trim() || undefined;
  const activeMode = (req.query.activeMode as string | undefined)?.trim() || undefined;
  const limit = parseLimit(req, 50, 200);
  const offsetRaw = Number(req.query.offset ?? 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  const rows = await listPersistedGovernanceTraces({ actionType, activeMode, limit, offset });
  res.json({
    ok: true,
    limit,
    offset,
    count: rows.length,
    traces: rows,
  });
});

router.get("/admin/agent-ecosystem/household-recommendations", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const limit = parseLimit(req, 200, 500);
  const traces = getGovernanceTraces({ limit });
  // Dedupe by agentKey+action, keeping the most recent (traces are newest-first).
  const byKey = new Map<string, {
    agentKey: string; name: string; action: string; reason: string;
    surface: GovernanceTraceEntry["surface"]; symbol: string; at: string;
  }>();
  for (const t of traces) {
    for (const r of t.review.lifecycleRecommendations) {
      const k = `${r.agentKey}:${r.action}`;
      if (!byKey.has(k)) {
        byKey.set(k, {
          agentKey: r.agentKey, name: r.name, action: r.action, reason: r.reason,
          surface: t.surface, symbol: t.symbol, at: t.at,
        });
      }
    }
  }
  const recommendations = [...byKey.values()];
  res.json({ ok: true, total: recommendations.length, recommendations });
});

// ── Layer 4 daily Household Report (§17) — admin/OWNER, audited generate ──────
//
//   POST /api/admin/agent-ecosystem/household-reports/generate   { reason? }
//     Generates (or refreshes) the canonical Household Report for the current
//     UTC day and persists it (one per day, upserted on report_date). Writes an
//     audit row. OBSERVATION ONLY — aggregates the advisory registry + traces.
//
//   GET  /api/admin/agent-ecosystem/household-reports?search=&limit=N
//     Lists recent reports (newest first) with optional headline/date search.
//
//   GET  /api/admin/agent-ecosystem/household-reports/:reportId
//     Returns one report with its full structured body + plain-English summary.

router.post("/admin/agent-ecosystem/household-reports/generate", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const reason = String((req.body as Record<string, unknown> | undefined)?.reason ?? "").trim();
  const report = await generateHouseholdReport({ generatedByUserId: admin.id });
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: "AGENT_ECO_GENERATE_HOUSEHOLD_REPORT",
    beforeState: {},
    afterState: { reportId: report.reportId, reportDate: report.reportDate },
    reason: reason.length >= 3 ? reason : "generate daily household report",
  });
  res.status(201).json({ ok: true, reportId: report.reportId, reportDate: report.reportDate });
});

router.get("/admin/agent-ecosystem/household-reports", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  const limit = parseLimit(req, 60, 200);
  const reports = await listHouseholdReports({ search, limit });
  res.json({ ok: true, total: reports.length, reports });
});

router.get("/admin/agent-ecosystem/household-reports/:reportId", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const reportId = String(req.params.reportId ?? "").trim();
  if (!reportId) { res.status(400).json({ ok: false, error: "REPORT_ID_REQUIRED" }); return; }
  const report = await getHouseholdReport(reportId);
  if (!report) { res.status(404).json({ ok: false, error: "REPORT_NOT_FOUND" }); return; }
  res.json({ ok: true, report });
});

// ── Layer 2 actions (audited) ─────────────────────────────────────────────────

router.post("/admin/agent-ecosystem/resolve-outcomes", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const reason = String((req.body as Record<string, unknown> | undefined)?.reason ?? "").trim();
  const result = await resolveAndScorePending({});
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: "AGENT_ECO_RESOLVE_OUTCOMES",
    beforeState: {}, afterState: { ...result },
    reason: reason.length >= 3 ? reason : "resolve + score pending agent predictions",
  });
  res.json({ ok: true, ...result });
});

router.post("/admin/agent-ecosystem/run-promotion", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const reason = String((req.body as Record<string, unknown> | undefined)?.reason ?? "").trim();
  const result = await runPromotionBoard({ triggeredBy: "ADMIN", triggeredByUserId: admin.id });
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: "AGENT_ECO_RUN_PROMOTION",
    beforeState: {}, afterState: { ...result },
    reason: reason.length >= 3 ? reason : "run Promotion Board lifecycle sweep",
  });
  res.json({ ok: true, ...result });
});

// Advance one Learning Camp record through its supervised stage machine. The
// observed `improved` flag decides whether the agent progresses toward a return
// (Shadow → Supervised → Full) or is pushed to FURTHER_RESTRICTION. On a
// return/terminal stage the agent moves out of LEARNING_CAMP (supervised first)
// and a lifecycle event is appended. Correction only — never a trade/live path.
router.post("/admin/agent-ecosystem/learning-camp/:recordId/advance", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const recordId = String(req.params.recordId ?? "").trim();
  if (!recordId) { res.status(400).json({ ok: false, error: "recordId required" }); return; }
  const reason = String(body.reason ?? "").trim();
  if (reason.length < 3) { res.status(400).json({ ok: false, error: "reason (≥3 chars) required" }); return; }
  const improved = body.improved === true;
  const perfRaw = body.performanceAfterReturn;
  const performanceAfterReturn = typeof perfRaw === "number" && Number.isFinite(perfRaw) ? perfRaw : null;

  let result: Awaited<ReturnType<typeof advanceLearningCamp>>;
  try {
    result = await advanceLearningCamp({
      recordId, improved, performanceAfterReturn,
      triggeredBy: "ADMIN", triggeredByUserId: admin.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "advance failed";
    res.status(msg === "LEARNING_CAMP_RECORD_NOT_FOUND" ? 404 : 400).json({ ok: false, error: msg });
    return;
  }

  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: "AGENT_ECO_ADVANCE_LEARNING_CAMP",
    beforeState: { recordId, improved }, afterState: { ...result },
    reason,
  });
  res.json({ ok: true, ...result });
});

// ── Phase 6 background lifecycle runner (admin/OWNER) ─────────────────────────
//
//   GET  /api/admin/agent-ecosystem/runner-status
//     Returns the background runner's enabled switch + live status (last/next
//     run, durations, skip counts, last result, error counts). Read-only.
//
//   POST /api/admin/agent-ecosystem/runner-settings   { enabled: bool, reason }
//     Flips the opt-in master switch (default false). Advisory/shadow only —
//     NEVER affects any trade/live/demo path. Reason (≥3) required; audited.
//
//   POST /api/admin/agent-ecosystem/run-now           { reason, scoreLimit? }
//     Triggers one sweep immediately (triggeredBy=ADMIN, force=true). force
//     bypasses ONLY the enabled switch — it still defers while a live command
//     is in flight and still takes the single-flight lock. Reason (≥3); audited.

router.get("/admin/agent-ecosystem/runner-status", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  let enabled = false;
  try { enabled = (await getEcosystemSettings()).backgroundRunnerEnabled; } catch { /* fail-soft */ }
  res.json({ ok: true, enabled, runner: getLifecycleRunnerStatus() });
});

router.post("/admin/agent-ecosystem/runner-settings", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ ok: false, error: "enabled (boolean) required" }); return;
  }
  const reason = String(body.reason ?? "").trim();
  if (reason.length < 3) { res.status(400).json({ ok: false, error: "reason (≥3 chars) required" }); return; }
  const before = await getEcosystemSettings().catch(() => ({ backgroundRunnerEnabled: null as boolean | null }));
  const result = await setBackgroundRunnerEnabled(body.enabled, admin.id);
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: "AGENT_ECO_SET_RUNNER_ENABLED",
    beforeState: { backgroundRunnerEnabled: before.backgroundRunnerEnabled },
    afterState: { ...result },
    reason,
  });
  res.json({ ok: true, ...result });
});

router.post("/admin/agent-ecosystem/run-now", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = String(body.reason ?? "").trim();
  if (reason.length < 3) { res.status(400).json({ ok: false, error: "reason (≥3 chars) required" }); return; }
  const scoreRaw = body.scoreLimit;
  const scoreLimit = typeof scoreRaw === "number" && Number.isInteger(scoreRaw) && scoreRaw > 0
    ? Math.min(scoreRaw, 1000) : undefined;
  const result = await runLifecycleSweep({
    triggeredBy: "ADMIN", triggeredByUserId: admin.id, force: true, scoreLimit,
  });
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: "AGENT_ECO_RUN_NOW",
    beforeState: {},
    afterState: {
      skipped: result.skipped, errorCount: result.errorCount,
      durationMs: result.durationMs, steps: result.steps.map((s) => ({ step: s.step, ok: s.ok })),
    },
    reason,
  });
  res.json({ ok: true, ...result });
});

// ── Layer 3 Governed Agent Factory (admin/OWNER, audited) ─────────────────────
//
//   GET  /api/admin/agent-ecosystem/creation-requests?status=PROPOSED&limit=N
//     Lists agent creation requests (most recent first). Admin/OWNER only.
//
//   POST /api/admin/agent-ecosystem/creation-requests
//     Validates + persists a PROPOSED creation request via the PURE Factory
//     validator. Rejects forbidden / duplicate / under-specified requests with
//     422 + neutral error codes. A PROPOSED request NEVER activates an agent.
//
//   POST /api/admin/agent-ecosystem/creation-requests/:id/decision
//     Approves (mints a SHADOW agent at 0% authority) or rejects a PROPOSED
//     request. Requires reason (≥3 chars). Writes a fail-CLOSED audit row.
//
// SAFETY: a created agent is ALWAYS born SHADOW / 0 authority / no live influence.
// Nothing here touches a trade/live/demo path or the 16-gate live pipeline.

const FACTORY_STATUSES: ReadonlySet<string> = new Set(["PROPOSED", "APPROVED", "REJECTED"]);

router.get("/admin/agent-ecosystem/creation-requests", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const statusRaw = (req.query.status as string | undefined)?.toUpperCase();
  const status = statusRaw && FACTORY_STATUSES.has(statusRaw)
    ? (statusRaw as FactoryRequestStatus)
    : undefined;
  const limit = parseLimit(req, 100, 500);
  const requests = await listAgentCreationRequests({ status, limit });
  res.json({ ok: true, total: requests.length, requests });
});

router.post("/admin/agent-ecosystem/creation-requests", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const body = (req.body ?? {}) as Partial<AgentCreationRequestInput>;
  const input: AgentCreationRequestInput = {
    proposedName: String(body.proposedName ?? ""),
    proposedDepartment: String(body.proposedDepartment ?? ""),
    purpose: String(body.purpose ?? ""),
    reasonNeeded: String(body.reasonNeeded ?? ""),
    workflowGap: String(body.workflowGap ?? ""),
    allowedInputs: Array.isArray(body.allowedInputs) ? body.allowedInputs : [],
    allowedOutputs: Array.isArray(body.allowedOutputs) ? body.allowedOutputs : [],
    permissions: Array.isArray(body.permissions) ? body.permissions : [],
    failureConditions: Array.isArray(body.failureConditions) ? body.failureConditions : [],
    scorecard: Array.isArray(body.scorecard) ? body.scorecard : [],
    testingRequirements: Array.isArray(body.testingRequirements) ? body.testingRequirements : [],
    activationRequirements: Array.isArray(body.activationRequirements) ? body.activationRequirements : [],
    parentAgentKey: body.parentAgentKey ? String(body.parentAgentKey) : null,
  };
  // §8/§15 governance assertions for a parent-initiated creation. Defaulted to
  // the SAFE (deny) side by the service; only forwarded when explicitly present.
  const gov = ((body as Record<string, unknown>).governance ?? {}) as Record<string, unknown>;
  const governance = {
    immuneApproved: gov.immuneApproved === true,
    riskClear: gov.riskClear === true,
    taskGapEvidenceCount:
      typeof gov.taskGapEvidenceCount === "number" && Number.isFinite(gov.taskGapEvidenceCount)
        ? gov.taskGapEvidenceCount
        : 0,
    missingSpecialty: gov.missingSpecialty === true,
  };
  const result = await proposeAgentCreation(input, admin.id, { governance });
  if (!result.ok || !result.request) {
    res.status(422).json({ ok: false, error: "VALIDATION_FAILED", errors: result.errors ?? [] });
    return;
  }
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: "AGENT_FACTORY_PROPOSE",
    beforeState: {},
    afterState: { requestId: result.request.id, proposedName: result.request.proposedName },
    reason: `propose agent creation: ${result.request.proposedName}`.slice(0, 200),
  });
  res.status(201).json({ ok: true, request: result.request });
});

router.post("/admin/agent-ecosystem/creation-requests/:id/decision", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_REQUEST_ID" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const decisionRaw = String(body.decision ?? "").toUpperCase();
  if (decisionRaw !== "APPROVE" && decisionRaw !== "REJECT") {
    res.status(400).json({ ok: false, error: "INVALID_DECISION" });
    return;
  }
  const reason = String(body.reason ?? "").trim();
  if (reason.length < 3) {
    res.status(400).json({ ok: false, error: "REASON_REQUIRED" });
    return;
  }
  const result = await decideAgentCreationRequest({
    id, decision: decisionRaw, decidedByUserId: admin.id, reason,
  });
  if (!result.ok || !result.request) {
    res.status(409).json({ ok: false, error: result.error ?? "DECISION_FAILED" });
    return;
  }
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: decisionRaw === "APPROVE" ? "AGENT_FACTORY_APPROVE" : "AGENT_FACTORY_REJECT",
    beforeState: { requestId: id },
    afterState: {
      requestId: result.request.id,
      status: result.request.status,
      createdAgentId: result.createdAgentId ?? null,
    },
    reason,
  });
  res.json({ ok: true, request: result.request, createdAgentId: result.createdAgentId });
});

// ── Layer 3 orchestration + ecosystem health (admin/OWNER) ───────────────────
//
//   GET  /api/admin/agent-ecosystem/family-tree
//     Department roll-up of the agent registry: per-department scores, strongest
//     / weakest / fastest agents, bloat, and parent-accountability summary.
//
//   GET  /api/admin/agent-ecosystem/immune-scan
//     Ecosystem-health scan: per-agent anomaly findings + recommended actions.
//     Visibility only — auto-applicable findings are limited to Risk-flagged
//     immediate restriction and are NOT applied here.
//
//   GET  /api/admin/agent-ecosystem/population
//     Population report: per-department counts vs caps, overcrowding, and
//     cleanup recommendations. Advisory only.
//
//   GET  /api/admin/agent-ecosystem/traffic-route?mode=SCALP&trade=1&emergency=0
//     Previews how the Traffic Controller would route the registry for a given
//     mode. Pure preview — never an execution input.
//
// SAFETY: all read-only. Nothing here routes, slows, or gates a trade/live path.

router.get("/admin/agent-ecosystem/family-tree", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const tree = await getFamilyTree();
  res.json({ ok: true, tree });
});

router.get("/admin/agent-ecosystem/immune-scan", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const result = await runImmuneScan();
  res.json({ ok: true, scan: result });
});

router.get("/admin/agent-ecosystem/population", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const report = await getPopulationReport();
  res.json({ ok: true, report });
});

router.get("/admin/agent-ecosystem/traffic-route", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const modeRaw = String(req.query.mode ?? "").toUpperCase();
  if (!isTrafficMode(modeRaw)) {
    res.status(400).json({ ok: false, error: "INVALID_MODE" });
    return;
  }
  const result = await previewTrafficRouting({
    mode: modeRaw,
    tradeActionInvolved: req.query.trade === "1" || req.query.trade === "true",
    emergency: req.query.emergency === "1" || req.query.emergency === "true",
    newsRelevant: req.query.news === "1" || req.query.news === "true",
  });
  res.json({ ok: true, routing: result });
});

// ── Layer 3 Agent Court disagreement records (admin/OWNER, audited) ───────────
//
//   GET  /api/admin/agent-ecosystem/disagreements?status=PENDING&limit=N
//     Lists Court disagreement learning records (most recent first).
//
//   POST /api/admin/agent-ecosystem/disagreements
//     Persists a Court resolution draft as a PENDING learning record. The body
//     is a DisagreementRecordDraft (from resolveDisagreement). Writes an audit
//     row. Learning evidence only — never gates a trade.
//
//   POST /api/admin/agent-ecosystem/disagreements/:disagreementId/outcome
//     Fills in the later who-was-right verdict on supplied REAL outcome evidence
//     (fail-closed: PENDING until evidence). Requires reason (≥3 chars).

router.get("/admin/agent-ecosystem/disagreements", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const statusRaw = (req.query.status as string | undefined)?.toUpperCase();
  const status = statusRaw === "PENDING" || statusRaw === "RESOLVED" ? statusRaw : undefined;
  const limit = parseLimit(req, 100, 500);
  const rows = await listDisagreements({ status, limit });
  res.json({ ok: true, total: rows.length, disagreements: rows });
});

router.post("/admin/agent-ecosystem/disagreements", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const body = (req.body ?? {}) as Partial<DisagreementRecordDraft> & { reason?: string };
  // Minimal shape validation — the draft is produced by the PURE resolver.
  if (
    !body.symbol || !body.timeframe || !body.tradeType ||
    !body.resolvedOutcome || !body.winningDecision ||
    !Array.isArray(body.positions) || !Array.isArray(body.winningAgentKeys)
  ) {
    res.status(400).json({ ok: false, error: "INVALID_DISAGREEMENT_DRAFT" });
    return;
  }
  const draft: DisagreementRecordDraft = {
    symbol: String(body.symbol),
    timeframe: String(body.timeframe),
    tradeType: body.tradeType,
    condition: String(body.condition ?? ""),
    positions: body.positions,
    resolvedOutcome: body.resolvedOutcome,
    winningDecision: body.winningDecision,
    winningAgentKeys: body.winningAgentKeys.map(String),
    riskVetoApplied: body.riskVetoApplied === true,
    reasoning: String(body.reasoning ?? ""),
  };
  const result = await recordDisagreement(draft);
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: "AGENT_COURT_RECORD_DISAGREEMENT",
    beforeState: {},
    afterState: { disagreementId: result.disagreementId, id: result.id ?? null },
    reason: `record court disagreement: ${draft.symbol} ${draft.timeframe}`.slice(0, 200),
  });
  res.status(201).json({ ok: true, disagreementId: result.disagreementId, id: result.id });
});

router.post("/admin/agent-ecosystem/disagreements/:disagreementId/outcome", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const disagreementId = String(req.params.disagreementId ?? "").trim();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = String(body.reason ?? "").trim();
  if (reason.length < 3) { res.status(400).json({ ok: false, error: "REASON_REQUIRED" }); return; }
  const actualOutcome = String(body.actualOutcome ?? "").trim();
  if (!actualOutcome) { res.status(400).json({ ok: false, error: "ACTUAL_OUTCOME_REQUIRED" }); return; }
  const whoWasRightAgentKeys = Array.isArray(body.whoWasRightAgentKeys)
    ? body.whoWasRightAgentKeys.map(String)
    : [];

  const result = await resolveDisagreementOutcome({ disagreementId, whoWasRightAgentKeys, actualOutcome });
  if (!result.ok) {
    res.status(result.error === "DISAGREEMENT_NOT_FOUND" ? 404 : 400).json({ ok: false, error: result.error });
    return;
  }
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: "AGENT_COURT_RESOLVE_OUTCOME",
    beforeState: { disagreementId },
    afterState: { actualOutcome, whoWasRightAgentKeys },
    reason,
  });
  res.json({ ok: true });
});

// ── Layer 3 governance mutations (admin/OWNER, audited) ──────────────────────
//
//   GET  /api/admin/agent-ecosystem/settings
//     Returns the ecosystem settings singleton (currently the §15 freeze-all
//     creation switch). Admin/OWNER only.
//
//   POST /api/admin/agent-ecosystem/factory/freeze   { frozen, reason }
//     Engages/lifts the §15 admin master freeze-all switch. While engaged,
//     EVERY new agent-creation proposal is refused with creation_frozen_by_admin.
//     Requires reason (≥3 chars). Writes a fail-CLOSED audit row.
//
//   POST /api/admin/agent-ecosystem/agents/:agentKey/activate   { reason, mode? }
//     Admin approval for a SHADOW agent to leave Shadow Mode (§15). Moves the
//     agent SHADOW → SUPERVISED (default) or ACTIVE. Authority stays earned via
//     the Promotion Board — this never grants authority weight. Requires reason.
//
//   POST /api/admin/agent-ecosystem/immune/apply   { agentKey, action, reason }
//     Applies an immune/cleanup recommendation to an agent: QUARANTINE,
//     LEARNING_CAMP, REDUCE_AUTHORITY, ON_DEMAND_ONLY, REMOVE_CREATION_RIGHTS,
//     RETIRE, ARCHIVE. Core agents are protected from destructive actions
//     (only QUARANTINE / REDUCE_AUTHORITY / ON_DEMAND_ONLY are allowed). Requires
//     reason. Writes a fail-CLOSED audit row.
//
// SAFETY: all mutate the advisory agent registry only. NOTHING here places,
// modifies, or closes a trade, and no path touches the 16-gate live pipeline.

router.get("/admin/agent-ecosystem/settings", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const settings = await getEcosystemSettings();
  res.json({ ok: true, settings });
});

router.post("/admin/agent-ecosystem/factory/freeze", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.frozen !== "boolean") {
    res.status(400).json({ ok: false, error: "FROZEN_BOOLEAN_REQUIRED" });
    return;
  }
  const reason = String(body.reason ?? "").trim();
  if (reason.length < 3) { res.status(400).json({ ok: false, error: "REASON_REQUIRED" }); return; }
  const before = await getEcosystemSettings();
  const after = await setCreationFrozen(body.frozen, reason, admin.id);
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: body.frozen ? "AGENT_FACTORY_FREEZE_CREATION" : "AGENT_FACTORY_UNFREEZE_CREATION",
    beforeState: { ...before }, afterState: { ...after },
    reason,
  });
  res.json({ ok: true, settings: after });
});

const ACTIVATE_MODES: ReadonlySet<string> = new Set(["SUPERVISED", "ACTIVE"]);

router.post("/admin/agent-ecosystem/agents/:agentKey/activate", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const agentKey = String(req.params.agentKey ?? "").trim();
  if (!agentKey) { res.status(400).json({ ok: false, error: "AGENT_KEY_REQUIRED" }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = String(body.reason ?? "").trim();
  if (reason.length < 3) { res.status(400).json({ ok: false, error: "REASON_REQUIRED" }); return; }
  const modeRaw = String(body.mode ?? "SUPERVISED").toUpperCase();
  const mode = ACTIVATE_MODES.has(modeRaw) ? modeRaw : "SUPERVISED";

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.agentKey, agentKey)).limit(1);
  if (!agent) { res.status(404).json({ ok: false, error: "AGENT_NOT_FOUND" }); return; }
  // Only a SHADOW agent can be approved to leave Shadow Mode.
  if (agent.currentMode !== "SHADOW" && agent.currentStatus !== "SHADOW") {
    res.status(409).json({ ok: false, error: `AGENT_NOT_IN_SHADOW:${agent.currentMode}` });
    return;
  }
  const [updated] = await db.update(agentsTable)
    .set({ currentMode: mode, currentStatus: "ACTIVE", updatedAt: new Date() })
    .where(eq(agentsTable.id, agent.id))
    .returning();
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: "AGENT_APPROVE_SHADOW_EXIT",
    beforeState: { agentKey, currentMode: agent.currentMode, currentStatus: agent.currentStatus },
    afterState: { agentKey, currentMode: updated.currentMode, currentStatus: updated.currentStatus },
    reason,
  });
  res.json({ ok: true, agent: { agentKey, currentMode: updated.currentMode, currentStatus: updated.currentStatus, authorityWeight: updated.authorityWeight } });
});

const IMMUNE_ACTIONS: ReadonlySet<string> = new Set([
  "QUARANTINE", "LEARNING_CAMP", "REDUCE_AUTHORITY", "ON_DEMAND_ONLY",
  "REMOVE_CREATION_RIGHTS", "RETIRE", "ARCHIVE",
]);
// Actions that destroy/retire an agent — never applied to a core agent.
const DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set(["RETIRE", "ARCHIVE", "REMOVE_CREATION_RIGHTS", "LEARNING_CAMP"]);

router.post("/admin/agent-ecosystem/immune/apply", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const agentKey = String(body.agentKey ?? "").trim();
  if (!agentKey) { res.status(400).json({ ok: false, error: "AGENT_KEY_REQUIRED" }); return; }
  const action = String(body.action ?? "").toUpperCase();
  if (!IMMUNE_ACTIONS.has(action)) { res.status(400).json({ ok: false, error: "INVALID_ACTION" }); return; }
  const reason = String(body.reason ?? "").trim();
  if (reason.length < 3) { res.status(400).json({ ok: false, error: "REASON_REQUIRED" }); return; }

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.agentKey, agentKey)).limit(1);
  if (!agent) { res.status(404).json({ ok: false, error: "AGENT_NOT_FOUND" }); return; }
  if (agent.isCore && DESTRUCTIVE_ACTIONS.has(action)) {
    res.status(409).json({ ok: false, error: "CORE_AGENT_PROTECTED" });
    return;
  }

  // Map each immune/cleanup action to concrete registry mutations. None of these
  // touch a trade/live path — they only adjust the agent's advisory standing.
  const patch: Partial<typeof agentsTable.$inferInsert> = { updatedAt: new Date() };
  switch (action) {
    case "QUARANTINE":
      patch.currentStatus = "QUARANTINED"; patch.currentMode = "SHADOW";
      patch.authorityWeight = 0; patch.liveInfluenceAllowed = false;
      break;
    case "LEARNING_CAMP":
      patch.currentStatus = "LEARNING_CAMP"; patch.currentMode = "SHADOW";
      patch.authorityWeight = 0; patch.liveInfluenceAllowed = false;
      break;
    case "REDUCE_AUTHORITY":
      patch.authorityWeight = 0; patch.liveInfluenceAllowed = false;
      break;
    case "ON_DEMAND_ONLY":
      patch.currentMode = "ON_DEMAND";
      break;
    case "REMOVE_CREATION_RIGHTS":
      patch.canCreateAgents = false; patch.creationRightLevel = "NONE";
      break;
    case "RETIRE":
      patch.currentStatus = "RETIRED"; patch.currentMode = "SHADOW";
      patch.authorityWeight = 0; patch.liveInfluenceAllowed = false; patch.canCreateAgents = false;
      break;
    case "ARCHIVE":
      patch.currentStatus = "ARCHIVED"; patch.currentMode = "SHADOW";
      patch.authorityWeight = 0; patch.liveInfluenceAllowed = false; patch.canCreateAgents = false;
      patch.archivedAt = new Date();
      break;
  }

  const [updated] = await db.update(agentsTable).set(patch)
    .where(eq(agentsTable.id, agent.id)).returning();
  await db.insert(adminActionAuditLogTable).values({
    adminId: admin.id, adminRole: admin.role,
    action: `AGENT_IMMUNE_APPLY:${action}`,
    beforeState: {
      agentKey, currentStatus: agent.currentStatus, currentMode: agent.currentMode,
      authorityWeight: agent.authorityWeight, canCreateAgents: agent.canCreateAgents,
    },
    afterState: {
      agentKey, currentStatus: updated.currentStatus, currentMode: updated.currentMode,
      authorityWeight: updated.authorityWeight, canCreateAgents: updated.canCreateAgents,
    },
    reason,
  });
  res.json({
    ok: true,
    agent: {
      agentKey, action,
      currentStatus: updated.currentStatus, currentMode: updated.currentMode,
      authorityWeight: updated.authorityWeight, canCreateAgents: updated.canCreateAgents,
    },
  });
});

export default router;
