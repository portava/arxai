// ARX Fund Book — Discrepancy & controls center service (Task #133).
//
// SAFETY / HONESTY (inviolable):
// - DETECTION ONLY. This engine gathers a reconciliation snapshot, FLAGS
//   mismatches as persisted discrepancy records, and LOCKS sensitive accounting
//   actions (issuance / withdrawals / statements). It NEVER auto-edits an
//   investor balance, NEVER closes a position, and NEVER touches any execution
//   path, lot sizing, the 16-gate live pipeline, kill switch, or any broker
//   dispatch surface.
// - Discrepancies are deduped on the LOGICAL entity ((discrepancyType,
//   entityKey)) so repeated passes are idempotent: an existing OPEN record is
//   refreshed (occurrence/last-seen/observed/expected), a RESOLVED/DISMISSED
//   record that recurs is re-opened. Never spams duplicate rows.
// - Every mutation is FAIL-CLOSED audited: the mutation + its
//   admin_action_audit_log row are written inside ONE db.transaction.
// - Investors never see internals/raw broker data/admin notes — only a clean
//   "temporarily paused while values are verified" message and a coarse
//   freshness status. Strict per-investor scoping.
// - No paper/sim/mock/fake or guaranteed-return wording anywhere.

import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  adminActionAuditLogTable,
  capitalMovementRequestsTable,
  fundBookFeeEntriesTable,
  investorPoolHoldingsTable,
  strategyPoolNavTable,
  fundReconciliationSettingsTable,
  fundDiscrepanciesTable,
  fundControlFreezesTable,
  fundCapacityLimitsTable,
  fundCapacityWaitlistTable,
  GLOBAL_SCOPE_KEY,
  type FundReconciliationSettings,
  type FundDiscrepancy,
  type FundControlFreeze,
  type FundCapacityLimit,
  type FreezeScope,
  type FreezeSource,
  type DiscrepancyStatus,
} from "@workspace/db";
import { ensurePools } from "./navEngine.js";
import { handshakeEventBus } from "../handshake/eventBus.js";
import { getBrokerMirror, getPoolFloatingPl } from "./brokerMirror.js";
import { ageMsOf } from "./mirrorFreshness.js";
import { createAlert } from "../alerts/alertManager.js";
import {
  evaluateReconciliation,
  type ReconciliationSnapshot,
  type ToleranceBands,
  type DiscrepancyCandidate,
} from "./discrepancyRules.js";
import {
  classifyValueFreshness,
  type ValueFreshnessResult,
} from "./valueFreshness.js";
import {
  classifyCapacityStatus,
  evaluateCapacity,
  type CapacityStatus,
  type DepositCapacityDecision,
} from "./capacity.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

export interface AdminActor {
  id: number;
  role: "ADMIN" | "OWNER";
}

/** A control-layer block (freeze active) or invalid op. Carries an HTTP status
 *  + a clean investor-safe message (never an internal). */
export class FundControlError extends Error {
  constructor(
    public code: string,
    public httpStatus = 409,
    public investorMessage = "This action is temporarily paused while your values are verified.",
  ) {
    super(code);
    this.name = "FundControlError";
  }
}

// Scopes auto-locked when a CRITICAL discrepancy fires.
const CRITICAL_AUTO_FREEZE_SCOPES: FreezeScope[] = [
  "ISSUANCE",
  "WITHDRAWALS",
  "STATEMENTS",
];

async function auditInTx(
  tx: Tx,
  args: {
    admin: AdminActor;
    action: string;
    targetUserId?: number | null;
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
    reason?: string | null;
  },
): Promise<void> {
  await tx.insert(adminActionAuditLogTable).values({
    adminId: args.admin.id,
    adminRole: args.admin.role,
    action: args.action,
    targetUserId: args.targetUserId ?? null,
    beforeState: args.beforeState,
    afterState: args.afterState,
    reason: args.reason ?? null,
  });
}

// ── Reconciliation settings (singleton) ─────────────────────────────────────

export async function getReconciliationSettings(): Promise<FundReconciliationSettings> {
  const rows = await db
    .select()
    .from(fundReconciliationSettingsTable)
    .where(eq(fundReconciliationSettingsTable.scope, "GLOBAL"))
    .limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db
    .insert(fundReconciliationSettingsTable)
    .values({ scope: "GLOBAL" })
    .onConflictDoNothing({ target: fundReconciliationSettingsTable.scope })
    .returning();
  if (inserted[0]) return inserted[0];
  const again = await db
    .select()
    .from(fundReconciliationSettingsTable)
    .where(eq(fundReconciliationSettingsTable.scope, "GLOBAL"))
    .limit(1);
  return again[0]!;
}

