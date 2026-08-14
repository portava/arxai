// One-time operator reconciliation for OWNER / master phantom live positions.
//
// WHAT THIS IS: a thin, dry-run-first CLI wrapper around the EXISTING broker-
// absence decision engine + DB runner (`runBrokerAbsenceReconcile`). It is NOT
// a second close path. It reuses the same pure evidence engine
// (`findBrokerAbsentGhostPositionIds`), the same CAS guard, and writes the same
// `liveTradingAudit` BROKER_SIDE_CLOSE_RECONCILED row the auto-runner does.
//
// WHY IT EXISTS: the always-on auto-runner is deliberately gated OFF
// (BROKER_ABSENCE_AUTO_RECONCILE_ENABLED defaults false) and the admin endpoint
// refuses to write while the flag is off. Owner/master rows that the broker
// already closed therefore pile up as phantom OPEN exposure (closed_at NULL),
// dragging available allocation to 0. This script performs the explicit,
// human-initiated, bridge-scoped, audited apply for ONE user without flipping
// the global env flag or starting the background runner — it passes a local
// `{ ...policy, enabled: true }` override to the runner for this invocation only.
//
// SAFETY (inherited from the runner — nothing relaxed here):
//   - Sends NO broker/EA command. Only mirrors closes the broker already made.
//   - Stamps closed_at + reconcile_state=RECONCILED_BROKER_ABSENT under a CAS
//     guard that re-asserts ticket + first-absent + absence-count + bridge, so a
//     position the broker re-confirmed open between eval and write is skipped.
//   - REAL open positions (present in the latest snapshot → absence count reset
//     to 0) are blocked as ACCUMULATING_ABSENCE_EVIDENCE and never touched.
//   - In-flight ARX CLOSE tickets are protected (never raced).
//   - An unreliable/stale snapshot marker blocks ALL stamping (no current truth).
//   - Writes REQUIRE a concrete bridge scope (the runner enforces writeScopeOk).
//   - DRY-RUN by default; --apply is required to mutate. Idempotent: after apply
//     the open+unreconciled filter matches none, so a re-run stamps nothing.
//
// USAGE:
//   tsx src/scripts/reconcileOwnerPhantomLivePositions.ts --user=4            # dry-run
//   tsx src/scripts/reconcileOwnerPhantomLivePositions.ts --user=4 --apply    # auto-resolve bridge + apply
//   tsx src/scripts/reconcileOwnerPhantomLivePositions.ts --user=4 --bridge=446 --apply

import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db, arxLivePositionsTable, mt5ConnectionTable } from "@workspace/db";
import { brokerAbsenceAutoReconcilePolicy } from "../lib/live/brokerAbsencePolicy.js";
import {
  runBrokerAbsenceReconcile,
  type BrokerAbsenceReconcileResult,
} from "../lib/live/brokerAbsenceReconcileRunner.js";

interface Args {
  userId: number;
  bridgeConnectionId: number | null;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  let userId: number | null = null;
  let bridgeConnectionId: number | null = null;
  let apply = false;
  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--user=")) userId = Number(a.slice("--user=".length));
    else if (a.startsWith("--bridge=")) bridgeConnectionId = Number(a.slice("--bridge=".length));
  }
  if (userId == null || !Number.isFinite(userId)) {
    throw new Error("--user=<id> is required");
  }
  if (bridgeConnectionId != null && !Number.isFinite(bridgeConnectionId)) {
    throw new Error("--bridge must be a number when provided");
  }
  return { userId, bridgeConnectionId, apply };
}

