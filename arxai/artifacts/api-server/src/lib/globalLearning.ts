// Global Learning Service
//
// Aggregates anonymized trade outcomes from opted-in users into
// global_signal_edges. Provides Ruby with platform-wide insights.
//
// PRIVACY GUARANTEES (enforced in code):
//   - Only processes users with contributeToGlobalLearning = true
//   - No user IDs written to global tables
//   - No raw P&L, balance, or account data stored
//   - MIN_SAMPLE_SIZE = 10 distinct contributors before surfacing
//   - Raw data never leaves per-user tables
//
// SAFETY: Read/aggregate only. Never touches trade execution.

import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  importedTradesTable,
  paperTradesTable,
  userPrivacySettingsTable,
  globalSignalEdgesTable,
  globalLearningRunsTable,
  traderDnaProfilesTable,
  MIN_SAMPLE_SIZE,
  type GlobalSignalEdgeRow,
} from "@workspace/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { logger } from "./logger.js";

const log = logger.child({ component: "globalLearning" });

// ── Privacy opt-in helpers ────────────────────────────────────────────────────

export async function getPrivacySettings(userId: number) {
  const rows = await db.select()
    .from(userPrivacySettingsTable)
    .where(eq(userPrivacySettingsTable.userId, userId))
    .limit(1);

  if (rows[0]) return rows[0];

  // Auto-create with safe defaults
  await db.insert(userPrivacySettingsTable)
    .values({ userId })
    .onConflictDoNothing();

  return (await db.select()
    .from(userPrivacySettingsTable)
    .where(eq(userPrivacySettingsTable.userId, userId))
    .limit(1))[0] ?? {
      userId,
      contributeToGlobalLearning: false,
      receiveGlobalInsights: true,
      contributionOptedInAt: null,
      contributionOptedOutAt: null,
    };
}

export async function setContributionOptIn(userId: number, optIn: boolean) {
  const now = new Date();
  await db.insert(userPrivacySettingsTable)
    .values({
      userId,
      contributeToGlobalLearning: optIn,
      contributionOptedInAt:  optIn ? now : null,
      contributionOptedOutAt: optIn ? null : now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userPrivacySettingsTable.userId,
      set: {
        contributeToGlobalLearning: optIn,
        contributionOptedInAt:  optIn ? now : sql`contribution_opted_in_at`,
        contributionOptedOutAt: optIn ? sql`contribution_opted_out_at` : now,
        updatedAt: now,
      },
    });
}

export async function setReceiveInsights(userId: number, receive: boolean) {
  await db.insert(userPrivacySettingsTable)
    .values({ userId, receiveGlobalInsights: receive, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userPrivacySettingsTable.userId,
      set: { receiveGlobalInsights: receive, updatedAt: new Date() },
    });
}

// ── Session detector ──────────────────────────────────────────────────────────
function sessionFromDate(d: Date | null): string {
  if (!d) return "any";
  const h = d.getUTCHours();
  if (h >= 0  && h < 7)  return "asian";
  if (h >= 7  && h < 12) return "london";
  if (h >= 12 && h < 16) return "overlap";
  if (h >= 16 && h < 21) return "newyork";
  return "asian";
}

// ── R-multiple from imported trade ───────────────────────────────────────────
function calcR(t: typeof importedTradesTable.$inferSelect): number | null {
  if (!t.stopLoss || !t.entryPrice || !t.exitPrice) return null;
  const risk = Math.abs(t.entryPrice - t.stopLoss);
  if (risk === 0) return null;
  const delta = t.side === "BUY" ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice;
  return Math.round((delta / risk) * 100) / 100;
}

// ── Main aggregation job ──────────────────────────────────────────────────────
// Reads opted-in users, anonymizes their closed trades into cohort buckets,
// upserts global_signal_edges. Runs periodically (e.g. every 6 hours).

