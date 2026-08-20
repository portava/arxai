// Credential-vault primitives — throwing matrix (R6 Phase 0, audit G-3).
//
// audit-connections.md red-fail test 4 pins the defect class: with
// ARX_ENCRYPTION_KEY unset, `encryptField` returns the plaintext UNCHANGED, so
// routing a credential through it silently writes a plaintext credential row.
// This suite proves the NEW `encryptCredential`/`decryptCredential`:
//   1. THROW CredentialEncryptionUnavailableError (code VAULT_NOT_READY) when
//      the vault is not ready — in both directions, never plaintext through;
//   2. never leak the plaintext or key material in an error message;
//   3. round-trip under a configured key;
//   4. stamp a ciphertext prefix DISTINCT from legacy encryptField envelopes
//      (distinguishable in both directions, and each reader refuses the
//      other's blobs);
//   5. leave legacy encryptField/readField semantics UNTOUCHED — their
//      fail-open behavior is load-bearing for AACI fields (constraint pinned
//      here so a future "fix" goes red in CI, not in production).
//
// Pure unit test — no DB, no network (encryptionAtRest imports only
// node:crypto + @workspace/domain). Env is process-global, so the not-ready
// tests run FIRST, then the key is set; __resetKeyringCacheForTests() flips
// the cached keyring between phases (same pattern as
// resetBrokerProviderForTests). node:test runs these sequentially in-file.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/security/__qa__/encryptCredential.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { security } from "@workspace/domain";
import {
  encryptField,
  readField,
  isEncryptionReady,
  isLegacyPlaintext,
  encryptCredential,
  decryptCredential,
  isCredentialCiphertext,
  CREDENTIAL_CIPHERTEXT_PREFIX,
  CredentialEncryptionUnavailableError,
  CredentialCiphertextInvalidError,
  __resetKeyringCacheForTests,
} from "../encryptionAtRest.js";

const PLAINTEXT = "deriv-api-token-SUPER-SECRET-1234567890";
const TEST_PASSPHRASE = "qa-only-passphrase-never-production-0001";

function goNotReady(): void {
  delete process.env.ARX_ENCRYPTION_KEY;
  __resetKeyringCacheForTests();
}

function goReady(): void {
  process.env.ARX_ENCRYPTION_KEY = TEST_PASSPHRASE;
  __resetKeyringCacheForTests();
}

// ── Phase 1: vault NOT ready ─────────────────────────────────────────────────

test("NOT READY: encryptCredential throws VAULT_NOT_READY, never plaintext", () => {
  goNotReady();
  assert.equal(isEncryptionReady(), false, "precondition: vault not ready");
  assert.throws(
    () => encryptCredential(PLAINTEXT),
    (err: unknown) =>
      err instanceof CredentialEncryptionUnavailableError &&
      err.code === "VAULT_NOT_READY",
    "encryptCredential must throw CredentialEncryptionUnavailableError when no key is configured",
  );
});

test("NOT READY: decryptCredential throws too (no read-side fallback)", () => {
  goNotReady();
  assert.throws(
    () => decryptCredential(`${CREDENTIAL_CIPHERTEXT_PREFIX}arxenc:1:x:y:z`),
    (err: unknown) => err instanceof CredentialEncryptionUnavailableError,
  );
});

test("NOT READY: the error never carries the plaintext or the env key name's value", () => {
  goNotReady();
  try {
    encryptCredential(PLAINTEXT);
    assert.fail("must have thrown");
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    assert.ok(!msg.includes(PLAINTEXT), "error message must not contain the credential plaintext");
    assert.ok(!msg.includes("SUPER-SECRET"), "error message must not contain credential fragments");
  }
});

test("NOT READY CONSTRAINT PIN: legacy encryptField still FAILS OPEN (AACI depends on it)", () => {
  goNotReady();
  // This is the documented, load-bearing legacy behavior — NOT a defect to
  // "fix" here. Broker credentials must never route through encryptField;
  // AACI fields rely on this exact degradation (flagged via readField).
  assert.equal(
    encryptField(PLAINTEXT),
    PLAINTEXT,
    "encryptField's fail-open contract changed — AACI callers depend on it; see encryptionAtRest.ts constraint comment",
  );
  const read = readField(PLAINTEXT);
  assert.equal(read.value, PLAINTEXT);
  assert.equal(read.legacyPlaintext, true);
});

// ── Phase 2: vault ready ─────────────────────────────────────────────────────

