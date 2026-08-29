// ── Profit Mission Phase 8 — Exit Manager, Profit Locks & Compounding service ──
//
// SAFETY / SCOPE:
//   - This service COMPOSES the five pure Phase 8 domain engines (Exit Manager
//     Pro, Partial Profit Plan, Profit Milestones, Missed-Profit, Controlled
//     Compounding) with honest live state read from the EXISTING seams (the
//     per-user open `arx_live_positions`, the executed mission drafts, the MFE
//     tracker, the mission risk read). It is PROTECTIVE / SIZING / DISPLAY only.
//   - EVERY exit action routes EXCLUSIVELY through the existing instant-trade
//     router (`executeInstant`, source "mission") → live command pipeline →
//     18-gate dispatch — exactly like a manual close/modify. There is NO new
//     execution path; nothing here can place, add, or relax a gate. The executor
//     is injectable ONLY so tests can substitute a spy.
//   - Compounding uses REALISED CLOSED PROFIT ONLY (sum of closed-draft P/L),
//     never floating P/L; it can never activate during drawdown, after a single
//     win, or when the Risk Governor / user has not permitted it (the pure engine
//     enforces all of this — this service only resolves honest inputs).
//   - Per-user / per-mission isolation: every read/write is scoped by (userId)
//     and (missionId); open positions are read ONLY from rows owned by the user.
//   - Honest degradation: unknown inputs never fabricate an exit, a milestone, or
//     a compounding boost — they fail toward LESS risk / MORE protection.
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionTradeDraftsTable,
  missionEventsTable,
  oneClickAuditTable,
  arxLivePositionsTable,
  type MissionTradeDraftRow,
} from "@workspace/db";
import {
  decideExit,
  buildPartialPlan,
  evaluateMilestones,
  analyseMissedProfit,
  evaluateCompounding,
  type ExitDecision,
  type PartialPlan,
  type MilestoneVerdict,
  type MissedProfitVerdict,
  type CompoundingVerdict,
  type CompoundingMode,
  type MissionMode,
} from "@workspace/domain/profit-mission";
import {
  executeInstant,
  type InstantTradeIntent,
  type InstantTradeResult,
} from "./live/instantTrade.js";
import type { MissionExecutor } from "./missionExecution.js";
import {
  refreshMissionRisk,
  type MissionLiveSignals,
  type MissionRiskState,
} from "./missionRiskService.js";
import { getRunning } from "./intelligence/mfeTracker.js";

type MissionRow = typeof profitMissionsTable.$inferSelect;

// Timeframes treated as scalps (protect winners faster). Mirrors the Phase 7
// service's classification so exit cadence is consistent across the codebase.
const SCALP_TIMEFRAMES = new Set(["S1", "S5", "S15", "S30", "M1", "M2", "M3", "M5"]);

function isScalpTimeframe(timeframe: string | null | undefined): boolean {
  return timeframe != null && SCALP_TIMEFRAMES.has(timeframe.trim().toUpperCase());
}

function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function boolOrDefault(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}

// ── Honest settings / progress readers (defensive, never fabricated) ──────────

interface CompoundingSettings {
  enabled: boolean;
  mode: CompoundingMode;
  reinvestFraction: number | null;
}
interface ProtectionSettings {
  givebackThreshold: number | null;
  dailyProfitGoal: number | null;
  continueAfterTarget: boolean;
}

const VALID_COMPOUNDING_MODES: ReadonlySet<string> = new Set([
  "off",
  "conservative",
  "balanced",
  "aggressive",
]);

function readCompoundingSettings(mission: MissionRow): CompoundingSettings {
  const settings = asRecord(mission.settingsJson);
  const c = asRecord(settings.compounding);
  const rawMode = typeof c.mode === "string" ? c.mode : "off";
  const mode = (VALID_COMPOUNDING_MODES.has(rawMode) ? rawMode : "off") as CompoundingMode;
  return {
    // Compounding is OFF unless the user explicitly enabled it AND picked a mode.
    enabled: c.enabled === true && mode !== "off",
    mode,
    reinvestFraction: numOrNull(c.reinvestFraction),
  };
}

function readProtectionSettings(mission: MissionRow): ProtectionSettings {
  const settings = asRecord(mission.settingsJson);
  const p = asRecord(settings.protection);
  return {
    givebackThreshold: numOrNull(p.givebackThreshold),
    dailyProfitGoal: numOrNull(p.dailyProfitGoal),
    continueAfterTarget: p.continueAfterTarget === true,
  };
}

/** Read the prior persisted peak realised profit from progressJson (carry forward). */
function readPriorPeakRealised(mission: MissionRow): number | null {
  const progress = asRecord(mission.progressJson);
  const protection = asRecord(progress.protection);
  return numOrNull(protection.peakRealisedProfit);
}

// ── Realised (closed) profit statistics — REALISED ONLY, never floating ───────

export interface MissionRealisedStats {
  /** Sum of realised P/L across CLOSED mission drafts (account currency). */
  realisedProfit: number;
  /** Realised P/L closed since the start of the current UTC day. */
  realisedProfitToday: number;
  /** Count of CLOSED realised mission trades (drives the "not one win" rule). */
  realisedTradeCount: number;
}

function startOfUtcDayMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Resolve a mission's REALISED closed-profit statistics from its executed,
 * closed drafts (per-user / per-mission). Floating P/L is never read here — only
 * a draft that has a `closedAt` and a finite `pnl` contributes.
 */
export async function resolveMissionRealisedStats(args: {
  userId: number;
  missionId: number;
  nowMs?: number;
}): Promise<MissionRealisedStats> {
  const nowMs = args.nowMs ?? Date.now();
  const rows = await db
    .select({
      pnl: missionTradeDraftsTable.pnl,
      closedAt: missionTradeDraftsTable.closedAt,
    })
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, args.missionId),
        eq(missionTradeDraftsTable.userId, args.userId),
        eq(missionTradeDraftsTable.status, "executed"),
      ),
    );

  const dayStart = startOfUtcDayMs(nowMs);
  let realisedProfit = 0;
  let realisedProfitToday = 0;
  let realisedTradeCount = 0;
  for (const r of rows) {
    if (r.closedAt == null || !isNum(r.pnl)) continue; // only CLOSED, realised rows
    realisedTradeCount += 1;
    realisedProfit += r.pnl;
    if (r.closedAt.getTime() >= dayStart) realisedProfitToday += r.pnl;
  }
  return {
    realisedProfit: round2(realisedProfit),
    realisedProfitToday: round2(realisedProfitToday),
    realisedTradeCount,
  };
}

// ── Controlled compounding (REALISED-only, never during drawdown) ─────────────

export interface MissionCompoundingState extends CompoundingVerdict {
  mode: CompoundingMode;
  /** Echoed for transparency in the pulse/report surfaces. */
  realisedProfit: number;
  realisedTradeCount: number;
  drawdownPct: number | null;
  governorMode: MissionMode;
}

/**
 * Resolve a mission's controlled-compounding state by composing the pure engine
 * with honest realised stats + the persisted risk read. Used both by draft
 * sizing (T008) and the pulse surface. The multiplier defaults to exactly 1 (no
 * boost) whenever any safety gate fails — in particular during ANY drawdown.
 */
export async function resolveMissionCompounding(args: {
  userId: number;
  mission: MissionRow;
  /** Optional pre-resolved realised stats (avoids a duplicate query). */
  realised?: MissionRealisedStats;
  /** Optional fresh risk state; falls back to the persisted `riskJson`. */
  riskState?: MissionRiskState | null;
  nowMs?: number;
}): Promise<MissionCompoundingState> {
  const nowMs = args.nowMs ?? Date.now();
  const realised =
    args.realised ??
    (await resolveMissionRealisedStats({
      userId: args.userId,
      missionId: args.mission.id,
      nowMs,
    }));

  // Drawdown + governor mode come from the risk read. When unknown we fail
  // CLOSED: an unknown governor mode defaults to "protect" (which the engine
  // refuses to compound under), so a missing risk read never enables a boost.
  const persisted = args.riskState ?? ((args.mission.riskJson as MissionRiskState | null) ?? null);
  const drawdownPct =
    persisted && typeof persisted.drawdownPct === "number" ? persisted.drawdownPct : null;
  const governorMode: MissionMode =
    persisted && typeof persisted.mode === "string" ? persisted.mode : "protect";

  const cfg = readCompoundingSettings(args.mission);
  const baseCapital =
    args.mission.currentValue > 0 ? args.mission.currentValue : args.mission.startingAmount;

  const verdict = evaluateCompounding({
    mode: cfg.mode,
    userAllowed: cfg.enabled,
    realisedProfit: realised.realisedProfit,
    realisedTradeCount: realised.realisedTradeCount,
    drawdownPct,
    governorMode,
    // Agent health is advisory; default healthy unless a risk read says otherwise.
    agentsHealthy: true,
    reinvestFraction: cfg.reinvestFraction,
    baseCapital: baseCapital > 0 ? baseCapital : null,
  });

  return {
    ...verdict,
    mode: cfg.mode,
    realisedProfit: realised.realisedProfit,
    realisedTradeCount: realised.realisedTradeCount,
    drawdownPct,
    governorMode,
  };
}

// ── Profit milestones / protection ladder / giveback / daily-goal ─────────────

export interface MissionMilestoneState extends MilestoneVerdict {
  /** Peak realised profit carried forward + updated this evaluation. */
  peakRealisedProfit: number;
  realisedProfit: number;
}

/**
 * Resolve a mission's milestone / protection-ladder / giveback / daily-goal read
 * by composing the pure engine with honest realised stats + the persisted peak.
 * Pure w.r.t. its inputs (no write) — persistence happens in
 * {@link refreshMissionProtection}.
 */