export async function runGlobalAggregation(): Promise<{
  optedInUsers: number;
  cohortsUpdated: number;
  cohortsCreated: number;
}> {
  const runId = `glr_${randomUUID()}`;
  await db.insert(globalLearningRunsTable).values({ runId, status: "RUNNING" });

  try {
    // 1. Find opted-in users
    const optedIn = await db.select({ userId: userPrivacySettingsTable.userId })
      .from(userPrivacySettingsTable)
      .where(eq(userPrivacySettingsTable.contributeToGlobalLearning, true));

    if (optedIn.length === 0) {
      await db.update(globalLearningRunsTable)
        .set({ status: "COMPLETE", completedAt: new Date(), optedInUsers: 0 })
        .where(eq(globalLearningRunsTable.runId, runId));
      return { optedInUsers: 0, cohortsUpdated: 0, cohortsCreated: 0 };
    }

    const userIds = optedIn.map((r) => r.userId);

    // 2. Collect anonymized trade data — ONLY: symbol, side, session, setup_type,
    //    win/loss, R-multiple, duration. NO user IDs stored in output.
    // We use a Map keyed by cohort to accumulate stats per contributor.
    // Map<cohortKey, Map<userId(temp), { wins, losses, rMultiples, durations }>>
    type ContribData = { wins: number; losses: number; rMults: number[]; durations: number[] };
    const cohortContribs = new Map<string, Map<number, ContribData>>();

    // Process imported trades from opted-in users
    for (const uid of userIds) {
      const trades = await db.select({
        symbol:    importedTradesTable.symbol,
        side:      importedTradesTable.side,
        netPnl:    importedTradesTable.netPnl,
        openedAt:  importedTradesTable.openedAt,
        closedAt:  importedTradesTable.closedAt,
        durationSeconds: importedTradesTable.durationSeconds,
        entryPrice: importedTradesTable.entryPrice,
        exitPrice:  importedTradesTable.exitPrice,
        stopLoss:   importedTradesTable.stopLoss,
        sessionLabel: importedTradesTable.sessionLabel,
      })
        .from(importedTradesTable)
        .where(and(
          eq(importedTradesTable.userId, uid),
          sql`${importedTradesTable.closedAt} IS NOT NULL`,
          sql`${importedTradesTable.netPnl} IS NOT NULL`,
        ))
        .limit(1000);

      for (const t of trades) {
        if (!t.symbol || !t.side || t.netPnl === null) continue;

        const session  = t.sessionLabel ?? sessionFromDate(t.openedAt);
        const cohortKey = `${t.symbol}|${session}|any|${t.side}`;

        if (!cohortContribs.has(cohortKey)) cohortContribs.set(cohortKey, new Map());
        const userMap = cohortContribs.get(cohortKey)!;
        if (!userMap.has(uid)) userMap.set(uid, { wins: 0, losses: 0, rMults: [], durations: [] });
        const contrib = userMap.get(uid)!;

        if (t.netPnl > 0) contrib.wins++;
        else if (t.netPnl < 0) contrib.losses++;

        // Compute R inline since we have raw fields
        const risk = t.stopLoss != null && t.entryPrice != null ? Math.abs(t.entryPrice - t.stopLoss) : 0;
        if (risk > 0 && t.exitPrice != null && t.entryPrice != null) {
          const delta = t.side === "BUY" ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice;
          contrib.rMults.push(Math.round((delta / risk) * 100) / 100);
        }
        if (t.durationSeconds) contrib.durations.push(t.durationSeconds);
      }
    }

    // 3. Aggregate cohorts and upsert global_signal_edges
    let updated = 0;
    let created = 0;
    const now = new Date();

    for (const [cohortKey, userMap] of cohortContribs.entries()) {
      const [symbol, session, setupType, action] = cohortKey.split("|") as [string, string, string, string];

      const contributorCount = userMap.size;
      let totalWins = 0, totalLosses = 0, allRMults: number[] = [], allDurations: number[] = [];

      for (const contrib of userMap.values()) {
        totalWins   += contrib.wins;
        totalLosses += contrib.losses;
        allRMults   = allRMults.concat(contrib.rMults);
        allDurations = allDurations.concat(contrib.durations);
      }

      const sampleCount = totalWins + totalLosses;
      if (sampleCount === 0) continue;

      const winRate   = (totalWins / sampleCount) * 100;
      const avgR      = allRMults.length   ? allRMults.reduce((a, b) => a + b, 0) / allRMults.length     : null;
      const avgDur    = allDurations.length ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length : null;

      // Confidence adjustment: positive when win rate > 55%, negative when < 45%
      // Bounded to [-10, 10]
      const rawAdj = ((winRate - 50) / 50) * 10;
      const confidenceAdjustment = Math.max(-10, Math.min(10, Math.round(rawAdj * 10) / 10));

      const isSurfaceable = contributorCount >= MIN_SAMPLE_SIZE;

      const existing = await db.select({ id: globalSignalEdgesTable.id })
        .from(globalSignalEdgesTable)
        .where(sql`symbol = ${symbol} AND session_label = ${session} AND setup_type = ${setupType} AND action = ${action}`)
        .limit(1);

      if (existing.length > 0) {
        await db.update(globalSignalEdgesTable)
          .set({
            contributorCount, sampleCount, winCount: totalWins, lossCount: totalLosses,
            winRate: Math.round(winRate * 10) / 10,
            avgRMultiple: avgR !== null ? Math.round(avgR * 100) / 100 : null,
            avgDuration:  avgDur !== null ? Math.round(avgDur) : null,
            confidenceAdjustment,
            isSurfaceable,
            lastAggregatedAt: now,
            updatedAt: now,
          })
          .where(sql`symbol = ${symbol} AND session_label = ${session} AND setup_type = ${setupType} AND action = ${action}`);
        updated++;
      } else {
        await db.insert(globalSignalEdgesTable)
          .values({
            symbol, sessionLabel: session, setupType: setupType ?? "any", action,
            contributorCount, sampleCount, winCount: totalWins, lossCount: totalLosses,
            winRate: Math.round(winRate * 10) / 10,
            avgRMultiple: avgR !== null ? Math.round(avgR * 100) / 100 : null,
            avgDuration:  avgDur !== null ? Math.round(avgDur) : null,
            confidenceAdjustment,
            isSurfaceable,
            lastAggregatedAt: now,
          })
          .onConflictDoNothing();
        created++;
      }
    }

    await db.update(globalLearningRunsTable)
      .set({
        status: "COMPLETE", completedAt: now,
        optedInUsers: userIds.length,
        cohortsUpdated: updated,
        cohortsCreated: created,
      })
      .where(eq(globalLearningRunsTable.runId, runId));

    log.info({ optedInUsers: userIds.length, updated, created }, "global_aggregation_complete");
    return { optedInUsers: userIds.length, cohortsUpdated: updated, cohortsCreated: created };

  } catch (e) {
    log.error({ err: e }, "global_aggregation_failed");
    await db.update(globalLearningRunsTable)
      .set({ status: "FAILED", completedAt: new Date(), errorMessage: (e as Error).message.slice(0, 500) })
      .where(eq(globalLearningRunsTable.runId, runId));
    throw e;
  }
}

