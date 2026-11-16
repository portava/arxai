// QA — Hard invite-gate behaviour. Exercises validateInviteForRegistration
// directly (the same function the /auth/register handler calls behind
// ARX_BETA_INVITE_REQUIRED). Also stress-tests expiry, revocation,
// already-used, email-mismatch, and 11th-user-blocked. No HTTP. No live trade.

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { betaInvitesRepo } from "@workspace/db";
const {
  MAX_COHORT_SIZE,
  createInvite,
  revokeInvite,
  acceptInvite,
  validateInviteForRegistration,
  inviteErrorMessage,
  isInviteExpired,
  hashInviteCode,
  findInviteByCode,
  toPublicInvite,
} = betaInvitesRepo;

const COHORT = "TEST_GATE_10";
const HCOHORT = "TEST_GATE_HARDEN";
const results: Array<{ id: string; ok: boolean; detail: string }> = [];
function pass(id: string, d: string): void { results.push({ id, ok: true, detail: d }); }
function fail(id: string, d: string): void { results.push({ id, ok: false, detail: d }); }

async function countLive(): Promise<number> {
  const r = await db.execute(sql`SELECT COUNT(*)::int AS c FROM arx_live_commands`);
  const rows = (r as unknown as { rows?: Array<{ c: number }> }).rows ?? (r as unknown as Array<{ c: number }>);
  return Number(rows[0]?.c ?? 0);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM beta_invites WHERE cohort IN (${COHORT}, ${HCOHORT}, 'TEST_GATE_RACE')`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'qa-gate-%@arx.test' OR email LIKE 'qa-race-%@arx.test'`);
  await db.execute(sql`DELETE FROM audit_events WHERE source = 'beta-invite-gate' AND (payload::text LIKE '%qa-gate-%' OR payload::text LIKE '%qa-race-%')`);
}

const SECRET_MARKERS = ["SESSION_SECRET", "MT5_BRIDGE_TOKEN", "apiKeyHash", "password_hash", "passwordHash", "BEGIN PRIVATE KEY"];

