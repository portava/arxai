/**
 * POST-SET VERIFICATION — run this AFTER the owner has set
 * REGISTRATION_KEY_PEPPER, in the environment the API server actually runs in.
 *
 *   pnpm --filter @workspace/scripts run verify:registration-key-pepper
 *
 * ONE command. It proves two things that no presence check can prove on its own:
 *
 *   1. The secret is provisioned AND this process can read it.
 *   2. The whole invite path works end to end under THAT value — mint a real
 *      ARX key, present it to the real POST /api/auth/register, get a real
 *      account back, and see the key flip to ACCEPTED in the same transaction.
 *
 * It NEVER prints, logs, hashes or fingerprints the pepper. It reads the
 * ambient value and NEVER sets, rotates or writes one — this script stops at
 * the owner's press and verifies the other side of it.
 *
 * WHY MINT-AND-REGISTER RATHER THAN "IS THE VAR SET". A set-but-wrong pepper
 * looks identical to a set-and-correct one from the outside: `present: true`
 * either way, while every key an admin issues silently fails at signup. The
 * only proof that generation and validation agree is a key that actually
 * redeems, so that is what this does.
 *
 * DEFAULT: boots the real Express app in-process on an ephemeral port, so the
 * minting side and the serving side are the same process and the same value.
 *
 * ARX_QA_BASE_URL=<url>: probes an ALREADY-RUNNING server instead. This is the
 * stronger check for a deployment — the key is minted here and redeemed there,
 * so it passes only if that server sees the SAME pepper this process does. It
 * is also the check that catches the classic Replit trap: a published build
 * holds a boot-time snapshot of the environment and will not see a newly-set
 * secret until it is REPUBLISHED.
 *
 * WRITES: one beta_invites row, one users row, one session, one audit row —
 * all tagged with a unique cohort and all deleted in a finally, on success and
 * on failure alike.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { pool, betaInvitesRepo } from "@workspace/db";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TAG = `verifyPepper_${Date.now()}_${randomBytes(3).toString("hex")}`;

// The gate must be ON for the invite path to run at all. Set on THIS process
// only, and only for the in-process app — never written to any secret store,
// and never touched when probing an external server (there, the deployment's
// own setting is part of what we are verifying).
if (!EXTERNAL_BASE) process.env["ARX_BETA_INVITE_REQUIRED"] = "true";

let passes = 0;
let failures = 0;
const notes: string[] = [];

function assert(cond: boolean, label: string): boolean {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  FAIL  ${label}`);
  }
  return cond;
}

function note(s: string): void {
  notes.push(s);
  // eslint-disable-next-line no-console
  console.log(`  note  ${s}`);
}

interface Resp { status: number; bodyText: string }
function makeReq(baseUrl: string) {
  return async function req(path: string, body: unknown): Promise<Resp> {
    const r = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, bodyText: await r.text() };
  };
}

function errorCodeOf(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

async function getUserByEmail(email: string): Promise<{ id: number; role: string } | null> {
  const r = await pool.query<{ id: number; role: string }>(
    "SELECT id, role FROM users WHERE email = $1 LIMIT 1", [email.toLowerCase()],
  );
  return r.rows[0] ?? null;
}

async function getInviteState(id: number): Promise<{ status: string; accepted_user_id: number | null } | null> {
  const r = await pool.query<{ status: string; accepted_user_id: number | null }>(
    "SELECT status, accepted_user_id FROM beta_invites WHERE id = $1", [id],
  );
  return r.rows[0] ?? null;
}

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

async function main(): Promise<void> {
  /* eslint-disable no-console */
  console.log("\nREGISTRATION_KEY_PEPPER — post-set verification");
  console.log("==============================================");
  console.log("No secret value is printed, hashed or fingerprinted anywhere below.\n");

  // ── 1. Provisioned and readable ─────────────────────────────────────────
  console.log("[1] the secret is provisioned and readable by this process");
  const pc = betaInvitesRepo.getRegistrationKeyPepper();
  if (!assert(pc.ok, "REGISTRATION_KEY_PEPPER is present and non-empty")) {
    console.error(
      "\nSTOP. The pepper is not visible to this process. Nothing below can be verified.\n"
      + "  - On Replit, a secret set mid-session does NOT reach an already-running process:\n"
      + "    the runtime holds a boot-time env snapshot. Restart the workflow (dev) or\n"
      + "    REDEPLOY (production), then re-run this command.\n"
      + "  - See docs/REGISTRATION_KEY_PEPPER_RUNBOOK.md\n",
    );
    await pool.end().catch(() => {});
    process.exit(1);
  }
  // Held in memory to prove it never leaks into a response body. Never printed.
  const pepperValue = pc.ok ? pc.pepper : "";
  // Shape only — a length is not an oracle for a high-entropy secret, and the
  // runbook asks for >= 32 chars. Reported so a too-short value is caught here
  // rather than by a brute-force later.
  assert(pepperValue.length >= 32,
    `pepper length is at least 32 characters (actual length ${pepperValue.length})`);

  if (betaInvitesRepo.getRegistrationKeyPepperPrevious() !== null) {
    note("REGISTRATION_KEY_PEPPER_PREVIOUS is SET — a rotation window is OPEN. "
      + "Keys under both peppers redeem. UNSET it once the window closes.");
  } else {
    note("REGISTRATION_KEY_PEPPER_PREVIOUS is unset — no rotation window is open.");
  }

  const startLive = await liveCommandsCount();

  // ── 2. Boot / locate the server ─────────────────────────────────────────
  let server: Server | null = null;
  let baseUrl: string;
  if (EXTERNAL_BASE) {
    baseUrl = EXTERNAL_BASE;
    console.log(`\n[2] probing the running server at ${baseUrl}`);
    note("the key is minted HERE and redeemed THERE — this passes only if that "
      + "server sees the same pepper this process does");
  } else {
    const app = (await import("../../artifacts/api-server/src/app.js")).default;
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    console.log(`\n[2] in-process app listening on ${baseUrl}`);
  }
  const req = makeReq(baseUrl);

  const createdEmails: string[] = [];
  const inviteIds: number[] = [];

  try {
    // ── 3. The gate is live and discriminating ────────────────────────────
    // A bogus ARX-shaped key must come back INVITE_NOT_FOUND, not
    // PEPPER_MISSING. This is the single probe that distinguishes "the server
    // has the pepper" from "the server is fail-closed", and it consumes no
    // real key.
    console.log("\n[3] the serving process has the pepper (bogus-key probe)");
    const bogus = await req("/api/auth/register", {
      email: `${TAG}_bogus@arx.test`,
      password: `Pw-${randomBytes(8).toString("hex")}`,
      registrationKey: "ARX-ZZZZ-ZZZZ-ZZZZ",
    });
    const bogusCode = errorCodeOf(bogus.bodyText);
    assert(bogusCode !== "PEPPER_MISSING",
      `bogus key is NOT refused with PEPPER_MISSING (got ${bogusCode ?? bogus.status})`);
    assert(bogusCode === "INVITE_NOT_FOUND",
      `bogus key is refused with INVITE_NOT_FOUND (got ${bogusCode ?? bogus.status})`);
    if (bogusCode === "PEPPER_MISSING") {
      note("the SERVING process cannot see the pepper even though this one can — "
        + "on Replit that means a published build predating the secret. REDEPLOY.");
    }

    // ── 4. Mint under the provisioned pepper ──────────────────────────────
    console.log("\n[4] mint a real registration key under the provisioned pepper");
    const mint = await betaInvitesRepo.createRegistrationKey({
      email: null, roleGrant: null, invitedByUserId: null, invitedByRole: "ADMIN",
      cohort: TAG, notes: "post-set pepper verification (auto-deleted)", expiresInDays: 1,
    });
    assert(mint.ok, `createRegistrationKey succeeds (${mint.ok ? "ok" : mint.error})`);
    if (!mint.ok) throw new Error(`mint refused (${mint.error}) — cannot verify the redemption path`);
    inviteIds.push(mint.invite.id);
    assert(!!mint.invite.keyPrefix && !mint.invite.inviteCode,
      "the minted row is peppered-path shaped (key_prefix set, no plaintext column)");

    // The raw key never leaves this process and is never logged.
    const resolved = await betaInvitesRepo.findInviteByCode(mint.rawKey);
    assert(resolved !== null && resolved.id === mint.invite.id,
      "the minted key resolves to its own row via the peppered lookup");

    // ── 5. Redeem it through the real endpoint ────────────────────────────
    console.log("\n[5] redeem it end to end through POST /api/auth/register");
    const email = `${TAG}@arx.test`;
    const password = `Pw-${randomBytes(8).toString("hex")}`;
    const reg = await req("/api/auth/register", { email, password, registrationKey: mint.rawKey });
    createdEmails.push(email);
    assert(reg.status === 201,
      `register returns 201 (got ${reg.status}${reg.status === 201 ? "" : ` / ${errorCodeOf(reg.bodyText) ?? reg.bodyText.slice(0, 100)}`})`);

    const user = await getUserByEmail(email);
    assert(user !== null, "the user row was created");
    assert(user?.role === "USER", `the key with no roleGrant yields role USER (got ${user?.role})`);

    const state = await getInviteState(mint.invite.id);
    assert(state?.status === "ACCEPTED", `the key flipped to ACCEPTED (got ${state?.status})`);
    assert(state?.accepted_user_id === user?.id,
      `accepted_user_id points at the new user (key=${state?.accepted_user_id} user=${user?.id})`);

    // ── 6. Single use ─────────────────────────────────────────────────────
    console.log("\n[6] the key is single-use");
    const reuse = await req("/api/auth/register", {
      email: `${TAG}_reuse@arx.test`, password, registrationKey: mint.rawKey,
    });
    createdEmails.push(`${TAG}_reuse@arx.test`);
    assert(errorCodeOf(reuse.bodyText) === "INVITE_NOT_PENDING",
      `a second use is refused with INVITE_NOT_PENDING (got ${errorCodeOf(reuse.bodyText) ?? reuse.status})`);

    // ── 7. Nothing leaked the value ───────────────────────────────────────
    console.log("\n[7] no response carried the secret");
    const allBodies = [bogus.bodyText, reg.bodyText, reuse.bodyText].join("\n");
    assert(!allBodies.includes(pepperValue),
      "no register response body contains the pepper value");
    assert(!allBodies.includes(mint.rawKey),
      "no register response body echoes the raw registration key");
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    try {
      for (const em of createdEmails) {
        const u = await getUserByEmail(em);
        if (u) {
          await pool.query("DELETE FROM auth_user_sessions WHERE user_id = $1", [u.id]).catch(() => {});
          await pool.query("DELETE FROM user_activity_events WHERE user_id = $1", [u.id]).catch(() => {});
          await pool.query("DELETE FROM users WHERE id = $1", [u.id]).catch(() => {});
        }
      }
      if (inviteIds.length > 0) {
        await pool.query(
          "DELETE FROM audit_events WHERE source = 'beta-invite-gate' AND payload->>'inviteId' = ANY($1::text[])",
          [inviteIds.map(String)],
        ).catch(() => {});
      }
      await pool.query("DELETE FROM beta_invites WHERE cohort = $1", [TAG]).catch(() => {});
      // Per-IP attempt counter, not safety evidence. Clear only the loopback
      // scopes this run could have created.
      try {
        const { hashScope } = await import("../../artifacts/api-server/src/lib/security/cooldowns.js");
        const scopes = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "unknown"].map((ip) => hashScope("ip", ip));
        await pool.query(
          "DELETE FROM security_cooldowns WHERE action_key = 'INVITE_CODE_ATTEMPT' AND scope_key = ANY($1::text[])",
          [scopes],
        ).catch(() => {});
      } catch { /* best effort */ }
    } catch (e) {
      assert(false, `cleanup failed: ${(e as Error).message}`);
    }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }

  const endLive = await liveCommandsCount();
  assert(endLive === startLive,
    `arx_live_commands unchanged — registration created zero live commands (start=${startLive} end=${endLive})`);

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  if (failures === 0) {
    console.log("\nVERDICT: PROVISIONED AND WORKING. A key minted under the current pepper was");
    console.log("redeemed end to end through the real registration endpoint.\n");
  } else {
    console.log("\nVERDICT: NOT VERIFIED. Do not announce the shield as working.\n");
  }
  /* eslint-enable no-console */
  await pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error("[verifyRegistrationKeyPepperProvisioned] ABORTED:", (e as Error).message);
  // eslint-disable-next-line no-console
  console.error("VERDICT: NOT VERIFIED (aborted) — this is not evidence the pepper works.");
  await pool.end().catch(() => {});
  process.exit(1);
});