test("READY: round-trip decryptCredential(encryptCredential(x)) === x", () => {
  goReady();
  assert.equal(isEncryptionReady(), true, "precondition: vault ready");
  const blob = encryptCredential(PLAINTEXT);
  assert.equal(decryptCredential(blob), PLAINTEXT);
});

test("READY: ciphertext is prefixed, opaque, and IV-randomized", () => {
  goReady();
  const blob = encryptCredential(PLAINTEXT);
  assert.ok(blob.startsWith(CREDENTIAL_CIPHERTEXT_PREFIX), "credential blob carries the arxcred prefix");
  assert.ok(isCredentialCiphertext(blob));
  assert.ok(!blob.includes(PLAINTEXT), "ciphertext must not contain the plaintext");
  assert.notEqual(
    encryptCredential(PLAINTEXT),
    blob,
    "two encryptions of the same plaintext differ (random IV — no ECB-style fingerprinting of identical credentials)",
  );
});

test("READY: prefix distinctness — credential blobs vs legacy envelopes, both directions", () => {
  goReady();
  const credentialBlob = encryptCredential(PLAINTEXT);
  const legacyBlob = encryptField(PLAINTEXT);

  // Direction 1: a credential blob is NOT a legacy arxenc envelope.
  assert.equal(
    security.isEncryptedEnvelope(credentialBlob),
    false,
    "credential blob must not read as a legacy envelope",
  );
  // Documented hazard, pinned: readField would classify a credential blob as
  // legacy plaintext and hand back raw bytes — which is exactly why credential
  // blobs must ONLY be read via decryptCredential.
  const misread = readField(credentialBlob);
  assert.equal(misread.legacyPlaintext, true);
  assert.equal(misread.value, credentialBlob, "readField returns the blob verbatim, not the plaintext");
  assert.ok(!misread.value.includes(PLAINTEXT) || misread.value === credentialBlob);

  // Direction 2: a legacy envelope is NOT a credential blob, and
  // decryptCredential refuses it instead of guessing.
  assert.ok(legacyBlob.startsWith("arxenc:"), "legacy encryptField output keeps the arxenc envelope");
  assert.equal(isCredentialCiphertext(legacyBlob), false);
  assert.throws(
    () => decryptCredential(legacyBlob),
    (err: unknown) => err instanceof CredentialCiphertextInvalidError,
    "decryptCredential must refuse a non-credential envelope",
  );
});

test("READY: decryptCredential refuses raw plaintext and corrupt inputs (fail-closed)", () => {
  goReady();
  // Raw plaintext (missing prefix) — refuse, never echo.
  try {
    decryptCredential(PLAINTEXT);
    assert.fail("must have thrown");
  } catch (err) {
    assert.ok(err instanceof CredentialCiphertextInvalidError);
    assert.ok(!(err as Error).message.includes(PLAINTEXT), "refusal must not echo the (possibly plaintext) value");
  }
  // Prefix present but nothing behind it.
  assert.throws(
    () => decryptCredential(`${CREDENTIAL_CIPHERTEXT_PREFIX}not-an-envelope`),
    (err: unknown) => err instanceof CredentialCiphertextInvalidError,
  );
  // Tampered ciphertext: flip the last character → GCM auth tag fails → throws
  // (from the domain layer), never returns corrupted bytes.
  const blob = encryptCredential(PLAINTEXT);
  const tampered = blob.slice(0, -1) + (blob.endsWith("A") ? "B" : "A");
  assert.throws(() => decryptCredential(tampered), "tampered credential ciphertext must throw, never decrypt");
});

test("READY: legacy encryptField/readField round-trip is untouched by the new code", () => {
  goReady();
  const legacyBlob = encryptField(PLAINTEXT);
  assert.notEqual(legacyBlob, PLAINTEXT, "with a key configured, encryptField encrypts as before");
  assert.equal(isLegacyPlaintext(legacyBlob), false);
  const read = readField(legacyBlob);
  assert.equal(read.value, PLAINTEXT);
  assert.equal(read.wasEncrypted, true);
  assert.equal(read.legacyPlaintext, false);
  assert.equal(read.needsReencryption, false);
});

// ── Phase 3: back to NOT ready (a later outage still refuses reads) ──────────

test("KEY LOST: previously-written credential blobs refuse to decrypt (no silent fallback)", () => {
  goReady();
  const blob = encryptCredential(PLAINTEXT);
  goNotReady();
  assert.throws(
    () => decryptCredential(blob),
    (err: unknown) => err instanceof CredentialEncryptionUnavailableError,
    "a key outage must surface as VAULT_NOT_READY, never as returned ciphertext or plaintext",
  );
});
