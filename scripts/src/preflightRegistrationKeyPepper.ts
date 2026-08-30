/**
 * PRE-FLIGHT — run this BEFORE setting or rotating REGISTRATION_KEY_PEPPER.
 *
 *   pnpm --filter @workspace/scripts run preflight:registration-key-pepper
 *   pnpm --filter @workspace/scripts run preflight:registration-key-pepper -- --json
 *
 * Answers one question honestly: does a registration key already exist that
 * setting or changing the pepper would render permanently unredeemable?
 *
 * WHY IT MATTERS. A key's stored hash is sha256(normalizeArxKey(rawKey) +
 * pepper). The hash cannot be reversed and the raw key is displayed exactly
 * once at mint time, so there is NO re-hash path: a key whose pepper changes
 * cannot be repaired, only revoked and re-issued to its holder. This script
 * exists so that is known BEFORE the press rather than discovered after it.
 *
 * NEVER prints, hashes or fingerprints the pepper. It reports PRESENCE as a
 * boolean and counts rows. It writes nothing and reads no hash column.
 *
 * HONEST DEGRADATION. The tally is `Tally | null`. A tally that could not be
 * read is reported as null WITH the reason, and the process exits 2. It is
 * never reported as zero — a confident zero here is exactly the lie that would
 * tell an owner a rotation is free when it is not.
 */

import { db, betaInvitesRepo } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  tallyInvites,
  PEPPER_CHANGE_CATEGORY_ORDER,
  PEPPER_CHANGE_CATEGORY_NOTES,
  type InviteFacts,
  type Tally,
} from "./registrationKeyPepperPreflightCore.js";

// ── Read ───────────────────────────────────────────────────────────────────

interface RawRow { status: string; key_prefix: string | null; expires_at: string | Date | null }

/** Reads only the four non-secret columns the classification needs. Never
 *  selects invite_code_hash or invite_code. */
async function readInviteFacts(): Promise<
  { ok: true; rows: InviteFacts[] } | { ok: false; reason: string }
> {
  try {
    const res = await db.execute(sql`
      SELECT status, key_prefix, expires_at FROM beta_invites
    `);
    const raw = ((res as unknown as { rows?: RawRow[] }).rows ?? (res as unknown as RawRow[])) ?? [];
    return {
      ok: true,
      rows: raw.map((r) => ({
        status: String(r.status),
        isArxKey: r.key_prefix !== null && r.key_prefix !== undefined,
        expiresAt: r.expires_at === null || r.expires_at === undefined
          ? null
          : new Date(r.expires_at),
      })),
    };
  } catch (e) {
    return { ok: false, reason: `${(e as Error).name} — ${(e as Error).message.slice(0, 180)}` };
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const jsonOut = process.argv.includes("--json");

  const pepperCurrentlySet = betaInvitesRepo.isRegistrationKeyPepperConfigured();
  const rotationWindowOpen = betaInvitesRepo.getRegistrationKeyPepperPrevious() !== null;
  const shieldEnabled = process.env["ARX_BETA_INVITE_REQUIRED"] === "true";

  const read = await readInviteFacts();
  const tally: Tally | null = read.ok ? tallyInvites(read.rows, new Date()) : null;
  const unreadReason: string | null = read.ok ? null : read.reason;

  /* eslint-disable no-console */
  if (jsonOut) {
    console.log(JSON.stringify(
      { pepperCurrentlySet, rotationWindowOpen, shieldEnabled, tally, unreadReason },
      null, 2,
    ));
  } else {
    console.log("\nREGISTRATION_KEY_PEPPER — pre-flight");
    console.log("====================================");
    console.log("No secret value is read, printed, hashed or fingerprinted here.\n");
    console.log("Current state (presence only):");
    console.log(`  REGISTRATION_KEY_PEPPER            ${pepperCurrentlySet ? "SET" : "ABSENT"}`);
    console.log(`  REGISTRATION_KEY_PEPPER_PREVIOUS   ${rotationWindowOpen ? "SET — a rotation window is OPEN" : "unset"}`);
    console.log(`  ARX_BETA_INVITE_REQUIRED           ${shieldEnabled ? "true — the shield is ON" : "not 'true' — the shield is OFF"}`);
    console.log("\nbeta_invites — what a pepper change would do:");
    if (tally === null) {
      console.log("  (no counts — the table could not be read)");
    } else {
      for (const cat of PEPPER_CHANGE_CATEGORY_ORDER) {
        console.log(`  ${String(tally[cat]).padStart(5)}  ${cat.padEnd(15)} ${PEPPER_CHANGE_CATEGORY_NOTES[cat]}`);
      }
    }
    console.log("");
  }

  if (tally === null) {
    console.error("VERDICT: UNKNOWN — beta_invites could not be read.");
    console.error(`  reason: ${unreadReason}`);
    console.error(
      "\nThis is NOT a clean bill of health. Do not treat an unread count as zero.\n"
      + "Fix DATABASE_URL / connectivity and re-run before touching the secret.\n",
    );
    process.exitCode = 2;
    return;
  }

  const atRisk = tally.AT_RISK;
  const legacy = tally.LEGACY_PENDING;

  if (!pepperCurrentlySet) {
    console.log("VERDICT: FIRST SET (no pepper is visible to this process).");
    if (atRisk > 0) {
      console.log(
        `  ${atRisk} redeemable ARX key(s) exist. They were minted under some OTHER pepper.\n`
        + "  Whatever you set now, they stay unredeemable unless the value you set is byte-\n"
        + "  identical to the one they were minted under. Their raw values are NOT recoverable\n"
        + "  from the rows. Plan to REVOKE and RE-ISSUE them.",
      );
    } else {
      console.log("  0 at-risk ARX keys — nothing is invalidated by setting the pepper now.");
    }
    if (legacy > 0) {
      console.log(`  ${legacy} legacy PENDING invite(s) are currently BLOCKED by the absent pepper and start working once it is set.`);
    }
  } else if (atRisk === 0) {
    console.log("VERDICT: SAFE TO ROTATE — 0 redeemable ARX keys would be invalidated.");
    if (legacy > 0) {
      console.log(`  ${legacy} legacy PENDING invite(s) exist; their hashes do not involve the pepper, so a rotation does not touch them.`);
    }
  } else {
    console.log(`VERDICT: ROTATION IS DESTRUCTIVE — ${atRisk} redeemable ARX key(s) would be permanently invalidated.`);
    console.log(
      "  There is no re-hash path: the raw key is shown once at mint and only the peppered\n"
      + "  hash is stored. To rotate without breaking these holders, either\n"
      + "    (a) set REGISTRATION_KEY_PEPPER_PREVIOUS to the OUTGOING value for a migration\n"
      + "        window — both peppers then redeem — and UNSET it when the window closes, or\n"
      + "    (b) revoke the outstanding keys and re-issue fresh ones after the rotation.",
    );
  }
  console.log("");
  /* eslint-enable no-console */
  process.exitCode = 0;
}

main()
  .catch((e: unknown) => {
    /* eslint-disable no-console */
    console.error(
      `pre-flight aborted: ${e instanceof Error ? `${e.name} — ${e.message.slice(0, 200)}` : "unknown"}`,
    );
    console.error("VERDICT: UNKNOWN — treat every count as unread, not as zero.");
    /* eslint-enable no-console */
    process.exitCode = 2;
  })
  .finally(() => {
    void (async () => {
      const { pool } = await import("@workspace/db");
      await pool.end().catch(() => {});
    })();
  });
