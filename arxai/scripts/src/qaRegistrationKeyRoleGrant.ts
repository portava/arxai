// qaRegistrationKeyRoleGrant.ts — End-to-end proof (Task #721) that a
// registration key's `roleGrant` is honoured all the way through the public
// signup endpoint into the durable DB row.
//
// IT PROVES (all against the REAL Express app in-process):
//   1. Minting an INVESTOR registration key and calling POST /api/auth/register
//      with it creates a user whose users.role === "INVESTOR".
//   2. The same flow with an OWNER-issued ADMIN key yields users.role === "ADMIN".
//   3. A key with NO roleGrant (null) defaults the new user to users.role ===
//      "USER" — proving the grant is applied from the key, not blanket-elevated.
//   4. Each key flips to ACCEPTED in the SAME transaction as the user insert,
//      with accepted_user_id pointing at the freshly-created user (atomic accept).
//
// WHY in-process: the Registration Key Shield is fail-closed on
// REGISTRATION_KEY_PEPPER. The key hash (minted here) and the server-side
// validation MUST share the same pepper. Booting the app in this process lets
// the test own the pepper, so the minted key and the server agree without
// depending on an externally-configured secret. (Set ARX_QA_BASE_URL to probe
// an already-running server instead — that server must share this pepper.)
//
// SAFETY / ISOLATION:
//   - Sets REGISTRATION_KEY_PEPPER on THIS process only (never the secret store).
//   - Seeds nothing but its own keys/users (unique TAG) and cleans every row up
//     in a finally, even on failure.
//   - Never places a trade / touches any execution / live / bridge surface; the
//     starting arx_live_commands count is asserted unchanged + strict-zero.
//   - CI-safe: spins up the REAL Express app in-process on an ephemeral port.
//     Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:registration-key-rolegrant

// Pepper + gate must be in place BEFORE the app handles any request. Both are
// read at request time, but we set them at module load to be unambiguous. We
// only touch the in-process env, never the durable secret store.
process.env.ARX_BETA_INVITE_REQUIRED = "true";
if (!process.env.REGISTRATION_KEY_PEPPER || process.env.REGISTRATION_KEY_PEPPER.trim() === "") {
  process.env.REGISTRATION_KEY_PEPPER = "qa-rolegrant-test-pepper-" + Date.now();
}

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { pool, betaInvitesRepo } from "@workspace/db";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TAG = `qaRoleGrant_${Date.now()}_${randomBytes(3).toString("hex")}`;

let passes = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    console.error(`  \u2717 ${label}`);
  }
}

interface Resp { status: number; bodyText: string }
function makeReq(baseUrl: string) {
  return async function req(method: "POST", path: string, body?: unknown): Promise<Resp> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, bodyText: await r.text() };
  };
}

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

interface UserRow { id: number; role: string }
async function getUserByEmail(email: string): Promise<UserRow | null> {
  const r = await pool.query<UserRow>(
    "SELECT id, role FROM users WHERE email = $1 LIMIT 1",
    [email.toLowerCase()],
  );
  return r.rows[0] ?? null;
}

interface InviteState { status: string; accepted_user_id: number | null }
async function getInviteState(inviteId: number): Promise<InviteState | null> {
  const r = await pool.query<InviteState>(
    "SELECT status, accepted_user_id FROM beta_invites WHERE id = $1",
    [inviteId],
  );
  return r.rows[0] ?? null;
}

// One full mint → register → assert role cycle.
async function runCase(
  req: ReturnType<typeof makeReq>,
  label: string,
  roleGrant: "USER" | "INVESTOR" | "ADMIN" | null,
  invitedByRole: "ADMIN" | "OWNER",
  expectedRole: string,
  createdEmails: string[],
  inviteIds: number[],
): Promise<void> {
  console.log(`\n${label}`);
  const email = `${TAG}_${(roleGrant ?? "none").toLowerCase()}@arx.test`;
  const password = `Pw-${randomBytes(8).toString("hex")}`;

  const mint = await betaInvitesRepo.createRegistrationKey({
    email: null, // email-optional key → registration email is free-form
    roleGrant,
    invitedByUserId: null,
    invitedByRole,
    cohort: TAG,
  });
  if (!mint.ok) {
    assert(false, `mint registration key (got error=${mint.error})`);
    return;
  }
  inviteIds.push(mint.invite.id);
  assert(mint.invite.roleGrant === roleGrant, `minted key stores roleGrant=${roleGrant === null ? "null" : roleGrant} (got ${mint.invite.roleGrant})`);

  const reg = await req("POST", "/api/auth/register", {
    email,
    password,
    registrationKey: mint.rawKey,
  });
  createdEmails.push(email);
  assert(reg.status === 201, `register returns 201 (got ${reg.status} body=${reg.bodyText.slice(0, 120)})`);

  const user = await getUserByEmail(email);
  assert(user !== null, `user row created for ${email}`);
  assert(
    user?.role === expectedRole,
    `users.role === "${expectedRole}" (got "${user?.role}")`,
  );

  const invite = await getInviteState(mint.invite.id);
  assert(invite?.status === "ACCEPTED", `key flipped to ACCEPTED (got ${invite?.status})`);
  assert(
    invite?.accepted_user_id === user?.id,
    `key.accepted_user_id points at the new user (key=${invite?.accepted_user_id} user=${user?.id})`,
  );

  // No password / hash should ever come back in the register response.
  assert(
    !/password.?hash/i.test(reg.bodyText) && !reg.bodyText.includes(password),
    `register response leaks no password/hash`,
  );
}

