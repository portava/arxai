// AACI Security Foundation — encryption-at-rest composition (api-server side).
//
// Resolves the keyring from ENVIRONMENT SECRETS ONLY (never hardcoded, never in
// client code) and delegates the actual crypto to the pure domain abstraction.
// Backward-compatible: legacy plaintext rows keep reading and are flagged for
// review. If no key is configured, encryption is honestly "not ready" — reads
// of plaintext still work; we never block startup and never fake-encrypt.

import { scryptSync } from "node:crypto";
import { security } from "@workspace/domain";

const ACTIVE_KEY_VERSION =
  security.DEFAULT_SECURITY_POLICIES.encryptionPolicy.activeKeyVersion;

// Versioned passphrase env vars. Add ARX_ENCRYPTION_KEY_V2 etc. when rotating;
// older versions stay present so old envelopes keep decrypting.
const KEY_ENV_BY_VERSION: Record<number, string> = {
  1: "ARX_ENCRYPTION_KEY",
};
const KDF_SALT = "arx-aaci-security-v1";

let cachedKeyring: security.Keyring | null = null;

/** Build a 32-byte key from a passphrase via scrypt (built-in, deterministic). */
function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, KDF_SALT, security.KEY_BYTES);
}

/** Resolve the keyring from env once. Empty when no key is configured. */
export function getKeyring(): security.Keyring {
  if (cachedKeyring) return cachedKeyring;
  const map = new Map<number, Buffer>();
  for (const [versionStr, envName] of Object.entries(KEY_ENV_BY_VERSION)) {
    const passphrase = process.env[envName];
    if (passphrase && passphrase.length >= 16) {
      map.set(Number(versionStr), deriveKey(passphrase));
    }
  }
  cachedKeyring = map;
  return cachedKeyring;
}

/** True when at least the active key version is configured. */
export function isEncryptionReady(): boolean {
  return getKeyring().has(ACTIVE_KEY_VERSION);
}

/**
 * Encrypt a sensitive field for storage. Returns plaintext UNCHANGED when no
 * key is configured (honest degradation — caller can check isEncryptionReady()
 * to surface a "not encrypted at rest" warning) instead of throwing on startup.
 */
export function encryptField(plaintext: string): string {
  const keyring = getKeyring();
  const key = keyring.get(ACTIVE_KEY_VERSION);
  if (!key) return plaintext;
  return security.encryptString(plaintext, ACTIVE_KEY_VERSION, key as Buffer);
}

export interface FieldReadResult extends security.DecryptResult {
  /** True when this row should be re-written under the active key version. */
  needsReencryption: boolean;
}

/** Decrypt-on-read with legacy-plaintext fallback + a re-encrypt flag. */
export function readField(stored: string): FieldReadResult {
  const result = security.decryptString(stored, getKeyring());
  return {
    ...result,
    needsReencryption: security.needsReencryption(stored, ACTIVE_KEY_VERSION),
  };
}

/** True when a stored value is a legacy plaintext row that should be reviewed. */
export function isLegacyPlaintext(stored: string): boolean {
  return !security.isEncryptedEnvelope(stored);
}
