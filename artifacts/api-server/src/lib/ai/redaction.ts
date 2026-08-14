// Task #705 — Redaction for everything the Fix Agent sends to the model and
// persists. Secrets must NEVER reach the provider or the ai_fix_agent_runs row.
//
// Two layers:
//   1. Pattern redaction — keys, tokens, JWTs, connection strings, emails,
//      phone numbers, AWS keys, generic high-entropy token-like blobs.
//   2. Env-value redaction — the literal values of known-secret env vars are
//      replaced by name, so even an unusual secret format is caught.
//
// Plus size capping so a giant log dump can't blow the prompt or the row.

export const MAX_FIELD_CHARS = 16_000;

const REDACTED = "[REDACTED]";

// Env var names whose VALUES must be scrubbed if they appear in any text.
function secretEnvNames(): string[] {
  const denySubstring = ["TOKEN", "SECRET", "PASSWORD", "API_KEY", "APIKEY", "PRIVATE_KEY"];
  const explicit = ["DATABASE_URL", "AI_INTEGRATIONS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"];
  const names = new Set<string>(explicit);
  for (const k of Object.keys(process.env)) {
    if (denySubstring.some((s) => k.toUpperCase().includes(s))) names.add(k);
  }
  return [...names];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PATTERNS: { re: RegExp; replace: string }[] = [
  // Anthropic / OpenAI style keys (sk-..., sk-ant-...).
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replace: REDACTED },
  // AWS access key IDs.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  // GitHub tokens.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: REDACTED },
  // Bearer / Authorization header values.
  { re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g, replace: "Bearer " + REDACTED },
  // JWTs (three base64url segments).
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replace: REDACTED },
  // Connection strings with embedded credentials -> keep scheme/host, drop creds.
  {
    re: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/g,
    replace: "$1" + REDACTED + "@",
  },
  // Email addresses.
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: REDACTED },
  // Phone numbers (loose international/US).
  { re: /(?<!\d)(\+?\d[\d().\s-]{8,}\d)(?!\d)/g, replace: REDACTED },
];

/** Redact secrets from a single string. Never throws. */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;

  // 1. Env-value redaction first (catches odd formats).
  for (const name of secretEnvNames()) {
    const val = process.env[name];
    if (typeof val === "string" && val.length >= 6) {
      out = out.split(val).join(`[REDACTED:${name}]`);
    }
  }

  // 2. Pattern redaction.
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/** Cap a string to MAX_FIELD_CHARS, keeping head + tail with a marker. */
export function capSize(input: string, max: number = MAX_FIELD_CHARS): string {
  if (!input || input.length <= max) return input;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 32;
  return (
    input.slice(0, head) +
    `\n…[TRUNCATED ${input.length - max} chars]…\n` +
    input.slice(input.length - tail)
  );
}

/** Redact then cap — the canonical sanitiser for a free-text field. */
export function sanitizeField(input: string | undefined | null, max: number = MAX_FIELD_CHARS): string {
  if (typeof input !== "string") return "";
  return capSize(redactSecrets(input), max);
}

/** Deep-redact arbitrary JSON-ish data (strings only; structure preserved). */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}