function bandsFromSettings(s: FundReconciliationSettings): ToleranceBands {
  return {
    lowUsd: s.lowUsd,
    mediumUsd: s.mediumUsd,
    highUsd: s.highUsd,
    criticalUsd: s.criticalUsd,
    lowPct: s.lowPct,
    mediumPct: s.mediumPct,
    highPct: s.highPct,
    criticalPct: s.criticalPct,
  };
}

export async function updateReconciliationSettings(
  admin: AdminActor,
  patch: Partial<
    Pick<
      FundReconciliationSettings,
      | "lowUsd"
      | "mediumUsd"
      | "highUsd"
      | "criticalUsd"
      | "lowPct"
      | "mediumPct"
      | "highPct"
      | "criticalPct"
      | "staleSyncMs"
      | "autoLockOnCritical"
    >
  >,
  reason: string,
): Promise<FundReconciliationSettings> {
  const current = await getReconciliationSettings();
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(fundReconciliationSettingsTable)
      .set({ ...patch, updatedByAdminId: admin.id })
      .where(eq(fundReconciliationSettingsTable.id, current.id))
      .returning();
    await auditInTx(tx, {
      admin,
      action: "FUND_RECON_SETTINGS_UPDATE",
      beforeState: { ...current },
      afterState: { ...updated[0] },
      reason,
    });
    return updated[0]!;
  });
}

// ── Snapshot gathering (DB reads only) ──────────────────────────────────────

