// ═══════════════════════════════════════════════════════════════════════════
// security/encryption.ts — future-ready encryption-at-rest abstraction.
//
// AES-256-GCM via the built-in node:crypto (NO new crypto packages). Keys are
// passed IN — this module never reads env or storage; artifacts/api-server
// resolves keys from environment secrets and owns the keyring.
//
// Backward compatibility is a hard requirement: existing plaintext rows must
// keep reading. decryptString() recognises the envelope format; anything else
// is returned verbatim and flagged `legacyPlaintext` for admin review. A bad
// auth tag / unknown key version THROWS — we never silently return ciphertext.
// ═══════════════════════════════════════════════════════════════════════════

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";

const ALGORITHM: CipherGCMTypes = "aes-256-gcm";
const ENVELOPE_PREFIX = "arxenc";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // 256-bit key

/** A map of keyVersion → 32-byte key. Lets keys rotate without losing reads. */
export type Keyring = ReadonlyMap<number, Buffer>;

export interface DecryptResult {
  value: string;
  /** True when the stored value was an ARX envelope and was decrypted. */
  wasEncrypted: boolean;
  /** Key version used to decrypt, or null for legacy plaintext. */
  keyVersion: number | null;
  /** True when the value was stored as plaintext (pre-encryption rows). */
  legacyPlaintext: boolean;
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be a ${KEY_BYTES}-byte Buffer (got ${
        Buffer.isBuffer(key) ? `${key.length} bytes` : typeof key
      }).`,
    );
  }
}

/** True when `stored` looks like an ARX encryption envelope. */
export function isEncryptedEnvelope(stored: unknown): boolean {
  return typeof stored === "string" && stored.startsWith(`${ENVELOPE_PREFIX}:`);
}

/**
 * Encrypt a UTF-8 string under a given key version. Output format (all base64):
 *   arxenc:<keyVersion>:<iv>:<authTag>:<ciphertext>
 */
export function encryptString(
  plaintext: string,
  keyVersion: number,
  key: Buffer,
): string {
  assertKey(key);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new Error("keyVersion must be a positive integer.");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX,
    String(keyVersion),
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Read a stored value:
 *  - ARX envelope → decrypt with the matching key version from the keyring.
 *    Unknown version or failed auth tag THROWS (never returns ciphertext).
 *  - anything else → returned verbatim, flagged as legacy plaintext.
 */
export function decryptString(
  stored: string,
  keyring: Keyring,
): DecryptResult {
  if (!isEncryptedEnvelope(stored)) {
    return {
      value: stored,
      wasEncrypted: false,
      keyVersion: null,
      legacyPlaintext: true,
    };
  }

  const parts = stored.split(":");
  // arxenc : version : iv : tag : ct
  if (parts.length !== 5) {
    throw new Error("Malformed encryption envelope.");
  }
  const keyVersion = Number(parts[1]);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new Error("Malformed encryption envelope (bad key version).");
  }
  const key = keyring.get(keyVersion);
  if (!key) {
    throw new Error(`No key available for version ${keyVersion}.`);
  }
  assertKey(key);

  const iv = Buffer.from(parts[2], "base64");
  const authTag = Buffer.from(parts[3], "base64");
  const ciphertext = Buffer.from(parts[4], "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // .final() throws if the auth tag does not verify — desired fail-closed.
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");

  return {
    value: plaintext,
    wasEncrypted: true,
    keyVersion,
    legacyPlaintext: false,
  };
}

/**
 * Whether a stored value should be re-written under the active key version
 * (true for legacy plaintext, or an envelope under an older key). Helps later
 * phases migrate rows lazily on read without blocking startup.
 */
export function needsReencryption(
  stored: string,
  activeKeyVersion: number,
): boolean {
  if (!isEncryptedEnvelope(stored)) return true;
  const parts = stored.split(":");
  if (parts.length !== 5) return true;
  const v = Number(parts[1]);
  return !Number.isInteger(v) || v < activeKeyVersion;
}

export { KEY_BYTES, ALGORITHM };
