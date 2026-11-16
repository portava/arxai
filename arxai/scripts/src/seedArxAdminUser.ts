/**
 * seedArxAdminUser.ts
 *
 * One-shot bootstrap for an ARX ADMIN account. Idempotent: if the email
 * already exists, the user's role is promoted to ADMIN and the password
 * is reset to the supplied value (or a freshly generated one).
 *
 * Uses the same scrypt hashing the auth route uses
 * (artifacts/api-server/src/lib/auth/password.ts).
 *
 * Refuses to run in production.
 */

import { scryptSync, randomBytes } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const N = 65536, r = 8, p = 1, KEYLEN = 64;
const SCRYPT_OPTS = { N, r, p, maxmem: 256 * 1024 * 1024 };

function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("[seedArxAdminUser] refused: NODE_ENV=production");
    process.exit(2);
  }

  const email = (process.env.ARX_ADMIN_EMAIL ?? "admin@arx.local").trim().toLowerCase();
  const password = process.env.ARX_ADMIN_PASSWORD ?? `Arx-Admin-${randomBytes(6).toString("hex")}`;
  const name = process.env.ARX_ADMIN_NAME ?? "ARX Admin";

  const passwordHash = hashPassword(password);

  const existing = (await db.execute(sql`SELECT id, email, role FROM users WHERE email = ${email} LIMIT 1`)) as unknown as { rows: Array<{ id: number; email: string; role: string }> };
  let userId: number;
  if (existing.rows.length > 0) {
    userId = existing.rows[0]!.id;
    await db.execute(sql`UPDATE users SET role='ADMIN', password_hash=${passwordHash}, name=${name}, updated_at=now() WHERE id=${userId}`);
    console.log(`[seedArxAdminUser] PROMOTED+RESET id=${userId} email=${email} role=ADMIN`);
  } else {
    const inserted = (await db.execute(sql`INSERT INTO users (email, name, password_hash, role) VALUES (${email}, ${name}, ${passwordHash}, 'ADMIN') RETURNING id`)) as unknown as { rows: Array<{ id: number }> };
    userId = inserted.rows[0]!.id;
    console.log(`[seedArxAdminUser] CREATED id=${userId} email=${email} role=ADMIN`);
  }

  console.log("");
  console.log("===========================================================");
  console.log("  ARX ADMIN LOGIN — shown ONCE (password not persisted plaintext)");
  console.log("===========================================================");
  console.log(`  email    = ${email}`);
  console.log(`  password = ${password}`);
  console.log(`  role     = ADMIN`);
  console.log(`  user id  = ${userId}`);
  console.log("===========================================================");
  console.log("  Login at /login   →   Admin pages: /admin/beta-control, etc.");
  console.log("===========================================================");
}

main().catch((err) => {
  console.error("[seedArxAdminUser] error", err);
  process.exit(1);
});
