// Self-Trade AI — service layer (Task #211, Foundation).
//
// Persists + reads the agent fleet for the Control Room. Every mutation runs
// inside ONE db.transaction together with its self_trade_audit_log row
// (fail-closed). NO execution, lot sizing, broker dispatch, or any of the 16
// live gates live here — this phase stands up control surfaces only.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  selfTradeAgentsTable,
  selfTradeAgentSettingsTable,
  selfTradeAgentLedgerTable,
  selfTradeLedgerEntriesTable,
  selfTradeAllocationsTable,
  selfTradeKillSwitchesTable,
  selfTradeAuditLogTable,
  selfTradeAgentExecutionsTable,
  SELF_TRADE_PROFILE_TEMPLATES,
  type SelfTradeAgent,
  type SelfTradeAgentExecution,
  type SelfTradeProfileTemplate,
  type SelfTradeKillScope,
} from "@workspace/db";
import { getProfileSpec } from "./profiles.js";
import { writeSelfTradeAudit } from "./audit.js";
import { enforceSensitiveAction } from "../security/handshake.js";
import { mirrorCriticalEvent } from "../security/events.js";

export interface Actor {
  userId: number;
  role: string;
}

export interface ServiceResult<T> {
  ok: boolean;
  error?: string;
  message?: string;
  data?: T;
}

