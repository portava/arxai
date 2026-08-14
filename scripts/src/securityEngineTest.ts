// AACI Security Foundation (Task #237) — PURE domain unit tests.
//
// Verifies the honesty + safety contracts of the security domain building blocks:
//  1. computeSecurityScore: bounds 0–100, deterministic, correct band mapping;
//     unknown components degrade to 0 (never fabricated high); critical-floor
//     caps band at Critical; lockdownTriggered forces Lockdown; no token leaks.
//  2. redactSecrets / redactForLog: every listed secret type is redacted; no
//     plaintext secret value survives in message or metadata.
//  3. fieldAccess: role-rank ordering, minRole denial, owner-scope, mask-vs-omit.
//  4. encryption: AES-256-GCM round-trip; legacy plaintext passthrough+flag;
//     bad auth tag throws; unknown key version throws; needsReencryption logic.
//
// Pure & deterministic. No DB, no IO.
// Run: pnpm --filter @workspace/scripts run test:security

import { randomBytes } from "node:crypto";
import {
  computeSecurityScore,
  securityBandForScore,
  SECURITY_SCORE_WEIGHTS,
  SECURITY_SCORE_COMPONENTS,
  redactSecrets,
  redactForLog,
  roleRank,
  resolveFieldAccess,
  filterRecordFields,
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  needsReencryption,
  KEY_BYTES,
  type SecurityScoreComponentInputs,
  type FieldPolicy,
  type Keyring,
} from "@workspace/domain/security";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

function allKnown(value: number): SecurityScoreComponentInputs {
  const out: SecurityScoreComponentInputs = {};
  for (const c of SECURITY_SCORE_COMPONENTS) out[c] = value;
  return out;
}

