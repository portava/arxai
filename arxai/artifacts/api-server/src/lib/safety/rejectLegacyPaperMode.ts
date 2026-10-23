// Phase 5 — Request-side rejection of the removed "paper" production mode.
//
// Paper Trading was retired as a product mode (Phases 2/3/4). The two
// supported production modes are DEMO and LIVE.
//
// Active mode validators (Zod enums on incoming request bodies) no
// longer include "paper". This helper intercepts request bodies BEFORE
// the Zod parser runs so callers get the canonical 400 error message
// instead of a generic "invalid enum value" Zod issue.
//
// Per the Phase 5 brief:
//   - Do NOT silently map paper requests to live (or to demo).
//   - Do NOT leave paper as a runtime fallback.
//   - Reject with: "Paper Trading has been removed. Use Demo or Live."
//
// What this helper does NOT touch:
//   - Wire literal `safetyMode: "paper_only"` (preserved — see
//     liveExecutionLock.ts doc comment for the full deferred list).
//   - Read-side types that surface legacy `"paper"` DB rows
//     (getUserModeScope.primaryDataDomain, meAccountShell paper-trade
//     aggregations, meAssistant accountMode reads). Those are Phase 9.

export const LEGACY_PAPER_MODE_REJECTION_MESSAGE =
  "Paper Trading has been removed. Use Demo or Live." as const;

const MODE_FIELDS = [
  "accountMode",
  "executionMode",
  "tradeMode",
  "mode",
] as const;

/**
 * Returns the canonical 400 error payload if any of the recognized mode
 * fields equals "paper" (case-insensitive). Returns null otherwise.
 * Callers should `res.status(400).json(payload)` on a non-null return.
 */
export function detectLegacyPaperModeRequest(
  body: unknown,
): { error: "LEGACY_PAPER_MODE_REMOVED"; message: string; field: string } | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  for (const field of MODE_FIELDS) {
    const v = obj[field];
    if (typeof v === "string" && v.trim().toLowerCase() === "paper") {
      return {
        error: "LEGACY_PAPER_MODE_REMOVED",
        message: LEGACY_PAPER_MODE_REJECTION_MESSAGE,
        field,
      };
    }
  }
  return null;
}
