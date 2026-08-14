// Build NN — reusable secret-redaction + account-masking utilities.
// Hard rule: secrets never appear in any output, log, export, or notification.

import { redactSecrets } from "@workspace/domain/security";

const SECRET_KEYS_RE = /(api[_-]?key|api[_-]?secret|secret|password|token|credential|broker[_-]?api|database[_-]?url|session[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|bearer)/i;
const ACCOUNT_KEYS_RE = /(account[_-]?id|account[_-]?number|broker[_-]?account|mt5[_-]?login)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /sk_(live|test)_[A-Za-z0-9]{12,}/g,
  /pk_(live|test)_[A-Za-z0-9]{12,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
  /postgres(?:ql)?:\/\/[^\s'"<>]+/g,
  /redis:\/\/[^\s'"<>]+/g,
  /mongodb(?:\+srv)?:\/\/[^\s'"<>]+/g,
];

export function maskAccountId(id: unknown): string {
  const s = String(id ?? "");
  if (s.length <= 4) return "****";
  return `****${s.slice(-4)}`;
}

export function maskToken(t: unknown): string {
  const s = String(t ?? "");
  if (s.length === 0) return "";
  const prefix = /^(sk|pk|ghp|xox[baprs])_/.exec(s);
  return prefix ? `${prefix[1]}_****REDACTED` : "****REDACTED";
}

export function scrubString(input: unknown): string {
  let s = typeof input === "string" ? input : String(input ?? "");
  for (const re of SECRET_VALUE_PATTERNS) s = s.replace(re, "[REDACTED]");
  return s;
}

export function scrub<T = unknown>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS_RE.test(k)) {
        out[k] = "[REDACTED]";
      } else if (ACCOUNT_KEYS_RE.test(k)) {
        out[k] = maskAccountId(v);
      } else {
        out[k] = scrub(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

export function maskSensitiveOutput<T = unknown>(value: T): T {
  return scrub(value);
}

// ── Phase 4: redaction-before-write for audit/log/export records ───────────
// Composes the runtime account-masking scrubber with the Phase-1 domain
// secret-redactor (`@workspace/domain/security` redactSecrets — covers API
// keys, bridge/session/reset tokens, invite codes, provider/signing/encryption
// secrets, passwords, connection strings) and returns a redaction-status
// marker plus the (names-only) list of redacted keys. Fail-OPEN: if redaction
// throws we drop the payload entirely and return status "UNKNOWN" so a record
// is still written (a row is never dropped) but no raw secret can leak.
export interface RedactForAuditResult {
  redacted: Record<string, unknown>;
  redactedKeys: string[];
  status: string;
}

export function redactForAudit(payload: unknown): RedactForAuditResult {
  try {
    // 1. Account masking + URL/value scrub (server runtime patterns).
    const scrubbed = scrub(payload);
    // 2. Phase-1 domain deep redaction (returns names of redacted keys).
    const obj =
      scrubbed != null && typeof scrubbed === "object" && !Array.isArray(scrubbed)
        ? (scrubbed as Record<string, unknown>)
        : { value: scrubbed };
    const { value, redactedKeys } = redactSecrets(obj);
    const status = redactedKeys.length > 0 ? `REDACTED:${redactedKeys.length}` : "REDACTED";
    return { redacted: value as Record<string, unknown>, redactedKeys, status };
  } catch {
    // Fail-open for privacy: never persist the raw payload on a redaction error.
    return { redacted: {}, redactedKeys: [], status: "UNKNOWN" };
  }
}

export function redactionSelfTest(): {
  apiKeyRedacted: boolean;
  jwtRedacted: boolean;
  awsKeyRedacted: boolean;
  postgresUrlRedacted: boolean;
  accountMasked: boolean;
  privateKeyRedacted: boolean;
} {
  const sample = scrub({
    api_key: "abc123",
    broker_api_secret: "topsecret",
    note: "see token sk_live_ABCDEFGHIJKLMNO and AKIAABCDEFGHIJKLMNOP and eyJabcdefghijklmno.eyJpayload12345.signature123456",
    account_id: "1234567890",
    db: "postgresql://user:pass@host:5432/db",
    pem: "-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBgkqh\n-----END PRIVATE KEY-----",
  }) as Record<string, unknown>;
  const noteStr = String(sample.note ?? "");
  return {
    apiKeyRedacted: sample.api_key === "[REDACTED]" && sample.broker_api_secret === "[REDACTED]",
    jwtRedacted: noteStr.includes("[REDACTED]") && !/eyJabcdefghijklmno/.test(noteStr),
    awsKeyRedacted: !/AKIA/.test(noteStr),
    postgresUrlRedacted: sample.db === "[REDACTED]" || /\[REDACTED\]/.test(String(sample.db ?? "")),
    accountMasked: sample.account_id === "****7890",
    privateKeyRedacted: !/BEGIN PRIVATE KEY/.test(String(sample.pem ?? "")),
  };
}