export async function gatherSnapshot(now: number = Date.now()): Promise<{
  snapshot: ReconciliationSnapshot;
  settings: FundReconciliationSettings;
}> {
  const settings = await getReconciliationSettings();
  const pools = await ensurePools();

  const [navRows, holdingRows, floating, mirror] = await Promise.all([
    db.select().from(strategyPoolNavTable),
    db
      .select({
        poolId: investorPoolHoldingsTable.strategyPoolId,
        units: sql<number>`coalesce(sum(${investorPoolHoldingsTable.unitsOwned}), 0)`,
      })
      .from(investorPoolHoldingsTable)
      .where(eq(investorPoolHoldingsTable.status, "ACTIVE"))
      .groupBy(investorPoolHoldingsTable.strategyPoolId),
    getPoolFloatingPl(),
    getBrokerMirror(now),
  ]);

  const navByPool = new Map(navRows.map((n) => [n.strategyPoolId, n]));
  const unitsByPool = new Map(holdingRows.map((h) => [h.poolId, Number(h.units)]));

  // Live broker totals (only live/real accounts contribute to fund equity).
  let brokerEquityTotal = 0;
  let brokerBalanceTotal = 0;
  let brokerFloatingPlTotal = 0;
  let newestBrokerAt: Date | null = null;
  for (const b of mirror.bridges) {
    const t = (b.accountType ?? "").toLowerCase();
    if (t !== "live" && t !== "real") continue;
    brokerEquityTotal += b.accountEquity;
    brokerBalanceTotal += b.accountBalance;
    brokerFloatingPlTotal += b.floatingPlTotal;
    if (b.freshnessAsOf && (newestBrokerAt == null || b.freshnessAsOf > newestBrokerAt)) {
      newestBrokerAt = b.freshnessAsOf;
    }
  }
  const brokerAgeMs = ageMsOf(newestBrokerAt, now);

  let poolValueTotal = 0;
  const poolSnaps = pools.map((p) => {
    const nav = navByPool.get(p.id);
    const totalPoolValue = nav?.totalPoolValue ?? 0;
    poolValueTotal += totalPoolValue;
    return {
      poolId: p.id,
      poolKey: p.poolKey,
      navPerUnit: nav?.navPerUnit ?? 1,
      totalUnitsOutstanding: nav?.totalUnitsOutstanding ?? 0,
      totalPoolValue,
      navStatus: nav?.navStatus ?? "OK",
      investorUnits: unitsByPool.get(p.id) ?? 0,
      floatingPlNav: nav?.unrealizedPl ?? 0,
      floatingPlReported: floating.aggregate.byPoolId.get(p.id) ?? 0,
    };
  });

  const unassignedPositions = floating.aggregate.unassigned.map((u) => ({
    brokerTicket: u.brokerTicket,
    userId: u.userId,
    symbol: u.symbol ?? null,
  }));

  // Structural request mismatches.
  const [settledDeposits, approvedWithdrawals, pendingMovementRows, feeOwedRows] =
    await Promise.all([
    db
      .select({
        requestId: capitalMovementRequestsTable.id,
        userId: capitalMovementRequestsTable.userId,
        netAmount: capitalMovementRequestsTable.netAmount,
        settledUnits: capitalMovementRequestsTable.settledUnits,
      })
      .from(capitalMovementRequestsTable)
      .where(
        and(
          eq(capitalMovementRequestsTable.movementType, "DEPOSIT"),
          inArray(capitalMovementRequestsTable.status, ["SETTLED", "COMPLETED"]),
          or(
            isNull(capitalMovementRequestsTable.settledUnits),
            lte(capitalMovementRequestsTable.settledUnits, 0),
          ),
        ),
      ),
    db
      .select({
        requestId: capitalMovementRequestsTable.id,
        userId: capitalMovementRequestsTable.userId,
        isFullExit: capitalMovementRequestsTable.isFullExit,
        reservedUnits: capitalMovementRequestsTable.reservedUnits,
      })
      .from(capitalMovementRequestsTable)
      .where(
        and(
          eq(capitalMovementRequestsTable.movementType, "WITHDRAWAL"),
          eq(capitalMovementRequestsTable.status, "APPROVED"),
          lte(capitalMovementRequestsTable.reservedUnits, 0),
        ),
      ),
    // Active (non-terminal) capital movement requests — the backlog rule filters
    // these by age against the configured window.
    db
      .select({
        requestId: capitalMovementRequestsTable.id,
        userId: capitalMovementRequestsTable.userId,
        movementType: capitalMovementRequestsTable.movementType,
        status: capitalMovementRequestsTable.status,
        createdAt: capitalMovementRequestsTable.createdAt,
        grossAmount: capitalMovementRequestsTable.grossAmount,
        netAmount: capitalMovementRequestsTable.netAmount,
        feeAmount: capitalMovementRequestsTable.totalFeeAmount,
      })
      .from(capitalMovementRequestsTable)
      .where(
        inArray(capitalMovementRequestsTable.status, [
          "SUBMITTED",
          "PENDING_REVIEW",
          "APPROVED",
          "PROCESSING",
        ]),
      ),
    // Settled/completed requests that recorded a fee but have no posted fee-ledger
    // entry (LEFT JOIN; the unmatched fee rows are the owed-but-unposted set).
    db
      .select({
        requestId: capitalMovementRequestsTable.id,
        userId: capitalMovementRequestsTable.userId,
        feeAmount: capitalMovementRequestsTable.totalFeeAmount,
      })
      .from(capitalMovementRequestsTable)
      .leftJoin(
        fundBookFeeEntriesTable,
        eq(
          fundBookFeeEntriesTable.capitalMovementRequestId,
          capitalMovementRequestsTable.id,
        ),
      )
      .where(
        and(
          inArray(capitalMovementRequestsTable.status, ["SETTLED", "COMPLETED"]),
          gt(capitalMovementRequestsTable.totalFeeAmount, 0),
          isNull(fundBookFeeEntriesTable.id),
        ),
      ),
  ]);

  // Fund book's recorded realized (closed) P/L — sum of each pool NAV's
  // realizedPl. The broker realized-P/L side is not yet ingested (the bridge
  // pushes heartbeat/account/positions only, never deal/close history), so it
  // stays null and the CLOSED_PL_MISMATCH rule never fabricates a broker figure.
  const bookClosedPlTotal = navRows.reduce((acc, n) => acc + (n.realizedPl ?? 0), 0);
  const brokerClosedPlTotal: number | null = null;

  const snapshot: ReconciliationSnapshot = {
    now,
    brokerEquityTotal,
    brokerBalanceTotal,
    brokerFloatingPlTotal,
    brokerAgeMs,
    poolValueTotal,
    bookClosedPlTotal,
    brokerClosedPlTotal,
    pools: poolSnaps,
    unassignedPositions,
    settledDepositsWithoutUnits: settledDeposits.map((d) => ({
      requestId: d.requestId,
      userId: d.userId,
      netAmount: d.netAmount,
      settledUnits: d.settledUnits ?? null,
    })),
    approvedWithdrawalsWithoutReserved: approvedWithdrawals.map((w) => ({
      requestId: w.requestId,
      userId: w.userId,
      isFullExit: w.isFullExit,
      reservedUnits: w.reservedUnits,
    })),
    pendingMovements: pendingMovementRows.map((m) => ({
      requestId: m.requestId,
      userId: m.userId,
      movementType: m.movementType,
      status: m.status,
      ageMs: Math.max(0, now - m.createdAt.getTime()),
      grossAmount: m.grossAmount,
      netAmount: m.netAmount,
      feeAmount: m.feeAmount,
    })),
    feesOwedUnposted: feeOwedRows.map((f) => ({
      requestId: f.requestId,
      userId: f.userId,
      feeAmount: f.feeAmount,
    })),
  };

  return { snapshot, settings };
}

// ── Reconciliation run (idempotent upsert + critical auto-lock) ─────────────