// ── 1. Security Score engine ────────────────────────────────────────────────
console.log("Security Score engine:");
{
  const weightSum = Object.values(SECURITY_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  check("weights sum to 1.0", Math.abs(weightSum - 1) < 1e-9);

  const perfect = computeSecurityScore(allKnown(100));
  check("all-100 → score 100", perfect.score === 100);
  check("all-100 → band Secure", perfect.band === "Secure");
  check("all-100 → no unknown components", perfect.unknownComponents.length === 0);
  check("all-100 → no critical floor hit", perfect.criticalFloorHit === false);

  const zero = computeSecurityScore(allKnown(0));
  check("all-0 → score 0", zero.score === 0);
  check("all-0 → band Lockdown", zero.band === "Lockdown");

  const empty = computeSecurityScore({});
  check("empty inputs → score 0 (honest, never high)", empty.score === 0);
  check(
    "empty inputs → all components unknown",
    empty.unknownComponents.length === SECURITY_SCORE_COMPONENTS.length,
  );
  check("empty inputs → critical floor hit", empty.criticalFloorHit === true);

  // High average but one critical-floor component failing → band capped.
  const capped = computeSecurityScore({
    ...allKnown(100),
    secretsProtected: 0,
  });
  check("critical-floor 0 → score still high", capped.score >= 80);
  check("critical-floor 0 → band capped at Critical", capped.band === "Critical");
  check("critical-floor 0 → criticalFloorHit true", capped.criticalFloorHit === true);

  // Unknown (undefined) is treated as 0 and degrades — never assumed secure.
  const unknownCritical = computeSecurityScore({
    ...allKnown(100),
    auditRedaction: undefined,
  });
  check(
    "unknown critical component → degraded (band ≤ Critical)",
    unknownCritical.band === "Critical" || unknownCritical.band === "Lockdown",
  );
  check(
    "unknown critical component listed",
    unknownCritical.unknownComponents.includes("auditRedaction"),
  );

  // Lockdown forced regardless of score.
  const locked = computeSecurityScore(allKnown(100), { lockdownTriggered: true });
  check("lockdownTriggered → band Lockdown", locked.band === "Lockdown");
  check("lockdownTriggered → lockdownForced true", locked.lockdownForced === true);

  // Bounds + clamping of out-of-range inputs.
  const clamped = computeSecurityScore(allKnown(99999));
  check("over-100 inputs clamp → score ≤ 100", clamped.score <= 100);
  const negative = computeSecurityScore(allKnown(-50));
  check("negative inputs clamp → score ≥ 0", negative.score >= 0);

  // securityBandForScore boundaries.
  check("band 90 → Secure", securityBandForScore(90) === "Secure");
  check("band 89 → Healthy", securityBandForScore(89) === "Healthy");
  check("band 0 → Lockdown", securityBandForScore(0) === "Lockdown");

  // Determinism.
  const a = computeSecurityScore(allKnown(73));
  const b = computeSecurityScore(allKnown(73));
  check("deterministic score", a.score === b.score && a.band === b.band);

  // No UPPER_SNAKE token leak into user-facing reasons.
  const tokenLeak = capped.reasons.some((r) => /[A-Z]{2,}_[A-Z_]+/.test(r));
  check("no UPPER_SNAKE token in reasons", !tokenLeak);
}

// ── 2. Redaction ────────────────────────────────────────────────────────────
console.log("Redaction:");
{
  const secretObj = {
    bridgeToken: "abc123secretbridge",
    reset_token: "rrrrrrtokenvalue",
    inviteCode: "INVITE-9988",
    signingKey: "sk-signing-abcdef",
    encryptionKey: "ek-zzzzzzzzzz",
    api_key: "sk_live_abcdefghijklmnop",
    password: "hunter2hunter2",
    sessionId: "sess_aaaaaaaaaa",
    safe: "EURUSD",
    nested: { brokerSecret: "verysecretbroker", lots: 0.01 },
  };
  const { value, redactedKeys } = redactSecrets(secretObj);
  const flat = JSON.stringify(value);
  check("bridge token redacted", !flat.includes("abc123secretbridge"));
  check("reset token redacted", !flat.includes("rrrrrrtokenvalue"));
  check("invite code redacted", !flat.includes("INVITE-9988"));
  check("signing key redacted", !flat.includes("sk-signing-abcdef"));
  check("encryption key redacted", !flat.includes("ek-zzzzzzzzzz"));
  check("api key redacted", !flat.includes("sk_live_abcdefghijklmnop"));
  check("password redacted", !flat.includes("hunter2hunter2"));
  check("nested broker secret redacted", !flat.includes("verysecretbroker"));
  check("non-secret value preserved", flat.includes("EURUSD"));
  check("redactedKeys reported", redactedKeys.length > 0);

  // Embedded secret shapes inside a free-text string.
  const msg = "connect via postgres://user:pass@host:5432/db and key sk_live_ZZZZZZZZZZZZ now";
  const safe = redactForLog(msg, { token: "ghp_ABCDEFGHIJKLMNOPQRST" });
  check("connection string redacted in message", !safe.message.includes("postgres://user:pass@host"));
  check("stripe key redacted in message", !safe.message.includes("sk_live_ZZZZZZZZZZZZ"));
  check(
    "github PAT redacted in meta",
    !JSON.stringify(safe.meta).includes("ghp_ABCDEFGHIJKLMNOPQRST"),
  );
}

// ── 3. Field-level access ───────────────────────────────────────────────────
console.log("Field-level access:");
{
  check("OWNER outranks ADMIN", roleRank("OWNER") > roleRank("ADMIN"));
  check("ADMIN outranks TRADER", roleRank("ADMIN") > roleRank("TRADER"));
  check("unknown role → rank 0", roleRank("nope") === 0);
  check("null role → rank 0", roleRank(null) === 0);
  check("case-insensitive role", roleRank("owner") === roleRank("OWNER"));

  const adminOnly: FieldPolicy = { minRole: "ADMIN", onDeny: "omit" };
  const adminDecision = resolveFieldAccess(adminOnly, {
    viewerRole: "TRADER",
    viewerUserId: 1,
    ownerUserId: 1,
  });
  check("TRADER denied ADMIN-only field", adminDecision.allowed === false);
  check("denied omit field flagged omitted", adminDecision.omitted === true);

  const adminAllowed = resolveFieldAccess(adminOnly, {
    viewerRole: "ADMIN",
    viewerUserId: 9,
    ownerUserId: 1,
  });
  check("ADMIN allowed ADMIN-only field", adminAllowed.allowed === true);

  // Fail-closed on a misconfigured (unknown) minRole — must NOT coerce to rank
  // 0 and let everyone through, even for the owner / owner-only fields.
  const badRolePolicy: FieldPolicy = { minRole: "ADMN", onDeny: "omit" };
  const badRoleOwner = resolveFieldAccess(badRolePolicy, {
    viewerRole: "OWNER",
    viewerUserId: 1,
    ownerUserId: 1,
  });
  check("unknown minRole denies even OWNER (fail closed)", badRoleOwner.allowed === false);
  const badRoleOwnerOnly = resolveFieldAccess(
    { minRole: "ADMN", ownerOnly: true, onDeny: "mask" },
    { viewerRole: "TRADER", viewerUserId: 5, ownerUserId: 5 },
  );
  check(
    "unknown minRole on owner-only denies record owner (fail closed)",
    badRoleOwnerOnly.allowed === false,
  );

  const ownerOnly: FieldPolicy = { ownerOnly: true, onDeny: "mask" };
  const ownerSelf = resolveFieldAccess(ownerOnly, {
    viewerRole: "TRADER",
    viewerUserId: 5,
    ownerUserId: 5,
  });
  check("owner sees own owner-only field", ownerSelf.allowed === true);
  const ownerOther = resolveFieldAccess(ownerOnly, {
    viewerRole: "TRADER",
    viewerUserId: 6,
    ownerUserId: 5,
  });
  check("non-owner denied owner-only field", ownerOther.allowed === false);
  check("denied mask field flagged masked", ownerOther.masked === true);

  const record = { id: 1, balance: 1000, bridgeToken: "secret", note: "hi" };
  const policies: Record<string, FieldPolicy> = {
    balance: { ownerOnly: true, onDeny: "mask" },
    bridgeToken: { minRole: "ADMIN", onDeny: "omit" },
  };
  const projected = filterRecordFields(record, policies, {
    viewerRole: "TRADER",
    viewerUserId: 2,
    ownerUserId: 5,
  });
  check(
    "masked field present as constant",
    (projected.record.balance as unknown) === "[RESTRICTED]",
  );
  check("omitted field dropped", !("bridgeToken" in projected.record));
  check("unpoliced field passes through", projected.record.note === "hi");
  check("deniedFields lists both", projected.deniedFields.length === 2);
}

// ── 4. Encryption-at-rest ───────────────────────────────────────────────────
console.log("Encryption-at-rest:");
{
  const key = randomBytes(KEY_BYTES);
  const keyring: Keyring = new Map([[1, key]]);

  const plaintext = "very-sensitive-bridge-token-XYZ";
  const envelope = encryptString(plaintext, 1, key);
  check("envelope has arxenc prefix", envelope.startsWith("arxenc:"));
  check("isEncryptedEnvelope true for envelope", isEncryptedEnvelope(envelope));
  check("ciphertext does not contain plaintext", !envelope.includes(plaintext));

  const decrypted = decryptString(envelope, keyring);
  check("round-trip value matches", decrypted.value === plaintext);
  check("round-trip wasEncrypted true", decrypted.wasEncrypted === true);
  check("round-trip keyVersion 1", decrypted.keyVersion === 1);
  check("round-trip not legacy", decrypted.legacyPlaintext === false);

  // Legacy plaintext passthrough.
  const legacy = decryptString("just-old-plaintext", keyring);
  check("legacy plaintext value passthrough", legacy.value === "just-old-plaintext");
  check("legacy plaintext flagged", legacy.legacyPlaintext === true);
  check("legacy plaintext wasEncrypted false", legacy.wasEncrypted === false);
  check("isEncryptedEnvelope false for plaintext", !isEncryptedEnvelope("plain"));

  // Bad auth tag → throw (never silently return ciphertext).
  const parts = envelope.split(":");
  const tampered = [parts[0], parts[1], parts[2], parts[3], Buffer.from("tampered").toString("base64")].join(":");
  let threwOnTamper = false;
  try {
    decryptString(tampered, keyring);
  } catch {
    threwOnTamper = true;
  }
  check("tampered ciphertext throws", threwOnTamper);

  // Unknown key version → throw.
  let threwOnMissingKey = false;
  try {
    decryptString(encryptString("x", 1, key).replace("arxenc:1:", "arxenc:9:"), keyring);
  } catch {
    threwOnMissingKey = true;
  }
  check("unknown key version throws", threwOnMissingKey);

  // needsReencryption.
  check("legacy plaintext needs re-encryption", needsReencryption("plain", 1) === true);
  check("current-version envelope OK", needsReencryption(envelope, 1) === false);
  check("older-version envelope needs re-encryption", needsReencryption(envelope, 2) === true);

  // Wrong key size rejected.
  let threwOnBadKey = false;
  try {
    encryptString("x", 1, randomBytes(16));
  } catch {
    threwOnBadKey = true;
  }
  check("wrong key size throws", threwOnBadKey);
}

console.log("");
if (failures > 0) {
  console.error(`securityEngineTest: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("securityEngineTest: all checks passed");

export {};
