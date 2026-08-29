// ── Profit Mission routes — create / list / get / pulse (Phase 1) +
//    multi-agent proposal War Room (Phase 3, Task #662) ──
//
// SAFETY / SCOPE:
//   - PLANNING + DISPLAY ONLY. These routes persist a user's stated goal and
//     return the SERVER-COMPUTED feasibility / probability / pace read, plus the
//     Phase 3 advisory agent roster / proposals / Risk veto / Judge selection.
//     They NEVER touch any execution path — no drafts, dispatch, or order send.
//   - Strictly per-user AND per-mission: every read/write is scoped by
//     req.authUser.id (and the owning mission). A row from one user is never
//     returned to another.
//   - Assessment + proposals are composed from the PURE domain engines; the
//     route never re-derives math. Values are honest estimates, never fabricated;
//     a disconnected/stale feed yields an honest no_trade with no selection.
//   - A mission is always created as a `draft` (automationLevel 2 / approval).
//     The feasibility verdict's `canStart` is feed-gated; the feed is not
//     confirmed for execution, so START stays blocked (drafts still allowed).
import { Router } from "express";
import { db, profitMissionsTable, missionTradeDraftsTable, oneClickAuditTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { normalizeProductRole, isAdminProductRole } from "../lib/auth/productRole.js";
import { CreateProfitMissionBody } from "@workspace/api-zod";
import {
  computeMissionMath,
  evaluateFeasibility,
  evaluateProbability,
  resolveUserAction,
  isMissionStatus,
  specToMinutes,
  specToLabel,
  type MissionStatus,
  type MissionUserAction,
  type RiskProfile,
  type TimeframeUnit,
} from "@workspace/domain/profit-mission";
import {
  assess,
  serialize,
  serializePulse,
  resolveFeedReadiness,
  VALID_RISK_PROFILES,
  type MissionRow,
} from "../lib/profitMissionSerialize.js";
import {
  applyMissionTransition,
  applyMissionSettingsUpdate,
  listMissionEvents,
} from "../lib/profitMissionJournal.js";
import {
  seedMissionTeam,
  listMissionProposals,
  runMissionScan,
} from "../lib/missionAgents.js";
import {
  approveProposalDraft,
  rejectProposalDraft,
  listTradeDrafts,
  projectDraft,
  type DraftServiceResult,
} from "../lib/missionDrafts.js";
import { refreshMissionRisk, type MissionLiveSignals } from "../lib/missionRiskService.js";
import { dispatchApprovedDraft } from "../lib/missionExecution.js";
import { resolveMissionPulsePhase7 } from "../lib/missionExecutionQuality.js";
import {
  refreshMissionProtection,
  manageMissionTradeExit,
  type MissionExitSignals,
} from "../lib/missionExitManager.js";
import type { MissionAgentRow, MissionProposalRow } from "@workspace/db";
import type { OpportunityQueue, RankedOpportunity } from "@workspace/domain/profit-mission";
import {
  runMissionBacktest,
  aggregateMissionForward,
  listMissionTestResults,
  type TestingLabResult,
} from "../lib/missionTestingLabService.js";
import { evaluateAndApplyDrift } from "../lib/missionDriftService.js";
import {
  resolveMissionPromotionStatus,
  applyMissionAutomationLevel,
  type PromotionContext,
} from "../lib/missionPromotionService.js";
import {
  buildMissionCertificate,
  acceptMissionCertificate,
} from "../lib/missionCertificateService.js";
import { applyMissionExecutionMode } from "../lib/missionExecutionModeService.js";
import {
  buildMissionDailyBriefing,
  buildMissionEodReview,
  buildMissionReportForUser,
  buildMissionLearningLoop,
} from "../lib/missionBriefingService.js";

const router = Router();

// Conservative display/recompute signals for a mission's risk read. The
// `feedStatus`/`quoteFresh` values here are the NEUTRAL element of the additive,
// stricter-only mission gate (they assert "no extra degradation observed", NOT
// that a feed is live) — the live execution pipeline re-derives every safety
// signal server-side, and Phase 7 resolves real per-symbol feed truth on its own
// from the mt5_broker-aware seam (this channel can only ADD strictness, never
// upgrade). These only feed the additive mission gate + the display recompute.
const MISSION_RISK_SIGNALS: MissionLiveSignals = {
  killSwitchActive: false,
  brokerConnected: true,
  feedStatus: "live",
  quoteFresh: true,
};

async function ownMission(userId: number, id: number): Promise<MissionRow | null> {
  const r = await db
    .select()
    .from(profitMissionsTable)
    .where(and(eq(profitMissionsTable.id, id), eq(profitMissionsTable.userId, userId)))
    .limit(1);
  return r[0] ?? null;
}

// ── List ──────────────────────────────────────────────────────────────────
router.get("/profit-missions", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const now = Date.now();
  const rows = await db
    .select()
    .from(profitMissionsTable)
    .where(eq(profitMissionsTable.userId, userId))
    .orderBy(desc(profitMissionsTable.createdAt))
    .limit(200);
  res.json(rows.map((row) => serialize(row, assess(row, now))));
});