export async function resolveMissionMilestones(args: {
  userId: number;
  mission: MissionRow;
  realised?: MissionRealisedStats;
  nowMs?: number;
}): Promise<MissionMilestoneState> {
  const nowMs = args.nowMs ?? Date.now();
  const realised =
    args.realised ??
    (await resolveMissionRealisedStats({
      userId: args.userId,
      missionId: args.mission.id,
      nowMs,
    }));
  const protection = readProtectionSettings(args.mission);
  const priorPeak = readPriorPeakRealised(args.mission);
  const peakRealisedProfit = Math.max(priorPeak ?? 0, realised.realisedProfit);

  const verdict = evaluateMilestones({
    requiredProfit: args.mission.requiredProfit,
    realisedProfit: realised.realisedProfit,
    peakRealisedProfit,
    realisedProfitToday: realised.realisedProfitToday,
    dailyProfitGoal: protection.dailyProfitGoal,
    givebackThreshold: protection.givebackThreshold,
    continueAfterTarget: protection.continueAfterTarget,
  });

  return {
    ...verdict,
    peakRealisedProfit: round2(peakRealisedProfit),
    realisedProfit: realised.realisedProfit,
  };
}

// ── Persisted protection surface (progressJson) + journal + target lock ───────

export interface MissionProtectionSnapshot {
  milestone: MissionMilestoneState;
  compounding: MissionCompoundingState;
  /** True when the mission was flipped to `completed` (target stop+lock). */
  missionCompleted: boolean;
}

async function journalMissionEvent(args: {
  missionId: number;
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(missionEventsTable).values({
    missionId: args.missionId,
    type: args.type,
    message: args.message,
    metadataJson: args.metadata ?? null,
  });
}

async function auditMission(args: {
  userId: number;
  action: string;
  ip?: string | null;
  ua?: string | null;
  metadata?: unknown;
}): Promise<void> {
  await db.insert(oneClickAuditTable).values({
    userId: args.userId,
    action: args.action,
    ip: args.ip ?? null,
    userAgent: args.ua ?? null,
    metadata: args.metadata != null ? JSON.stringify(args.metadata) : null,
  });
}

/**
 * Recompute a mission's protection (milestones/lock/giveback) + compounding state
 * and persist it into `profit_missions.progressJson` (MERGED — every existing key
 * is preserved). Journals a milestone advance, a giveback-protect switch, and a
 * target lock; at 100% with stop+lock the mission status flips to `completed`.
 * Loaded `FOR UPDATE` scoped by (id, userId) — fail-closed, one transaction.
 */
export async function refreshMissionProtection(args: {
  userId: number;
  missionId: number;
  nowMs?: number;
}): Promise<{ ok: true; snapshot: MissionProtectionSnapshot } | { ok: false; kind: "mission_not_found" }> {
  const nowMs = args.nowMs ?? Date.now();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(profitMissionsTable)
      .where(
        and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)),
      )
      .for("update")
      .limit(1);
    const mission = rows[0] as MissionRow | undefined;
    if (!mission) return { ok: false as const, kind: "mission_not_found" as const };

    // Realised stats are read once and shared by both engines (per-user/mission).
    const closedRows = await tx
      .select({
        pnl: missionTradeDraftsTable.pnl,
        closedAt: missionTradeDraftsTable.closedAt,
      })
      .from(missionTradeDraftsTable)
      .where(
        and(
          eq(missionTradeDraftsTable.missionId, args.missionId),
          eq(missionTradeDraftsTable.userId, args.userId),
          eq(missionTradeDraftsTable.status, "executed"),
        ),
      );
    const dayStart = startOfUtcDayMs(nowMs);
    let realisedProfit = 0;
    let realisedProfitToday = 0;
    let realisedTradeCount = 0;
    for (const r of closedRows) {
      if (r.closedAt == null || !isNum(r.pnl)) continue;
      realisedTradeCount += 1;
      realisedProfit += r.pnl;
      if (r.closedAt.getTime() >= dayStart) realisedProfitToday += r.pnl;
    }
    const realised: MissionRealisedStats = {
      realisedProfit: round2(realisedProfit),
      realisedProfitToday: round2(realisedProfitToday),
      realisedTradeCount,
    };

    const milestone = await resolveMissionMilestones({
      userId: args.userId,
      mission,
      realised,
      nowMs,
    });
    const compounding = await resolveMissionCompounding({
      userId: args.userId,
      mission,
      realised,
      nowMs,
    });

    // ── Detect a journal-worthy CHANGE vs the prior persisted protection. ──────
    const priorProgress = asRecord(mission.progressJson);
    const priorProtection = asRecord(priorProgress.protection);
    const priorMilestone = numOrNull(priorProtection.milestone) ?? 0;
    const priorGiveback = boolOrDefault(priorProtection.givebackTriggered, false);
    const priorStopLock = boolOrDefault(priorProtection.stopAndLock, false);

    // ── Merge the Phase 8 keys into progressJson, PRESERVING every other key. ──
    const nowIso = new Date(nowMs).toISOString();
    const nextProgress: Record<string, unknown> = {
      ...priorProgress,
      protection: {
        milestone: milestone.milestone,
        lockedProfit: milestone.lockedProfit,
        minSetupTier: milestone.minSetupTier,
        riskMultiplier: milestone.riskMultiplier,
        suggestedMode: milestone.suggestedMode,
        stopAndLock: milestone.stopAndLock,
        givebackTriggered: milestone.givebackTriggered,
        dailyGoalReached: milestone.dailyGoalReached,
        peakRealisedProfit: milestone.peakRealisedProfit,
        realisedProfit: milestone.realisedProfit,
        reasons: milestone.reasons,
        asOf: nowIso,
      },
      compounding: {
        active: compounding.active,
        multiplier: compounding.multiplier,
        mode: compounding.mode,
        reinvestibleProfit: compounding.reinvestibleProfit,
        realisedProfit: compounding.realisedProfit,
        realisedTradeCount: compounding.realisedTradeCount,
        drawdownPct: compounding.drawdownPct,
        governorMode: compounding.governorMode,
        reasons: compounding.reasons,
        blockers: compounding.blockers,
        asOf: nowIso,
      },
    };

    // ── Target stop+lock → flip the mission to `completed` (default at 100%). ──
    const missionCompleted =
      milestone.stopAndLock && mission.status !== "completed" && mission.status !== "cancelled";
    await tx
      .update(profitMissionsTable)
      .set({
        progressJson: nextProgress,
        currentValue: round2(mission.startingAmount + realised.realisedProfit),
        updatedAt: new Date(nowMs),
        ...(missionCompleted
          ? { status: "completed", currentMode: "review", completedAt: new Date(nowMs) }
          : {}),
      })
      .where(
        and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)),
      );

    // ── Journal meaningful protection CHANGES (idempotent across refreshes). ───
    if (milestone.milestone > priorMilestone) {
      await tx.insert(missionEventsTable).values({
        missionId: args.missionId,
        type: "mission_milestone_reached",
        message: `Reached the ${milestone.milestone}% profit milestone — locked ${milestone.lockedProfit}.`,
        metadataJson: {
          milestone: milestone.milestone,
          lockedProfit: milestone.lockedProfit,
          minSetupTier: milestone.minSetupTier,
          riskMultiplier: milestone.riskMultiplier,
        },
      });
    }
    if (milestone.givebackTriggered && !priorGiveback) {
      await tx.insert(missionEventsTable).values({
        missionId: args.missionId,
        type: "mission_giveback_protect",
        message: `Giveback guard fired — switching to protect mode and reducing risk.${milestone.reasons[0] ? ` ${milestone.reasons[0]}` : ""}`,
        metadataJson: {
          peakRealisedProfit: milestone.peakRealisedProfit,
          realisedProfit: milestone.realisedProfit,
          riskMultiplier: milestone.riskMultiplier,
        },
      });
    }
    if (milestone.stopAndLock && !priorStopLock) {
      await tx.insert(missionEventsTable).values({
        missionId: args.missionId,
        type: "mission_target_locked",
        message: `Target reached — ${missionCompleted ? "mission completed and profit locked" : "profit locked"} (${milestone.lockedProfit}).`,
        metadataJson: { lockedProfit: milestone.lockedProfit, missionCompleted },
      });
    }

    return { ok: true as const, snapshot: { milestone, compounding, missionCompleted } };
  });
}

