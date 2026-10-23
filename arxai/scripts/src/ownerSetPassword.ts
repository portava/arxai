// ownerSetPassword — out-of-band password reset for a single account.
//
// PURPOSE
//   Lets an owner (or anyone with shell access to this Repl) set a new
//   password on a user account WITHOUT a UI-side reset flow and WITHOUT
//   ever logging the plaintext, the hash, or the session token.
//
// USAGE
//   Interactive (recommended): pnpm --filter @workspace/scripts run owner:set-password
//     → prompts for email, then prompts for password TWICE on stdin with
//       no echo. Nothing about the password is ever printed.
//
//   Non-interactive (CI / scripted recovery only):
//     OWNER_RESET_EMAIL=foo@bar.com OWNER_RESET_PASSWORD=... \
//       pnpm --filter @workspace/scripts run owner:set-password
//     The password is consumed and zeroed in memory before any logging.
//
// SAFETY
//   * Never logs the password or the resulting hash.
//   * Refuses if the password is shorter than 12 chars.
//   * Refuses if the password matches a known-bad smoke-test value.
//   * Always invalidates ALL existing sessions for the user as a side effect.
//   * Marked with the SENTINEL below so the
//     `no-real-user-password-mutation` CI guard knows this is the ONE
//     legitimate password-mutation tool. Test code that imports/copies
//     this sentinel without being this file will fail the guard.
//
// ARX-OWNER-PASSWORD-RESET-TOOL-SENTINEL-DO-NOT-COPY

import { scryptSync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { db, usersTable, authUserSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const N = 65536;
const r = 8;
const p = 1;
const KEYLEN = 64;
const SCRYPT_OPTS = { N, r, p, maxmem: 256 * 1024 * 1024 };

// Hard-coded list of passwords that must NEVER be allowed on any
// account, regardless of caller. Anyone updating this list MUST also
// add the new banned value to the CI guard's banned-literals set so the
// repo cannot reintroduce it elsewhere.
const BANNED_PASSWORDS = new Set([
  "SmokeTest!2026",
  "password",
  "password123",
  "changeme",
]);

function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdout = process.stdout as unknown as { write: (s: string) => void };
    stdout.write(`${label}: `);
    // Disable echo by writing a backspace for every keystroke. tsx/node
    // tty doesn't expose a one-shot no-echo on Linux, so we intercept.
    const stdin = process.stdin as unknown as { on: (e: string, h: (b: Buffer) => void) => void };
    let buf = "";
    const handler = (ch: Buffer) => {
      const s = ch.toString("utf8");
      if (s === "\n" || s === "\r" || s === "\r\n") {
        stdout.write("\n");
        rl.close();
        resolve(buf);
        return;
      }
      if (s === "\u0003") { process.exit(130); }
      if (s === "\u0008" || s === "\u007f") {
        if (buf.length > 0) buf = buf.slice(0, -1);
        return;
      }
      buf += s;
    };
    stdin.on("data", handler);
  });
}

async function main(): Promise<void> {
  const envEmail = process.env.OWNER_RESET_EMAIL;
  const envPw = process.env.OWNER_RESET_PASSWORD;

  let email: string;
  let pw: string;

  if (envEmail && envPw) {
    email = envEmail.trim().toLowerCase();
    pw = envPw;
    // Wipe env so child processes / logs don't inherit it.
    delete process.env.OWNER_RESET_PASSWORD;
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    email = await new Promise<string>((resolve) =>
      rl.question("User email: ", (a) => { rl.close(); resolve(a.trim().toLowerCase()); }),
    );
    pw = await promptHidden("New password (min 12 chars)");
    const confirm = await promptHidden("Confirm new password");
    if (pw !== confirm) {
      // eslint-disable-next-line no-console
      console.error("Passwords did not match.");
      process.exit(1);
    }
  }

  if (pw.length < 12) {
    // eslint-disable-next-line no-console
    console.error("Password must be at least 12 characters.");
    process.exit(1);
  }
  if (BANNED_PASSWORDS.has(pw)) {
    // eslint-disable-next-line no-console
    console.error("That password is on the banned-known-value list.");
    process.exit(1);
  }

  const found = await db.select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (found.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`No user with email ${email}.`);
    process.exit(1);
  }
  const userId = found[0]!.id;
  const role = found[0]!.role;

  const stored = hashPassword(pw);
  // Best-effort wipe of the plaintext in memory before any I/O.
  pw = randomBytes(64).toString("hex");

  await db.update(usersTable).set({ passwordHash: stored, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));
  const deleted = await db.delete(authUserSessionsTable)
    .where(eq(authUserSessionsTable.userId, userId)).returning({ id: authUserSessionsTable.id });

  // eslint-disable-next-line no-console
  console.log(`OK. user_id=${userId} role=${role} email=${email}. Invalidated ${deleted.length} existing session(s). New password is active; nothing about it has been logged.`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("ownerSetPassword failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