// ── Create (planning + display only) ────────────────────────────────────────
router.post("/profit-missions", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const parsed = CreateProfitMissionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    return;
  }
  const b = parsed.data;

  const startingAmount = Number(b.startingAmount);
  const targetAmount = Number(b.targetAmount);
  const now = Date.now();
  const timeframeStart = b.timeframeStart ? new Date(b.timeframeStart) : new Date(now);

  // Resolve timeframeEnd: prefer explicit ISO date; fall back to amount+unit.
  const VALID_UNITS: readonly TimeframeUnit[] = ["minutes", "hours", "days", "weeks"];
  let timeframeAmount: number | null = null;
  let timeframeUnit: TimeframeUnit | null = null;
  let timeframeMinutesDb: number | null = null;
  let timeframeLabelDb: string | null = null;
  let timeframeEnd: Date;

  const rawUnit = (b as Record<string, unknown>).timeframeUnit;
  const rawAmount = (b as Record<string, unknown>).timeframeAmount;
  if (rawUnit && VALID_UNITS.includes(rawUnit as TimeframeUnit) && rawAmount != null && Number.isFinite(Number(rawAmount)) && Number(rawAmount) > 0) {
    timeframeUnit = rawUnit as TimeframeUnit;
    timeframeAmount = Number(rawAmount);
    timeframeMinutesDb = specToMinutes(timeframeAmount, timeframeUnit);
    timeframeLabelDb = specToLabel(timeframeAmount, timeframeUnit);
    timeframeEnd = new Date(timeframeStart.getTime() + timeframeMinutesDb * 60_000);
  } else if (b.timeframeEnd) {
    timeframeEnd = new Date(b.timeframeEnd as string);
  } else {
    res.status(400).json({ error: "Provide timeframeEnd or timeframeAmount + timeframeUnit" });
    return;
  }

  if (!Number.isFinite(startingAmount) || startingAmount <= 0) {
    res.status(400).json({ error: "startingAmount must be a positive number" });
    return;
  }
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    res.status(400).json({ error: "targetAmount must be a positive number" });
    return;
  }
  if (targetAmount <= startingAmount) {
    res.status(400).json({ error: "targetAmount must be greater than startingAmount" });
    return;
  }
  if (Number.isNaN(timeframeStart.getTime()) || Number.isNaN(timeframeEnd.getTime())) {
    res.status(400).json({ error: "timeframeStart/timeframeEnd must be valid dates" });
    return;
  }
  if (timeframeEnd.getTime() <= timeframeStart.getTime()) {
    res.status(400).json({ error: "timeframeEnd must be after timeframeStart" });
    return;
  }

  const riskProfile: RiskProfile =
    b.riskProfile && (VALID_RISK_PROFILES as readonly string[]).includes(b.riskProfile)
      ? (b.riskProfile as RiskProfile)
      : "balanced";
  const currentValue =
    b.currentValue != null && Number.isFinite(Number(b.currentValue))
      ? Number(b.currentValue)
      : startingAmount;

  // Compose the pure engines for the create-time snapshot.
  const math = computeMissionMath({
    startingAmount,
    targetAmount,
    timeframeStartMs: timeframeStart.getTime(),
    timeframeEndMs: timeframeEnd.getTime(),
    currentValue,
    nowMs: now,
  });
  const feasibility = evaluateFeasibility({ math, riskProfile, feed: resolveFeedReadiness() });
  const probability = evaluateProbability({ math, feasibility, riskProfile, sampleSize: 0 });

  const settings =
    b.settings && typeof b.settings === "object" ? (b.settings as Record<string, unknown>) : null;

  const ins = await db
    .insert(profitMissionsTable)
    .values({
      userId,
      startingAmount,
      targetAmount,
      requiredProfit: targetAmount - startingAmount,
      timeframeStart,
      timeframeEnd,
      timeframeAmount,
      timeframeUnit,
      timeframeMinutes: timeframeMinutesDb,
      timeframeLabel: timeframeLabelDb,
      riskProfile,
      executionMode: "paper",
      automationLevel: 2,
      status: "draft",
      currentMode: "planning",
      settingsJson: settings,
      currentValue,
      progressJson: math,
      feasibilityJson: feasibility,
      probabilityJson: probability,
    })
    .returning();

  const row = ins[0]!;
  res.status(201).json(serialize(row, { math, feasibility, probability }));
});

// ── Parse natural-language mission intent (advisory / planning only) ─────────
// Pure deterministic parser — no LLM, no persistence, no execution gate.
// Must be registered BEFORE the /:id routes or Express catches "parse-intent"
// as an id parameter.
router.post("/profit-missions/parse-intent", requireUser, async (req, res): Promise<void> => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const { parseMissionIntent } = await import("../lib/assistant/parseMissionIntent.js");
  const result = parseMissionIntent(text);
  if (!result.ok) {
    res.status(400).json({ error: result.reason });
    return;
  }
  res.json(result.intent);
});

// ── Get one ─────────────────────────────────────────────────────────────────
router.get("/profit-missions/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  res.json(serialize(row, assess(row, Date.now())));
});

