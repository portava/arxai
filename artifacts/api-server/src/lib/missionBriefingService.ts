// ── Profit Mission Phase 9 — Briefing / EOD / report + learning-loop service ───
//
// SAFETY / SCOPE:
//   - COMPOSES the pure briefing + learning-loop engines with the mission's HONEST
//     state and its real closed drafts. Everything here is READ-ONLY and ADVISORY:
//     no trade, no gate change, no fabrication. Empty evidence yields honest empty
//     aggregates (never invented performance).
//   - Per-user / per-mission isolation: every read is scoped by (userId, missionId).
import { and, eq } from "drizzle-orm";
import { db, profitMissionsTable, missionTradeDraftsTable } from "@workspace/db";
import {
  buildDailyBriefing,
  buildEndOfDayReview,
  buildMissionReport,
  runMissionLearningLoop,
  type DailyBriefing,
  type EndOfDayReview,
  type MissionReport,
  type MissionBriefingState,
  type ClosedTradeAggregate,
  type ClosedTradeRecord,
  type LearningLoopResult,
} from "@workspace/domain/profit-mission";

type MissionRow = typeof profitMissionsTable.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function startOfUtcDayMs(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

async function loadOwnedMission(userId: number, missionId: number): Promise<MissionRow | null> {
  const rows = await db
    .select()
    .from(profitMissionsTable)
    .where(and(eq(profitMissionsTable.id, missionId), eq(profitMissionsTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

function toBriefingState(mission: MissionRow, nowMs: number): MissionBriefingState {
  const deadlineMs = mission.timeframeEnd.getTime();
  const daysRemaining = Math.ceil((deadlineMs - nowMs) / DAY_MS);
  const promotion = asRecord(mission.promotionJson);
  return {
    missionId: mission.id,
    status: mission.status,
    startingAmount: mission.startingAmount,
    targetAmount: mission.targetAmount,
    currentValue: mission.currentValue,
    requiredProfit: mission.requiredProfit,
    daysRemaining,
    automationLevel: mission.automationLevel,
    promotionPaused: promotion.promotionPaused === true,
  };
}

interface ClosedDraftRow {
  pnl: number;
  rMultiple: number | null;
  closedAt: Date;
  symbol: string | null;
  agentKey: string | null;
}

async function readClosedDrafts(userId: number, missionId: number): Promise<ClosedDraftRow[]> {
  const rows = await db
    .select({
      pnl: missionTradeDraftsTable.pnl,
      rMultiple: missionTradeDraftsTable.rMultiple,
      closedAt: missionTradeDraftsTable.closedAt,
      symbol: missionTradeDraftsTable.symbol,
      agentKey: missionTradeDraftsTable.agentKey,
    })
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, missionId),
        eq(missionTradeDraftsTable.userId, userId),
        eq(missionTradeDraftsTable.status, "executed"),
      ),
    );
  return rows
    .filter((r): r is typeof r & { closedAt: Date } =>
      r.closedAt != null && r.pnl != null && Number.isFinite(r.pnl))
    .map((r) => ({
      pnl: r.pnl as number,
      rMultiple: r.rMultiple != null && Number.isFinite(r.rMultiple) ? r.rMultiple : null,
      closedAt: r.closedAt,
      symbol: r.symbol,
      agentKey: r.agentKey,
    }));
}

function aggregate(drafts: ClosedDraftRow[]): ClosedTradeAggregate {
  let winningTrades = 0;
  let losingTrades = 0;
  let netPnl = 0;
  let bestTradePnl = 0;
  let worstTradePnl = 0;
  let any = false;
  for (const d of drafts) {
    if (d.pnl > 0) winningTrades += 1;
    else if (d.pnl < 0) losingTrades += 1;
    netPnl += d.pnl;
    if (!any) {
      bestTradePnl = d.pnl;
      worstTradePnl = d.pnl;
      any = true;
    } else {
      if (d.pnl > bestTradePnl) bestTradePnl = d.pnl;
      if (d.pnl < worstTradePnl) worstTradePnl = d.pnl;
    }
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    totalTrades: drafts.length,
    winningTrades,
    losingTrades,
    netPnl: round2(netPnl),
    bestTradePnl: round2(bestTradePnl),
    worstTradePnl: round2(worstTradePnl),
  };
}

/** Daily briefing for a mission (advisory, honest). */
export async function buildMissionDailyBriefing(args: {
  userId: number;
  missionId: number;
  nowMs?: number;
}): Promise<{ ok: true; briefing: DailyBriefing } | { ok: false; kind: "not_found" }> {
  const mission = await loadOwnedMission(args.userId, args.missionId);
  if (!mission) return { ok: false, kind: "not_found" };
  const nowMs = args.nowMs ?? Date.now();
  return { ok: true, briefing: buildDailyBriefing(toBriefingState(mission, nowMs), nowMs) };
}

/** End-of-day review for a mission (today's realised closed trades). */
export async function buildMissionEodReview(args: {
  userId: number;
  missionId: number;
  nowMs?: number;
}): Promise<{ ok: true; review: EndOfDayReview } | { ok: false; kind: "not_found" }> {
  const mission = await loadOwnedMission(args.userId, args.missionId);
  if (!mission) return { ok: false, kind: "not_found" };
  const nowMs = args.nowMs ?? Date.now();
  const dayStart = startOfUtcDayMs(nowMs);
  const drafts = await readClosedDrafts(args.userId, args.missionId);
  const today = drafts.filter((d) => d.closedAt.getTime() >= dayStart);
  return {
    ok: true,
    review: buildEndOfDayReview(toBriefingState(mission, nowMs), aggregate(today), nowMs),
  };
}

/** Post-mission (or in-progress) report over all realised closed trades. */
export async function buildMissionReportForUser(args: {
  userId: number;
  missionId: number;
  nowMs?: number;
}): Promise<{ ok: true; report: MissionReport } | { ok: false; kind: "not_found" }> {
  const mission = await loadOwnedMission(args.userId, args.missionId);
  if (!mission) return { ok: false, kind: "not_found" };
  const nowMs = args.nowMs ?? Date.now();
  const drafts = await readClosedDrafts(args.userId, args.missionId);
  return {
    ok: true,
    report: buildMissionReport(toBriefingState(mission, nowMs), aggregate(drafts), nowMs),
  };
}

/** Learning-loop aggregation (reliability by agent/strategy/symbol) for a mission. */
export async function buildMissionLearningLoop(args: {
  userId: number;
  missionId: number;
}): Promise<{ ok: true; learning: LearningLoopResult } | { ok: false; kind: "not_found" }> {
  const mission = await loadOwnedMission(args.userId, args.missionId);
  if (!mission) return { ok: false, kind: "not_found" };
  const drafts = await readClosedDrafts(args.userId, args.missionId);
  const records: ClosedTradeRecord[] = drafts.map((d) => ({
    agentKey: d.agentKey,
    strategyKey: d.agentKey,
    symbol: d.symbol,
    session: null,
    pattern: null,
    rMultiple: d.rMultiple ?? 0,
    win: d.pnl > 0,
  }));
  return { ok: true, learning: runMissionLearningLoop(records) };
}