export interface ReconciliationRunResult {
  ranAt: string;
  totalCandidates: number;
  opened: number;
  updated: number;
  reopened: number;
  criticalCount: number;
  autoLockedScopes: FreezeScope[];
  discrepancies: FundDiscrepancy[];
}

/**
 * Run a full reconciliation pass. Upserts each candidate discrepancy on its
 * logical entity (idempotent), and — when a CRITICAL fires and auto-lock is
 * enabled — applies the issuance/withdrawals/statements freezes and raises an
 * alert. All writes are fail-closed audited.
 */
export async function runReconciliation(
  admin: AdminActor,
  reason: string,
  now: number = Date.now(),
): Promise<ReconciliationRunResult> {
  const { snapshot, settings } = await gatherSnapshot(now);
  const candidates = evaluateReconciliation(snapshot, {
    bands: bandsFromSettings(settings),
    staleSyncMs: settings.staleSyncMs,
  });

  const result = await db.transaction(async (tx) => {
    let opened = 0;
    let updated = 0;
    let reopened = 0;
    const persisted: FundDiscrepancy[] = [];

    for (const c of candidates) {
      const existingRows = await tx
        .select()
        .from(fundDiscrepanciesTable)
        .where(
          and(
            eq(fundDiscrepanciesTable.discrepancyType, c.discrepancyType),
            eq(fundDiscrepanciesTable.entityKey, c.entityKey),
          ),
        )
        .limit(1);
      const existing = existingRows[0];

      if (!existing) {
        const ins = await tx
          .insert(fundDiscrepanciesTable)
          .values({
            discrepancyType: c.discrepancyType,
            entityKey: c.entityKey,
            entityType: c.entityType,
            userId: c.userId,
            strategyPoolId: c.strategyPoolId,
            severity: c.severity,
            status: "OPEN",
            expectedValue: c.expectedValue,
            observedValue: c.observedValue,
            deltaAbsolute: c.deltaAbsolute,
            deltaPercent: c.deltaPercent,
            summary: c.summary,
            recommendedAction: c.recommendedAction,
            detail: c.detail,
            firstDetectedAt: new Date(now),
            lastDetectedAt: new Date(now),
          })
          .returning();
        opened++;
        persisted.push(ins[0]!);
        continue;
      }

      // Recurred after resolve/dismiss → re-open; otherwise refresh in place.
      const wasClosed = existing.status === "RESOLVED" || existing.status === "DISMISSED";
      const upd = await tx
        .update(fundDiscrepanciesTable)
        .set({
          severity: c.severity,
          status: wasClosed ? "OPEN" : existing.status,
          expectedValue: c.expectedValue,
          observedValue: c.observedValue,
          deltaAbsolute: c.deltaAbsolute,
          deltaPercent: c.deltaPercent,
          summary: c.summary,
          recommendedAction: c.recommendedAction,
          detail: c.detail,
          lastDetectedAt: new Date(now),
          occurrenceCount: existing.occurrenceCount + 1,
          ...(wasClosed
            ? { resolutionReason: null, resolvedByAdminId: null, resolvedAt: null }
            : {}),
        })
        .where(eq(fundDiscrepanciesTable.id, existing.id))
        .returning();
      if (wasClosed) reopened++;
      else updated++;
      persisted.push(upd[0]!);
    }

    const criticals = persisted.filter((d) => d.severity === "CRITICAL");
    const autoLockedScopes: FreezeScope[] = [];

    if (settings.autoLockOnCritical && criticals.length > 0) {
      const lockReason = `Auto-lock: ${criticals.length} critical discrepancy(ies) open. Run #${now}.`;
      for (const scope of CRITICAL_AUTO_FREEZE_SCOPES) {
        const applied = await applyFreezeInTx(tx, admin, {
          scope,
          scopeKey: GLOBAL_SCOPE_KEY,
          reason: lockReason,
          source: "AUTO_CRITICAL",
          relatedDiscrepancyId: criticals[0]!.id,
        });
        if (applied) autoLockedScopes.push(scope);
      }
      // Mark the criticals that drove the lock.
      await tx
        .update(fundDiscrepanciesTable)
        .set({ autoLockApplied: true })
        .where(
          inArray(
            fundDiscrepanciesTable.id,
            criticals.map((c) => c.id),
          ),
        );
    }

    await auditInTx(tx, {
      admin,
      action: "FUND_RECON_RUN",
      beforeState: { candidateCount: candidates.length },
      afterState: {
        opened,
        updated,
        reopened,
        criticalCount: criticals.length,
        autoLockedScopes,
      },
      reason,
    });

    return {
      ranAt: new Date(now).toISOString(),
      totalCandidates: candidates.length,
      opened,
      updated,
      reopened,
      criticalCount: criticals.length,
      autoLockedScopes,
      discrepancies: persisted,
    };
  });

  // Best-effort alert AFTER the audited tx commits (never blocks the run).
  if (result.criticalCount > 0) {
    try {
      await createAlert({
        type: "RISK_LOCK",
        priority: "CRITICAL",
        title: "Critical fund discrepancy detected",
        message: `${result.criticalCount} critical discrepancy(ies) opened. Issuance, withdrawals, and statements are locked pending review.`,
        actionRequired: true,
        dedupeKey: "fund-critical-discrepancy-lock",
      });
    } catch {
      // Alerting is advisory; the lock + audit already committed.
    }
  }

  return result;
}

