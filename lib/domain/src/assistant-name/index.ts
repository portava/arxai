// ── Assistant display-name helpers (pure, shared) ───────────────────────────
// Single source of truth for the AI assistant's user-facing display name and
// its validation rules. Imported by both the api-server (authoritative
// validation + name resolution) and the trading-dashboard (inline form
// feedback + name resolution). Personalization/branding ONLY — this module
// has no effect on AI logic, safety, or execution.
//
// Naming model:
//   - Platform/app brand: "ARX AI" (handled elsewhere, never replaced here).
//   - Default assistant name: "Eleanor".
//   - Each user may set their own assistant_display_name (per-user only).

export const DEFAULT_ASSISTANT_NAME = "Eleanor";

export const MIN_ASSISTANT_NAME_LENGTH = 2;
export const MAX_ASSISTANT_NAME_LENGTH = 24;

// Letters (any script), numbers, spaces, apostrophes and hyphens only.
const ALLOWED_NAME_RE = /^[\p{L}\p{N} '\-]+$/u;

// Reserved / impersonation names (compared case-insensitively after
// whitespace normalization). Kept deliberately small per the task spec — we do
// NOT build a general offensive-language filter here.
const RESERVED_NAMES: readonly string[] = [
  "admin",
  "support",
  "broker",
  "mt5",
  "official",
  "system",
  "arx",
  "arx ai",
  "arx admin",
];

export type AssistantNameErrorCode =
  | "EMPTY"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "INVALID_CHARS"
  | "RESERVED";

export interface AssistantNameValidation {
  ok: boolean;
  /** Normalized accepted name (present only when ok === true). */
  value?: string;
  /** Machine-readable rejection code (present only when ok === false). */
  error?: AssistantNameErrorCode;
  /** Human-readable rejection message (present only when ok === false). */
  message?: string;
}

/**
 * Resolve the display name to show. Empty / null / whitespace-only falls back
 * to the app-level default (Eleanor). Never throws.
 */
export function resolveAssistantName(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_ASSISTANT_NAME;
}

/**
 * Validate a user-supplied assistant name. Returns the normalized name on
 * success, or a machine code + human message on failure. Use `resolveAssistantName`
 * (not this) when you simply want a name to display.
 *
 * Note: callers that want to RESET to the default should send `null`, not an
 * empty string — an empty string here is treated as an invalid explicit name.
 */
export function validateAssistantName(
  raw: string | null | undefined,
): AssistantNameValidation {
  const trimmed = (raw ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return { ok: false, error: "EMPTY", message: "Enter a name for your assistant." };
  }
  if (trimmed.length < MIN_ASSISTANT_NAME_LENGTH) {
    return { ok: false, error: "TOO_SHORT", message: "Name must be at least 2 characters." };
  }
  if (trimmed.length > MAX_ASSISTANT_NAME_LENGTH) {
    return { ok: false, error: "TOO_LONG", message: "Name must be 24 characters or fewer." };
  }
  if (!ALLOWED_NAME_RE.test(trimmed)) {
    return {
      ok: false,
      error: "INVALID_CHARS",
      message: "Use only letters, numbers, spaces, apostrophes, and hyphens.",
    };
  }
  if (RESERVED_NAMES.includes(trimmed.toLowerCase())) {
    return {
      ok: false,
      error: "RESERVED",
      message: "That name isn't available. Please choose a different name.",
    };
  }
  return { ok: true, value: trimmed };
}
