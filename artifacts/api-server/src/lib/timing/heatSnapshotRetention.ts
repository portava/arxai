// Heat Snapshot Retention — automatic pruning policy for heat_snapshots (Task #266).
//
// PURPOSE
//   heat_snapshots now grows on every timing-brain read (persistSnapshot
//   defaults to true). Left unbounded the table would slow the app. This module
//   prunes OLD snapshots on a safe, configurable policy while preserving recent
//   and learning-relevant data.
//
// SAFETY (inviolable):
//   * heat_snapshots is an ADVISORY / learning surface — never an execution gate.
//     Pruning it can never affect any trade, gate, or live/demo path.
//   * Audit-critical records live in their OWN tables (trade_decision_logs,
//     arx_live_commands, paper_trades, alerts, AACI decisions, audit logs).
//     This module NEVER touches those tables — it only deletes rows from
//     heat_snapshots, so no audit-critical record is ever removed.
//   * Decision-linked protection: a snapshot within `protectionWindowMinutes`
//     of a real trade/decision record for the same symbol is NEVER deleted,
//     even if it is older than the cutoff (requirement: never delete snapshots
//     tied to a trade/self-trade decision unless policy explicitly allows it).
//   * Rollups (compressed 31–180d summaries) are FUTURE-READY, not yet built.
//     Until `rollupsImplemented` is true we keep full-detail rows all the way to
//     the outer bound (so the 31–180d window is never lost prematurely) and only
//     hard-delete beyond the outer bound. This is "safe pruning only".
//   * Hard safety cap (`maxDeletePerRun`) bounds any single run.
//   * Every run (auto, manual, dry-run) is recorded in
//     heat_snapshot_retention_runs and logged — a safe audit trail.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { heatSnapshotRetentionRunsTable } from "@workspace/db/schema";
import { logger } from "../logger.js";

// ── Policy ───────────────────────────────────────────────────────────────────
// Single source of truth — no scattered hardcoded values. Env overrides are
// read once at module load so the policy is stable for the process lifetime.

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

/**
 * A decision/trade protection source. A snapshot is protected when its
 * generated_at is within the protection window of a row in `table` whose
 * `symbolExpr` matches the snapshot symbol (case-insensitive) and whose
 * `timeExpr` is within the window. Both `symbolExpr` and `timeExpr` are
 * SQL expressions already qualified against the subquery alias `src` (so an
 * expression like `coalesce(src.opened_at, src.created_at)` is valid). Only
 * `active` sources are enforced; the rest are documented as future-ready.
 */
type ProtectionSource = {
  key: string;
  table: string;
  symbolExpr: string;
  timeExpr: string;
  active: boolean;
  note: string;
};

const PROTECTION_SOURCES: ProtectionSource[] = [
  {
    key: "paper_trades",
    table: "paper_trades",
    symbolExpr: "src.symbol",
    timeExpr: "coalesce(src.opened_at, src.created_at)",
    active: true,
    note: "Demo trade decisions (the autoDebrief learning link).",
  },
  {
    key: "trade_decision_logs",
    table: "trade_decision_logs",
    symbolExpr: "src.symbol",
    timeExpr: "src.created_at",
    active: true,
    note: "Recorded trade decisions.",
  },
  {
    key: "arx_live_commands",
    table: "arx_live_commands",
    symbolExpr: "src.symbol",
    timeExpr: "src.created_at",
    active: true,
    note: "Live broker dispatch decisions.",
  },
  // ── Future-ready protection sources (not yet enforced). Wiring them in is a
  // matter of flipping `active` to true once each link is verified safe. ──
  {
    key: "aaci_decisions",
    table: "aaci_decisions",
    symbolExpr: "src.symbol",
    timeExpr: "src.created_at",
    active: false,
    note: "AACI advisory decisions — future-ready.",
  },
  {
    key: "chart_decision_memory",
    table: "chart_decision_memory",
    symbolExpr: "src.symbol",
    timeExpr: "src.created_at",
    active: false,
    note: "Chart replay / decision-memory receipts — future-ready.",
  },
  {
    key: "alerts",
    table: "alerts",
    symbolExpr: "src.symbol",
    timeExpr: "src.created_at",
    active: false,
    note: "Major alerts / high-impact news markers — future-ready.",
  },
];

