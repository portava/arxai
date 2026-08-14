// ── security/promptInjectionGuard.ts (api-server) ───────────────────────────
// Server-side wrapper around the pure domain prompt-injection detector. This is
// the ONLY place that records a security event when external text contains an
// injection attempt. The detection/neutralization itself is pure (domain).
//
// SAFETY:
//   - Treats ALL external text (market news, economic calendar, third-party
//     provider messages, user-uploaded content, alerts) as DATA, never as
//     instructions.
//   - On detection it returns the NEUTRALIZED copy (safe to use as data) and
//     fires a redacted security event (best-effort; never throws, never blocks).
//   - No secret, token, or raw provider payload is logged — only the matched
//     pattern family names and a short caller context, scrubbed by
//     recordSecurityEvent's redact-before-write.

import { scanForPromptInjection } from "@workspace/domain/security";
import { recordSecurityEvent } from "./events.js";
import { logger } from "../logger.js";

export interface ExternalTextContext {
  /** Where the text came from, e.g. "market_news", "economic_calendar". */
  source: string;
  /** Optional field name within the source record (e.g. "headline"). */
  field?: string;
  /** The user the request is attributed to (per-user isolation). */
  userId?: number | null;
}

/**
 * Scan a single external string for injection and return the neutralized copy.
 * On detection, records a redacted security event (fire-and-forget). Never
 * throws — on any failure it returns the original text unchanged.
 */
export function sanitizeExternalText(text: string | null | undefined, ctx: ExternalTextContext): string {
  if (typeof text !== "string" || text.length === 0) return text ?? "";
  try {
    const result = scanForPromptInjection(text);
    if (result.detected) {
      void recordSecurityEvent({
        eventType: "PROMPT_INJECTION_DETECTED",
        severity: "WARNING",
        status: "TRIGGERED",
        actorRole: null,
        actorUserId: ctx.userId ?? null,
        permissionKey: `prompt-injection:${ctx.source}`,
        message: `Prompt-injection pattern neutralized in external text (${ctx.source}${ctx.field ? `.${ctx.field}` : ""}).`,
        metadata: {
          source: ctx.source,
          field: ctx.field ?? null,
          patterns: result.patterns,
          userId: ctx.userId ?? null,
        },
      }).catch((err) => {
        logger.warn({ err, source: ctx.source }, "security: prompt-injection event record failed (non-fatal)");
      });
    }
    return result.sanitized;
  } catch (err) {
    logger.warn({ err, source: ctx.source }, "security: prompt-injection scan failed (passthrough)");
    return text;
  }
}

/**
 * Sanitize the named string fields of an external record in place-safe fashion
 * (returns a new object). Non-string fields are left untouched.
 */
export function sanitizeExternalRecord<T extends Record<string, unknown>>(
  record: T,
  fields: Array<keyof T>,
  ctx: Omit<ExternalTextContext, "field">,
): T {
  const out: T = { ...record };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string") {
      out[f] = sanitizeExternalText(v, { ...ctx, field: String(f) }) as T[keyof T];
    }
  }
  return out;
}
