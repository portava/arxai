// Test: EA-version backfill inference rules
// (scripts/src/backfillUnknownPnlEaVersion.ts).
//
// The backfill fills `trades.reported_ea_version` for untrustworthy rows
// (pnlStatus='UNKNOWN', reported_ea_version IS NULL) ONLY when the user's
// completed live-test-cycles bracket the trade's close time in BOTH
// directions with the SAME EA version. It must:
//   - fill a trade whose close is time-bracketed by a unanimous version,
//   - leave a trade null when the bracketing cycles disagree on version,
//   - leave a trade null when the user has no cycle evidence at all
//     (even if an mt5_connection carries an EA version — that source is
//     deliberately NOT trusted; it is a mutable latest-heartbeat snapshot),
//   - leave a trade null when it has no userId,
//   - NEVER touch a trusted (pnlStatus='COMPUTED') row.
//
// HOW THE TEST PROVES IT:
//   Seeds an isolated set of users + trades + live-test-cycles +
//   mt5_connections, runs the REAL backfill script as a subprocess (first
//   in default DRY-RUN, then with --apply), and asserts the exact per-row
//   outcome by primary key. The DRY-RUN must write nothing; the apply must
//   fill exactly the one fillable row and leave every other case null, with
//   the COMPUTED row's reported_ea_version and pnlStatus both untouched.
//
// SAFETY / ISOLATION:
//   - All seeded users are isSystemUser=true with fixed @arx.test emails.
//   - Idempotent: deletes any leftover seeded rows at start, and cleans up
//     (trades, cycles, connections, users) at the end even on failure,
//     tracking the null-userId trade by primary key (it cannot be cleaned
//     by user join). Follows the project's seed-then-delete baseline
//     convention for persistent tables.
//   - Reads/writes ONLY the seeded rows; never deletes anyone else's data.
//
// Run: pnpm --filter @workspace/scripts run test:backfill-ea-version

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  tradesTable,
  arxLiveTestCyclesTable,
  mt5ConnectionTable,
} from "@workspace/db";

const EMAIL_FILL = "qa+backfill-ea-fill@arx.test";
const EMAIL_CONFLICT = "qa+backfill-ea-conflict@arx.test";
const EMAIL_NOSOURCE = "qa+backfill-ea-nosource@arx.test";
const ALL_EMAILS = [EMAIL_FILL, EMAIL_CONFLICT, EMAIL_NOSOURCE];

