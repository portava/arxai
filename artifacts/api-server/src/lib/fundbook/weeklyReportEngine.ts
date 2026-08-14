// ARX Fund Book — Weekly investor account story, DB-backed engine (Task #143).
//
// SAFETY / HONESTY (inviolable):
// - Every read is STRICTLY scoped by userId. No row, value, or narrative from
//   investor A is ever assembled into investor B's report.
// - The investor-facing snapshot is built only from the investor's OWN recorded
//   data: holdings × pool NAV, their verified pro-rata floating-P/L share, their
//   own unit-event ledger, their own ARX-free waterfall allocations, their own
//   drawdown high-water mark, and their own deposit locks. It NEVER reads the
//   master broker balance, the waterfall run header, the ARX 60% internal share,
//   trader compensation, account numbers, or any execution-path surface.
// - A generated report persists a point-in-time SNAPSHOT into `narrative`; reads
//   return that stored snapshot verbatim and NEVER recompute it. A published week
//   is therefore reproducible.
// - Net change is anchored ONLY to a real prior PUBLISHED baseline. With none,
//   the snapshot honestly reports no week-over-week change.
// - Generate / publish are admin-only and FAIL-CLOSED audited (the mutation and
//   its admin_action_audit_log row commit inside ONE db.transaction). This engine
//   touches NO execution path, lot sizing, the 16-gate live pipeline, kill
//   switch, or any broker dispatch surface.

import { and, desc, eq, gte, lt, max } from "drizzle-orm";
import {
  db,
  adminActionAuditLogTable,
  investorPoolHoldingsTable,
  strategyPoolNavTable,
  fundBookUnitEventsTable,
  fundBookWaterfallAllocationsTable,
  fundBookHighWaterMarksTable,
  investorDepositLocksTable,
  fundBookWeeklyReportsTable,
  type FundBookWeeklyReport,
} from "@workspace/db";
import { ensurePools } from "./navEngine.js";
import { computeHoldingValue, round2 } from "./navMath.js";
import { getPoolFloatingPl } from "./brokerMirror.js";
import { computeInvestorFloatingShare } from "./plAllocator.js";
import { computeLockedVsWithdrawable, type DepositLockRow } from "./depositLock.js";
import { getValueStatusForUser } from "./fundControls.js";
import {
  buildWeeklyAccountStory,
  isoWeekRangeOf,
  nextIsoWeekKey,
  previousIsoWeekKey,
  isValidPeriodKey,
  type WeeklyAccountStory,
  type WeeklyStoryInput,
  type PoolContributionInput,
} from "./weeklyReportMath.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface AdminActor {
  id: number;
  role: "ADMIN" | "OWNER";
}

export class WeeklyReportError extends Error {
  constructor(
    public code: string,
    public httpStatus = 400,
  ) {
    super(code);
    this.name = "WeeklyReportError";
  }
}

async function auditInTx(
  tx: Tx,
  args: {
    admin: AdminActor;
    action: string;
    targetUserId?: number | null;
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
    reason: string;
  },
): Promise<void> {
  await tx.insert(adminActionAuditLogTable).values({
    adminId: args.admin.id,
    adminRole: args.admin.role,
    action: args.action,
    targetUserId: args.targetUserId ?? null,
    beforeState: args.beforeState,
    afterState: args.afterState,
    reason: args.reason,
  });
}

// ── Baseline ────────────────────────────────────────────────────────────────

/**
 * The end value of the immediately-preceding PUBLISHED report for this investor
 * (the chronologically latest published period strictly before `periodKey`).
 * Returns null when the investor has no earlier published week — the caller then
 * reports an honest "starting baseline" with no week-over-week change.
 */
export async function getPublishedBaseline(
  userId: number,
  periodKey: string,
): Promise<{ endValue: number; periodKey: string } | null> {
  const rows = await db
    .select({
      periodKey: fundBookWeeklyReportsTable.periodKey,
      narrative: fundBookWeeklyReportsTable.narrative,
    })
    .from(fundBookWeeklyReportsTable)
    .where(
      and(
        eq(fundBookWeeklyReportsTable.userId, userId),
        eq(fundBookWeeklyReportsTable.status, "PUBLISHED"),
        lt(fundBookWeeklyReportsTable.periodKey, periodKey),
      ),
    )
    .orderBy(desc(fundBookWeeklyReportsTable.periodKey))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const story = row.narrative as WeeklyAccountStory | null;
  const endValue = story?.economicImpact?.endValue;
  if (typeof endValue !== "number" || !Number.isFinite(endValue)) return null;
  return { endValue: round2(endValue), periodKey: row.periodKey };
}

