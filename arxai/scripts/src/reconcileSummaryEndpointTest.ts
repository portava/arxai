// reconcileSummaryEndpointTest — locks in the behaviour of the read-only
// operator endpoint GET /api/admin/live-positions/reconcile-summary
// (handler: artifacts/api-server/src/routes/adminAllocations.ts).
//
// That endpoint separates genuinely-open live exposure (reconcile_state IS
// NULL) from already-resolved "ghost" rows (IGNORED / EXTERNAL / IMPORTED /
// other), grouped per user, so operators can spot ghost accumulation. There
// was no automated test, so a future change to the grouping logic or the
// admin gate could silently regress it. This test pins both.
//
// WHAT IT PROVES
//   Grouping/maths (over freshly-created, fully-isolated data users):
//     - totalOpen counts every OPEN row regardless of reconcile_state
//     - genuineOpen counts ONLY reconcile_state IS NULL
//     - reconciledCount counts every non-null reconcile_state
//     - byState buckets IGNORED / EXTERNAL / IMPORTED exactly, and any other
//       non-null state (e.g. RECONCILED_BROKER_ABSENT) lands in OTHER
//     - CLOSED rows (closed_at set) are excluded entirely
//   Auth gate (the requireAdmin contract):
//     - no session            -> 401
//     - normal USER session   -> 403
//     - ADMIN session         -> 200
//     - OWNER session         -> 200
//     - an admin reviewing per-user data (role intact) is treated as admin —
//       requireAdmin keys on the session's real role, so an operator
//       "previewing" any user's reconciliation rows still passes the gate.
//
// SHARED-DB SAFETY
//   arx_live_positions is a persistent evidence table shared with whatever
//   real rows already exist. We therefore:
//     - take a BASELINE summary read BEFORE seeding and assert the DELTA after
//       seeding for the GLOBAL summary totals (never `== 0` against the table)
//     - assert the freshly-created data users' per-user rows ABSOLUTELY (they
//       did not exist before this run, so their counts are fully attributable)
//   Seeds only isolated isSystemUser rows at fixed emails; cleans everything
//   (positions, sessions, users) in a `finally`, idempotent on rerun. Never
//   places a trade, never inserts an arx_live_command, never reaches the EA.
//
// Run: pnpm --filter @workspace/scripts run test:reconcile-summary-endpoint

import { randomBytes, createHash } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { db, usersTable, authUserSessionsTable, arxLivePositionsTable } from "@workspace/db";
import { getSharedBaseUrl, isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const EMAIL_PREFIX = "qa+reconcile-summary";
const DATA_U1_EMAIL = `${EMAIL_PREFIX}-data1@arx.test`;
const DATA_U2_EMAIL = `${EMAIL_PREFIX}-data2@arx.test`;
const ADMIN_EMAIL = `${EMAIL_PREFIX}-admin@arx.test`;
const OWNER_EMAIL = `${EMAIL_PREFIX}-owner@arx.test`;
const USER_EMAIL = `${EMAIL_PREFIX}-user@arx.test`;
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_COOKIE = "arx_user_session";

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

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function mintSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1",
    userAgent: "qa-reconcile-summary-endpoint",
  });
  return raw;
}

async function cleanup(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable)
    .where(like(usersTable.email, `${EMAIL_PREFIX}%`));
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await db.delete(arxLivePositionsTable).where(inArray(arxLivePositionsTable.userId, ids));
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
}

type ByState = { IGNORED: number; EXTERNAL: number; IMPORTED: number; OTHER: number };
type PerUser = {
  userId: number;
  totalOpen: number;
  genuineOpen: number;
  reconciledCount: number;
  byState: ByState;
};
type SummaryBody = {
  ok?: boolean;
  users?: PerUser[];
  summary?: { totalOpen: number; genuineOpen: number; reconciledCount: number; userCount: number };
};

async function getSummary(base: string, cookie: string | null): Promise<{ status: number; body: SummaryBody }> {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = `${SESSION_COOKIE}=${cookie}`;
  const r = await fetch(`${base}/api/admin/live-positions/reconcile-summary`, { headers });
  let body: SummaryBody = {};
  try { body = (await r.json()) as SummaryBody; } catch { body = {}; }
  return { status: r.status, body };
}

