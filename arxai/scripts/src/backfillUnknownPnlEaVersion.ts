// One-off, idempotent backfill that populates the `reported_ea_version`
// column on historical `trades` rows whose P/L is untrustworthy
// (pnlStatus='UNKNOWN') but whose EA version was never recorded
// (reported_ea_version IS NULL).
//
// WHY:
//   The `reported_ea_version` column on `trades` is only written for closes
//   that happen AFTER the column was introduced (see
//   artifacts/api-server/src/routes/trades.ts TRADE_CLOSE handler). Rows that
//   went UNKNOWN before that change carry a null EA version, so the Trade Logs
//   "upgrade to v1.28" nudge always fires for them (null is treated as
//   "too old"). That is SAFE but noisy — some of those rows may have actually
//   been closed by a modern EA. This backfill fills the EA version in ONLY
//   where it can be inferred from genuinely historical, time-bracketed
//   evidence, and leaves the rest null (so the nudge keeps showing only where
//   we genuinely don't know).
//
// RELIABLE INFERENCE — per trade, scoped to the trade's own userId AND time:
//   The ONLY trustworthy historical source is
//   `arx_live_test_cycles.reported_ea_version`, which captures the EA version
//   at the moment a live test cycle COMPLETED (a real timestamped event).
//   (We deliberately do NOT use `mt5_connection.ea_version` — that is a
//   mutable "latest heartbeat" snapshot, overwritten on every heartbeat, and
//   carries no trade-time history.)
//
//   For a candidate trade with a known `closed_at`, we look at the user's
//   completed cycles that carry a non-null reported_ea_version + completed_at:
//     - the latest cycle that completed AT OR BEFORE the trade closed, and
//     - the earliest cycle that completed AT OR AFTER the trade closed.
//   We fill the trade's EA version ONLY when BOTH exist AND report the SAME
//   version. That brackets the trade in time with identical evidence on both
//   sides, proving the EA version did not change across that window — so the
//   trade was closed by exactly that version. Any other case (no before, no
//   after, version changed across the window, or no `closed_at`) is left null.
//   This rule cannot introduce a false positive.
//
// SAFETY:
//   - Touches ONLY the `trades` table, and ONLY rows where pnlStatus='UNKNOWN'
//     AND reported_ea_version IS NULL. Never reads/writes any COMPUTED row.
//   - Only ever writes the `reported_ea_version` column. Never touches pnl,
//     pnlStatus, status, dataQualityFlag, or any other field. The untrusted
//     P/L stays untrusted.
//   - Never deletes any row. Never mutates live-test-cycles, connections,
//     audit tables, or broker history.
//   - DRY-RUN BY DEFAULT: prints exactly what it would do and writes nothing.
//     Pass `--apply` (or `--confirm`) to actually write.
//   - Idempotent: after an apply run the filled rows have a non-null
//     reported_ea_version, so the reported_ea_version IS NULL filter excludes
//     them on every subsequent run.
//
// RUN:
//   pnpm --filter @workspace/scripts run backfill:unknown-pnl-ea-version
//   pnpm --filter @workspace/scripts run backfill:unknown-pnl-ea-version -- --apply

import { and, eq, isNull, isNotNull, inArray } from "drizzle-orm";
import {
  db, tradesTable, arxLiveTestCyclesTable,
} from "@workspace/db";

const APPLY = process.argv.slice(2).some((a) => a === "--apply" || a === "--confirm");

function log(line: string) {
  // eslint-disable-next-line no-console
  console.log(line);
}

type CycleEvidence = { version: string; completedAt: Date };

