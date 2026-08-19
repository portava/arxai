// AACI Security Phase 4 (Task #240) — redaction-before-write unit tests.
//
// Verifies that the audit/log/export redaction composition NEVER lets a raw
// secret reach a stored record:
//   1. redactForAudit redacts every secret key + embedded secret value shape,
//      masks account numbers, preserves non-secrets, and reports redactedKeys.
//   2. scrubString strips embedded connection strings / provider keys from free
//      text.
//   3. Fail-OPEN: a payload that cannot be redacted yields status "UNKNOWN" with
//      an EMPTY redacted body (the raw payload is dropped, never persisted) —
//      a row is still writable, but no secret can leak.
//
// Pure & deterministic. No DB, no IO.
// Run: pnpm --filter @workspace/scripts run test:security-redaction

import {
  redactForAudit,
  scrubString,
  maskAccountId,
  redactionSelfTest,
} from "../../artifacts/api-server/src/lib/security/redact.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}`);
  }
}

// ── 1. redactForAudit: every secret type ────────────────────────────────────
// eslint-disable-next-line no-console
console.log("redactForAudit — secret coverage:");
{
  const payload = {
    bridgeToken: "abc123secretbridge",
    reset_token: "rrrrrrtokenvalue",
    inviteCode: "INVITE-9988",
    signingKey: "sk-signing-abcdef",
    encryptionKey: "ek-zzzzzzzzzz",
    api_key: "sk_live_abcdefghijklmnop",
    password: "hunter2hunter2",
    sessionSecret: "sess_aaaaaaaaaa",
    accountNumber: "1234567890",
    accountIdMasked: "98••••••10",
    providerError: "request failed with token sk_live_PROVIDERSECRET123",
    note: "connect via postgres://user:pass@host:5432/db key sk_live_ZZZZZZZZZZZZ now",
    safe: "EURUSD",
    nested: { brokerSecret: "verysecretbroker", lots: 0.01 },
  };
  const { redacted, redactedKeys, status } = redactForAudit(payload);
  const flat = JSON.stringify(redacted);

  check("bridge token redacted", !flat.includes("abc123secretbridge"));
  check("reset token redacted", !flat.includes("rrrrrrtokenvalue"));
  check("signing key redacted", !flat.includes("sk-signing-abcdef"));
  check("encryption key redacted", !flat.includes("ek-zzzzzzzzzz"));
  check("api key redacted", !flat.includes("sk_live_abcdefghijklmnop"));
  check("password redacted", !flat.includes("hunter2hunter2"));
  check("session secret redacted", !flat.includes("sess_aaaaaaaaaa"));
  check("nested broker secret redacted", !flat.includes("verysecretbroker"));
  check("embedded connection string redacted", !flat.includes("postgres://user:pass@host"));
  check("embedded stripe key redacted", !flat.includes("sk_live_ZZZZZZZZZZZZ"));
  check("account number masked (no raw)", !flat.includes("1234567890"));
  check("masked account identifier stays redacted", !flat.includes("98••••••10"));
  check("provider error secret redacted", !flat.includes("sk_live_PROVIDERSECRET123"));
  check("account number tail preserved", flat.includes("7890"));
  check("non-secret value preserved", flat.includes("EURUSD"));
  check("non-secret numeric preserved", redacted != null && JSON.stringify(redacted).includes("0.01"));
  check("redactedKeys reported (names only)", redactedKeys.length > 0);
  check("status marks redaction", status.startsWith("REDACTED"));
}

// ── 2. scrubString — free-text embedded secrets ─────────────────────────────
// eslint-disable-next-line no-console
console.log("scrubString — free text:");
{
  const s = scrubString("token sk_live_ABCDEFGHIJKL and db postgres://u:p@h:5432/d and AKIAABCDEFGHIJKLMNOP done");
  check("stripe key scrubbed", !s.includes("sk_live_ABCDEFGHIJKL"));
  check("postgres url scrubbed", !s.includes("postgres://u:p@h"));
  check("aws key scrubbed", !/AKIA[0-9A-Z]{16}/.test(s));
  check("non-secret words preserved", s.includes("token") && s.includes("done"));
}

// ── 3. Account masking ──────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log("account masking:");
{
  check("long account masked to tail", maskAccountId("1234567890") === "****7890");
  check("short account fully masked", maskAccountId("12") === "****");
  check("null account masked", maskAccountId(null) === "****");
}

// ── 4. Fail-open behaviour ──────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log("fail-open:");
{
  // A getter that throws forces the redactor into its catch branch. The
  // contract is: status "UNKNOWN", empty redacted body, no raw value leaked.
  const exploding: Record<string, unknown> = {};
  Object.defineProperty(exploding, "boom", {
    enumerable: true,
    get() {
      throw new Error("cannot read this property");
    },
  });
  const r = redactForAudit(exploding);
  check("fail-open status UNKNOWN", r.status === "UNKNOWN");
  check("fail-open drops payload (empty body)", Object.keys(r.redacted).length === 0);
  check("fail-open reports no keys", r.redactedKeys.length === 0);
}

// ── 5. Self-test sanity ─────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log("redactionSelfTest:");
{
  const t = redactionSelfTest();
  check("self-test api key redacted", t.apiKeyRedacted);
  check("self-test jwt redacted", t.jwtRedacted);
  check("self-test aws key redacted", t.awsKeyRedacted);
  check("self-test postgres url redacted", t.postgresUrlRedacted);
  check("self-test account masked", t.accountMasked);
  check("self-test private key redacted", t.privateKeyRedacted);
}

// eslint-disable-next-line no-console
console.log("");
if (failures > 0) {
  // eslint-disable-next-line no-console
  console.error(`securityRedactionTest: ${failures} check(s) FAILED`);
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log("securityRedactionTest: all checks passed");

export {};
