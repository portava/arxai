// ── @workspace/domain/security — user-copy safety ───────────────────────────
// Pure, deterministic, IO-free. A defensive net that keeps regular-user-facing
// assistant copy free of backend internals: SCREAMING_SNAKE gate/env codes,
// route paths, system-prompt references, and obvious secret shapes.
//
// SAFETY:
//   - Applies to REGULAR-USER output only. Admin diagnostics are surfaced on
//     separate, admin-gated channels and are NOT scrubbed.
//   - `findInternalLeaks` is the detector (used by tests + guards);
//     `scrubUserCopy` returns a cleaned copy where each leak is removed/replaced
//     and whitespace/punctuation are tidied.

/**
 * Patterns that must never appear in regular-user assistant copy. Each is global
 * so every occurrence is detected/replaced.
 */
export const FORBIDDEN_USER_COPY_TOKENS: RegExp[] = [
  // SCREAMING_SNAKE_CASE internal codes / env var names (≥2 segments):
  // LIVE_BLOCKED, LIVE_BROKER_EXECUTION_DISABLED, SESSION_SECRET,
  // ARX_LIVE_BROKER_EXECUTION_ENABLED, TWELVEDATA_API_KEY, …
  /\b[A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]+)+\b/g,
  // Explicit system-prompt references.
  /\bsystem\s*prompt\b/gi,
  // Internal API route paths.
  /\/api\/[A-Za-z0-9_\-/]+/g,
  // OpenAI-style secret keys.
  /\bsk-[A-Za-z0-9-]{8,}\b/g,
  // JWT-ish tokens.
  /\bey[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

/** Return every internal-leak substring found in `text` (deduped). */
export function findInternalLeaks(text: string | null | undefined): string[] {
  const input = typeof text === "string" ? text : "";
  if (input.length === 0) return [];
  const found = new Set<string>();
  for (const re of FORBIDDEN_USER_COPY_TOKENS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      found.add(m[0]);
      if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-width loop
    }
  }
  return [...found];
}

/** True when `text` is free of internal leaks. */
export function isUserCopyClean(text: string | null | undefined): boolean {
  return findInternalLeaks(text).length === 0;
}

/**
 * Remove internal leaks from regular-user copy and tidy the result. Pure and
 * deterministic. After this returns, {@link findInternalLeaks} on the output is
 * empty.
 */
export function scrubUserCopy(text: string | null | undefined): string {
  let out = typeof text === "string" ? text : "";
  if (out.length === 0) return out;
  for (const re of FORBIDDEN_USER_COPY_TOKENS) {
    re.lastIndex = 0;
    out = out.replace(re, "");
  }
  // Tidy whitespace + dangling punctuation/space artifacts left by removals.
  out = out
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out;
}

/**
 * Options for {@link scrubUserCopyDeep}.
 *
 * `preserveKeys` is an explicit allowlist of machine-field KEY NAMES (e.g.
 * `readLayer`, `tradeHealthFreshness`, `reasonCode`) whose value is a wire enum,
 * not narrative copy. A string under one of these keys is kept verbatim ONLY when
 * the whole value is a single SCREAMING_SNAKE / upper-case token (the enum shape).
 * Anything else under a preserved key — a sentence, a route path, a secret shape
 * — is still scrubbed exactly like narrative copy. Keys NOT on the allowlist are
 * always scrubbed, so a narrative string that is purely "LIVE_BLOCKED" (e.g. a
 * `blockedReason`) is still removed. The allowlist is by key name, never by
 * "looks like an enum".
 */
export interface ScrubUserCopyDeepOptions {
  preserveKeys?: ReadonlySet<string> | readonly string[];
}

/** A whole-value machine enum token: `STRUCTURAL_ONLY`, `HISTORICAL_ONLY`, `FULL`. */
const MACHINE_ENUM_VALUE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/**
 * Recursively scrub every string within a JSON-like value (objects, arrays,
 * strings). Numbers, booleans, null/undefined are returned unchanged. Pure and
 * deterministic — returns a new value, never mutates the input. Use on
 * regular-user-facing narrative payloads before serialization.
 *
 * Machine fields that carry an enum on the wire (a display read layer, a
 * freshness band, a reason code) MUST be listed in `opts.preserveKeys`, otherwise
 * a multi-segment enum like `STRUCTURAL_ONLY` is blanked to "" and the client
 * can no longer tell a withheld read from a full one.
 */
export function scrubUserCopyDeep<T>(value: T, opts?: ScrubUserCopyDeepOptions): T {
  const preserve =
    opts?.preserveKeys == null
      ? null
      : opts.preserveKeys instanceof Set
        ? (opts.preserveKeys as ReadonlySet<string>)
        : new Set(opts.preserveKeys as readonly string[]);
  return scrubDeepInner(value, preserve);
}

function scrubDeepInner<T>(value: T, preserve: ReadonlySet<string> | null): T {
  if (typeof value === "string") return scrubUserCopy(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeepInner(v, preserve)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        preserve != null && preserve.has(k) && typeof v === "string" && MACHINE_ENUM_VALUE.test(v)
          ? v
          : scrubDeepInner(v, preserve);
    }
    return out as T;
  }
  return value;
}