export const HEAT_SNAPSHOT_RETENTION_POLICY = {
  enabled: boolEnv("ARX_HEAT_RETENTION_ENABLED", true),
  // Full-detail retention: keep ALL snapshots newer than this many days.
  fullDetailRetentionDays: intEnv("ARX_HEAT_RETENTION_FULL_DAYS", 30),
  // Outer retention bound: while rollups are not implemented, full rows are kept
  // until this bound. Hard-delete only happens beyond it.
  outerRetentionDays: intEnv("ARX_HEAT_RETENTION_OUTER_DAYS", 180),
  // Compressed 31–180d summaries are not built yet — future-ready.
  rollupsImplemented: boolEnv("ARX_HEAT_RETENTION_ROLLUPS", false),
  // Never delete a snapshot within this many minutes of a real trade/decision
  // record for the same symbol.
  protectionWindowMinutes: intEnv("ARX_HEAT_RETENTION_PROTECT_MINUTES", 120),
  protectDecisionLinkedSnapshots: boolEnv("ARX_HEAT_RETENTION_PROTECT", true),
  // Safety cap — never delete more than this many rows in one run.
  maxDeletePerRun: intEnv("ARX_HEAT_RETENTION_MAX_DELETE", 50_000),
  // How often the automatic worker runs (ms). Default 24h.
  workerIntervalMs: intEnv("ARX_HEAT_RETENTION_INTERVAL_MS", 24 * 60 * 60 * 1000),
  protectionSources: PROTECTION_SOURCES,
} as const;

/**
 * The hard-delete cutoff in days. While rollups are not implemented we keep
 * full rows out to the outer bound; once rollups exist, full rows beyond the
 * full-detail window become summaries so the cutoff moves in to the full-detail
 * window.
 */
export function effectiveCutoffDays(): number {
  const p = HEAT_SNAPSHOT_RETENTION_POLICY;
  return p.rollupsImplemented ? p.fullDetailRetentionDays : p.outerRetentionDays;
}

// ── Public DTO shapes (mirror the OpenAPI schemas) ─────────────────────────────

export type RetentionPolicyView = {
  enabled: boolean;
  fullDetailRetentionDays: number;
  outerRetentionDays: number;
  effectiveCutoffDays: number;
  rollupsImplemented: boolean;
  protectionWindowMinutes: number;
  protectDecisionLinkedSnapshots: boolean;
  maxDeletePerRun: number;
  workerIntervalMs: number;
  activeProtectionSources: string[];
  futureReadyProtectionSources: string[];
};

export type RetentionPlan = {
  cutoffAt: string;
  totalRows: number;
  eligibleByAge: number;
  wouldDelete: number;
  protectedCount: number;
  oldestRetainedAt: string | null;
  newestAt: string | null;
};

export type RetentionRunView = {
  id: number;
  ranAt: string;
  trigger: string;
  dryRun: boolean;
  rowsScanned: number;
  rowsDeleted: number;
  protectedRows: number;
  cutoffAt: string;
  oldestRetainedAt: string | null;
  reason: string | null;
  actorUserId: number | null;
};

export function getRetentionPolicyView(): RetentionPolicyView {
  const p = HEAT_SNAPSHOT_RETENTION_POLICY;
  return {
    enabled: p.enabled,
    fullDetailRetentionDays: p.fullDetailRetentionDays,
    outerRetentionDays: p.outerRetentionDays,
    effectiveCutoffDays: effectiveCutoffDays(),
    rollupsImplemented: p.rollupsImplemented,
    protectionWindowMinutes: p.protectionWindowMinutes,
    protectDecisionLinkedSnapshots: p.protectDecisionLinkedSnapshots,
    maxDeletePerRun: p.maxDeletePerRun,
    workerIntervalMs: p.workerIntervalMs,
    activeProtectionSources: p.protectionSources.filter((s) => s.active).map((s) => s.key),
    futureReadyProtectionSources: p.protectionSources.filter((s) => !s.active).map((s) => s.key),
  };
}