async function insertPosition(
  userId: number,
  ticket: string,
  reconcileState: string | null,
  closed: boolean,
): Promise<void> {
  const now = new Date();
  await db.insert(arxLivePositionsTable).values({
    userId,
    bridgeConnectionId: 999_000, // arbitrary; no FK on this column
    brokerTicket: ticket,
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.01,
    entryPrice: 1.05,
    floatingPl: 0,
    openedAt: now,
    closedAt: closed ? now : null,
    reconcileState,
  });
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("reconcileSummaryEndpointTest");
  // eslint-disable-next-line no-console
  console.log("============================\n");

  await cleanup();
  const base = await getSharedBaseUrl();

  try {
    // ── Seed requester accounts (no positions of their own) ────────────────
    const [adminUser] = await db.insert(usersTable).values({
      email: ADMIN_EMAIL, name: "QA Reconcile Admin", role: "ADMIN", isSystemUser: true,
    }).returning();
    const [ownerUser] = await db.insert(usersTable).values({
      email: OWNER_EMAIL, name: "QA Reconcile Owner", role: "OWNER", isSystemUser: true,
    }).returning();
    const [normalUser] = await db.insert(usersTable).values({
      email: USER_EMAIL, name: "QA Reconcile User", role: "USER", isSystemUser: true,
    }).returning();
    // ── Seed two isolated DATA users whose positions we assert on ──────────
    const [u1] = await db.insert(usersTable).values({
      email: DATA_U1_EMAIL, name: "QA Reconcile Data1", role: "USER", isSystemUser: true,
    }).returning();
    const [u2] = await db.insert(usersTable).values({
      email: DATA_U2_EMAIL, name: "QA Reconcile Data2", role: "USER", isSystemUser: true,
    }).returning();
    if (!adminUser || !ownerUser || !normalUser || !u1 || !u2) {
      throw new Error("requester/data user creation failed");
    }

    // ── BASELINE summary BEFORE seeding any positions ──────────────────────
    const adminCookie = await mintSession(adminUser.id);
    const ownerCookie = await mintSession(ownerUser.id);
    const userCookie = await mintSession(normalUser.id);

    const baseline = await getSummary(base, adminCookie);
    assert(baseline.status === 200 && baseline.body.ok === true, "baseline admin read ok (200)");
    const b = baseline.body.summary ?? { totalOpen: 0, genuineOpen: 0, reconciledCount: 0, userCount: 0 };
    // Fresh data users have no rows yet, so they must be absent pre-seed.
    const preSeedHasU1 = (baseline.body.users ?? []).some((x) => x.userId === u1.id);
    const preSeedHasU2 = (baseline.body.users ?? []).some((x) => x.userId === u2.id);
    assert(!preSeedHasU1 && !preSeedHasU2, "data users absent from summary before seeding");

    // ── Seed positions ────────────────────────────────────────────────────
    // U1: 2 NULL(open), 3 IGNORED(open), 1 EXTERNAL(open), 1 IMPORTED(open),
    //     + 1 NULL(closed) + 1 IGNORED(closed) -> both closed rows EXCLUDED.
    //   expected: totalOpen 7, genuineOpen 2, reconciled 5,
    //             byState {IGNORED 3, EXTERNAL 1, IMPORTED 1, OTHER 0}
    await insertPosition(u1.id, "QA-RS-U1-N1", null, false);
    await insertPosition(u1.id, "QA-RS-U1-N2", null, false);
    await insertPosition(u1.id, "QA-RS-U1-IG1", "IGNORED", false);
    await insertPosition(u1.id, "QA-RS-U1-IG2", "IGNORED", false);
    await insertPosition(u1.id, "QA-RS-U1-IG3", "IGNORED", false);
    await insertPosition(u1.id, "QA-RS-U1-EX1", "EXTERNAL", false);
    await insertPosition(u1.id, "QA-RS-U1-IM1", "IMPORTED", false);
    await insertPosition(u1.id, "QA-RS-U1-CN1", null, true);
    await insertPosition(u1.id, "QA-RS-U1-CIG1", "IGNORED", true);

    // U2: 1 NULL(open), 2 IMPORTED(open), 1 RECONCILED_BROKER_ABSENT(open ->
    //     OTHER bucket) + 1 NULL(closed -> EXCLUDED).
    //   expected: totalOpen 4, genuineOpen 1, reconciled 3,
    //             byState {IGNORED 0, EXTERNAL 0, IMPORTED 2, OTHER 1}
    await insertPosition(u2.id, "QA-RS-U2-N1", null, false);
    await insertPosition(u2.id, "QA-RS-U2-IM1", "IMPORTED", false);
    await insertPosition(u2.id, "QA-RS-U2-IM2", "IMPORTED", false);
    await insertPosition(u2.id, "QA-RS-U2-RBA1", "RECONCILED_BROKER_ABSENT", false);
    await insertPosition(u2.id, "QA-RS-U2-CN1", null, true);

    // ── Re-read as admin AFTER seeding ─────────────────────────────────────
    const after = await getSummary(base, adminCookie);
    assert(after.status === 200 && after.body.ok === true, "post-seed admin read ok (200)");
    const a = after.body.summary ?? { totalOpen: 0, genuineOpen: 0, reconciledCount: 0, userCount: 0 };
    const users = after.body.users ?? [];

    // Per-user ABSOLUTE assertions (data users are fully isolated).
    const ru1 = users.find((x) => x.userId === u1.id);
    const ru2 = users.find((x) => x.userId === u2.id);
    assert(!!ru1, "U1 present in summary after seeding");
    assert(!!ru2, "U2 present in summary after seeding");

    if (ru1) {
      assert(ru1.totalOpen === 7, `U1 totalOpen=7 (open rows only, 2 closed excluded; got ${ru1.totalOpen})`);
      assert(ru1.genuineOpen === 2, `U1 genuineOpen=2 (NULL only; got ${ru1.genuineOpen})`);
      assert(ru1.reconciledCount === 5, `U1 reconciledCount=5 (got ${ru1.reconciledCount})`);
      assert(ru1.byState.IGNORED === 3, `U1 byState.IGNORED=3 (got ${ru1.byState.IGNORED})`);
      assert(ru1.byState.EXTERNAL === 1, `U1 byState.EXTERNAL=1 (got ${ru1.byState.EXTERNAL})`);
      assert(ru1.byState.IMPORTED === 1, `U1 byState.IMPORTED=1 (got ${ru1.byState.IMPORTED})`);
      assert(ru1.byState.OTHER === 0, `U1 byState.OTHER=0 (got ${ru1.byState.OTHER})`);
      assert(
        ru1.genuineOpen + ru1.reconciledCount === ru1.totalOpen,
        `U1 genuineOpen+reconciledCount==totalOpen (${ru1.genuineOpen}+${ru1.reconciledCount} vs ${ru1.totalOpen})`,
      );
    }
    if (ru2) {
      assert(ru2.totalOpen === 4, `U2 totalOpen=4 (1 closed excluded; got ${ru2.totalOpen})`);
      assert(ru2.genuineOpen === 1, `U2 genuineOpen=1 (got ${ru2.genuineOpen})`);
      assert(ru2.reconciledCount === 3, `U2 reconciledCount=3 (got ${ru2.reconciledCount})`);
      assert(ru2.byState.IMPORTED === 2, `U2 byState.IMPORTED=2 (got ${ru2.byState.IMPORTED})`);
      assert(
        ru2.byState.OTHER === 1,
        `U2 byState.OTHER=1 (RECONCILED_BROKER_ABSENT lands in OTHER; got ${ru2.byState.OTHER})`,
      );
      assert(ru2.byState.IGNORED === 0 && ru2.byState.EXTERNAL === 0, "U2 has no IGNORED/EXTERNAL");
    }

    // Global summary via BASELINE-DELTA (shared evidence table).
    assert(a.totalOpen - b.totalOpen === 11, `summary.totalOpen delta=+11 (got ${a.totalOpen - b.totalOpen})`);
    assert(a.genuineOpen - b.genuineOpen === 3, `summary.genuineOpen delta=+3 (got ${a.genuineOpen - b.genuineOpen})`);
    assert(
      a.reconciledCount - b.reconciledCount === 8,
      `summary.reconciledCount delta=+8 (got ${a.reconciledCount - b.reconciledCount})`,
    );
    assert(a.userCount - b.userCount === 2, `summary.userCount delta=+2 (got ${a.userCount - b.userCount})`);

    // ── Auth gate: the requireAdmin contract ───────────────────────────────
    const anon = await getSummary(base, null);
    assert(anon.status === 401, `unauthenticated -> 401 (got ${anon.status})`);

    const asUser = await getSummary(base, userCookie);
    assert(asUser.status === 403, `normal USER -> 403 (got ${asUser.status})`);
    assert(asUser.body.users === undefined, "USER 403 body carries no per-user data");

    const asOwner = await getSummary(base, ownerCookie);
    assert(asOwner.status === 200 && asOwner.body.ok === true, `OWNER -> 200 (got ${asOwner.status})`);

    // Admin reviewing per-user reconciliation data is treated as admin: the
    // requireAdmin gate keys on the session's real role, so the operator
    // "previewing" U1/U2's rows still passes and can see their data.
    const adminSeesData =
      after.status === 200 &&
      (after.body.users ?? []).some((x) => x.userId === u1.id) &&
      (after.body.users ?? []).some((x) => x.userId === u2.id);
    assert(adminSeesData, "ADMIN reviewing per-user data is treated as admin (sees U1+U2 rows)");
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "reconcileSummaryEndpointTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    async (err) => {
      await cleanup().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[reconcileSummaryEndpointTest] FAILED:", err);
      process.exit(1);
    },
  );
}