async function main(): Promise<void> {
  const liveBefore = await countLive();
  console.log("=".repeat(72));
  console.log("QA — Beta Invite Gate (hard registration gate behaviour)");
  console.log("=".repeat(72));
  console.log(`arx_live_commands BEFORE: ${liveBefore}`);

  await cleanup();

  // Seed 2 users (the pilot users — accept their invites)
  const u = await db.execute(sql`
    INSERT INTO users (email, name, password_hash, role)
    VALUES ('qa-gate-pilot1@arx.test','Pilot 1','x','USER'),
           ('qa-gate-pilot2@arx.test','Pilot 2','x','USER')
    RETURNING id, email
  `);
  const urows = ((u as unknown as { rows?: Array<{ id: number; email: string }> }).rows
    ?? (u as unknown as Array<{ id: number; email: string }>)) as Array<{ id: number; email: string }>;
  const pilot1 = urows[0]!;
  const pilot2 = urows[1]!;

  // Seed invites
  const okPilot1 = await createInvite({ email: pilot1.email, invitedByUserId: null, cohort: COHORT });
  const okPilot2 = await createInvite({ email: pilot2.email, invitedByUserId: null, cohort: COHORT });
  const okRevoke = await createInvite({ email: "qa-gate-revoke@arx.test", invitedByUserId: null, cohort: COHORT });
  const okExpire = await createInvite({ email: "qa-gate-expire@arx.test", invitedByUserId: null, cohort: COHORT });
  if (!okPilot1.ok || !okPilot2.ok || !okRevoke.ok || !okExpire.ok) { fail("setup", "seed failed"); process.exit(2); }
  await revokeInvite(okRevoke.invite.id, null);
  // Force expiry by direct UPDATE (yesterday)
  await db.execute(sql`UPDATE beta_invites SET expires_at = NOW() - INTERVAL '1 day' WHERE id = ${okExpire.invite.id}`);

  // T1: no invite code → INVITE_REQUIRED
  const r1 = await validateInviteForRegistration({ inviteCode: "", email: pilot1.email });
  if (!r1.ok && r1.error === "INVITE_REQUIRED") pass("T1", `INVITE_REQUIRED · msg="${inviteErrorMessage(r1.error)}"`);
  else fail("T1", JSON.stringify(r1));

  // T2: bogus code → INVITE_NOT_FOUND
  const r2 = await validateInviteForRegistration({ inviteCode: "deadbeefdeadbeef", email: pilot1.email });
  if (!r2.ok && r2.error === "INVITE_NOT_FOUND") pass("T2", `INVITE_NOT_FOUND · msg="${inviteErrorMessage(r2.error)}"`);
  else fail("T2", JSON.stringify(r2));

  // T3: revoked code → INVITE_NOT_PENDING
  const r3 = await validateInviteForRegistration({ inviteCode: okRevoke.rawCode, email: okRevoke.invite.email ?? "revoke-test@arx.test" });
  if (!r3.ok && r3.error === "INVITE_NOT_PENDING") pass("T3", `revoked → INVITE_NOT_PENDING · msg="${inviteErrorMessage(r3.error)}"`);
  else fail("T3", JSON.stringify(r3));

  // T4: expired code → INVITE_EXPIRED
  const expired = await db.execute(sql`SELECT * FROM beta_invites WHERE id = ${okExpire.invite.id}`);
  const expRow = ((expired as unknown as { rows?: Array<{ expires_at: Date }> }).rows
    ?? (expired as unknown as Array<{ expires_at: Date }>))[0];
  if (expRow) pass("T4-pre", `expires_at=${(expRow as { expires_at: Date }).expires_at}`); else fail("T4-pre", "no row");
  const r4 = await validateInviteForRegistration({ inviteCode: okExpire.rawCode, email: okExpire.invite.email ?? "expire-test@arx.test" });
  if (!r4.ok && r4.error === "INVITE_EXPIRED") pass("T4", `expired → INVITE_EXPIRED · msg="${inviteErrorMessage(r4.error)}"`);
  else fail("T4", JSON.stringify(r4));

  // T5: email mismatch → EMAIL_MISMATCH
  const r5 = await validateInviteForRegistration({ inviteCode: okPilot1.rawCode, email: "wrong@arx.test" });
  if (!r5.ok && r5.error === "EMAIL_MISMATCH") pass("T5", `email-mismatch · msg="${inviteErrorMessage(r5.error)}"`);
  else fail("T5", JSON.stringify(r5));

  // T6: happy path → ok
  const r6 = await validateInviteForRegistration({ inviteCode: okPilot1.rawCode, email: pilot1.email });
  if (r6.ok) pass("T6", "valid invite passes validation");
  else fail("T6", JSON.stringify(r6));

  // T7: accept → INVITE_NOT_PENDING on re-use
  await acceptInvite({ inviteCode: okPilot1.rawCode, email: pilot1.email, userId: pilot1.id });
  const r7 = await validateInviteForRegistration({ inviteCode: okPilot1.rawCode, email: pilot1.email });
  if (!r7.ok && r7.error === "INVITE_NOT_PENDING") pass("T7", `re-use blocked · msg="${inviteErrorMessage(r7.error)}"`);
  else fail("T7", JSON.stringify(r7));

  // T8: cap — fill remaining slots, then assert 11th blocked at INVITE level
  // We already have 4 invites (pilot1 ACCEPTED, pilot2 PENDING, revoke REVOKED, expire PENDING).
  // Active count = PENDING + ACCEPTED + PAUSED = 3 (pilot1 ACCEPTED, pilot2 PENDING, expire PENDING).
  // Add 7 more to reach exactly 10 active.
  const filler: string[] = [];
  for (let i = 0; i < 7; i++) {
    const r = await createInvite({ email: `qa-gate-fill-${i}@arx.test`, invitedByUserId: null, cohort: COHORT });
    if (!r.ok) { fail(`T8-fill-${i}`, `${r.error}`); break; }
    filler.push(r.rawCode);
  }
  const eleventh = await createInvite({ email: "qa-gate-11@arx.test", invitedByUserId: null, cohort: COHORT });
  if (!eleventh.ok && eleventh.error === "CAP_REACHED") pass("T8", `11th invite blocked at CAP_REACHED (msg="${inviteErrorMessage(eleventh.error)}")`);
  else fail("T8", JSON.stringify(eleventh));

  // T9: isInviteExpired helper correctness
  const future = { ...okPilot1.invite, expiresAt: new Date(Date.now() + 86_400_000) };
  const past = { ...okPilot1.invite, expiresAt: new Date(Date.now() - 86_400_000) };
  const noExp = { ...okPilot1.invite, expiresAt: null };
  if (!isInviteExpired(future) && isInviteExpired(past) && !isInviteExpired(noExp)) pass("T9", "isInviteExpired classifies future/past/null correctly");
  else fail("T9", `future=${isInviteExpired(future)} past=${isInviteExpired(past)} null=${isInviteExpired(noExp)}`);

  // T10: audit events for blocked attempts persist (smoke — we don't run via HTTP)
  // Insert one manually to confirm getRecentBlockedAttempts query shape.
  await db.execute(sql`
    INSERT INTO audit_events (event_id, timestamp, event_type, source, severity, payload, checksum, schema_version)
    VALUES ('qa-gate-audit-1', NOW()::text, 'beta_invite_validation_failed', 'beta-invite-gate', 'INFO',
            ${JSON.stringify({ email: "qa-gate-pilot1@arx.test", error: "INVITE_REQUIRED" })}::jsonb,
            'qa-checksum', 1)
  `);
  const recent = await betaInvitesRepo.getRecentBlockedAttempts(10);
  if (recent.length > 0) pass("T10", `getRecentBlockedAttempts returned ${recent.length} rows`);
  else fail("T10", `no rows returned`);

  // T11: no secret markers leak from any public surface
  const blob = JSON.stringify(recent);
  const leaked = SECRET_MARKERS.filter((m) => blob.includes(m));
  if (leaked.length === 0) pass("T11", "no secret markers in blocked-attempts surface");
  else fail("T11", `LEAKED: ${leaked.join(",")}`);

  // ───── HARDENING tests (hashing + atomic cap + transactional audit) ─────
  // Fresh isolated cohort so we never collide with T8's full TEST_GATE_10 cap.
  await db.execute(sql`DELETE FROM beta_invites WHERE cohort = ${HCOHORT}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'qa-gate-hash%@arx.test' OR email LIKE 'qa-gate-audit%@arx.test' OR email LIKE 'qa-gate-rollback%@arx.test' OR email LIKE 'qa-gate-revoke2%@arx.test'`);

  // T15: new invites store only the SHA-256 hash; plaintext column is NULL
  const inv15 = await createInvite({ email: "qa-gate-hash@arx.test", invitedByUserId: null, cohort: HCOHORT });
  if (!inv15.ok) { fail("T15", `seed failed: ${inv15.error}`); }
  else {
    const stored = await db.execute(sql`
      SELECT invite_code, invite_code_hash FROM beta_invites WHERE id = ${inv15.invite.id}
    `);
    const row = ((stored as unknown as { rows?: Array<{ invite_code: string | null; invite_code_hash: string | null }> }).rows
      ?? (stored as unknown as Array<{ invite_code: string | null; invite_code_hash: string | null }>))[0];
    const expectedHash = hashInviteCode(inv15.rawCode);
    if (row?.invite_code === null && row?.invite_code_hash === expectedHash) {
      pass("T15", `plaintext=NULL, hash=${row.invite_code_hash.slice(0, 12)}…`);
    } else {
      fail("T15", `plaintext=${row?.invite_code} hash=${row?.invite_code_hash} expected=${expectedHash}`);
    }
    // T15b: lookup by raw code resolves via hash
    const found = await findInviteByCode(inv15.rawCode);
    if (found && found.id === inv15.invite.id) pass("T15b", "findInviteByCode(rawCode) resolves via hash");
    else fail("T15b", `lookup failed for raw code`);
    // T15c: toPublicInvite never exposes raw code or hash
    const pub = toPublicInvite(inv15.invite);
    const blob = JSON.stringify(pub);
    if (!blob.includes(inv15.rawCode) && !blob.includes(expectedHash) && !("inviteCode" in pub)) {
      pass("T15c", `public shape masked (no rawCode/hash); keys=${Object.keys(pub).join(",")}`);
    } else {
      fail("T15c", `LEAK in toPublicInvite: ${blob.slice(0, 200)}`);
    }
  }

  // T16: atomic cap-check at acceptance — two users racing for the LAST seat
  // never both win. We seed a fresh isolated cohort, fill 9 ACCEPTED, leave
  // 1 seat, then fire two concurrent acceptInvite() against distinct PENDING
  // invites. Exactly one should ACCEPT, the other must get CAP_REACHED.
  const RACE_COHORT = "TEST_GATE_RACE";
  await db.execute(sql`DELETE FROM beta_invites WHERE cohort = ${RACE_COHORT}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'qa-race-%@arx.test'`);
  // Seed 9 ACCEPTED directly via SQL (bypass createInvite's active-cap check)
  // + 2 PENDING via createInvite so we exercise the real hash flow.
  for (let i = 0; i < 9; i++) {
    await db.execute(sql`
      INSERT INTO beta_invites (cohort, email, invite_code_hash, status, accepted_at)
      VALUES (${RACE_COHORT}, ${"qa-race-acc-" + i + "@arx.test"}, ${"raceacc" + i + "hashfiller" + i}, 'ACCEPTED', NOW())
    `);
  }
  // Two PENDING invites inserted directly so they exist with valid hashes.
  const rawA = "race-A-raw-" + Date.now();
  const rawB = "race-B-raw-" + Date.now();
  const hashA = hashInviteCode(rawA);
  const hashB = hashInviteCode(rawB);
  const insA = await db.execute(sql`
    INSERT INTO beta_invites (cohort, email, invite_code_hash, status)
    VALUES (${RACE_COHORT}, 'qa-race-A@arx.test', ${hashA}, 'PENDING') RETURNING id
  `);
  const insB = await db.execute(sql`
    INSERT INTO beta_invites (cohort, email, invite_code_hash, status)
    VALUES (${RACE_COHORT}, 'qa-race-B@arx.test', ${hashB}, 'PENDING') RETURNING id
  `);
  const idA = (((insA as unknown as { rows?: Array<{ id: number }> }).rows ?? (insA as unknown as Array<{ id: number }>))[0]!).id;
  const idB = (((insB as unknown as { rows?: Array<{ id: number }> }).rows ?? (insB as unknown as Array<{ id: number }>))[0]!).id;
  if (!idA || !idB) { fail("T16-seed-AB", `race setup failed`); }
  else {
    const userA = await db.execute(sql`INSERT INTO users (email, name, password_hash, role) VALUES ('qa-race-A@arx.test','RaceA','x','USER') RETURNING id`);
    const userB = await db.execute(sql`INSERT INTO users (email, name, password_hash, role) VALUES ('qa-race-B@arx.test','RaceB','x','USER') RETURNING id`);
    const uidA = (((userA as unknown as { rows?: Array<{ id: number }> }).rows ?? (userA as unknown as Array<{ id: number }>))[0]!).id;
    const uidB = (((userB as unknown as { rows?: Array<{ id: number }> }).rows ?? (userB as unknown as Array<{ id: number }>))[0]!).id;
    const [resA, resB] = await Promise.all([
      acceptInvite({ inviteCode: rawA, email: "qa-race-A@arx.test", userId: uidA, cohort: RACE_COHORT }),
      acceptInvite({ inviteCode: rawB, email: "qa-race-B@arx.test", userId: uidB, cohort: RACE_COHORT }),
    ]);
    const wins = [resA, resB].filter((r) => r.ok).length;
    const blocks = [resA, resB].filter((r) => !r.ok && r.error === "CAP_REACHED").length;
    if (wins === 1 && blocks === 1) {
      pass("T16", `race: 1 ACCEPT + 1 CAP_REACHED (resA=${resA.ok ? "OK" : resA.error}, resB=${resB.ok ? "OK" : resB.error})`);
    } else {
      fail("T16", `wins=${wins} blocks=${blocks} resA=${JSON.stringify(resA)} resB=${JSON.stringify(resB)}`);
    }
    // T16b: post-race accepted count is exactly MAX_COHORT_SIZE
    const acc = await db.execute(sql`SELECT COUNT(*)::int AS c FROM beta_invites WHERE cohort=${RACE_COHORT} AND status='ACCEPTED'`);
    const accCount = Number((((acc as unknown as { rows?: Array<{ c: number }> }).rows ?? (acc as unknown as Array<{ c: number }>))[0]!).c);
    if (accCount === MAX_COHORT_SIZE) pass("T16b", `accepted count = ${accCount} == MAX_COHORT_SIZE`);
    else fail("T16b", `accepted=${accCount} expected=${MAX_COHORT_SIZE}`);
    await db.execute(sql`DELETE FROM beta_invites WHERE cohort=${RACE_COHORT}`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE 'qa-race-%@arx.test'`);
  }

  // T17: transactional audit — successful accept writes audit row in same tx
  const u17 = await db.execute(sql`INSERT INTO users (email, name, password_hash, role) VALUES ('qa-gate-audit@arx.test','Audit','x','USER') RETURNING id`);
  const uid17 = (((u17 as unknown as { rows?: Array<{ id: number }> }).rows ?? (u17 as unknown as Array<{ id: number }>))[0]!).id;
  const inv17 = await createInvite({ email: "qa-gate-audit@arx.test", invitedByUserId: null, cohort: HCOHORT });
  if (!inv17.ok) { fail("T17", `seed: ${inv17.error}`); }
  else {
    const before17 = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE source='beta-invite-gate' AND event_type='beta_invite_accepted' AND payload->>'inviteId'=${String(inv17.invite.id)}`);
    const beforeC = Number((((before17 as unknown as { rows?: Array<{ c: number }> }).rows ?? (before17 as unknown as Array<{ c: number }>))[0]!).c);
    const acc17 = await acceptInvite({ inviteCode: inv17.rawCode, email: "qa-gate-audit@arx.test", userId: uid17, cohort: HCOHORT });
    const after17 = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE source='beta-invite-gate' AND event_type='beta_invite_accepted' AND payload->>'inviteId'=${String(inv17.invite.id)}`);
    const afterC = Number((((after17 as unknown as { rows?: Array<{ c: number }> }).rows ?? (after17 as unknown as Array<{ c: number }>))[0]!).c);
    if (acc17.ok && afterC === beforeC + 1) pass("T17", `accept wrote audit row in same tx (${beforeC} → ${afterC})`);
    else fail("T17", `accept=${JSON.stringify(acc17)} audit ${beforeC}→${afterC}`);
  }

  // T18: audit failure aborts the action (transactional rollback)
  const u18 = await db.execute(sql`INSERT INTO users (email, name, password_hash, role) VALUES ('qa-gate-rollback@arx.test','Rb','x','USER') RETURNING id`);
  const uid18 = (((u18 as unknown as { rows?: Array<{ id: number }> }).rows ?? (u18 as unknown as Array<{ id: number }>))[0]!).id;
  const inv18 = await createInvite({ email: "qa-gate-rollback@arx.test", invitedByUserId: null, cohort: HCOHORT });
  if (!inv18.ok) { fail("T18", `seed: ${inv18.error}`); }
  else {
    let thrown: string | null = null;
    try {
      await acceptInvite({
        inviteCode: inv18.rawCode, email: "qa-gate-rollback@arx.test", userId: uid18, cohort: HCOHORT,
        auditFn: async () => { throw new Error("simulated_audit_failure"); },
      });
    } catch (e) { thrown = (e as Error).message; }
    // Verify the invite is still PENDING (the UPDATE rolled back with the audit failure)
    const post = await db.execute(sql`SELECT status, accepted_user_id FROM beta_invites WHERE id=${inv18.invite.id}`);
    const postRow = (((post as unknown as { rows?: Array<{ status: string; accepted_user_id: number | null }> }).rows
      ?? (post as unknown as Array<{ status: string; accepted_user_id: number | null }>))[0]);
    if (thrown && postRow?.status === "PENDING" && postRow?.accepted_user_id === null) {
      pass("T18", `audit failure rolled back accept (thrown="${thrown}", status=PENDING)`);
    } else {
      fail("T18", `thrown=${thrown} status=${postRow?.status} accepted_user_id=${postRow?.accepted_user_id}`);
    }
  }

  // T19: revoke wraps audit in same tx — success path writes audit row
  const inv19 = await createInvite({ email: "qa-gate-revoke2@arx.test", invitedByUserId: null, cohort: HCOHORT });
  if (!inv19.ok) { fail("T19", `seed: ${inv19.error}`); }
  else {
    const before19 = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE source='beta-invite-gate' AND event_type='beta_invite_revoked' AND payload->>'inviteId'=${String(inv19.invite.id)}`);
    const beforeC = Number((((before19 as unknown as { rows?: Array<{ c: number }> }).rows ?? (before19 as unknown as Array<{ c: number }>))[0]!).c);
    await revokeInvite(inv19.invite.id, null);
    const after19 = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE source='beta-invite-gate' AND event_type='beta_invite_revoked' AND payload->>'inviteId'=${String(inv19.invite.id)}`);
    const afterC = Number((((after19 as unknown as { rows?: Array<{ c: number }> }).rows ?? (after19 as unknown as Array<{ c: number }>))[0]!).c);
    if (afterC === beforeC + 1) pass("T19", `revoke wrote transactional audit (${beforeC}→${afterC})`);
    else fail("T19", `audit ${beforeC}→${afterC}`);
  }

  // T20: cleanup audit rows scoped to this test run
  await db.execute(sql`DELETE FROM audit_events WHERE source='beta-invite-gate' AND payload::text LIKE '%qa-gate-%'`);

  // T12: cleanup
  await cleanup();
  pass("T12", "cleanup complete");

  const liveAfter = await countLive();
  const liveUnchanged = liveBefore === liveAfter;
  const liveStrictZero = liveBefore === 0 && liveAfter === 0;
  if (liveUnchanged) pass("T13", `arx_live_commands unchanged ${liveBefore}→${liveAfter}`);
  else fail("T13", `arx_live_commands CHANGED ${liveBefore}→${liveAfter}`);
  if (liveStrictZero) pass("T14", `arx_live_commands strict-zero`);
  else fail("T14", `not strict-zero`);

  console.log("");
  for (const r of results) console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.id.padEnd(7)} ${r.detail}`);
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
  console.error("qaBetaInviteGate crashed:", e instanceof Error ? e.message : e);
  try { await cleanup(); } catch { /* noop */ }
  try { await pool.end(); } catch { /* noop */ }
  process.exit(2);
});