// ── Exit management for an OPEN mission trade (routes via executeInstant) ──────

export interface MissionExitOpenPosition {
  brokerTicket: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  entryPrice: number;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  floatingPl: number | null;
}

/** Honest signals a caller can observe for the exit decision (all optional). */
export interface MissionExitSignals {
  invalidation?: boolean;
  agentDisagreement?: boolean;
  orderFlowReversal?: boolean;
  highImpactNewsImminent?: boolean;
  unstableSpread?: boolean;
  structureBreak?: boolean;
  /** ATR in price terms (sizes the trail); null when not observed. */
  atr?: number | null;
  /** Whether the broker/symbol supports partial closes (for the plan). */
  brokerSupportsPartialClose?: boolean;
}

export type ManageMissionExitResult =
  | {
      ok: true;
      decision: ExitDecision;
      partialPlan: PartialPlan;
      /** True when an exit action was routed to the executor. */
      dispatched: boolean;
      commandId?: string;
      position: MissionExitOpenPosition;
    }
  | { ok: false; kind: "mission_not_found" }
  | { ok: false; kind: "draft_not_found" }
  | { ok: false; kind: "not_executed"; status: string }
  | { ok: false; kind: "no_open_position" }
  | {
      ok: false;
      kind: "execution_rejected";
      decision: ExitDecision;
      error: string;
      primaryReason?: string;
      httpStatus: number;
    };

export interface ManageMissionExitArgs {
  userId: number;
  missionId: number;
  draftId: string;
  signals?: MissionExitSignals;
  ip?: string | null;
  ua?: string | null;
  nowMs?: number;
}

export interface ManageMissionExitOpts {
  executor?: MissionExecutor;
}