// ── Pulse (live recompute, display-only) ─────────────────────────────────────
router.get("/profit-missions/:id/pulse", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  const now = Date.now();
  const { math, feasibility, probability } = assess(row, now);
  // Recompute + persist the additive, stricter-only risk read (riskJson) and
  // surface it for the Battle Room display. Journaling inside is escalation-only
  // and idempotent, so repeated polls never spam mission_events.
  const risk = await refreshMissionRisk({
    userId,
    missionId: id,
    signals: MISSION_RISK_SIGNALS,
    nowMs: now,
  });
  // Advisory Phase 7 surface: honest broker/feed execution health + open exposure.
  const phase7 = await resolveMissionPulsePhase7({ userId, signals: MISSION_RISK_SIGNALS });
  // Phase 8 protection surface: recompute + persist milestones / locked profit /
  // giveback + compounding state (MERGED into progressJson; journaling is
  // change-only + idempotent, so repeated polls never spam mission_events). A
  // target stop+lock flips the mission to `completed` inside this call.
  const protection = await refreshMissionProtection({ userId, missionId: id, nowMs: now });
  res.json(
    serializePulse(
      row,
      { math, feasibility, probability },
      {
        risk: risk.ok ? risk.state : null,
        executionHealth: phase7.health,
        exposure: phase7.exposure,
        protection: protection.ok ? protection.snapshot : null,
        asOf: new Date(now).toISOString(),
      },
    ),
  );
});

// ── Lifecycle actions (pause / resume / cancel) ─────────────────────────────
//
// Each is a user-driven status transition. The state machine decides legality;
// the journaling service performs the move + writes the journal event + snapshot
// atomically. Illegal transitions return 409. PLANNING + DISPLAY ONLY.
const ACTION_COPY: Record<MissionUserAction, string> = {
  pause: "Mission paused by user.",
  resume: "Mission resumed by user.",
  cancel: "Mission cancelled by user.",
};

function readReason(body: unknown): string | null {
  if (body && typeof body === "object" && "reason" in body) {
    const r = (body as { reason?: unknown }).reason;
    if (typeof r === "string" && r.trim().length > 0) return r.trim().slice(0, 500);
  }
  return null;
}

async function handleLifecycleAction(
  action: MissionUserAction,
  userId: number,
  id: number,
  body: unknown,
  res: import("express").Response,
): Promise<void> {
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  if (!isMissionStatus(row.status)) {
    res.status(409).json({ error: `Cannot ${action} mission from an unrecognized state` });
    return;
  }
  const from: MissionStatus = row.status;
  const resolved = resolveUserAction(from, action);
  if (!resolved.ok) {
    res.status(409).json({ error: `Cannot ${action} mission from state '${from}'` });
    return;
  }
  const now = Date.now();
  const a = assess(row, now);
  const reason = readReason(body);
  const message = reason ? `${ACTION_COPY[action]} ${reason}` : ACTION_COPY[action];
  const result = await applyMissionTransition({
    userId,
    missionId: id,
    toStatus: resolved.resolved.to,
    eventType: resolved.resolved.eventType,
    message,
    metadata: reason ? { reason } : null,
    snapshot: {
      math: a.math,
      feasibility: a.feasibility,
      probability: a.probability,
      currentValue: row.currentValue,
      status: resolved.resolved.to,
      asOf: new Date(now).toISOString(),
    },
  });
  if (!result.ok) {
    if (result.kind === "not_found") {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    res.status(409).json({ error: `Cannot ${action} mission from state '${from}'` });
    return;
  }
  res.json(serialize(result.row, assess(result.row, Date.now())));
}

router.patch("/profit-missions/:id/pause", requireUser, async (req, res): Promise<void> => {
  await handleLifecycleAction("pause", req.authUser!.id, Number(req.params.id), req.body, res);
});

router.patch("/profit-missions/:id/resume", requireUser, async (req, res): Promise<void> => {
  await handleLifecycleAction("resume", req.authUser!.id, Number(req.params.id), req.body, res);
});

router.patch("/profit-missions/:id/cancel", requireUser, async (req, res): Promise<void> => {
  await handleLifecycleAction("cancel", req.authUser!.id, Number(req.params.id), req.body, res);
});

// ── Settings update (records an override event) ─────────────────────────────
router.patch("/profit-missions/:id/settings", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const body = req.body;
  if (!body || typeof body !== "object" || typeof (body as { settings?: unknown }).settings !== "object" || (body as { settings?: unknown }).settings === null) {
    res.status(400).json({ error: "settings object is required" });
    return;
  }
  const settings = (body as { settings: Record<string, unknown> }).settings;
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  const now = Date.now();
  const a = assess(row, now);
  const reason = readReason(body);
  const result = await applyMissionSettingsUpdate({
    userId,
    missionId: id,
    settings,
    message: reason ? `Mission settings updated. ${reason}` : "Mission settings updated.",
    snapshot: {
      math: a.math,
      feasibility: a.feasibility,
      probability: a.probability,
      currentValue: row.currentValue,
      status: row.status,
      asOf: new Date(now).toISOString(),
    },
  });
  if (!result.ok) {
    if (result.kind === "not_found") {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    res.status(409).json({ error: "Mission is in a terminal state and cannot be edited" });
    return;
  }
  res.json(serialize(result.row, assess(result.row, Date.now())));
});

// ── Journal events (append-only, paginated, user-scoped) ────────────────────
router.get("/profit-missions/:id/events", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  // Isolation: confirm the mission belongs to the caller BEFORE reading events.
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
  const events = await listMissionEvents(id, { limit, offset });
  res.json(events);
});

// ── Phase 3 — Multi-Agent Proposal System (advisory; analysis artifacts only) ─
//
// Phase 3 fallback reconstruction from Task #662 spec. These surfaces seed a
// mission's specialist agent team and expose the read-only proposals they
// scouted. ADVISORY ONLY — there is no draft, approval-to-execute, or order
// placement here, and nothing touches the instant-trade router / live pipeline /
// MT5 bridge. Every read/write is scoped by the owning user + mission.