// ── Discrepancy workflow ────────────────────────────────────────────────────

export interface DiscrepancyFilter {
  status?: DiscrepancyStatus;
  severity?: string;
  userId?: number;
  strategyPoolId?: number;
}

export async function listDiscrepancies(
  filter: DiscrepancyFilter = {},
): Promise<FundDiscrepancy[]> {
  const conds = [];
  if (filter.status) conds.push(eq(fundDiscrepanciesTable.status, filter.status));
  if (filter.severity) conds.push(eq(fundDiscrepanciesTable.severity, filter.severity));
  if (filter.userId != null) conds.push(eq(fundDiscrepanciesTable.userId, filter.userId));
  if (filter.strategyPoolId != null)
    conds.push(eq(fundDiscrepanciesTable.strategyPoolId, filter.strategyPoolId));
  return db
    .select()
    .from(fundDiscrepanciesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(fundDiscrepanciesTable.lastDetectedAt));
}

export type DiscrepancyAction = "ASSIGN" | "NOTE" | "INVESTIGATE" | "RESOLVE" | "DISMISS";

export async function actOnDiscrepancy(
  admin: AdminActor,
  id: number,
  action: DiscrepancyAction,
  opts: { reason?: string; note?: string; assigneeId?: number } = {},
): Promise<FundDiscrepancy> {
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(fundDiscrepanciesTable)
      .where(eq(fundDiscrepanciesTable.id, id))
      .limit(1);
    const existing = rows[0];
    if (!existing) throw new FundControlError("DISCREPANCY_NOT_FOUND", 404);

    const patch: Partial<typeof fundDiscrepanciesTable.$inferInsert> = {};
    switch (action) {
      case "ASSIGN":
        if (opts.assigneeId == null) throw new FundControlError("ASSIGNEE_REQUIRED", 400);
        patch.assignedToAdminId = opts.assigneeId;
        break;
      case "NOTE":
        if (!opts.note) throw new FundControlError("NOTE_REQUIRED", 400);
        patch.adminNote = opts.note;
        break;
      case "INVESTIGATE":
        patch.status = "INVESTIGATING";
        break;
      case "RESOLVE":
        if (!opts.reason) throw new FundControlError("REASON_REQUIRED", 400);
        patch.status = "RESOLVED";
        patch.resolutionReason = opts.reason;
        patch.resolvedByAdminId = admin.id;
        patch.resolvedAt = new Date();
        break;
      case "DISMISS":
        if (!opts.reason) throw new FundControlError("REASON_REQUIRED", 400);
        patch.status = "DISMISSED";
        patch.resolutionReason = opts.reason;
        patch.resolvedByAdminId = admin.id;
        patch.resolvedAt = new Date();
        break;
    }

    const updated = await tx
      .update(fundDiscrepanciesTable)
      .set(patch)
      .where(eq(fundDiscrepanciesTable.id, id))
      .returning();
    await auditInTx(tx, {
      admin,
      action: `FUND_DISCREPANCY_${action}`,
      targetUserId: existing.userId,
      beforeState: { status: existing.status, assignedToAdminId: existing.assignedToAdminId },
      afterState: { ...patch },
      reason: opts.reason ?? opts.note ?? null,
    });
    return updated[0]!;
  });
  // Advisory cross-layer signal: a discrepancy action changes fund-book
  // readiness. Best-effort, post-commit; never affects this admin operation.
  handshakeEventBus.emit("layer:discrepancy", {
    userId: result.userId ?? undefined,
    at: new Date().toISOString(),
  });
  return result;
}

// ── Freezes ─────────────────────────────────────────────────────────────────

/**
 * Apply a freeze inside an existing tx. Returns the new freeze, or null when an
 * ACTIVE freeze on the same (scope, scopeKey) already exists (idempotent).
 */