/** Map a protective exit decision onto an existing instant-trade intent. */
function intentForDecision(
  decision: ExitDecision,
  position: MissionExitOpenPosition,
  missionId: number,
): InstantTradeIntent | null {
  switch (decision.action) {
    case "CLOSE": {
      return {
        source: "mission",
        missionId,
        action: "CLOSE",
        accountMode: "live",
        symbol: position.symbol,
        positionId: position.brokerTicket,
      };
    }
    case "PARTIAL_CLOSE": {
      const frac = isNum(decision.closeFraction) ? decision.closeFraction : null;
      if (frac == null || frac <= 0) return null;
      const closeVolume = round2(position.volume * frac);
      if (!(closeVolume > 0)) return null;
      return {
        source: "mission",
        missionId,
        action: "CLOSE",
        accountMode: "live",
        symbol: position.symbol,
        positionId: position.brokerTicket,
        closeVolume,
      };
    }
    case "MOVE_BREAKEVEN":
    case "TRAIL": {
      if (!isNum(decision.newPrice)) return null;
      return {
        source: "mission",
        missionId,
        action: "MODIFY_SL_TP",
        accountMode: "live",
        symbol: position.symbol,
        positionId: position.brokerTicket,
        newStopLoss: decision.newPrice,
        newTakeProfit: position.takeProfit,
      };
    }
    case "ADJUST_TARGET": {
      if (!isNum(decision.newPrice)) return null;
      return {
        source: "mission",
        missionId,
        action: "MODIFY_SL_TP",
        accountMode: "live",
        symbol: position.symbol,
        positionId: position.brokerTicket,
        newStopLoss: position.stopLoss,
        newTakeProfit: decision.newPrice,
      };
    }
    default:
      return null;
  }
}

/**
 * Decide and (optionally) route the next protective exit action for an OPEN
 * mission trade. The decision comes from the pure Exit Manager Pro engine; the
 * chosen action is mapped onto the EXISTING instant-trade actions and routed
 * through `executeInstant` (source "mission"). NONE → nothing is dispatched.
 * Per-user / per-mission isolation throughout.
 */