function serializeAgent(row: MissionAgentRow) {
  return {
    id: row.id,
    missionId: row.missionId,
    agentKey: row.agentKey,
    registryAgentKey: row.registryAgentKey ?? null,
    name: row.name,
    role: row.role,
    status: row.status,
    rank: row.rank,
    weight: row.weight,
    performance: (row.performanceJson as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeProposal(row: MissionProposalRow) {
  const entry = (row.entryPlanJson as Record<string, unknown> | null) ?? {};
  const risk = (row.riskPlanJson as Record<string, unknown> | null) ?? {};
  const warnings = Array.isArray(row.warningsJson) ? (row.warningsJson as string[]) : [];
  return {
    id: row.id,
    proposalId: row.proposalId,
    missionId: row.missionId,
    missionAgentId: row.missionAgentId,
    agentKey: row.agentKey,
    symbol: row.symbol,
    timeframe: row.timeframe,
    direction: row.direction,
    setupType: row.setupType ?? null,
    confidence: row.confidence,
    urgency: row.urgency,
    entryPlan: {
      entryPrice: (entry.entryPrice as number | null) ?? null,
      entryZoneLow: (entry.entryZoneLow as number | null) ?? null,
      entryZoneHigh: (entry.entryZoneHigh as number | null) ?? null,
    },
    riskPlan: {
      stopLoss: (risk.stopLoss as number | null) ?? null,
      takeProfit: (risk.takeProfit as number | null) ?? null,
      riskAmount: (risk.riskAmount as number | null) ?? row.riskAmount ?? null,
      expectedR: (risk.expectedR as number | null) ?? row.expectedR ?? null,
    },
    marketSnapshot: (row.marketSnapshotJson as Record<string, unknown> | null) ?? null,
    warnings,
    reason: row.reason ?? null,
    invalidationLevel: row.invalidationLevel ?? null,
    status: row.status,
    selectionReason: row.selectionReason ?? null,
    rejectionReason: row.rejectionReason ?? null,
    riskObjection: row.riskObjection ?? null,
    judgeDecision: row.judgeDecision ?? null,
    createdAt: row.createdAt.toISOString(),
    edge: (row.edgeJson as Record<string, unknown> | null) ?? null,
    missionImpact: (row.missionImpactJson as Record<string, unknown> | null) ?? null,
    executionQuality: (row.executionQualityJson as Record<string, unknown> | null) ?? null,
  };
}

function serializeQueueEntry(r: RankedOpportunity) {
  return {
    proposalId: r.candidate.proposalId,
    agentKey: r.candidate.agentKey,
    symbol: r.candidate.symbol,
    timeframe: r.candidate.timeframe,
    direction: r.candidate.direction,
    edgeTier: r.candidate.edge?.tier ?? null,
    edgeScore: r.candidate.edge?.finalEdgeScore ?? null,
    rank: r.rank,
    riskAdjustedScore: r.riskAdjustedScore,
    missionFit: r.missionFit,
    actionable: r.actionable,
    opportunityCost: r.opportunityCost,
    reasons: r.reasons,
  };
}

function serializeQueue(q: OpportunityQueue) {
  return {
    decision: q.decision,
    best: q.best ? serializeQueueEntry(q.best) : null,
    queue: q.queue.map(serializeQueueEntry),
    waitReason: q.waitReason ?? null,
    bestAlternativeForgone: q.bestAlternativeForgone,
  };
}

// ── List a mission's agent team (seeds the team on first read) ───────────────
router.get("/profit-missions/:id/agents", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  // Idempotent: seed the team if it does not exist yet, then return it.
  const agents = await seedMissionTeam(id, userId);
  res.json(agents.map(serializeAgent));
});

// ── List a mission's structured proposals (newest first, paginated) ─────────
router.get("/profit-missions/:id/proposals", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
  const proposals = await listMissionProposals(id, userId, { limit, offset });
  res.json(proposals.map(serializeProposal));
});

// ── Run the mission's agents (advisory scan; honest-empty on no edge) ────────
router.post("/profit-missions/:id/scan", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  const settings = (row.settingsJson as Record<string, unknown> | null) ?? null;
  const result = await runMissionScan({ userId, missionId: id, settings });
  res.json({
    proposals: result.proposals.map(serializeProposal),
    selectedProposalId: result.selectedProposalId,
    judgeDecision: result.judgeDecision,
    judgeReason: result.judgeReason,
    liveFeedConnected: result.liveFeedConnected,
    symbolsScanned: result.symbolsScanned,
    queue: result.queue ? serializeQueue(result.queue) : null,
    missionImpact: result.missionImpact ?? null,
  });
});

// ── List a mission's reviewable trade drafts (newest first, paginated) ───────
// Approval artifacts only — NEVER an order. Expiry is enforced on read.
router.get("/profit-missions/:id/trade-drafts", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
  const drafts = await listTradeDrafts(userId, id, { limit, offset });
  res.json(drafts);
});

// Map a draft-service failure to an HTTP status + honest message.
function sendDraftFailure(res: import("express").Response, result: Extract<DraftServiceResult, { ok: false }>): void {
  if (result.kind === "not_found") {
    res.status(404).json({ error: "Mission or proposal not found" });
    return;
  }
  if (result.kind === "not_approvable") {
    res.status(409).json({ error: result.reason });
    return;
  }
  if (result.kind === "expired") {
    res.status(409).json({ error: "This draft has expired and can no longer be approved." });
    return;
  }
  res.status(409).json({ error: result.reason });
}