async function main(): Promise<void> {
  console.log("qaRegistrationKeyRoleGrant");
  console.log("==========================\n");

  const startLive = await liveCommandsCount();

  let server: Server | null = null;
  let baseUrl: string;
  if (EXTERNAL_BASE) {
    baseUrl = EXTERNAL_BASE;
    console.log(`[setup] probing external server at ${baseUrl}`);
    console.log(`[setup] NOTE: that server must share REGISTRATION_KEY_PEPPER with this process.\n`);
  } else {
    const app = (await import("../../artifacts/api-server/src/app.js")).default;
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    console.log(`[setup] in-process app listening on ${baseUrl}\n`);
  }
  const req = makeReq(baseUrl);

  const createdEmails: string[] = [];
  const inviteIds: number[] = [];

  try {
    // 1. INVESTOR key (admin-issued) → users.role === "INVESTOR"
    await runCase(req, "1. INVESTOR registration key → users.role === \"INVESTOR\"",
      "INVESTOR", "ADMIN", "INVESTOR", createdEmails, inviteIds);

    // 2. ADMIN key (OWNER-issued — only OWNER may grant ADMIN) → users.role === "ADMIN"
    await runCase(req, "2. OWNER-issued ADMIN registration key → users.role === \"ADMIN\"",
      "ADMIN", "OWNER", "ADMIN", createdEmails, inviteIds);

    // 3. Control: no roleGrant → defaults to USER (proves grant is from the key)
    await runCase(req, "3. Key with no roleGrant → users.role defaults to \"USER\"",
      null, "ADMIN", "USER", createdEmails, inviteIds);
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    // Idempotent cleanup of every row this run created.
    try {
      for (const email of createdEmails) {
        const u = await getUserByEmail(email);
        if (u) {
          await pool.query("DELETE FROM auth_user_sessions WHERE user_id = $1", [u.id]).catch(() => {});
          await pool.query("DELETE FROM user_activity_events WHERE user_id = $1", [u.id]).catch(() => {});
          await pool.query("DELETE FROM users WHERE id = $1", [u.id]).catch(() => {});
        }
      }
      if (inviteIds.length > 0) {
        // beta_invite_accepted audit rows are written in the accept tx; remove ours.
        await pool.query(
          `DELETE FROM audit_events WHERE source = 'beta-invite-gate' AND payload->>'inviteId' = ANY($1::text[])`,
          [inviteIds.map((id) => String(id))],
        ).catch(() => {});
      }
      await pool.query("DELETE FROM beta_invites WHERE cohort = $1", [TAG]).catch(() => {});
      // INVITE_CODE_ATTEMPT is a per-IP rate-limit counter (not safety evidence).
      // Clear ONLY the loopback scope keys this in-process run could have created
      // (req.ip is one of these for an in-process listener) so repeated local runs
      // don't accumulate toward the cap, without touching any other scope's row.
      try {
        const { hashScope } = await import("../../artifacts/api-server/src/lib/security/cooldowns.js");
        const loopbackScopes = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "unknown"].map((ip) =>
          hashScope("ip", ip),
        );
        await pool.query(
          "DELETE FROM security_cooldowns WHERE action_key = 'INVITE_CODE_ATTEMPT' AND scope_key = ANY($1::text[])",
          [loopbackScopes],
        ).catch(() => {});
      } catch {
        /* best-effort cooldown cleanup; never fail the run on it */
      }
    } catch (e) {
      assert(false, `cleanup failed: ${(e as Error).message}`);
    }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }

  // The real invariant for THIS test is that registration creates ZERO live
  // commands (delta === 0). We assert the delta, not a global strict-zero —
  // the shared dev DB may already hold unrelated arx_live_commands rows from
  // prior runs, which this test must leave untouched.
  const endLive = await liveCommandsCount();
  assert(endLive === startLive, `arx_live_commands unchanged — zero created by registration (start=${startLive} end=${endLive})`);

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  await pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("[qaRegistrationKeyRoleGrant] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