export async function manageMissionTradeExit(
  args: ManageMissionExitArgs,
  opts: ManageMissionExitOpts = {},
): Promise<ManageMissionExitResult> {
  const executor = opts.executor ?? executeInstant;
  const nowMs = args.nowMs ?? Date.now();
  const signals = args.signals ?? {};

  // ── Load mission + the executed draft (both scoped by userId). ─────────────
  const missionRows = await db
    .select()
    .from(profitMissionsTable)
    .where(
      and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)),
    )
    .limit(1);
  const mission = missionRows[0] as MissionRow | undefined;
  if (!mission) return { ok: false, kind: "mission_not_found" };

  const draftRows = await db
    .select()
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.draftId, args.draftId),
        eq(missionTradeDraftsTable.missionId, args.missionId),
        eq(missionTradeDraftsTable.userId, args.userId),
      ),
    )
    .limit(1);
  const draft = draftRows[0] as MissionTradeDraftRow | undefined;
  if (!draft) return { ok: false, kind: "draft_not_found" };
  if (draft.status !== "executed") return { ok: false, kind: "not_executed", status: draft.status };

  // ── Resolve the OPEN live position for this executed draft (per-user). ──────
  // The draft links to its live command via `commandId`; the position carries
  // `source_command_id` back to that command. A still-open position has no
  // `closedAt`. Read ONLY rows owned by this user.
  const posRows = await db
    .select()
    .from(arxLivePositionsTable)
    .where(and(eq(arxLivePositionsTable.userId, args.userId), isNull(arxLivePositionsTable.closedAt)));
  const match = posRows.find((r) => {
    if (draft.brokerTicket != null && r.brokerTicket === draft.brokerTicket) return true;
    if (draft.commandId != null && r.sourceCommandId === draft.commandId) return true;
    return false;
  });
  if (!match) return { ok: false, kind: "no_open_position" };

  // Lazy draft→fill backfill: a position matched via commandId whose draft is
  // still missing its broker ticket gets the ticket stamped now (best-effort,
  // additive column write) so the close hook can resolve this trade later even
  // if the fill-time backfill was missed.
  if (draft.brokerTicket == null && match.brokerTicket) {
    await db
      .update(missionTradeDraftsTable)
      .set({ brokerTicket: match.brokerTicket, updatedAt: new Date(nowMs) })
      .where(
        and(
          eq(missionTradeDraftsTable.draftId, draft.draftId),
          eq(missionTradeDraftsTable.userId, args.userId),
          isNull(missionTradeDraftsTable.brokerTicket),
        ),
      )
      .catch(() => undefined);
  }

  const side: "BUY" | "SELL" = String(match.side).toUpperCase() === "SELL" ? "SELL" : "BUY";
  const position: MissionExitOpenPosition = {
    brokerTicket: match.brokerTicket,
    symbol: match.symbol,
    side,
    volume: match.volume,
    entryPrice: match.entryPrice,
    currentPrice: numOrNull(match.currentPrice),
    stopLoss: numOrNull(match.stopLoss),
    takeProfit: numOrNull(match.takeProfit),
    floatingPl: numOrNull(match.floatingPl),
  };

  // ── Running MFE (price terms) from the MFE tracker, keyed by broker ticket. ─
  const running = await getRunning(args.userId, position.brokerTicket).catch(() => ({
    mfe: null,
    mae: null,
    peakPnl: null,
  }));

  // ── Prior exit progress (partial taken / break-even done) from resultJson. ─
  const result = asRecord(draft.resultJson);
  const partialTaken = numOrNull(result.partialTaken);
  const breakevenDone = boolOrDefault(result.breakevenDone, false);
  const isScalp = isScalpTimeframe(draft.timeframe);

  // ── Compose the pure exit decision + the advisory partial plan. ────────────
  const decision = decideExit({
    side: position.side,
    entryPrice: position.entryPrice,
    currentPrice: position.currentPrice,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    mfePrice: running.mfe,
    atr: signals.atr ?? null,
    isScalp,
    partialTaken,
    breakevenDone,
    invalidation: signals.invalidation,
    agentDisagreement: signals.agentDisagreement,
    orderFlowReversal: signals.orderFlowReversal,
    highImpactNewsImminent: signals.highImpactNewsImminent,
    unstableSpread: signals.unstableSpread,
    structureBreak: signals.structureBreak,
  });
  const partialPlan = buildPartialPlan({
    side: position.side,
    entryPrice: position.entryPrice,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    brokerSupportsPartialClose: signals.brokerSupportsPartialClose === true,
    isScalp,
  });

  // ── NONE → nothing to route (honest no-op). ────────────────────────────────
  const intent = intentForDecision(decision, position, args.missionId);
  if (decision.action === "NONE" || intent == null) {
    return { ok: true, decision, partialPlan, dispatched: false, position };
  }

  // ── Route the chosen exit through the EXISTING instant-trade path. ──────────
  await auditMission({
    userId: args.userId,
    action: "mission_exit_dispatch_attempt",
    ip: args.ip,
    ua: args.ua,
    metadata: {
      missionId: args.missionId,
      draftId: draft.draftId,
      brokerTicket: position.brokerTicket,
      exitAction: decision.action,
      trigger: decision.trigger,
    },
  });

  const exec: InstantTradeResult = await executor({
    userId: args.userId,
    intent,
    ip: args.ip,
    ua: args.ua,
  });

  if (!exec.ok) {
    await journalMissionEvent({
      missionId: args.missionId,
      type: "mission_exit_rejected",
      message: `Protective exit (${decision.action}) rejected for ${position.symbol}: ${exec.primaryReason ?? exec.error}.`,
      metadata: { draftId: draft.draftId, exitAction: decision.action, error: exec.error },
    });
    return {
      ok: false,
      kind: "execution_rejected",
      decision,
      error: exec.error,
      primaryReason: exec.primaryReason,
      httpStatus: exec.httpStatus,
    };
  }

  // ── Success: record exit progress on the draft (best-effort) + journal. ────
  const nextResult: Record<string, unknown> = { ...result };
  if (decision.action === "PARTIAL_CLOSE" && isNum(decision.closeFraction)) {
    nextResult.partialTaken = round2((partialTaken ?? 0) + decision.closeFraction);
  }
  if (decision.action === "MOVE_BREAKEVEN") nextResult.breakevenDone = true;
  nextResult.lastExitAction = decision.action;
  nextResult.lastExitTrigger = decision.trigger;
  nextResult.lastExitAt = new Date(nowMs).toISOString();

  await db
    .update(missionTradeDraftsTable)
    .set({ resultJson: nextResult, updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(missionTradeDraftsTable.draftId, draft.draftId),
        eq(missionTradeDraftsTable.userId, args.userId),
      ),
    );
  await journalMissionEvent({
    missionId: args.missionId,
    type: "mission_exit_dispatched",
    message: `Protective exit (${decision.action}) routed for ${position.symbol} ${position.side}.${decision.reasons[0] ? ` ${decision.reasons[0]}` : ""}`,
    metadata: {
      draftId: draft.draftId,
      exitAction: decision.action,
      trigger: decision.trigger,
      commandId: exec.commandId ?? null,
      source: "mission",
    },
  });

  return {
    ok: true,
    decision,
    partialPlan,
    dispatched: true,
    commandId: exec.commandId,
    position,
  };
}

// ── Record a CLOSED mission trade's realised result + missed-profit ───────────

export interface RecordMissionTradeCloseArgs {
  userId: number;
  missionId: number;
  draftId: string;
  /** Realised P/L of the closed trade, account currency (may be negative). */
  realisedPnl: number | null;
  /** Max favourable excursion in account currency (best unrealised profit seen). */
  mfeProfit?: number | null;
  /** Max adverse excursion in account currency (worst unrealised loss, ≤ 0). */
  maeProfit?: number | null;
  /** Broker fill ticket (for the de-facto mission-trade record). */
  brokerTicket?: string | null;
  /** The exit trigger that closed the trade (drives the protective flag). */
  exitReason?: string | null;
  /** True when the close was driven by a protective trigger (not penalised). */
  protectiveExit?: boolean;
  /** Realised reward-to-risk, when known. */
  rMultiple?: number | null;
  nowMs?: number;
}