// ── Snapshot assembly (DB reads only) ───────────────────────────────────────

/**
 * Assemble the investor-safe weekly story input from the investor's OWN recorded
 * data for the given ISO week. The end value is the point-in-time snapshot at
 * generation; flows are exact from the in-window unit ledger + waterfall.
 */
export async function assembleWeeklyStoryInput(
  userId: number,
  periodKey: string,
  now: Date = new Date(),
): Promise<WeeklyStoryInput> {
  if (!isValidPeriodKey(periodKey)) throw new WeeklyReportError("INVALID_PERIOD_KEY", 400);
  const { periodStart, periodEnd } = isoWeekRangeOf(periodKey);

  const pools = await ensurePools();
  const [navRows, holdings, floating, unitEvents, waterfallAllocs, hwmRows, lockRows, freshness, baseline] =
    await Promise.all([
      db.select().from(strategyPoolNavTable),
      db
        .select()
        .from(investorPoolHoldingsTable)
        .where(eq(investorPoolHoldingsTable.userId, userId)),
      getPoolFloatingPl(),
      // Unit events inside [periodStart, periodEnd) for this investor.
      db
        .select({
          strategyPoolId: fundBookUnitEventsTable.strategyPoolId,
          netAmount: fundBookUnitEventsTable.netAmount,
        })
        .from(fundBookUnitEventsTable)
        .where(
          and(
            eq(fundBookUnitEventsTable.userId, userId),
            gte(fundBookUnitEventsTable.createdAt, periodStart),
            lt(fundBookUnitEventsTable.createdAt, periodEnd),
          ),
        ),
      // Waterfall allocations inside the window (ARX-free table; per-user).
      db
        .select({
          strategyPoolId: fundBookWaterfallAllocationsTable.strategyPoolId,
          distributableShare: fundBookWaterfallAllocationsTable.distributableShare,
        })
        .from(fundBookWaterfallAllocationsTable)
        .where(
          and(
            eq(fundBookWaterfallAllocationsTable.userId, userId),
            gte(fundBookWaterfallAllocationsTable.createdAt, periodStart),
            lt(fundBookWaterfallAllocationsTable.createdAt, periodEnd),
          ),
        ),
      // The investor's OWN net-value drawdown high-water mark.
      db
        .select()
        .from(fundBookHighWaterMarksTable)
        .where(
          and(
            eq(fundBookHighWaterMarksTable.scopeType, "INVESTOR"),
            eq(fundBookHighWaterMarksTable.userId, userId),
          ),
        )
        .limit(1),
      // The investor's own deposit locks.
      db
        .select()
        .from(investorDepositLocksTable)
        .where(eq(investorDepositLocksTable.userId, userId)),
      getValueStatusForUser(userId),
      getPublishedBaseline(userId, periodKey),
    ]);

  const navByPool = new Map(navRows.map((n) => [n.strategyPoolId, n]));
  const holdingByPool = new Map(holdings.map((h) => [h.strategyPoolId, h]));
  const floatingByPool = floating.aggregate.byPoolId;

  // Per-pool recorded net flows in the window (unit ledger + waterfall).
  const flowsByPool = new Map<number, number>();
  for (const e of unitEvents) {
    flowsByPool.set(e.strategyPoolId, (flowsByPool.get(e.strategyPoolId) ?? 0) + e.netAmount);
  }
  for (const a of waterfallAllocs) {
    flowsByPool.set(
      a.strategyPoolId,
      (flowsByPool.get(a.strategyPoolId) ?? 0) + a.distributableShare,
    );
  }

  // Window flow magnitudes: deposits = inflows, withdrawals = |outflows| from the
  // unit ledger; distributions = signed waterfall distributable in the window.
  let deposits = 0;
  let withdrawals = 0;
  for (const e of unitEvents) {
    if (e.netAmount > 0) deposits += e.netAmount;
    else if (e.netAmount < 0) withdrawals += -e.netAmount;
  }
  let distributions = 0;
  for (const a of waterfallAllocs) distributions += a.distributableShare;

  let endValue = 0;
  const poolInputs: PoolContributionInput[] = pools.map((p) => {
    const nav = navByPool.get(p.id);
    const h = holdingByPool.get(p.id);
    const navPerUnit = nav?.navPerUnit ?? 1;
    const totalUnits = nav?.totalUnitsOutstanding ?? 0;
    const unitsOwned = h?.unitsOwned ?? 0;
    const settledValue = computeHoldingValue(unitsOwned, navPerUnit);
    const poolFloating = floatingByPool.get(p.id) ?? 0;
    const floatingPlShare = round2(
      computeInvestorFloatingShare(poolFloating, unitsOwned, totalUnits),
    );
    endValue += settledValue + floatingPlShare;
    return {
      poolKey: p.poolKey,
      name: p.name,
      riskLevel: p.riskLevel,
      navStatus: nav?.navStatus ?? "OK",
      unitsOwned,
      settledValue,
      floatingPlShare,
      flowsInWindow: round2(flowsByPool.get(p.id) ?? 0),
    };
  });
  endValue = round2(endValue);

  // Deposit-lock split at the snapshot + whether a lock releases next week.
  const lockInputs: DepositLockRow[] = lockRows.map((l) => ({
    principalAmount: l.principalAmount,
    lockUntil: l.lockUntil,
    status: l.status,
  }));
  const lockSplit = computeLockedVsWithdrawable(endValue, lockInputs, now);
  let lockReleasesNextWeek = false;
  if (lockSplit.nextReleaseAt) {
    const nextRange = isoWeekRangeOf(nextIsoWeekKey(periodKey));
    const t = lockSplit.nextReleaseAt.getTime();
    lockReleasesNextWeek =
      t >= nextRange.periodStart.getTime() && t < nextRange.periodEnd.getTime();
  }

  const hwm = hwmRows[0] ?? null;
  const navStatus: "OK" | "UNDER_REVIEW" =
    freshness.status === "UNDER_REVIEW" ? "UNDER_REVIEW" : "OK";

  return {
    periodKey,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    endValue,
    baselineValue: baseline?.endValue ?? null,
    baselineAvailable: baseline != null,
    baselinePeriodKey: baseline?.periodKey ?? null,
    deposits: round2(deposits),
    withdrawals: round2(withdrawals),
    distributions: round2(distributions),
    pools: poolInputs,
    drawdownPercent: hwm ? round2(hwm.drawdownPercent) : null,
    drawdownUsd: hwm ? round2(hwm.drawdownUsd) : null,
    lockedPrincipal: lockSplit.lockedPrincipal,
    withdrawableValue: lockSplit.withdrawableValue,
    nextReleaseAt: lockSplit.nextReleaseAt ? lockSplit.nextReleaseAt.toISOString() : null,
    lockReleasesNextWeek,
    navStatus,
    freshness: freshness.status,
    freshnessMessage: freshness.investorMessage,
  };
}