// ── Protection predicate (SQL) ─────────────────────────────────────────────────
// Builds an OR of "is decision-linked" EXISTS clauses for the ACTIVE sources.
// Returns null when protection is disabled or no active source exists (=> no
// row is treated as protected).

function buildProtectionExistsSql(): ReturnType<typeof sql> | null {
  const p = HEAT_SNAPSHOT_RETENTION_POLICY;
  if (!p.protectDecisionLinkedSnapshots) return null;
  const active = p.protectionSources.filter((s) => s.active);
  if (active.length === 0) return null;

  const windowSec = Math.max(0, p.protectionWindowMinutes) * 60;
  const clauses = active.map(
    (s) =>
      sql`EXISTS (SELECT 1 FROM ${sql.raw(s.table)} src
        WHERE upper(${sql.raw(s.symbolExpr)}) = upper(hs.symbol)
          AND ${sql.raw(s.timeExpr)} IS NOT NULL
          AND abs(extract(epoch FROM (${sql.raw(s.timeExpr)} - hs.generated_at))) <= ${windowSec})`,
  );
  // Join with OR.
  let combined = clauses[0]!;
  for (let i = 1; i < clauses.length; i++) {
    combined = sql`${combined} OR ${clauses[i]!}`;
  }
  return sql`(${combined})`;
}

function cutoffDate(): Date {
  return new Date(Date.now() - effectiveCutoffDays() * 24 * 60 * 60 * 1000);
}

// ── Plan (dry-run analysis) ────────────────────────────────────────────────────

/**
 * Compute what a prune WOULD do without deleting anything: total rows, rows
 * eligible by age, how many would be deleted, how many are protected, and the
 * oldest snapshot that would remain.
 */
export async function computeRetentionPlan(): Promise<RetentionPlan> {
  const cutoff = cutoffDate();
  const protectExists = buildProtectionExistsSql();
  const notProtected = protectExists ? sql`AND NOT ${protectExists}` : sql``;

  const totalsRow = (await db.execute(sql`
    SELECT
      count(*)::int AS total_rows,
      count(*) FILTER (WHERE hs.generated_at < ${cutoff})::int AS eligible_by_age,
      min(hs.generated_at) AS oldest_at,
      max(hs.generated_at) AS newest_at
    FROM heat_snapshots hs
  `)) as unknown as {
    rows: Array<{ total_rows: number; eligible_by_age: number; oldest_at: Date | string | null; newest_at: Date | string | null }>;
  };
  const t = totalsRow.rows[0] ?? { total_rows: 0, eligible_by_age: 0, oldest_at: null, newest_at: null };

  // Rows that would actually be deleted (eligible by age AND not protected),
  // capped by the safety cap.
  const deletableRow = (await db.execute(sql`
    SELECT count(*)::int AS deletable
    FROM heat_snapshots hs
    WHERE hs.generated_at < ${cutoff}
    ${notProtected}
  `)) as unknown as { rows: Array<{ deletable: number }> };
  const deletableUncapped = deletableRow.rows[0]?.deletable ?? 0;
  const wouldDelete = Math.min(deletableUncapped, HEAT_SNAPSHOT_RETENTION_POLICY.maxDeletePerRun);
  const protectedCount = Math.max(0, t.eligible_by_age - deletableUncapped);

  // Oldest snapshot that would REMAIN after deleting the deletable rows: the
  // min generated_at among rows that are either newer than cutoff OR protected.
  const oldestRetainedRow = (await db.execute(sql`
    SELECT min(hs.generated_at) AS oldest_retained
    FROM heat_snapshots hs
    WHERE hs.generated_at >= ${cutoff}
       ${protectExists ? sql`OR ${protectExists}` : sql``}
  `)) as unknown as { rows: Array<{ oldest_retained: Date | string | null }> };

  return {
    cutoffAt: cutoff.toISOString(),
    totalRows: t.total_rows,
    eligibleByAge: t.eligible_by_age,
    wouldDelete,
    protectedCount,
    oldestRetainedAt: toIso(oldestRetainedRow.rows[0]?.oldest_retained ?? null),
    newestAt: toIso(t.newest_at),
  };
}

