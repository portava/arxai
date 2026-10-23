// Password hashing using node:crypto scrypt — no third-party dep required.
// Format: `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`
//
// SAFETY: never log or persist plain-text passwords. Verify uses
// timingSafeEqual to avoid leaking length/equality through timing.

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// OWASP-aligned scrypt cost (N=2^16). The N value is encoded into every
// stored hash, so older hashes with N=2^14 will still verify.
const N = 65536; // CPU/memory cost (2^16)
const r = 8;
const p = 1;
const KEYLEN = 64;
// Node's scrypt defaults to a 32 MiB memory ceiling; with N=65536, r=8 we
// need ~64 MiB. We bump maxmem so scrypt doesn't refuse to run.
const SCRYPT_OPTS = { N, r, p, maxmem: 256 * 1024 * 1024 };

export function hashPassword(plain: string): string {
  if (typeof plain !== "string" || plain.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N2 = Number(parts[1]);
  const r2 = Number(parts[2]);
  const p2 = Number(parts[3]);
  if (!Number.isFinite(N2) || !Number.isFinite(r2) || !Number.isFinite(p2)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    expected = Buffer.from(parts[5]!, "base64");
  } catch {
    return false;
  }
  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length, { N: N2, r: r2, p: p2, maxmem: 256 * 1024 * 1024 });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
