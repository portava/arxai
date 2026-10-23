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

// ═════════════════════════════════════════════════════════════════════════════
// R6 multi-broker Phase 0 — credential-vault primitives (THROWING, fail-closed)
//
// audit-connections.md G-3 / red-fail test 4: `encryptField` FAILS OPEN — it
// returns the plaintext UNCHANGED when no key is configured. That degradation
// is honest and acceptable for its original AACI fields (legacy plaintext rows
// are expected, flagged via readField, and surfaced for review), but it is
// NEVER acceptable for broker credentials: a silently-written plaintext
// credential row is exactly the defect the audit pinned.
//
// CONSTRAINT (do not "fix"): the fail-open semantics of encryptField/readField
// above are LOAD-BEARING for the AACI fields that already flow through them.
// Changing encryptField to throw would turn a missing env key into an AACI
// outage. Credentials get NEW throwing variants; the legacy path stays as-is.
//
// Ciphertext format: CREDENTIAL_CIPHERTEXT_PREFIX + standard arxenc envelope
// ("arxcred1:" + "arxenc:<v>:<iv>:<tag>:<ct>"). The distinct prefix makes a
// credential blob mechanically distinguishable from legacy encryptField
// output in BOTH directions:
//   - security.isEncryptedEnvelope(credentialBlob) === false (no "arxenc:" start)
//   - isCredentialCiphertext(encryptFieldOutput)   === false (no "arxcred1:" start)
// Consequence: readField() would classify a credential blob as "legacy
// plaintext" and return the raw blob — so credential values must ONLY ever be
// read via decryptCredential(). The prefix guard below makes decryptCredential
// equally refuse non-credential input instead of guessing.
//
// LOGGING RULE: no plaintext, no ciphertext, no key material in any error
// message or log line produced here. Errors carry only static text + a code.
// ═════════════════════════════════════════════════════════════════════════════

/** Prefix stamped on every credential ciphertext (versioned independently of the key version inside the envelope). */
export const CREDENTIAL_CIPHERTEXT_PREFIX = "arxcred1:";

/**
 * Thrown when the credential vault is asked to operate without a configured
 * active key. `code` matches the HTTP surface the audit specifies for the
 * connect flow (503 VAULT_NOT_READY). Message is static — never includes the
 * value being encrypted/decrypted.
 */
export class CredentialEncryptionUnavailableError extends Error {
  readonly code = "VAULT_NOT_READY" as const;
  constructor() {
    super(
      "Credential vault is not ready: no active encryption key is configured. " +
        "Refusing to handle credentials (fail-closed; never plaintext).",
    );
    this.name = "CredentialEncryptionUnavailableError";
  }
}

/**
 * Thrown when decryptCredential receives a value that is not a well-formed
 * credential ciphertext (missing prefix, corrupt envelope, failed auth tag is
 * surfaced by node:crypto itself). Message is static — the offending value is
 * NEVER echoed, since a malformed "ciphertext" may in fact be a plaintext
 * credential.
 */
export class CredentialCiphertextInvalidError extends Error {
  readonly code = "CREDENTIAL_CIPHERTEXT_INVALID" as const;
  constructor(detail: string) {
    super(`Invalid credential ciphertext: ${detail}`);
    this.name = "CredentialCiphertextInvalidError";
  }
}

/** True when a stored value carries the credential-vault prefix. */
export function isCredentialCiphertext(stored: unknown): boolean {
  return (
    typeof stored === "string" && stored.startsWith(CREDENTIAL_CIPHERTEXT_PREFIX)
  );
}

/**
 * Encrypt a broker credential for storage. THROWS
 * CredentialEncryptionUnavailableError when the active key is not configured —
 * unlike encryptField, this can never return plaintext.
 */
export function encryptCredential(plaintext: string): string {
  const key = getKeyring().get(ACTIVE_KEY_VERSION);
  if (!key || !isEncryptionReady()) {
    throw new CredentialEncryptionUnavailableError();
  }
  return (
    CREDENTIAL_CIPHERTEXT_PREFIX +
    security.encryptString(plaintext, ACTIVE_KEY_VERSION, key as Buffer)
  );
}

/**
 * Decrypt a stored credential ciphertext. Fail-closed on every branch:
 *  - vault not ready                → CredentialEncryptionUnavailableError
 *  - missing credential prefix      → CredentialCiphertextInvalidError
 *  - inner payload not an envelope  → CredentialCiphertextInvalidError
 *  - unknown key version / bad tag  → throws from security.decryptString
 * There is NO legacy-plaintext fallback here by design: a credential that is
 * not verifiably ours to decrypt is never returned.
 */
export function decryptCredential(stored: string): string {
  if (!isEncryptionReady()) {
    throw new CredentialEncryptionUnavailableError();
  }
  if (!isCredentialCiphertext(stored)) {
    throw new CredentialCiphertextInvalidError(
      "value does not carry the credential prefix.",
    );
  }
  const envelope = stored.slice(CREDENTIAL_CIPHERTEXT_PREFIX.length);
  if (!security.isEncryptedEnvelope(envelope)) {
    // Corrupt row (prefix present but no envelope behind it). Refuse — never
    // return the raw bytes; they could be an accidentally-prefixed plaintext.
    throw new CredentialCiphertextInvalidError(
      "prefixed value does not contain an encryption envelope.",
    );
  }
  const result = security.decryptString(envelope, getKeyring());
  return result.value;
}

/**
 * TEST-ONLY (pattern: resetBrokerProviderForTests in broker/registry.ts).
 * Drops the cached keyring so a test can flip ARX_ENCRYPTION_KEY between
 * not-ready and ready states within one process. Never called in production.
 */
export function __resetKeyringCacheForTests(): void {
  cachedKeyring = null;
}
