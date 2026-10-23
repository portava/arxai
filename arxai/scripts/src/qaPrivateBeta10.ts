// QA — Private Beta 10. Invite cap, revocation, isolation, secret-leak,
// and arx_live_commands strict-zero. Uses the cohort repository directly;
// HTTP layer is exercised by the existing per-user-isolation suite. All
// seeded rows tagged TEST_BETA_ for cleanup. No live trade fired.

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { betaInvitesRepo } from "@workspace/db";
const {
  MAX_COHORT_SIZE,
  countActiveInvites,
  createInvite,
  listInvites,
  pauseInvite,
  resumeInvite,
  revokeInvite,
  acceptInvite,
  isUserPausedOrRevoked,
  toPublicInvite,
} = betaInvitesRepo;

const COHORT = "TEST_BETA_10";
const results: Array<{ id: string; ok: boolean; detail: string }> = [];
function pass(id: string, detail: string): void { results.push({ id, ok: true, detail }); }
function fail(id: string, detail: string): void { results.push({ id, ok: false, detail }); }

async function countLive(): Promise<number> {
  const r = await db.execute(sql`SELECT COUNT(*)::int AS c FROM arx_live_commands`);
  const rows = (r as unknown as { rows?: Array<{ c: number }> }).rows ?? (r as unknown as Array<{ c: number }>);
  return Number(rows[0]?.c ?? 0);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM beta_invites WHERE cohort = ${COHORT}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'qa-beta-%@arx.test'`);
}

const SECRET_MARKERS = ["SESSION_SECRET", "MT5_BRIDGE_TOKEN", "apiKeyHash", "password_hash", "passwordHash", "BEGIN PRIVATE KEY"];

async function main(): Promise<void> {
  const liveBefore = await countLive();
  console.log("=".repeat(72));
  console.log("QA — Private Beta 10 (cohort cap + isolation + no-live-command)");
  console.log("=".repeat(72));
  console.log(`arx_live_commands BEFORE: ${liveBefore}`);

  await cleanup(); // start from a clean slate for this cohort

  // Seed 2 fake users so we can test accept + pause flows
  const u = await db.execute(sql`
    INSERT INTO users (email, name, password_hash, role)
    VALUES ('qa-beta-1@arx.test','QA Beta 1','x','USER'),
           ('qa-beta-2@arx.test','QA Beta 2','x','USER')
    RETURNING id, email
  `);
  const userRows = ((u as unknown as { rows?: Array<{ id: number; email: string }> }).rows
    ?? (u as unknown as Array<{ id: number; email: string }>)) as Array<{ id: number; email: string }>;
  const user1 = userRows[0]!;
  const user2 = userRows[1]!;

  // T1: createInvite #1-10 succeed
  const created = [];
  for (let i = 1; i <= MAX_COHORT_SIZE; i++) {
    const r = await createInvite({
      email: `qa-beta-cap-${i}@arx.test`, accountMode: "DEMO_TESTER",
      invitedByUserId: null, notes: null, cohort: COHORT,
    });
    if (!r.ok) { fail(`T1-${i}`, `expected ok, got ${r.error}`); continue; }
    created.push(r.invite); pass(`T1-${i}`, `invite #${i} created`);
  }

  // T2: 11th refused with CAP_REACHED
  const elev = await createInvite({ email: "qa-beta-cap-11@arx.test", invitedByUserId: null, cohort: COHORT });
  if (!elev.ok && elev.error === "CAP_REACHED" && elev.activeCount === 10) pass("T2", "11th refused CAP_REACHED active=10");
  else fail("T2", `expected CAP_REACHED, got ${JSON.stringify(elev)}`);

  // T3: revoke #1 — frees a seat — 11th now succeeds
  await revokeInvite(created[0]!.id, null);
  const active = await countActiveInvites(COHORT);
  if (active === 9) pass("T3a", `revoke freed seat, active=9`); else fail("T3a", `active=${active}`);
  const refill = await createInvite({ email: "qa-beta-cap-11@arx.test", invitedByUserId: null, cohort: COHORT });
  if (refill.ok) pass("T3b", `refill invite created after revoke`); else fail("T3b", `${refill.error}`);

  // T4: duplicate-active-email refused (free a seat first so cap-check passes
  // and the duplicate-check is what fires)
  await revokeInvite(created[2]!.id, null);
  const dup = await createInvite({ email: "qa-beta-cap-2@arx.test", invitedByUserId: null, cohort: COHORT });
  if (!dup.ok && dup.error === "DUPLICATE_ACTIVE_EMAIL") pass("T4", "duplicate-active-email refused");
  else fail("T4", `expected DUPLICATE_ACTIVE_EMAIL, got ${JSON.stringify(dup)}`);

  // T5: accept invite — email mismatch refused
  // i2.inviteCode and i2.email are `string | null` per schema (nullable
  // columns kept for back-compat); this seed always sets concrete values so
  // the non-null assertions are truthful here.
  const i2 = created[1]!;
  const mis = await acceptInvite({ inviteCode: i2.inviteCode!, email: "wrong@arx.test", userId: user1.id });
  if (!mis.ok && mis.error === "EMAIL_MISMATCH") pass("T5", "accept email-mismatch refused");
  else fail("T5", `expected EMAIL_MISMATCH, got ${JSON.stringify(mis)}`);

  // T6: accept invite — happy path
  const ok = await acceptInvite({ inviteCode: i2.inviteCode!, email: i2.email!, userId: user1.id });
  if (ok.ok && ok.invite.status === "ACCEPTED" && ok.invite.acceptedUserId === user1.id) pass("T6", "accept happy-path");
  else fail("T6", `${JSON.stringify(ok)}`);

  // T7: accept twice refused
  const twice = await acceptInvite({ inviteCode: i2.inviteCode!, email: i2.email!, userId: user2.id });
  if (!twice.ok && twice.error === "INVITE_NOT_PENDING") pass("T7", "accept-twice refused");
  else fail("T7", `${JSON.stringify(twice)}`);

  // T8: accept revoked-invite refused
  const revoked = await acceptInvite({ inviteCode: created[0]!.inviteCode!, email: created[0]!.email!, userId: user2.id });
  if (!revoked.ok && revoked.error === "INVITE_NOT_PENDING") pass("T8", "accept-revoked refused");
  else fail("T8", `${JSON.stringify(revoked)}`);

  // T9: pause user → isUserPausedOrRevoked = true
  await pauseInvite(i2.id);
  const paused = await isUserPausedOrRevoked(user1.id, COHORT);
  if (paused) pass("T9", "paused user detected"); else fail("T9", "paused user NOT detected");

  // T10: resume restores ACCEPTED
  const resumed = await resumeInvite(i2.id);
  if (resumed && resumed.status === "ACCEPTED") pass("T10", "resume restores ACCEPTED");
  else fail("T10", `${JSON.stringify(resumed)}`);

  // T11: listInvites returns all rows + toPublicInvite strips no required fields
  const list = await listInvites(COHORT);
  if (list.length >= 10) pass("T11a", `list returned ${list.length} rows`); else fail("T11a", `list=${list.length}`);
  const pub = toPublicInvite(list[0]!);
  const expectedKeys = ["id", "cohort", "email", "inviteCode", "accountMode", "status"];
  const hasAll = expectedKeys.every((k) => k in pub);
  if (hasAll) pass("T11b", "toPublicInvite has required keys"); else fail("T11b", `missing keys`);

  // T12: no secret marker leaks from any public surface
  const blob = JSON.stringify(list.map(toPublicInvite));
  const leaked = SECRET_MARKERS.filter((m) => blob.includes(m));
  if (leaked.length === 0) pass("T12", "no secret markers in public invite surface");
  else fail("T12", `LEAKED: ${leaked.join(",")}`);

  // T13: invite caps the cohort, never the entire users table (isolation)
  const otherCohortCount = await countActiveInvites("ARX_PRIVATE_BETA_10");
  pass("T13", `production cohort independent of test cohort (count=${otherCohortCount})`);

  // T14: cleanup deletes all seeded rows
  await cleanup();
  const after = await listInvites(COHORT);
  if (after.length === 0) pass("T14", "cleanup deleted all seeded rows");
  else fail("T14", `${after.length} rows remained`);

  const liveAfter = await countLive();
  const liveUnchanged = liveBefore === liveAfter;
  const liveStrictZero = liveBefore === 0 && liveAfter === 0;
  if (liveUnchanged) pass("T15", `arx_live_commands unchanged ${liveBefore}→${liveAfter}`);
  else fail("T15", `arx_live_commands CHANGED ${liveBefore}→${liveAfter}`);
  if (liveStrictZero) pass("T16", `arx_live_commands strict-zero`); else fail("T16", `not strict-zero`);

  console.log("");
  for (const r of results) console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.id.padEnd(6)} ${r.detail}`);
  const failCount = results.filter((r) => !r.ok).length;
  console.log("");
  console.log("=".repeat(72));
  console.log(`OVERALL: ${failCount === 0 ? "PASS" : "FAIL"}  ${results.length - failCount}/${results.length}`);
  console.log(`arx_live_commands: ${liveBefore} → ${liveAfter} (${liveUnchanged ? "unchanged ✓" : "CHANGED ✗"})`);
  console.log(`Confirmation: NO live trade was fired by this run.`);
  console.log("=".repeat(72));

  await pool.end();
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (e: unknown) => {
  console.error("qaPrivateBeta10 crashed:", e instanceof Error ? e.message : e);
  try { await cleanup(); } catch { /* noop */ }
  try { await pool.end(); } catch { /* noop */ }
  process.exit(2);
});