async function main() {
  const mode = APPLY ? "APPLY" : "DRY-RUN";
  log(`[backfillUnknownPnlEaVersion] Mode: ${mode}`);

  // Candidates: untrusted P/L with no recorded EA version.
  const candidates = await db.select().from(tradesTable).where(and(
    eq(tradesTable.pnlStatus, "UNKNOWN"),
    isNull(tradesTable.reportedEaVersion),
  ));

  if (candidates.length === 0) {
    log("[backfillUnknownPnlEaVersion] No UNKNOWN rows with a null EA version. ✓");
    return;
  }

  // Distinct userIds we need trustworthy EA-version evidence for.
  const userIds = Array.from(
    new Set(candidates.map((t) => t.userId).filter((u): u is number => u != null)),
  );

  // Per-user, time-ordered cycle evidence (only rows with BOTH a non-null
  // reported_ea_version and a completed_at timestamp — both are required for
  // time-bracketing).
  const evidenceByUser = new Map<number, CycleEvidence[]>();
  if (userIds.length > 0) {
    const cycles = await db.select({
      userId: arxLiveTestCyclesTable.userId,
      reportedEaVersion: arxLiveTestCyclesTable.reportedEaVersion,
      completedAt: arxLiveTestCyclesTable.completedAt,
    }).from(arxLiveTestCyclesTable).where(and(
      inArray(arxLiveTestCyclesTable.userId, userIds),
      isNotNull(arxLiveTestCyclesTable.reportedEaVersion),
      isNotNull(arxLiveTestCyclesTable.completedAt),
    ));
    for (const c of cycles) {
      const version = c.reportedEaVersion?.trim();
      if (!version || !c.completedAt) continue;
      const bucket = evidenceByUser.get(c.userId) ?? [];
      bucket.push({ version, completedAt: c.completedAt });
      evidenceByUser.set(c.userId, bucket);
    }
    for (const bucket of evidenceByUser.values()) {
      bucket.sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime());
    }
  }

  // Resolve per trade with strict time-bracketing.
  type Resolution = { trade: typeof candidates[number]; version: string };
  const toFill: Resolution[] = [];
  let skippedNoUser = 0;
  let skippedNoClosedAt = 0;
  let skippedNoEvidence = 0;
  let skippedNotBracketed = 0;
  let skippedVersionChanged = 0;

  for (const trade of candidates) {
    if (trade.userId == null) { skippedNoUser += 1; continue; }
    if (trade.closedAt == null) { skippedNoClosedAt += 1; continue; }
    const evidence = evidenceByUser.get(trade.userId);
    if (!evidence || evidence.length === 0) { skippedNoEvidence += 1; continue; }

    const closedMs = trade.closedAt.getTime();
    // Latest cycle completed at or before the trade close.
    let before: CycleEvidence | null = null;
    // Earliest cycle completed at or after the trade close.
    let after: CycleEvidence | null = null;
    for (const ev of evidence) {
      const evMs = ev.completedAt.getTime();
      if (evMs <= closedMs) before = ev;          // evidence is time-sorted ascending
      if (evMs >= closedMs && after === null) after = ev;
    }

    if (!before || !after) { skippedNotBracketed += 1; continue; }
    if (before.version !== after.version) { skippedVersionChanged += 1; continue; }
    toFill.push({ trade, version: before.version });
  }

  log(
    `[backfillUnknownPnlEaVersion] Inspected ${candidates.length} UNKNOWN/null-EA row(s).`,
  );
  log("[backfillUnknownPnlEaVersion] Outcome breakdown:");
  log(`    fillable (time-bracketed, same version) : ${toFill.length}`);
  log(`    left null — no userId                    : ${skippedNoUser}`);
  log(`    left null — no closed_at timestamp       : ${skippedNoClosedAt}`);
  log(`    left null — no cycle evidence for user   : ${skippedNoEvidence}`);
  log(`    left null — trade not bracketed in time  : ${skippedNotBracketed}`);
  log(`    left null — EA version changed in window  : ${skippedVersionChanged}`);

  for (const { trade, version } of toFill) {
    log(
      `  ${APPLY ? "✓" : "•"} trade #${trade.id} user=${trade.userId} `
      + `${trade.symbol} ${trade.status} closedAt=${trade.closedAt?.toISOString()} `
      + `reportedEaVersion: null → ${version}`,
    );
    if (APPLY) {
      // Guard the WHERE with the same untrusted+null predicate so a concurrent
      // close that already set a value (or flipped pnlStatus) is never
      // overwritten.
      await db.update(tradesTable).set({
        reportedEaVersion: version,
      }).where(and(
        eq(tradesTable.id, trade.id),
        eq(tradesTable.pnlStatus, "UNKNOWN"),
        isNull(tradesTable.reportedEaVersion),
      ));
    }
  }

  if (!APPLY) {
    log(
      `[backfillUnknownPnlEaVersion] DRY-RUN complete. Would fill ${toFill.length} row(s). `
      + "Re-run with `-- --apply` to write.",
    );
  } else {
    log(`[backfillUnknownPnlEaVersion] Done. Filled ${toFill.length} row(s).`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error("[backfillUnknownPnlEaVersion] FAILED:", err);
    process.exit(1);
  },
);
