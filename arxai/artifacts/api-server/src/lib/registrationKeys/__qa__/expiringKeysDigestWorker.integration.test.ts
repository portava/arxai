// Expiring-registration-keys email digest worker — scheduling integration tests.
//
// The PURE email body builder is leak-tested elsewhere (04g in
// securityRegressionSuite). This suite covers the SCHEDULING WORKER's three
// most important behaviours directly against the real DB — WITHOUT ever sending
// a real email. The email send loop in runExpiringKeysDigest is only reached
// when keys are actually expiring AND recipients exist; every assertion here is
// constructed so that path is never taken:
//
//   • NO-NOISE      — when listExpiringPendingKeys returns an empty list, the
//                     worker sends NO email and writes NO durable "sent" marker.
//   • PER-DAY GUARD — a second run on the same UTC day is a no-op (ALREADY_SENT)
//                     driven by the durable audit-log marker
//                     (action REGISTRATION_KEY_EXPIRY_DIGEST_SENT), with NO
//                     second audit row written.
//   • RECIPIENTS    — loadAdminRecipients() returns ONLY non-system ADMIN/OWNER
//                     users that have an email address.
//
// Far-future clocks isolate the no-noise / per-day assertions from any real
// data, so they can never collide with the live worker or real production rows.
// These tests touch the real database (DATABASE_URL). Every row they create is
// uniquely keyed and removed in a finally block so they never leak fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  db,
  adminActionAuditLogTable,
  usersTable,
  betaInvitesTable,
  betaInvitesRepo,
} from "@workspace/db";
import {
  runExpiringKeysDigest,
  loadAdminRecipients,
  type SendExpiringKeysDigestEmailFn,
} from "../expiringKeysDigestWorker.js";
import type { ExpiringKeysDigestEmailInput } from "../../email/expiringKeysDigestEmail.js";