const SCRIPT = fileURLToPath(new URL("./backfillUnknownPnlEaVersion.ts", import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "../..");

let passes = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  \u2717 ${label}`);
  }
}

// The null-userId trade cannot be removed by a user join, so we track it by id.
let nullUserTradeId: number | null = null;

async function cleanup(): Promise<void> {
  const users = await db.select().from(usersTable).where(inArray(usersTable.email, ALL_EMAILS));
  const userIds = users.map((u) => u.id);
  if (userIds.length > 0) {
    await db.delete(tradesTable).where(inArray(tradesTable.userId, userIds));
    await db.delete(arxLiveTestCyclesTable).where(inArray(arxLiveTestCyclesTable.userId, userIds));
    await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  if (nullUserTradeId != null) {
    await db.delete(tradesTable).where(eq(tradesTable.id, nullUserTradeId));
    nullUserTradeId = null;
  }
}

function runBackfill(apply: boolean): string {
  const args = ["tsx", SCRIPT, ...(apply ? ["--apply"] : [])];
  return execFileSync("npx", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
  });
}

async function reportedEaVersionOf(id: number): Promise<string | null | undefined> {
  const rows = await db.select({
    v: tradesTable.reportedEaVersion,
  }).from(tradesTable).where(eq(tradesTable.id, id));
  return rows[0]?.v;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("backfillUnknownPnlEaVersionTest");
  // eslint-disable-next-line no-console
  console.log("===============================\n");

  await cleanup();

  // Fixed close time bracketed by cycles 1h before/after.
  const closeAt = new Date("2026-01-15T12:00:00.000Z");
  const before = new Date(closeAt.getTime() - 60 * 60 * 1000);
  const after = new Date(closeAt.getTime() + 60 * 60 * 1000);

  // ── Seed users ─────────────────────────────────────────────────────────
  const [userFill] = await db.insert(usersTable).values({
    email: EMAIL_FILL, name: "QA Backfill Fill", role: "USER", isSystemUser: true,
  }).returning();
  const [userConflict] = await db.insert(usersTable).values({
    email: EMAIL_CONFLICT, name: "QA Backfill Conflict", role: "USER", isSystemUser: true,
  }).returning();
  const [userNoSource] = await db.insert(usersTable).values({
    email: EMAIL_NOSOURCE, name: "QA Backfill NoSource", role: "USER", isSystemUser: true,
  }).returning();

  const tradeBase = {
    symbol: "EURUSD",
    direction: "BUY" as const,
    lot: 0.01,
    entryPrice: 1.05,
    stopLoss: 1.04,
    takeProfit: 1.07,
    strategy: "Trend Continuation",
    confidence: 80,
    mode: "LIVE" as const,
    status: "CLOSED_WIN",
  };

  // ── Case 1: unanimous version → FILLS with 1.28 ────────────────────────
  const [tradeFill] = await db.insert(tradesTable).values({
    ...tradeBase, userId: userFill!.id,
    pnl: null, pnlStatus: "UNKNOWN", dataQualityFlag: "MISSING_CLOSE_FILL_PRICE",
    reportedEaVersion: null, closedAt: closeAt,
  }).returning();

  // ── Case 5: trusted COMPUTED row for the SAME user → NEVER touched ──────
  // Even though this user's cycles unanimously bracket this row's close, the
  // candidate filter is pnlStatus='UNKNOWN', so a COMPUTED row is invisible.
  const [tradeComputed] = await db.insert(tradesTable).values({
    ...tradeBase, userId: userFill!.id,
    pnl: 12.34, pnlStatus: "COMPUTED", dataQualityFlag: null,
    reportedEaVersion: null, closedAt: closeAt,
  }).returning();

  const cycleBase = {
    symbol: "EURUSD", side: "BUY", requestedVolume: 0.01, stopLoss: 1.04,
    status: "COMPLETED", pnlStatus: "COMPUTED",
  };
  // userFill: both bracketing cycles report 1.28.
  await db.insert(arxLiveTestCyclesTable).values([
    { ...cycleBase, cycleId: `qa-fill-before-${Date.now()}`, userId: userFill!.id, reportedEaVersion: "1.28", completedAt: before },
    { ...cycleBase, cycleId: `qa-fill-after-${Date.now()}`, userId: userFill!.id, reportedEaVersion: "1.28", completedAt: after },
  ]);

  // ── Case 2: conflicting versions → left null ───────────────────────────
  const [tradeConflict] = await db.insert(tradesTable).values({
    ...tradeBase, userId: userConflict!.id,
    pnl: null, pnlStatus: "UNKNOWN", dataQualityFlag: "MISSING_CLOSE_FILL_PRICE",
    reportedEaVersion: null, closedAt: closeAt,
  }).returning();
  await db.insert(arxLiveTestCyclesTable).values([
    { ...cycleBase, cycleId: `qa-conflict-before-${Date.now()}`, userId: userConflict!.id, reportedEaVersion: "1.27", completedAt: before },
    { ...cycleBase, cycleId: `qa-conflict-after-${Date.now()}`, userId: userConflict!.id, reportedEaVersion: "1.28", completedAt: after },
  ]);

  // ── Case 3: no cycle evidence → left null (connection EA NOT trusted) ───
  const [tradeNoSource] = await db.insert(tradesTable).values({
    ...tradeBase, userId: userNoSource!.id,
    pnl: null, pnlStatus: "UNKNOWN", dataQualityFlag: "MISSING_CLOSE_FILL_PRICE",
    reportedEaVersion: null, closedAt: closeAt,
  }).returning();
  // A connection that DOES carry an EA version — the backfill must ignore it.
  await db.insert(mt5ConnectionTable).values({
    userId: userNoSource!.id, eaVersion: "1.29",
  });

  // ── Case 4: null userId → left null ────────────────────────────────────
  const [tradeNullUser] = await db.insert(tradesTable).values({
    ...tradeBase, userId: null,
    pnl: null, pnlStatus: "UNKNOWN", dataQualityFlag: "MISSING_CLOSE_FILL_PRICE",
    reportedEaVersion: null, closedAt: closeAt,
  }).returning();
  nullUserTradeId = tradeNullUser!.id;

  // ── DRY-RUN: must write nothing ────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("DRY-RUN (default) — writes nothing");
  runBackfill(false);
  assert(await reportedEaVersionOf(tradeFill!.id) === null, "fillable row still null after dry-run");
  assert(await reportedEaVersionOf(tradeConflict!.id) === null, "conflicting row still null after dry-run");
  assert(await reportedEaVersionOf(tradeNoSource!.id) === null, "no-source row still null after dry-run");
  assert(await reportedEaVersionOf(tradeNullUser!.id) === null, "null-userId row still null after dry-run");
  assert(await reportedEaVersionOf(tradeComputed!.id) === null, "COMPUTED row still null after dry-run");

  // ── APPLY: fills exactly the one bracketed, unanimous row ───────────────
  // eslint-disable-next-line no-console
  console.log("\nAPPLY (--apply) — fills exactly the expected rows");
  runBackfill(true);
  assert(await reportedEaVersionOf(tradeFill!.id) === "1.28", "fillable row filled with 1.28");
  assert(await reportedEaVersionOf(tradeConflict!.id) === null, "conflicting-version row left null");
  assert(await reportedEaVersionOf(tradeNoSource!.id) === null, "no-source row left null (connection EA ignored)");
  assert(await reportedEaVersionOf(tradeNullUser!.id) === null, "null-userId row left null");

  // The COMPUTED row must be entirely untouched: version still null AND
  // its trusted status unchanged.
  const computedAfter = await db.select({
    v: tradesTable.reportedEaVersion,
    s: tradesTable.pnlStatus,
    p: tradesTable.pnl,
  }).from(tradesTable).where(eq(tradesTable.id, tradeComputed!.id));
  assert(computedAfter[0]?.v === null, "COMPUTED row reported_ea_version still null (never touched)");
  assert(computedAfter[0]?.s === "COMPUTED", "COMPUTED row pnlStatus unchanged");
  assert(computedAfter[0]?.p === 12.34, "COMPUTED row pnl unchanged");

  // ── IDEMPOTENT: a second apply changes nothing for our rows ────────────
  // eslint-disable-next-line no-console
  console.log("\nAPPLY again — idempotent, no further change");
  runBackfill(true);
  assert(await reportedEaVersionOf(tradeFill!.id) === "1.28", "fillable row stays 1.28 on re-apply");
  assert(await reportedEaVersionOf(tradeConflict!.id) === null, "conflicting row stays null on re-apply");

  await cleanup();

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  async (err) => {
    await cleanup().catch(() => {});
    // eslint-disable-next-line no-console
    console.error("[backfillUnknownPnlEaVersionTest] FAILED:", err);
    process.exit(1);
  },
);