export type RecordMissionTradeCloseResult =
  | { ok: true; verdict: MissedProfitVerdict; draft: MissionTradeDraftRow }
  | { ok: false; kind: "draft_not_found" };

/**
 * Record a closed mission trade's realised outcome + missed-profit analysis into
 * the executed draft (the de-facto mission-trade record). Loaded `FOR UPDATE`
 * scoped by (draftId, missionId, userId) — fail-closed, one transaction. A
 * risk-justified protective exit is NEVER classified as "left money".
 */
export async function recordMissionTradeClose(
  args: RecordMissionTradeCloseArgs,
): Promise<RecordMissionTradeCloseResult> {
  const nowMs = args.nowMs ?? Date.now();
  const verdict = analyseMissedProfit({
    realisedPnl: args.realisedPnl,
    mfeProfit: args.mfeProfit,
    maeProfit: args.maeProfit,
    protectiveExit: args.protectiveExit === true,
  });

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(missionTradeDraftsTable)
      .where(
        and(
          eq(missionTradeDraftsTable.draftId, args.draftId),
          eq(missionTradeDraftsTable.missionId, args.missionId),
          eq(missionTradeDraftsTable.userId, args.userId),
        ),
      )
      .for("update")
      .limit(1);
    const draft = rows[0] as MissionTradeDraftRow | undefined;
    if (!draft) return { ok: false as const, kind: "draft_not_found" as const };

    const priorResult = asRecord(draft.resultJson);
    const nextResult: Record<string, unknown> = {
      ...priorResult,
      missedProfit: {
        capturedProfit: verdict.capturedProfit,
        availableProfit: verdict.availableProfit,
        missedProfit: verdict.missedProfit,
        captureRate: verdict.captureRate,
        quality: verdict.quality,
        justified: verdict.justified,
        reasons: verdict.reasons,
      },
      closedAt: new Date(nowMs).toISOString(),
    };

    const [updated] = await tx
      .update(missionTradeDraftsTable)
      .set({
        pnl: isNum(args.realisedPnl) ? args.realisedPnl : draft.pnl,
        rMultiple: isNum(args.rMultiple) ? args.rMultiple : draft.rMultiple,
        mfe: isNum(args.mfeProfit) ? args.mfeProfit : draft.mfe,
        mae: isNum(args.maeProfit) ? args.maeProfit : draft.mae,
        capturedProfit: verdict.capturedProfit,
        missedProfit: verdict.missedProfit,
        exitReason: args.exitReason ?? draft.exitReason,
        brokerTicket: args.brokerTicket ?? draft.brokerTicket,
        resultJson: nextResult,
        closedAt: draft.closedAt ?? new Date(nowMs),
        updatedAt: new Date(nowMs),
      })
      .where(
        and(
          eq(missionTradeDraftsTable.draftId, args.draftId),
          eq(missionTradeDraftsTable.userId, args.userId),
        ),
      )
      .returning();

    await tx.insert(missionEventsTable).values({
      missionId: args.missionId,
      type: "mission_trade_closed",
      message: `Mission trade closed for ${draft.symbol} ${draft.direction} — captured ${verdict.capturedProfit}${verdict.captureRate != null ? ` (${Math.round(verdict.captureRate * 100)}% of the move)` : ""}.`,
      metadataJson: {
        draftId: draft.draftId,
        realisedPnl: args.realisedPnl,
        captureRate: verdict.captureRate,
        missedProfit: verdict.missedProfit,
        quality: verdict.quality,
        justified: verdict.justified,
        exitReason: args.exitReason ?? null,
      },
    });

    return { ok: true as const, verdict, draft: (updated as MissionTradeDraftRow) ?? draft };
  });
}

/**
 * Exit triggers that represent a risk-justified protective exit (invalidation,
 * structure break, news, etc.). A close driven by one of these must NEVER be
 * penalised as "left money on the table" — the user protected capital on
 * purpose. Profit-capture / scaling triggers (tp1, target, trail, breakeven)
 * are deliberately excluded.
 */
const PROTECTIVE_EXIT_TRIGGERS: ReadonlySet<string> = new Set([
  "invalidation",
  "structure_break",
  "agent_disagreement",
  "order_flow_reversal",
  "high_impact_news",
  "unstable_spread",
  "giveback",
]);

function isProtectiveExitTrigger(trigger: string | null | undefined): boolean {
  return trigger != null && PROTECTIVE_EXIT_TRIGGERS.has(trigger);
}

export type RecordMissionCloseByTicketResult =
  | RecordMissionTradeCloseResult
  | { ok: false; kind: "not_mission_trade" };

/**
 * Best-effort close-lifecycle hook: resolve a just-closed live position (by
 * per-user broker ticket) back to its executed mission draft and record the
 * realised outcome + missed-profit verdict. A no-op when the ticket is not a
 * mission trade or the close was already recorded (idempotent). Called from the
 * authoritative live close-confirmation path — never an execution path itself.
 *
 * MFE comes from the per-user MFE tracker's account-currency `peakPnl`; the
 * protective-exit flag is derived from the draft's last recorded exit trigger so
 * a risk-justified early exit is not classified as missed profit.
 */