/** Build (but do not persist) the deterministic story for a week. */
export async function buildWeeklyReportSnapshot(
  userId: number,
  periodKey: string,
  now: Date = new Date(),
): Promise<WeeklyAccountStory> {
  const input = await assembleWeeklyStoryInput(userId, periodKey, now);
  return buildWeeklyAccountStory(input);
}

// ── Generation (new DRAFT version) ──────────────────────────────────────────

/**
 * Generate a new DRAFT weekly report version for (userId, periodKey). Each call
 * mints the next version (append-only); existing versions are never edited. The
 * generation is fail-closed audited.
 */
export async function generateWeeklyReport(
  admin: AdminActor,
  userId: number,
  periodKey: string,
  reason: string,
  now: Date = new Date(),
): Promise<FundBookWeeklyReport> {
  if (!isValidPeriodKey(periodKey)) throw new WeeklyReportError("INVALID_PERIOD_KEY", 400);
  const input = await assembleWeeklyStoryInput(userId, periodKey, now);
  const story = buildWeeklyAccountStory(input);
  const { periodStart, periodEnd } = isoWeekRangeOf(periodKey);

  return db.transaction(async (tx) => {
    const maxRows = await tx
      .select({ v: max(fundBookWeeklyReportsTable.version) })
      .from(fundBookWeeklyReportsTable)
      .where(
        and(
          eq(fundBookWeeklyReportsTable.userId, userId),
          eq(fundBookWeeklyReportsTable.periodKey, periodKey),
        ),
      );
    const nextVersion = (maxRows[0]?.v ?? 0) + 1;

    const inserted = await tx
      .insert(fundBookWeeklyReportsTable)
      .values({
        userId,
        periodKey,
        periodStart,
        periodEnd,
        version: nextVersion,
        status: "DRAFT",
        headline: story.headline,
        narrative: story,
        navStatus: story.dataQuality.navStatus,
        freshness: story.dataQuality.freshness,
        baselineAvailable: story.economicImpact.baselineAvailable,
        generatedByAdminId: admin.id,
        reason,
      })
      .returning();
    const row = inserted[0]!;

    await auditInTx(tx, {
      admin,
      action: "FUND_WEEKLY_REPORT_GENERATE",
      targetUserId: userId,
      beforeState: { periodKey, priorVersions: nextVersion - 1 },
      afterState: {
        reportId: row.id,
        version: nextVersion,
        navStatus: row.navStatus,
        baselineAvailable: row.baselineAvailable,
      },
      reason,
    });
    return row;
  });
}