function readDecisionReason(body: unknown): string | null {
  if (body && typeof body === "object" && "reason" in body) {
    const r = (body as { reason?: unknown }).reason;
    if (typeof r === "string") return r;
  }
  return null;
}

// ── Approve a proposal's trade draft (approved record + journal; NO order) ───
router.post(
  "/profit-missions/:id/proposals/:proposalId/approve",
  requireUser,
  async (req, res): Promise<void> => {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    const proposalId = String(req.params.proposalId);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const row = await ownMission(userId, id);
    if (!row) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    const result = await approveProposalDraft({
      userId,
      missionId: id,
      proposalId,
      reason: readDecisionReason(req.body),
    });
    if (!result.ok) {
      sendDraftFailure(res, result);
      return;
    }
    res.json(projectDraft(result.draft, Date.now()));
  },
);

// ── Reject a proposal's trade draft (rejected record + journal) ──────────────
router.post(
  "/profit-missions/:id/proposals/:proposalId/reject",
  requireUser,
  async (req, res): Promise<void> => {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    const proposalId = String(req.params.proposalId);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const row = await ownMission(userId, id);
    if (!row) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    const result = await rejectProposalDraft({
      userId,
      missionId: id,
      proposalId,
      reason: readDecisionReason(req.body),
    });
    if (!result.ok) {
      sendDraftFailure(res, result);
      return;
    }
    res.json(projectDraft(result.draft, Date.now()));
  },
);

// ── Manage an OPEN mission trade's protective exit (routes via executeInstant) ─
//
// Phase 8. Decides the next protective exit action for an EXECUTED mission trade
// (partial close / break-even / trail / structure-news-target close / target
// adjust) from the pure Exit Manager Pro engine and routes the chosen action
// through the EXISTING instant-trade path (source "mission") → live pipeline →
// 18-gate dispatch. NONE → nothing is dispatched. Per-user / per-mission scoped.
function readExitSignals(body: unknown): MissionExitSignals | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as { signals?: unknown }).signals;
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const num = (v: unknown): number | null | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : v === null ? null : undefined;
  return {
    invalidation: bool(s.invalidation),
    agentDisagreement: bool(s.agentDisagreement),
    orderFlowReversal: bool(s.orderFlowReversal),
    highImpactNewsImminent: bool(s.highImpactNewsImminent),
    unstableSpread: bool(s.unstableSpread),
    structureBreak: bool(s.structureBreak),
    atr: num(s.atr),
    brokerSupportsPartialClose: bool(s.brokerSupportsPartialClose),
  };
}

router.post(
  "/profit-missions/:id/trade-drafts/:draftId/manage-exit",
  requireUser,
  async (req, res): Promise<void> => {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    const draftId = String(req.params.draftId);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const result = await manageMissionTradeExit({
      userId,
      missionId: id,
      draftId,
      signals: readExitSignals(req.body),
      ip: req.ip ?? null,
      ua: req.get("user-agent") ?? null,
    });
    if (result.ok) {
      res.json({
        ok: true,
        decision: result.decision,
        partialPlan: result.partialPlan,
        dispatched: result.dispatched,
        commandId: result.commandId ?? null,
        position: result.position,
      });
      return;
    }
    switch (result.kind) {
      case "mission_not_found":
        res.status(404).json({ error: "Mission not found" });
        return;
      case "draft_not_found":
        res.status(404).json({ error: "Mission trade not found" });
        return;
      case "not_executed":
        res.status(409).json({ error: `Mission trade is not executed (status: ${result.status}).` });
        return;
      case "manual_control":
        // Capability #44 — the owner has taken this position over; strategy
        // management is suspended until an explicit release.
        res.status(409).json({
          error: "Position is under manual control — automated management is suspended until you release it.",
          reason: "MANUAL_CONTROL_ACTIVE",
          brokerTicket: result.brokerTicket,
        });
        return;
      case "no_open_position":
        res.status(409).json({ error: "No open position is linked to this mission trade." });
        return;
      case "execution_rejected":
        res.status(422).json({
          error: result.error,
          primaryReason: result.primaryReason ?? null,
          decision: result.decision,
        });
        return;
      default:
        res.status(500).json({ error: "Unable to manage mission trade exit." });
    }
  },
);

// ── Emergency stop (user-triggered) — record emergency risk read + pause ─────
//
// Persists a user-triggered emergency risk read (journaled stricter-only) and,
// best-effort, transitions the mission to `paused` via the SAME state machine /
// journaling service as the manual pause action. Per-user scoped. Never executes.
router.post("/profit-missions/:id/emergency-stop", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  const now = Date.now();
  const risk = await refreshMissionRisk({
    userId,
    missionId: id,
    signals: { ...MISSION_RISK_SIGNALS, userEmergencyStop: true },
    nowMs: now,
  });
  let mission = row;
  if (isMissionStatus(row.status)) {
    const resolved = resolveUserAction(row.status, "pause");
    if (resolved.ok) {
      const a = assess(row, now);
      const reason = readReason(req.body);
      const result = await applyMissionTransition({
        userId,
        missionId: id,
        toStatus: resolved.resolved.to,
        eventType: resolved.resolved.eventType,
        message: reason
          ? `Emergency stop triggered by user — mission paused. ${reason}`
          : "Emergency stop triggered by user — mission paused.",
        metadata: { emergency: true, reason },
        snapshot: {
          math: a.math,
          feasibility: a.feasibility,
          probability: a.probability,
          currentValue: row.currentValue,
          status: resolved.resolved.to,
          asOf: new Date(now).toISOString(),
        },
      });
      if (result.ok) mission = result.row;
    }
  }
  res.json({
    ...serialize(mission, assess(mission, Date.now())),
    risk: risk.ok ? risk.state : null,
  });
});

