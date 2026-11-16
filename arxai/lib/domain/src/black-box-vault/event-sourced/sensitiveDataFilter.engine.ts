// ═══════════════════════════════════════════════════════════════════════════
// sensitiveDataFilter.engine.ts — pure recursive redactor.
//
// Removes API keys, passwords, broker secrets, tokens, cookies, session ids,
// private keys, and similar credentials from event payloads BEFORE storage.
// Walks objects + arrays. Replaces matched values with "[REDACTED]" and
// returns the list of redacted key names (not values) for auditability.
// ═══════════════════════════════════════════════════════════════════════════

const REDACT_PLACEHOLDER = "[REDACTED]";

/** Key-name patterns that always redact. Matched case-insensitively against
 *  the key (not the value). */
const SENSITIVE_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /password/i,
  /passwd/i,
  /(^|[_\-.])secret([_\-.]|$)/i,
  /(^|[_\-.])token([_\-.]|$)/i,
  /api[_\-]?key/i,
  /access[_\-]?key/i,
  /access[_\-]?token/i,
  /refresh[_\-]?token/i,
  /authorization/i,
  /^auth$/i,
  /bearer/i,
  /private[_\-]?key/i,
  /secret[_\-]?key/i,
  /client[_\-]?secret/i,
  /credential/i,
  /cookie/i,
  /session[_\-]?id/i,
  /broker.*(secret|token|password|key)/i,
  /mt5.*(secret|token|password|key)/i,
  /deriv.*(secret|token|password|key)/i,
  /webhook[_\-]?secret/i,
  // ── Additive ARX-specific patterns (only ever redact MORE, never less) ────
  /bridge[_\-]?token/i,
  /reset[_\-]?token/i,
  /invite[_\-]?code/i,
  /signing[_\-]?key/i,
  /encryption[_\-]?key/i,
];

/** High-confidence value patterns for "looks like a secret" string detection.
 *  Conservative — only flags very obvious shapes to avoid false positives on
 *  legitimate trade payload strings. */
const SENSITIVE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /^sk-[A-Za-z0-9_\-]{20,}$/,            // OpenAI-style
  /^Bearer\s+[A-Za-z0-9._\-]{16,}$/i,    // bearer header
  /^eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}$/, // JWT
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/,      // Slack tokens
  /^ghp_[A-Za-z0-9]{20,}$/,              // GitHub PAT
];

export interface RedactionResult {
  redacted: Record<string, unknown>;
  redactionCount: number;
  redactedKeys: string[];
}

export function isSensitiveKey(k: string): boolean {
  // Normalize camelCase boundaries so compound keys like `sessionSecret`,
  // `bridgeToken`, or `tokenCount` are matched exactly as their snake_case
  // equivalents (`session_secret`, …) already are. Boundary-anchored patterns
  // (e.g. /(^|[_\-.])secret([_\-.]|$)/i) otherwise miss the camelCase form.
  // Purely additive — we test BOTH the raw and normalized key, so this only
  // ever redacts MORE, never less.
  const camelSplit = k.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SENSITIVE_KEY_PATTERNS.some((rx) => rx.test(k) || rx.test(camelSplit));
}

export function looksLikeSecretValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return SENSITIVE_VALUE_PATTERNS.some((rx) => rx.test(v));
}

export function redactSensitive(payload: unknown): RedactionResult {
  const redactedKeys: string[] = [];
  const seen = new WeakSet<object>();
  const MAX_DEPTH = 32;

  function walk(v: unknown, path: string, depth: number): unknown {
    if (depth > MAX_DEPTH) return "[TRUNCATED:max-depth]";
    if (Array.isArray(v)) {
      if (seen.has(v)) return "[TRUNCATED:cycle]";
      seen.add(v);
      return v.map((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    }
    if (v !== null && typeof v === "object") {
      if (seen.has(v as object)) return "[TRUNCATED:cycle]";
      seen.add(v as object);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const here = path ? `${path}.${k}` : k;
        if (isSensitiveKey(k)) {
          redactedKeys.push(here);
          out[k] = REDACT_PLACEHOLDER;
        } else if (looksLikeSecretValue(val)) {
          redactedKeys.push(here);
          out[k] = REDACT_PLACEHOLDER;
        } else {
          out[k] = walk(val, here, depth + 1);
        }
      }
      return out;
    }
    return v;
  }

  const safeInput =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const redacted = walk(safeInput, "", 0) as Record<string, unknown>;
  return { redacted, redactionCount: redactedKeys.length, redactedKeys };
}