const DELIVERY_AUDIT_ACTION = "REGISTRATION_KEY_EXPIRY_DIGEST_SENT";
const TEST_MARKER_REASON = "TEST_735_DIGEST_MARKER";
const TAG = `qa-digest-735-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function startOfNextUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
}

/**
 * Count durable "sent" markers on a given UTC day (the production per-day guard).
 * Bounded to the exact [dayStart, nextDayStart) window so unrelated future-day
 * rows in the shared dev DB can never contaminate the count.
 */
async function digestAuditRowsOnDay(now: Date): Promise<number> {
  const rows = await db
    .select({ id: adminActionAuditLogTable.id })
    .from(adminActionAuditLogTable)
    .where(
      and(
        eq(adminActionAuditLogTable.action, DELIVERY_AUDIT_ACTION),
        gte(adminActionAuditLogTable.createdAt, startOfUtcDay(now)),
        lt(adminActionAuditLogTable.createdAt, startOfNextUtcDay(now)),
      ),
    );
  return rows.length;
}

test("NO-NOISE: empty expiring list ⇒ no email, no durable marker", async () => {
  // A far-future clock guarantees the look-ahead window [now, now+window] holds
  // no real keys regardless of shared dev-DB state. force=true bypasses the hour
  // + per-day gates so we reach the empty-list check itself.
  const farFuture = new Date(Date.UTC(2099, 0, 10, 23, 0, 0));

  const before = await digestAuditRowsOnDay(farFuture);
  const result = await runExpiringKeysDigest({ now: farFuture, force: true });
  const after = await digestAuditRowsOnDay(farFuture);

  assert.equal(result.skipped, "NOTHING_EXPIRING", "should skip with NOTHING_EXPIRING");
  assert.equal(result.expiringCount, 0, "no keys expiring");
  assert.equal(result.delivered, 0, "no email delivered");
  assert.equal(result.recipients, 0, "recipient loading not even reached");
  assert.equal(before, 0, "no pre-existing marker on this far-future day");
  assert.equal(after, 0, "no durable marker written for an empty run");
});

test("PER-DAY GUARD: a second run on the same UTC day is a no-op (durable audit-log guard)", async () => {
  // Simulate "already sent today" by inserting the durable audit marker on a
  // far-future UTC day, then run the worker (force=false) for that same day and
  // prove it short-circuits to ALREADY_SENT, sends nothing, and writes NO new
  // marker. Hour 23 ≥ the target hour so guard 1 (BEFORE_TARGET_HOUR) is not the
  // reason — this exercises the DURABLE audit-log guard, not the in-memory one.
  const farFuture = new Date(Date.UTC(2099, 1, 15, 23, 0, 0));

  let insertedId = 0;
  try {
    const [marker] = await db
      .insert(adminActionAuditLogTable)
      .values({
        adminId: null,
        adminRole: "SYSTEM",
        action: DELIVERY_AUDIT_ACTION,
        beforeState: {},
        afterState: { reportDate: "2099-02-15", seededBy: TAG },
        reason: TEST_MARKER_REASON,
        createdAt: new Date(Date.UTC(2099, 1, 15, 8, 0, 0)),
      })
      .returning({ id: adminActionAuditLogTable.id });
    insertedId = marker!.id;

    const before = await digestAuditRowsOnDay(farFuture);
    const result = await runExpiringKeysDigest({ now: farFuture });
    const after = await digestAuditRowsOnDay(farFuture);

    assert.equal(result.skipped, "ALREADY_SENT", "second same-day run should be ALREADY_SENT");
    assert.equal(result.delivered, 0, "no email on an already-sent day");
    assert.equal(before, 1, "exactly our seeded marker present before the run");
    assert.equal(after, 1, "no second durable marker written (idempotent per UTC day)");
  } finally {
    if (insertedId) {
      await db
        .delete(adminActionAuditLogTable)
        .where(eq(adminActionAuditLogTable.id, insertedId));
    }
  }
});

test("RECIPIENTS: only non-system ADMIN/OWNER users with an email", async () => {
  // Seed one of each shape. Subset semantics: the shared dev DB may hold real
  // admins, so we assert OUR qualifying users ARE included and OUR disqualified
  // users are NOT — never a global exact count.
  // The "no usable email" admin carries an address with NO "@" — the column is
  // NOT NULL + UNIQUE, so this exercises the loader's `email.includes("@")`
  // exclusion exactly as a malformed/empty address would, without violating the
  // schema.
  const emails = {
    owner: `owner-${TAG}@arx.test`,
    admin: `admin-${TAG}@arx.test`,
    user: `user-${TAG}@arx.test`,
    sysOwner: `sysowner-${TAG}@arx.test`,
    noEmailAdmin: `noemailadmin-${TAG}-no-at-symbol`,
  };
  const seededIds: number[] = [];
  try {
    const seeded = await db
      .insert(usersTable)
      .values([
        { email: emails.owner, role: "OWNER", isSystemUser: false },
        { email: emails.admin, role: "ADMIN", isSystemUser: false },
        { email: emails.user, role: "USER", isSystemUser: false },
        { email: emails.sysOwner, role: "OWNER", isSystemUser: true },
        { email: emails.noEmailAdmin, role: "ADMIN", isSystemUser: false },
      ])
      .returning({ id: usersTable.id, email: usersTable.email });
    for (const s of seeded) seededIds.push(s.id);

    const byEmail = new Map(seeded.map((s) => [s.email, s.id]));
    const ownerId = byEmail.get(emails.owner)!;
    const adminId = byEmail.get(emails.admin)!;
    const plainUserId = byEmail.get(emails.user)!;
    const sysOwnerId = byEmail.get(emails.sysOwner)!;
    const noEmailAdminId = byEmail.get(emails.noEmailAdmin)!;

    const recipients = await loadAdminRecipients();
    const recipientIds = new Set(recipients.map((r) => r.id));

    assert.ok(recipientIds.has(ownerId), "non-system OWNER with email is included");
    assert.ok(recipientIds.has(adminId), "non-system ADMIN with email is included");
    assert.ok(!recipientIds.has(plainUserId), "plain USER is excluded");
    assert.ok(!recipientIds.has(sysOwnerId), "system OWNER is excluded");
    assert.ok(!recipientIds.has(noEmailAdminId), "admin without an email is excluded");

    // Every returned recipient must carry a usable email (the contract).
    for (const r of recipients) {
      assert.ok(r.email && r.email.includes("@"), "recipient has a usable email address");
    }
  } finally {
    for (const id of seededIds) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
  }
});

test("POSITIVE DELIVERY: expiring key + admin ⇒ send attempted with right recipients/body + exactly one durable marker", async () => {
  // The three Task #735 cases above all avoid the send loop. THIS case proves the
  // POSITIVE path: when a PENDING key is really expiring within the window AND a
  // qualifying admin exists, the worker (a) calls the (injected) send seam — no
  // real email leaves the environment — with the correct recipient + masked body,
  // and (b) writes EXACTLY ONE durable per-UTC-day audit marker.
  //
  // Isolation: a far-future clock keeps the look-ahead window AND the audit day
  // free of any real key/marker, so the durable-marker count is a clean 0→1.
  // The send seam is injected (DI) so nothing hits Resend / the network.
  //
  // Recipient-set honesty: the shared dev DB may already hold real admins, so we
  // do NOT assert a global "called exactly once". Instead we tie the stub call
  // count to the worker's own `recipients` count, prove OUR seeded admin received
  // EXACTLY ONE send carrying our key, and prove EXACTLY ONE durable marker — the
  // marker is written once regardless of how many recipients exist.
  // Far-future clock so the look-ahead window holds ONLY our seeded key. The day
  // is randomized per run so two concurrent test processes on the shared dev DB
  // can never collide on the same reportDate (the durable marker's dedupe key).
  const uniqueOffsetDays = Math.floor(Math.random() * 100_000); // spread ~273 years
  const now = new Date(Date.UTC(2099, 0, 1, 12, 0, 0) + uniqueOffsetDays * 86_400_000);
  const expiresAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // +2 days, in window
  // The durable marker's identity is afterState.reportDate (its createdAt is the
  // real wall clock, NOT the simulated `now`), so we count/clean by reportDate.
  const reportDate = startOfUtcDay(now).toISOString().slice(0, 10);
  const markersForReportDate = async (): Promise<number> => {
    const rows = await db
      .select({ id: adminActionAuditLogTable.id })
      .from(adminActionAuditLogTable)
      .where(
        and(
          eq(adminActionAuditLogTable.action, DELIVERY_AUDIT_ACTION),
          sql`${adminActionAuditLogTable.afterState}->>'reportDate' = ${reportDate}`,
        ),
      );
    return rows.length;
  };

  const adminEmail = `digest-recipient-${TAG}@arx.test`;
  const keyholderEmail = `keyholder-${TAG}@arx.test`;
  const keyPrefix = `ARX-${TAG.slice(-4).toUpperCase()}`;

  const calls: ExpiringKeysDigestEmailInput[] = [];
  const stubSend: SendExpiringKeysDigestEmailFn = async (input) => {
    calls.push(input);
    return { id: `stub-${calls.length}` };
  };

  let seededUserId = 0;
  let seededInviteId = 0;
  try {
    const [adminRow] = await db
      .insert(usersTable)
      .values({ email: adminEmail, role: "ADMIN", isSystemUser: false })
      .returning({ id: usersTable.id });
    seededUserId = adminRow!.id;

    const [inviteRow] = await db
      .insert(betaInvitesTable)
      .values({
        cohort: `QA_${TAG}`,
        email: keyholderEmail,
        inviteCode: null,
        inviteCodeHash: `qa-hash-${TAG}`,
        keyPrefix,
        roleGrant: "USER",
        accountMode: "DEMO_TESTER",
        status: "PENDING",
        invitedByUserId: null,
        expiresAt,
        updatedAt: now,
      })
      .returning({ id: betaInvitesTable.id });
    seededInviteId = inviteRow!.id;

    const before = await markersForReportDate();
    const result = await runExpiringKeysDigest({
      now,
      force: true,
      sendDigestEmail: stubSend,
    });
    const after = await markersForReportDate();

    // (a) The worker took the positive delivery path.
    assert.equal(result.skipped, null, "positive path: not skipped");
    assert.ok(result.expiringCount >= 1, "at least our seeded key is expiring");
    assert.ok(result.recipients >= 1, "at least our seeded admin is a recipient");
    assert.equal(
      result.delivered,
      result.recipients,
      "every recipient was delivered to (stub never throws)",
    );

    // (b) The send seam was invoked once per recipient (no real email sent).
    assert.equal(
      calls.length,
      result.recipients,
      "send seam called exactly once per recipient",
    );

    // OUR seeded admin received EXACTLY ONE send.
    const ourCalls = calls.filter((c) => c.to === adminEmail);
    assert.equal(ourCalls.length, 1, "our seeded admin received exactly one digest send");

    // The body carried OUR expiring key, masked, with the honest window + manage link.
    const ourCall = ourCalls[0]!;
    const expectedMask = betaInvitesRepo.maskArxKey(keyPrefix);
    const item = ourCall.items.find((i) => i.assignedEmail === keyholderEmail);
    assert.ok(item, "the digest body includes our seeded key (by assigned email)");
    assert.equal(item!.maskedKey, expectedMask, "the key is masked, never raw");
    assert.equal(item!.roleGrant, "USER", "the key's roleGrant is carried through");
    assert.equal(
      item!.daysLeft,
      betaInvitesRepo.daysUntilExpiry(expiresAt, now),
      "days-left is computed honestly from expiry",
    );
    assert.equal(ourCall.windowDays, result.windowDays, "window days match the worker config");
    assert.ok(
      ourCall.manageLink.endsWith("/admin/beta-control"),
      "manage link points at the admin beta-control page",
    );

    // (c) EXACTLY ONE durable per-report-date marker was written by THIS run.
    assert.equal(
      after - before,
      1,
      "exactly one new durable REGISTRATION_KEY_EXPIRY_DIGEST_SENT marker for this report date",
    );
  } finally {
    // Remove the durable marker(s) the worker wrote (the far-future reportDate is
    // unique to this test, so deleting by reportDate only removes our own marker).
    await db
      .delete(adminActionAuditLogTable)
      .where(
        and(
          eq(adminActionAuditLogTable.action, DELIVERY_AUDIT_ACTION),
          sql`${adminActionAuditLogTable.afterState}->>'reportDate' = ${reportDate}`,
        ),
      );
    if (seededInviteId) {
      await db.delete(betaInvitesTable).where(eq(betaInvitesTable.id, seededInviteId));
    }
    if (seededUserId) {
      await db.delete(usersTable).where(eq(usersTable.id, seededUserId));
    }
  }
});