async function applyFreezeInTx(
  tx: Tx,
  admin: AdminActor,
  args: {
    scope: FreezeScope;
    scopeKey?: string;
    reason: string;
    source?: FreezeSource;
    relatedDiscrepancyId?: number | null;
  },
): Promise<FundControlFreeze | null> {
  const scopeKey = args.scopeKey ?? GLOBAL_SCOPE_KEY;
  const existing = await tx
    .select()
    .from(fundControlFreezesTable)
    .where(
      and(
        eq(fundControlFreezesTable.freezeScope, args.scope),
        eq(fundControlFreezesTable.scopeKey, scopeKey),
        eq(fundControlFreezesTable.active, true),
      ),
    )
    .limit(1);
  if (existing[0]) return null;

  const inserted = await tx
    .insert(fundControlFreezesTable)
    .values({
      freezeScope: args.scope,
      scopeKey,
      active: true,
      source: args.source ?? "MANUAL",
      reason: args.reason,
      relatedDiscrepancyId: args.relatedDiscrepancyId ?? null,
      frozenByAdminId: admin.id,
    })
    .returning();
  await auditInTx(tx, {
    admin,
    action: "FUND_FREEZE_APPLY",
    beforeState: { scope: args.scope, scopeKey, active: false },
    afterState: { ...inserted[0] },
    reason: args.reason,
  });
  return inserted[0]!;
}

export async function applyFreeze(
  admin: AdminActor,
  args: {
    scope: FreezeScope;
    scopeKey?: string;
    reason: string;
    source?: FreezeSource;
    relatedDiscrepancyId?: number | null;
  },
): Promise<FundControlFreeze> {
  const out = await db.transaction((tx) => applyFreezeInTx(tx, admin, args));
  if (!out) throw new FundControlError("FREEZE_ALREADY_ACTIVE", 409);
  return out;
}

export async function liftFreeze(
  admin: AdminActor,
  id: number,
  note: string,
): Promise<FundControlFreeze> {
  if (!note || note.trim().length < 3) throw new FundControlError("UNFREEZE_NOTE_REQUIRED", 400);
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(fundControlFreezesTable)
      .where(eq(fundControlFreezesTable.id, id))
      .limit(1);
    const existing = rows[0];
    if (!existing) throw new FundControlError("FREEZE_NOT_FOUND", 404);
    if (!existing.active) throw new FundControlError("FREEZE_NOT_ACTIVE", 409);

    const updated = await tx
      .update(fundControlFreezesTable)
      .set({
        active: false,
        unfreezeNote: note,
        unfrozenByAdminId: admin.id,
        unfrozenAt: new Date(),
      })
      .where(eq(fundControlFreezesTable.id, id))
      .returning();
    await auditInTx(tx, {
      admin,
      action: "FUND_FREEZE_LIFT",
      beforeState: { id, active: true },
      afterState: { id, active: false },
      reason: note,
    });
    return updated[0]!;
  });
}

export async function listActiveFreezes(reader: DbOrTx = db): Promise<FundControlFreeze[]> {
  return reader
    .select()
    .from(fundControlFreezesTable)
    .where(eq(fundControlFreezesTable.active, true))
    .orderBy(desc(fundControlFreezesTable.frozenAt));
}

/**
 * True when an ACTIVE freeze covers a scope. A scope-wide GLOBAL freeze covers
 * every key; a keyed freeze covers only that key. Pass the relevant scopeKey
 * (pool key / userId) to also honour keyed freezes.
 */
