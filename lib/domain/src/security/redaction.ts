// ═══════════════════════════════════════════════════════════════════════════
// security/redaction.ts — secret-safe redaction built ON the existing
// sensitive-data filter engine (never a fork).
//
// Adds value-pattern detection for the secret types the security spec calls out
// (API keys, bridge/session/reset tokens, invite codes, provider secrets,
// signing/encryption keys, passwords, connection strings) and a log-safe
// wrapper. Pure; no IO. The actual logging happens in artifacts/api-server.
// ═══════════════════════════════════════════════════════════════════════════

import {
  redactSensitive,
  isSensitiveKey,
  looksLikeSecretValue,
} from "../black-box-vault/event-sourced/sensitiveDataFilter.engine.js";

const REDACT_PLACEHOLDER = "[REDACTED]";

/**
 * High-confidence secret value shapes, redacted wherever they appear inside a
 * string (e.g. embedded in a free-text message). Conservative to avoid mangling
 * legitimate content, but covers every type the spec lists.
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /sk_(?:live|test)_[A-Za-z0-9]{12,}/g, // Stripe-style secret
  /pk_(?:live|test)_[A-Za-z0-9]{12,}/g, // Stripe-style publishable
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /re_[A-Za-z0-9_-]{16,}/g, // Resend API key
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
  /postgres(?:ql)?:\/\/[^\s'"<>]+/gi, // connection strings
  /redis:\/\/[^\s'"<>]+/gi,
  /mongodb(?:\+srv)?:\/\/[^\s'"<>]+/gi,
  /mysql:\/\/[^\s'"<>]+/gi,
];

/** Redact obvious secret shapes embedded anywhere in a string. */
export function redactSecretString(input: unknown): string {
  let s = typeof input === "string" ? input : String(input ?? "");
  for (const rx of SECRET_VALUE_PATTERNS) s = s.replace(rx, REDACT_PLACEHOLDER);
  return s;
}

export interface RedactSecretsResult<T> {
  value: T;
  /** Dotted key paths whose value was redacted (names only, never values). */
  redactedKeys: string[];
}

/**
 * Deep-redact secrets from any value:
 *  - objects → recursively, keying off the shared engine's key/value patterns
 *    (so bridge tokens, invite codes, signing/encryption keys are covered)
 *  - strings → embedded secret shapes scrubbed
 *  - arrays/primitives → walked/passed through
 */
export function redactSecrets<T>(value: T): RedactSecretsResult<T> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const result = redactSensitive(value);
    // Second pass: scrub embedded secret shapes left inside string leaves.
    const scrubbed = scrubStringsDeep(result.redacted);
    return { value: scrubbed as unknown as T, redactedKeys: result.redactedKeys };
  }
  if (Array.isArray(value)) {
    const wrapped = redactSensitive({ items: value });
    const inner = (wrapped.redacted as { items: unknown }).items;
    return {
      value: scrubStringsDeep(inner) as unknown as T,
      redactedKeys: wrapped.redactedKeys,
    };
  }
  if (typeof value === "string") {
    return { value: redactSecretString(value) as unknown as T, redactedKeys: [] };
  }
  return { value, redactedKeys: [] };
}

function scrubStringsDeep(v: unknown): unknown {
  if (typeof v === "string") return redactSecretString(v);
  if (Array.isArray(v)) return v.map(scrubStringsDeep);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = scrubStringsDeep(val);
    }
    return out;
  }
  return v;
}

export interface SafeLogRecord {
  message: string;
  meta: Record<string, unknown>;
  redactedKeys: string[];
}

/**
 * Build a log-safe record: the message has embedded secrets scrubbed and the
 * metadata object is deep-redacted. The api-server logging wrapper passes the
 * result straight to `logger`/`req.log` — secrets never reach a log sink.
 */
export function redactForLog(
  message: unknown,
  meta?: Record<string, unknown>,
): SafeLogRecord {
  const safeMessage = redactSecretString(message);
  const { value, redactedKeys } = redactSecrets(meta ?? {});
  return {
    message: safeMessage,
    meta: value as Record<string, unknown>,
    redactedKeys,
  };
}

export { isSensitiveKey, looksLikeSecretValue };