function slugifyKey(name: string, template: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${template.toLowerCase()}-${base || "agent"}-${suffix}`;
}

// ── Create an agent from a profile template ─────────────────────────────────
export interface CreateFromTemplateInput {
  template: SelfTradeProfileTemplate;
  name: string;
  reason: string;
  description?: string | null;
  ownerType?: "OPERATOR_FLEET" | "USER";
  ownerId?: number | null;
}

export async function createAgentFromTemplate(
  input: CreateFromTemplateInput,
  actor: Actor,
): Promise<ServiceResult<{ agent: SelfTradeAgent }>> {
  if (!SELF_TRADE_PROFILE_TEMPLATES.includes(input.template)) {
    return { ok: false, error: "INVALID_TEMPLATE", message: "Unknown profile template." };
  }
  const spec = getProfileSpec(input.template);
  const ownerType = input.ownerType ?? "OPERATOR_FLEET";
  if (ownerType === "USER" && !input.ownerId) {
    return { ok: false, error: "OWNER_ID_REQUIRED", message: "USER agents require an ownerId." };
  }

  return db.transaction(async (tx) => {
    const agentKey = slugifyKey(input.name, input.template);
    const inserted = await tx.insert(selfTradeAgentsTable).values({
      agentKey,
      name: input.name.trim(),
      profileTemplate: input.template,
      description: input.description ?? null,
      ownerType,
      ownerId: ownerType === "USER" ? (input.ownerId ?? null) : null,
      status: "UNFUNDED",
      autonomyLevel: spec.defaultAutonomyLevel,
      mode: "SHADOW",
      createdByUserId: actor.userId,
    }).returning();
    const agent = inserted[0];

    await tx.insert(selfTradeAgentSettingsTable).values({
      agentId: agent.id,
      riskPerTradePct: spec.riskPerTradePct,
      maxLotPerTrade: spec.maxLotPerTrade,
      maxConcurrentPositions: spec.maxConcurrentPositions,
      maxDailyLossUsd: spec.maxDailyLossUsd,
      maxWeeklyLossUsd: spec.maxWeeklyLossUsd,
      dailyProfitGoalUsd: spec.dailyProfitGoalUsd,
      weeklyProfitGoalUsd: spec.weeklyProfitGoalUsd,
      dailyMinTrades: spec.dailyMinTrades,
      baseMaxTrades: spec.baseMaxTrades,
      extensionEnabled: spec.extensionEnabled,
      extensionMaxTrades: spec.extensionMaxTrades,
      allowedSymbols: spec.allowedSymbols,
      allowedSessions: spec.allowedSessions,
      allowedStrategies: spec.allowedStrategies,
      newsTradingPermission: spec.newsTradingPermission,
      requireStopLoss: spec.requireStopLoss,
      updatedByUserId: actor.userId,
    });

    await tx.insert(selfTradeAgentLedgerTable).values({ agentId: agent.id });

    await writeSelfTradeAudit(tx, {
      agentId: agent.id,
      eventType: "CREATE_AGENT",
      actorUserId: actor.userId,
      actorRole: actor.role,
      severity: "INFO",
      afterState: { agentKey, template: input.template, ownerType },
      reason: input.reason.trim(),
    });

    return { ok: true, data: { agent } };
  });
}

// ── Configure settings ──────────────────────────────────────────────────────
export type ConfigurablePatch = Partial<{
  riskPerTradePct: number;
  maxLotPerTrade: number;
  maxConcurrentPositions: number;
  maxDailyLossUsd: number;
  maxWeeklyLossUsd: number;
  dailyProfitGoalUsd: number;
  weeklyProfitGoalUsd: number;
  dailyMinTrades: number;
  baseMaxTrades: number;
  extensionEnabled: boolean;
  extensionMaxTrades: number;
  allowedSymbols: string[];
  allowedSessions: string[];
  allowedStrategies: string[];
  newsTradingPermission: "BLOCK" | "CAUTION" | "ALLOW";
  requireStopLoss: boolean;
}>;

export async function configureAgent(
  agentId: number,
  patch: ConfigurablePatch,
  reason: string,
  actor: Actor,
): Promise<ServiceResult<{ agentId: number }>> {
  // AACI Security handshake (Phase 2) — advisory-additive. Map the riskiest
  // permission the patch touches to a sensitive action.
  const hsAction =
    patch.newsTradingPermission === "ALLOW"
      ? "ENABLE_NEWS_TRADING"
      : patch.baseMaxTrades !== undefined || patch.extensionMaxTrades !== undefined
        ? "INCREASE_MAX_LOT"
        : "CHANGE_AUTONOMY";
  const hs = await enforceSensitiveAction(hsAction, {
    userId: actor.userId, role: actor.role, authenticated: true,
  });
  if (!hs.ok) return { ok: false, error: hs.reasonCode, message: hs.userMessage };
  return db.transaction(async (tx) => {
    const before = await tx
      .select()
      .from(selfTradeAgentSettingsTable)
      .where(eq(selfTradeAgentSettingsTable.agentId, agentId))
      .limit(1);
    if (!before[0]) {
      return { ok: false, error: "AGENT_NOT_FOUND", message: "Agent settings not found." };
    }
    const updated = await tx
      .update(selfTradeAgentSettingsTable)
      .set({ ...patch, updatedByUserId: actor.userId, updatedAt: new Date() })
      .where(eq(selfTradeAgentSettingsTable.agentId, agentId))
      .returning();

    await writeSelfTradeAudit(tx, {
      agentId,
      eventType: "SET_CONFIG",
      actorUserId: actor.userId,
      actorRole: actor.role,
      severity: "INFO",
      beforeState: before[0],
      afterState: updated[0],
      reason,
    });
    return { ok: true, data: { agentId } };
  });
}

// ── Autonomy level (L0–L4) ──────────────────────────────────────────────────
export async function setAutonomyLevel(
  agentId: number,
  level: number,
  reason: string,
  actor: Actor,
): Promise<ServiceResult<{ agentId: number; autonomyLevel: number }>> {
  if (!Number.isInteger(level) || level < 0 || level > 4) {
    return { ok: false, error: "INVALID_LEVEL", message: "Autonomy level must be 0–4." };
  }
  const hs = await enforceSensitiveAction("CHANGE_AUTONOMY", {
    userId: actor.userId, role: actor.role, authenticated: true,
  });
  if (!hs.ok) return { ok: false, error: hs.reasonCode, message: hs.userMessage };
  const result = await db.transaction(async (tx) => {
    const before = await tx
      .select()
      .from(selfTradeAgentsTable)
      .where(eq(selfTradeAgentsTable.id, agentId))
      .limit(1);
    if (!before[0]) return { ok: false, error: "AGENT_NOT_FOUND", message: "Agent not found." };

    await tx
      .update(selfTradeAgentsTable)
      .set({ autonomyLevel: level, updatedAt: new Date() })
      .where(eq(selfTradeAgentsTable.id, agentId));

    await writeSelfTradeAudit(tx, {
      agentId,
      eventType: "SET_AUTONOMY",
      actorUserId: actor.userId,
      actorRole: actor.role,
      severity: level >= 3 ? "WARNING" : "INFO",
      beforeState: { autonomyLevel: before[0].autonomyLevel },
      afterState: { autonomyLevel: level },
      reason,
    });
    return { ok: true, data: { agentId, autonomyLevel: level } };
  });
  // Tamper-evident mirror — best-effort, runs AFTER commit on its own
  // connection so a chain failure can never roll back the autonomy change.
  if (result.ok) {
    await mirrorCriticalEvent({
      eventType: "AUTONOMY_CHANGE", severity: level >= 3 ? "HIGH" : "INFO", status: "ALLOWED",
      actorUserId: actor.userId, actorRole: actor.role, actorType: actor.role,
      affectedObject: `self_trade_agents:${agentId}`,
      message: `Agent autonomy set to L${level}`, metadata: { agentId, autonomyLevel: level, reason },
    });
  }
  return result;
}

// ── Status transitions (no execution; bookkeeping + audit only) ─────────────
const STATUS_TRANSITIONS: Record<string, string[]> = {
  UNFUNDED: ["ARCHIVED"],
  FUNDED_IDLE: ["ACTIVE", "STOPPED", "ARCHIVED"],
  ACTIVE: ["PAUSED", "STOPPED"],
  PAUSED: ["ACTIVE", "STOPPED"],
  STOPPED: ["FUNDED_IDLE", "ARCHIVED"],
  ARCHIVED: [],
};

export async function setAgentStatus(
  agentId: number,
  next: SelfTradeAgent["status"],
  reason: string,
  actor: Actor,
): Promise<ServiceResult<{ agentId: number; status: string }>> {
  // Activating an agent enables autonomous execution — gate it. Pausing /
  // stopping / archiving are protective and never consulted.
  if (next === "ACTIVE") {
    const hs = await enforceSensitiveAction("ENABLE_LIVE_AUTONOMOUS", {
      userId: actor.userId, role: actor.role, authenticated: true,
    });
    if (!hs.ok) return { ok: false, error: hs.reasonCode, message: hs.userMessage };
  }
  const result = await db.transaction(async (tx) => {
    const before = await tx
      .select()
      .from(selfTradeAgentsTable)
      .where(eq(selfTradeAgentsTable.id, agentId))
      .limit(1);
    const agent = before[0];
    if (!agent) return { ok: false, error: "AGENT_NOT_FOUND", message: "Agent not found." };

    const allowed = STATUS_TRANSITIONS[agent.status] ?? [];
    if (agent.status !== next && !allowed.includes(next)) {
      return {
        ok: false,
        error: "INVALID_TRANSITION",
        message: `Cannot move ${agent.status} → ${next}.`,
      };
    }

    // Funding invariant: an unfunded agent can never be activated for trading.
    // (Re-checked here even though STATUS_TRANSITIONS gates UNFUNDED out of the
    // ACTIVE path — funds can drain to zero while in FUNDED_IDLE/PAUSED.)
    if (next === "ACTIVE") {
      const ledgerRows = await tx
        .select()
        .from(selfTradeAgentLedgerTable)
        .where(eq(selfTradeAgentLedgerTable.agentId, agentId))
        .limit(1);
      const available = ledgerRows[0]?.availableFunds ?? 0;
      const allocated = ledgerRows[0]?.allocatedFunds ?? 0;
      if (!(available > 0) && !(allocated > 0)) {
        return {
          ok: false,
          error: "AGENT_UNFUNDED",
          message: "An unfunded agent cannot be activated. Fund it first.",
        };
      }
    }

    const now = new Date();
    const timestamps: Partial<typeof selfTradeAgentsTable.$inferInsert> = {};
    if (next === "ACTIVE") timestamps.startedAt = now;
    if (next === "PAUSED") timestamps.pausedAt = now;
    if (next === "STOPPED") timestamps.stoppedAt = now;
    if (next === "ARCHIVED") timestamps.archivedAt = now;

    await tx
      .update(selfTradeAgentsTable)
      .set({ status: next, updatedAt: now, ...timestamps })
      .where(eq(selfTradeAgentsTable.id, agentId));

    await writeSelfTradeAudit(tx, {
      agentId,
      eventType: "SET_STATUS",
      actorUserId: actor.userId,
      actorRole: actor.role,
      severity: next === "STOPPED" ? "WARNING" : "INFO",
      beforeState: { status: agent.status },
      afterState: { status: next },
      reason,
    });
    return { ok: true, data: { agentId, status: next, from: agent.status } };
  });
  // Tamper-evident mirror for pause/resume transitions — best-effort, post-commit.
  if (result.ok && result.data && (next === "PAUSED" || next === "ACTIVE")) {
    await mirrorCriticalEvent({
      eventType: "AGENT_PAUSE_RESUME", severity: next === "ACTIVE" ? "HIGH" : "INFO", status: "ALLOWED",
      actorUserId: actor.userId, actorRole: actor.role, actorType: actor.role,
      affectedObject: `self_trade_agents:${agentId}`,
      message: `Agent ${next === "ACTIVE" ? "resumed/activated" : "paused"}`,
      metadata: { agentId, from: result.data.from, to: next, reason },
    });
  }
  return result;
}

// ── Kill switches (engage / release) ────────────────────────────────────────
export async function toggleKillSwitch(
  scope: SelfTradeKillScope,
  scopeRef: string | null,
  engaged: boolean,
  reason: string,
  actor: Actor,
): Promise<ServiceResult<{ scope: string; scopeRef: string | null; engaged: boolean }>> {
  // RELEASING a kill switch (resuming trading) is the sensitive direction.
  // Engaging is always allowed (fail-closed). If the release is BLOCKed the
  // switch simply stays engaged — the safe outcome.
  if (!engaged) {
    const hs = await enforceSensitiveAction("DISABLE_KILL_SWITCH", {
      userId: actor.userId, role: actor.role, authenticated: true,
    });
    if (!hs.ok) return { ok: false, error: hs.reasonCode, message: hs.userMessage };
  }
  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(selfTradeKillSwitchesTable)
      .where(and(
        eq(selfTradeKillSwitchesTable.scope, scope),
        scopeRef === null
          ? sql`${selfTradeKillSwitchesTable.scopeRef} is null`
          : eq(selfTradeKillSwitchesTable.scopeRef, scopeRef),
      ))
      .limit(1);

    const now = new Date();
    const before = existing[0] ?? null;
    if (before) {
      await tx
        .update(selfTradeKillSwitchesTable)
        .set({
          engaged,
          reason,
          engagedByUserId: engaged ? actor.userId : before.engagedByUserId,
          engagedAt: engaged ? now : before.engagedAt,
          releasedByUserId: engaged ? before.releasedByUserId : actor.userId,
          releasedAt: engaged ? before.releasedAt : now,
          updatedAt: now,
        })
        .where(eq(selfTradeKillSwitchesTable.id, before.id));
    } else {
      await tx.insert(selfTradeKillSwitchesTable).values({
        scope,
        scopeRef,
        engaged,
        reason,
        engagedByUserId: engaged ? actor.userId : null,
        engagedAt: engaged ? now : null,
        releasedByUserId: engaged ? null : actor.userId,
        releasedAt: engaged ? null : now,
      });
    }

    await writeSelfTradeAudit(tx, {
      eventType: engaged ? "KILL_ENGAGE" : "KILL_RELEASE",
      scope,
      actorUserId: actor.userId,
      actorRole: actor.role,
      severity: engaged ? "CRITICAL" : "WARNING",
      beforeState: before ? { engaged: before.engaged } : { engaged: false },
      afterState: { scope, scopeRef, engaged },
      reason,
    });
    return { ok: true, data: { scope, scopeRef, engaged } };
  });
  // Tamper-evident mirror — best-effort, post-commit. Engage is a CRITICAL
  // safety event; release re-enables trading and is HIGH.
  if (result.ok) {
    await mirrorCriticalEvent({
      eventType: "KILL_SWITCH_CHANGE", severity: engaged ? "CRITICAL" : "HIGH", status: "ALLOWED",
      actorUserId: actor.userId, actorRole: actor.role, actorType: actor.role,
      affectedObject: `self_trade_kill_switch:${scope}:${scopeRef ?? "GLOBAL"}`,
      message: engaged ? "Kill switch engaged" : "Kill switch released",
      metadata: { scope, scopeRef, engaged, reason },
    });
  }
  return result;
}

// ── Reads ───────────────────────────────────────────────────────────────────
export interface AgentScope {
  ownerType?: "OPERATOR_FLEET" | "USER";
  ownerId?: number | null;
}

function scopeWhere(scope?: AgentScope) {
  if (!scope) return undefined;
  if (scope.ownerType === "USER" && scope.ownerId != null) {
    return and(
      eq(selfTradeAgentsTable.ownerType, "USER"),
      eq(selfTradeAgentsTable.ownerId, scope.ownerId),
    );
  }
  if (scope.ownerType === "OPERATOR_FLEET") {
    return eq(selfTradeAgentsTable.ownerType, "OPERATOR_FLEET");
  }
  return undefined;
}

export async function listAgents(scope?: AgentScope): Promise<SelfTradeAgent[]> {
  const where = scopeWhere(scope);
  const q = db.select().from(selfTradeAgentsTable);
  const rows = where ? await q.where(where) : await q;
  return rows.sort((a, b) => b.id - a.id);
}

export async function getAgentById(agentId: number, scope?: AgentScope) {
  const rows = await db
    .select()
    .from(selfTradeAgentsTable)
    .where(eq(selfTradeAgentsTable.id, agentId))
    .limit(1);
  const agent = rows[0];
  if (!agent) return null;
  if (scope?.ownerType === "USER") {
    if (agent.ownerType !== "USER" || agent.ownerId !== scope.ownerId) return null;
  }
  const [settings, ledger] = await Promise.all([
    db.select().from(selfTradeAgentSettingsTable)
      .where(eq(selfTradeAgentSettingsTable.agentId, agentId)).limit(1),
    db.select().from(selfTradeAgentLedgerTable)
      .where(eq(selfTradeAgentLedgerTable.agentId, agentId)).limit(1),
  ]);
  return { agent, settings: settings[0] ?? null, ledger: ledger[0] ?? null };
}

export async function listLedgerEntries(agentId: number, limit = 100) {
  return db
    .select()
    .from(selfTradeLedgerEntriesTable)
    .where(eq(selfTradeLedgerEntriesTable.agentId, agentId))
    .orderBy(desc(selfTradeLedgerEntriesTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

export async function listAllocations(agentId?: number) {
  const q = db.select().from(selfTradeAllocationsTable);
  const rows = agentId
    ? await q.where(eq(selfTradeAllocationsTable.agentId, agentId))
    : await q;
  return rows.sort((a, b) => b.id - a.id);
}

export async function listKillSwitches() {
  return db.select().from(selfTradeKillSwitchesTable);
}

export async function listAuditLog(agentId?: number, limit = 100) {
  const q = db.select().from(selfTradeAuditLogTable);
  const rows = agentId
    ? await q.where(eq(selfTradeAuditLogTable.agentId, agentId))
        .orderBy(desc(selfTradeAuditLogTable.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500))
    : await q.orderBy(desc(selfTradeAuditLogTable.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500));
  return rows;
}

// Owner-isolated list of REAL autonomous execution rows. A non-admin caller
// passes a USER scope; we restrict to the agents visible to them so user A can
// never see user B's executions. honest dispatch≠fill: status carries the true
// lifecycle (DISPATCHED ≠ FILLED).
export async function listAgentExecutions(
  scope: AgentScope | undefined,
  agentId?: number,
  limit = 100,
): Promise<SelfTradeAgentExecution[]> {
  const capped = Math.min(Math.max(limit, 1), 500);

  // Resolve the agent ids visible to the caller.
  const visible = await listAgents(scope);
  const visibleIds = new Set(visible.map((a) => a.id));
  if (scope && visibleIds.size === 0) return [];

  let ids: number[] | null = scope ? [...visibleIds] : null;
  if (agentId != null) {
    if (scope && !visibleIds.has(agentId)) return [];
    ids = [agentId];
  }

  const q = db.select().from(selfTradeAgentExecutionsTable);
  const rows = ids
    ? await q
        .where(inArray(selfTradeAgentExecutionsTable.agentId, ids))
        .orderBy(desc(selfTradeAgentExecutionsTable.id))
        .limit(capped)
    : await q.orderBy(desc(selfTradeAgentExecutionsTable.id)).limit(capped);
  return rows;
}

// Fleet overview roll-up for the control room Overview tab.
export async function getFleetOverview(scope?: AgentScope) {
  const agents = await listAgents(scope);
  const ids = agents.map((a) => a.id);
  const ledgers = ids.length
    ? await db.select().from(selfTradeAgentLedgerTable)
        .where(inArray(selfTradeAgentLedgerTable.agentId, ids))
    : [];
  const totalAllocated = ledgers.reduce((s, l) => s + l.allocatedFunds, 0);
  const totalAvailable = ledgers.reduce((s, l) => s + l.availableFunds, 0);
  const totalRealizedPnl = ledgers.reduce((s, l) => s + l.realizedPnl, 0);
  const totalOpenPnl = ledgers.reduce((s, l) => s + l.openPnl, 0);

  const byStatus: Record<string, number> = {};
  for (const a of agents) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  return {
    totalAgents: agents.length,
    activeAgents: agents.filter((a) => a.status === "ACTIVE").length,
    fundedAgents: ledgers.filter((l) => l.allocatedFunds > 0).length,
    byStatus,
    totalAllocated,
    totalAvailable,
    totalRealizedPnl,
    totalOpenPnl,
  };
}