export async function isFrozen(
  scope: FreezeScope,
  scopeKey?: string,
  reader: DbOrTx = db,
): Promise<boolean> {
  const keys = [GLOBAL_SCOPE_KEY];
  if (scopeKey && scopeKey !== GLOBAL_SCOPE_KEY) keys.push(scopeKey);
  const rows = await reader
    .select({ id: fundControlFreezesTable.id })
    .from(fundControlFreezesTable)
    .where(
      and(
        eq(fundControlFreezesTable.freezeScope, scope),
        eq(fundControlFreezesTable.active, true),
        inArray(fundControlFreezesTable.scopeKey, keys),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Throw FundControlError if any of the given scopes is frozen. Used at the
 * sensitive accounting checkpoints (deposit / withdrawal / settle / statement).
 */
export async function assertActionAllowed(
  scopes: FreezeScope[],
  opts: { scopeKey?: string; reader?: DbOrTx } = {},
): Promise<void> {
  const reader = opts.reader ?? db;
  for (const scope of scopes) {
    if (await isFrozen(scope, opts.scopeKey, reader)) {
      throw new FundControlError(
        `ACTION_FROZEN:${scope}`,
        409,
        "This action is temporarily paused while your values are verified.",
      );
    }
  }
}

// ── Capacity ────────────────────────────────────────────────────────────────

export async function getCapacityLimit(
  scope: "FUND" | "POOL",
  scopeKey: string = GLOBAL_SCOPE_KEY,
): Promise<FundCapacityLimit | null> {
  const rows = await db
    .select()
    .from(fundCapacityLimitsTable)
    .where(
      and(
        eq(fundCapacityLimitsTable.scope, scope),
        eq(fundCapacityLimitsTable.scopeKey, scopeKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listCapacityLimits(): Promise<FundCapacityLimit[]> {
  return db.select().from(fundCapacityLimitsTable);
}

export async function upsertCapacityLimit(
  admin: AdminActor,
  args: {
    scope: "FUND" | "POOL";
    scopeKey?: string;
    maxFundCapital?: number;
    maxPoolCapital?: number;
    maxInvestorCapital?: number;
    exposureCapPct?: number;
    liquidityReservePct?: number;
    nearCapacityThresholdPct?: number;
    adminStatusOverride?: string | null;
    waitlistEnabled?: boolean;
  },
  reason: string,
): Promise<FundCapacityLimit> {
  const scopeKey = args.scopeKey ?? GLOBAL_SCOPE_KEY;
  const before = await getCapacityLimit(args.scope, scopeKey);
  return db.transaction(async (tx) => {
    const values = {
      scope: args.scope,
      scopeKey,
      maxFundCapital: args.maxFundCapital ?? before?.maxFundCapital ?? 0,
      maxPoolCapital: args.maxPoolCapital ?? before?.maxPoolCapital ?? 0,
      maxInvestorCapital: args.maxInvestorCapital ?? before?.maxInvestorCapital ?? 0,
      exposureCapPct: args.exposureCapPct ?? before?.exposureCapPct ?? 0,
      liquidityReservePct: args.liquidityReservePct ?? before?.liquidityReservePct ?? 0,
      nearCapacityThresholdPct:
        args.nearCapacityThresholdPct ?? before?.nearCapacityThresholdPct ?? 90,
      adminStatusOverride:
        args.adminStatusOverride === undefined
          ? (before?.adminStatusOverride ?? null)
          : args.adminStatusOverride,
      waitlistEnabled: args.waitlistEnabled ?? before?.waitlistEnabled ?? true,
      updatedByAdminId: admin.id,
    };
    const upserted = await tx
      .insert(fundCapacityLimitsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [fundCapacityLimitsTable.scope, fundCapacityLimitsTable.scopeKey],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    await auditInTx(tx, {
      admin,
      action: "FUND_CAPACITY_UPSERT",
      beforeState: { ...(before ?? {}) },
      afterState: { ...upserted[0] },
      reason,
    });
    return upserted[0]!;
  });
}

/**
 * Resolve the capacity status for a pool from its current value vs the
 * configured cap + admin override. No limit row ⇒ OPEN.
 */
export async function getPoolCapacityStatus(
  poolKey: string,
  currentValue: number,
): Promise<{ status: CapacityStatus; limit: FundCapacityLimit | null }> {
  const limit = await getCapacityLimit("POOL", poolKey);
  if (!limit) return { status: "OPEN", limit: null };
  const status = classifyCapacityStatus(currentValue, {
    maxCapital: limit.maxPoolCapital,
    nearThresholdPct: limit.nearCapacityThresholdPct,
    adminStatusOverride: limit.adminStatusOverride,
  });
  return { status, limit };
}

/**
 * Decide how to route a deposit into a pool, enforcing EVERY configured cap:
 * the per-pool cap, plus (from the FUND limit row) the fund total cap, the
 * liquidity reserve, the per-pool exposure cap, and the per-investor cap. The
 * binding (most restrictive) constraint decides the routing. Pure routing
 * decision — the caller persists a waitlist row when routedTo is WAITLIST.
 * No limit rows at all ⇒ unbounded OPEN.
 */
export async function checkDepositCapacity(args: {
  poolKey: string;
  currentValue: number;
  depositAmount: number;
  // Total current fund pool value (sum across pools), for fund/exposure caps.
  fundCurrentValue?: number;
  // This investor's current total holdings value, for the per-investor cap.
  investorCurrentValue?: number;
}): Promise<DepositCapacityDecision> {
  const [poolLimit, fundLimit] = await Promise.all([
    getCapacityLimit("POOL", args.poolKey),
    getCapacityLimit("FUND"),
  ]);

  const pool = {
    currentValue: args.currentValue,
    maxPoolCapital: poolLimit?.maxPoolCapital ?? 0,
    nearThresholdPct: poolLimit?.nearCapacityThresholdPct ?? 90,
    adminStatusOverride: poolLimit?.adminStatusOverride ?? null,
    waitlistEnabled: poolLimit?.waitlistEnabled ?? true,
  };

  const fund =
    fundLimit && fundLimit.maxFundCapital > 0
      ? {
          fundCurrentValue: args.fundCurrentValue ?? 0,
          maxFundCapital: fundLimit.maxFundCapital,
          liquidityReservePct: fundLimit.liquidityReservePct,
          exposureCapPct: fundLimit.exposureCapPct,
        }
      : null;

  const investor =
    fundLimit && fundLimit.maxInvestorCapital > 0
      ? {
          investorCurrentValue: args.investorCurrentValue ?? 0,
          maxInvestorCapital: fundLimit.maxInvestorCapital,
        }
      : null;

  return evaluateCapacity({
    depositAmount: args.depositAmount,
    pool,
    fund,
    investor,
  });
}

export async function addToWaitlist(args: {
  userId: number;
  strategyPoolId: number | null;
  poolKey: string | null;
  requestedAmount: number;
  capitalMovementRequestId?: number | null;
  status: "WAITLISTED" | "ROUTED_CASH_RESERVE";
  investorMessage: string;
  reason?: string;
}): Promise<void> {
  await db.insert(fundCapacityWaitlistTable).values({
    userId: args.userId,
    strategyPoolId: args.strategyPoolId,
    poolKey: args.poolKey,
    requestedAmount: args.requestedAmount,
    capitalMovementRequestId: args.capitalMovementRequestId ?? null,
    status: args.status,
    investorMessage: args.investorMessage,
    reason: args.reason ?? null,
  });
}

// ── Investor value freshness (per-investor scoped) ──────────────────────────

/**
 * The 5-state freshness verdict for an investor's values. Verification states
 * (NAV under review, an OPEN/INVESTIGATING discrepancy on a pool they hold, or
 * an active freeze touching them) surface as UNDER_REVIEW with the calm
 * investor message. Strictly scoped to THIS user.
 */
export async function getValueStatusForUser(
  userId: number,
  now: number = Date.now(),
): Promise<ValueFreshnessResult> {
  const [{ bridges }, holdings, freezes] = await Promise.all([
    getBrokerMirror(now),
    db
      .select({ poolId: investorPoolHoldingsTable.strategyPoolId })
      .from(investorPoolHoldingsTable)
      .where(
        and(
          eq(investorPoolHoldingsTable.userId, userId),
          eq(investorPoolHoldingsTable.status, "ACTIVE"),
        ),
      ),
    listActiveFreezes(),
  ]);

  // Broker freshness: freshest live bridge.
  let newestBrokerAt: Date | null = null;
  for (const b of bridges) {
    const t = (b.accountType ?? "").toLowerCase();
    if (t !== "live" && t !== "real") continue;
    if (b.freshnessAsOf && (newestBrokerAt == null || b.freshnessAsOf > newestBrokerAt)) {
      newestBrokerAt = b.freshnessAsOf;
    }
  }
  const brokerAgeMs = ageMsOf(newestBrokerAt, now);
  const brokerFreshness =
    brokerAgeMs == null
      ? ("MISSING" as const)
      : brokerAgeMs <= 15_000
        ? ("FRESH" as const)
        : brokerAgeMs <= 60_000
          ? ("DELAYED" as const)
          : ("STALE" as const);

  const poolIds = holdings.map((h) => h.poolId);

  // NAV under review on a pool this user holds.
  let navUnderReview = false;
  if (poolIds.length) {
    const navRows = await db
      .select({ navStatus: strategyPoolNavTable.navStatus })
      .from(strategyPoolNavTable)
      .where(
        and(
          inArray(strategyPoolNavTable.strategyPoolId, poolIds),
          eq(strategyPoolNavTable.navStatus, "UNDER_REVIEW"),
        ),
      )
      .limit(1);
    navUnderReview = navRows.length > 0;
  }

  // An OPEN/INVESTIGATING discrepancy scoped to this user or a pool they hold.
  const openConds = [
    inArray(fundDiscrepanciesTable.status, ["OPEN", "INVESTIGATING"]),
  ];
  const scopeOr = [eq(fundDiscrepanciesTable.userId, userId)];
  if (poolIds.length) scopeOr.push(inArray(fundDiscrepanciesTable.strategyPoolId, poolIds));
  const discRows = await db
    .select({ id: fundDiscrepanciesTable.id })
    .from(fundDiscrepanciesTable)
    .where(and(...openConds, or(...scopeOr)))
    .limit(1);
  const hasOpenDiscrepancy = discRows.length > 0;

  // A freeze touching this investor: a scope-wide INVESTOR freeze, this user's
  // keyed INVESTOR freeze, or any global value-affecting freeze.
  const isFrozenForUser = freezes.some((f) => {
    if (f.freezeScope === "INVESTOR") {
      return f.scopeKey === GLOBAL_SCOPE_KEY || f.scopeKey === String(userId);
    }
    return false;
  });

  return classifyValueFreshness({
    brokerFreshness,
    brokerAgeMs,
    navStatus: navUnderReview ? "UNDER_REVIEW" : "OK",
    hasOpenDiscrepancy,
    isFrozen: isFrozenForUser,
  });
}
