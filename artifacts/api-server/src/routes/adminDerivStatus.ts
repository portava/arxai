// Admin-only Deriv provider health endpoint.
//
// GET /api/admin/deriv-status — returns full health with masked credentials.
// GET /api/admin/deriv-status/check — triggers an active connection check.
//
// SECURITY:
//   - Admin/Owner only.
//   - Never returns raw DERIV_APP_ID, DERIV_API_TOKEN, or OTP URLs.
//   - Only masked values (first 2 + last 2 chars).
//   - Sanitizes all error messages to strip any credential patterns.

import { Router, type Request, type Response } from "express";
import { getDerivFeedStatus } from "../lib/data/providers/derivProvider.js";
import { getDerivWsClient } from "../lib/data/providers/derivWsClient.js";

const router = Router();

function requireAdmin(req: Request, res: Response): boolean {
  const u = (req as unknown as { authUser?: { id: number; role?: string } }).authUser;
  if (!u) { res.status(401).json({ error: "AUTH_REQUIRED" }); return false; }
  const role = String(u.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "FORBIDDEN" }); return false;
  }
  return true;
}

// Sanitize error messages to never leak credentials
function sanitizeError(msg: string | null): string | null {
  if (!msg) return null;
  // Redact anything that looks like a token or app id
  return msg
    .replace(/pat_[A-Za-z0-9_-]+/gi, "<token>")
    .replace(/bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer <token>")
    .replace(/app_id=[^\s&"]+/gi, "app_id=<redacted>")
    .slice(0, 300);
}

router.get("/admin/deriv-status", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const status = getDerivFeedStatus();

  // Friendly blocker reasons for admin
  const blockers: string[] = [];
  if (!status.appIdConfigured)    blockers.push("DERIV_APP_ID not configured in Replit Secrets.");
  if (!status.apiTokenConfigured && status.mode !== "legacy")
    blockers.push("DERIV_API_TOKEN not configured — required for new PAT API mode.");
  if (status.mode === "new" && !status.accountIdConfigured)
    blockers.push("DERIV_ACCOUNT_ID may be required if the OTP endpoint uses account routing.");
  if (status.errorMessage?.includes("Unauthorized"))
    blockers.push("OTP request unauthorized — check that DERIV_APP_ID and DERIV_API_TOKEN are correct.");
  if (status.errorMessage?.includes("not found"))
    blockers.push("OTP endpoint not found — Deriv API may have changed.");

  res.json({
    ok:            true,
    health:        status.healthSummary,
    mode:          status.mode,
    configured:    status.configured,
    connected:     status.connected,
    credentials: {
      appId:     { present: status.appIdConfigured,    masked: status.maskedAppId },
      token:     { present: status.apiTokenConfigured, masked: status.maskedToken },
      accountId: { present: status.accountIdConfigured },
    },
    otpLastResult:    sanitizeError(status.otpLastResult),
    errorMessage:     sanitizeError(status.errorMessage),
    lastTickAt:       status.lastTickAt,
    lastTickAgeMs:    status.lastTickAgeMs,
    hasRecentTick:    status.hasRecentTick,
    lastCandleAt:     status.lastCandleAt,
    connectedAt:      status.connectedAt,
    reconnectCount:   status.reconnectCount,
    subscribedSymbols: status.subscribedSymbols,
    knownSymbols:     status.knownSyntheticSymbolCount,
    activeSymbols:    status.activeSymbolCount,
    activeSymbolsLoaded:        status.activeSymbolsLoaded,
    activeSymbolsCachedCount:   status.activeSymbolsCachedCount,
    activeSymbolsLoadedAt:      status.activeSymbolsLoadedAt,
    activeSymbolsError:         sanitizeError(status.activeSymbolsError),
    eagerWarmupSymbols:         status.eagerWarmupSymbols,
    warmupAttemptedAt:          status.warmupAttemptedAt,
    warmupCompletedAt:          status.warmupCompletedAt,
    feedReadinessState:         status.feedReadinessState,
    message:          status.message,
    blockers,
    setupInstructions: blockers.length > 0 ? [
      "1. Go to developers.deriv.com and create an API app.",
      "2. Add DERIV_APP_ID = your alphanumeric app ID to Replit Secrets.",
      "3. Add DERIV_API_TOKEN = your PAT token (starts with pat_) to Replit Secrets.",
      "4. Optionally add DERIV_ACCOUNT_ID if required.",
      "5. Set DERIV_API_MODE=new (or leave unset for auto-detection).",
      "6. Restart the server.",
    ] : [],
  });
});

// Active connection check — triggers ensureConnection and waits briefly
router.post("/admin/deriv-status/check", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const client = getDerivWsClient();
  client.ensureConnection();
  // Wait up to 3s for connection
  await new Promise(r => setTimeout(r, 3000));
  const status = getDerivFeedStatus();
  res.json({
    ok:        true,
    connected: status.connected,
    health:    status.healthSummary,
    error:     sanitizeError(status.errorMessage),
  });
});

// Active probe — runs `active_symbols` + `ticks_history(R_75, 60s, 5)`
// round trips against the live Deriv WS. Surfaces the real Deriv error
// for PAT/credential mismatches instead of a synthetic blocker message.
router.post("/admin/deriv-status/probe", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const client = getDerivWsClient();
  const result = await client.probe();
  res.json({
    ok: true,
    connected:           result.connected,
    authorized:          result.authorized,
    activeSymbolsCount:  result.activeSymbolsCount,
    activeSymbolsError:  sanitizeError(result.activeSymbolsError),
    ticksHistoryCount:   result.ticksHistoryCount,
    lastCandleEpoch:     result.lastCandleEpoch,
    lastCandleAt:        result.lastCandleEpoch
      ? new Date(result.lastCandleEpoch * 1000).toISOString()
      : null,
    ticksHistoryError:   sanitizeError(result.ticksHistoryError),
  });
});

export default router;