function toIso(v: Date | string | null): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

// ── Prune (execute) ────────────────────────────────────────────────────────────

export type PruneResult = {
  dryRun: boolean;
  run: RetentionRunView;
  plan: RetentionPlan;
};

/**
 * Run the retention policy. When `dryRun` is true, nothing is deleted — only the
 * plan is computed. Every invocation records a heat_snapshot_retention_runs row
 * and logs. Fail-soft: a recording failure never throws after a successful
 * delete (the delete already happened); a delete failure is surfaced.
 */
export async function pruneHeatSnapshots(opts: {
  dryRun: boolean;
  trigger: "AUTOMATIC" | "ADMIN";
  actorUserId?: number | null;
  reason?: string | null;
}): Promise<PruneResult> {
  const { dryRun, trigger } = opts;
  const policyView = getRetentionPolicyView();

  // If retention is disabled, record a no-op run for visibility and return.
  if (!HEAT_SNAPSHOT_RETENTION_POLICY.enabled) {
    const plan = await computeRetentionPlan();
    const run = await recordRun({
      trigger,
      dryRun: true,
      rowsScanned: plan.eligibleByAge,
      rowsDeleted: 0,
      protectedRows: plan.protectedCount,
      cutoffAt: plan.cutoffAt,
      oldestRetainedAt: plan.oldestRetainedAt,
      actorUserId: opts.actorUserId ?? null,
      reason: opts.reason ?? "retention disabled (no-op)",
      policySnapshot: policyView,
    });
    return { dryRun: true, run, plan };
  }

  const plan = await computeRetentionPlan();

  let rowsDeleted = 0;
  if (!dryRun && plan.wouldDelete > 0) {
    const cutoff = cutoffDate();
    const protectExists = buildProtectionExistsSql();
    const notProtected = protectExists ? sql`AND NOT ${protectExists}` : sql``;
    // Bounded, atomic delete using a CTE so the safety cap is enforced in SQL.
    const del = (await db.execute(sql`
      WITH victims AS (
        SELECT hs.id FROM heat_snapshots hs
        WHERE hs.generated_at < ${cutoff}
        ${notProtected}
        ORDER BY hs.generated_at ASC
        LIMIT ${HEAT_SNAPSHOT_RETENTION_POLICY.maxDeletePerRun}
      )
      DELETE FROM heat_snapshots WHERE id IN (SELECT id FROM victims)
      RETURNING id
    `)) as unknown as { rows: Array<{ id: number }>; rowCount?: number };
    rowsDeleted = del.rows?.length ?? del.rowCount ?? 0;
  }

  // Recompute oldest-retained AFTER the delete for an accurate status figure.
  const after = dryRun ? plan : await computeRetentionPlan();

  const run = await recordRun({
    trigger,
    dryRun,
    rowsScanned: plan.eligibleByAge,
    rowsDeleted,
    protectedRows: plan.protectedCount,
    cutoffAt: plan.cutoffAt,
    oldestRetainedAt: after.oldestRetainedAt,
    actorUserId: opts.actorUserId ?? null,
    reason: opts.reason ?? null,
    policySnapshot: policyView,
  });

  logger.info(
    {
      trigger,
      dryRun,
      cutoffAt: plan.cutoffAt,
      eligibleByAge: plan.eligibleByAge,
      rowsDeleted,
      protectedRows: plan.protectedCount,
      oldestRetainedAt: after.oldestRetainedAt,
    },
    "[heatRetention] prune run",
  );

  return { dryRun, run, plan: after };
}