// Resolve the user's freshest connected non-demo (live/real) bridge — the
// concrete scope the runner needs before it will write.
//
// NULLS LAST is critical: Postgres sorts NULLs FIRST under `DESC`, so a
// never-synced bridge (last_positions_snapshot_at IS NULL) would otherwise win
// over a live, recently-heartbeating bridge and the runner would scope to a
// connection with no truth (snapshotReliable=false → 0 candidates).
async function resolveLiveBridge(userId: number): Promise<number | null> {
  const rows = await db
    .select({ id: mt5ConnectionTable.id })
    .from(mt5ConnectionTable)
    .where(and(
      eq(mt5ConnectionTable.userId, userId),
      ne(mt5ConnectionTable.status, "revoked"),
      or(isNull(mt5ConnectionTable.accountType), ne(mt5ConnectionTable.accountType, "demo")),
    ))
    .orderBy(sql`${mt5ConnectionTable.lastPositionsSnapshotAt} DESC NULLS LAST`)
    .limit(1);
  return rows[0]?.id ?? null;
}

function printResult(label: string, r: BrokerAbsenceReconcileResult): void {
  console.log(`\n── ${label} ─────────────────────────────────────────────`);
  console.log(`scope            user=${r.scope.userId} bridge=${r.scope.bridgeConnectionId ?? "(unscoped)"}`);
  console.log(`snapshotReliable ${r.snapshotReliable}`);
  console.log(`dryRun           ${r.dryRun}`);
  console.log(`candidateCount   ${r.candidateCount}`);
  console.log(`safeToStamp      ${r.safeToStampCount}`);
  console.log(`blocked          ${r.blockedCount}`);
  console.log(`stamped          ${r.stampedCount}`);
  console.log(`candidateStates  ${JSON.stringify(r.candidateStates)}`);
  console.log(`blockedReasons   ${JSON.stringify(r.blockedReasons)}`);
  if (r.oldestCandidateAgeMs != null) {
    console.log(`oldestCandidate  ${Math.round(r.oldestCandidateAgeMs / 60000)} min absent`);
  }
  // Per-candidate one-liners (capped so a huge backlog stays readable).
  const preview = r.candidates.slice(0, 60);
  for (const c of preview) {
    console.log(
      `  pos ${c.positionId} ${c.symbol} ticket=${c.brokerTicket ?? "?"} ` +
      `absent=${c.absentSnapshotCount} state=${c.candidateState} ` +
      `${c.safeToStampClosed ? "SAFE_TO_STAMP" : `BLOCKED(${c.blockedReason ?? "?"})`}`,
    );
  }
  if (r.candidates.length > preview.length) {
    console.log(`  … +${r.candidates.length - preview.length} more`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Local enable override for THIS invocation only. Does not mutate the env, the
  // shared policy object, or start the background auto-runner.
  const enabledPolicy = { ...brokerAbsenceAutoReconcilePolicy, enabled: true };

  let bridgeConnectionId = args.bridgeConnectionId;
  if (args.apply && bridgeConnectionId == null) {
    bridgeConnectionId = await resolveLiveBridge(args.userId);
    if (bridgeConnectionId == null) {
      throw new Error(
        `No connected non-demo bridge found for user ${args.userId}; ` +
        `pass --bridge=<id> explicitly. Refusing to write without a concrete scope.`,
      );
    }
    console.log(`Auto-resolved live bridge for user ${args.userId}: connection ${bridgeConnectionId}`);
  }

  // 1) Always dry-run first (read-only) so the operator sees what WOULD change.
  const dry = await runBrokerAbsenceReconcile({
    userId: args.userId,
    bridgeConnectionId: bridgeConnectionId ?? args.bridgeConnectionId,
    dryRun: true,
    policy: enabledPolicy,
  });
  printResult("DRY RUN (no writes)", dry);

  if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to stamp the SAFE_TO_STAMP rows.");
    return;
  }

  // 2) Apply — stamps closed_at + reconcile_state on safe rows via the runner's
  //    CAS guard + audit. Bridge scope is mandatory (resolved above).
  const applied = await runBrokerAbsenceReconcile({
    userId: args.userId,
    bridgeConnectionId,
    dryRun: false,
    policy: enabledPolicy,
  });
  printResult("APPLY (stamped via runner CAS + audit)", applied);
  console.log(`\nDone. Stamped ${applied.stampedCount} broker-absent ghost(s) for user ${args.userId}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("reconcileOwnerPhantomLivePositions FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