// Map an execution-hook failure to an HTTP status + honest message.
export function sendDispatchFailure(
  res: import("express").Response,
  result: Extract<Awaited<ReturnType<typeof dispatchApprovedDraft>>, { ok: false }>,
): void {
  switch (result.kind) {
    case "mission_not_found":
    case "draft_not_found":
      res.status(404).json({ error: "Mission or approved draft not found" });
      return;
    case "not_approved":
      res.status(409).json({ error: "This draft must be approved before it can be executed." });
      return;
    case "expired":
      res.status(409).json({ error: "This draft has expired and can no longer be executed." });
      return;
    case "no_direction":
      res.status(409).json({ error: "This draft has no directional setup to execute." });
      return;
    case "mission_blocked":
      res.status(409).json({
        error: "Mission risk gate blocked this execution.",
        blockReasons: result.gate.blockReasons,
        decision: result.gate.decision,
      });
      return;
    case "phase7_blocked":
      res.status(409).json({
        error: "Execution-quality pre-checks blocked this execution.",
        blockReasons: result.phase7.blockReasons,
        warnings: result.phase7.warnings,
        health: result.phase7.health.reason,
        netProfit: result.phase7.netProfit.reason,
      });
      return;
    case "execution_rejected":
      res.status(result.httpStatus).json({ error: result.primaryReason ?? result.error });
      return;
  }
}

// ── Execute an approved draft (FIRST real-execution path; mission-gated) ─────
//
// Dispatches an already-approved draft into REAL execution exclusively via the
// instant-trade router (source "mission") → live pipeline → 18-gate dispatch.
// The additive, stricter-only mission gate runs first; demo/paper never touch the
// live broker. Per-user scoped; per-draft Level-2 approval still required.
router.post(
  "/profit-missions/:id/proposals/:proposalId/execute",
  requireUser,
  async (req, res): Promise<void> => {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    const proposalId = String(req.params.proposalId);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const row = await ownMission(userId, id);
    if (!row) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    const result = await dispatchApprovedDraft({
      userId,
      missionId: id,
      proposalId,
      ip: req.ip ?? null,
      ua: req.get("user-agent") ?? null,
      signals: MISSION_RISK_SIGNALS,
    });
    if (!result.ok) {
      sendDispatchFailure(res, result);
      return;
    }
    res.json({
      ok: true,
      commandId: result.commandId ?? null,
      executionMode: result.executionMode,
      draft: projectDraft(result.draft, Date.now()),
    });
  },
);

// ── Phase 9 — Testing Lab + promotion + certificate + briefing ──────────────
//
// SAFETY / SCOPE:
//   - All routes are per-user / per-mission scoped via ownMission(). Testing,
//     drift, promotion, certificate, and briefing are ADVISORY composition of the
//     pure engines over honest evidence — none of them place a trade, contact the
//     broker, or relax any live gate. Promotion is fail-closed; live auto requires
//     explicit enablement + an accepted certificate + the platform live gates.

function parseId(req: import("express").Request, res: import("express").Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return null;
  }
  return id;
}

// A user with no executed (real) mission trades is treated as new — stricter
// guardrail ceiling. Honest: derived from real executed drafts, never assumed.
async function resolveIsNewUser(userId: number): Promise<boolean> {
  const rows = await db
    .select({ id: missionTradeDraftsTable.id })
    .from(missionTradeDraftsTable)
    .where(and(eq(missionTradeDraftsTable.userId, userId), eq(missionTradeDraftsTable.status, "executed")))
    .limit(1);
  return rows.length === 0;
}

async function resolvePromotionContext(req: import("express").Request, userId: number): Promise<PromotionContext> {
  const role = normalizeProductRole((req.authUser as { role?: string } | undefined)?.role);
  return { role, isNewUser: await resolveIsNewUser(userId) };
}

function sendTestingFailure(res: import("express").Response, r: Extract<TestingLabResult, { ok: false }>): void {
  switch (r.kind) {
    case "not_found":
      res.status(404).json({ error: "Mission not found" });
      return;
    case "unknown_strategy":
      res.status(400).json({ error: "Unknown strategy", allowed: r.allowed });
      return;
    case "focus_blocked":
      res.status(409).json({ error: "Symbol is outside the ARX focus market", ...r.envelope });
      return;
  }
}

// ── Testing Lab — run backtest (historical/simulated, honestly labelled) ────
router.post("/profit-missions/:id/testing/backtest", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const strategyId = typeof b.strategyId === "string" ? b.strategyId : "";
  const symbol = typeof b.symbol === "string" ? b.symbol : "";
  const timeframe = typeof b.timeframe === "string" ? b.timeframe : "";
  if (!strategyId || !symbol || !timeframe) {
    res.status(400).json({ error: "strategyId, symbol and timeframe are required" });
    return;
  }
  const result = await runMissionBacktest({
    userId,
    missionId: id,
    strategyId,
    symbol,
    timeframe,
    candleCount: typeof b.candleCount === "number" ? b.candleCount : undefined,
    minConfidence: typeof b.minConfidence === "number" ? b.minConfidence : undefined,
  });
  if (!result.ok) {
    sendTestingFailure(res, result);
    return;
  }
  res.status(201).json(result.result);
});

