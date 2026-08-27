/**
 * Verify newly provisioned secrets WITHOUT exposing their values.
 *
 *   pnpm --filter @workspace/scripts run verify:secret-provisioning
 *   pnpm --filter @workspace/scripts run verify:secret-provisioning -- --allow-write
 *
 * Read-only by default. Nothing here prints, hashes, fingerprints, logs or
 * otherwise reveals a secret: presence is reported as a boolean, and the one
 * raw key this script can create never leaves the process.
 *
 * --allow-write additionally performs a create -> lookup -> revoke round trip
 * against the CURRENT pepper, which is the only way to prove the hashing path
 * actually works end to end. It writes a row to the live database and revokes
 * it again, so it is opt-in rather than default.
 */

import { betaInvitesRepo, db } from "@workspace/db";
import { sql } from "drizzle-orm";

const ALLOW_WRITE = process.argv.includes("--allow-write");
let failures = 0;

function report(id: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  // eslint-disable-next-line no-console
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${id.padEnd(52)} ${detail}`);
}
function skip(id: string, why: string): void {
  // eslint-disable-next-line no-console
  console.log(`  [SKIP] ${id.padEnd(52)} ${why}`);
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("\nSecret provisioning verification — presence only, no values shown\n");

  // ── 1 & 2: presence at runtime. Boolean only. Never the value, never its
  //          length, never a digest — a fingerprint is still an oracle.
  const vaultSet = (process.env["VAULT_OVERRIDE_TOKEN"] ?? "").trim().length > 0;
  report("1. VAULT_OVERRIDE_TOKEN is SET at runtime", vaultSet, vaultSet ? "present" : "ABSENT");

  const pepper = betaInvitesRepo.getRegistrationKeyPepper();
  report("2. REGISTRATION_KEY_PEPPER is SET at runtime", pepper.ok,
    pepper.ok ? "present and non-empty" : "ABSENT — key paths fail closed");

  // ── 3: the previous-pepper window should be ABSENT when there was nothing
  //      to preserve. Its presence would not be an error, but it would mean a
  //      stale secret is still accepted, so it must be deliberate.
  const prevSet = betaInvitesRepo.getRegistrationKeyPepperPrevious() !== null;
  report("3. REGISTRATION_KEY_PEPPER_PREVIOUS not required", !prevSet,
    prevSet
      ? "SET — a previous pepper is still accepted; unset it once migration is done"
      : "unset, as expected when no prior pepper existed");

  // ── 8: pre-existing unredeemed ARX-format keys. GATING CHECK.
  //      A key's hash cannot be reversed, so compatibility cannot be proven
  //      from the row alone — only the raw key would settle it, and nobody
  //      holds that but the invitee. Any outstanding ARX-format key is
  //      therefore reported as UNVERIFIABLE rather than assumed fine.
  let outstanding = -1;
  try {
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS c
        FROM beta_invites
       WHERE status IN ('PENDING','PAUSED')
         AND key_prefix IS NOT NULL
    `);
    const r = (rows as unknown as { rows?: Array<{ c: number }> }).rows
      ?? (rows as unknown as Array<{ c: number }>);
    outstanding = Number(r[0]?.c ?? 0);
  } catch (e) {
    report("8. pre-existing unredeemed ARX keys", false,
      `could not query: ${(e as Error).name}`);
  }
  if (outstanding >= 0) {
    report("8. no unredeemed ARX keys predating provisioning", outstanding === 0,
      outstanding === 0
        ? "0 outstanding — nothing to preserve"
        : `${outstanding} OUTSTANDING — cannot prove these were hashed under the `
          + "current pepper. If any predate provisioning they are now unredeemable. STOP.");
  }

  // ── 5: /system/override fail-closed, against the RUNNING app.
  //      Both probes are rejections by design and change no state — the
  //      endpoint only writes a behaviour record on SUCCESS, and neither probe
  //      carries a valid token. The correct token is never sent or needed.
  const baseUrl = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1];
  if (!baseUrl) {
    skip("5. /system/override is fail-closed", "needs --base-url=<running app>");
  } else {
    const body = JSON.stringify({ user: "verification", action: "probe" });
    const hdrs = { "content-type": "application/json" };
    try {
      // No token at all.
      const noTok = await fetch(`${baseUrl}/system/override`, { method: "POST", headers: hdrs, body });
      // A wrong token. Deliberately not secret-shaped.
      const badTok = await fetch(`${baseUrl}/system/override`, {
        method: "POST", body,
        headers: { ...hdrs, "X-Vault-Override-Token": "not-the-token" },
      });
      // 401 = token required and rejected. 503 = endpoint disabled because the
      // env var is unset. Both are fail-closed; 2xx is not.
      const ok = [401, 503].includes(noTok.status) && [401, 503].includes(badTok.status);
      report("5. /system/override is fail-closed", ok,
        `no-token -> ${noTok.status}, wrong-token -> ${badTok.status}`
        + (ok ? " (both rejected)" : " — EXPECTED 401 or 503"));
      // If the token is set, an absent token must NOT yield 503.
      if (vaultSet && noTok.status === 503) {
        report("5b. endpoint enabled when the token is set", false,
          "503 means the app does not see VAULT_OVERRIDE_TOKEN — redeploy may be pending");
      }
    } catch (e) {
      // "TypeError" alone says nothing actionable. A fetch that cannot connect
      // is the app not running, which is a different problem from the endpoint
      // misbehaving — and only one of them is a security finding.
      const cause = (e as { cause?: { code?: unknown } })?.cause?.code;
      const unreachable = cause === "ECONNREFUSED" || cause === "ENOTFOUND"
        || cause === "ECONNRESET" || cause === "UND_ERR_CONNECT_TIMEOUT";
      report("5. /system/override is fail-closed", false,
        unreachable
          ? `app not reachable at ${baseUrl} (${String(cause)}) — start it and re-run; `
            + "this is NOT evidence the endpoint is open"
          : `probe failed: ${(e as Error).name}`
            + (typeof cause === "string" ? `/${cause}` : ""));
    }
  }

  // ── 6 & 7: the hashing path, end to end.
  if (!ALLOW_WRITE) {
    skip("6. registration-key creation + lookup round trip", "needs --allow-write");
    skip("7. new keys use the current peppered path", "needs --allow-write");
  } else if (!pepper.ok) {
    report("6. registration-key creation + lookup round trip", false, "pepper absent");
  } else {
    let createdId: string | number | null = null;
    try {
      const created = await betaInvitesRepo.createRegistrationKey({
        invitedByUserId: null, notes: "secret-provisioning verification (auto-revoked)",
        expiresInDays: 1,
      });
      if (!created.ok) {
        report("6. registration-key creation + lookup round trip", false,
          `creation refused: ${created.error}`);
      } else {
        createdId = (created.invite as { id: string | number }).id;
        // The raw key stays in-process and is never logged.
        const found = await betaInvitesRepo.findInviteByCode(created.rawKey);
        const matched = found !== null
          && String((found as { id: string | number }).id) === String(createdId);
        report("6. registration-key creation + lookup round trip", matched,
          matched ? "created key resolves to its own row" : "created key did NOT resolve");

        // 7: it resolved via the PEPPERED tier specifically — the row carries a
        //    keyPrefix (ARX format) and no legacy plaintext column.
        const row = found as { keyPrefix?: string | null; inviteCode?: string | null } | null;
        const peppered = row !== null && !!row.keyPrefix && !row.inviteCode;
        report("7. new keys use the current peppered path", peppered,
          peppered ? "keyPrefix set, no plaintext column" : "row is not peppered-path shaped");
      }
    } catch (e) {
      report("6. registration-key creation + lookup round trip", false,
        `threw: ${(e as Error).name}`);
    } finally {
      if (createdId !== null) {
        try {
          await db.execute(sql`
            UPDATE beta_invites SET status = 'REVOKED', updated_at = NOW()
             WHERE id = ${createdId}
          `);
          // eslint-disable-next-line no-console
          console.log("  [ ok ] verification key revoked");
        } catch {
          // eslint-disable-next-line no-console
          console.log("  [WARN] could not revoke the verification key — revoke it manually");
        }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`verification aborted: ${e instanceof Error ? e.constructor.name : "unknown"}`);
  process.exitCode = 1;
});