export async function recordMissionTradeCloseByBrokerTicket(args: {
  userId: number;
  brokerTicket: string | null | undefined;
  realisedPnl: number | null;
  exitReason?: string | null;
  nowMs?: number;
}): Promise<RecordMissionCloseByTicketResult> {
  const ticket = typeof args.brokerTicket === "string" ? args.brokerTicket.trim() : "";
  if (!ticket) return { ok: false, kind: "not_mission_trade" };

  const rows = await db
    .select()
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.userId, args.userId),
        eq(missionTradeDraftsTable.brokerTicket, ticket),
        eq(missionTradeDraftsTable.status, "executed"),
      ),
    )
    .limit(1);
  const draft = rows[0] as MissionTradeDraftRow | undefined;
  if (!draft) return { ok: false, kind: "not_mission_trade" };

  // Idempotent: already closed AND already carries a missed-profit verdict.
  if (draft.closedAt != null && asRecord(draft.resultJson).missedProfit != null) {
    return { ok: false, kind: "not_mission_trade" };
  }

  const running = await getRunning(args.userId, ticket).catch(() => ({
    mfe: null,
    mae: null,
    peakPnl: null,
  }));

  const priorResult = asRecord(draft.resultJson);
  const lastTrigger =
    typeof priorResult.lastExitTrigger === "string" ? priorResult.lastExitTrigger : null;
  const exitReason = args.exitReason ?? lastTrigger ?? null;
  const protectiveExit =
    isProtectiveExitTrigger(lastTrigger) || isProtectiveExitTrigger(args.exitReason);

  return recordMissionTradeClose({
    userId: args.userId,
    missionId: draft.missionId,
    draftId: draft.draftId,
    realisedPnl: args.realisedPnl,
    mfeProfit: running.peakPnl,
    maeProfit: null,
    brokerTicket: ticket,
    exitReason,
    protectiveExit,
    nowMs: args.nowMs,
  });
}

// ── Pulse surface (advisory protection + compounding + capture stats) ─────────

export interface MissionCaptureStats {
  /** Number of closed trades that had a computable capture rate. */
  tradesAnalysed: number;
  /** Average capture rate across analysable closed trades (0..1), or null. */
  avgCaptureRate: number | null;
  /** Total profit left on the table across non-justified exits, account currency. */
  totalMissedProfit: number;
}

export interface MissionProtectionPulse {
  milestone: MissionMilestoneState;
  compounding: MissionCompoundingState;
  capture: MissionCaptureStats;
}

/**
 * Resolve the advisory protection pulse: milestone/lock state, compounding state,
 * and aggregate capture statistics. Display only — never an execution path.
 * Per-user / per-mission isolation.
 */
export async function resolveMissionProtectionPulse(args: {
  userId: number;
  missionId: number;
  nowMs?: number;
}): Promise<{ ok: true; pulse: MissionProtectionPulse } | { ok: false; kind: "mission_not_found" }> {
  const nowMs = args.nowMs ?? Date.now();
  const missionRows = await db
    .select()
    .from(profitMissionsTable)
    .where(
      and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)),
    )
    .limit(1);
  const mission = missionRows[0] as MissionRow | undefined;
  if (!mission) return { ok: false, kind: "mission_not_found" };

  const realised = await resolveMissionRealisedStats({
    userId: args.userId,
    missionId: args.missionId,
    nowMs,
  });
  const milestone = await resolveMissionMilestones({ userId: args.userId, mission, realised, nowMs });
  const compounding = await resolveMissionCompounding({
    userId: args.userId,
    mission,
    realised,
    nowMs,
  });

  // Aggregate capture stats from closed drafts' persisted missed-profit verdicts.
  const closed = await db
    .select({
      capturedProfit: missionTradeDraftsTable.capturedProfit,
      missedProfit: missionTradeDraftsTable.missedProfit,
      resultJson: missionTradeDraftsTable.resultJson,
      closedAt: missionTradeDraftsTable.closedAt,
    })
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, args.missionId),
        eq(missionTradeDraftsTable.userId, args.userId),
        eq(missionTradeDraftsTable.status, "executed"),
      ),
    );
  let tradesAnalysed = 0;
  let captureSum = 0;
  let totalMissedProfit = 0;
  for (const r of closed) {
    if (r.closedAt == null) continue;
    const mp = asRecord(asRecord(r.resultJson).missedProfit);
    const rate = numOrNull(mp.captureRate);
    const justified = boolOrDefault(mp.justified, false);
    if (rate != null) {
      tradesAnalysed += 1;
      captureSum += rate;
    }
    // Only non-justified exits count as genuinely "left on the table".
    if (!justified && isNum(r.missedProfit)) totalMissedProfit += r.missedProfit;
  }
  const capture: MissionCaptureStats = {
    tradesAnalysed,
    avgCaptureRate: tradesAnalysed > 0 ? round2(captureSum / tradesAnalysed) : null,
    totalMissedProfit: round2(totalMissedProfit),
  };

  return { ok: true, pulse: { milestone, compounding, capture } };
}