// ── Query global insights for Ruby ───────────────────────────────────────────
export async function getGlobalInsight(
  symbol: string,
  session: string,
  action: "BUY" | "SELL",
): Promise<GlobalSignalEdgeRow | null> {
  // Try exact session match first, then fall back to "any"
  const rows = await db.select()
    .from(globalSignalEdgesTable)
    .where(and(
      eq(globalSignalEdgesTable.symbol, symbol.toUpperCase()),
      eq(globalSignalEdgesTable.action, action),
      eq(globalSignalEdgesTable.isSurfaceable, true),
      sql`session_label IN (${session}, 'any')`,
    ))
    .limit(2);

  // Prefer specific session over "any"
  return rows.find((r) => r.sessionLabel === session) ?? rows[0] ?? null;
}

export async function getGlobalInsightSummary(
  symbol: string,
  session: string,
): Promise<{ buy: GlobalSignalEdgeRow | null; sell: GlobalSignalEdgeRow | null }> {
  const [buy, sell] = await Promise.all([
    getGlobalInsight(symbol, session, "BUY"),
    getGlobalInsight(symbol, session, "SELL"),
  ]);
  return { buy, sell };
}

// ── Schedule the aggregation job ─────────────────────────────────────────────
// Called once at server startup. Runs every 6 hours.
const AGG_INTERVAL_MS = 6 * 60 * 60_000;

export function scheduleGlobalAggregation(): void {
  const run = () => {
    runGlobalAggregation().catch((e) => {
      log.warn({ err: e }, "scheduled_global_aggregation_failed");
    });
  };

  // First run after 5 minutes (let server settle)
  setTimeout(run, 5 * 60_000);

  const timer = setInterval(run, AGG_INTERVAL_MS);
  timer.unref?.();
}