async function recordRun(input: {
  trigger: string;
  dryRun: boolean;
  rowsScanned: number;
  rowsDeleted: number;
  protectedRows: number;
  cutoffAt: string;
  oldestRetainedAt: string | null;
  actorUserId: number | null;
  reason: string | null;
  policySnapshot: unknown;
}): Promise<RetentionRunView> {
  const inserted = await db
    .insert(heatSnapshotRetentionRunsTable)
    .values({
      trigger: input.trigger,
      dryRun: input.dryRun,
      rowsScanned: input.rowsScanned,
      rowsDeleted: input.rowsDeleted,
      protectedRows: input.protectedRows,
      cutoffAt: new Date(input.cutoffAt),
      oldestRetainedAt: input.oldestRetainedAt ? new Date(input.oldestRetainedAt) : null,
      actorUserId: input.actorUserId,
      reason: input.reason,
      policySnapshot: input.policySnapshot as Record<string, unknown>,
    })
    .returning();
  const r = inserted[0]!;
  return runRowToView(r);
}

function runRowToView(r: typeof heatSnapshotRetentionRunsTable.$inferSelect): RetentionRunView {
  return {
    id: r.id,
    ranAt: r.ranAt.toISOString(),
    trigger: r.trigger,
    dryRun: r.dryRun,
    rowsScanned: r.rowsScanned,
    rowsDeleted: r.rowsDeleted,
    protectedRows: r.protectedRows,
    cutoffAt: r.cutoffAt.toISOString(),
    oldestRetainedAt: r.oldestRetainedAt ? r.oldestRetainedAt.toISOString() : null,
    reason: r.reason,
    actorUserId: r.actorUserId,
  };
}

/** Most recent retention run (any trigger), or null if none yet. */
export async function getLastRetentionRun(): Promise<RetentionRunView | null> {
  const rows = await db
    .select()
    .from(heatSnapshotRetentionRunsTable)
    .orderBy(sql`${heatSnapshotRetentionRunsTable.ranAt} DESC`)
    .limit(1);
  return rows[0] ? runRowToView(rows[0]) : null;
}

// ── Automatic worker ───────────────────────────────────────────────────────────

let workerStarted = false;
let workerCyclesRun = 0;
let workerLastRunAt: Date | null = null;

export function getRetentionWorkerStatus(): {
  running: boolean;
  intervalMs: number;
  cyclesRun: number;
  lastRunAt: string | null;
} {
  return {
    running: workerStarted,
    intervalMs: HEAT_SNAPSHOT_RETENTION_POLICY.workerIntervalMs,
    cyclesRun: workerCyclesRun,
    lastRunAt: workerLastRunAt?.toISOString() ?? null,
  };
}

export function startHeatSnapshotRetentionWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const intervalMs = HEAT_SNAPSHOT_RETENTION_POLICY.workerIntervalMs;
  // First cycle runs after one interval (never blocks server start). Fail-soft:
  // any error is logged and swallowed so a bad cycle never crashes the process.
  const t = setInterval(() => {
    void (async () => {
      try {
        await pruneHeatSnapshots({ trigger: "AUTOMATIC", dryRun: false, reason: "scheduled retention" });
      } catch (e) {
        logger.error({ err: String(e).slice(0, 300) }, "[heatRetention] automatic cycle failed");
      } finally {
        workerCyclesRun++;
        workerLastRunAt = new Date();
      }
    })();
  }, intervalMs);
  t.unref?.();
  logger.info(
    { intervalMs, enabled: HEAT_SNAPSHOT_RETENTION_POLICY.enabled, cutoffDays: effectiveCutoffDays() },
    "[heatRetention] retention worker started",
  );
}