// ── Testing Lab — aggregate forward result from real closed drafts ──────────
router.post("/profit-missions/:id/testing/forward", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await aggregateMissionForward({
    userId,
    missionId: id,
    strategyKey: typeof b.strategyKey === "string" ? b.strategyKey : undefined,
    symbol: typeof b.symbol === "string" ? b.symbol : undefined,
    timeframe: typeof b.timeframe === "string" ? b.timeframe : undefined,
  });
  if (!result.ok) {
    sendTestingFailure(res, result);
    return;
  }
  res.status(201).json(result.result);
});

// ── Testing Lab — list a mission's test results (newest first) ──────────────
router.get("/profit-missions/:id/testing", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  const limit = Number(req.query.limit);
  const results = await listMissionTestResults(userId, id, {
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  res.json({ results });
});

// ── Drift — evaluate + (fail-safe) demote/pause on SEVERE drift ─────────────
router.get("/profit-missions/:id/drift", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const result = await evaluateAndApplyDrift({
    userId,
    missionId: id,
    ip: req.ip ?? null,
    ua: req.get("user-agent") ?? null,
  });
  if (!result.ok && result.kind === "not_found") {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  if (!result.ok) {
    res.json({ drift: result.drift, demoted: false, promotionPaused: false, insufficientEvidence: true });
    return;
  }
  res.json({
    drift: result.drift,
    demoted: result.demoted,
    promotionPaused: result.promotionPaused,
    insufficientEvidence: false,
  });
});

// ── Promotion — read promotion status / gate checklist (advisory) ───────────
router.get("/profit-missions/:id/promotion", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const targetLevelRaw = Number(req.query.targetLevel);
  const ctx = await resolvePromotionContext(req, userId);
  const result = await resolveMissionPromotionStatus({
    userId,
    missionId: id,
    targetLevel: Number.isFinite(targetLevelRaw) ? targetLevelRaw : undefined,
    ctx,
  });
  if (!result.ok) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  res.json(result.status);
});

// ── Promotion — apply an automation-level change (fail-closed, audited) ─────
router.patch("/profit-missions/:id/automation-level", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const targetLevel = Number(b.level);
  if (!Number.isFinite(targetLevel)) {
    res.status(400).json({ error: "level is required" });
    return;
  }
  const ctx = await resolvePromotionContext(req, userId);
  const result = await applyMissionAutomationLevel({
    userId,
    missionId: id,
    targetLevel,
    ctx,
    enableLiveAuto: b.enableLiveAuto === true,
    ip: req.ip ?? null,
    ua: req.get("user-agent") ?? null,
  });
  if (!result.ok) {
    switch (result.kind) {
      case "not_found":
        res.status(404).json({ error: "Mission not found" });
        return;
      case "invalid_level":
        res.status(400).json({ error: "level must be an automation level 0–6" });
        return;
      case "explicit_enablement_required":
        res.status(409).json({
          error: "Live auto must be explicitly enabled and pass every promotion gate.",
          decision: result.decision,
        });
        return;
    }
  }
  res.json({
    applied: result.applied,
    level: result.level,
    liveAutoEnabled: result.liveAutoEnabled,
    decision: result.decision,
  });
});

// ── Execution mode — gated paper → demo → live lifecycle (fail-closed) ──────
//
// F-build. Upgrades are stepwise and explicitly confirmed; stepping to LIVE
// additionally requires the accepted Mission Risk Certificate + the platform
// live master switch (env AND db) + a live-capable automation level. Changing
// the mode never places a trade and never relaxes a gate — dispatch still runs
// the full gated path in every mode. Downgrades are always allowed.
router.patch("/profit-missions/:id/execution-mode", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ctx = await resolvePromotionContext(req, userId);
  const result = await applyMissionExecutionMode({
    userId,
    missionId: id,
    targetMode: b.mode,
    confirm: b.confirm === true,
    ctx,
    ip: req.ip ?? null,
    ua: req.get("user-agent") ?? null,
  });
  if (!result.ok) {
    switch (result.kind) {
      case "not_found":
        res.status(404).json({ error: "Mission not found" });
        return;
      case "invalid_mode":
        res.status(400).json({ error: "mode must be one of paper | demo | live" });
        return;
      case "terminal":
        res.status(409).json({ error: "Mission is in a terminal state and cannot change execution mode" });
        return;
      case "blocked":
        res.status(409).json({
          error: "Execution-mode change blocked.",
          blockReasons: result.blockReasons,
        });
        return;
    }
  }
  res.json({ applied: result.applied, executionMode: result.executionMode, reasons: result.reasons });
});