// ── Publish (one PUBLISHED per period) ──────────────────────────────────────

/**
 * Publish a DRAFT report. Any previously-PUBLISHED version for the same
 * (userId, periodKey) is marked SUPERSEDED in the same transaction so the
 * partial unique index (one PUBLISHED per period) always holds. Fail-closed
 * audited.
 */
export async function publishWeeklyReport(
  admin: AdminActor,
  reportId: number,
  reason: string,
): Promise<FundBookWeeklyReport> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(fundBookWeeklyReportsTable)
      .where(eq(fundBookWeeklyReportsTable.id, reportId))
      .limit(1);
    const report = rows[0];
    if (!report) throw new WeeklyReportError("REPORT_NOT_FOUND", 404);
    if (report.status === "PUBLISHED") {
      return report; // idempotent: already the published version
    }
    if (report.status === "SUPERSEDED") {
      throw new WeeklyReportError("REPORT_SUPERSEDED", 409);
    }

    // Supersede the current published version for this period (if any).
    await tx
      .update(fundBookWeeklyReportsTable)
      .set({ status: "SUPERSEDED" })
      .where(
        and(
          eq(fundBookWeeklyReportsTable.userId, report.userId),
          eq(fundBookWeeklyReportsTable.periodKey, report.periodKey),
          eq(fundBookWeeklyReportsTable.status, "PUBLISHED"),
        ),
      );

    const updated = await tx
      .update(fundBookWeeklyReportsTable)
      .set({
        status: "PUBLISHED",
        publishedByAdminId: admin.id,
        publishedAt: new Date(),
      })
      .where(eq(fundBookWeeklyReportsTable.id, reportId))
      .returning();
    const row = updated[0]!;

    await auditInTx(tx, {
      admin,
      action: "FUND_WEEKLY_REPORT_PUBLISH",
      targetUserId: report.userId,
      beforeState: { reportId, priorStatus: report.status, periodKey: report.periodKey },
      afterState: { reportId, status: "PUBLISHED", version: row.version },
      reason,
    });
    return row;
  });
}

// ── Bulk generate / publish (per-investor or whole-cohort) ──────────────────

export interface BulkReportResult {
  userId: number;
  ok: boolean;
  reportId?: number;
  version?: number;
  status?: string;
  error?: string;
}

/**
 * Resolve the target investor set. An explicit (deduped, positive) userIds list
 * wins; otherwise the cohort is every investor who currently holds units in any
 * pool. Each per-user generate/publish remains independently fail-closed audited
 * inside the engine, so a bulk run is just a sequenced loop with per-user error
 * isolation (one investor's failure never aborts the batch).
 */
async function resolveTargetUserIds(userIds?: number[]): Promise<number[]> {
  if (userIds && userIds.length > 0) {
    return Array.from(
      new Set(userIds.filter((u) => Number.isInteger(u) && u > 0)),
    );
  }
  const rows = await db
    .selectDistinct({ userId: investorPoolHoldingsTable.userId })
    .from(investorPoolHoldingsTable);
  return rows.map((r) => r.userId);
}

/** Generate a new DRAFT for each target investor for one period. */
export async function bulkGenerateWeeklyReports(
  admin: AdminActor,
  periodKey: string,
  reason: string,
  userIds?: number[],
  now: Date = new Date(),
): Promise<BulkReportResult[]> {
  if (!isValidPeriodKey(periodKey)) throw new WeeklyReportError("INVALID_PERIOD_KEY", 400);
  const targets = await resolveTargetUserIds(userIds);
  const results: BulkReportResult[] = [];
  for (const userId of targets) {
    try {
      const row = await generateWeeklyReport(admin, userId, periodKey, reason, now);
      results.push({ userId, ok: true, reportId: row.id, version: row.version, status: row.status });
    } catch (e) {
      const error =
        e instanceof WeeklyReportError ? e.code : e instanceof Error ? e.message : "GENERATE_FAILED";
      results.push({ userId, ok: false, error });
    }
  }
  return results;
}

/** Publish the latest DRAFT for each target investor for one period. */
export async function bulkPublishWeeklyReports(
  admin: AdminActor,
  periodKey: string,
  reason: string,
  userIds?: number[],
): Promise<BulkReportResult[]> {
  if (!isValidPeriodKey(periodKey)) throw new WeeklyReportError("INVALID_PERIOD_KEY", 400);
  const targets = await resolveTargetUserIds(userIds);
  const results: BulkReportResult[] = [];
  for (const userId of targets) {
    try {
      const draftRows = await db
        .select({ id: fundBookWeeklyReportsTable.id })
        .from(fundBookWeeklyReportsTable)
        .where(
          and(
            eq(fundBookWeeklyReportsTable.userId, userId),
            eq(fundBookWeeklyReportsTable.periodKey, periodKey),
            eq(fundBookWeeklyReportsTable.status, "DRAFT"),
          ),
        )
        .orderBy(desc(fundBookWeeklyReportsTable.version))
        .limit(1);
      const draft = draftRows[0];
      if (!draft) {
        results.push({ userId, ok: false, error: "NO_DRAFT" });
        continue;
      }
      const row = await publishWeeklyReport(admin, draft.id, reason);
      results.push({ userId, ok: true, reportId: row.id, version: row.version, status: row.status });
    } catch (e) {
      const error =
        e instanceof WeeklyReportError ? e.code : e instanceof Error ? e.message : "PUBLISH_FAILED";
      results.push({ userId, ok: false, error });
    }
  }
  return results;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** A reproducible, investor-safe report DTO (the stored snapshot verbatim). */
export interface WeeklyReportDto {
  id: number;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  status: string;
  headline: string;
  navStatus: string;
  freshness: string;
  baselineAvailable: boolean;
  publishedAt: string | null;
  createdAt: string;
  narrative: WeeklyAccountStory;
}

function toDto(row: FundBookWeeklyReport): WeeklyReportDto {
  return {
    id: row.id,
    periodKey: row.periodKey,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    version: row.version,
    status: row.status,
    headline: row.headline,
    navStatus: row.navStatus,
    freshness: row.freshness,
    baselineAvailable: row.baselineAvailable,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    narrative: row.narrative as WeeklyAccountStory,
  };
}

/** Lightweight list item (no full narrative) for week pickers / admin lists. */
export interface WeeklyReportListItem {
  id: number;
  periodKey: string;
  version: number;
  status: string;
  headline: string;
  navStatus: string;
  freshness: string;
  baselineAvailable: boolean;
  publishedAt: string | null;
  createdAt: string;
}

function toListItem(row: FundBookWeeklyReport): WeeklyReportListItem {
  return {
    id: row.id,
    periodKey: row.periodKey,
    version: row.version,
    status: row.status,
    headline: row.headline,
    navStatus: row.navStatus,
    freshness: row.freshness,
    baselineAvailable: row.baselineAvailable,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The investor's OWN published reports (one per period), newest first. Strictly
 * scoped by userId; DRAFT / SUPERSEDED rows are never returned to investors.
 */
export async function listPublishedReportsForUser(
  userId: number,
): Promise<WeeklyReportListItem[]> {
  const rows = await db
    .select()
    .from(fundBookWeeklyReportsTable)
    .where(
      and(
        eq(fundBookWeeklyReportsTable.userId, userId),
        eq(fundBookWeeklyReportsTable.status, "PUBLISHED"),
      ),
    )
    .orderBy(desc(fundBookWeeklyReportsTable.periodKey));
  return rows.map(toListItem);
}

/** The investor's OWN published report for one period (or null). */
export async function getPublishedReportForUser(
  userId: number,
  periodKey: string,
): Promise<WeeklyReportDto | null> {
  const rows = await db
    .select()
    .from(fundBookWeeklyReportsTable)
    .where(
      and(
        eq(fundBookWeeklyReportsTable.userId, userId),
        eq(fundBookWeeklyReportsTable.periodKey, periodKey),
        eq(fundBookWeeklyReportsTable.status, "PUBLISHED"),
      ),
    )
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

/** Admin: every version row for one investor (all statuses), newest first. */
export async function listReportsForUserAdmin(
  userId: number,
): Promise<WeeklyReportListItem[]> {
  const rows = await db
    .select()
    .from(fundBookWeeklyReportsTable)
    .where(eq(fundBookWeeklyReportsTable.userId, userId))
    .orderBy(desc(fundBookWeeklyReportsTable.periodKey), desc(fundBookWeeklyReportsTable.version));
  return rows.map(toListItem);
}

/** Admin: a single report row by id (full snapshot). */
export async function getReportByIdAdmin(id: number): Promise<WeeklyReportDto | null> {
  const rows = await db
    .select()
    .from(fundBookWeeklyReportsTable)
    .where(eq(fundBookWeeklyReportsTable.id, id))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

export { toDto as weeklyReportToDto, toListItem as weeklyReportToListItem };