// ── Start — activate a drafted mission (state-machine moves only) ────────────
//
// Walks the mission through the legal draft → pending_approval → running edges
// via the SAME journaled transition service as pause/resume/cancel. Starting a
// mission places no trade: it only makes the mission eligible for the gated
// scan/draft/approve/dispatch loop (and, at auto levels, the driver's ticks —
// which re-check every gate at act time).
router.post("/profit-missions/:id/start", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const row = await ownMission(userId, id);
  if (!row) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  if (!isMissionStatus(row.status)) {
    res.status(409).json({ error: "Cannot start mission from an unrecognized state" });
    return;
  }
  if (row.status === "running") {
    res.json(serialize(row, assess(row, Date.now())));
    return;
  }
  const now = Date.now();
  const a = assess(row, now);
  const snapshot = {
    math: a.math,
    feasibility: a.feasibility,
    probability: a.probability,
    currentValue: row.currentValue,
    asOf: new Date(now).toISOString(),
  };
  // Legal path only: draft → pending_approval → running (each edge validated
  // by the state machine and journaled). paused → running uses the resume edge.
  const hops: Array<{ to: MissionStatus; message: string }> =
    row.status === "draft"
      ? [
          { to: "pending_approval", message: "Mission submitted for start." },
          { to: "running", message: "Mission started by user." },
        ]
      : [{ to: "running", message: "Mission started by user." }];
  let current = row;
  for (const hop of hops) {
    const result = await applyMissionTransition({
      userId,
      missionId: id,
      toStatus: hop.to,
      eventType: "status_changed",
      message: hop.message,
      snapshot: { ...snapshot, status: hop.to },
    });
    if (!result.ok) {
      res.status(409).json({ error: `Cannot start mission from state '${current.status}'` });
      return;
    }
    current = result.row;
  }
  res.json(serialize(current, assess(current, Date.now())));
});

// ── Certificate — fetch content (GET) / accept append-only (POST) ───────────
router.get("/profit-missions/:id/certificate", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const targetRaw = Number(req.query.targetAutomationLevel);
  const result = await buildMissionCertificate({
    userId,
    missionId: id,
    targetAutomationLevel: Number.isFinite(targetRaw) ? targetRaw : undefined,
  });
  if (!result.ok) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  res.json(result.content);
});

router.post("/profit-missions/:id/certificate", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await acceptMissionCertificate({
    userId,
    missionId: id,
    confirmed: b.confirmed,
    phrase: b.phrase,
    targetAutomationLevel: typeof b.targetAutomationLevel === "number" ? b.targetAutomationLevel : undefined,
    ip: req.ip ?? null,
    ua: req.get("user-agent") ?? null,
  });
  if (!result.ok) {
    if (result.kind === "not_found") {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    res.status(400).json({ error: result.reason });
    return;
  }
  res.status(201).json({ acceptedAt: result.acceptedAt, acceptanceCount: result.acceptanceCount });
});

// ── Briefing / EOD review / report (advisory, honest) ───────────────────────
router.get("/profit-missions/:id/briefing", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const result = await buildMissionDailyBriefing({ userId, missionId: id });
  if (!result.ok) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  res.json(result.briefing);
});

router.get("/profit-missions/:id/eod-review", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const result = await buildMissionEodReview({ userId, missionId: id });
  if (!result.ok) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  res.json(result.review);
});

router.get("/profit-missions/:id/report", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = parseId(req, res);
  if (id == null) return;
  const [report, learning] = await Promise.all([
    buildMissionReportForUser({ userId, missionId: id }),
    buildMissionLearningLoop({ userId, missionId: id }),
  ]);
  if (!report.ok) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  res.json({
    report: report.report,
    learning: learning.ok ? learning.learning : null,
  });
});

// ── Admin — redacted mission detail (role-audited, no secrets) ──────────────
router.get("/admin/profit-missions/:id", requireUser, async (req, res): Promise<void> => {
  const role = normalizeProductRole((req.authUser as { role?: string } | undefined)?.role);
  if (!isAdminProductRole(role)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const id = parseId(req, res);
  if (id == null) return;

  const rows = await db
    .select()
    .from(profitMissionsTable)
    .where(eq(profitMissionsTable.id, id))
    .limit(1);
  const mission = rows[0];
  if (!mission) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }

  // Audit the admin read.
  await db.insert(oneClickAuditTable).values({
    userId: req.authUser!.id,
    action: "ADMIN_MISSION_VIEW",
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
    metadata: JSON.stringify({ missionId: id, ownerUserId: mission.userId, role }),
  });

  const ownerUserId = mission.userId;
  const ctx: PromotionContext = { role: "ADMIN", isNewUser: false };
  const [testResults, promotion] = await Promise.all([
    listMissionTestResults(ownerUserId, id, { limit: 50 }),
    resolveMissionPromotionStatus({ userId: ownerUserId, missionId: id, ctx }),
  ]);

  const acceptanceJson = mission.certificateAcceptanceJson as { acceptances?: unknown[] } | null;
  res.json({
    mission: {
      id: mission.id,
      ownerUserId,
      status: mission.status,
      executionMode: mission.executionMode,
      automationLevel: mission.automationLevel,
      liveAutoEnabled: mission.liveAutoEnabled,
      riskProfile: mission.riskProfile,
      startingAmount: mission.startingAmount,
      targetAmount: mission.targetAmount,
      currentValue: mission.currentValue,
      certificateAcceptedAt: mission.certificateAcceptedAt?.toISOString() ?? null,
      certificateAcceptanceCount: Array.isArray(acceptanceJson?.acceptances)
        ? acceptanceJson!.acceptances!.length
        : 0,
      promotionJson: mission.promotionJson ?? null,
    },
    testResults,
    promotion: promotion.ok ? promotion.status : null,
  });
});

export default router;
